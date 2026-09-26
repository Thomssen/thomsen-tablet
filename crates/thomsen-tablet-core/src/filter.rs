//! The filter pipeline: spike rejection, micro-jitter, noise reduction,
//! velocity-based smoothing, the One Euro filter, and plain smoothing all
//! operate on position (implement [`Filter`]); anti-chatter and lift-off
//! debounce operate on a boolean signal and timing, which doesn't fit that
//! shape, so they share the one small [`AntiChatter`] type instead (a plain
//! debounce timer applies to any bouncy boolean, not just a button). Tap
//! stabilization needs the pen's contact state alongside position, which
//! doesn't fit the plain `Filter` shape either, so it's its own small type,
//! [`TapStabilizer`], applied explicitly by the driver rather than through
//! `build_chain`.
//!
//! These are standard, generic DSP/debounce techniques (exponential
//! smoothing, windowed averaging, a debounce timer, a deadzone, a
//! speed-adaptive EMA, the published One Euro filter, velocity/acceleration
//! outlier rejection) - not derived from any existing driver's
//! implementation.

use std::collections::{HashMap, VecDeque};

use crate::area::Point;

pub trait Filter: Send {
    /// A stable id, matched against `FilterConfig::id`.
    fn id(&self) -> &'static str;

    /// Adjusts a raw point before it's mapped to screen space. `timestamp_ms`
    /// is a monotonic milliseconds counter, for filters that need timing
    /// rather than just the current sample.
    fn apply(&mut self, point: Point, timestamp_ms: u64) -> Point;

    /// Clears any accumulated state (last point, velocity history, etc.) so
    /// the next sample is treated as a fresh start rather than continuing
    /// from data that's no longer relevant - the driver calls this on every
    /// filter in the chain when the tablet reconnects, since a gap of
    /// unknown length (and a pen very possibly now at a completely different
    /// physical position) invalidates whatever a filter remembered from
    /// before the disconnect. Profile changes and enable/disable toggles
    /// don't need this: `build_chain` constructs brand-new filter instances
    /// for those, which start clean by construction.
    fn reset(&mut self);

    /// An optional running counter a filter wants surfaced in diagnostics
    /// (currently just [`SpikeRejectionFilter`]'s rejection count). `None`
    /// for filters with nothing to report.
    fn diagnostic_count(&self) -> Option<u64> {
        None
    }
}

pub const SMOOTHING_ID: &str = "smoothing";
pub const NOISE_REDUCTION_ID: &str = "noise_reduction";
pub const ANTI_CHATTER_ID: &str = "anti_chatter";
pub const VELOCITY_SMOOTHING_ID: &str = "velocity_smoothing";
pub const MICRO_JITTER_ID: &str = "micro_jitter";
pub const LIFT_OFF_DEBOUNCE_ID: &str = "lift_off_debounce";
pub const ONE_EURO_ID: &str = "one_euro";
pub const SPIKE_REJECTION_ID: &str = "spike_rejection";
pub const TAP_STABILIZATION_ID: &str = "tap_stabilization";

/// Shared by [`SmoothingFilter`] and [`VelocitySmoothingFilter`]: the
/// intuitive 0 (off) - 1 (heaviest) UI knob, converted to an EMA alpha
/// (fraction of each new point taken - lower alpha = smoother + more lag).
fn alpha_from_strength(strength: f64) -> f64 {
    (1.0 - strength.clamp(0.0, 1.0)).max(0.05)
}

fn distance(a: Point, b: Point) -> f64 {
    ((a.x - b.x).powi(2) + (a.y - b.y).powi(2)).sqrt()
}

/// Exponential smoothing: each output point moves a fraction of the way from
/// the previous output toward the new raw point, damping jitter at the cost
/// of a small amount of lag.
pub struct SmoothingFilter {
    /// 0..1 - how much of each new point to take on. Lower = smoother + more lag.
    alpha: f64,
    last: Option<Point>,
}

impl SmoothingFilter {
    /// `strength` is 0 (off) to 1 (heaviest smoothing) - the intuitive knob
    /// exposed in the UI; internally converted to an EMA alpha.
    pub fn from_strength(strength: f64) -> Self {
        SmoothingFilter { alpha: alpha_from_strength(strength), last: None }
    }
}

impl Filter for SmoothingFilter {
    fn id(&self) -> &'static str {
        SMOOTHING_ID
    }

    fn apply(&mut self, point: Point, _timestamp_ms: u64) -> Point {
        let out = match self.last {
            None => point,
            Some(prev) => Point {
                x: prev.x + self.alpha * (point.x - prev.x),
                y: prev.y + self.alpha * (point.y - prev.y),
            },
        };
        self.last = Some(out);
        out
    }

    fn reset(&mut self) {
        self.last = None;
    }
}

/// Windowed average: outputs the mean of the last `capacity` raw points,
/// damping single-sample jitter. Larger windows smooth more but lag more.
pub struct NoiseReductionFilter {
    window: VecDeque<Point>,
    capacity: usize,
}

impl NoiseReductionFilter {
    pub fn new(samples: u32) -> Self {
        let capacity = (samples.max(1) as usize).min(32);
        NoiseReductionFilter { window: VecDeque::with_capacity(capacity), capacity }
    }
}

impl Filter for NoiseReductionFilter {
    fn id(&self) -> &'static str {
        NOISE_REDUCTION_ID
    }

    fn apply(&mut self, point: Point, _timestamp_ms: u64) -> Point {
        if self.window.len() >= self.capacity {
            self.window.pop_front();
        }
        self.window.push_back(point);
        let n = self.window.len() as f64;
        let (sx, sy) = self.window.iter().fold((0.0, 0.0), |(sx, sy), p| (sx + p.x, sy + p.y));
        Point { x: sx / n, y: sy / n }
    }

    fn reset(&mut self) {
        self.window.clear();
    }
}

/// Exponential smoothing whose strength adapts to how fast the pen is
/// actually moving: closer to `slow_strength` while the pen is nearly still
/// (steadies fine aiming/tracing), closer to `fast_strength` once it's
/// moving quickly (keeps osu!-style flicks and jumps immediate). Built for
/// osu! players specifically wanting stability on small movements without
/// paying for it in latency on big ones - unlike the plain [`SmoothingFilter`],
/// which applies one fixed strength regardless of speed.
///
/// The blend between the two strengths is a smooth exponential decay in
/// speed (mm/ms), not a hard cutoff, so there's no perceptible "seam" where
/// behavior suddenly changes mid-flick. `sensitivity` (0..1) sets how
/// quickly that decay reaches the fast-movement behavior: higher
/// sensitivity reacts to smaller speed increases.
pub struct VelocitySmoothingFilter {
    slow_alpha: f64,
    fast_alpha: f64,
    /// Speed (mm/ms) at which the blend is roughly halfway between
    /// `slow_alpha` and `fast_alpha`. Derived from `sensitivity`.
    reference_speed: f64,
    last_raw: Option<Point>,
    last_timestamp_ms: Option<u64>,
    last_output: Option<Point>,
}

impl VelocitySmoothingFilter {
    /// Reference speed ranges from 300 mm/s (sensitivity 0 - only very fast
    /// jumps get the "fast" treatment) down to 30 mm/s (sensitivity 1 - even
    /// fairly modest movements do). Both ends are deliberately generous
    /// guesses at osu!-relevant speeds (a full-tablet-width jump in ~150ms
    /// is roughly 1000mm/s; slow tracing is well under 50mm/s) rather than
    /// numbers measured against real play - tune by feel.
    pub fn from_params(slow_strength: f64, fast_strength: f64, sensitivity: f64) -> Self {
        const MAX_REFERENCE_MM_PER_MS: f64 = 0.3;
        const MIN_REFERENCE_MM_PER_MS: f64 = 0.03;
        let s = sensitivity.clamp(0.0, 1.0);
        let reference_speed = MAX_REFERENCE_MM_PER_MS - s * (MAX_REFERENCE_MM_PER_MS - MIN_REFERENCE_MM_PER_MS);
        VelocitySmoothingFilter {
            slow_alpha: alpha_from_strength(slow_strength),
            fast_alpha: alpha_from_strength(fast_strength),
            reference_speed,
            last_raw: None,
            last_timestamp_ms: None,
            last_output: None,
        }
    }
}

impl Filter for VelocitySmoothingFilter {
    fn id(&self) -> &'static str {
        VELOCITY_SMOOTHING_ID
    }

    fn apply(&mut self, point: Point, timestamp_ms: u64) -> Point {
        let alpha = match (self.last_raw, self.last_timestamp_ms) {
            (Some(last_point), Some(last_ts)) => {
                let dt_ms = timestamp_ms.saturating_sub(last_ts).max(1) as f64;
                let speed = distance(point, last_point) / dt_ms;
                let slow_weight = (-speed / self.reference_speed).exp();
                self.fast_alpha + (self.slow_alpha - self.fast_alpha) * slow_weight
            }
            // No prior sample to measure speed from yet - assume stationary,
            // the safer default (favors stability over an unmeasured guess).
            _ => self.slow_alpha,
        };
        self.last_raw = Some(point);
        self.last_timestamp_ms = Some(timestamp_ms);

        let out = match self.last_output {
            None => point,
            Some(prev) => Point { x: prev.x + alpha * (point.x - prev.x), y: prev.y + alpha * (point.y - prev.y) },
        };
        self.last_output = Some(out);
        out
    }

    fn reset(&mut self) {
        self.last_raw = None;
        self.last_timestamp_ms = None;
        self.last_output = None;
    }
}

/// A small deadzone around the last accepted point: raw movement smaller
/// than `deadzone_mm` is treated as sensor/hand noise and held at the last
/// position, instead of letting the cursor drift while the pen is meant to
/// be still. Movement at or past the deadzone passes straight through
/// (never clamped or delayed), so it's invisible to normal aiming once the
/// pen is actually moving - only true micro-jitter gets caught.
pub struct MicroJitterFilter {
    deadzone_mm: f64,
    held: Option<Point>,
}

impl MicroJitterFilter {
    pub fn new(deadzone_mm: f64) -> Self {
        MicroJitterFilter { deadzone_mm: deadzone_mm.max(0.0), held: None }
    }
}

impl Filter for MicroJitterFilter {
    fn id(&self) -> &'static str {
        MICRO_JITTER_ID
    }

    fn apply(&mut self, point: Point, _timestamp_ms: u64) -> Point {
        match self.held {
            Some(held) if distance(point, held) < self.deadzone_mm => held,
            _ => {
                self.held = Some(point);
                point
            }
        }
    }

    fn reset(&mut self) {
        self.held = None;
    }
}

/// The published One Euro Filter (Casiez, Roussel & Vogel, 2012 -
/// https://cristal.univ-lille.fr/~casiez/1euro/) - a low-pass filter whose
/// cutoff frequency adapts to the signal's own speed. Applied to the 2D
/// point as a whole (one shared adaptive cutoff, driven by the true 2D
/// speed) rather than filtering X and Y as independent 1D signals, so
/// diagonal movement isn't treated as "slower" than an equally-fast
/// axis-aligned one.
///
/// The filter's own key property is what makes it a good fit here: at
/// steady high speed, the *distance* it lags behind the raw input converges
/// to a constant, `1 / (2*pi*beta)`, independent of how fast the pen is
/// actually moving - so `beta` directly controls how much worst-case lag
/// (in mm) you're willing to accept during a fast flick, while `min_cutoff`
/// controls how much smoothing is applied when nearly still.
pub struct OneEuroFilter {
    min_cutoff: f64,
    beta: f64,
    d_cutoff: f64,
    /// Raw previous point - the derivative is always measured raw-to-raw,
    /// never against the filtered output (matching the reference
    /// implementation), so smoothing the position doesn't also damp the
    /// speed estimate that's supposed to react quickly to it.
    prev_raw: Option<Point>,
    prev_filtered: Option<Point>,
    /// Low-passed speed estimate (mm/s), carried between samples.
    prev_derivative: f64,
    prev_timestamp_ms: Option<u64>,
}

/// A gap this large between samples means a stall or a tablet reconnect,
/// not a real sample interval - treated as "start fresh" everywhere it's
/// checked in this file, rather than computing a speed/derivative from a
/// stale point across an arbitrary real-world time gap.
const RECONNECT_GAP_MS: u64 = 500;

fn one_euro_alpha(cutoff: f64, dt_seconds: f64) -> f64 {
    let tau = 1.0 / (2.0 * std::f64::consts::PI * cutoff.max(0.0001));
    dt_seconds / (dt_seconds + tau)
}

impl OneEuroFilter {
    pub fn from_params(min_cutoff: f64, beta: f64, d_cutoff: f64) -> Self {
        OneEuroFilter {
            min_cutoff: min_cutoff.max(0.0001),
            beta: beta.max(0.0),
            d_cutoff: d_cutoff.max(0.0001),
            prev_raw: None,
            prev_filtered: None,
            prev_derivative: 0.0,
            prev_timestamp_ms: None,
        }
    }
}

impl Filter for OneEuroFilter {
    fn id(&self) -> &'static str {
        ONE_EURO_ID
    }

    fn apply(&mut self, point: Point, timestamp_ms: u64) -> Point {
        let (Some(prev_raw), Some(prev_ts)) = (self.prev_raw, self.prev_timestamp_ms) else {
            self.prev_raw = Some(point);
            self.prev_filtered = Some(point);
            self.prev_derivative = 0.0;
            self.prev_timestamp_ms = Some(timestamp_ms);
            return point;
        };

        let dt_ms = timestamp_ms.saturating_sub(prev_ts);
        if dt_ms == 0 {
            // Two reports stamped identically - can't derive a speed (would
            // divide by zero). Repeat the last filtered output rather than
            // guessing.
            return self.prev_filtered.unwrap_or(point);
        }
        if dt_ms > RECONNECT_GAP_MS {
            self.prev_raw = Some(point);
            self.prev_filtered = Some(point);
            self.prev_derivative = 0.0;
            self.prev_timestamp_ms = Some(timestamp_ms);
            return point;
        }
        let dt_seconds = dt_ms as f64 / 1000.0;

        let speed = distance(point, prev_raw) / dt_seconds; // mm/s
        let d_alpha = one_euro_alpha(self.d_cutoff, dt_seconds);
        let derivative = self.prev_derivative + d_alpha * (speed - self.prev_derivative);

        let cutoff = self.min_cutoff + self.beta * derivative;
        let alpha = one_euro_alpha(cutoff, dt_seconds);
        let prev_filtered = self.prev_filtered.unwrap_or(point);
        let out = Point {
            x: prev_filtered.x + alpha * (point.x - prev_filtered.x),
            y: prev_filtered.y + alpha * (point.y - prev_filtered.y),
        };

        self.prev_raw = Some(point);
        self.prev_filtered = Some(out);
        self.prev_derivative = derivative;
        self.prev_timestamp_ms = Some(timestamp_ms);
        out
    }

    fn reset(&mut self) {
        self.prev_raw = None;
        self.prev_filtered = None;
        self.prev_derivative = 0.0;
        self.prev_timestamp_ms = None;
    }
}

/// Rejects a position sample when the motion it implies is far outside
/// anything a real pen stroke could produce - a corrupted/glitched HID
/// report, not a fast flick. Two independent checks, either enough to
/// reject on its own:
///
/// 1. **Absolute velocity ceiling.** Regardless of history, a per-sample
///    speed far beyond the fastest realistic flick (tuned with generous
///    headroom above it - see `from_sensitivity`) can only be bad data.
/// 2. **Sudden deviation from an already-established, non-trivial
///    velocity** (elevated speed *and* a sharp jump in that speed *and* the
///    previous sample was already moving at a real pace). That last
///    condition is what keeps this from ever catching the legitimate first
///    sample of a flick starting from a stop: going from ~0 to "fast" in one
///    sample is, by definition, exactly what a flick's onset looks like, so
///    it's only flagged as suspicious when it happens *mid-motion* instead.
///
/// A rejected sample never updates the filter's own history - it repeats
/// the last accepted point, and the *next* sample is judged purely against
/// that same last-known-good state. This is what makes recovery immediate:
/// one bad report never poisons the comparison for the sample after it.
pub struct SpikeRejectionFilter {
    velocity_ceiling: f64,          // mm/ms - check 1
    trend_velocity_threshold: f64,  // mm/ms - check 2
    trend_accel_threshold: f64,     // mm/ms^2 - check 2
    last_accepted: Option<Point>,
    last_accepted_velocity: f64,    // mm/ms
    last_timestamp_ms: Option<u64>,
    rejected_count: u64,
}

/// How fast the previous sample must already have been moving before check
/// 2 applies at all - excludes "starting from a stop" unconditionally,
/// regardless of how the other two check-2 thresholds are tuned.
const SPIKE_MIN_PRIOR_VELOCITY_MM_PER_MS: f64 = 0.3;

impl SpikeRejectionFilter {
    /// `sensitivity` 0 (least aggressive - only rejects the most extreme,
    /// unmistakable garbage) to 1 (most aggressive - also catches subtler
    /// anomalies). Even at 1.0, the velocity ceiling (8 mm/ms - crossing this
    /// tablet's ~180mm diagonal in a single ~22ms window) stays well above
    /// any realistic single-report flick distance, so a legitimate fast
    /// flick is never expected to reach it.
    pub fn from_sensitivity(sensitivity: f64) -> Self {
        let s = sensitivity.clamp(0.0, 1.0);
        SpikeRejectionFilter {
            velocity_ceiling: 20.0 - s * (20.0 - 8.0),
            trend_velocity_threshold: 6.0 - s * (6.0 - 3.0),
            trend_accel_threshold: 2.0 - s * (2.0 - 0.8),
            last_accepted: None,
            last_accepted_velocity: 0.0,
            last_timestamp_ms: None,
            rejected_count: 0,
        }
    }
}

impl Filter for SpikeRejectionFilter {
    fn id(&self) -> &'static str {
        SPIKE_REJECTION_ID
    }

    fn apply(&mut self, point: Point, timestamp_ms: u64) -> Point {
        let (Some(last), Some(last_ts)) = (self.last_accepted, self.last_timestamp_ms) else {
            self.last_accepted = Some(point);
            self.last_accepted_velocity = 0.0;
            self.last_timestamp_ms = Some(timestamp_ms);
            return point;
        };

        let dt_ms = timestamp_ms.saturating_sub(last_ts);
        if dt_ms == 0 {
            return last;
        }
        if dt_ms > RECONNECT_GAP_MS {
            // A real gap this large means the pen may now be anywhere -
            // the resulting "jump" is expected and must never be treated as
            // a spike, so start fresh instead of comparing against it.
            self.last_accepted = Some(point);
            self.last_accepted_velocity = 0.0;
            self.last_timestamp_ms = Some(timestamp_ms);
            return point;
        }

        let dt = dt_ms as f64;
        let v_now = distance(point, last) / dt;
        let accel = (v_now - self.last_accepted_velocity).abs() / dt;

        let exceeds_ceiling = v_now > self.velocity_ceiling;
        let deviates_from_trend =
            v_now > self.trend_velocity_threshold && accel > self.trend_accel_threshold && self.last_accepted_velocity > SPIKE_MIN_PRIOR_VELOCITY_MM_PER_MS;

        if exceeds_ceiling || deviates_from_trend {
            self.rejected_count += 1;
            return last;
        }

        self.last_accepted = Some(point);
        self.last_accepted_velocity = v_now;
        self.last_timestamp_ms = Some(timestamp_ms);
        point
    }

    fn reset(&mut self) {
        self.last_accepted = None;
        self.last_accepted_velocity = 0.0;
        self.last_timestamp_ms = None;
        // rejected_count is a lifetime diagnostic total, not pipeline
        // state - a reconnect doesn't erase how many spikes happened
        // earlier in the session, so it's deliberately left alone here.
    }

    fn diagnostic_count(&self) -> Option<u64> {
        Some(self.rejected_count)
    }
}

/// Steadies the pen's very first moments of contact: the physical act of
/// pressing the nib against the surface can itself impart a tiny, unwanted
/// lateral nudge, distinct from ordinary jitter in that it only ever
/// happens right at a hover-to-contact transition. Anchors to the contact
/// point and damps movement within `radius_mm` of it for `duration_ms`
/// afterward - but the moment movement exceeds that radius (a deliberate
/// aim/drag starting immediately on contact), it passes straight through
/// *and* ends the window early, so it can never fight real aim.
///
/// Applied by the driver after the rest of the position [`Filter`] chain
/// (see `driver::process_sample`) using the tip's already-debounced
/// contact state, not raw pressure - pressure's exact decoding is not yet
/// confirmed against real hardware (see the crate's README), while the tip
/// switch bit is already trusted for real clicks elsewhere in this
/// pipeline, making it the more reliable signal to key off here too.
pub struct TapStabilizer {
    radius_mm: f64,
    duration_ms: u64,
    strength: f64,
    contact_start: Option<(Point, u64)>,
    was_in_contact: bool,
}

impl TapStabilizer {
    pub fn new(radius_mm: f64, duration_ms: u64, strength: f64) -> Self {
        TapStabilizer {
            radius_mm: radius_mm.max(0.0),
            duration_ms,
            strength: strength.clamp(0.0, 1.0),
            contact_start: None,
            was_in_contact: false,
        }
    }

    /// `point` should already be the fully-filtered position (after the
    /// rest of the chain) - this only ever nudges it back toward the
    /// contact anchor, never reintroduces raw noise the earlier filters
    /// already removed.
    pub fn apply(&mut self, point: Point, timestamp_ms: u64, in_contact: bool) -> Point {
        if !in_contact {
            self.was_in_contact = false;
            self.contact_start = None;
            return point;
        }

        if !self.was_in_contact {
            // The hover -> contact transition, right now: this point itself
            // is the anchor, nothing to correct yet.
            self.was_in_contact = true;
            self.contact_start = Some((point, timestamp_ms));
            return point;
        }

        let Some((anchor, start_ts)) = self.contact_start else { return point };
        if timestamp_ms.saturating_sub(start_ts) >= self.duration_ms {
            self.contact_start = None; // window elapsed - stop touching this entirely
            return point;
        }

        if distance(point, anchor) >= self.radius_mm {
            // Movement past the radius is unmistakably intentional - let it
            // through immediately and don't keep correcting for the rest of
            // the window, so a drag/aim starting right on contact is never
            // fought.
            self.contact_start = None;
            return point;
        }

        // Inside the radius, inside the window: damp toward the anchor by
        // `strength` rather than pinning it rigidly, so it still feels like
        // the pen moved a little, not a dead zone.
        Point {
            x: anchor.x + (1.0 - self.strength) * (point.x - anchor.x),
            y: anchor.y + (1.0 - self.strength) * (point.y - anchor.y),
        }
    }

    pub fn reset(&mut self) {
        self.contact_start = None;
        self.was_in_contact = false;
    }
}

/// Debounces a button/tip signal: a state change is only accepted once it's
/// held for `min_interval_ms`, filtering out rapid on/off "chatter" from a
/// worn or mechanically noisy switch.
pub struct AntiChatter {
    min_interval_ms: u64,
    last_change_ms: Option<u64>,
    stable_state: bool,
}

impl AntiChatter {
    pub fn new(min_interval_ms: u64) -> Self {
        AntiChatter { min_interval_ms, last_change_ms: None, stable_state: false }
    }

    /// Feed the raw (possibly bouncing) state; returns the debounced state
    /// to actually act on.
    pub fn debounce(&mut self, raw_pressed: bool, timestamp_ms: u64) -> bool {
        if raw_pressed != self.stable_state {
            let allowed = match self.last_change_ms {
                None => true,
                Some(last) => timestamp_ms.saturating_sub(last) >= self.min_interval_ms,
            };
            if allowed {
                self.stable_state = raw_pressed;
                self.last_change_ms = Some(timestamp_ms);
            }
        }
        self.stable_state
    }

    /// Same reconnect-safety rationale as `Filter::reset` - the physical
    /// button state right after a reconnect is unknown, so start from "not
    /// pressed" (matching `driver::release_buttons_if_held`, which already
    /// forces the actual mouse button output to release on disconnect)
    /// rather than trusting whatever state was stable before the gap.
    pub fn reset(&mut self) {
        self.stable_state = false;
        self.last_change_ms = None;
    }
}

/// Builds the position-filter chain for a profile's enabled filters, in a
/// fixed, deterministic order regardless of the order they're stored in - so
/// behavior doesn't depend on incidental list ordering:
///
/// 1. Spike rejection - reject impossible jumps at the source, before
///    anything with a rolling window (noise reduction) or history (the
///    smoothing filters) has a chance to let a corrupted sample leak into
///    several subsequent outputs.
/// 2. Micro-jitter deadzone - reject sub-perceptible noise next.
/// 3. Noise reduction - average out whatever small noise remains.
/// 4. Velocity-based smoothing - adaptive EMA based on how fast the
///    (already denoised) point is moving.
/// 5. One Euro filter - a second, published adaptive-smoothing algorithm;
///    grouped with velocity-based smoothing since both solve the same
///    "smooth when slow, stay direct when fast" problem, ahead of the final
///    fixed-strength pass.
/// 6. Smoothing - a final fixed-strength pass, for anyone who wants extra
///    smoothing on top of (or instead of) the adaptive filters.
pub fn build_chain(configs: &[crate::profile::FilterConfig]) -> Vec<Box<dyn Filter>> {
    let enabled: HashMap<&str, &crate::profile::FilterConfig> =
        configs.iter().filter(|c| c.enabled).map(|c| (c.id.as_str(), c)).collect();

    let mut chain: Vec<Box<dyn Filter>> = Vec::new();
    if let Some(c) = enabled.get(SPIKE_REJECTION_ID) {
        chain.push(Box::new(SpikeRejectionFilter::from_sensitivity(c.params.get("sensitivity").copied().unwrap_or(0.5))));
    }
    if let Some(c) = enabled.get(MICRO_JITTER_ID) {
        chain.push(Box::new(MicroJitterFilter::new(c.params.get("deadzone_mm").copied().unwrap_or(0.1))));
    }
    if let Some(c) = enabled.get(NOISE_REDUCTION_ID) {
        chain.push(Box::new(NoiseReductionFilter::new(c.params.get("samples").copied().unwrap_or(4.0) as u32)));
    }
    if let Some(c) = enabled.get(VELOCITY_SMOOTHING_ID) {
        chain.push(Box::new(VelocitySmoothingFilter::from_params(
            c.params.get("slow_strength").copied().unwrap_or(0.5),
            c.params.get("fast_strength").copied().unwrap_or(0.0),
            c.params.get("sensitivity").copied().unwrap_or(0.5),
        )));
    }
    if let Some(c) = enabled.get(ONE_EURO_ID) {
        chain.push(Box::new(OneEuroFilter::from_params(
            c.params.get("min_cutoff").copied().unwrap_or(0.8),
            c.params.get("beta").copied().unwrap_or(0.6),
            c.params.get("d_cutoff").copied().unwrap_or(1.0),
        )));
    }
    if let Some(c) = enabled.get(SMOOTHING_ID) {
        chain.push(Box::new(SmoothingFilter::from_strength(c.params.get("strength").copied().unwrap_or(0.5))));
    }
    chain
}

/// Builds the anti-chatter debouncer if enabled, else `None`.
pub fn build_anti_chatter(configs: &[crate::profile::FilterConfig]) -> Option<AntiChatter> {
    configs
        .iter()
        .find(|c| c.id == ANTI_CHATTER_ID && c.enabled)
        .map(|c| AntiChatter::new(c.params.get("interval_ms").copied().unwrap_or(15.0) as u64))
}

/// Builds the lift-off debouncer if enabled, else `None` - the same debounce
/// timer as [`build_anti_chatter`], applied to the pen's in-range signal
/// instead of the tip switch (see `Driver::process_sample`'s use of it).
pub fn build_lift_off_debounce(configs: &[crate::profile::FilterConfig]) -> Option<AntiChatter> {
    configs
        .iter()
        .find(|c| c.id == LIFT_OFF_DEBOUNCE_ID && c.enabled)
        .map(|c| AntiChatter::new(c.params.get("debounce_ms").copied().unwrap_or(4.0) as u64))
}

/// Builds the tap stabilizer if enabled, else `None`.
pub fn build_tap_stabilizer(configs: &[crate::profile::FilterConfig]) -> Option<TapStabilizer> {
    configs.iter().find(|c| c.id == TAP_STABILIZATION_ID && c.enabled).map(|c| {
        TapStabilizer::new(
            c.params.get("radius_mm").copied().unwrap_or(0.5),
            c.params.get("duration_ms").copied().unwrap_or(15.0) as u64,
            c.params.get("strength").copied().unwrap_or(0.7),
        )
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn smoothing_moves_toward_target_without_overshoot() {
        let mut f = SmoothingFilter::from_strength(0.5);
        let a = f.apply(Point { x: 0.0, y: 0.0 }, 0);
        assert_eq!(a, Point { x: 0.0, y: 0.0 });
        let b = f.apply(Point { x: 10.0, y: 0.0 }, 1);
        assert!(b.x > 0.0 && b.x < 10.0, "should move partway, got {}", b.x);
    }

    #[test]
    fn smoothing_strength_zero_is_effectively_passthrough() {
        let mut f = SmoothingFilter::from_strength(0.0);
        f.apply(Point { x: 0.0, y: 0.0 }, 0);
        let b = f.apply(Point { x: 10.0, y: 5.0 }, 1);
        assert!((b.x - 10.0).abs() < 0.6 && (b.y - 5.0).abs() < 0.6);
    }

    #[test]
    fn smoothing_reset_forgets_the_last_point() {
        let mut f = SmoothingFilter::from_strength(0.9);
        f.apply(Point { x: 0.0, y: 0.0 }, 0);
        f.reset();
        // With no "last" remembered, the next point is a direct passthrough again.
        let out = f.apply(Point { x: 50.0, y: 50.0 }, 1);
        assert_eq!(out, Point { x: 50.0, y: 50.0 });
    }

    #[test]
    fn noise_reduction_averages_the_window() {
        let mut f = NoiseReductionFilter::new(2);
        f.apply(Point { x: 0.0, y: 0.0 }, 0);
        let out = f.apply(Point { x: 10.0, y: 0.0 }, 1);
        assert_eq!(out, Point { x: 5.0, y: 0.0 });
    }

    #[test]
    fn noise_reduction_reset_clears_the_window() {
        let mut f = NoiseReductionFilter::new(4);
        f.apply(Point { x: 0.0, y: 0.0 }, 0);
        f.apply(Point { x: 100.0, y: 100.0 }, 1);
        f.reset();
        let out = f.apply(Point { x: 5.0, y: 5.0 }, 2);
        assert_eq!(out, Point { x: 5.0, y: 5.0 }, "a fresh window of one point should average to just that point");
    }

    #[test]
    fn anti_chatter_rejects_rapid_flip_back() {
        let mut ac = AntiChatter::new(20);
        assert!(!ac.debounce(false, 0));
        assert!(ac.debounce(true, 0), "first press should register immediately from the initial state");
        // A bounce back to "not pressed" 5ms later (within the 20ms window) should be rejected.
        assert!(ac.debounce(false, 5), "bounce within the debounce window should be ignored");
        // But a real release after the window has elapsed should register.
        assert!(!ac.debounce(false, 25));
    }

    #[test]
    fn anti_chatter_reset_trusts_the_next_reading_immediately_like_a_fresh_instance() {
        let mut ac = AntiChatter::new(20);
        ac.debounce(true, 0);
        assert!(ac.debounce(true, 1));
        ac.reset();
        // No prior state to bounce against after a reset (e.g. a reconnect)
        // - the first reading afterward is trusted immediately, exactly
        // like `AntiChatter::new()`'s very first call, rather than being
        // held to the debounce interval as if it were a mid-stream change.
        assert!(ac.debounce(true, 2), "the first reading after reset should register immediately, regardless of what it is");
    }

    #[test]
    fn build_chain_respects_enabled_flag() {
        use crate::profile::FilterConfig;
        let configs = vec![
            FilterConfig { id: SMOOTHING_ID.into(), enabled: false, params: HashMap::new() },
            FilterConfig { id: NOISE_REDUCTION_ID.into(), enabled: true, params: HashMap::new() },
        ];
        let chain = build_chain(&configs);
        assert_eq!(chain.len(), 1);
        assert_eq!(chain[0].id(), NOISE_REDUCTION_ID);
    }

    #[test]
    fn all_filters_disabled_is_an_empty_chain_ie_raw_passthrough() {
        use crate::profile::default_filters;
        // default_filters() starts everything disabled - build_chain over it
        // must produce zero filters, so `fold` over the chain is a no-op and
        // the raw point passes through completely unmodified.
        let chain = build_chain(&default_filters());
        assert!(chain.is_empty(), "disabled-by-default filters must not appear in the chain");
    }

    #[test]
    fn velocity_smoothing_moves_less_per_step_when_pen_is_slow() {
        // Slow strength 0.9 (heavy smoothing, alpha=0.1), fast strength 0.0
        // (alpha=1.0, passthrough), high sensitivity so the transition
        // happens at an easily-reached speed in this synthetic test.
        let mut f = VelocitySmoothingFilter::from_params(0.9, 0.0, 1.0);
        f.apply(Point { x: 0.0, y: 0.0 }, 0);
        // Tiny, slow movement (1mm over 100ms = 0.01 mm/ms, well under the
        // sensitivity=1.0 reference speed of 0.03 mm/ms) - should be heavily
        // damped, landing well short of the target.
        let slow = f.apply(Point { x: 1.0, y: 0.0 }, 100);
        assert!(slow.x < 0.5, "slow movement should be heavily smoothed, got x={}", slow.x);
    }

    #[test]
    fn velocity_smoothing_passes_fast_movement_through_almost_untouched() {
        let mut f = VelocitySmoothingFilter::from_params(0.9, 0.0, 0.5);
        f.apply(Point { x: 0.0, y: 0.0 }, 0);
        // A full tablet-width jump in 10ms (~1.5mm/ms) - far past the
        // reference speed regardless of sensitivity, so this should land
        // very close to fast_strength's near-zero smoothing.
        let fast = f.apply(Point { x: 150.0, y: 0.0 }, 10);
        assert!(fast.x > 140.0, "fast movement should pass through almost raw, got x={}", fast.x);
    }

    #[test]
    fn velocity_smoothing_first_sample_is_a_direct_passthrough() {
        // No prior point to measure speed from - must not panic or divide by
        // zero, and the very first point has nothing to smooth against.
        let mut f = VelocitySmoothingFilter::from_params(0.9, 0.0, 0.5);
        let out = f.apply(Point { x: 5.0, y: 5.0 }, 0);
        assert_eq!(out, Point { x: 5.0, y: 5.0 });
    }

    #[test]
    fn micro_jitter_holds_position_within_the_deadzone() {
        let mut f = MicroJitterFilter::new(0.1);
        let a = f.apply(Point { x: 10.0, y: 10.0 }, 0);
        assert_eq!(a, Point { x: 10.0, y: 10.0 });
        // A tiny 0.05mm wobble, well inside the 0.1mm deadzone - held.
        let b = f.apply(Point { x: 10.03, y: 10.04 }, 1);
        assert_eq!(b, Point { x: 10.0, y: 10.0 }, "sub-deadzone movement should be held at the last position");
    }

    #[test]
    fn micro_jitter_passes_real_movement_through_unclamped_and_untouched() {
        let mut f = MicroJitterFilter::new(0.1);
        f.apply(Point { x: 10.0, y: 10.0 }, 0);
        // A clearly-real 5mm movement, well past the deadzone.
        let out = f.apply(Point { x: 15.0, y: 10.0 }, 1);
        assert_eq!(out, Point { x: 15.0, y: 10.0 }, "movement past the deadzone must pass through exactly, not be clamped to the deadzone edge");
    }

    #[test]
    fn lift_off_debounce_is_built_only_when_enabled() {
        use crate::profile::FilterConfig;
        let disabled = vec![FilterConfig { id: LIFT_OFF_DEBOUNCE_ID.into(), enabled: false, params: HashMap::new() }];
        assert!(build_lift_off_debounce(&disabled).is_none());

        let enabled = vec![FilterConfig { id: LIFT_OFF_DEBOUNCE_ID.into(), enabled: true, params: HashMap::from([("debounce_ms".to_string(), 4.0)]) }];
        assert!(build_lift_off_debounce(&enabled).is_some());
    }

    #[test]
    fn chain_order_is_spike_rejection_then_micro_jitter_then_noise_reduction_then_velocity_then_one_euro_then_smoothing() {
        use crate::profile::FilterConfig;
        let all_enabled = |id: &str| FilterConfig { id: id.into(), enabled: true, params: HashMap::new() };
        // Deliberately stored out of pipeline order, to prove build_chain
        // fixes the order rather than preserving list order.
        let configs = vec![
            all_enabled(SMOOTHING_ID),
            all_enabled(ONE_EURO_ID),
            all_enabled(VELOCITY_SMOOTHING_ID),
            all_enabled(NOISE_REDUCTION_ID),
            all_enabled(MICRO_JITTER_ID),
            all_enabled(SPIKE_REJECTION_ID),
        ];
        let chain = build_chain(&configs);
        let ids: Vec<&str> = chain.iter().map(|f| f.id()).collect();
        assert_eq!(ids, vec![SPIKE_REJECTION_ID, MICRO_JITTER_ID, NOISE_REDUCTION_ID, VELOCITY_SMOOTHING_ID, ONE_EURO_ID, SMOOTHING_ID]);
    }

    // -- One Euro filter -----------------------------------------------

    #[test]
    fn one_euro_first_sample_is_a_direct_passthrough() {
        let mut f = OneEuroFilter::from_params(0.8, 0.6, 1.0);
        let out = f.apply(Point { x: 5.0, y: 5.0 }, 0);
        assert_eq!(out, Point { x: 5.0, y: 5.0 });
    }

    #[test]
    fn one_euro_smooths_slow_movement_more_than_fast_movement() {
        // Same min_cutoff/beta/d_cutoff for both cases - only the speed of
        // movement differs, proving the adaptive behavior (not just "some
        // smoothing happens") actually depends on speed.
        let mut slow = OneEuroFilter::from_params(0.8, 0.6, 1.0);
        slow.apply(Point { x: 0.0, y: 0.0 }, 0);
        // 0.3mm over 20ms = 15mm/s - slow tracing.
        let slow_out = slow.apply(Point { x: 0.3, y: 0.0 }, 20);
        let slow_lag = 0.3 - slow_out.x;

        let mut fast = OneEuroFilter::from_params(0.8, 0.6, 1.0);
        fast.apply(Point { x: 0.0, y: 0.0 }, 0);
        // 30mm over 20ms = 1500mm/s - a fast flick.
        let fast_out = fast.apply(Point { x: 30.0, y: 0.0 }, 20);
        let fast_lag_fraction = (30.0 - fast_out.x) / 30.0;
        let slow_lag_fraction = slow_lag / 0.3;

        assert!(
            fast_lag_fraction < slow_lag_fraction,
            "fast movement should lag behind the raw target by a smaller fraction than slow movement (fast={fast_lag_fraction}, slow={slow_lag_fraction})"
        );
    }

    #[test]
    fn one_euro_handles_zero_dt_without_panicking_or_producing_nan() {
        let mut f = OneEuroFilter::from_params(0.8, 0.6, 1.0);
        f.apply(Point { x: 0.0, y: 0.0 }, 100);
        let out = f.apply(Point { x: 5.0, y: 5.0 }, 100); // same timestamp - dt=0
        assert!(out.x.is_finite() && out.y.is_finite(), "zero dt must not produce NaN/infinite output");
    }

    #[test]
    fn one_euro_resets_cleanly_across_a_large_reconnect_style_gap() {
        let mut f = OneEuroFilter::from_params(0.8, 0.6, 1.0);
        f.apply(Point { x: 0.0, y: 0.0 }, 0);
        f.apply(Point { x: 1.0, y: 0.0 }, 10);
        // A huge gap (tablet unplugged and replugged), then the pen is now
        // at a totally different physical position - must land there
        // directly, not lag toward it from the old point.
        let out = f.apply(Point { x: 200.0, y: 200.0 }, 5000);
        assert_eq!(out, Point { x: 200.0, y: 200.0 }, "a reconnect-sized gap should be treated as a fresh start, not smoothed from stale history");
    }

    #[test]
    fn one_euro_reset_clears_state_explicitly() {
        let mut f = OneEuroFilter::from_params(0.8, 0.6, 1.0);
        f.apply(Point { x: 0.0, y: 0.0 }, 0);
        f.apply(Point { x: 100.0, y: 0.0 }, 10);
        f.reset();
        let out = f.apply(Point { x: 5.0, y: 5.0 }, 20);
        assert_eq!(out, Point { x: 5.0, y: 5.0 }, "after reset, the next sample has nothing to smooth against");
    }

    // -- Spike rejection -------------------------------------------------

    #[test]
    fn spike_rejection_first_sample_passes_through() {
        let mut f = SpikeRejectionFilter::from_sensitivity(0.5);
        let out = f.apply(Point { x: 10.0, y: 10.0 }, 0);
        assert_eq!(out, Point { x: 10.0, y: 10.0 });
    }

    #[test]
    fn spike_rejection_rejects_an_impossible_teleport() {
        let mut f = SpikeRejectionFilter::from_sensitivity(0.5);
        f.apply(Point { x: 0.0, y: 0.0 }, 0);
        // 100mm in a single ~7.5ms report (~13 mm/ms) - far beyond the
        // fastest realistic flick, and beyond even the least-aggressive
        // (sensitivity=0) 20 mm/ms... use a genuinely absurd jump instead.
        let out = f.apply(Point { x: 500.0, y: 0.0 }, 8);
        assert_eq!(out, Point { x: 0.0, y: 0.0 }, "an impossible jump should be rejected, repeating the last accepted point");
        assert_eq!(f.diagnostic_count(), Some(1));
    }

    #[test]
    fn spike_rejection_recovers_immediately_on_the_next_valid_sample() {
        let mut f = SpikeRejectionFilter::from_sensitivity(0.5);
        f.apply(Point { x: 0.0, y: 0.0 }, 0);
        f.apply(Point { x: 500.0, y: 0.0 }, 8); // rejected
        // The next sample continues near the *original* trajectory, not
        // from the rejected point - must be accepted normally, immediately.
        let out = f.apply(Point { x: 2.0, y: 0.0 }, 16);
        assert_eq!(out, Point { x: 2.0, y: 0.0 }, "a normal sample right after a rejection must be accepted, not frozen");
    }

    #[test]
    fn spike_rejection_never_rejects_a_fast_flick_starting_from_rest() {
        let mut f = SpikeRejectionFilter::from_sensitivity(1.0); // most aggressive setting
        f.apply(Point { x: 0.0, y: 0.0 }, 0);
        // A very fast but entirely plausible flick: ~40mm in one ~7.5ms
        // report, starting from a standing stop.
        let out = f.apply(Point { x: 40.0, y: 0.0 }, 8);
        assert_eq!(out, Point { x: 40.0, y: 0.0 }, "a legitimate flick's onset must never be rejected, even at max sensitivity");
        assert_eq!(f.diagnostic_count(), Some(0));
    }

    #[test]
    fn spike_rejection_never_rejects_a_sustained_fast_flick() {
        let mut f = SpikeRejectionFilter::from_sensitivity(1.0);
        let mut t = 0u64;
        let mut x = 0.0;
        f.apply(Point { x, y: 0.0 }, t);
        // Several consecutive samples all moving fast in the same
        // direction - a real flick in progress, not a one-off glitch.
        for _ in 0..5 {
            t += 8;
            x += 35.0;
            let out = f.apply(Point { x, y: 0.0 }, t);
            assert_eq!(out, Point { x, y: 0.0 }, "sustained fast movement must never be rejected");
        }
        assert_eq!(f.diagnostic_count(), Some(0));
    }

    #[test]
    fn spike_rejection_ignores_a_huge_gap_after_reconnect() {
        let mut f = SpikeRejectionFilter::from_sensitivity(1.0);
        f.apply(Point { x: 0.0, y: 0.0 }, 0);
        // A huge time gap (reconnect), then the pen is at a totally
        // different physical position - must pass straight through, not be
        // treated as a spike.
        let out = f.apply(Point { x: 300.0, y: 300.0 }, 10_000);
        assert_eq!(out, Point { x: 300.0, y: 300.0 });
        assert_eq!(f.diagnostic_count(), Some(0));
    }

    #[test]
    fn spike_rejection_reset_clears_history_but_keeps_the_counter() {
        let mut f = SpikeRejectionFilter::from_sensitivity(0.5);
        f.apply(Point { x: 0.0, y: 0.0 }, 0);
        f.apply(Point { x: 500.0, y: 0.0 }, 8); // rejected, count -> 1
        f.reset();
        assert_eq!(f.diagnostic_count(), Some(1), "the lifetime rejection count must survive a reset");
        // Fresh history: even a big jump right after reset is a "first sample" again.
        let out = f.apply(Point { x: 999.0, y: 999.0 }, 100);
        assert_eq!(out, Point { x: 999.0, y: 999.0 });
    }

    // -- Tap stabilization -------------------------------------------------

    #[test]
    fn tap_stabilizer_passes_through_untouched_while_hovering() {
        let mut ts = TapStabilizer::new(0.5, 15, 0.7);
        let out = ts.apply(Point { x: 3.0, y: 4.0 }, 0, false);
        assert_eq!(out, Point { x: 3.0, y: 4.0 });
    }

    #[test]
    fn tap_stabilizer_anchors_on_the_hover_to_contact_transition() {
        let mut ts = TapStabilizer::new(0.5, 15, 0.7);
        ts.apply(Point { x: 1.0, y: 1.0 }, 0, false); // hovering
        let out = ts.apply(Point { x: 10.0, y: 10.0 }, 1, true); // touches down here
        assert_eq!(out, Point { x: 10.0, y: 10.0 }, "the contact point itself is the anchor - nothing to correct on the transition sample");
    }

    #[test]
    fn tap_stabilizer_damps_tiny_movement_within_the_radius_and_window() {
        let mut ts = TapStabilizer::new(0.5, 15, 1.0); // strength 1.0 = fully pinned, easiest to assert on
        ts.apply(Point { x: 10.0, y: 10.0 }, 0, true); // contact
        let out = ts.apply(Point { x: 10.2, y: 10.0 }, 5, true); // 0.2mm nudge, inside 0.5mm radius, inside 15ms
        assert_eq!(out, Point { x: 10.0, y: 10.0 }, "full-strength damping should pin fully to the anchor");
    }

    #[test]
    fn tap_stabilizer_lets_movement_past_the_radius_straight_through() {
        let mut ts = TapStabilizer::new(0.5, 15, 1.0);
        ts.apply(Point { x: 10.0, y: 10.0 }, 0, true);
        // 2mm movement, well past the 0.5mm radius - a deliberate drag, not tap noise.
        let out = ts.apply(Point { x: 12.0, y: 10.0 }, 2, true);
        assert_eq!(out, Point { x: 12.0, y: 10.0 }, "movement past the radius must never be damped");
    }

    #[test]
    fn tap_stabilizer_stops_correcting_once_the_duration_elapses() {
        let mut ts = TapStabilizer::new(0.5, 15, 1.0);
        ts.apply(Point { x: 10.0, y: 10.0 }, 0, true);
        // Still within the radius, but the 15ms window has elapsed.
        let out = ts.apply(Point { x: 10.2, y: 10.0 }, 20, true);
        assert_eq!(out, Point { x: 10.2, y: 10.0 }, "once the duration elapses, even small movement should pass through");
    }

    #[test]
    fn tap_stabilizer_resets_on_lift_off_and_on_reset() {
        let mut ts = TapStabilizer::new(0.5, 15, 1.0);
        ts.apply(Point { x: 10.0, y: 10.0 }, 0, true);
        ts.apply(Point { x: 10.1, y: 10.0 }, 2, false); // lifts off
        // A brand new contact should get its own fresh anchor at the new point.
        let out = ts.apply(Point { x: 50.0, y: 50.0 }, 5, true);
        assert_eq!(out, Point { x: 50.0, y: 50.0 });

        ts.apply(Point { x: 50.2, y: 50.0 }, 6, true);
        ts.reset();
        let after_reset = ts.apply(Point { x: 90.0, y: 90.0 }, 7, true);
        assert_eq!(after_reset, Point { x: 90.0, y: 90.0 }, "reset should also drop any in-progress contact anchor");
    }

    #[test]
    fn build_tap_stabilizer_is_built_only_when_enabled() {
        use crate::profile::FilterConfig;
        let disabled = vec![FilterConfig { id: TAP_STABILIZATION_ID.into(), enabled: false, params: HashMap::new() }];
        assert!(build_tap_stabilizer(&disabled).is_none());

        let enabled = vec![FilterConfig {
            id: TAP_STABILIZATION_ID.into(),
            enabled: true,
            params: HashMap::from([("radius_mm".to_string(), 0.5), ("duration_ms".to_string(), 15.0), ("strength".to_string(), 0.7)]),
        }];
        assert!(build_tap_stabilizer(&enabled).is_some());
    }
}

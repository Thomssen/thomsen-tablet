//! Owns the live pipeline: opens a discovered tablet's pen interface, reads
//! raw HID reports on a background thread, converts them to millimeters,
//! runs the active profile's filter chain, maps them to screen space, and
//! emits real cursor/click output.
//!
//! The active profile can be swapped live via [`Driver::update_profile`]
//! without reopening the HID device - so switching profiles (manually or,
//! later, per-application) doesn't interrupt the tablet connection.
//!
//! **Relative mode convention:** sensitivity directly scales millimeters of
//! pen movement to pixels of cursor movement (`dx_px = dx_mm * x_sensitivity`).
//! This is a documented choice of this implementation, not a claim to match
//! any other driver's exact formula.

use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::thread::JoinHandle;
use std::time::{Duration, Instant};

use serde::Serialize;

use thomsen_tablet_core::{map_point, pressure_gate, AntiChatter, Filter, InputMode, Point, Profile, TapStabilizer};
use thomsen_tablet_devices::{hid, parse_wacom_ctl472, DiscoveredTablet, RawSample, ReportFormat, TabletDescriptor, CTL472_REPORT_LEN};

use crate::pointer;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DriverStatus {
    pub running: bool,
    /// True once the HID device is actually open and readable. False while
    /// `running` is true but the tablet has been unplugged and the driver is
    /// waiting to reconnect (see `read_loop`'s outer retry loop).
    pub connected: bool,
    pub tablet_name: String,
    pub active_profile_id: String,
    pub active_profile_name: String,
    pub last_sample: Option<RawSample>,
    pub samples_received: u64,
    pub reports_per_second: f64,
    pub last_error: Option<String>,
    /// Ids of every processing stage currently active for the profile in
    /// use, in pipeline order - lets Diagnostics show exactly what's
    /// running rather than the user having to infer it from the Filters
    /// page. Includes the position chain plus anti-chatter/lift-off-debounce/
    /// tap-stabilization, none of which live in `chain` itself (see
    /// `ActiveConfig`).
    pub active_filter_chain: Vec<String>,
    /// Lifetime count of samples the spike-rejection filter has dropped as
    /// implausible, if that filter is enabled - `0` otherwise (including
    /// while it's disabled, rather than a meaningless "not applicable").
    pub spikes_rejected: u64,
}

struct ActiveConfig {
    profile: Profile,
    chain: Vec<Box<dyn Filter>>,
    anti_chatter: Option<AntiChatter>,
    /// Debounces the pen's in-range signal, separately from the tip-button
    /// debounce above - see `process_sample`'s use of it.
    lift_off_debounce: Option<AntiChatter>,
    /// Needs the pen's contact state alongside position, so it isn't a
    /// `Filter` in `chain` - applied explicitly in `process_sample` instead.
    tap_stabilizer: Option<TapStabilizer>,
}

impl ActiveConfig {
    fn new(profile: Profile) -> Self {
        let chain = thomsen_tablet_core::filter::build_chain(&profile.filters);
        let anti_chatter = thomsen_tablet_core::filter::build_anti_chatter(&profile.filters);
        let lift_off_debounce = thomsen_tablet_core::filter::build_lift_off_debounce(&profile.filters);
        let tap_stabilizer = thomsen_tablet_core::filter::build_tap_stabilizer(&profile.filters);
        ActiveConfig { profile, chain, anti_chatter, lift_off_debounce, tap_stabilizer }
    }

    /// Every active stage's id, in pipeline order - see `DriverStatus::active_filter_chain`.
    fn active_filter_chain(&self) -> Vec<String> {
        let mut ids: Vec<String> = self.chain.iter().map(|f| f.id().to_string()).collect();
        if self.anti_chatter.is_some() {
            ids.push(thomsen_tablet_core::filter::ANTI_CHATTER_ID.to_string());
        }
        if self.lift_off_debounce.is_some() {
            ids.push(thomsen_tablet_core::filter::LIFT_OFF_DEBOUNCE_ID.to_string());
        }
        if self.tap_stabilizer.is_some() {
            ids.push(thomsen_tablet_core::filter::TAP_STABILIZATION_ID.to_string());
        }
        ids
    }

    fn spikes_rejected(&self) -> u64 {
        self.chain.iter().find_map(|f| f.diagnostic_count()).unwrap_or(0)
    }

    /// Clears every stage's accumulated state (last point, velocity
    /// history, debounce timers, tap-contact anchor) without discarding the
    /// configuration itself - called when the tablet reconnects, since a
    /// gap of unknown length (and the pen very possibly now at a completely
    /// different physical position) invalidates whatever any stage
    /// remembered from before the disconnect. Rebuilding via `Self::new`
    /// would work too, but this avoids re-parsing every filter's params for
    /// what's otherwise an unchanged configuration.
    fn reset_state(&mut self) {
        for f in self.chain.iter_mut() {
            f.reset();
        }
        if let Some(ac) = self.anti_chatter.as_mut() {
            ac.reset();
        }
        if let Some(lod) = self.lift_off_debounce.as_mut() {
            lod.reset();
        }
        if let Some(ts) = self.tap_stabilizer.as_mut() {
            ts.reset();
        }
    }
}

struct RelativeState {
    /// Last accepted point (mm), reset whenever the pen leaves range so
    /// re-entering doesn't produce one huge jump delta.
    last_point: Option<Point>,
}

/// Input Lab's test-session statistics: report-rate min/max, a timing-gap
/// heuristic for likely dropped reports, and peak pressure seen. Kept
/// separate from the driver's own lifetime counters (`samples_received` etc,
/// used by the Dashboard/Driver pages) specifically so "Reset Test" can
/// clear these without disturbing anything else.
struct TestSession {
    started_at: Instant,
    sample_count: u64,
    rate_min: f64,
    rate_max: f64,
    /// The most recent sample's pipeline timestamp - used only to measure
    /// the gap to the next one, see `record_sample`.
    last_sample_ts_ms: Option<u64>,
    /// A count of inter-sample gaps far longer than this session's own
    /// running-average interval - the CTL-472's protocol has no sequence
    /// number or any other way to *confirm* a dropped report (checked in
    /// `report.rs` - every byte is accounted for), so this is a heuristic
    /// inference from real timing data, not a hardware-verified count. See
    /// `TestSessionStatus::timing_gaps`'s doc comment - the UI must present
    /// it as an estimate, never as an exact number.
    timing_gaps: u64,
    max_pressure_seen: i32,
}

impl TestSession {
    fn new() -> Self {
        TestSession {
            started_at: Instant::now(),
            sample_count: 0,
            rate_min: f64::INFINITY,
            rate_max: 0.0,
            last_sample_ts_ms: None,
            timing_gaps: 0,
            max_pressure_seen: 0,
        }
    }

    fn reset(&mut self) {
        *self = TestSession::new();
    }

    fn average_rate(&self) -> f64 {
        let elapsed = self.started_at.elapsed().as_secs_f64();
        if elapsed <= 0.0 {
            0.0
        } else {
            self.sample_count as f64 / elapsed
        }
    }
}

/// Live telemetry for Input Lab specifically - separate from [`DriverStatus`]
/// (which every other page polls) so this page's higher-frequency polling
/// and Input-Lab-only fields don't add overhead anywhere else.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TestSessionStatus {
    /// The current sample's position in tablet-surface millimeters, before
    /// any filter runs. `None` until at least one sample has been processed.
    pub raw_point: Option<Point>,
    /// Same sample, after the full filter chain (or identical to `raw_point`
    /// while `filter_bypass` is on).
    pub filtered_point: Option<Point>,
    /// Pressure/contact state from that same sample, bundled here (rather
    /// than read separately from `DriverStatus.lastSample`) so the
    /// visualizer's position, pressure, and pen-down readouts are always
    /// from one consistent sample instead of two independently-timed polls.
    pub pressure: i32,
    pub tip_pressed: bool,
    pub in_range: bool,
    pub filter_bypass: bool,
    pub rate_current: f64,
    pub rate_average: f64,
    pub rate_min: f64,
    pub rate_max: f64,
    pub sample_count: u64,
    /// A heuristic estimate of likely-dropped reports (see `TestSession`'s
    /// doc comment) - present this as an estimate in the UI, not a precise count.
    pub timing_gaps: u64,
    pub max_pressure_seen: i32,
}

struct Shared {
    last_sample: Mutex<Option<RawSample>>,
    samples_received: AtomicU64,
    window_start: Mutex<Instant>,
    window_count: AtomicU64,
    current_rate: Mutex<f64>,
    last_error: Mutex<Option<String>>,
    stop_flag: AtomicBool,
    connected: AtomicBool,
    config: Mutex<ActiveConfig>,
    relative: Mutex<RelativeState>,
    last_tip: AtomicBool,
    last_barrel: AtomicBool,
    raw_point: Mutex<Option<Point>>,
    filtered_point: Mutex<Option<Point>>,
    /// The exact sample `raw_point`/`filtered_point` were derived from -
    /// kept separate from `last_sample` (which updates even for
    /// suppressed/unconfirmed blips) so Input Lab's pressure/pen-down
    /// readout is always in sync with the position it's shown alongside.
    visualized_sample: Mutex<Option<RawSample>>,
    /// Temporary, session-only override (never persisted, never touches a
    /// saved profile) that makes the pipeline skip the filter chain and tap
    /// stabilization entirely - Input Lab's "Bypass Filters" control.
    filter_bypass: AtomicBool,
    test_session: Mutex<TestSession>,
}

/// How often to retry opening the tablet after it disconnects.
const RECONNECT_INTERVAL: Duration = Duration::from_millis(1000);

pub struct Driver {
    tablet_name: String,
    shared: Arc<Shared>,
    thread: Option<JoinHandle<()>>,
}

impl Driver {
    /// Opens the tablet's HID interface and starts the full pipeline
    /// (read -> filter -> map -> cursor output) using `profile`. If the
    /// tablet disconnects later, the read thread keeps retrying to reopen
    /// the same device (matched by vendor/product id) rather than dying -
    /// see `read_loop`.
    pub fn start(tablet: DiscoveredTablet, profile: Profile) -> Result<Self, String> {
        let device = open_and_init(&tablet)?;

        let shared = Arc::new(Shared {
            last_sample: Mutex::new(None),
            samples_received: AtomicU64::new(0),
            window_start: Mutex::new(Instant::now()),
            window_count: AtomicU64::new(0),
            current_rate: Mutex::new(0.0),
            last_error: Mutex::new(None),
            stop_flag: AtomicBool::new(false),
            connected: AtomicBool::new(true),
            config: Mutex::new(ActiveConfig::new(profile)),
            relative: Mutex::new(RelativeState { last_point: None }),
            last_tip: AtomicBool::new(false),
            last_barrel: AtomicBool::new(false),
            raw_point: Mutex::new(None),
            filtered_point: Mutex::new(None),
            visualized_sample: Mutex::new(None),
            filter_bypass: AtomicBool::new(false),
            test_session: Mutex::new(TestSession::new()),
        });

        let thread_shared = Arc::clone(&shared);
        let descriptor = tablet.descriptor;
        let tablet_name = tablet.descriptor.name.to_string();

        let thread = std::thread::Builder::new()
            .name("thomsen-tablet-hid-read".into())
            .spawn(move || read_loop(device, &thread_shared, descriptor))
            .map_err(|e| e.to_string())?;

        Ok(Driver { tablet_name, shared, thread: Some(thread) })
    }

    /// Swaps the active profile without reopening the HID device - used
    /// when the user edits the area/mode/filters, or switches profiles.
    pub fn update_profile(&self, profile: Profile) {
        let mut config = self.shared.config.lock().unwrap();
        *config = ActiveConfig::new(profile);
        // A new area/mode should not inherit a stale relative-mode anchor.
        self.shared.relative.lock().unwrap().last_point = None;
    }

    pub fn stop(mut self) {
        self.shared.stop_flag.store(true, Ordering::Relaxed);
        if let Some(handle) = self.thread.take() {
            let _ = handle.join();
        }
        // Release any held buttons so stopping the driver never leaves a
        // mouse button stuck down.
        if self.shared.last_tip.swap(false, Ordering::Relaxed) {
            pointer::set_tip_button(false);
        }
        if self.shared.last_barrel.swap(false, Ordering::Relaxed) {
            pointer::set_barrel_button(false);
        }
    }

    pub fn status(&self) -> DriverStatus {
        let config = self.shared.config.lock().unwrap();
        let (profile_id, profile_name) = (config.profile.id.clone(), config.profile.name.clone());
        let active_filter_chain = config.active_filter_chain();
        let spikes_rejected = config.spikes_rejected();
        drop(config);
        DriverStatus {
            running: true,
            connected: self.shared.connected.load(Ordering::Relaxed),
            tablet_name: self.tablet_name.clone(),
            active_profile_id: profile_id,
            active_profile_name: profile_name,
            last_sample: *self.shared.last_sample.lock().unwrap(),
            samples_received: self.shared.samples_received.load(Ordering::Relaxed),
            reports_per_second: *self.shared.current_rate.lock().unwrap(),
            last_error: self.shared.last_error.lock().unwrap().clone(),
            active_filter_chain,
            spikes_rejected,
        }
    }

    /// Live telemetry for Input Lab - see [`TestSessionStatus`].
    pub fn test_session_status(&self) -> TestSessionStatus {
        let test = self.shared.test_session.lock().unwrap();
        let sample = *self.shared.visualized_sample.lock().unwrap();
        TestSessionStatus {
            raw_point: *self.shared.raw_point.lock().unwrap(),
            filtered_point: *self.shared.filtered_point.lock().unwrap(),
            pressure: sample.map(|s| s.pressure).unwrap_or(0),
            tip_pressed: sample.map(|s| s.tip_pressed).unwrap_or(false),
            in_range: sample.map(|s| s.in_range).unwrap_or(false),
            filter_bypass: self.shared.filter_bypass.load(Ordering::Relaxed),
            rate_current: *self.shared.current_rate.lock().unwrap(),
            rate_average: test.average_rate(),
            rate_min: if test.rate_min.is_finite() { test.rate_min } else { 0.0 },
            rate_max: test.rate_max,
            sample_count: test.sample_count,
            timing_gaps: test.timing_gaps,
            max_pressure_seen: test.max_pressure_seen,
        }
    }

    /// Temporarily skips the filter chain and tap stabilization - Input
    /// Lab's "Bypass Filters" control. Never touches the saved profile.
    pub fn set_filter_bypass(&self, enabled: bool) {
        self.shared.filter_bypass.store(enabled, Ordering::Relaxed);
    }

    pub fn filter_bypass(&self) -> bool {
        self.shared.filter_bypass.load(Ordering::Relaxed)
    }

    /// Clears Input Lab's test-session statistics (report-rate min/max,
    /// timing-gap count, peak pressure) - deliberately does not touch the
    /// profile, filters, tablet area, or any other persisted setting.
    pub fn reset_test_session(&self) {
        self.shared.test_session.lock().unwrap().reset();
    }
}

/// Sends the tablet's feature-report init sequence, if it needs one.
/// Best-effort: log-and-continue on failure, since not every model needs
/// this and a failure here doesn't necessarily mean the device is unusable.
fn open_and_init(tablet: &DiscoveredTablet) -> Result<hidapi::HidDevice, String> {
    let device = hid::open_by_path(&tablet.hid_path)?;
    if let Err(e) = device.send_feature_report(&[0x02, 0x02]) {
        tracing::warn!("feature-report init failed (continuing anyway): {e}");
    }
    Ok(device)
}

/// Outer loop: reads while connected; on any read error, drops the handle
/// and retries opening the same tablet (by vendor/product id) every
/// [`RECONNECT_INTERVAL`] until it's back or the driver is stopped. This is
/// what makes unplugging and replugging the tablet recover on its own
/// rather than requiring the user to press Start again.
fn read_loop(mut device: hidapi::HidDevice, shared: &Shared, descriptor: TabletDescriptor) {
    let mut buf = [0u8; 64];
    let start = Instant::now();

    'connection: loop {
        while !shared.stop_flag.load(Ordering::Relaxed) {
            match device.read_timeout(&mut buf, 100) {
                Ok(0) => continue, // timed out with nothing to read - normal, keep polling stop_flag
                Ok(len) => {
                    let parsed = match descriptor.report_format {
                        ReportFormat::WacomCtl472 if len >= CTL472_REPORT_LEN => parse_wacom_ctl472(&buf[..len], descriptor.max_pressure),
                        _ => None,
                    };
                    // TEMPORARY: verifying the byte layout against a real,
                    // physically-connected tablet for the first time - see
                    // NOTICE.md / README for why this has never been checked
                    // before. Remove once the report format is confirmed.
                    match &parsed {
                        Some(sample) => tracing::info!(
                            raw_bytes = %format!("{:02x?}", &buf[..len]),
                            x = sample.x, y = sample.y, pressure = sample.pressure,
                            in_range = sample.in_range, tip_pressed = sample.tip_pressed,
                            barrel = sample.barrel_button, eraser = sample.eraser_button,
                            hover_distance = sample.hover_distance,
                            "raw sample decoded"
                        ),
                        None => tracing::info!(raw_bytes = %format!("{:02x?}", &buf[..len]), len, "report received but not recognized as a pen report"),
                    }
                    if let Some(sample) = parsed {
                        let timestamp_ms = start.elapsed().as_millis() as u64;
                        record_sample(shared, sample, timestamp_ms);
                        process_sample(shared, sample, &descriptor, timestamp_ms);
                    }
                }
                Err(e) => {
                    tracing::warn!(tablet = descriptor.name, error = %e, "tablet read error - treating as disconnected, will retry");
                    *shared.last_error.lock().unwrap() = Some(e.to_string());
                    shared.connected.store(false, Ordering::Relaxed);
                    release_buttons_if_held(shared);
                    break; // fall through to the reconnect loop below
                }
            }
        }

        if shared.stop_flag.load(Ordering::Relaxed) {
            return;
        }

        // Reconnect loop: try to find and reopen the same tablet model
        // every RECONNECT_INTERVAL, still checking stop_flag frequently so
        // Stop remains responsive even while disconnected.
        loop {
            if shared.stop_flag.load(Ordering::Relaxed) {
                return;
            }
            if let Ok(found) = thomsen_tablet_devices::scan_primary() {
                if let Some(tablet) = found
                    .into_iter()
                    .find(|t| t.descriptor.vendor_id == descriptor.vendor_id && t.descriptor.product_id == descriptor.product_id)
                {
                    match open_and_init(&tablet) {
                        Ok(reopened) => {
                            tracing::info!(tablet = descriptor.name, "reconnected");
                            device = reopened;
                            shared.connected.store(true, Ordering::Relaxed);
                            *shared.last_error.lock().unwrap() = None;
                            // The pen may now be anywhere - every stage's
                            // remembered position/velocity/timing from
                            // before the gap is stale and must not leak
                            // into how the first post-reconnect sample gets
                            // treated (see `Filter::reset`'s doc comment).
                            shared.config.lock().unwrap().reset_state();
                            shared.relative.lock().unwrap().last_point = None;
                            continue 'connection;
                        }
                        Err(e) => {
                            tracing::warn!(tablet = descriptor.name, error = e, "reconnect attempt failed");
                        }
                    }
                }
            }
            sleep_checking_stop(shared, RECONNECT_INTERVAL);
        }
    }
}

/// Sleeps in short increments so `stop_flag` is checked well within the
/// full duration, instead of one long, unresponsive sleep.
fn sleep_checking_stop(shared: &Shared, duration: Duration) {
    const STEP: Duration = Duration::from_millis(100);
    let mut waited = Duration::ZERO;
    while waited < duration {
        if shared.stop_flag.load(Ordering::Relaxed) {
            return;
        }
        std::thread::sleep(STEP.min(duration - waited));
        waited += STEP;
    }
}

fn record_sample(shared: &Shared, sample: RawSample, timestamp_ms: u64) {
    *shared.last_sample.lock().unwrap() = Some(sample);
    shared.samples_received.fetch_add(1, Ordering::Relaxed);
    shared.window_count.fetch_add(1, Ordering::Relaxed);

    let mut window_start = shared.window_start.lock().unwrap();
    let elapsed = window_start.elapsed();
    if elapsed >= Duration::from_secs(1) {
        let count = shared.window_count.swap(0, Ordering::Relaxed);
        let rate = count as f64 / elapsed.as_secs_f64();
        *shared.current_rate.lock().unwrap() = rate;
        *window_start = Instant::now();

        if rate > 0.0 {
            let mut test = shared.test_session.lock().unwrap();
            test.rate_min = test.rate_min.min(rate);
            test.rate_max = test.rate_max.max(rate);
        }
    }
    drop(window_start);

    let mut test = shared.test_session.lock().unwrap();
    test.sample_count += 1;
    test.max_pressure_seen = test.max_pressure_seen.max(sample.pressure);
    // A gap far past this session's own running-average interval, once
    // enough samples exist to make that average meaningful - see
    // `TestSession::timing_gaps`'s doc comment on why this is a heuristic,
    // not a hardware-confirmed count. The flat 20ms floor keeps this from
    // ever firing on ordinary jitter while the running average is still
    // small/noisy in the first handful of samples.
    if let Some(last_ts) = test.last_sample_ts_ms {
        let gap_ms = timestamp_ms.saturating_sub(last_ts) as f64;
        let baseline_ms = test.started_at.elapsed().as_millis() as f64 / test.sample_count.max(1) as f64;
        if test.sample_count > 10 && gap_ms > 20.0 && gap_ms > baseline_ms * 3.0 {
            test.timing_gaps += 1;
        }
    }
    test.last_sample_ts_ms = Some(timestamp_ms);
}

/// Converts device units to millimeters using the tablet's own reported
/// resolution (`max_x`/`max_y` over `width_mm`/`height_mm`), so this stays
/// correct for any tablet's own scale, not just the CTL-472's.
fn to_mm(raw_x: i32, raw_y: i32, descriptor: &TabletDescriptor) -> Point {
    let units_per_mm_x = descriptor.max_x as f64 / descriptor.width_mm;
    let units_per_mm_y = descriptor.max_y as f64 / descriptor.height_mm;
    Point { x: raw_x as f64 / units_per_mm_x, y: raw_y as f64 / units_per_mm_y }
}

fn process_sample(shared: &Shared, sample: RawSample, descriptor: &TabletDescriptor, timestamp_ms: u64) {
    let mut config = shared.config.lock().unwrap();

    // Debounce the in-range signal itself (independent of the tip-button
    // debounce below): a brief drop to "out of range" only counts as a real
    // lift-off once it's persisted for the configured window. Until then,
    // treat it as a stable "still in range" - but importantly, don't feed
    // *this* sample's position through, since a genuinely bouncy read's
    // x/y/pressure are exactly what shouldn't be trusted (real hardware has
    // been observed sending an all-zero payload right as it drops out of
    // range - see report.rs - which would otherwise inject a bogus point
    // into the filter chain and jump the cursor).
    let debounced_in_range = config.lift_off_debounce.as_mut().map(|d| d.debounce(sample.in_range, timestamp_ms)).unwrap_or(sample.in_range);
    if !debounced_in_range {
        shared.relative.lock().unwrap().last_point = None;
        release_buttons_if_held(shared);
        return;
    }
    if !sample.in_range {
        // Raw signal says out of range but the debounce hasn't confirmed a
        // real lift-off yet - suppress this one sample rather than act on
        // position data that came with an out-of-range reading.
        return;
    }

    // Computed here, ahead of position filtering, specifically so tap
    // stabilization below can key off the pen's *debounced* contact state -
    // it must not wait until after the position has already been filtered
    // and sent to the pointer.
    let pressure_ok = pressure_gate(sample.pressure, descriptor.max_pressure, config.profile.pressure_activation_threshold);
    let raw_tip = sample.tip_pressed && pressure_ok;
    let tip = config.anti_chatter.as_mut().map(|ac| ac.debounce(raw_tip, timestamp_ms)).unwrap_or(raw_tip);

    let raw_mm = to_mm(sample.x, sample.y, descriptor);
    // Input Lab's temporary "Bypass Filters" control - session-only, never
    // touches the saved profile. While on, the filtered point (and
    // therefore the real cursor output below) is identical to raw.
    let bypass = shared.filter_bypass.load(Ordering::Relaxed);
    let filtered = if bypass {
        raw_mm
    } else {
        let f = config.chain.iter_mut().fold(raw_mm, |p, f| f.apply(p, timestamp_ms));
        match config.tap_stabilizer.as_mut() {
            Some(ts) => ts.apply(f, timestamp_ms, tip),
            None => f,
        }
    };
    *shared.raw_point.lock().unwrap() = Some(raw_mm);
    *shared.filtered_point.lock().unwrap() = Some(filtered);
    *shared.visualized_sample.lock().unwrap() = Some(sample);

    match config.profile.input_mode {
        InputMode::Absolute => {
            let screen = map_point(filtered, &config.profile.tablet_area, &config.profile.display_area);
            pointer::move_absolute(screen.x, screen.y);
        }
        InputMode::Relative => {
            let mut rel = shared.relative.lock().unwrap();
            if let Some(last) = rel.last_point {
                let dx_mm = filtered.x - last.x;
                let dy_mm = filtered.y - last.y;
                let dx_px = (dx_mm * config.profile.relative_settings.x_sensitivity).round() as i32;
                let dy_px = (dy_mm * config.profile.relative_settings.y_sensitivity).round() as i32;
                if dx_px != 0 || dy_px != 0 {
                    pointer::move_relative(dx_px, dy_px);
                }
            }
            rel.last_point = Some(filtered);
        }
    }

    if tip != shared.last_tip.swap(tip, Ordering::Relaxed) {
        pointer::set_tip_button(tip);
    }
    if sample.barrel_button != shared.last_barrel.swap(sample.barrel_button, Ordering::Relaxed) {
        pointer::set_barrel_button(sample.barrel_button);
    }
}

fn release_buttons_if_held(shared: &Shared) {
    if shared.last_tip.swap(false, Ordering::Relaxed) {
        pointer::set_tip_button(false);
    }
    if shared.last_barrel.swap(false, Ordering::Relaxed) {
        pointer::set_barrel_button(false);
    }
}

/// `ActiveConfig` needs no HID device to test - it's pure config/filter
/// bookkeeping - so its reconnect-reset and diagnostics logic (the parts
/// that are actually new/risky here) are covered directly, without needing
/// real hardware.
#[cfg(test)]
mod tests {
    use super::*;
    use thomsen_tablet_core::{Area, FilterConfig, Profile};

    fn profile_with_filters(filters: Vec<FilterConfig>) -> Profile {
        let mut p = Profile::new("Test", Area::full(150.0, 100.0), Area::full(1920.0, 1080.0));
        p.filters = filters;
        p
    }

    fn enabled(id: &str, params: &[(&str, f64)]) -> FilterConfig {
        FilterConfig { id: id.to_string(), enabled: true, params: params.iter().map(|(k, v)| (k.to_string(), *v)).collect() }
    }

    #[test]
    fn active_filter_chain_lists_every_stage_in_pipeline_order_including_non_chain_ones() {
        use thomsen_tablet_core::filter::*;
        // anti-chatter/lift-off-debounce/tap-stabilization deliberately
        // don't live in `chain` (see ActiveConfig's own doc comment) - this
        // proves `active_filter_chain()` still reports them.
        let profile = profile_with_filters(vec![
            enabled(SMOOTHING_ID, &[("strength", 0.3)]),
            enabled(SPIKE_REJECTION_ID, &[("sensitivity", 0.5)]),
            enabled(ANTI_CHATTER_ID, &[("interval_ms", 15.0)]),
            enabled(LIFT_OFF_DEBOUNCE_ID, &[("debounce_ms", 4.0)]),
            enabled(TAP_STABILIZATION_ID, &[("radius_mm", 0.5), ("duration_ms", 15.0), ("strength", 0.7)]),
        ]);
        let config = ActiveConfig::new(profile);
        assert_eq!(
            config.active_filter_chain(),
            vec![
                SPIKE_REJECTION_ID.to_string(),
                SMOOTHING_ID.to_string(),
                ANTI_CHATTER_ID.to_string(),
                LIFT_OFF_DEBOUNCE_ID.to_string(),
                TAP_STABILIZATION_ID.to_string(),
            ]
        );
    }

    #[test]
    fn spikes_rejected_is_zero_when_spike_rejection_is_not_enabled() {
        let config = ActiveConfig::new(profile_with_filters(vec![]));
        assert_eq!(config.spikes_rejected(), 0);
    }

    #[test]
    fn spikes_rejected_reflects_the_live_running_filters_count() {
        use thomsen_tablet_core::filter::SPIKE_REJECTION_ID;
        let profile = profile_with_filters(vec![enabled(SPIKE_REJECTION_ID, &[("sensitivity", 1.0)])]);
        let mut config = ActiveConfig::new(profile);
        config.chain[0].apply(Point { x: 0.0, y: 0.0 }, 0);
        config.chain[0].apply(Point { x: 500.0, y: 0.0 }, 8); // an impossible jump - rejected
        assert_eq!(config.spikes_rejected(), 1);
    }

    #[test]
    fn reset_state_clears_every_stage_without_discarding_the_configuration() {
        use thomsen_tablet_core::filter::SMOOTHING_ID;
        let profile = profile_with_filters(vec![enabled(SMOOTHING_ID, &[("strength", 0.9)])]);
        let mut config = ActiveConfig::new(profile);
        config.chain[0].apply(Point { x: 0.0, y: 0.0 }, 0);
        // Heavy smoothing (0.9 strength -> alpha 0.1) should still lag well
        // behind a big jump on the very next sample.
        let before_reset = config.chain[0].apply(Point { x: 100.0, y: 0.0 }, 10);
        assert!(before_reset.x < 50.0, "expected heavy smoothing to still be lagging, got {}", before_reset.x);

        config.reset_state();
        // Immediately after reset, the filter has no "last point" to smooth
        // from, so the next sample is a direct passthrough again - proving
        // reset_state() actually reached into the chain, not just the
        // config wrapper around it.
        let after_reset = config.chain[0].apply(Point { x: 100.0, y: 0.0 }, 20);
        assert_eq!(after_reset, Point { x: 100.0, y: 0.0 });
    }

    #[test]
    fn reset_state_does_not_change_the_configuration_itself() {
        use thomsen_tablet_core::filter::SMOOTHING_ID;
        let profile = profile_with_filters(vec![enabled(SMOOTHING_ID, &[("strength", 0.9)])]);
        let mut config = ActiveConfig::new(profile);
        let before = config.active_filter_chain();
        config.reset_state();
        assert_eq!(config.active_filter_chain(), before, "reset_state must clear runtime state, not rebuild/change which filters are active");
    }

    // -- TestSession (Input Lab) -----------------------------------------

    #[test]
    fn fresh_test_session_reports_zero_rate_and_no_finite_min() {
        let session = TestSession::new();
        assert_eq!(session.average_rate(), 0.0, "no samples yet - must not divide by a tiny elapsed time and report a huge fake rate");
        assert_eq!(session.sample_count, 0);
        assert_eq!(session.timing_gaps, 0);
        // rate_min starts at infinity internally (so the first real sample
        // correctly becomes the min) - Driver::test_session_status is what
        // maps that to a UI-safe 0.0, not TestSession itself.
        assert!(session.rate_min.is_infinite());
    }

    #[test]
    fn average_rate_is_sample_count_over_elapsed_time() {
        let mut session = TestSession::new();
        session.started_at = Instant::now() - Duration::from_secs(2);
        session.sample_count = 260;
        // 260 samples over ~2 seconds ~= 130 Hz.
        let rate = session.average_rate();
        assert!((rate - 130.0).abs() < 5.0, "expected ~130 Hz, got {rate}");
    }

    #[test]
    fn reset_clears_every_field_back_to_a_fresh_session() {
        let mut session = TestSession::new();
        session.sample_count = 500;
        session.rate_min = 120.0;
        session.rate_max = 140.0;
        session.timing_gaps = 3;
        session.max_pressure_seen = 2047;
        session.last_sample_ts_ms = Some(9999);

        session.reset();

        assert_eq!(session.sample_count, 0);
        assert_eq!(session.timing_gaps, 0);
        assert_eq!(session.max_pressure_seen, 0);
        assert_eq!(session.last_sample_ts_ms, None);
        assert!(session.rate_min.is_infinite());
        assert_eq!(session.rate_max, 0.0);
    }

    #[test]
    fn test_session_status_maps_infinite_rate_min_to_zero_for_the_ui() {
        // A driver that's running but hasn't completed a single 1-second
        // rate-measurement window yet (e.g. just started) - rate_min must
        // never reach the frontend as `inf`, which doesn't round-trip
        // through JSON.
        let profile = profile_with_filters(vec![]);
        let shared = Shared {
            last_sample: Mutex::new(None),
            samples_received: AtomicU64::new(0),
            window_start: Mutex::new(Instant::now()),
            window_count: AtomicU64::new(0),
            current_rate: Mutex::new(0.0),
            last_error: Mutex::new(None),
            stop_flag: AtomicBool::new(false),
            connected: AtomicBool::new(true),
            config: Mutex::new(ActiveConfig::new(profile)),
            relative: Mutex::new(RelativeState { last_point: None }),
            last_tip: AtomicBool::new(false),
            last_barrel: AtomicBool::new(false),
            raw_point: Mutex::new(None),
            filtered_point: Mutex::new(None),
            visualized_sample: Mutex::new(None),
            filter_bypass: AtomicBool::new(false),
            test_session: Mutex::new(TestSession::new()),
        };
        let driver = Driver { tablet_name: "Test".to_string(), shared: Arc::new(shared), thread: None };
        let status = driver.test_session_status();
        assert_eq!(status.rate_min, 0.0);
        assert!(status.rate_min.is_finite());
    }
}

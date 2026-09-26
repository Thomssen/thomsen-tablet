//! A saved, user-facing configuration bundle - "osu!", "Full Area",
//! "Drawing", "Desktop", "Custom", etc. This is Thomsen Tablet's own concept
//! (unrelated to any external driver's profile format) and is what the
//! Profiles UI manages, and what `app_bindings` lets auto-switch per app.

use std::collections::HashMap;

use serde::{Deserialize, Serialize};

use crate::area::Area;
use crate::filter;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum InputMode {
    Absolute,
    Relative,
}

/// osu! ships two separate programs under the same literal executable name
/// (`osu!.exe`) - stable and lazer - so "the osu! profile" is really two
/// independent slots, one per variant (see `Profile::osu_variant_assignment`
/// and `app_switcher.rs`, which resolves *which* variant is actually running
/// before picking a profile).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum OsuVariant {
    Stable,
    Lazer,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RelativeSettings {
    pub x_sensitivity: f64,
    pub y_sensitivity: f64,
}

impl Default for RelativeSettings {
    fn default() -> Self {
        RelativeSettings { x_sensitivity: 10.0, y_sensitivity: 10.0 }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FilterConfig {
    pub id: String,
    pub enabled: bool,
    #[serde(default)]
    pub params: HashMap<String, f64>,
}

fn filter_config(id: &str, params: &[(&str, f64)]) -> FilterConfig {
    FilterConfig {
        id: id.to_string(),
        enabled: false,
        params: params.iter().map(|(k, v)| (k.to_string(), *v)).collect(),
    }
}

/// Every filter a profile can enable, disabled by default with sensible
/// starting parameters - so the Filters UI always has something concrete to
/// show a toggle and a slider for, per filter, per profile.
pub fn default_filters() -> Vec<FilterConfig> {
    vec![
        filter_config(filter::SMOOTHING_ID, &[("strength", 0.3)]),
        filter_config(filter::NOISE_REDUCTION_ID, &[("samples", 4.0)]),
        filter_config(filter::ANTI_CHATTER_ID, &[("interval_ms", 15.0)]),
        filter_config(filter::VELOCITY_SMOOTHING_ID, &[("slow_strength", 0.5), ("fast_strength", 0.0), ("sensitivity", 0.5)]),
        filter_config(filter::MICRO_JITTER_ID, &[("deadzone_mm", 0.1)]),
        filter_config(filter::LIFT_OFF_DEBOUNCE_ID, &[("debounce_ms", 4.0)]),
        // Starting points reasoned from the published algorithm's own
        // math (beta directly sets the filter's asymptotic lag distance at
        // high speed - see filter.rs's doc comment), not measured against
        // real play - tune by feel, same honesty as velocity-smoothing above.
        filter_config(filter::ONE_EURO_ID, &[("min_cutoff", 0.8), ("beta", 0.6), ("d_cutoff", 1.0)]),
        filter_config(filter::SPIKE_REJECTION_ID, &[("sensitivity", 0.5)]),
        filter_config(filter::TAP_STABILIZATION_ID, &[("radius_mm", 0.5), ("duration_ms", 15.0), ("strength", 0.7)]),
    ]
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Profile {
    /// Stable identity, independent of the user-editable `name` - this is
    /// the persistence key and what `app_bindings`/"active profile" refer to.
    pub id: String,
    pub name: String,
    pub tablet_area: Area,
    pub display_area: Area,
    pub lock_aspect_ratio: bool,
    pub input_mode: InputMode,
    pub relative_settings: RelativeSettings,
    pub filters: Vec<FilterConfig>,
    /// Executable file names (e.g. "osu!.exe", case-insensitive) that
    /// auto-activate this profile when they're the foreground app. Empty
    /// means "never auto-switched to".
    #[serde(default)]
    pub app_bindings: Vec<String>,
    /// Minimum pressure, as a fraction of the tablet's max pressure
    /// (0.0..=1.0), required before a pen-down is honored as a tip click.
    /// `0.0` (the default) disables the gate entirely and trusts the
    /// hardware's own tip-switch bit as-is. See [`pressure_gate`].
    #[serde(default)]
    pub pressure_activation_threshold: f64,
    /// Which osu! variant (if either) the background app-switcher activates
    /// this profile for (see `app_switcher.rs` and
    /// `AppSettings::auto_switch_osu_profile`) - independent of, and
    /// consulted before, `app_bindings`, so setting this up doesn't also
    /// require manually adding an "osu!.exe" binding. `None` means this
    /// profile isn't tied to either variant. At most one profile should be
    /// assigned to a given variant at a time; callers that assign one are
    /// responsible for clearing that same variant on any other profile that
    /// had it (see the `save_profile` command), since enforcing "at most
    /// one per variant" isn't this type's job.
    #[serde(default)]
    pub osu_variant_assignment: Option<OsuVariant>,
}

/// Whether a raw pressure reading clears a profile's configured activation
/// threshold. Pure function of plain numbers (no device/HID dependency) so
/// it's fully unit-testable without hardware; `driver::process_sample` is
/// the one caller that feeds it real values.
///
/// `threshold <= 0.0` always passes - the default, hardware-trusting
/// behavior. Otherwise the reading must reach `threshold` as a fraction of
/// `max_pressure` (guarded against a zero/negative `max_pressure`, which
/// would otherwise divide by zero).
pub fn pressure_gate(pressure: i32, max_pressure: i32, threshold: f64) -> bool {
    if threshold <= 0.0 {
        return true;
    }
    if max_pressure <= 0 {
        return true;
    }
    (pressure as f64 / max_pressure as f64) >= threshold
}

impl Profile {
    pub fn new(name: impl Into<String>, tablet_area: Area, display_area: Area) -> Self {
        Profile {
            id: uuid::Uuid::new_v4().to_string(),
            name: name.into(),
            tablet_area,
            display_area,
            lock_aspect_ratio: false,
            input_mode: InputMode::Absolute,
            relative_settings: RelativeSettings::default(),
            filters: default_filters(),
            app_bindings: Vec::new(),
            pressure_activation_threshold: 0.0,
            osu_variant_assignment: None,
        }
    }

    /// A copy with a new id/name - "Duplicate" in the Profiles UI. Resets
    /// `app_bindings` and `osu_variant_assignment` rather than carrying them
    /// over - both are "this one specific profile is special" markers that
    /// a copy shouldn't silently also claim (two profiles both auto-bound to
    /// osu!.exe, or both assigned to the same osu! variant, would be an
    /// ambiguous, surprising state).
    pub fn duplicate_as(&self, new_name: impl Into<String>) -> Self {
        Profile {
            id: uuid::Uuid::new_v4().to_string(),
            name: new_name.into(),
            app_bindings: Vec::new(),
            osu_variant_assignment: None,
            ..self.clone()
        }
    }

    /// Adds any filter this profile doesn't already have (by id) with its
    /// default config, disabled. A profile saved before a given filter
    /// existed simply won't have it in `filters` at all - without this, the
    /// UI's per-filter fallback (`{ enabled: false, params: {} }`) would show
    /// every one of that filter's sliders at a bare `0` instead of its real
    /// documented default, so turning the toggle on with no other changes
    /// would silently do nothing useful (e.g. velocity smoothing with both
    /// strengths at 0 is a no-op passthrough). Existing entries are never
    /// touched, and this is idempotent - safe to call on every load.
    pub fn backfill_missing_filters(&mut self) {
        for default in default_filters() {
            if !self.filters.iter().any(|f| f.id == default.id) {
                self.filters.push(default);
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn zero_threshold_always_passes() {
        assert!(pressure_gate(0, 2047, 0.0));
        assert!(pressure_gate(-1, 2047, 0.0));
    }

    #[test]
    fn gate_compares_as_a_fraction_of_max_pressure() {
        // 50% threshold against a max of 2000: 999 fails, 1000 clears.
        assert!(!pressure_gate(999, 2000, 0.5));
        assert!(pressure_gate(1000, 2000, 0.5));
        assert!(pressure_gate(2000, 2000, 0.5));
    }

    #[test]
    fn degenerate_max_pressure_does_not_panic_or_divide_by_zero() {
        assert!(pressure_gate(100, 0, 0.5));
        assert!(pressure_gate(100, -5, 0.5));
    }

    #[test]
    fn new_profile_defaults_to_no_activation_threshold() {
        let p = Profile::new("Test", Area::full(100.0, 100.0), Area::full(1920.0, 1080.0));
        assert_eq!(p.pressure_activation_threshold, 0.0);
    }

    #[test]
    fn backfill_adds_missing_filters_with_real_defaults_not_touching_existing_ones() {
        use crate::filter::{NOISE_REDUCTION_ID, SMOOTHING_ID, VELOCITY_SMOOTHING_ID};
        let mut p = Profile::new("Test", Area::full(100.0, 100.0), Area::full(1920.0, 1080.0));
        // Simulate a profile saved before the three newer filters existed,
        // and before the user's own edit to the still-present smoothing filter.
        p.filters.retain(|f| f.id == SMOOTHING_ID || f.id == NOISE_REDUCTION_ID);
        p.filters.iter_mut().find(|f| f.id == SMOOTHING_ID).unwrap().params.insert("strength".into(), 0.77);

        p.backfill_missing_filters();

        assert_eq!(p.filters.len(), default_filters().len(), "every known filter id should now be present");
        let smoothing = p.filters.iter().find(|f| f.id == SMOOTHING_ID).unwrap();
        assert_eq!(smoothing.params["strength"], 0.77, "an already-present filter's params must be left untouched");
        let velocity = p.filters.iter().find(|f| f.id == VELOCITY_SMOOTHING_ID).unwrap();
        assert_eq!(velocity.params["slow_strength"], 0.5, "a backfilled filter should get its real documented default, not a blank 0");
        assert!(!velocity.enabled, "backfilled filters must come in disabled, matching default_filters()");
    }

    #[test]
    fn backfill_is_idempotent() {
        let mut p = Profile::new("Test", Area::full(100.0, 100.0), Area::full(1920.0, 1080.0));
        p.backfill_missing_filters();
        let once = p.filters.clone();
        p.backfill_missing_filters();
        assert_eq!(p.filters, once, "calling backfill again on an already-complete profile must be a no-op");
    }
}

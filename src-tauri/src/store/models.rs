//! Thomsen Tablet's own settings - app preferences only. Tablet profiles
//! (area, input mode, filters, sensitivity) are `thomsen_tablet_core::Profile`,
//! not stored here; this is just how the app itself behaves.

use serde::{Deserialize, Serialize};

pub use thomsen_tablet_core::OsuVariant;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "lowercase")]
pub enum ThemeSetting {
    #[default]
    Dark,
    Light,
    System,
}

/// Which title bar control style to draw - see `TitleBar.tsx`. Purely a
/// frontend rendering choice; nothing on this side depends on it.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "lowercase")]
pub enum WindowStyle {
    #[default]
    Macos,
    Windows,
}

/// The onboarding wizard's "what will you use this for" answer - stored so
/// Settings can show/change it later, and so re-running setup can
/// pre-select the user's previous choice. Applying it only ever *sets*
/// starting defaults at the moment it's chosen (see the onboarding wizard
/// and `services/profiles.ts`'s preset builders) - it's not enforced
/// anywhere afterward.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "lowercase")]
pub enum UsagePreset {
    Osu,
    Drawing,
    General,
    #[default]
    Custom,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AppSettings {
    pub theme: ThemeSetting,

    /// Kept in sync with the real Windows autostart registration by
    /// `sync_autostart` (see `lib.rs`) - not just a stored preference.
    pub start_with_windows: bool,
    /// Whether closing the window hides it to the tray instead of exiting -
    /// see the `WindowEvent::CloseRequested` handler in `lib.rs`.
    pub minimize_to_tray: bool,
    /// Whether the window starts hidden (tray-only) on launch. Only takes
    /// effect when `minimize_to_tray` is also on.
    pub start_minimized: bool,
    /// Persisted now; the update checker itself ships in v1.0.
    pub check_for_updates: bool,

    /// `#[serde(default)]` on everything below - added well after `theme`
    /// etc. above, so a settings.json from before the onboarding wizard
    /// existed must still load cleanly with these falling back sanely,
    /// exactly like `Profile`'s own older-field additions.
    #[serde(default)]
    pub window_style: WindowStyle,
    /// What the Dashboard greeting calls the user - `None`/empty means "no
    /// name set," which the greeting already handles as its own clean case.
    #[serde(default)]
    pub display_name: Option<String>,
    #[serde(default)]
    pub usage_preset: UsagePreset,
    /// Whether the first-run setup wizard has been completed (or skipped
    /// past) at least once. `false` for both a genuinely fresh install and
    /// an older install upgrading from before this field existed - both
    /// cases should see the wizard once, which is the correct behavior for
    /// either.
    #[serde(default)]
    pub onboarding_completed: bool,

    /// User-configured path override for osu! (stable) - only needed when
    /// auto-detection (checking the standard install location) doesn't find
    /// it. `None` means "use auto-detection."
    #[serde(default)]
    pub osu_stable_path: Option<String>,
    /// Same, for osu!lazer.
    #[serde(default)]
    pub osu_lazer_path: Option<String>,
    /// Whether the background app-switcher (see `app_switcher.rs`) is
    /// allowed to activate a profile assigned to a running osu! variant (see
    /// `Profile::osu_variant_assignment`). Plain per-application
    /// `app_bindings` switching is unaffected by this - it's specifically
    /// the osu!-detection path.
    #[serde(default = "default_true")]
    pub auto_switch_osu_profile: bool,
    /// Whether the app-switcher restores whatever profile was active before
    /// switching to the osu! one, once osu! is no longer running.
    #[serde(default = "default_true")]
    pub restore_profile_after_osu_close: bool,
    /// Which variant "Open osu!" should launch when both stable and lazer
    /// are available - only meaningful in that dual-install case.
    #[serde(default)]
    pub preferred_osu_variant: Option<OsuVariant>,
    /// Whether the Dashboard treats a currently-running osu! as an active
    /// "Session" - a named, visible framing over the same auto-switch
    /// behavior `auto_switch_osu_profile` already provides (see
    /// `commands::osu::get_osu_status`), not a second switching mechanism.
    #[serde(default = "default_true")]
    pub session_mode_enabled: bool,
}

fn default_true() -> bool {
    true
}

impl Default for AppSettings {
    fn default() -> Self {
        AppSettings {
            theme: ThemeSetting::default(),
            start_with_windows: false,
            minimize_to_tray: false,
            start_minimized: false,
            check_for_updates: true,
            window_style: WindowStyle::default(),
            display_name: None,
            usage_preset: UsagePreset::default(),
            onboarding_completed: false,
            osu_stable_path: None,
            osu_lazer_path: None,
            auto_switch_osu_profile: true,
            restore_profile_after_osu_close: true,
            preferred_osu_variant: None,
            session_mode_enabled: true,
        }
    }
}

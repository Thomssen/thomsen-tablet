//! The on-disk store: app settings, held in memory and written back
//! atomically on every change.

pub mod models;
pub mod paths;

use std::path::{Path, PathBuf};

use crate::error::AppResult;
use models::AppSettings;

pub struct Store {
    root: PathBuf,
    settings: AppSettings,
    /// Non-fatal problems found while loading the store - surfaced once in
    /// the UI rather than failing startup.
    pub load_warnings: Vec<String>,
}

impl Store {
    pub fn empty(root: PathBuf) -> Self {
        Store {
            root,
            settings: AppSettings::default(),
            load_warnings: Vec::new(),
        }
    }

    /// Read `settings.json` if present. A file that fails to parse is
    /// skipped with a warning rather than failing the whole app.
    pub fn load(root: PathBuf) -> Self {
        let mut store = Store::empty(root);

        let settings_path = paths::settings_file(&store.root);
        if settings_path.exists() {
            match std::fs::read_to_string(&settings_path)
                .map_err(crate::error::AppError::from)
                .and_then(|s| serde_json::from_str::<AppSettings>(&s).map_err(crate::error::AppError::from))
            {
                Ok(s) => store.settings = s,
                Err(e) => store
                    .load_warnings
                    .push(format!("settings.json could not be read ({e}); using defaults")),
            }
        }

        store
    }

    pub fn root(&self) -> &Path {
        &self.root
    }

    pub fn settings(&self) -> AppSettings {
        self.settings.clone()
    }

    pub fn save_settings(&mut self, next: AppSettings) -> AppResult<AppSettings> {
        self.settings = next;
        self.persist_settings()?;
        Ok(self.settings.clone())
    }

    pub fn reset_settings(&mut self) -> AppResult<AppSettings> {
        self.settings = AppSettings::default();
        self.persist_settings()?;
        Ok(self.settings.clone())
    }

    fn persist_settings(&self) -> AppResult<()> {
        let bytes = serde_json::to_vec_pretty(&self.settings)?;
        paths::atomic_write(&paths::settings_file(&self.root), &bytes)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use models::{OsuVariant, ThemeSetting, UsagePreset, WindowStyle};

    fn temp_root() -> PathBuf {
        let dir = std::env::temp_dir().join(format!("thomsen-tablet-store-test-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    /// The core ask behind "settings survive a restart": save, then load
    /// again from a *fresh* `Store` pointed at the same root - simulating
    /// the app being closed and reopened, not just reading back in-memory
    /// state.
    #[test]
    fn settings_survive_a_simulated_restart() {
        let root = temp_root();
        let mut store = Store::load(root.clone());
        store
            .save_settings(AppSettings {
                theme: ThemeSetting::Light,
                start_with_windows: true,
                minimize_to_tray: true,
                start_minimized: true,
                check_for_updates: false,
                window_style: WindowStyle::Windows,
                display_name: Some("Thomsen".to_string()),
                usage_preset: UsagePreset::Osu,
                onboarding_completed: true,
                osu_stable_path: Some("C:\\osu!\\osu!.exe".to_string()),
                osu_lazer_path: None,
                auto_switch_osu_profile: false,
                restore_profile_after_osu_close: false,
                preferred_osu_variant: Some(OsuVariant::Lazer),
                session_mode_enabled: false,
            })
            .unwrap();

        let reloaded = Store::load(root.clone());
        assert_eq!(reloaded.settings().theme, ThemeSetting::Light);
        assert!(reloaded.settings().start_with_windows);
        assert!(reloaded.settings().minimize_to_tray);
        assert!(reloaded.settings().start_minimized);
        assert!(!reloaded.settings().check_for_updates);
        assert_eq!(reloaded.settings().window_style, WindowStyle::Windows);
        assert_eq!(reloaded.settings().display_name.as_deref(), Some("Thomsen"));
        assert_eq!(reloaded.settings().usage_preset, UsagePreset::Osu);
        assert!(reloaded.settings().onboarding_completed);
        assert_eq!(reloaded.settings().osu_stable_path.as_deref(), Some("C:\\osu!\\osu!.exe"));
        assert_eq!(reloaded.settings().osu_lazer_path, None);
        assert!(!reloaded.settings().auto_switch_osu_profile);
        assert!(!reloaded.settings().restore_profile_after_osu_close);
        assert_eq!(reloaded.settings().preferred_osu_variant, Some(OsuVariant::Lazer));
        assert!(!reloaded.settings().session_mode_enabled);
        assert!(reloaded.load_warnings.is_empty());

        std::fs::remove_dir_all(root).ok();
    }

    #[test]
    fn missing_settings_file_loads_defaults_without_warning() {
        let root = temp_root();
        let store = Store::load(root.clone());
        assert_eq!(store.settings().theme, ThemeSetting::Dark);
        assert!(store.load_warnings.is_empty());
        std::fs::remove_dir_all(root).ok();
    }

    /// Corrupted config on disk (truncated write, manual edit gone wrong,
    /// etc.) must not crash startup - it should fall back to defaults and
    /// surface a warning instead.
    #[test]
    fn corrupted_settings_file_falls_back_to_defaults_with_a_warning() {
        let root = temp_root();
        std::fs::write(paths::settings_file(&root), b"{ not valid json at all").unwrap();

        let store = Store::load(root.clone());
        assert_eq!(store.settings().theme, ThemeSetting::Dark);
        assert_eq!(store.load_warnings.len(), 1);
        assert!(store.load_warnings[0].contains("settings.json"));

        std::fs::remove_dir_all(root).ok();
    }

    /// A settings.json from an older schema (e.g. the pre-pivot
    /// `otdPathOverride` field, or simply a file saved before the
    /// onboarding wizard's fields existed at all) must still load - unknown
    /// fields are ignored, and missing new ones fall back to their
    /// `#[serde(default)]`, neither is treated as corruption.
    #[test]
    fn unknown_legacy_fields_are_ignored_not_treated_as_corrupt() {
        let root = temp_root();
        std::fs::write(
            paths::settings_file(&root),
            br#"{"theme":"light","startWithWindows":false,"minimizeToTray":false,"startMinimized":false,"checkForUpdates":true,"otdPathOverride":null}"#,
        )
        .unwrap();

        let store = Store::load(root.clone());
        assert!(store.load_warnings.is_empty());
        assert_eq!(store.settings().theme, ThemeSetting::Light);
        // None of these fields exist in the JSON above at all - an upgrade
        // from before onboarding existed must fall back cleanly, which is
        // also exactly what makes the wizard correctly appear once for an
        // existing install (see `onboarding_completed`'s doc comment).
        assert_eq!(store.settings().window_style, WindowStyle::Macos);
        assert_eq!(store.settings().display_name, None);
        assert_eq!(store.settings().usage_preset, UsagePreset::Custom);
        assert!(!store.settings().onboarding_completed);
        assert_eq!(store.settings().osu_stable_path, None);
        assert_eq!(store.settings().osu_lazer_path, None);
        // These two default to *true* specifically (unlike the others
        // above, which default false/none) - an existing install upgrading
        // should keep behaving like the always-on switching it already had
        // via app_bindings, not silently go quiet.
        assert!(store.settings().auto_switch_osu_profile);
        assert!(store.settings().restore_profile_after_osu_close);
        assert_eq!(store.settings().preferred_osu_variant, None);
        // Same "an upgrading install keeps the always-on behavior it
        // effectively already had" reasoning as the two asserts above.
        assert!(store.settings().session_mode_enabled);

        std::fs::remove_dir_all(root).ok();
    }

    #[test]
    fn reset_settings_restores_defaults_and_persists_them() {
        let root = temp_root();
        let mut store = Store::load(root.clone());
        store
            .save_settings(AppSettings {
                theme: ThemeSetting::Light,
                start_with_windows: true,
                minimize_to_tray: true,
                start_minimized: true,
                check_for_updates: false,
                window_style: WindowStyle::Windows,
                display_name: Some("Thomsen".to_string()),
                usage_preset: UsagePreset::Drawing,
                onboarding_completed: true,
                osu_stable_path: Some("C:\\osu!\\osu!.exe".to_string()),
                osu_lazer_path: Some("C:\\osulazer\\osu!.exe".to_string()),
                auto_switch_osu_profile: false,
                restore_profile_after_osu_close: false,
                preferred_osu_variant: Some(OsuVariant::Stable),
                session_mode_enabled: false,
            })
            .unwrap();

        store.reset_settings().unwrap();
        assert_eq!(store.settings().theme, ThemeSetting::Dark);
        assert_eq!(store.settings().window_style, WindowStyle::Macos);
        assert_eq!(store.settings().display_name, None);
        assert_eq!(store.settings().usage_preset, UsagePreset::Custom);
        assert!(!store.settings().onboarding_completed);
        assert_eq!(store.settings().osu_stable_path, None);
        assert_eq!(store.settings().osu_lazer_path, None);
        assert!(store.settings().auto_switch_osu_profile);
        assert!(store.settings().restore_profile_after_osu_close);
        assert_eq!(store.settings().preferred_osu_variant, None);
        assert!(store.settings().session_mode_enabled);

        let reloaded = Store::load(root.clone());
        assert_eq!(reloaded.settings().theme, ThemeSetting::Dark);
        assert!(!reloaded.settings().start_with_windows);

        std::fs::remove_dir_all(root).ok();
    }
}

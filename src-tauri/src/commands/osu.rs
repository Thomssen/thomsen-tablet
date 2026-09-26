//! osu! detection and launching. Two independent concerns, kept separate on
//! purpose: whether an install is *configured/found* (a path on disk) says
//! nothing about whether it's *running right now* (a live process), and
//! conflating them would mean reporting "not running" for a copy the user
//! launched from a portable/custom location this session doesn't know the
//! path of. No HID/driver logic here - see `app_switcher.rs` for where
//! osu!-running status feeds into profile auto-switching.

use std::path::{Path, PathBuf};

use serde::Serialize;
use tauri::State;

use thomsen_tablet_core::OsuVariant;
use thomsen_tablet_input::foreground;

use crate::error::{AppError, AppResult};
use crate::state::AppState;

/// The literal executable name for *both* osu! stable and osu!lazer on
/// Windows - lazer was rebranded to ship as a plain "osu!.exe" too, so a
/// bare running-process-name check can't tell them apart. Disambiguation
/// happens by resolving each matching process's real image path instead
/// (see `classify_running_paths`), not by the name.
const OSU_EXE_NAME: &str = "osu!.exe";

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OsuInstallStatus {
    /// The executable path Thomsen Tablet would launch for this variant - a
    /// user override (`AppSettings.osu_stable_path`/`osu_lazer_path`) if
    /// one is set, else the standard install location. `None` if neither is
    /// set nor known.
    pub path: Option<String>,
    /// Whether `path` actually exists on disk right now. Kept separate from
    /// `path` itself so a stale/typo'd user override can still be *shown*
    /// (e.g. so Settings can say "this path doesn't exist") rather than
    /// silently disappearing.
    pub path_exists: bool,
    /// Whether `path` came from an explicit user override rather than
    /// auto-detection.
    pub configured: bool,
    /// Whether this variant is currently running - detected independently
    /// of `path`, by resolving every running `osu!.exe` process's real
    /// image path and classifying it (see `classify_running_paths`). True
    /// even if the running copy lives somewhere other than `path`.
    pub running: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OsuStatus {
    pub stable: OsuInstallStatus,
    pub lazer: OsuInstallStatus,
}

fn standard_stable_path() -> Option<PathBuf> {
    std::env::var_os("LOCALAPPDATA").map(|dir| PathBuf::from(dir).join("osu!").join(OSU_EXE_NAME))
}

/// osu!lazer's Squirrel-based installer puts it under `%LOCALAPPDATA%\osulazer`
/// (a top-level `osu!.exe` shim next to versioned `app-x.y.z` folders) - this
/// is a best-guess default location, not a guarantee; a user override always
/// wins (see `resolve_path`).
fn standard_lazer_path() -> Option<PathBuf> {
    std::env::var_os("LOCALAPPDATA").map(|dir| PathBuf::from(dir).join("osulazer").join(OSU_EXE_NAME))
}

/// A path resolved from either a user override or a standard-location guess,
/// plus whether it actually exists - the shared shape both `get_osu_status`
/// and `launch_osu` need, before `get_osu_status` additionally attaches
/// live "is it running" data that `launch_osu` doesn't care about.
struct ResolvedPath {
    path: Option<PathBuf>,
    exists: bool,
    configured: bool,
}

fn resolve_path(configured: Option<&str>, standard: impl Fn() -> Option<PathBuf>) -> ResolvedPath {
    match configured.map(str::trim).filter(|s| !s.is_empty()) {
        Some(p) => {
            let path = PathBuf::from(p);
            let exists = path.exists();
            ResolvedPath { path: Some(path), exists, configured: true }
        }
        None => {
            let path = standard();
            let exists = path.as_deref().is_some_and(Path::exists);
            ResolvedPath { path, exists, configured: false }
        }
    }
}

fn resolve_for(variant: OsuVariant, settings: &crate::store::models::AppSettings) -> ResolvedPath {
    match variant {
        OsuVariant::Stable => resolve_path(settings.osu_stable_path.as_deref(), standard_stable_path),
        OsuVariant::Lazer => resolve_path(settings.osu_lazer_path.as_deref(), standard_lazer_path),
    }
}

/// osu!lazer's real image path always sits under an `osulazer` directory
/// (see `standard_lazer_path`) regardless of which versioned `app-x.y.z`
/// subfolder Squirrel is currently running it from - checking for that
/// substring is more robust than an exact path match, and correctly
/// classifies a lazer install running from a custom location too, as long
/// as the user hasn't literally renamed the folder to remove "osulazer".
/// Anything else matching the shared exe name is treated as stable.
fn is_lazer_image_path(path: &str) -> bool {
    path.to_ascii_lowercase().contains("osulazer")
}

/// Which osu! variant is running right now, if any - `None` if neither is.
/// `app_switcher` uses this (rather than a plain running/not-running bool)
/// because stable and lazer can each have their own assigned profile, so it
/// needs to know *which* one to pick. If somehow both are running at once
/// (two independent processes, so technically possible), stable is reported
/// arbitrarily - a profile is assigned to one variant, so something has to
/// be picked when both are simultaneously true.
pub(crate) fn running_osu_variant() -> Option<OsuVariant> {
    let paths = foreground::list_running_process_paths(OSU_EXE_NAME);
    if paths.iter().any(|p| !is_lazer_image_path(p)) {
        return Some(OsuVariant::Stable);
    }
    if paths.iter().any(|p| is_lazer_image_path(p)) {
        return Some(OsuVariant::Lazer);
    }
    None
}

/// Real-time osu! stable/lazer install and running status - no fabricated
/// values: an install that can't be found reports `path: None`, and
/// "running" only reflects processes actually observed just now.
#[tauri::command]
pub fn get_osu_status(state: State<'_, AppState>) -> OsuStatus {
    let settings = state.store.lock().unwrap().settings();

    let running_paths = foreground::list_running_process_paths(OSU_EXE_NAME);
    let lazer_running = running_paths.iter().any(|p| is_lazer_image_path(p));
    let stable_running = running_paths.iter().any(|p| !is_lazer_image_path(p));

    let to_status = |resolved: ResolvedPath, running: bool| OsuInstallStatus {
        path: resolved.path.map(|p| p.display().to_string()),
        path_exists: resolved.exists,
        configured: resolved.configured,
        running,
    };

    OsuStatus {
        stable: to_status(resolve_for(OsuVariant::Stable, &settings), stable_running),
        lazer: to_status(resolve_for(OsuVariant::Lazer, &settings), lazer_running),
    }
}

/// Launches the requested osu! variant from its resolved path. Never
/// touches the network and never guesses past what `resolve_for` already
/// found - a variant whose path doesn't exist fails with a message pointing
/// at Settings rather than silently no-op'ing.
#[tauri::command]
pub fn launch_osu(variant: OsuVariant, state: State<'_, AppState>) -> AppResult<()> {
    let settings = state.store.lock().unwrap().settings();
    let resolved = resolve_for(variant, &settings);

    if !resolved.exists {
        return Err(AppError::msg("Couldn't find that osu! installation. Set its executable path in Settings."));
    }
    let path = resolved.path.expect("exists implies a path was resolved");

    std::process::Command::new(&path)
        .spawn()
        .map(|_| ())
        .map_err(|e| AppError::msg(format!("Couldn't launch osu! ({e}).")))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn lazer_image_paths_are_recognized_regardless_of_app_version_subfolder() {
        assert!(is_lazer_image_path(r"C:\Users\test\AppData\Local\osulazer\osu!.exe"));
        assert!(is_lazer_image_path(r"C:\Users\test\AppData\Local\osulazer\app-2024.1201.0\osu!.exe"));
        assert!(is_lazer_image_path("C:/Users/test/AppData/Local/OsuLazer/osu!.exe"), "must be case-insensitive");
    }

    #[test]
    fn stable_image_paths_are_not_misclassified_as_lazer() {
        assert!(!is_lazer_image_path(r"C:\Users\test\AppData\Local\osu!\osu!.exe"));
        assert!(!is_lazer_image_path(r"D:\Games\osu!\osu!.exe"));
    }

    #[test]
    fn empty_or_blank_configured_path_falls_back_to_standard_location() {
        let resolved = resolve_path(Some("   "), || Some(PathBuf::from(r"C:\standard\osu!.exe")));
        assert!(!resolved.configured);
        assert_eq!(resolved.path, Some(PathBuf::from(r"C:\standard\osu!.exe")));
    }

    #[test]
    fn a_configured_path_wins_over_the_standard_location_even_when_neither_exists() {
        let resolved = resolve_path(Some(r"C:\custom\osu!.exe"), || Some(PathBuf::from(r"C:\standard\osu!.exe")));
        assert!(resolved.configured);
        assert_eq!(resolved.path, Some(PathBuf::from(r"C:\custom\osu!.exe")));
        assert!(!resolved.exists, "a made-up test path should not exist on the real filesystem");
    }

    #[test]
    fn no_configured_path_and_no_standard_location_resolves_to_nothing() {
        let resolved = resolve_path(None, || None);
        assert_eq!(resolved.path, None);
        assert!(!resolved.exists);
        assert!(!resolved.configured);
    }
}

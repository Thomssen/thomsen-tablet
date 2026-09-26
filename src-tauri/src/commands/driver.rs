//! Tauri commands for the standalone driver: scanning for tablets, and
//! starting/stopping/restarting the live pipeline. See
//! `thomsen_tablet_input::Driver` for what actually happens - this file is
//! orchestration only, no HID/report/mapping logic of its own.

use serde::Serialize;
use tauri::State;

use thomsen_tablet_core::Profile;
use thomsen_tablet_devices::{scan_primary, DiscoveredTablet};
use thomsen_tablet_input::{Driver, DriverStatus, TestSessionStatus};

use super::profiles::default_profile_for;
use crate::error::{AppError, AppResult};
use crate::state::AppState;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScannedTablet {
    pub name: String,
    pub vendor_id: u16,
    pub product_id: u16,
    pub width_mm: f64,
    pub height_mm: f64,
    /// Raw device-unit range for X/Y, as reported by the tablet - what
    /// `RawSample.x`/`.y` are measured in before the driver's `to_mm`
    /// conversion. Exposed so the frontend can normalize a live sample into
    /// a 0..1 fraction of the tablet surface (see the Calibration page).
    pub max_x: i32,
    pub max_y: i32,
    pub max_pressure: i32,
    pub button_count: u8,
}

fn stopped_status() -> DriverStatus {
    DriverStatus {
        running: false,
        connected: false,
        tablet_name: String::new(),
        active_profile_id: String::new(),
        active_profile_name: String::new(),
        last_sample: None,
        samples_received: 0,
        reports_per_second: 0.0,
        last_error: None,
        active_filter_chain: Vec::new(),
        spikes_rejected: 0,
    }
}

/// Lists currently-connected tablets Thomsen Tablet recognizes, without
/// starting anything - used for the Driver page's "Rescan" action and to
/// show what's available before the driver is started. One entry per
/// physical tablet (see `scan_primary`), not one per raw HID interface.
#[tauri::command]
pub fn scan_tablets() -> AppResult<Vec<ScannedTablet>> {
    let found = scan_primary().map_err(AppError::msg)?;
    Ok(found
        .into_iter()
        .map(|t| ScannedTablet {
            name: t.descriptor.name.to_string(),
            vendor_id: t.descriptor.vendor_id,
            product_id: t.descriptor.product_id,
            width_mm: t.descriptor.width_mm,
            height_mm: t.descriptor.height_mm,
            max_x: t.descriptor.max_x,
            max_y: t.descriptor.max_y,
            max_pressure: t.descriptor.max_pressure,
            button_count: t.descriptor.button_count,
        })
        .collect())
}

#[tauri::command]
pub fn get_driver_status(state: State<'_, AppState>) -> DriverStatus {
    let guard = state.driver.lock().unwrap();
    guard.as_ref().map(Driver::status).unwrap_or_else(stopped_status)
}

/// The profile to use when starting: the saved active one if it still
/// exists, else the first saved profile (and remember it as active), else a
/// freshly bootstrapped default for whatever tablet was just found - so
/// starting the driver always works on a first run with zero setup.
fn resolve_profile(state: &AppState, tablet: &DiscoveredTablet) -> AppResult<Profile> {
    if let Some(id) = state.profiles.active_profile_id()? {
        if let Ok(profile) = state.profiles.get(&id) {
            return Ok(profile);
        }
    }
    let existing = state.profiles.list()?;
    if let Some(first) = existing.into_iter().next() {
        state.profiles.set_active(Some(&first.id))?;
        return Ok(first);
    }
    let bootstrapped = default_profile_for(&tablet.descriptor);
    state.profiles.save(&bootstrapped)?;
    state.profiles.set_active(Some(&bootstrapped.id))?;
    tracing::info!(profile = bootstrapped.name, "bootstrapped a default profile for first run");
    Ok(bootstrapped)
}

#[tauri::command]
pub fn start_driver(state: State<'_, AppState>) -> AppResult<DriverStatus> {
    let mut guard = state.driver.lock().unwrap();
    if guard.is_some() {
        return Err(AppError::msg("The driver is already running."));
    }

    let tablet = scan_primary()
        .map_err(AppError::msg)?
        .into_iter()
        .next()
        .ok_or_else(|| AppError::msg("No supported tablet detected. Connect it and try Rescan."))?;
    let profile = resolve_profile(&state, &tablet)?;

    tracing::info!(tablet = tablet.descriptor.name, interface = tablet.interface_number, profile = profile.name, "starting driver");
    let driver = Driver::start(tablet, profile).map_err(AppError::msg)?;
    let status = driver.status();
    *guard = Some(driver);
    Ok(status)
}

#[tauri::command]
pub fn stop_driver(state: State<'_, AppState>) -> AppResult<DriverStatus> {
    let mut guard = state.driver.lock().unwrap();
    if let Some(driver) = guard.take() {
        tracing::info!("stopping driver");
        driver.stop();
    }
    Ok(stopped_status())
}

#[tauri::command]
pub fn restart_driver(state: State<'_, AppState>) -> AppResult<DriverStatus> {
    {
        let mut guard = state.driver.lock().unwrap();
        if let Some(driver) = guard.take() {
            tracing::info!("stopping driver (restart)");
            driver.stop();
        }
    }

    let tablet = scan_primary()
        .map_err(AppError::msg)?
        .into_iter()
        .next()
        .ok_or_else(|| AppError::msg("No supported tablet detected. Connect it and try Rescan."))?;
    let profile = resolve_profile(&state, &tablet)?;

    tracing::info!(tablet = tablet.descriptor.name, interface = tablet.interface_number, profile = profile.name, "restarting driver");
    let driver = Driver::start(tablet, profile).map_err(AppError::msg)?;
    let status = driver.status();
    *state.driver.lock().unwrap() = Some(driver);
    Ok(status)
}

/// Re-reads the active profile from disk and pushes it into the running
/// driver without a restart - used after the Tablet Area/Filters pages save
/// a change to the profile that's currently active.
#[tauri::command]
pub fn apply_active_profile(state: State<'_, AppState>) -> AppResult<DriverStatus> {
    let guard = state.driver.lock().unwrap();
    let driver = guard.as_ref().ok_or_else(|| AppError::msg("The driver isn't running."))?;
    let id = state.profiles.active_profile_id()?.ok_or_else(|| AppError::msg("No active profile."))?;
    let profile = state.profiles.get(&id)?;
    driver.update_profile(profile);
    Ok(driver.status())
}

/// Input Lab's live telemetry - `None` while the driver isn't running, so
/// the page can distinguish "not started" from "started, no sample yet."
#[tauri::command]
pub fn get_test_session_status(state: State<'_, AppState>) -> Option<TestSessionStatus> {
    state.driver.lock().unwrap().as_ref().map(Driver::test_session_status)
}

/// Input Lab's temporary "Bypass Filters" control - session-only, never
/// touches the saved profile. Requires the driver to be running, same as
/// every other live-pipeline command here.
#[tauri::command]
pub fn set_filter_bypass(state: State<'_, AppState>, enabled: bool) -> AppResult<()> {
    let guard = state.driver.lock().unwrap();
    let driver = guard.as_ref().ok_or_else(|| AppError::msg("The driver isn't running."))?;
    driver.set_filter_bypass(enabled);
    Ok(())
}

/// Clears Input Lab's test-session statistics only - never the tablet area,
/// profiles, filters, or any other persisted setting.
#[tauri::command]
pub fn reset_test_session(state: State<'_, AppState>) -> AppResult<()> {
    let guard = state.driver.lock().unwrap();
    let driver = guard.as_ref().ok_or_else(|| AppError::msg("The driver isn't running."))?;
    driver.reset_test_session();
    Ok(())
}

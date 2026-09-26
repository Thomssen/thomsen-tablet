//! Troubleshooting support: a consolidated status snapshot, log file
//! access, and a copyable text report - real data assembled from the same
//! sources the Dashboard/Driver pages use, not a separate mock.

use serde::Serialize;
use tauri::State;

use thomsen_tablet_devices::scan;

use crate::error::{AppError, AppResult};
use crate::state::AppState;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DetectedDevice {
    pub name: String,
    pub vendor_id: String,
    pub product_id: String,
    pub hid_path: String,
    pub interface_number: i32,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DiagnosticsSnapshot {
    pub app_version: String,
    pub os: String,
    pub arch: String,
    pub devices: Vec<DetectedDevice>,
    pub driver_running: bool,
    pub driver_connected: bool,
    pub active_profile_name: Option<String>,
    pub last_driver_error: Option<String>,
    pub logs_dir: String,
    pub config_dir: String,
    /// Every processing stage currently active, in pipeline order - empty
    /// while the driver isn't running. Lets this page show what's actually
    /// live, not just what a profile has toggled on.
    pub active_filter_chain: Vec<String>,
    /// Lifetime count of samples spike-rejection has dropped as
    /// implausible this driver session - `0` while not running or disabled.
    pub spikes_rejected: u64,
}

fn snapshot(state: &AppState) -> DiagnosticsSnapshot {
    let devices = scan()
        .unwrap_or_default()
        .into_iter()
        .map(|t| DetectedDevice {
            name: t.descriptor.name.to_string(),
            vendor_id: format!("{:#06x}", t.descriptor.vendor_id),
            product_id: format!("{:#06x}", t.descriptor.product_id),
            hid_path: t.hid_path,
            interface_number: t.interface_number,
        })
        .collect();

    let driver_status = state.driver.lock().unwrap().as_ref().map(thomsen_tablet_input::Driver::status);
    let root = state.store.lock().unwrap().root().to_path_buf();

    // The active profile is a persisted concept independent of whether the
    // driver happens to be running right now - looked up from the profile
    // store directly rather than `driver_status.active_profile_name`, which
    // is only populated while the driver is actually up.
    let active_profile_name = state
        .profiles
        .active_profile_id()
        .ok()
        .flatten()
        .and_then(|id| state.profiles.get(&id).ok())
        .map(|p| p.name);

    DiagnosticsSnapshot {
        app_version: env!("CARGO_PKG_VERSION").to_string(),
        os: std::env::consts::OS.to_string(),
        arch: std::env::consts::ARCH.to_string(),
        devices,
        driver_running: driver_status.is_some(),
        driver_connected: driver_status.as_ref().map(|s| s.connected).unwrap_or(false),
        active_profile_name,
        active_filter_chain: driver_status.as_ref().map(|s| s.active_filter_chain.clone()).unwrap_or_default(),
        spikes_rejected: driver_status.as_ref().map(|s| s.spikes_rejected).unwrap_or(0),
        last_driver_error: driver_status.and_then(|s| s.last_error),
        logs_dir: root.join("logs").display().to_string(),
        config_dir: root.display().to_string(),
    }
}

#[tauri::command]
pub fn get_diagnostics(state: State<'_, AppState>) -> DiagnosticsSnapshot {
    snapshot(&state)
}

#[tauri::command]
pub fn generate_diagnostic_report(state: State<'_, AppState>) -> String {
    let s = snapshot(&state);
    let mut out = String::new();
    out.push_str("Thomsen Tablet diagnostic report\n");
    out.push_str(&format!("Version: {}\n", s.app_version));
    out.push_str(&format!("OS/Arch: {}/{}\n", s.os, s.arch));
    out.push_str(&format!("Driver running: {} (connected: {})\n", s.driver_running, s.driver_connected));
    out.push_str(&format!("Active profile: {}\n", s.active_profile_name.as_deref().unwrap_or("none")));
    out.push_str(&format!(
        "Active filter chain: {}\n",
        if s.active_filter_chain.is_empty() { "none".to_string() } else { s.active_filter_chain.join(" -> ") }
    ));
    out.push_str(&format!("Spikes rejected (this session): {}\n", s.spikes_rejected));
    out.push_str(&format!("Config dir: {}\n", s.config_dir));
    out.push_str(&format!("Logs dir: {}\n", s.logs_dir));
    out.push_str(&format!("Detected devices: {}\n", s.devices.len()));
    for d in &s.devices {
        out.push_str(&format!(
            "  - {} (VID {} / PID {}) interface {} at {}\n",
            d.name, d.vendor_id, d.product_id, d.interface_number, d.hid_path
        ));
    }
    out
}

/// The most recent log file's tail, for a quick in-app look without leaving
/// the app - "Open Logs" (reveal in Explorer) covers the full history.
#[tauri::command]
pub fn get_recent_logs(state: State<'_, AppState>, max_lines: usize) -> AppResult<String> {
    let root = state.store.lock().unwrap().root().to_path_buf();
    let logs_dir = root.join("logs");
    let mut entries: Vec<_> = std::fs::read_dir(&logs_dir)
        .map_err(|e| AppError::msg(format!("no logs yet: {e}")))?
        .filter_map(|e| e.ok())
        .collect();
    entries.sort_by_key(|e| e.file_name());
    let newest = entries.last().ok_or_else(|| AppError::msg("no log files yet"))?;
    let text = std::fs::read_to_string(newest.path())?;
    let lines: Vec<&str> = text.lines().rev().take(max_lines).collect();
    Ok(lines.into_iter().rev().collect::<Vec<_>>().join("\n"))
}

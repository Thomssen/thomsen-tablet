//! Thomsen Tablet - application wiring.
//!
//! `main.rs` is a one-liner that calls [`run`]. Keeping the app in a library
//! crate keeps every module testable and matches the Tauri v2 template layout.
//!
//! This crate is the UI-integration layer only: it wires Tauri commands to
//! the driver stack, and holds no HID/report-parsing/coordinate-mapping
//! logic of its own. That lives in the sibling crates:
//! - `thomsen-tablet-core`    tablet abstraction, coordinates, profiles, filters
//! - `thomsen-tablet-devices` USB/HID discovery, tablet definitions, report parsing
//! - `thomsen-tablet-input`   the live pipeline: read -> filter -> map -> cursor output

pub mod app_switcher;
pub mod commands;
pub mod error;
pub mod state;
pub mod store;
pub mod tray;

use tauri::{Manager, WindowEvent};
use tauri_plugin_autostart::{MacosLauncher, ManagerExt};

use crate::state::AppState;
use crate::store::Store;

/// Keeps the non-blocking log writer alive for the app's lifetime - dropping
/// it would silently stop flushing buffered log lines to disk.
struct LogGuard(#[allow(dead_code)] tracing_appender::non_blocking::WorkerGuard);

fn init_logging(data_root: &std::path::Path) -> LogGuard {
    let log_dir = data_root.join("logs");
    let file_appender = tracing_appender::rolling::daily(&log_dir, "thomsen-tablet.log");
    let (non_blocking, guard) = tracing_appender::non_blocking(file_appender);

    tracing_subscriber::fmt()
        .with_writer(non_blocking)
        .with_ansi(false)
        .with_env_filter(tracing_subscriber::EnvFilter::try_from_default_env().unwrap_or_else(|_| "info".into()))
        .init();

    LogGuard(guard)
}

/// Keeps the OS autostart registration in step with the saved setting -
/// covers both a fresh install (setting says on, registration doesn't exist
/// yet), the user having removed it out-of-band, and toggling it live from
/// the Settings page (see `commands::settings::save_settings`).
pub(crate) fn sync_autostart(app: &tauri::AppHandle, want_enabled: bool) {
    let manager = app.autolaunch();
    let is_enabled = manager.is_enabled().unwrap_or(false);
    if want_enabled && !is_enabled {
        if let Err(e) = manager.enable() {
            tracing::warn!(error = %e, "couldn't enable start-with-Windows");
        }
    } else if !want_enabled && is_enabled {
        if let Err(e) = manager.disable() {
            tracing::warn!(error = %e, "couldn't disable start-with-Windows");
        }
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_autostart::init(MacosLauncher::LaunchAgent, Some(vec!["--minimized"])))
        .setup(|app| {
            let root = store::paths::data_dir(app.handle()).expect("resolve %APPDATA%\\Thomsen Tablet");

            app.manage(init_logging(&root));
            tracing::info!(version = env!("CARGO_PKG_VERSION"), "Thomsen Tablet starting");

            let store = Store::load(root.clone());
            let profiles = thomsen_tablet_core::ProfileStore::new(root);
            let settings = store.settings();
            app.manage(AppState::new(store, profiles));

            sync_autostart(app.handle(), settings.start_with_windows);
            tray::setup(app.handle())?;
            app_switcher::spawn(app.handle().clone());

            // Logged at startup (not just when the Driver page happens to be
            // opened) so a support log always shows what was connected.
            match thomsen_tablet_devices::scan() {
                Ok(found) if found.is_empty() => tracing::info!("startup scan: no supported tablet detected"),
                Ok(found) => {
                    for t in &found {
                        tracing::info!(
                            name = t.descriptor.name,
                            vendor_id = format!("{:#06x}", t.descriptor.vendor_id),
                            product_id = format!("{:#06x}", t.descriptor.product_id),
                            hid_path = t.hid_path,
                            interface = t.interface_number,
                            usage_page = format!("{:#06x}", t.usage_page),
                            usage = format!("{:#06x}", t.usage),
                            "startup scan: found tablet interface"
                        );
                    }
                }
                Err(e) => tracing::warn!(error = e, "startup scan failed"),
            }

            if let Some(window) = app.get_webview_window("main") {
                // Window CloseRequested: hide instead of exiting when
                // "minimize to tray" is on, so the driver keeps running.
                let app_handle = app.handle().clone();
                window.on_window_event(move |event| {
                    if let WindowEvent::CloseRequested { api, .. } = event {
                        let minimize_to_tray = app_handle.state::<AppState>().store.lock().unwrap().settings().minimize_to_tray;
                        if minimize_to_tray {
                            api.prevent_close();
                            if let Some(w) = app_handle.get_webview_window("main") {
                                let _ = w.hide();
                            }
                        }
                    }
                });

                // The window starts hidden (tauri.conf.json) to avoid a
                // white flash while the webview paints. Reveal it now,
                // unless the user asked to start minimized to the tray.
                let start_hidden = settings.start_minimized && settings.minimize_to_tray;
                if !start_hidden {
                    window.show()?;
                    let _ = window.set_focus();
                }
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::app_info,
            commands::get_computer_name,
            commands::get_settings,
            commands::save_settings,
            commands::reset_settings,
            commands::scan_tablets,
            commands::get_driver_status,
            commands::start_driver,
            commands::stop_driver,
            commands::restart_driver,
            commands::apply_active_profile,
            commands::get_test_session_status,
            commands::set_filter_bypass,
            commands::reset_test_session,
            commands::list_profiles,
            commands::ensure_active_profile,
            commands::get_profile,
            commands::save_profile,
            commands::duplicate_profile,
            commands::delete_profile,
            commands::get_active_profile_id,
            commands::set_active_profile,
            commands::export_profile,
            commands::import_profile,
            commands::get_diagnostics,
            commands::generate_diagnostic_report,
            commands::get_recent_logs,
            commands::get_osu_status,
            commands::launch_osu,
        ])
        .run(tauri::generate_context!())
        .expect("error while running Thomsen Tablet");
}

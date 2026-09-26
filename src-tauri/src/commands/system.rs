//! App-level commands: identity and data location.

use serde::Serialize;
use tauri::State;

use crate::state::AppState;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppInfo {
    pub name: String,
    pub version: String,
    pub data_dir: String,
    /// Non-fatal problems found while loading the store (e.g. a corrupt file).
    pub load_warnings: Vec<String>,
}

#[tauri::command]
pub fn app_info(state: State<'_, AppState>) -> AppInfo {
    let store = state.store.lock().unwrap();
    AppInfo {
        name: "Thomsen Tablet".into(),
        version: env!("CARGO_PKG_VERSION").into(),
        data_dir: store.root().display().to_string(),
        load_warnings: store.load_warnings.clone(),
    }
}

/// The real Windows machine name (`%COMPUTERNAME%` - always set for a
/// logged-in session, no extra dependency or network access needed), for
/// the Dashboard's greeting. `None` on the rare chance it's unset or empty;
/// the frontend owns the "Your PC" fallback copy, same as any other
/// possibly-missing display value.
#[tauri::command]
pub fn get_computer_name() -> Option<String> {
    std::env::var("COMPUTERNAME").ok().filter(|s| !s.trim().is_empty())
}

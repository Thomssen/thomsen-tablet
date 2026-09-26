//! Thomsen Tablet's own settings (`store::models::AppSettings`) - app
//! preferences only, not tablet profiles.

use tauri::{AppHandle, State};

use crate::error::AppResult;
use crate::state::AppState;
use crate::store::models::AppSettings;

#[tauri::command]
pub fn get_settings(state: State<'_, AppState>) -> AppSettings {
    state.store.lock().unwrap().settings()
}

#[tauri::command]
pub fn save_settings(app: AppHandle, state: State<'_, AppState>, settings: AppSettings) -> AppResult<AppSettings> {
    let saved = state.store.lock().unwrap().save_settings(settings)?;
    crate::sync_autostart(&app, saved.start_with_windows);
    Ok(saved)
}

#[tauri::command]
pub fn reset_settings(app: AppHandle, state: State<'_, AppState>) -> AppResult<AppSettings> {
    let reset = state.store.lock().unwrap().reset_settings()?;
    crate::sync_autostart(&app, reset.start_with_windows);
    Ok(reset)
}

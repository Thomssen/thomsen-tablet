//! Profile CRUD, active-profile selection, and import/export. Persistence
//! itself lives in `thomsen_tablet_core::ProfileStore` - this is just the
//! Tauri-facing surface over it.

use tauri::State;

use thomsen_tablet_core::{Area, Profile};
use thomsen_tablet_devices::{scan_primary, TabletDescriptor};
use thomsen_tablet_input::pointer;

use crate::error::{AppError, AppResult};
use crate::state::AppState;

/// A sensible starting profile for a newly-detected tablet: full tablet
/// surface mapped to the full virtual screen (every connected monitor).
/// Deliberately simple - the Tablet Area page is where this gets refined.
pub fn default_profile_for(descriptor: &TabletDescriptor) -> Profile {
    let vs = pointer::virtual_screen();
    let tablet_area = Area::full(descriptor.width_mm, descriptor.height_mm);
    let display_area = if vs.width > 0 && vs.height > 0 {
        Area {
            width: vs.width as f64,
            height: vs.height as f64,
            x: vs.x as f64 + vs.width as f64 / 2.0,
            y: vs.y as f64 + vs.height as f64 / 2.0,
            rotation: 0.0,
        }
    } else {
        Area::full(1920.0, 1080.0)
    };
    Profile::new("Default", tablet_area, display_area)
}

#[tauri::command]
pub fn list_profiles(state: State<'_, AppState>) -> AppResult<Vec<Profile>> {
    Ok(state.profiles.list()?)
}

/// Returns the active profile, creating one first if none exists yet -
/// used by the onboarding wizard, which needs *something* to apply a usage
/// preset/filter preset to even before the driver has ever been started
/// (that's normally what bootstraps the first profile - see
/// `commands::driver::resolve_profile`). Deliberately never requires a
/// tablet to be connected: a detected one gives a better-fitting default
/// area, but onboarding must not block without one.
#[tauri::command]
pub fn ensure_active_profile(state: State<'_, AppState>) -> AppResult<Profile> {
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

    let descriptor = scan_primary().ok().and_then(|found| found.into_iter().next()).map(|t| t.descriptor);
    let bootstrapped = match descriptor {
        Some(d) => default_profile_for(&d),
        // No tablet to size the area from - a generic placeholder the
        // Tablet Area page can refine, same spirit as `default_profile_for`
        // itself ("deliberately simple").
        None => Profile::new("Default", Area::full(152.0, 95.0), Area::full(1920.0, 1080.0)),
    };
    state.profiles.save(&bootstrapped)?;
    state.profiles.set_active(Some(&bootstrapped.id))?;
    Ok(bootstrapped)
}

#[tauri::command]
pub fn get_profile(state: State<'_, AppState>, id: String) -> AppResult<Profile> {
    Ok(state.profiles.get(&id)?)
}

/// Creates or updates a profile - if `profile.id` doesn't already exist,
/// this creates it. The frontend generates ids itself (`crypto.randomUUID()`)
/// so a single call can cover both cases.
#[tauri::command]
pub fn save_profile(state: State<'_, AppState>, profile: Profile) -> AppResult<Profile> {
    if profile.name.trim().is_empty() {
        return Err(AppError::Invalid("Give the profile a name.".into()));
    }

    // At most one profile can be assigned to a given osu! variant - clear
    // that same variant on any other profile that had it, so assigning one
    // always unambiguously replaces rather than adds to the set. Stable and
    // lazer are independent slots: assigning this profile to stable must
    // not disturb whichever profile (possibly this same one) is assigned to lazer.
    if let Some(variant) = profile.osu_variant_assignment {
        for mut other in state
            .profiles
            .list()?
            .into_iter()
            .filter(|p| p.id != profile.id && p.osu_variant_assignment == Some(variant))
        {
            other.osu_variant_assignment = None;
            state.profiles.save(&other)?;
        }
    }

    state.profiles.save(&profile)?;

    // If a live driver is using this exact profile, push the change through
    // immediately rather than waiting for a restart.
    if let Some(driver) = state.driver.lock().unwrap().as_ref() {
        if driver.status().active_profile_id == profile.id {
            driver.update_profile(profile.clone());
        }
    }
    Ok(profile)
}

#[tauri::command]
pub fn duplicate_profile(state: State<'_, AppState>, id: String, new_name: String) -> AppResult<Profile> {
    let original = state.profiles.get(&id)?;
    let dup = original.duplicate_as(new_name);
    state.profiles.save(&dup)?;
    Ok(dup)
}

#[tauri::command]
pub fn delete_profile(state: State<'_, AppState>, id: String) -> AppResult<()> {
    Ok(state.profiles.delete(&id)?)
}

#[tauri::command]
pub fn get_active_profile_id(state: State<'_, AppState>) -> AppResult<Option<String>> {
    Ok(state.profiles.active_profile_id()?)
}

#[tauri::command]
pub fn set_active_profile(state: State<'_, AppState>, id: Option<String>) -> AppResult<()> {
    Ok(state.profiles.set_active(id.as_deref())?)
}

#[tauri::command]
pub fn export_profile(state: State<'_, AppState>, id: String, path: String) -> AppResult<()> {
    let profile = state.profiles.get(&id)?;
    let bytes = serde_json::to_vec_pretty(&profile)?;
    std::fs::write(&path, bytes).map_err(AppError::from)
}

/// Imports a profile file, always as a *new* profile (fresh id) so it can
/// never silently overwrite an existing one with a colliding id.
#[tauri::command]
pub fn import_profile(state: State<'_, AppState>, path: String) -> AppResult<Profile> {
    let text = std::fs::read_to_string(&path).map_err(|e| AppError::msg(format!("Couldn't read {path}: {e}")))?;
    let mut profile: Profile =
        serde_json::from_str(&text).map_err(|e| AppError::Invalid(format!("That file isn't a valid Thomsen Tablet profile: {e}")))?;
    profile.id = uuid::Uuid::new_v4().to_string();
    state.profiles.save(&profile)?;
    Ok(profile)
}

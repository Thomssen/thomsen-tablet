//! Automatic profile switching, on a single background thread with two
//! independent triggers:
//! - Per-application: when the *foreground* window's process matches a
//!   profile's `app_bindings`, that profile becomes active.
//! - osu!: when osu! (stable or lazer) starts running *anywhere* - it
//!   doesn't need to be focused - the profile assigned to that specific
//!   variant (`Profile::osu_variant_assignment`) becomes active, and the
//!   previously-active profile is restored once osu! closes. Gated on
//!   `AppSettings.auto_switch_osu_profile`/`restore_profile_after_osu_close`
//!   respectively, and independent of `app_bindings` - assigning a profile
//!   to osu! doesn't also require manually binding it to "osu!.exe".
//!
//! Runs as a plain background thread (not a Tauri command) since it's an
//! ambient behavior with no direct UI trigger, started once at app launch
//! and running for the app's whole lifetime.

use std::time::Duration;

use tauri::{AppHandle, Manager};

use thomsen_tablet_core::{OsuVariant, Profile};

use crate::state::AppState;

const POLL_INTERVAL: Duration = Duration::from_millis(1500);

pub fn spawn(app: AppHandle) {
    std::thread::Builder::new()
        .name("thomsen-tablet-app-switcher".into())
        .spawn(move || run(app))
        .expect("spawn app-switcher thread");
}

fn run(app: AppHandle) {
    let mut last_foreground: Option<String> = None;
    let mut current_osu_variant: Option<OsuVariant> = None;
    let mut profile_before_osu: Option<String> = None;

    loop {
        std::thread::sleep(POLL_INTERVAL);
        let state = app.state::<AppState>();

        handle_osu_lifecycle(&state, &mut current_osu_variant, &mut profile_before_osu);

        let Some(process_name) = thomsen_tablet_input::foreground::current_process_name() else {
            continue;
        };
        if last_foreground.as_deref() == Some(process_name.as_str()) {
            continue;
        }
        last_foreground = Some(process_name.clone());

        let profiles = match state.profiles.list() {
            Ok(p) => p,
            Err(e) => {
                tracing::warn!(error = %e, "app-switcher: couldn't list profiles");
                continue;
            }
        };

        let Some(matched) = profiles.into_iter().find(|p| {
            p.app_bindings.iter().any(|bound| bound.eq_ignore_ascii_case(&process_name))
        }) else {
            continue;
        };

        let already_active = state.profiles.active_profile_id().ok().flatten().as_deref() == Some(matched.id.as_str());
        if already_active {
            continue;
        }

        tracing::info!(process = process_name, profile = matched.name, "app-switcher: activating bound profile");
        activate(&state, matched);
    }
}

/// Tracks which osu! variant (if any) is running across ticks in
/// `current_osu_variant`, and reacts only on a real transition - "just
/// started," "just closed," or "switched straight from one variant to the
/// other" - rather than re-activating every 1.5s while osu! simply stays
/// open. `profile_before_osu` carries the profile that was active at the
/// moment osu! started, across however many ticks osu! keeps running, so it
/// can be restored on close.
fn handle_osu_lifecycle(state: &AppState, current_osu_variant: &mut Option<OsuVariant>, profile_before_osu: &mut Option<String>) {
    let settings = state.store.lock().unwrap().settings();
    if !settings.auto_switch_osu_profile {
        // Reset the edge rather than leaving it stuck: if osu! is running
        // when the toggle is turned back on later, that should be treated
        // as a fresh "just started" so the assigned profile actually gets
        // (re-)applied, not silently skipped as "no change."
        *current_osu_variant = None;
        return;
    }

    let running = crate::commands::running_osu_variant();
    if running == *current_osu_variant {
        return;
    }

    // Closing side of the transition, if we were tracking a variant.
    if current_osu_variant.is_some() {
        if settings.restore_profile_after_osu_close {
            if let Some(previous_id) = profile_before_osu.take() {
                if let Ok(previous) = state.profiles.get(&previous_id) {
                    tracing::info!(profile = previous.name, "app-switcher: osu! closed, restoring previous profile");
                    activate(state, previous);
                }
            }
        } else {
            profile_before_osu.take();
        }
    }

    // Opening side of the transition, if a variant is now running.
    if let Some(variant) = running {
        match state.profiles.list() {
            Ok(profiles) => match profiles.into_iter().find(|p| p.osu_variant_assignment == Some(variant)) {
                Some(assigned) => {
                    let current_active = state.profiles.active_profile_id().ok().flatten();
                    if current_active.as_deref() != Some(assigned.id.as_str()) {
                        *profile_before_osu = current_active;
                        tracing::info!(profile = assigned.name, variant = ?variant, "app-switcher: osu! detected, activating assigned profile");
                        activate(state, assigned);
                    }
                }
                None => tracing::debug!(variant = ?variant, "app-switcher: osu! detected but no profile is assigned to this variant"),
            },
            Err(e) => tracing::warn!(error = %e, "app-switcher: couldn't list profiles"),
        }
    }

    *current_osu_variant = running;
}

fn activate(state: &AppState, profile: Profile) {
    if let Err(e) = state.profiles.set_active(Some(&profile.id)) {
        tracing::warn!(error = %e, "app-switcher: couldn't persist active profile");
        return;
    }
    if let Some(driver) = state.driver.lock().unwrap().as_ref() {
        driver.update_profile(profile);
    }
}

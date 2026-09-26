import type { FilterConfig, Profile } from "@/types";
import { FILTER_IDS } from "@/types";
import { invoke } from "./ipc";

/** Matches `thomsen_tablet_core::profile::default_filters()` - kept in sync
 * by hand since a new profile is constructed here on the frontend, then
 * just persisted as-is by the backend. */
export function defaultFilters(): FilterConfig[] {
  return [
    { id: FILTER_IDS.SMOOTHING, enabled: false, params: { strength: 0.3 } },
    { id: FILTER_IDS.NOISE_REDUCTION, enabled: false, params: { samples: 4 } },
    { id: FILTER_IDS.ANTI_CHATTER, enabled: false, params: { interval_ms: 15 } },
    { id: FILTER_IDS.VELOCITY_SMOOTHING, enabled: false, params: { slow_strength: 0.5, fast_strength: 0.0, sensitivity: 0.5 } },
    { id: FILTER_IDS.MICRO_JITTER, enabled: false, params: { deadzone_mm: 0.1 } },
    { id: FILTER_IDS.LIFT_OFF_DEBOUNCE, enabled: false, params: { debounce_ms: 4 } },
    // Starting points reasoned from the published One Euro filter's own
    // math (beta directly sets its worst-case lag distance at high speed -
    // see FiltersPage's description), not measured against real play.
    { id: FILTER_IDS.ONE_EURO, enabled: false, params: { min_cutoff: 0.8, beta: 0.6, d_cutoff: 1.0 } },
    { id: FILTER_IDS.SPIKE_REJECTION, enabled: false, params: { sensitivity: 0.5 } },
    { id: FILTER_IDS.TAP_STABILIZATION, enabled: false, params: { radius_mm: 0.5, duration_ms: 15, strength: 0.7 } },
  ];
}

/** The onboarding wizard's "Raw" filter style - literally the all-off
 * defaults, reused rather than duplicated: "lowest processing" is exactly
 * what `defaultFilters()` already is. */
export const rawFilters = defaultFilters;

/** The "Competitive" preset: minimal filtering with a focus on
 * responsiveness - sits between Raw (nothing at all) and Balanced. Keeps
 * only the two filters that don't touch position smoothing at all: spike
 * rejection (throws out individual reports no real pen stroke could
 * produce - protects against bad HID reads, not legitimate fast movement)
 * and a very short lift-off debounce (guards against an accidental dropped
 * click from a brief hover blip). Nothing here can make a real, deliberate
 * movement feel less direct. */
export function competitiveFilters(): FilterConfig[] {
  return [
    { id: FILTER_IDS.SMOOTHING, enabled: false, params: { strength: 0 } },
    { id: FILTER_IDS.NOISE_REDUCTION, enabled: false, params: { samples: 1 } },
    { id: FILTER_IDS.ANTI_CHATTER, enabled: false, params: { interval_ms: 5 } },
    { id: FILTER_IDS.VELOCITY_SMOOTHING, enabled: false, params: { slow_strength: 0, fast_strength: 0, sensitivity: 0.5 } },
    { id: FILTER_IDS.MICRO_JITTER, enabled: false, params: { deadzone_mm: 0.02 } },
    { id: FILTER_IDS.LIFT_OFF_DEBOUNCE, enabled: true, params: { debounce_ms: 3 } },
    { id: FILTER_IDS.ONE_EURO, enabled: false, params: { min_cutoff: 0.8, beta: 0.6, d_cutoff: 1.0 } },
    { id: FILTER_IDS.SPIKE_REJECTION, enabled: true, params: { sensitivity: 0.5 } },
    { id: FILTER_IDS.TAP_STABILIZATION, enabled: false, params: { radius_mm: 0.5, duration_ms: 15, strength: 0.7 } },
  ];
}

/** The "Balanced" preset: a light, low-latency touch - just enough to smooth
 * over real sensor/switch noise, nothing that reintroduces perceptible lag. */
export function balancedFilters(): FilterConfig[] {
  return [
    { id: FILTER_IDS.SMOOTHING, enabled: false, params: { strength: 0.3 } },
    { id: FILTER_IDS.NOISE_REDUCTION, enabled: false, params: { samples: 4 } },
    { id: FILTER_IDS.ANTI_CHATTER, enabled: true, params: { interval_ms: 10 } },
    { id: FILTER_IDS.VELOCITY_SMOOTHING, enabled: false, params: { slow_strength: 0.5, fast_strength: 0.0, sensitivity: 0.5 } },
    { id: FILTER_IDS.MICRO_JITTER, enabled: true, params: { deadzone_mm: 0.06 } },
    { id: FILTER_IDS.LIFT_OFF_DEBOUNCE, enabled: true, params: { debounce_ms: 4 } },
    { id: FILTER_IDS.ONE_EURO, enabled: false, params: { min_cutoff: 0.8, beta: 0.6, d_cutoff: 1.0 } },
    { id: FILTER_IDS.SPIKE_REJECTION, enabled: true, params: { sensitivity: 0.4 } },
    { id: FILTER_IDS.TAP_STABILIZATION, enabled: true, params: { radius_mm: 0.4, duration_ms: 10, strength: 0.5 } },
  ];
}

/** The "Stable" preset: more jitter reduction than Balanced while staying
 * suitable for fast gameplay - direct/raw aim during fast movement, a light
 * steadying touch only on tiny slow movements, tuned by feel rather than
 * measured against real hardware (see FiltersPage). Deliberately not called
 * "Best" or "Pro" anywhere - it's one of five starting points, not a
 * universal recommendation (different players prefer different settings).
 *
 * Uses the One Euro filter as the one adaptive-smoothing stage rather than
 * enabling it alongside velocity-based smoothing too - stacking two filters
 * that both solve "smooth when slow, direct when fast" would only add
 * latency without adding anything real, so velocity-based smoothing is left
 * off here (still available to enable by hand). */
export function stableFilters(): FilterConfig[] {
  return [
    { id: FILTER_IDS.SMOOTHING, enabled: false, params: { strength: 0 } },
    { id: FILTER_IDS.NOISE_REDUCTION, enabled: false, params: { samples: 1 } },
    { id: FILTER_IDS.ANTI_CHATTER, enabled: false, params: { interval_ms: 5 } },
    { id: FILTER_IDS.VELOCITY_SMOOTHING, enabled: false, params: { slow_strength: 0.12, fast_strength: 0, sensitivity: 0.5 } },
    { id: FILTER_IDS.MICRO_JITTER, enabled: true, params: { deadzone_mm: 0.04 } },
    { id: FILTER_IDS.LIFT_OFF_DEBOUNCE, enabled: true, params: { debounce_ms: 4 } },
    { id: FILTER_IDS.ONE_EURO, enabled: true, params: { min_cutoff: 1.2, beta: 0.8, d_cutoff: 1.0 } },
    { id: FILTER_IDS.SPIKE_REJECTION, enabled: true, params: { sensitivity: 0.5 } },
    { id: FILTER_IDS.TAP_STABILIZATION, enabled: true, params: { radius_mm: 0.4, duration_ms: 12, strength: 0.6 } },
  ];
}

/** The "Smooth" preset: more stabilization for people who prefer steadier
 * cursor movement over raw directness. Uses the One Euro filter (not stacked
 * with velocity-based smoothing, same anti-compounding-latency reasoning as
 * `stableFilters`) with a lower beta than Stable, which - per the published
 * algorithm's own math - means more residual lag at speed in exchange for
 * more smoothing at rest. */
export function smoothFilters(): FilterConfig[] {
  return [
    { id: FILTER_IDS.SMOOTHING, enabled: false, params: { strength: 0.3 } },
    { id: FILTER_IDS.NOISE_REDUCTION, enabled: true, params: { samples: 4 } },
    { id: FILTER_IDS.ANTI_CHATTER, enabled: true, params: { interval_ms: 15 } },
    { id: FILTER_IDS.VELOCITY_SMOOTHING, enabled: false, params: { slow_strength: 0.5, fast_strength: 0.0, sensitivity: 0.5 } },
    { id: FILTER_IDS.MICRO_JITTER, enabled: true, params: { deadzone_mm: 0.12 } },
    { id: FILTER_IDS.LIFT_OFF_DEBOUNCE, enabled: true, params: { debounce_ms: 6 } },
    { id: FILTER_IDS.ONE_EURO, enabled: true, params: { min_cutoff: 0.5, beta: 0.3, d_cutoff: 1.0 } },
    { id: FILTER_IDS.SPIKE_REJECTION, enabled: true, params: { sensitivity: 0.5 } },
    { id: FILTER_IDS.TAP_STABILIZATION, enabled: true, params: { radius_mm: 0.6, duration_ms: 20, strength: 0.7 } },
  ];
}

export const listProfiles = (): Promise<Profile[]> => invoke<Profile[]>("list_profiles");

/** Returns the active profile, creating one first if none exists yet - see
 * the Rust command's own doc comment. Used by onboarding, which needs a
 * profile to apply a usage/filter preset to even on a completely fresh
 * install, before the driver has ever started. */
export const ensureActiveProfile = (): Promise<Profile> => invoke<Profile>("ensure_active_profile");

export const getProfile = (id: string): Promise<Profile> => invoke<Profile>("get_profile", { id });

/** Creates (if `profile.id` is new) or updates (if it already exists) a profile. */
export const saveProfile = (profile: Profile): Promise<Profile> => invoke<Profile>("save_profile", { profile });

export const duplicateProfile = (id: string, newName: string): Promise<Profile> =>
  invoke<Profile>("duplicate_profile", { id, newName });

export const deleteProfile = (id: string): Promise<void> => invoke<void>("delete_profile", { id });

export const getActiveProfileId = (): Promise<string | null> => invoke<string | null>("get_active_profile_id");

export const setActiveProfile = (id: string | null): Promise<void> => invoke<void>("set_active_profile", { id });

export const exportProfile = (id: string, path: string): Promise<void> => invoke<void>("export_profile", { id, path });

export const importProfile = (path: string): Promise<Profile> => invoke<Profile>("import_profile", { path });

/** A fresh, valid v4-shaped id for a brand-new profile the frontend is
 * about to create - matches what the Rust side expects to see. */
export function newProfileId(): string {
  return crypto.randomUUID();
}

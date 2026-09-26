/**
 * The osu! Optimizer's recommendation engine: compares the active profile's
 * current filter configuration (and a couple of non-filter settings) against
 * a chosen preference, and produces a list of concrete, explainable
 * suggestions - never a fabricated "best setup" claim. Every recommendation
 * names a real setting this program can actually change, shows the current
 * and suggested value, and states the tradeoff honestly.
 */

import { FILTER_IDS, type Area, type FilterConfig, type Profile } from "@/types";
import { FILTER_META, type FilterMeta } from "@/lib/filterMeta";
import { aspectRatioValue, effectiveSize, matchAspectRatio, ratiosMatch } from "@/lib/aspectRatio";
import { PRESETS, type PresetKind } from "@/lib/presets";

export type Preference = PresetKind | "custom";

export const PREFERENCE_DEFS: { value: Preference; label: string; description: string }[] = [
  ...PRESETS.map((p) => ({ value: p.kind as Preference, label: p.label, description: p.description })),
  { value: "custom", label: "Custom", description: "Full manual control - the Optimizer won't suggest filter changes." },
];

export interface Recommendation {
  id: string;
  setting: string;
  current: string;
  suggested: string;
  reason: string;
  tradeoff: string;
  apply: (profile: Profile) => Profile;
}

function getFilter(filters: FilterConfig[], id: string): FilterConfig {
  return filters.find((f) => f.id === id) ?? { id, enabled: false, params: {} };
}

function describeFilter(meta: FilterMeta, cfg: FilterConfig): string {
  if (!cfg.enabled) return "Off";
  const parts = meta.params.map((p) => `${p.label} ${p.format(cfg.params[p.key] ?? 0)}`);
  return `On (${parts.join(", ")})`;
}

function filtersEqual(a: FilterConfig, b: FilterConfig): boolean {
  if (a.enabled !== b.enabled) return false;
  if (!a.enabled) return true; // both off - a disabled filter's leftover params don't do anything
  const keys = new Set([...Object.keys(a.params), ...Object.keys(b.params)]);
  return [...keys].every((k) => Math.abs((a.params[k] ?? 0) - (b.params[k] ?? 0)) < 1e-9);
}

/** Per-filter reason/tradeoff text, branching on whether the change makes
 * this filter do *more* or *less* - written by hand per filter rather than
 * derived generically, since "more" doesn't mean the same thing for every
 * parameter (see the One Euro filter's special case below, where a higher
 * min cutoff/beta means *less* smoothing, the opposite of every other filter
 * here) and a wrong automatic guess would be worse than no reason at all. */
function reasonFor(id: string, current: FilterConfig, target: FilterConfig): { reason: string; tradeoff: string } {
  const turningOn = !current.enabled && target.enabled;
  const turningOff = current.enabled && !target.enabled;

  switch (id) {
    case FILTER_IDS.SMOOTHING: {
      const more = turningOn || (target.enabled && (target.params.strength ?? 0) > (current.params.strength ?? 0));
      return more
        ? { reason: "Reduces jitter by trailing slightly behind raw input.", tradeoff: "Adds a small amount of lag proportional to strength." }
        : { reason: "Improves responsiveness by relying less on this smoothing stage.", tradeoff: "May expose more of the tablet's own raw jitter." };
    }
    case FILTER_IDS.NOISE_REDUCTION: {
      const more = turningOn || (target.enabled && (target.params.samples ?? 0) > (current.params.samples ?? 0));
      return more
        ? { reason: "Averages more samples, filtering out more sensor noise.", tradeoff: "Adds more lag the larger the averaging window gets." }
        : { reason: "Averages fewer samples, so output tracks raw input more closely.", tradeoff: "May let more raw sensor noise through." };
    }
    case FILTER_IDS.ANTI_CHATTER: {
      const more = turningOn || (target.enabled && (target.params.interval_ms ?? 0) > (current.params.interval_ms ?? 0));
      return more
        ? { reason: "Debounces rapid tip on/off chatter from a worn switch.", tradeoff: "Delays every real press/release by the debounce window." }
        : turningOff
          ? { reason: "Removes the debounce delay entirely.", tradeoff: "A worn switch's chatter would pass straight through as repeated clicks." }
          : { reason: "Shortens the debounce window.", tradeoff: "Slightly less protection against switch chatter." };
    }
    case FILTER_IDS.VELOCITY_SMOOTHING: {
      const more = turningOn || (target.enabled && (target.params.slow_strength ?? 0) > (current.params.slow_strength ?? 0));
      return more
        ? { reason: "Steadies fine aiming during slow, precise movement.", tradeoff: "Adds a small amount of lag specifically during slow movement." }
        : { reason: "Keeps slow movement as direct as fast movement.", tradeoff: "Slow, precise aiming may feel less steady." };
    }
    case FILTER_IDS.MICRO_JITTER: {
      const more = turningOn || (target.enabled && (target.params.deadzone_mm ?? 0) > (current.params.deadzone_mm ?? 0));
      return more
        ? { reason: "Ignores more small involuntary movement while the pen is nearly still.", tradeoff: "A larger deadzone can also absorb the smallest deliberate corrections." }
        : { reason: "Lets smaller movements through unfiltered.", tradeoff: "More of the tablet's own resting jitter may become visible." };
    }
    case FILTER_IDS.LIFT_OFF_DEBOUNCE: {
      const more = turningOn || (target.enabled && (target.params.debounce_ms ?? 0) > (current.params.debounce_ms ?? 0));
      return more
        ? { reason: "Tolerates longer accidental out-of-range blips without dropping a held click.", tradeoff: "Delays every real lift-off by the same amount." }
        : { reason: "Real lift-offs register faster.", tradeoff: "A brief flaky read could drop a held click." };
    }
    case FILTER_IDS.SPIKE_REJECTION:
      return turningOn
        ? { reason: "Rejects individual reports that jump farther than any real pen stroke could.", tradeoff: "Essentially none - it only blocks physically-impossible jumps, never a real fast flick." }
        : { reason: "No reports are rejected, even implausible ones.", tradeoff: "A single bad HID report could briefly move the cursor to the wrong place." };
    case FILTER_IDS.ONE_EURO:
      if (turningOn) {
        return { reason: "Adds adaptive smoothing that's heavier when the pen is nearly still and lighter as it speeds up.", tradeoff: "Introduces some latency, mostly noticeable at low speed." };
      }
      if (turningOff) {
        return { reason: "Removes this adaptive smoothing stage entirely.", tradeoff: "Faster response at rest, but more visible jitter when the pen is nearly still." };
      }
      return { reason: "Rebalances how aggressively this filter smooths at rest versus at speed.", tradeoff: "A different tradeoff point between stability and responsiveness, not a strictly better one." };
    case FILTER_IDS.TAP_STABILIZATION:
      return turningOn
        ? { reason: "Steadies the pen for a brief moment right as it touches down.", tradeoff: "Very slightly delays deliberate fast movement immediately after a tap." }
        : { reason: "No extra steadying right after touchdown.", tradeoff: "The physical act of tapping may nudge the coordinate slightly." };
    default:
      return { reason: "Matches the selected preference.", tradeoff: "Changes how this filter processes input." };
  }
}

/** One recommendation per filter whose current config differs from the
 * target preset's - never for filters that already match. */
export function filterRecommendations(profile: Profile, targetFilters: FilterConfig[]): Recommendation[] {
  const recs: Recommendation[] = [];
  for (const meta of FILTER_META) {
    const current = getFilter(profile.filters, meta.id);
    const target = getFilter(targetFilters, meta.id);
    if (filtersEqual(current, target)) continue;

    const { reason, tradeoff } = reasonFor(meta.id, current, target);
    recs.push({
      id: `filter:${meta.id}`,
      setting: meta.title,
      current: describeFilter(meta, current),
      suggested: describeFilter(meta, target),
      reason,
      tradeoff,
      apply: (p) => ({ ...p, filters: p.filters.some((f) => f.id === meta.id) ? p.filters.map((f) => (f.id === meta.id ? target : f)) : [...p.filters, target] }),
    });
  }
  return recs;
}

/** Non-filter recommendations: absolute mode and aspect-ratio matching -
 * the only two non-filter settings the Optimizer can safely suggest a
 * concrete, unambiguous fix for. It never guesses at which monitor is
 * "correct" (see `OptimizerPage`'s own doc comment for why). */
export function structuralRecommendations(profile: Profile, monitor: { width: number; height: number } | null, tabletBounds: { width: number; height: number } | null): Recommendation[] {
  const recs: Recommendation[] = [];

  if (profile.inputMode !== "absolute") {
    recs.push({
      id: "structural:absolute-mode",
      setting: "Input mode",
      current: "Relative",
      suggested: "Absolute",
      reason: "osu! reads the tablet as an absolute position, so every point on the tablet area maps to a fixed point on screen - relative mode is built for pointer-style movement instead.",
      tradeoff: "None for osu! specifically - relative mode has no advantage here unless you're using the tablet outside the game too.",
      apply: (p) => ({ ...p, inputMode: "absolute" }),
    });
  }

  if (monitor && tabletBounds) {
    const tabletEffective = effectiveSize(profile.tabletArea);
    const tabletRatio = aspectRatioValue(tabletEffective.width, tabletEffective.height);
    const monitorRatio = aspectRatioValue(monitor.width, monitor.height);
    if (!ratiosMatch(tabletRatio, monitorRatio)) {
      recs.push({
        id: "structural:aspect-ratio",
        setting: "Tablet area aspect ratio",
        current: `${tabletEffective.width.toFixed(1)} × ${tabletEffective.height.toFixed(1)} mm`,
        suggested: "Matched to the selected monitor's shape",
        reason: "A tablet area whose shape doesn't match the monitor's stretches movement unevenly between the two axes, throwing off aim precision.",
        tradeoff: "Changes the tablet area's width or height slightly - whichever moves less - without moving its center.",
        apply: (p) => ({ ...p, tabletArea: matchAspectRatio(p.tabletArea, monitorRatio, tabletBounds) }),
      });
    }
  }

  return recs;
}

export function buildRecommendations(
  profile: Profile,
  preference: Preference,
  monitor: { width: number; height: number } | null,
  tabletBounds: { width: number; height: number } | null,
): Recommendation[] {
  const structural = structuralRecommendations(profile, monitor, tabletBounds);
  if (preference === "custom") return structural;
  const preset = PRESETS.find((p) => p.kind === preference);
  if (!preset) return structural;
  return [...filterRecommendations(profile, preset.build()), ...structural];
}

/** Applies every given recommendation to a fresh copy of `profile`, in
 * order - later ones see earlier ones' changes (relevant for aspect-ratio
 * matching, which reads `tabletArea` after any filter changes, though those
 * are independent fields so order never actually matters in practice today). */
export function applyRecommendations(profile: Profile, recommendations: Recommendation[]): Profile {
  return recommendations.reduce((p, rec) => rec.apply(p), profile);
}

/** A plain snapshot of exactly what the Optimizer can change, for rollback -
 * see `lib/rollback.ts`. */
export interface OptimizableFields {
  tabletArea: Area;
  inputMode: Profile["inputMode"];
  filters: FilterConfig[];
}

export function snapshotOptimizableFields(profile: Profile): OptimizableFields {
  return { tabletArea: profile.tabletArea, inputMode: profile.inputMode, filters: profile.filters };
}

export function restoreOptimizableFields(profile: Profile, snapshot: OptimizableFields): Profile {
  return { ...profile, ...snapshot };
}

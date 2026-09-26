/**
 * Display metadata (title, description, slider ranges/formatting) for every
 * filter the driver actually implements - shared by the Filters page and the
 * osu! Optimizer so both describe and format the same filters identically.
 * Only filters that actually exist in `thomsen_tablet_core::filter` are
 * listed here - never invent UI for an unimplemented algorithm.
 */

import { FILTER_IDS } from "@/types";

export interface FilterParam {
  key: string;
  label: string;
  min: number;
  max: number;
  step: number;
  format: (v: number) => string;
}

export interface FilterMeta {
  id: string;
  title: string;
  description: string;
  params: FilterParam[];
}

export const pct = (v: number) => `${Math.round(v * 100)}%`;
export const ms = (v: number) => `${Math.round(v)} ms`;

export const FILTER_META: FilterMeta[] = [
  {
    id: FILTER_IDS.SMOOTHING,
    title: "Smoothing",
    description: "Exponential smoothing - each point moves partway from the last output toward the new raw point. Reduces jitter at the cost of a small amount of lag.",
    params: [{ key: "strength", label: "Strength", min: 0, max: 1, step: 0.05, format: pct }],
  },
  {
    id: FILTER_IDS.NOISE_REDUCTION,
    title: "Noise reduction",
    description: "Averages the last N raw points before mapping them. Larger windows remove more noise but add more lag.",
    params: [{ key: "samples", label: "Window size", min: 1, max: 10, step: 1, format: (v) => `${Math.round(v)} sample${Math.round(v) === 1 ? "" : "s"}` }],
  },
  {
    id: FILTER_IDS.ANTI_CHATTER,
    title: "Anti-chatter",
    description: "Debounces the pen tip: a press/release only registers once it's held for the interval below, filtering out rapid on/off chatter from a worn switch.",
    params: [{ key: "interval_ms", label: "Debounce window", min: 0, max: 50, step: 1, format: ms }],
  },
  {
    id: FILTER_IDS.VELOCITY_SMOOTHING,
    title: "Velocity-based smoothing",
    description:
      "Smooths more while the pen is moving slowly (steadier fine aiming) and less - down to none - once it's moving fast, so osu! jumps and flicks stay direct. Runs independently of the plain Smoothing filter above.",
    params: [
      { key: "slow_strength", label: "Slow movement smoothing", min: 0, max: 1, step: 0.01, format: pct },
      { key: "fast_strength", label: "Fast movement smoothing", min: 0, max: 1, step: 0.01, format: pct },
      { key: "sensitivity", label: "Transition sensitivity", min: 0, max: 1, step: 0.05, format: pct },
    ],
  },
  {
    id: FILTER_IDS.MICRO_JITTER,
    title: "Micro-jitter filter",
    description: "Ignores movement smaller than the deadzone while the pen is nearly still. Movement past the deadzone passes straight through, so normal aiming is unaffected.",
    params: [{ key: "deadzone_mm", label: "Deadzone", min: 0, max: 0.5, step: 0.01, format: (v) => `${v.toFixed(2)} mm` }],
  },
  {
    id: FILTER_IDS.LIFT_OFF_DEBOUNCE,
    title: "Lift-off debounce",
    description:
      "Ignores extremely brief pen out-of-range blips while hovering, so a flaky read doesn't drop your cursor position or release a held click. Keep this low - it delays real lift-offs by the same amount.",
    params: [{ key: "debounce_ms", label: "Debounce time", min: 0, max: 30, step: 1, format: ms }],
  },
  {
    id: FILTER_IDS.SPIKE_REJECTION,
    title: "Spike rejection",
    description:
      "Rejects individual reports that jump farther or more abruptly than any real pen stroke could - a bad HID report, not a fast flick. Runs first in the pipeline, before anything with a window or history can let a bad sample leak into several outputs. Recovers on the very next good sample.",
    params: [{ key: "sensitivity", label: "Sensitivity", min: 0, max: 1, step: 0.05, format: pct }],
  },
  {
    id: FILTER_IDS.ONE_EURO,
    title: "One Euro Filter",
    description:
      "A published adaptive filter: heavier smoothing while the pen is nearly still, progressively less as it speeds up. Solves the same problem as Velocity-based smoothing above with a different, published algorithm - enabling both at once just adds latency without adding anything real.",
    params: [
      { key: "min_cutoff", label: "Min cutoff", min: 0.05, max: 2, step: 0.05, format: (v) => `${v.toFixed(2)} Hz` },
      { key: "beta", label: "Beta", min: 0, max: 2, step: 0.05, format: (v) => v.toFixed(2) },
      { key: "d_cutoff", label: "Derivative cutoff", min: 0.5, max: 2, step: 0.1, format: (v) => `${v.toFixed(1)} Hz` },
    ],
  },
  {
    id: FILTER_IDS.TAP_STABILIZATION,
    title: "Tap stabilization",
    description:
      "Steadies the pen for a brief moment right as it touches down - the physical act of tapping can itself nudge the coordinate slightly. Moving past the radius is treated as deliberate aim and passes straight through immediately, ending the window early.",
    params: [
      { key: "radius_mm", label: "Stabilization radius", min: 0.1, max: 2, step: 0.1, format: (v) => `${v.toFixed(1)} mm` },
      { key: "duration_ms", label: "Duration", min: 0, max: 60, step: 1, format: ms },
      { key: "strength", label: "Strength", min: 0, max: 1, step: 0.05, format: pct },
    ],
  },
];

export function filterTitle(id: string): string {
  return FILTER_META.find((m) => m.id === id)?.title ?? id;
}

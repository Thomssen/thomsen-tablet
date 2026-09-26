/**
 * The five named filter starting points shared by the Filters page, the
 * Dashboard's quick actions, and the osu! Optimizer - defined once so all
 * three always agree on what "Competitive" (etc.) actually means. Deliberately
 * not ranked "best to worst": different players prefer different settings,
 * so none of these is ever labeled "Best," "Pro," or "Ultimate" anywhere.
 */

import { balancedFilters, competitiveFilters, defaultFilters, smoothFilters, stableFilters } from "@/services/profiles";
import type { FilterConfig } from "@/types";

export type PresetKind = "raw" | "competitive" | "balanced" | "stable" | "smooth";

export interface PresetDef {
  kind: PresetKind;
  label: string;
  description: string;
  build: () => FilterConfig[];
}

export const PRESETS: PresetDef[] = [
  { kind: "raw", label: "Raw", description: "No unnecessary filtering at all - the lowest added delay.", build: defaultFilters },
  { kind: "competitive", label: "Competitive", description: "Minimal filtering with a focus on responsiveness.", build: competitiveFilters },
  { kind: "balanced", label: "Balanced", description: "Light filtering with some jitter reduction.", build: balancedFilters },
  { kind: "stable", label: "Stable", description: "Stronger stabilization for noisier tablet input.", build: stableFilters },
  { kind: "smooth", label: "Smooth", description: "More smoothing, at some cost to responsiveness.", build: smoothFilters },
];

export function presetByKind(kind: PresetKind): PresetDef | undefined {
  return PRESETS.find((p) => p.kind === kind);
}

/** Deep-compares a profile's filters against a named preset's exact shape,
 * so a page can honestly report which preset (if any) is currently active
 * rather than always saying "Custom." */
export function filtersMatchPreset(filters: FilterConfig[], preset: FilterConfig[]): boolean {
  if (filters.length !== preset.length) return false;
  const byId = new Map(filters.map((f) => [f.id, f]));
  return preset.every((want) => {
    const have = byId.get(want.id);
    if (!have || have.enabled !== want.enabled) return false;
    if (!want.enabled) return true; // both off - a disabled filter's leftover params don't do anything
    const keys = new Set([...Object.keys(have.params), ...Object.keys(want.params)]);
    return [...keys].every((k) => Math.abs((have.params[k] ?? 0) - (want.params[k] ?? 0)) < 1e-9);
  });
}

export function activePresetLabel(filters: FilterConfig[] | undefined): string {
  if (!filters) return "—";
  for (const preset of PRESETS) {
    if (filtersMatchPreset(filters, preset.build())) return preset.label;
  }
  return "Custom";
}

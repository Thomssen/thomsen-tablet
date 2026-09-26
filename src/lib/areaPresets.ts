/**
 * User-created tablet area presets - a handful of named width/height/x/y/
 * rotation bundles the user saves for themselves, e.g. "My osu! area."
 * Distinct from the built-in Full Area/Center Area/quick-width buttons,
 * which are fixed. Stored in this device's local storage (this is a
 * personal shortcut list, not a shareable file - see Profiles' Export for
 * actually sending a setup to someone else) - never sent anywhere.
 */

import type { Area } from "@/types";

const STORAGE_KEY = "thomsen-tablet-area-presets";

export interface AreaPreset {
  name: string;
  area: Area;
}

function readAll(): AreaPreset[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function writeAll(presets: AreaPreset[]): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(presets));
  } catch {
    // Private browsing / storage disabled - presets just won't persist.
  }
}

export function listAreaPresets(): AreaPreset[] {
  return readAll();
}

/** Saves under `name`, replacing any existing preset with the same name. */
export function saveAreaPreset(name: string, area: Area): AreaPreset[] {
  const trimmed = name.trim();
  const next = readAll().filter((p) => p.name !== trimmed);
  next.push({ name: trimmed, area });
  writeAll(next);
  return next;
}

export function deleteAreaPreset(name: string): AreaPreset[] {
  const next = readAll().filter((p) => p.name !== name);
  writeAll(next);
  return next;
}

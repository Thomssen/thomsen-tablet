/**
 * A single-slot "undo my last optimization" snapshot, stored locally on this
 * device (never sent anywhere). Overwritten each time the Optimizer applies
 * a new change, and cleared once the user undoes it - by design there is
 * only ever one snapshot at a time, matching "survives until another
 * optimization is applied or the user clears it," not a full history.
 */

import type { OptimizableFields } from "@/lib/optimizer";

const STORAGE_KEY = "thomsen-tablet-optimizer-rollback";

export interface RollbackSnapshot {
  profileId: string;
  profileName: string;
  savedAt: number;
  fields: OptimizableFields;
}

export function saveRollbackSnapshot(snapshot: RollbackSnapshot): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(snapshot));
  } catch {
    // Private browsing / storage disabled - Undo just won't be available.
  }
}

export function getRollbackSnapshot(): RollbackSnapshot | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || !parsed.profileId || !parsed.fields) return null;
    return parsed as RollbackSnapshot;
  } catch {
    return null;
  }
}

export function clearRollbackSnapshot(): void {
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch {
    // Nothing to do - if it couldn't be read, it can't have been acted on either.
  }
}

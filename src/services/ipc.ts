/**
 * Thin, typed bridge to the Rust backend.
 *
 * Every backend call goes through `invoke()`. When the UI runs outside Tauri
 * (`npm run dev` in a plain browser, for design work) calls are served by
 * `mockBackend`, so the app still renders without the native shell.
 */

import { invoke as tauriInvoke } from "@tauri-apps/api/core";
import { mockBackend } from "./mock";

export function isTauri(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

export async function invoke<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  if (!isTauri()) {
    return mockBackend<T>(command, args);
  }
  return tauriInvoke<T>(command, args);
}

/** Normalize a thrown backend error into a string message. */
export function errorMessage(e: unknown): string {
  if (typeof e === "string") return e;
  if (e && typeof e === "object" && "message" in e) {
    return String((e as { message: unknown }).message);
  }
  return String(e);
}

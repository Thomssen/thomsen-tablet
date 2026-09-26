/**
 * Native file dialogs and "open in OS" helpers. Thin wrappers over the Tauri
 * dialog / opener plugins that degrade to no-ops outside Tauri.
 */

import { isTauri } from "./ipc";

export interface SaveOptions {
  title?: string;
  defaultPath?: string;
  filters?: { name: string; extensions: string[] }[];
}
export interface OpenOptions extends SaveOptions {
  directory?: boolean;
}

export async function saveDialog(opts: SaveOptions): Promise<string | null> {
  if (!isTauri()) return null;
  const { save } = await import("@tauri-apps/plugin-dialog");
  const path = await save(opts);
  return path ?? null;
}

export async function openDialog(opts: OpenOptions): Promise<string | null> {
  if (!isTauri()) return null;
  const { open } = await import("@tauri-apps/plugin-dialog");
  const picked = await open({ ...opts, multiple: false });
  return typeof picked === "string" ? picked : null;
}

export async function revealPath(path: string): Promise<void> {
  if (!isTauri()) return;
  const { revealItemInDir } = await import("@tauri-apps/plugin-opener");
  await revealItemInDir(path);
}

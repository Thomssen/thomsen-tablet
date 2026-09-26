/**
 * Custom frameless window controls. Wraps `@tauri-apps/api/window`; every call
 * is a safe no-op outside Tauri so the title bar still renders in a browser.
 */

import { isTauri } from "./ipc";

type MaybeWindow = {
  minimize: () => Promise<void>;
  toggleMaximize: () => Promise<void>;
  close: () => Promise<void>;
  isMaximized: () => Promise<boolean>;
  onResized: (cb: () => void) => Promise<() => void>;
};

let cached: MaybeWindow | null = null;

async function appWindow(): Promise<MaybeWindow | null> {
  if (!isTauri()) return null;
  if (cached) return cached;
  const { getCurrentWindow } = await import("@tauri-apps/api/window");
  cached = getCurrentWindow() as unknown as MaybeWindow;
  return cached;
}

export async function minimizeWindow(): Promise<void> {
  (await appWindow())?.minimize();
}
export async function toggleMaximizeWindow(): Promise<void> {
  (await appWindow())?.toggleMaximize();
}
export async function closeWindow(): Promise<void> {
  (await appWindow())?.close();
}
export async function isWindowMaximized(): Promise<boolean> {
  return (await appWindow())?.isMaximized() ?? false;
}
export async function onMaximizeChange(cb: (maximized: boolean) => void): Promise<() => void> {
  const win = await appWindow();
  if (!win) return () => {};
  return win.onResized(async () => cb(await win.isMaximized()));
}

export interface MonitorInfo {
  name: string;
  width: number;
  height: number;
  x: number;
  y: number;
  scaleFactor: number;
}

/** Windows reports monitors by their raw device name (e.g. `\\.\DISPLAY1`),
 * which is meaningless to a user - shown as "Display 1" everywhere instead.
 * Falls back to the raw name for anything that doesn't match that shape,
 * rather than guessing. */
function friendlyMonitorName(raw: string | null | undefined, index: number): string {
  const match = raw?.match(/DISPLAY(\d+)/i);
  if (match) return `Display ${match[1]}`;
  return raw ?? `Monitor ${index + 1}`;
}

/** Plausible multi-monitor layout for the browser-only preview (`npm run
 * dev`), so monitor-dependent UI (mapping, aspect ratio) has something real
 * to render without Tauri - never shown as if it were live hardware. */
const MOCK_MONITORS: MonitorInfo[] = [
  { name: "Monitor 1 (16:9)", width: 1920, height: 1080, x: 0, y: 0, scaleFactor: 1 },
  { name: "Monitor 2 (4:3)", width: 1280, height: 960, x: 1920, y: 120, scaleFactor: 1 },
  { name: "Monitor 3 (16:10)", width: 1920, height: 1200, x: -1920, y: -120, scaleFactor: 1 },
  { name: "Monitor 4 (21:9)", width: 2520, height: 1080, x: 0, y: -1200, scaleFactor: 1 },
  { name: "Monitor 5 (portrait 9:16)", width: 1080, height: 1920, x: 3200, y: -420, scaleFactor: 1 },
];

/** Every connected monitor, in real virtual-desktop pixel coordinates. A
 * fixed mock layout outside Tauri (a plain browser has no concept of "the
 * OS's monitors") so preview mode can still exercise monitor-dependent UI. */
export async function getAvailableMonitors(): Promise<MonitorInfo[]> {
  if (!isTauri()) return MOCK_MONITORS;
  const { availableMonitors } = await import("@tauri-apps/api/window");
  const monitors = await availableMonitors();
  return monitors.map((m, i) => ({
    name: friendlyMonitorName(m.name, i),
    width: m.size.width,
    height: m.size.height,
    x: m.position.x,
    y: m.position.y,
    scaleFactor: m.scaleFactor,
  }));
}

export async function getPrimaryMonitor(): Promise<MonitorInfo | null> {
  if (!isTauri()) return MOCK_MONITORS[0] ?? null;
  const { primaryMonitor } = await import("@tauri-apps/api/window");
  const m = await primaryMonitor();
  if (!m) return null;
  return { name: friendlyMonitorName(m.name, 0), width: m.size.width, height: m.size.height, x: m.position.x, y: m.position.y, scaleFactor: m.scaleFactor };
}

/**
 * A tiny in-memory stand-in for the Tauri backend, used only when the UI runs
 * outside Tauri (`npm run dev` in a plain browser) so the app still renders
 * for fast design iteration without a compiled backend.
 */

import type { AppSettings, DiagnosticsSnapshot, DriverStatus, FilterConfig, OsuStatus, Point, Profile, ScannedTablet, TestSessionStatus } from "@/types";
import { FILTER_IDS } from "@/types";

const DEFAULT_SETTINGS: AppSettings = {
  theme: "dark",
  startWithWindows: false,
  minimizeToTray: false,
  startMinimized: false,
  checkForUpdates: true,
  windowStyle: "macos",
  displayName: null,
  usagePreset: "custom",
  onboardingCompleted: false,
  osuStablePath: null,
  osuLazerPath: null,
  autoSwitchOsuProfile: true,
  restoreProfileAfterOsuClose: true,
  preferredOsuVariant: null,
  sessionModeEnabled: true,
};

/** A browser preview has no real OS processes or filesystem to check -
 * honestly reporting "not found, not running" for both variants rather than
 * inventing a fake detected install, same spirit as `get_computer_name`
 * returning `null` here. */
const MOCK_OSU_STATUS: OsuStatus = {
  stable: { path: null, pathExists: false, configured: false, running: false },
  lazer: { path: null, pathExists: false, configured: false, running: false },
};

let settings: AppSettings = { ...DEFAULT_SETTINGS };

/** Shaped after the real, connected Wacom CTL-472, for browser-only preview. */
const MOCK_TABLET: ScannedTablet = {
  name: "Wacom CTL-472",
  vendorId: 0x056a,
  productId: 0x037a,
  widthMm: 152,
  heightMm: 95,
  maxX: 15200,
  maxY: 9500,
  maxPressure: 2047,
  buttonCount: 2,
};
const MOCK_SCAN: ScannedTablet[] = [MOCK_TABLET];

let driverStatus: DriverStatus = {
  running: false,
  connected: false,
  tabletName: "",
  activeProfileId: "",
  activeProfileName: "",
  lastSample: null,
  samplesReceived: 0,
  reportsPerSecond: 0,
  lastError: null,
  activeFilterChain: [],
  spikesRejected: 0,
};

let filterBypass = false;
let mockMaxPressureSeen = 0;
let mockSessionStart = Date.now();

/** A clearly-synthetic, smooth Lissajous-style path for Input Lab's browser
 * preview only - the real app never simulates tablet input (see
 * `driver::process_sample` for the genuine pipeline). "Raw" adds a small
 * high-frequency wobble; "filtered" is the same path sampled slightly
 * earlier, which reads visually as a lagged/smoothed line behind it -
 * exactly like a real low-pass filter, without pretending to run one. */
function mockPoint(tMs: number, widthMm: number, heightMm: number): Point {
  const cx = widthMm / 2;
  const cy = heightMm / 2;
  const rx = widthMm * 0.32;
  const ry = heightMm * 0.32;
  return { x: cx + rx * Math.cos(tMs / 900), y: cy + ry * Math.sin(tMs / 630) };
}
function mockWobble(p: Point, tMs: number): Point {
  return { x: p.x + Math.sin(tMs / 47) * 0.3, y: p.y + Math.cos(tMs / 53) * 0.3 };
}

/** Kept in sync by hand with `thomsen_tablet_core::profile::default_filters()`
 * and `services/profiles.ts`'s `defaultFilters()` - this mock has no backend
 * of its own to be the source of truth, so all three must agree. */
function defaultFilters(): FilterConfig[] {
  return [
    { id: FILTER_IDS.SMOOTHING, enabled: false, params: { strength: 0.3 } },
    { id: FILTER_IDS.NOISE_REDUCTION, enabled: false, params: { samples: 4 } },
    { id: FILTER_IDS.ANTI_CHATTER, enabled: false, params: { interval_ms: 15 } },
    { id: FILTER_IDS.VELOCITY_SMOOTHING, enabled: false, params: { slow_strength: 0.5, fast_strength: 0.0, sensitivity: 0.5 } },
    { id: FILTER_IDS.MICRO_JITTER, enabled: false, params: { deadzone_mm: 0.1 } },
    { id: FILTER_IDS.LIFT_OFF_DEBOUNCE, enabled: false, params: { debounce_ms: 4 } },
    { id: FILTER_IDS.ONE_EURO, enabled: false, params: { min_cutoff: 0.8, beta: 0.6, d_cutoff: 1.0 } },
    { id: FILTER_IDS.SPIKE_REJECTION, enabled: false, params: { sensitivity: 0.5 } },
    { id: FILTER_IDS.TAP_STABILIZATION, enabled: false, params: { radius_mm: 0.5, duration_ms: 15, strength: 0.7 } },
  ];
}

/** Mirrors the real pipeline order from `thomsen_tablet_core::filter::build_chain`
 * plus `ActiveConfig::active_filter_chain` - so the mock's Diagnostics view
 * is a meaningful simulation of "what would actually be running," not just
 * an empty placeholder. */
const PIPELINE_ORDER = [
  FILTER_IDS.SPIKE_REJECTION,
  FILTER_IDS.MICRO_JITTER,
  FILTER_IDS.NOISE_REDUCTION,
  FILTER_IDS.VELOCITY_SMOOTHING,
  FILTER_IDS.ONE_EURO,
  FILTER_IDS.SMOOTHING,
  FILTER_IDS.ANTI_CHATTER,
  FILTER_IDS.LIFT_OFF_DEBOUNCE,
  FILTER_IDS.TAP_STABILIZATION,
];

function activeFilterChainFor(profile: Profile): string[] {
  const enabled = new Set(profile.filters.filter((f) => f.enabled).map((f) => f.id));
  return PIPELINE_ORDER.filter((id) => enabled.has(id));
}

const defaultProfile: Profile = {
  id: "mock-default-profile",
  name: "Default",
  tabletArea: { width: 152, height: 95, x: 76, y: 47.5, rotation: 0 },
  displayArea: { width: 1920, height: 1080, x: 960, y: 540, rotation: 0 },
  lockAspectRatio: false,
  inputMode: "absolute",
  relativeSettings: { xSensitivity: 10, ySensitivity: 10 },
  filters: defaultFilters(),
  appBindings: [],
  pressureActivationThreshold: 0,
  osuVariantAssignment: null,
};

let profiles: Profile[] = [defaultProfile];
let activeProfileId: string | null = defaultProfile.id;

export async function mockBackend<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  switch (command) {
    case "app_info":
      return {
        name: "Thomsen Tablet",
        version: "0.1.0",
        dataDir: "(browser preview - no backend)",
        loadWarnings: [],
      } as T;

    case "get_computer_name":
      // A browser has no real Windows machine name to report - null here
      // exercises the same "Your PC" fallback path the real app falls back
      // to if COMPUTERNAME is ever unset, rather than inventing one.
      return null as unknown as T;

    case "get_settings":
      return settings as unknown as T;

    case "save_settings":
      settings = args?.settings as AppSettings;
      return settings as unknown as T;

    case "reset_settings":
      settings = { ...DEFAULT_SETTINGS };
      return settings as unknown as T;

    case "scan_tablets":
      return MOCK_SCAN as unknown as T;

    case "get_driver_status":
      return driverStatus as unknown as T;

    case "start_driver":
    case "restart_driver": {
      const active = profiles.find((p) => p.id === activeProfileId) ?? defaultProfile;
      driverStatus = {
        running: true,
        connected: true,
        tabletName: MOCK_TABLET.name,
        activeProfileId: active.id,
        activeProfileName: active.name,
        lastSample: { x: 7600, y: 4750, pressure: 0, inRange: false, tipPressed: false, barrelButton: false, eraserButton: false, hoverDistance: 10 },
        samplesReceived: 0,
        reportsPerSecond: 0,
        lastError: null,
        activeFilterChain: activeFilterChainFor(active),
        spikesRejected: 0,
      };
      return driverStatus as unknown as T;
    }

    case "stop_driver":
      driverStatus = {
        running: false,
        connected: false,
        tabletName: "",
        activeProfileId: "",
        activeProfileName: "",
        lastSample: null,
        samplesReceived: 0,
        reportsPerSecond: 0,
        lastError: null,
        activeFilterChain: [],
        spikesRejected: 0,
      };
      return driverStatus as unknown as T;

    case "apply_active_profile": {
      const active = profiles.find((p) => p.id === activeProfileId);
      if (driverStatus.running && active) {
        driverStatus = { ...driverStatus, activeFilterChain: activeFilterChainFor(active) };
      }
      return driverStatus as unknown as T;
    }

    case "get_test_session_status": {
      if (!driverStatus.running) return null as unknown as T;
      const t = Date.now() - mockSessionStart;
      const raw = mockWobble(mockPoint(t, MOCK_TABLET.widthMm, MOCK_TABLET.heightMm), t);
      const filtered = filterBypass ? raw : mockPoint(t - 90, MOCK_TABLET.widthMm, MOCK_TABLET.heightMm);
      const pressure = Math.max(0, Math.round((Math.sin(t / 800) * 0.5 + 0.5) * MOCK_TABLET.maxPressure));
      mockMaxPressureSeen = Math.max(mockMaxPressureSeen, pressure);
      const status: TestSessionStatus = {
        rawPoint: raw,
        filteredPoint: filtered,
        pressure,
        tipPressed: pressure > MOCK_TABLET.maxPressure * 0.1,
        inRange: true,
        filterBypass,
        rateCurrent: 131,
        rateAverage: 130,
        rateMin: 126,
        rateMax: 134,
        sampleCount: Math.round(t / 7.6),
        timingGaps: 0,
        maxPressureSeen: mockMaxPressureSeen,
      };
      return status as unknown as T;
    }

    case "set_filter_bypass":
      filterBypass = Boolean(args?.enabled);
      return undefined as unknown as T;

    case "reset_test_session":
      mockMaxPressureSeen = 0;
      mockSessionStart = Date.now();
      return undefined as unknown as T;

    case "list_profiles":
      return profiles as unknown as T;

    case "ensure_active_profile": {
      let active = profiles.find((p) => p.id === activeProfileId);
      if (!active) {
        active = profiles[0];
        if (active) activeProfileId = active.id;
      }
      if (!active) {
        active = { ...defaultProfile, id: crypto.randomUUID() };
        profiles.push(active);
        activeProfileId = active.id;
      }
      return active as unknown as T;
    }

    case "get_profile": {
      const p = profiles.find((x) => x.id === args?.id);
      if (!p) throw new Error(`No profile with id "${String(args?.id)}"`);
      return p as unknown as T;
    }

    case "save_profile": {
      const incoming = args?.profile as Profile;
      // Mirrors the real backend's "at most one profile per osu! variant"
      // invariant (see `commands::profiles::save_profile`).
      if (incoming.osuVariantAssignment) {
        profiles = profiles.map((p) =>
          p.id !== incoming.id && p.osuVariantAssignment === incoming.osuVariantAssignment ? { ...p, osuVariantAssignment: null } : p,
        );
      }
      const idx = profiles.findIndex((p) => p.id === incoming.id);
      if (idx >= 0) profiles[idx] = incoming;
      else profiles.push(incoming);
      return incoming as unknown as T;
    }

    case "duplicate_profile": {
      const original = profiles.find((p) => p.id === args?.id);
      if (!original) throw new Error("Profile not found");
      const dup: Profile = { ...original, id: crypto.randomUUID(), name: String(args?.newName), appBindings: [], osuVariantAssignment: null };
      profiles.push(dup);
      return dup as unknown as T;
    }

    case "delete_profile":
      profiles = profiles.filter((p) => p.id !== args?.id);
      if (activeProfileId === args?.id) activeProfileId = null;
      return undefined as unknown as T;

    case "get_active_profile_id":
      return activeProfileId as unknown as T;

    case "set_active_profile":
      activeProfileId = (args?.id as string | null) ?? null;
      return undefined as unknown as T;

    case "export_profile":
    case "import_profile":
      throw new Error("File import/export needs the native app - try npm run start.");

    case "get_diagnostics":
      return {
        appVersion: "0.1.0",
        os: "windows",
        arch: "x86_64",
        devices: [
          { name: MOCK_TABLET.name, vendorId: "0x056a", productId: "0x037a", hidPath: "(browser preview)", interfaceNumber: 0 },
        ],
        driverRunning: driverStatus.running,
        driverConnected: driverStatus.connected,
        activeProfileName: (profiles.find((p) => p.id === activeProfileId) ?? null)?.name ?? null,
        activeFilterChain: driverStatus.activeFilterChain,
        spikesRejected: driverStatus.spikesRejected,
        lastDriverError: driverStatus.lastError,
        logsDir: "(browser preview - no backend)",
        configDir: "(browser preview - no backend)",
      } as DiagnosticsSnapshot as unknown as T;

    case "generate_diagnostic_report":
      return "Thomsen Tablet diagnostic report\n(browser preview - no backend)\n" as unknown as T;

    case "get_recent_logs":
      return "(browser preview - no backend, run npm run start to see real logs)" as unknown as T;

    case "get_osu_status":
      return MOCK_OSU_STATUS as unknown as T;

    case "launch_osu":
      throw new Error("Launching osu! needs the native app - try npm run start.");

    default:
      throw new Error(`No mock for "${command}" - running outside Tauri.`);
  }
}

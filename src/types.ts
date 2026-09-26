export type ThemeSetting = "dark" | "light" | "system";
export type WindowStyle = "macos" | "windows";
export type UsagePreset = "osu" | "drawing" | "general" | "custom";
export type OsuVariant = "stable" | "lazer";

export interface AppSettings {
  theme: ThemeSetting;
  startWithWindows: boolean;
  minimizeToTray: boolean;
  startMinimized: boolean;
  checkForUpdates: boolean;
  windowStyle: WindowStyle;
  /** What the Dashboard greeting calls the user - `null` means no name set. */
  displayName: string | null;
  usagePreset: UsagePreset;
  onboardingCompleted: boolean;
  /** User-configured override for osu! (stable)'s executable path - `null`
   * means "use auto-detection at the standard install location." */
  osuStablePath: string | null;
  osuLazerPath: string | null;
  /** Whether the background app-switcher may activate the profile assigned
   * to a running osu! variant (see `Profile.osuVariantAssignment`). */
  autoSwitchOsuProfile: boolean;
  /** Whether the app-switcher restores the previously-active profile once
   * osu! is no longer running. */
  restoreProfileAfterOsuClose: boolean;
  /** Which installation "Open osu!" should launch when both are found -
   * `null` means no preference recorded yet. */
  preferredOsuVariant: OsuVariant | null;
  /** Whether the Dashboard treats a currently-running osu! as an active
   * "Session" - a visible framing over the same auto-switch behavior
   * `autoSwitchOsuProfile` already provides, not a second mechanism. */
  sessionModeEnabled: boolean;
}

export interface OsuInstallStatus {
  /** The executable path Thomsen Tablet would launch - a user override if
   * set, else the standard install location. `null` if neither is known. */
  path: string | null;
  /** Whether `path` actually exists on disk right now. */
  pathExists: boolean;
  /** Whether `path` came from a user override rather than auto-detection. */
  configured: boolean;
  /** Whether this variant is running right now, detected independently of `path`. */
  running: boolean;
}

export interface OsuStatus {
  stable: OsuInstallStatus;
  lazer: OsuInstallStatus;
}

export interface AppInfo {
  name: string;
  version: string;
  dataDir: string;
  loadWarnings: string[];
}

export interface ScannedTablet {
  name: string;
  vendorId: number;
  productId: number;
  widthMm: number;
  heightMm: number;
  /** Raw device-unit range for X/Y - what RawSample.x/.y are measured in. */
  maxX: number;
  maxY: number;
  maxPressure: number;
  buttonCount: number;
}

/** One parsed HID pen report. Device units, not yet mapped to screen space. */
export interface RawSample {
  x: number;
  y: number;
  pressure: number;
  inRange: boolean;
  tipPressed: boolean;
  barrelButton: boolean;
  eraserButton: boolean;
  hoverDistance: number;
}

export interface DriverStatus {
  running: boolean;
  /** True once the HID device is actually open - false while `running` but
   * disconnected and retrying (see the Rust driver's reconnect loop). */
  connected: boolean;
  tabletName: string;
  activeProfileId: string;
  activeProfileName: string;
  lastSample: RawSample | null;
  samplesReceived: number;
  reportsPerSecond: number;
  lastError: string | null;
  /** Every processing stage currently active, in pipeline order - empty while stopped. */
  activeFilterChain: string[];
  /** Lifetime count of samples spike-rejection has dropped this session. */
  spikesRejected: number;
}

/** A point in some coordinate space - tablet-surface millimeters, here. */
export interface Point {
  x: number;
  y: number;
}

/** Input Lab's live telemetry - polled separately from, and faster than,
 * {@link DriverStatus} so only the one page that needs this detail pays for it. */
export interface TestSessionStatus {
  /** Current sample's position in tablet-surface mm, before any filter runs. */
  rawPoint: Point | null;
  /** Same sample, after the full filter chain (equals `rawPoint` while `filterBypass` is on). */
  filteredPoint: Point | null;
  pressure: number;
  tipPressed: boolean;
  inRange: boolean;
  /** Whether the temporary "Bypass Filters" override is currently active. */
  filterBypass: boolean;
  rateCurrent: number;
  rateAverage: number;
  rateMin: number;
  rateMax: number;
  sampleCount: number;
  /** A heuristic estimate of likely-dropped reports, inferred from timing
   * gaps - the CTL-472 protocol has no sequence number to confirm this
   * exactly. Always present it as an estimate, never a precise count. */
  timingGaps: number;
  maxPressureSeen: number;
}

// -- Profiles ----------------------------------------------------------

export type InputMode = "absolute" | "relative";

export interface RelativeSettings {
  xSensitivity: number;
  ySensitivity: number;
}

export const FILTER_IDS = {
  SMOOTHING: "smoothing",
  NOISE_REDUCTION: "noise_reduction",
  ANTI_CHATTER: "anti_chatter",
  VELOCITY_SMOOTHING: "velocity_smoothing",
  MICRO_JITTER: "micro_jitter",
  LIFT_OFF_DEBOUNCE: "lift_off_debounce",
  ONE_EURO: "one_euro",
  SPIKE_REJECTION: "spike_rejection",
  TAP_STABILIZATION: "tap_stabilization",
} as const;

export interface FilterConfig {
  id: string;
  enabled: boolean;
  params: Record<string, number>;
}

/** Center-based rectangle: (x, y) is the CENTER, matching how the driver's
 * coordinate math and most tablet software already model an active area. */
export interface Area {
  width: number;
  height: number;
  x: number;
  y: number;
  rotation: number;
}

export interface Profile {
  id: string;
  name: string;
  tabletArea: Area;
  displayArea: Area;
  lockAspectRatio: boolean;
  inputMode: InputMode;
  relativeSettings: RelativeSettings;
  filters: FilterConfig[];
  /** Executable file names (e.g. "osu!.exe") that auto-activate this profile. */
  appBindings: string[];
  /** Minimum pressure (0..1 fraction of max pressure) required before a
   * pen-down registers as a tip click. 0 disables the gate. */
  pressureActivationThreshold: number;
  /** Which osu! variant (if either) the app-switcher activates this profile
   * for. At most one profile should be assigned to a given variant. */
  osuVariantAssignment: OsuVariant | null;
}

// -- Diagnostics ---------------------------------------------------------

export interface DetectedDevice {
  name: string;
  vendorId: string;
  productId: string;
  hidPath: string;
  interfaceNumber: number;
}

export interface DiagnosticsSnapshot {
  appVersion: string;
  os: string;
  arch: string;
  devices: DetectedDevice[];
  driverRunning: boolean;
  driverConnected: boolean;
  activeProfileName: string | null;
  activeFilterChain: string[];
  spikesRejected: number;
  lastDriverError: string | null;
  logsDir: string;
  configDir: string;
}

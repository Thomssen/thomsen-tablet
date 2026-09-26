/**
 * Sidebar navigation. Text only - no icons - to keep the rail quiet, matching
 * Thomsen OSINT.
 *
 * Add a page: add a `Route`, an entry in a group here, and a case in
 * <RouteView> (src/app/RouteView.tsx).
 */

export type Route =
  | "dashboard"
  | "optimizer"
  | "tablet-area"
  | "filters"
  | "calibration"
  | "profiles"
  | "diagnostics"
  | "settings";

export interface NavItem {
  route: Route;
  label: string;
}

/** Primary nav, in groups. Settings is pinned separately at the rail's foot.
 * No separate "Driver" destination - its Start/Stop/Rescan controls and
 * tablet status live on the Dashboard now, so the whole app stays focused on
 * the osu! setup/testing loop rather than a general driver-utility feel.
 * The Optimizer isn't listed here (reachable from the Dashboard's "Open
 * Optimizer" quick action instead) - see `ROUTE_LABELS` for why a route
 * doesn't need to be in the nav to need a label. */
export const NAV_GROUPS: readonly (readonly NavItem[])[] = [
  [{ route: "dashboard", label: "Dashboard" }],
  [
    { route: "tablet-area", label: "Tablet Area" },
    { route: "filters", label: "Filters" },
    { route: "calibration", label: "Input Lab" },
    { route: "profiles", label: "Profiles" },
  ],
  [{ route: "diagnostics", label: "Performance" }],
] as const;

export const SETTINGS_ITEM: NavItem = { route: "settings", label: "Settings" };

export const ROUTE_ORDER: readonly Route[] = [
  ...NAV_GROUPS.flat().map((i) => i.route),
  "settings",
];

/** Every route's title-bar label, independent of `NAV_GROUPS` - a route that
 * isn't in the sidebar (the Optimizer) still needs a real label when it's
 * open, rather than showing up blank in the title bar. Written as a plain
 * object (not derived from `NAV_GROUPS`) so TypeScript itself catches a
 * route ever left without one. */
export const ROUTE_LABELS: Record<Route, string> = {
  dashboard: "Dashboard",
  optimizer: "osu! Optimizer",
  "tablet-area": "Tablet Area",
  filters: "Filters",
  calibration: "Input Lab",
  profiles: "Profiles",
  diagnostics: "Performance",
  settings: "Settings",
};

export const DEFAULT_ROUTE: Route = "dashboard";

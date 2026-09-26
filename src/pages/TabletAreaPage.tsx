import { useCallback, useEffect, useMemo, useState } from "react";
import { Page, Section } from "@/components/layout/Page";
import { Card } from "@/components/ui/Card";
import { Button } from "@/components/ui/Button";
import { Field, TextInput } from "@/components/ui/Field";
import { Dropdown } from "@/components/ui/Dropdown";
import { Toggle } from "@/components/ui/Toggle";
import { SegmentedControl } from "@/components/ui/SegmentedControl";
import { EmptyState } from "@/components/ui/EmptyState";
import { Modal } from "@/components/ui/Modal";
import { useToast } from "@/components/ui/Toast";
import { useNavigation } from "@/state/NavigationProvider";
import { AreaEditor } from "@/components/AreaEditor/AreaEditor";
import { MonitorLayout } from "@/components/MonitorLayout/MonitorLayout";
import { AspectRatioCheck } from "@/components/AspectRatioCheck/AspectRatioCheck";
import { aspectRatioValue, effectiveSize, fitWithinBounds, ratiosMatch, simplifyRatio } from "@/lib/aspectRatio";
import { listAreaPresets, saveAreaPreset, deleteAreaPreset, type AreaPreset } from "@/lib/areaPresets";
import { copyText } from "@/lib/format";
import { errorMessage } from "@/services/ipc";
import { getActiveProfileId, getProfile, saveProfile } from "@/services/profiles";
import { applyActiveProfile, getDriverStatus, scanTablets } from "@/services/driver";
import { getAvailableMonitors, type MonitorInfo } from "@/services/window";
import type { Area, InputMode, Profile } from "@/types";
import "./TabletAreaPage.css";

const round = (n: number, places = 2) => Number(n.toFixed(places));

/** Named, convenient starting widths - not a claim that any is "correct."
 * "Full Area" isn't listed here since it reuses the page's own `fullArea()`
 * action directly rather than a fixed mm value. */
const AREA_SIZES: { label: string; mm: number }[] = [
  { label: "Small", mm: 50 },
  { label: "Medium", mm: 65 },
  { label: "Large", mm: 80 },
];
/** How close (as a fraction) a width has to be to a named size or to the
 * full tablet width to be labeled that instead of "Custom" - matches the
 * same tolerance already used for aspect-ratio comparisons elsewhere. */
const AREA_SIZE_TOLERANCE = 0.02;

/** A human label for the tablet area's current width - one of the named
 * sizes above, "Full Area" if it matches the tablet's own width, or
 * "Custom" for anything else. Purely descriptive, derived from the real
 * current value - never a separate stored choice that could drift from it. */
function areaSizeLabel(widthMm: number, tabletBounds: { width: number } | null): string {
  if (tabletBounds && Math.abs(widthMm - tabletBounds.width) / tabletBounds.width <= AREA_SIZE_TOLERANCE) return "Full Area";
  for (const size of AREA_SIZES) {
    if (Math.abs(widthMm - size.mm) / size.mm <= AREA_SIZE_TOLERANCE) return size.label;
  }
  return "Custom";
}

/** A tablet area is only ever something to import manually, never parsed
 * automatically from another driver's config file - see the page-level
 * ImportAreaModal doc comment for why. This just validates that pasted/typed
 * numbers are sane enough to become a real Area (positive size, finite
 * values), the same bar `updateTabletArea` callers already assume. */
function isValidAreaShape(v: unknown): v is Area {
  if (!v || typeof v !== "object") return false;
  const a = v as Record<string, unknown>;
  return (
    typeof a.width === "number" && a.width > 0 &&
    typeof a.height === "number" && a.height > 0 &&
    typeof a.x === "number" && Number.isFinite(a.x) &&
    typeof a.y === "number" && Number.isFinite(a.y) &&
    typeof a.rotation === "number" && Number.isFinite(a.rotation)
  );
}

/** Which monitor a saved `displayArea` was mapped to, matched by size - so
 * the dropdown can be resynced after loading or reverting a profile. Falls
 * back to the first monitor (or -1 if none) rather than guessing. */
function findMonitorIndex(monitors: MonitorInfo[], displayArea: Pick<Area, "width" | "height">): number {
  const matchIndex = monitors.findIndex((m) => Math.abs(m.width - displayArea.width) < 1 && Math.abs(m.height - displayArea.height) < 1);
  return matchIndex >= 0 ? matchIndex : 0;
}

function AreaFields({
  area,
  onChange,
  unit,
  disabled,
  lockAspectRatio,
  aspectRatio,
  bounds,
}: {
  area: Area;
  onChange: (a: Area) => void;
  unit: string;
  disabled?: boolean;
  /** When on, editing width/height keeps a fixed ratio by adjusting the other dimension too. */
  lockAspectRatio?: boolean;
  /** The ratio to lock to (e.g. the selected monitor's width/height). Falls
   * back to the area's own current ratio if not given (e.g. no monitor
   * detected yet), so the lock still does *something* sensible. */
  aspectRatio?: number;
  /** Physical surface to stay within - clamps (preserving the ratio) if the
   * locked computation would otherwise overflow it. */
  bounds?: { width: number; height: number };
}) {
  const field = (key: keyof Area, label: string, fieldUnit: string, step: number) => (
    <Field label={`${label} (${fieldUnit})`}>
      <TextInput
        type="number"
        step={step}
        value={round(area[key])}
        disabled={disabled}
        onChange={(e) => {
          const v = Number(e.target.value);
          if (!Number.isFinite(v)) return;
          const isSize = key === "width" || key === "height";
          if (isSize && v <= 0) return; // a zero/negative area breaks aspect-ratio math and rendering

          if (lockAspectRatio && isSize) {
            const ratio = aspectRatio && aspectRatio > 0 ? aspectRatio : area.width > 0 && area.height > 0 ? area.width / area.height : null;
            if (ratio) {
              let width = key === "width" ? v : v * ratio;
              let height = key === "width" ? v / ratio : v;
              let { x, y } = area;
              if (bounds) ({ width, height, x, y } = fitWithinBounds(width, height, x, y, bounds));
              onChange({ ...area, width, height, x, y });
              return;
            }
          }
          onChange({ ...area, [key]: v });
        }}
      />
    </Field>
  );
  return (
    <div className="tablet-area__fields">
      {field("width", "Width", unit, 0.1)}
      {field("height", "Height", unit, 0.1)}
      {field("x", "X", unit, 0.1)}
      {field("y", "Y", unit, 0.1)}
      {field("rotation", "Rotation", "deg", 1)}
    </div>
  );
}

export function TabletAreaPage() {
  const { navigate } = useNavigation();
  const toast = useToast();

  const [profile, setProfile] = useState<Profile | null>(null);
  const [draft, setDraft] = useState<Profile | null>(null);
  const [tabletBounds, setTabletBounds] = useState<{ width: number; height: number } | null>(null);
  const [tabletBoundsAssumed, setTabletBoundsAssumed] = useState(false);
  const [monitors, setMonitors] = useState<MonitorInfo[]>([]);
  const [selectedMonitor, setSelectedMonitor] = useState(0);
  const [busy, setBusy] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [customPresets, setCustomPresets] = useState<AreaPreset[]>(() => listAreaPresets());
  const [saveNameDraft, setSaveNameDraft] = useState("");
  const [savePresetOpen, setSavePresetOpen] = useState(false);
  const [importOpen, setImportOpen] = useState(false);

  const load = useCallback(async () => {
    try {
      const activeId = await getActiveProfileId();
      if (!activeId) {
        setProfile(null);
        return;
      }
      const p = await getProfile(activeId);
      setProfile(p);
      setDraft(p);

      const tablets = await scanTablets().catch(() => []);
      if (tablets[0]) {
        setTabletBounds({ width: tablets[0].widthMm, height: tablets[0].heightMm });
        setTabletBoundsAssumed(false);
      } else {
        setTabletBounds({ width: Math.max(p.tabletArea.width, 100), height: Math.max(p.tabletArea.height, 60) });
        setTabletBoundsAssumed(true);
      }

      const mons = await getAvailableMonitors();
      setMonitors(mons);
      setSelectedMonitor(findMonitorIndex(mons, p.displayArea));
    } catch (e) {
      setLoadError(errorMessage(e));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const dirty = useMemo(() => profile !== null && draft !== null && JSON.stringify(profile) !== JSON.stringify(draft), [profile, draft]);

  const monitorBounds = monitors[selectedMonitor] ?? { width: draft?.displayArea.width ?? 1920, height: draft?.displayArea.height ?? 1080 };
  const selectedMonitorInfo = monitors[selectedMonitor];
  const monitorRatio = selectedMonitorInfo ? aspectRatioValue(selectedMonitorInfo.width, selectedMonitorInfo.height) : 0;

  const updateTabletArea = (area: Area) => draft && setDraft({ ...draft, tabletArea: area });
  const updateDisplayArea = (area: Area) => draft && setDraft({ ...draft, displayArea: area });

  const setLockAspect = (locked: boolean) => draft && setDraft({ ...draft, lockAspectRatio: locked });
  const setInputMode = (mode: InputMode) => draft && setDraft({ ...draft, inputMode: mode });

  const fullArea = () => {
    if (!draft || !tabletBounds) return;
    if (draft.lockAspectRatio && monitorRatio > 0) {
      // The largest rectangle matching the locked ratio that still fits
      // within the physical surface, centered - "full" within the
      // constraint, not a literal edge-to-edge stretch that would break it.
      let width = tabletBounds.width;
      let height = width / monitorRatio;
      if (height > tabletBounds.height) {
        height = tabletBounds.height;
        width = height * monitorRatio;
      }
      updateTabletArea({ width, height, x: tabletBounds.width / 2, y: tabletBounds.height / 2, rotation: draft.tabletArea.rotation });
      return;
    }
    updateTabletArea({ width: tabletBounds.width, height: tabletBounds.height, x: tabletBounds.width / 2, y: tabletBounds.height / 2, rotation: draft.tabletArea.rotation });
  };
  const centerArea = () => {
    if (!draft || !tabletBounds) return;
    updateTabletArea({ ...draft.tabletArea, x: tabletBounds.width / 2, y: tabletBounds.height / 2 });
  };
  const resetDraft = () => {
    if (!profile) return;
    setDraft(profile);
    // The monitor dropdown is separate UI state (an index, not the area
    // itself) - without this, reverting a draft that had switched monitors
    // would leave the dropdown pointing at a monitor that no longer matches
    // the just-restored displayArea.
    setSelectedMonitor(findMonitorIndex(monitors, profile.displayArea));
  };

  const selectMonitor = (index: number) => {
    setSelectedMonitor(index);
    const m = monitors[index];
    if (m && draft) {
      updateDisplayArea({ width: m.width, height: m.height, x: m.x + m.width / 2, y: m.y + m.height / 2, rotation: draft.displayArea.rotation });
    }
  };

  /** Sets the tablet area's width to an exact value - a convenient starting
   * point, not a claim that any of these widths is "best." Mirrors exactly
   * what typing that value into the Width field above would do: when aspect
   * ratio is locked, height follows the same ratio; either way the result is
   * clamped to the physical surface. */
  const setQuickWidth = (mm: number) => {
    if (!draft || !tabletBounds) return;
    const ratio = draft.lockAspectRatio ? (monitorRatio > 0 ? monitorRatio : draft.tabletArea.height > 0 ? draft.tabletArea.width / draft.tabletArea.height : null) : null;
    let width = mm;
    let height = ratio ? mm / ratio : draft.tabletArea.height;
    let { x, y } = draft.tabletArea;
    ({ width, height, x, y } = fitWithinBounds(width, height, x, y, tabletBounds));
    updateTabletArea({ ...draft.tabletArea, width, height, x, y });
  };

  const copyArea = () =>
    void copyText(JSON.stringify(draft?.tabletArea)).then((ok) => toast[ok ? "success" : "error"](ok ? "Tablet area copied" : "Couldn't access the clipboard"));

  const pasteArea = () =>
    (async () => {
      let text: string;
      try {
        text = await navigator.clipboard.readText();
      } catch {
        toast.error("Couldn't access the clipboard");
        return;
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(text);
      } catch {
        toast.error("Clipboard doesn't contain a tablet area");
        return;
      }
      if (!isValidAreaShape(parsed) || !draft || !tabletBounds) {
        toast.error("Clipboard doesn't contain a valid tablet area");
        return;
      }
      const clamped = fitWithinBounds(parsed.width, parsed.height, parsed.x, parsed.y, tabletBounds);
      updateTabletArea({ ...clamped, rotation: parsed.rotation });
      toast.success("Tablet area pasted - review it, then Apply");
    })();

  const applyCustomPreset = (preset: AreaPreset) => {
    if (!draft || !tabletBounds) return;
    const clamped = fitWithinBounds(preset.area.width, preset.area.height, preset.area.x, preset.area.y, tabletBounds);
    updateTabletArea({ ...clamped, rotation: preset.area.rotation });
  };

  const doSavePreset = () => {
    const name = saveNameDraft.trim();
    if (!name || !draft) return;
    setCustomPresets(saveAreaPreset(name, draft.tabletArea));
    setSaveNameDraft("");
    setSavePresetOpen(false);
    toast.success(`Saved "${name}"`);
  };

  const doDeletePreset = (name: string) => setCustomPresets(deleteAreaPreset(name));

  const importArea = (area: Area) => {
    if (!tabletBounds) return;
    const clamped = fitWithinBounds(area.width, area.height, area.x, area.y, tabletBounds);
    updateTabletArea({ ...clamped, rotation: area.rotation });
    setImportOpen(false);
    toast.success("Imported - review it, then Apply");
  };

  const apply = () =>
    (async () => {
      if (!draft) return;
      setBusy(true);
      try {
        const saved = await saveProfile(draft);
        setProfile(saved);
        setDraft(saved);
        const status = await getDriverStatus();
        if (status.running && status.activeProfileId === saved.id) {
          await applyActiveProfile();
        }
        toast.success("Applied");
      } catch (e) {
        toast.error(errorMessage(e));
      } finally {
        setBusy(false);
      }
    })();

  return (
    <Page
      title="Tablet Area"
      eyebrow="Mapping"
      description={draft ? `Editing "${draft.name}"` : undefined}
      actions={
        draft && (
          <>
            <Button size="sm" variant="ghost" onClick={resetDraft} disabled={!dirty || busy}>
              Reset
            </Button>
            <Button size="sm" variant="primary" onClick={apply} loading={busy} disabled={!dirty}>
              Apply
            </Button>
          </>
        )
      }
    >
      {loadError ? (
        <Card>
          <EmptyState title="Couldn't load the active profile" description={loadError} />
        </Card>
      ) : !draft ? (
        <Card>
          <EmptyState
            title="No active profile yet"
            description="The area editor works on a profile. Create or activate one on the Profiles page first."
            action={
              <Button size="sm" variant="secondary" onClick={() => navigate("profiles")}>
                Go to Profiles
              </Button>
            }
          />
        </Card>
      ) : (
        <div className="stack">
          <Section title="Input mode">
            <Card>
              <Field label="Mode">
                <SegmentedControl
                  aria-label="Input mode"
                  options={[
                    { value: "absolute", label: "Absolute" },
                    { value: "relative", label: "Relative" },
                  ]}
                  value={draft.inputMode}
                  onChange={setInputMode}
                />
              </Field>
              {draft.inputMode === "relative" && (
                <div className="tablet-area__fields" style={{ marginTop: 14 }}>
                  <Field label="Horizontal sensitivity">
                    <TextInput
                      type="number"
                      step={0.5}
                      value={draft.relativeSettings.xSensitivity}
                      onChange={(e) => setDraft({ ...draft, relativeSettings: { ...draft.relativeSettings, xSensitivity: Number(e.target.value) } })}
                    />
                  </Field>
                  <Field label="Vertical sensitivity">
                    <TextInput
                      type="number"
                      step={0.5}
                      value={draft.relativeSettings.ySensitivity}
                      onChange={(e) => setDraft({ ...draft, relativeSettings: { ...draft.relativeSettings, ySensitivity: Number(e.target.value) } })}
                    />
                  </Field>
                </div>
              )}
            </Card>
          </Section>

          <Section title="Tablet surface" description={tabletBoundsAssumed ? "No tablet detected right now - showing an assumed surface size based on the saved area. Connect your tablet for accurate proportions." : undefined}>
            <Card>
              <div className="tablet-area__layout">
                {tabletBounds && (
                  <AreaEditor
                    bounds={tabletBounds}
                    value={draft.tabletArea}
                    onChange={updateTabletArea}
                    lockAspectRatio={draft.lockAspectRatio}
                    aspectRatio={monitorRatio || undefined}
                    minSize={2}
                  />
                )}
                <div className="tablet-area__side">
                  <AreaFields
                    area={draft.tabletArea}
                    onChange={updateTabletArea}
                    unit="mm"
                    lockAspectRatio={draft.lockAspectRatio}
                    aspectRatio={monitorRatio}
                    bounds={tabletBounds ?? undefined}
                  />
                  <div className="tablet-area__row">
                    <Field label="Lock aspect ratio" hint={monitorRatio > 0 ? "Keeps this area's shape matching your selected monitor's." : "Select a monitor below to lock to its shape."}>
                      <Toggle checked={draft.lockAspectRatio} onChange={setLockAspect} label="Lock aspect ratio" />
                    </Field>
                    <div className="tablet-area__quick-actions">
                      <Button size="sm" variant="secondary" onClick={fullArea} disabled={!tabletBounds || tabletBoundsAssumed}>
                        Full Area
                      </Button>
                      <Button size="sm" variant="secondary" onClick={centerArea} disabled={!tabletBounds || tabletBoundsAssumed}>
                        Center Area
                      </Button>
                    </div>
                  </div>
                  <div className="tablet-area__row">
                    <span className="tablet-area__quick-label">Area size - convenient starting values, not a recommendation:</span>
                    <div className="tablet-area__quick-actions">
                      {AREA_SIZES.map((size) => (
                        <Button key={size.label} size="sm" variant="ghost" onClick={() => setQuickWidth(size.mm)} disabled={!tabletBounds || tabletBoundsAssumed}>
                          {size.label} ({size.mm} mm)
                        </Button>
                      ))}
                      <Button size="sm" variant="ghost" onClick={fullArea} disabled={!tabletBounds || tabletBoundsAssumed}>
                        Full Area
                      </Button>
                    </div>
                  </div>
                </div>
              </div>
            </Card>
          </Section>

          <Section title="Area info" description="A quick summary for osu! - not a claim that there's one universally correct area.">
            <Card>
              <div className="tablet-area__info-grid">
                <div className="tablet-area__info-stat">
                  <span className="tablet-area__info-label">Area size</span>
                  <span className="tablet-area__info-value">{areaSizeLabel(draft.tabletArea.width, tabletBoundsAssumed ? null : tabletBounds)}</span>
                </div>
                <div className="tablet-area__info-stat">
                  <span className="tablet-area__info-label">Area aspect ratio</span>
                  <span className="tablet-area__info-value mono">{simplifyRatio(effectiveSize(draft.tabletArea).width, effectiveSize(draft.tabletArea).height)}</span>
                </div>
                <div className="tablet-area__info-stat">
                  <span className="tablet-area__info-label">Monitor aspect ratio</span>
                  <span className="tablet-area__info-value mono">{selectedMonitorInfo ? simplifyRatio(selectedMonitorInfo.width, selectedMonitorInfo.height) : "—"}</span>
                </div>
                <div className="tablet-area__info-stat">
                  <span className="tablet-area__info-label">Aspect ratio match</span>
                  <span className="tablet-area__info-value">
                    {selectedMonitorInfo
                      ? ratiosMatch(aspectRatioValue(effectiveSize(draft.tabletArea).width, effectiveSize(draft.tabletArea).height), monitorRatio)
                        ? "Matched"
                        : "Not matched"
                      : "—"}
                  </span>
                </div>
                <div className="tablet-area__info-stat">
                  <span className="tablet-area__info-label">Horizontal tablet usage</span>
                  <span className="tablet-area__info-value mono">{tabletBounds && !tabletBoundsAssumed ? `${((draft.tabletArea.width / tabletBounds.width) * 100).toFixed(0)}%` : "—"}</span>
                </div>
                <div className="tablet-area__info-stat">
                  <span className="tablet-area__info-label">Vertical tablet usage</span>
                  <span className="tablet-area__info-value mono">{tabletBounds && !tabletBoundsAssumed ? `${((draft.tabletArea.height / tabletBounds.height) * 100).toFixed(0)}%` : "—"}</span>
                </div>
              </div>
            </Card>
          </Section>

          <Section title="Area presets" description="Your own saved starting points, plus copy/paste and manual import from another driver's numbers.">
            <Card>
              <div className="tablet-area__quick-actions">
                <Button size="sm" variant="secondary" onClick={() => setSavePresetOpen(true)} disabled={!draft}>
                  Save Area Preset
                </Button>
                <Button size="sm" variant="secondary" onClick={copyArea} disabled={!draft}>
                  Copy Area
                </Button>
                <Button size="sm" variant="secondary" onClick={() => void pasteArea()} disabled={!draft || !tabletBounds}>
                  Paste Area
                </Button>
                <Button size="sm" variant="secondary" onClick={() => setImportOpen(true)} disabled={!draft || !tabletBounds}>
                  Import Area…
                </Button>
              </div>
              {customPresets.length > 0 && (
                <>
                  <div className="rule tablet-area__rule" />
                  <div className="tablet-area__presets">
                    {customPresets.map((preset) => (
                      <span className="tablet-area__chip" key={preset.name}>
                        <button type="button" className="tablet-area__preset-apply" onClick={() => applyCustomPreset(preset)}>
                          {preset.name}
                        </button>
                        <button type="button" onClick={() => doDeletePreset(preset.name)} aria-label={`Delete ${preset.name}`}>
                          ×
                        </button>
                      </span>
                    ))}
                  </div>
                </>
              )}
            </Card>
          </Section>

          <Section title="Monitor mapping" description="Where the tablet area above maps to on screen.">
            <Card>
              <div className="tablet-area__layout">
                <AreaEditor bounds={monitorBounds} value={draft.displayArea} onChange={updateDisplayArea} minSize={16} />
                <div className="tablet-area__side">
                  <Field label="Monitor">
                    <Dropdown
                      aria-label="Monitor"
                      value={selectedMonitor}
                      onChange={selectMonitor}
                      options={monitors.map((m, i) => ({ value: i, label: `${m.name} - ${m.width}×${m.height}` }))}
                    />
                  </Field>
                  <MonitorLayout monitors={monitors} selectedIndex={selectedMonitor} onSelect={selectMonitor} renderWidth={220} />
                  <AreaFields area={draft.displayArea} onChange={updateDisplayArea} unit="px" />
                </div>
              </div>
            </Card>
          </Section>

          <Section>
            <AspectRatioCheck
              tabletArea={draft.tabletArea}
              tabletBounds={tabletBounds}
              monitor={monitors[selectedMonitor] ?? null}
              onMatch={updateTabletArea}
            />
          </Section>
        </div>
      )}

      <Modal
        open={savePresetOpen}
        onClose={() => setSavePresetOpen(false)}
        title="Save area preset"
        description="Saves the tablet area's current width/height/position/rotation under a name you choose, for quick reuse later."
        footer={
          <>
            <Button variant="ghost" onClick={() => setSavePresetOpen(false)}>
              Cancel
            </Button>
            <Button variant="primary" disabled={!saveNameDraft.trim()} onClick={doSavePreset}>
              Save
            </Button>
          </>
        }
      >
        <Field label="Name">
          <TextInput autoFocus value={saveNameDraft} onChange={(e) => setSaveNameDraft(e.target.value)} onKeyDown={(e) => e.key === "Enter" && doSavePreset()} placeholder="My osu! area" />
        </Field>
      </Modal>

      {draft && tabletBounds && <ImportAreaModal open={importOpen} onClose={() => setImportOpen(false)} onImport={importArea} currentArea={draft.tabletArea} />}
    </Page>
  );
}

type ImportSource = "otd" | "corners";

/**
 * Manual entry only - deliberately not a file parser for another driver's
 * config. OpenTabletDriver's own area is already center-based mm, same as
 * Thomsen's `Area`, so its fields map straight across; a driver that
 * expresses area as tablet-native corners (Wacom's desktop center software
 * is the common example) is covered by the Corners tab instead, which
 * computes the equivalent center/size. Parsing an actual OTD/Wacom config
 * file was considered and deferred - getting a real third-party format
 * wrong would silently produce an unsafe area, where asking the user to
 * type the same numbers their old driver already shows them cannot.
 */
function ImportAreaModal({ open, onClose, onImport, currentArea }: { open: boolean; onClose: () => void; onImport: (area: Area) => void; currentArea: Area }) {
  const [source, setSource] = useState<ImportSource>("otd");
  const [width, setWidth] = useState(String(round(currentArea.width)));
  const [height, setHeight] = useState(String(round(currentArea.height)));
  const [x, setX] = useState(String(round(currentArea.x)));
  const [y, setY] = useState(String(round(currentArea.y)));
  const [rotation, setRotation] = useState(String(round(currentArea.rotation)));
  const [left, setLeft] = useState("0");
  const [top, setTop] = useState("0");
  const [right, setRight] = useState(String(round(currentArea.width)));
  const [bottom, setBottom] = useState(String(round(currentArea.height)));

  // The fields above only need to start from the *current* area at the
  // moment the modal actually opens - without this, they'd stay frozen at
  // whatever the area was on this component's first mount (this instance
  // stays mounted across opens/closes, same as every other Modal in the
  // app), showing stale numbers on the second and later opens.
  useEffect(() => {
    if (!open) return;
    setWidth(String(round(currentArea.width)));
    setHeight(String(round(currentArea.height)));
    setX(String(round(currentArea.x)));
    setY(String(round(currentArea.y)));
    setRotation(String(round(currentArea.rotation)));
    setLeft("0");
    setTop("0");
    setRight(String(round(currentArea.width)));
    setBottom(String(round(currentArea.height)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const otdArea: Area | null = (() => {
    const w = Number(width), h = Number(height), cx = Number(x), cy = Number(y), r = Number(rotation) || 0;
    if (!(w > 0) || !(h > 0) || !Number.isFinite(cx) || !Number.isFinite(cy)) return null;
    return { width: w, height: h, x: cx, y: cy, rotation: r };
  })();

  const cornersArea: Area | null = (() => {
    const l = Number(left), t = Number(top), r = Number(right), b = Number(bottom);
    if (![l, t, r, b].every(Number.isFinite) || r <= l || b <= t) return null;
    return { width: r - l, height: b - t, x: (l + r) / 2, y: (t + b) / 2, rotation: 0 };
  })();

  const preview = source === "otd" ? otdArea : cornersArea;

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Import area"
      description="Manual entry, not an automatic file import - type the numbers your previous driver already shows you and Thomsen converts them correctly."
      width={520}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" disabled={!preview} onClick={() => preview && onImport(preview)}>
            Import
          </Button>
        </>
      }
    >
      <Field label="Source">
        <SegmentedControl
          aria-label="Import source"
          options={[
            { value: "otd", label: "OpenTabletDriver" },
            { value: "corners", label: "Corners (e.g. Wacom)" },
          ]}
          value={source}
          onChange={setSource}
        />
      </Field>
      <div className="rule tablet-area__rule" />
      {source === "otd" ? (
        <>
          <p className="tablet-area__import-hint">OpenTabletDriver's Width/Height/Area X/Area Y are already center-based millimeters, same as Thomsen - enter them directly.</p>
          <div className="tablet-area__fields">
            <Field label="Width (mm)">
              <TextInput type="number" value={width} onChange={(e) => setWidth(e.target.value)} />
            </Field>
            <Field label="Height (mm)">
              <TextInput type="number" value={height} onChange={(e) => setHeight(e.target.value)} />
            </Field>
            <Field label="Area X (mm)">
              <TextInput type="number" value={x} onChange={(e) => setX(e.target.value)} />
            </Field>
            <Field label="Area Y (mm)">
              <TextInput type="number" value={y} onChange={(e) => setY(e.target.value)} />
            </Field>
            <Field label="Rotation (deg)">
              <TextInput type="number" value={rotation} onChange={(e) => setRotation(e.target.value)} />
            </Field>
          </div>
        </>
      ) : (
        <>
          <p className="tablet-area__import-hint">For a driver that shows the area as corners instead of center + size (e.g. Wacom's desktop center software) - millimeters from the tablet's top-left.</p>
          <div className="tablet-area__fields">
            <Field label="Left (mm)">
              <TextInput type="number" value={left} onChange={(e) => setLeft(e.target.value)} />
            </Field>
            <Field label="Top (mm)">
              <TextInput type="number" value={top} onChange={(e) => setTop(e.target.value)} />
            </Field>
            <Field label="Right (mm)">
              <TextInput type="number" value={right} onChange={(e) => setRight(e.target.value)} />
            </Field>
            <Field label="Bottom (mm)">
              <TextInput type="number" value={bottom} onChange={(e) => setBottom(e.target.value)} />
            </Field>
          </div>
        </>
      )}
      {preview && (
        <p className="tablet-area__import-preview mono">
          → {round(preview.width)}×{round(preview.height)} mm at ({round(preview.x)}, {round(preview.y)}){preview.rotation ? `, ${preview.rotation}°` : ""}
        </p>
      )}
    </Modal>
  );
}

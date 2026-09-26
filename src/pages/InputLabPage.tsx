import { useCallback, useEffect, useRef, useState } from "react";
import { Page, Section } from "@/components/layout/Page";
import { Card } from "@/components/ui/Card";
import { Field } from "@/components/ui/Field";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Toggle } from "@/components/ui/Toggle";
import { EmptyState } from "@/components/ui/EmptyState";
import { useToast } from "@/components/ui/Toast";
import { useNavigation } from "@/state/NavigationProvider";
import { errorMessage } from "@/services/ipc";
import { getActiveProfileId, getProfile, saveProfile } from "@/services/profiles";
import { applyActiveProfile, getDriverStatus, getTestSessionStatus, resetTestSession, scanTablets, setFilterBypass } from "@/services/driver";
import type { DriverStatus, Point, Profile, ScannedTablet, TestSessionStatus } from "@/types";
import "./InputLabPage.css";

/** ~50Hz - smooth for a visual trail/dot without trying to catch every one
 * of the tablet's real ~130Hz reports (this is a diagnostic visualizer, not
 * an instrument, and this poll only reads a few already-computed fields, so
 * it doesn't add meaningful load). The real cursor pipeline runs entirely on
 * its own Rust thread regardless of how fast this page polls or renders -
 * nothing here can add latency to it. */
const FAST_POLL_MS = 20;
/** Promote the fast poll's result into React state (for the numeric
 * readouts) only every Nth tick, so text that a human can't perceive
 * changing faster than a few times a second doesn't force extra re-renders. */
const DISPLAY_EVERY_N_TICKS = 5;
const JITTER_TEST_MS = 2000;
const PRESSURE_HISTORY_LEN = 160;
const MAX_THRESHOLD = 0.9;
const CANVAS_W = 900;
/** Fraction of the tablet surface's width used as the target's hit radius -
 * generous enough to reach reliably, without needing hardware-specific tuning. */
const TARGET_HIT_RADIUS_FRACTION = 0.04;
/** Keeps generated targets away from the very edge of the surface, so the
 * hit circle itself never gets clipped or sits right against the boundary. */
const TARGET_MARGIN_FRACTION = 0.15;

const clamp01 = (v: number) => Math.max(0, Math.min(1, v));

function jitterMm(points: Point[]): number | null {
  if (points.length < 2) return null;
  const meanX = points.reduce((s, p) => s + p.x, 0) / points.length;
  const meanY = points.reduce((s, p) => s + p.y, 0) / points.length;
  const sumSq = points.reduce((s, p) => s + (p.x - meanX) ** 2 + (p.y - meanY) ** 2, 0);
  return Math.sqrt(sumSq / points.length);
}

function distanceMm(a: Point, b: Point): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

/** Total length of the path traced through `points`, in mm - a real geometric
 * measurement of however the pen actually moved, used to compare against the
 * straight-line distance between two targets (see `TargetRun`). */
function pathLengthMm(points: Point[]): number {
  let total = 0;
  for (let i = 1; i < points.length; i++) {
    const prev = points[i - 1];
    const cur = points[i];
    if (prev && cur) total += distanceMm(prev, cur);
  }
  return total;
}

function randomTargetMm(widthMm: number, heightMm: number): Point {
  const mx = widthMm * TARGET_MARGIN_FRACTION;
  const my = heightMm * TARGET_MARGIN_FRACTION;
  return { x: mx + Math.random() * Math.max(0, widthMm - 2 * mx), y: my + Math.random() * Math.max(0, heightMm - 2 * my) };
}

interface TargetRun {
  straightLineMm: number;
  rawPathMm: number;
  filteredPathMm: number;
}

/** A bundle of real, already-measured values captured at one moment, for the
 * "Before vs After Optimization" comparison - never a fabricated improvement.
 * `overshootPct` is `null` until at least one Movement Test leg has
 * completed since the page opened; there's no ambient/idle way to measure it. */
interface OptimizationSnapshot {
  capturedAt: number;
  jitterRawMm: number | null;
  jitterFilteredMm: number | null;
  reportStabilityPct: number | null;
  droppedReports: number | null;
  overshootPct: number | null;
}

/** One metric's row in the Before/After table. `better` says which
 * direction is an improvement for *this* metric (lower jitter/dropped
 * reports/overshoot, higher report stability) so the after-value can be
 * honestly marked as an improvement or a regression - never hidden either
 * way, per "if the new configuration performs worse, show that honestly." */
function CompareRow({ label, before, afterValue, unit, decimals, better }: { label: string; before: number | null; afterValue: number | null; unit: string; decimals: number; better: "lower" | "higher" }) {
  const format = (v: number | null) => (v === null ? "—" : `${v.toFixed(decimals)}${unit}`);
  let tone: "good" | "warn" | "neutral" = "neutral";
  if (before !== null && afterValue !== null && before !== afterValue) {
    const improved = better === "lower" ? afterValue < before : afterValue > before;
    tone = improved ? "good" : "warn";
  }
  return (
    <div className="input-lab__compare-row">
      <span className="input-lab__compare-label">{label}</span>
      <span className="input-lab__compare-value mono">{format(before)}</span>
      <span className="input-lab__compare-value mono">
        {format(afterValue)}
        {tone !== "neutral" && <Badge tone={tone}>{tone === "good" ? "Improved" : "Regressed"}</Badge>}
      </span>
    </div>
  );
}

/** Canvas drawing needs literal color values, not CSS custom properties -
 * read the *current* resolved token so raw/filtered trails and the pressure
 * graph stay legible in both themes instead of being tuned for dark only. */
function cssVar(name: string, fallback: string): string {
  const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return v || fallback;
}

export function InputLabPage() {
  const { navigate } = useNavigation();
  const toast = useToast();

  const [profile, setProfile] = useState<Profile | null>(null);
  const [tablet, setTablet] = useState<ScannedTablet | null>(null);
  const [driverStatus, setDriverStatus] = useState<DriverStatus | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const [liveDisplay, setLiveDisplay] = useState<TestSessionStatus | null>(null);
  const [showRawTrail, setShowRawTrail] = useState(true);
  const [showFilteredTrail, setShowFilteredTrail] = useState(true);
  const [bypassPending, setBypassPending] = useState(false);

  const [jitterRunning, setJitterRunning] = useState(false);
  const [jitterResult, setJitterResult] = useState<{ raw: number; filtered: number; samples: number } | null>(null);

  const [targetTestActive, setTargetTestActive] = useState(false);
  const [targetsReached, setTargetsReached] = useState(0);
  const [lastRun, setLastRun] = useState<TargetRun | null>(null);

  const [baseline, setBaseline] = useState<OptimizationSnapshot | null>(null);
  const [after, setAfter] = useState<OptimizationSnapshot | null>(null);
  const [capturingSlot, setCapturingSlot] = useState<"baseline" | "after" | null>(null);
  const capturingSlotRef = useRef<"baseline" | "after" | null>(null);
  const lastRunRef = useRef<TargetRun | null>(null);
  lastRunRef.current = lastRun;

  const drawCanvasRef = useRef<HTMLCanvasElement>(null);
  const pressureCanvasRef = useRef<HTMLCanvasElement>(null);
  const targetCanvasRef = useRef<HTMLCanvasElement>(null);
  const lastDrawPointRef = useRef<{ raw: Point | null; filtered: Point | null }>({ raw: null, filtered: null });
  const pressureHistoryRef = useRef<number[]>([]);
  const jitterSamplesRef = useRef<{ raw: Point[]; filtered: Point[] }>({ raw: [], filtered: [] });
  const jitterDeadlineRef = useRef(0);
  const showRawTrailRef = useRef(showRawTrail);
  const showFilteredTrailRef = useRef(showFilteredTrail);
  showRawTrailRef.current = showRawTrail;
  showFilteredTrailRef.current = showFilteredTrail;
  const targetTestActiveRef = useRef(false);
  const targetRef = useRef<Point | null>(null);
  /** Where the *current* leg started from - the previous target's position,
   * or `null` for the very first leg, which has no prior target to measure a
   * straight-line baseline against (so it's counted in `targetsReached` but
   * doesn't produce a `TargetRun`). */
  const targetLegStartRef = useRef<Point | null>(null);
  const targetPathRef = useRef<{ raw: Point[]; filtered: Point[] }>({ raw: [], filtered: [] });
  const targetLastDrawRef = useRef<{ raw: Point | null; filtered: Point | null }>({ raw: null, filtered: null });

  const load = useCallback(async () => {
    try {
      const activeId = await getActiveProfileId();
      setProfile(activeId ? await getProfile(activeId) : null);
      const tablets = await scanTablets().catch(() => []);
      setTablet(tablets[0] ?? null);
    } catch (e) {
      setLoadError(errorMessage(e));
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    let cancelled = false;
    const poll = () => void getDriverStatus().then((s) => !cancelled && setDriverStatus(s));
    poll();
    const id = window.setInterval(poll, 250);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, []);

  const live = Boolean(driverStatus?.running && driverStatus.connected);

  const surfaceAssumed = !tablet;
  const surface = tablet
    ? { widthMm: tablet.widthMm, heightMm: tablet.heightMm, maxPressure: tablet.maxPressure }
    : { widthMm: Math.max(profile?.tabletArea.width ?? 152, 100), heightMm: Math.max(profile?.tabletArea.height ?? 95, 60), maxPressure: 0 };

  const areaOverlay = profile
    ? {
        leftPct: clamp01((profile.tabletArea.x - profile.tabletArea.width / 2) / surface.widthMm) * 100,
        topPct: clamp01((profile.tabletArea.y - profile.tabletArea.height / 2) / surface.heightMm) * 100,
        widthPct: clamp01(profile.tabletArea.width / surface.widthMm) * 100,
        heightPct: clamp01(profile.tabletArea.height / surface.heightMm) * 100,
      }
    : null;

  // Safety net: "Bypass Filters" is explicitly temporary testing behavior -
  // never leave the real pipeline silently unfiltered after leaving this page.
  useEffect(() => {
    return () => {
      void setFilterBypass(false).catch(() => {});
    };
  }, []);

  const redrawPressureGraph = useCallback(() => {
    const canvas = pressureCanvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    const { width, height } = canvas;
    ctx.clearRect(0, 0, width, height);
    const history = pressureHistoryRef.current;
    const max = surface.maxPressure || 1;
    if (history.length < 2) return;
    ctx.beginPath();
    history.forEach((p, i) => {
      const x = (i / (PRESSURE_HISTORY_LEN - 1)) * width;
      const y = height - clamp01(p / max) * height;
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    });
    const lineColor = cssVar("--text", "#f2f3f4");
    ctx.strokeStyle = lineColor;
    ctx.lineWidth = 1.5;
    ctx.lineJoin = "round";
    ctx.stroke();
    ctx.lineTo(width, height);
    ctx.lineTo((0 / (PRESSURE_HISTORY_LEN - 1)) * width, height);
    ctx.closePath();
    ctx.fillStyle = lineColor;
    ctx.globalAlpha = 0.08;
    ctx.fill();
    ctx.globalAlpha = 1;
  }, [surface.maxPressure]);

  const drawTrailSegment = useCallback(
    (kind: "raw" | "filtered", from: Point | null, to: Point) => {
      const canvas = drawCanvasRef.current;
      if (!canvas) return;
      const ctx = canvas.getContext("2d");
      if (!ctx) return;
      const scaleX = canvas.width / surface.widthMm;
      const scaleY = canvas.height / surface.heightMm;
      const toPx = (p: Point) => ({ x: p.x * scaleX, y: p.y * scaleY });
      const b = toPx(to);
      ctx.strokeStyle = kind === "raw" ? cssVar("--warn", "#d8b24c") : cssVar("--text", "#f2f3f4");
      ctx.fillStyle = ctx.strokeStyle;
      ctx.globalAlpha = kind === "raw" ? 0.85 : 0.95;
      ctx.lineWidth = kind === "raw" ? 1.4 : 2;
      ctx.lineCap = "round";
      if (from) {
        const a = toPx(from);
        ctx.beginPath();
        ctx.moveTo(a.x, a.y);
        ctx.lineTo(b.x, b.y);
        ctx.stroke();
      } else {
        ctx.beginPath();
        ctx.arc(b.x, b.y, ctx.lineWidth, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.globalAlpha = 1;
    },
    [surface.widthMm, surface.heightMm],
  );

  const clearDrawing = () => {
    const canvas = drawCanvasRef.current;
    const ctx = canvas?.getContext("2d");
    if (canvas && ctx) ctx.clearRect(0, 0, canvas.width, canvas.height);
    lastDrawPointRef.current = { raw: null, filtered: null };
  };

  /** Draws the current target as a plain ring - deliberately generic, not a
   * recreation of osu!'s own hit-circle art (no numbering, approach circle,
   * or skin imagery), since this is an original test, not a copy of the game. */
  const drawTarget = useCallback(
    (t: Point) => {
      const canvas = targetCanvasRef.current;
      const ctx = canvas?.getContext("2d");
      if (!canvas || !ctx) return;
      const scaleX = canvas.width / surface.widthMm;
      const scaleY = canvas.height / surface.heightMm;
      const radiusPx = surface.widthMm * TARGET_HIT_RADIUS_FRACTION * scaleX;
      const p = { x: t.x * scaleX, y: t.y * scaleY };
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      const ringColor = cssVar("--accent", cssVar("--text", "#f2f3f4"));
      ctx.strokeStyle = ringColor;
      ctx.lineWidth = 2.5;
      ctx.beginPath();
      ctx.arc(p.x, p.y, radiusPx, 0, Math.PI * 2);
      ctx.stroke();
      ctx.globalAlpha = 0.12;
      ctx.fillStyle = ringColor;
      ctx.fill();
      ctx.globalAlpha = 1;
      targetLastDrawRef.current = { raw: null, filtered: null };
    },
    [surface.widthMm, surface.heightMm],
  );

  const drawTargetTrailSegment = useCallback(
    (kind: "raw" | "filtered", from: Point | null, to: Point) => {
      const canvas = targetCanvasRef.current;
      const ctx = canvas?.getContext("2d");
      if (!canvas || !ctx) return;
      const scaleX = canvas.width / surface.widthMm;
      const scaleY = canvas.height / surface.heightMm;
      const toPx = (p: Point) => ({ x: p.x * scaleX, y: p.y * scaleY });
      const b = toPx(to);
      ctx.strokeStyle = kind === "raw" ? cssVar("--warn", "#d8b24c") : cssVar("--text", "#f2f3f4");
      ctx.globalAlpha = kind === "raw" ? 0.85 : 0.95;
      ctx.lineWidth = kind === "raw" ? 1.4 : 2;
      ctx.lineCap = "round";
      if (from) {
        const a = toPx(from);
        ctx.beginPath();
        ctx.moveTo(a.x, a.y);
        ctx.lineTo(b.x, b.y);
        ctx.stroke();
      }
      ctx.globalAlpha = 1;
    },
    [surface.widthMm, surface.heightMm],
  );

  const startTargetTest = () => {
    const t = randomTargetMm(surface.widthMm, surface.heightMm);
    targetRef.current = t;
    targetLegStartRef.current = null;
    targetPathRef.current = { raw: [], filtered: [] };
    setTargetsReached(0);
    setLastRun(null);
    targetTestActiveRef.current = true;
    setTargetTestActive(true);
    drawTarget(t);
  };

  const stopTargetTest = () => {
    targetTestActiveRef.current = false;
    setTargetTestActive(false);
    const canvas = targetCanvasRef.current;
    const ctx = canvas?.getContext("2d");
    if (canvas && ctx) ctx.clearRect(0, 0, canvas.width, canvas.height);
  };

  // The one fast loop: reads live telemetry, drives the canvas/jitter
  // accumulator imperatively (no re-render on every tick), and promotes a
  // throttled snapshot into React state for the numeric displays.
  useEffect(() => {
    if (!live) {
      setLiveDisplay(null);
      return;
    }
    let cancelled = false;
    let tick = 0;
    const poll = () => {
      void getTestSessionStatus().then((s) => {
        if (cancelled || !s) return;

        if (s.rawPoint && showRawTrailRef.current) {
          drawTrailSegment("raw", lastDrawPointRef.current.raw, s.rawPoint);
        }
        if (s.filteredPoint && showFilteredTrailRef.current) {
          drawTrailSegment("filtered", lastDrawPointRef.current.filtered, s.filteredPoint);
        }
        lastDrawPointRef.current = { raw: s.rawPoint, filtered: s.filteredPoint };

        pressureHistoryRef.current.push(s.pressure);
        if (pressureHistoryRef.current.length > PRESSURE_HISTORY_LEN) pressureHistoryRef.current.shift();
        redrawPressureGraph();

        if (jitterDeadlineRef.current > 0) {
          if (s.rawPoint) jitterSamplesRef.current.raw.push(s.rawPoint);
          if (s.filteredPoint) jitterSamplesRef.current.filtered.push(s.filteredPoint);
          if (Date.now() >= jitterDeadlineRef.current) {
            jitterDeadlineRef.current = 0;
            const raw = jitterMm(jitterSamplesRef.current.raw);
            const filtered = jitterMm(jitterSamplesRef.current.filtered);
            setJitterRunning(false);
            setJitterResult(raw !== null && filtered !== null ? { raw, filtered, samples: jitterSamplesRef.current.raw.length } : null);
            if (raw === null) toast.error("Not enough samples were captured - try holding the pen still for the full test.");

            // "Capture Baseline"/"Capture After" piggyback on the jitter
            // test's own 2-second hold-still measurement rather than
            // running a second, separate timer - the same real hold gives
            // both the jitter number and a fresh window of report-rate stats.
            if (capturingSlotRef.current) {
              const stabilityPct = s.rateAverage > 0 ? clamp01(1 - (s.rateMax - s.rateMin) / s.rateAverage) * 100 : null;
              const run = lastRunRef.current;
              const snapshot: OptimizationSnapshot = {
                capturedAt: Date.now(),
                jitterRawMm: raw,
                jitterFilteredMm: filtered,
                reportStabilityPct: stabilityPct,
                droppedReports: s.timingGaps,
                overshootPct: run ? (run.filteredPathMm / Math.max(run.straightLineMm, 0.01) - 1) * 100 : null,
              };
              if (capturingSlotRef.current === "baseline") setBaseline(snapshot);
              else setAfter(snapshot);
              capturingSlotRef.current = null;
              setCapturingSlot(null);
            }
          }
        }

        if (targetTestActiveRef.current && targetRef.current) {
          if (s.rawPoint) {
            drawTargetTrailSegment("raw", targetLastDrawRef.current.raw, s.rawPoint);
            targetPathRef.current.raw.push(s.rawPoint);
            targetLastDrawRef.current.raw = s.rawPoint;
          }
          if (s.filteredPoint) {
            drawTargetTrailSegment("filtered", targetLastDrawRef.current.filtered, s.filteredPoint);
            targetPathRef.current.filtered.push(s.filteredPoint);
            targetLastDrawRef.current.filtered = s.filteredPoint;

            if (distanceMm(s.filteredPoint, targetRef.current) <= surface.widthMm * TARGET_HIT_RADIUS_FRACTION) {
              const reachedTarget = targetRef.current;
              const legStart = targetLegStartRef.current;
              if (legStart) {
                setLastRun({
                  straightLineMm: distanceMm(legStart, reachedTarget),
                  rawPathMm: pathLengthMm(targetPathRef.current.raw),
                  filteredPathMm: pathLengthMm(targetPathRef.current.filtered),
                });
              }
              setTargetsReached((n) => n + 1);

              targetLegStartRef.current = reachedTarget;
              const next = randomTargetMm(surface.widthMm, surface.heightMm);
              targetRef.current = next;
              targetPathRef.current = { raw: [], filtered: [] };
              drawTarget(next);
            }
          }
        }

        tick += 1;
        if (tick % DISPLAY_EVERY_N_TICKS === 0) setLiveDisplay(s);
      });
    };
    poll();
    const id = window.setInterval(poll, FAST_POLL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, [live, drawTrailSegment, redrawPressureGraph, drawTarget, drawTargetTrailSegment, surface.widthMm]);

  const startJitterTest = () => {
    jitterSamplesRef.current = { raw: [], filtered: [] };
    jitterDeadlineRef.current = Date.now() + JITTER_TEST_MS;
    setJitterResult(null);
    setJitterRunning(true);
  };

  /** Captures a real, measured snapshot for the Before/After comparison by
   * running the same hold-still test as "Start Jitter Test" - see where its
   * result is consumed above for why this piggybacks rather than measuring
   * separately. */
  const captureSnapshot = (slot: "baseline" | "after") => {
    if (!live || jitterRunning) return;
    capturingSlotRef.current = slot;
    setCapturingSlot(slot);
    startJitterTest();
  };

  const toggleBypass = (next: boolean) =>
    (async () => {
      setBypassPending(true);
      try {
        await setFilterBypass(next);
      } catch (e) {
        toast.error(errorMessage(e));
      } finally {
        setBypassPending(false);
      }
    })();

  const resetTest = () =>
    (async () => {
      setBusy(true);
      try {
        await resetTestSession();
        pressureHistoryRef.current = [];
        redrawPressureGraph();
        clearDrawing();
        setJitterResult(null);
        setJitterRunning(false);
        jitterDeadlineRef.current = 0;
        stopTargetTest();
        setTargetsReached(0);
        setLastRun(null);
        targetRef.current = null;
        targetLegStartRef.current = null;
        setBaseline(null);
        setAfter(null);
        capturingSlotRef.current = null;
        setCapturingSlot(null);
        toast.success("Test session reset");
      } catch (e) {
        toast.error(errorMessage(e));
      } finally {
        setBusy(false);
      }
    })();

  const save = (next: Profile) =>
    (async () => {
      setBusy(true);
      try {
        const saved = await saveProfile(next);
        setProfile(saved);
        const s = await getDriverStatus();
        if (s.running && s.activeProfileId === saved.id) await applyActiveProfile();
      } catch (e) {
        toast.error(errorMessage(e));
      } finally {
        setBusy(false);
      }
    })();

  const setThreshold = (v: number) => {
    if (!profile) return;
    void save({ ...profile, pressureActivationThreshold: v });
  };

  const threshold = profile?.pressureActivationThreshold ?? 0;
  const thresholdPct = Math.round(threshold * 100);
  const fracPressure = live && liveDisplay && surface.maxPressure > 0 ? clamp01(liveDisplay.pressure / surface.maxPressure) : 0;
  const pressureClearsThreshold = fracPressure >= threshold;

  const rawFrac = liveDisplay?.rawPoint ? { x: clamp01(liveDisplay.rawPoint.x / surface.widthMm), y: clamp01(liveDisplay.rawPoint.y / surface.heightMm) } : null;
  const filteredFrac = liveDisplay?.filteredPoint
    ? { x: clamp01(liveDisplay.filteredPoint.x / surface.widthMm), y: clamp01(liveDisplay.filteredPoint.y / surface.heightMm) }
    : null;

  return (
    <Page
      title="Input Lab"
      eyebrow="Verification"
      description="Live pen tracking, raw-vs-filtered comparison, and hardware diagnostics - separate from the Tablet Area page's mapping editor."
      actions={
        profile && (
          <>
            <div className="input-lab__bypass">
              <Toggle checked={liveDisplay?.filterBypass ?? false} onChange={toggleBypass} disabled={!live || bypassPending} label="Bypass filters" />
              <span className={["input-lab__bypass-label", liveDisplay?.filterBypass ? "is-active" : ""].filter(Boolean).join(" ")}>Bypass filters</span>
            </div>
            <Button size="sm" variant="ghost" onClick={resetTest} disabled={!live || busy}>
              Reset Test
            </Button>
          </>
        )
      }
    >
      <div className="stack">
        {loadError ? (
          <Card>
            <EmptyState title="Couldn't load the active profile" description={loadError} />
          </Card>
        ) : !profile ? (
          <Card>
            <EmptyState
              title="No active profile yet"
              description="Input Lab reads and adjusts the active profile. Create or activate one on the Profiles page first."
              action={
                <Button size="sm" variant="secondary" onClick={() => navigate("profiles")}>
                  Go to Profiles
                </Button>
              }
            />
          </Card>
        ) : (
          <>
            {liveDisplay?.filterBypass && (
              <Card className="input-lab__bypass-banner">
                <Badge tone="warn">Filters bypassed</Badge>
                <span>The real cursor is currently running on completely unfiltered input for testing. Turn this off above to restore your normal filters.</span>
              </Card>
            )}

            <Section
              title="Live position"
              description={
                !live
                  ? "Start the driver from the Dashboard to see live tracking here."
                  : surfaceAssumed
                    ? "No tablet detected right now - showing an assumed surface size. Connect your tablet for accurate proportions."
                    : "The full physical tablet surface. Amber is raw input; the other dot is the filtered output actually sent to your cursor (see the legend below)."
              }
            >
              <Card>
                <div className="input-lab__surface" style={{ aspectRatio: `${surface.widthMm} / ${surface.heightMm}` }}>
                  {areaOverlay && (
                    <div
                      className="input-lab__area"
                      style={{ left: `${areaOverlay.leftPct}%`, top: `${areaOverlay.topPct}%`, width: `${areaOverlay.widthPct}%`, height: `${areaOverlay.heightPct}%` }}
                    />
                  )}
                  {live && filteredFrac && (
                    <div
                      className={["input-lab__dot input-lab__dot--filtered", liveDisplay?.inRange ? "is-in-range" : "", liveDisplay?.tipPressed ? "is-pressed" : ""]
                        .filter(Boolean)
                        .join(" ")}
                      style={{ left: `${filteredFrac.x * 100}%`, top: `${filteredFrac.y * 100}%` }}
                    />
                  )}
                  {/* Painted after (on top of) the filtered dot - smaller, so it reads as a
                      highlight rather than fully hiding the filtered dot when they're close
                      together, but never itself gets hidden the way it would the other way round. */}
                  {live && rawFrac && <div className="input-lab__dot input-lab__dot--raw" style={{ left: `${rawFrac.x * 100}%`, top: `${rawFrac.y * 100}%` }} />}
                  {!live && <div className="input-lab__overlay">No live data</div>}
                  {live && !rawFrac && <div className="input-lab__overlay">Waiting for the pen…</div>}
                </div>
                <div className="input-lab__legend">
                  <span className="input-lab__legend-item">
                    <span className="input-lab__swatch input-lab__swatch--raw" /> Raw {liveDisplay?.rawPoint ? `${liveDisplay.rawPoint.x.toFixed(1)} / ${liveDisplay.rawPoint.y.toFixed(1)} mm` : "—"}
                  </span>
                  <span className="input-lab__legend-item">
                    <span className="input-lab__swatch input-lab__swatch--filtered" /> Filtered{" "}
                    {liveDisplay?.filteredPoint ? `${liveDisplay.filteredPoint.x.toFixed(1)} / ${liveDisplay.filteredPoint.y.toFixed(1)} mm` : "—"}
                  </span>
                  {live ? <Badge tone={liveDisplay?.inRange ? "good" : "neutral"}>{liveDisplay?.inRange ? "In range" : "Out of range"}</Badge> : <Badge tone="neutral">Driver stopped</Badge>}
                </div>
              </Card>
            </Section>

            <Section title="Report rate" description="How consistently the tablet is actually reporting, measured live.">
              <Card>
                <div className="input-lab__grid4">
                  <div className="input-lab__stat">
                    <span className="input-lab__stat-label">Current</span>
                    <span className="input-lab__stat-value mono">{live ? `${liveDisplay?.rateCurrent.toFixed(0) ?? "—"} Hz` : "—"}</span>
                  </div>
                  <div className="input-lab__stat">
                    <span className="input-lab__stat-label">Average</span>
                    <span className="input-lab__stat-value mono">{live ? `${liveDisplay?.rateAverage.toFixed(0) ?? "—"} Hz` : "—"}</span>
                  </div>
                  <div className="input-lab__stat">
                    <span className="input-lab__stat-label">Minimum</span>
                    <span className="input-lab__stat-value mono">{live ? `${liveDisplay?.rateMin.toFixed(0) ?? "—"} Hz` : "—"}</span>
                  </div>
                  <div className="input-lab__stat">
                    <span className="input-lab__stat-label">Maximum</span>
                    <span className="input-lab__stat-value mono">{live ? `${liveDisplay?.rateMax.toFixed(0) ?? "—"} Hz` : "—"}</span>
                  </div>
                </div>
                <div className="rule" style={{ margin: "14px 0" }} />
                <div className="input-lab__readout">
                  <span>Possible dropped reports</span>
                  <span className="mono">{live ? (liveDisplay?.timingGaps ?? 0) : "—"}</span>
                </div>
                <p className="input-lab__hint">
                  Estimated from unusually large gaps between reports - the tablet's protocol has no sequence number, so this can't be an exact count. Treat it as a rough signal, not a
                  precise measurement.
                </p>
              </Card>
            </Section>

            <Section title="Jitter test" description="Hold the pen still on the tablet, then start the test - it measures how much the reported position moves while you're trying to stay still.">
              <Card>
                <div className="input-lab__readout">
                  <Button size="sm" variant="primary" onClick={startJitterTest} disabled={!live || jitterRunning} loading={jitterRunning}>
                    {jitterRunning ? "Hold still…" : "Start Jitter Test"}
                  </Button>
                  {jitterResult && (
                    <div className="input-lab__jitter-results">
                      <span className="mono">
                        Raw <strong>{jitterResult.raw.toFixed(2)} mm</strong>
                      </span>
                      <span className="mono">
                        Filtered <strong>{jitterResult.filtered.toFixed(2)} mm</strong>
                      </span>
                    </div>
                  )}
                </div>
                <p className="input-lab__hint">Lower is more stable. Measured over a {(JITTER_TEST_MS / 1000).toFixed(0)}-second hold, from real tablet reports.</p>
              </Card>
            </Section>

            <Section title="Drawing test" description="Draw circles, straight lines, and slow/fast, small/large movements to see exactly how your filters shape real strokes.">
              <Card flush>
                <div className="input-lab__canvas-wrap">
                  <canvas ref={drawCanvasRef} width={CANVAS_W} height={Math.round((CANVAS_W * surface.heightMm) / surface.widthMm)} className="input-lab__canvas" />
                  {!live && <div className="input-lab__overlay input-lab__overlay--canvas">Start the driver to draw here</div>}
                </div>
                <div className="input-lab__canvas-controls">
                  <Button size="sm" variant="secondary" onClick={clearDrawing}>
                    Clear
                  </Button>
                  <div className="input-lab__check">
                    <Toggle checked={showRawTrail} onChange={setShowRawTrail} label="Raw trail" />
                    <span>Raw trail</span>
                  </div>
                  <div className="input-lab__check">
                    <Toggle checked={showFilteredTrail} onChange={setShowFilteredTrail} label="Filtered trail" />
                    <span>Filtered trail</span>
                  </div>
                  <div className="input-lab__check">
                    <Toggle checked={liveDisplay?.filterBypass ?? false} onChange={toggleBypass} disabled={!live || bypassPending} label="Bypass filters" />
                    <span>Bypass filters</span>
                  </div>
                </div>
              </Card>
            </Section>

            <Section
              title="Movement test"
              description="An original target-to-target test - not a copy of osu!'s hit circles or scoring. Move the pen so the cursor reaches each ring; this visualizes path, overshoot, and raw-vs-filtered consistency, not skill or a game score."
            >
              <Card flush>
                <div className="input-lab__canvas-wrap">
                  <canvas ref={targetCanvasRef} width={CANVAS_W} height={Math.round((CANVAS_W * surface.heightMm) / surface.widthMm)} className="input-lab__canvas" />
                  {!live && <div className="input-lab__overlay input-lab__overlay--canvas">Start the driver to run this test</div>}
                  {live && !targetTestActive && <div className="input-lab__overlay input-lab__overlay--canvas">Start the test to see a target</div>}
                </div>
                <div className="input-lab__canvas-controls">
                  {targetTestActive ? (
                    <Button size="sm" variant="secondary" onClick={stopTargetTest}>
                      Stop Test
                    </Button>
                  ) : (
                    <Button size="sm" variant="primary" onClick={startTargetTest} disabled={!live}>
                      Start Movement Test
                    </Button>
                  )}
                  <span className="input-lab__readout">
                    <span>Targets reached</span>
                    <span className="mono">{targetsReached}</span>
                  </span>
                  {lastRun && (
                    <span className="input-lab__readout">
                      <span>Last leg</span>
                      <span className="mono">
                        {lastRun.straightLineMm.toFixed(1)} mm straight · raw {(lastRun.rawPathMm / Math.max(lastRun.straightLineMm, 0.01)).toFixed(2)}× · filtered{" "}
                        {(lastRun.filteredPathMm / Math.max(lastRun.straightLineMm, 0.01)).toFixed(2)}×
                      </span>
                    </span>
                  )}
                </div>
                <p className="input-lab__hint">Closer to 1.00× means a more direct path to the target; higher means more correction or overshoot along the way.</p>
              </Card>
            </Section>

            <Section
              title="Compare setup (before vs after)"
              description="Capture a real measurement now, change your filters or tablet area, then capture again - real numbers only, shown honestly even if something got worse."
            >
              <Card>
                <div className="input-lab__compare-actions">
                  <Button size="sm" variant="secondary" onClick={() => captureSnapshot("baseline")} disabled={!live || jitterRunning} loading={capturingSlot === "baseline"}>
                    Capture Baseline
                  </Button>
                  <Button size="sm" variant="secondary" onClick={() => captureSnapshot("after")} disabled={!live || jitterRunning || !baseline} loading={capturingSlot === "after"}>
                    Capture After
                  </Button>
                  {(baseline || after) && (
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => {
                        setBaseline(null);
                        setAfter(null);
                      }}
                      disabled={jitterRunning}
                    >
                      Clear
                    </Button>
                  )}
                </div>
                {!baseline ? (
                  <p className="input-lab__hint">Capture a baseline first (holds still for {(JITTER_TEST_MS / 1000).toFixed(0)} seconds, same as the jitter test above), change your settings, then capture again.</p>
                ) : (
                  <div className="input-lab__compare-table">
                    <div className="input-lab__compare-row input-lab__compare-row--head">
                      <span />
                      <span>Before</span>
                      <span>After</span>
                    </div>
                    <CompareRow label="Jitter (filtered)" before={baseline.jitterFilteredMm} afterValue={after?.jitterFilteredMm ?? null} unit=" mm" decimals={2} better="lower" />
                    <CompareRow label="Report stability" before={baseline.reportStabilityPct} afterValue={after?.reportStabilityPct ?? null} unit="%" decimals={1} better="higher" />
                    <CompareRow label="Dropped reports (est.)" before={baseline.droppedReports} afterValue={after?.droppedReports ?? null} unit="" decimals={0} better="lower" />
                    <CompareRow label="Movement overshoot" before={baseline.overshootPct} afterValue={after?.overshootPct ?? null} unit="%" decimals={1} better="lower" />
                  </div>
                )}
                {baseline?.overshootPct === null && <p className="input-lab__hint">Overshoot needs at least one completed leg of the Movement Test above before it can be captured.</p>}
              </Card>
            </Section>

            <Section title="Pressure" description="Confirm the pen reports pressure across its full range, and set a minimum press force before a touch counts as a click.">
              <Card>
                <div className="input-lab__pressure-bar">
                  <div className="input-lab__pressure-fill" style={{ width: `${fracPressure * 100}%` }} />
                  {thresholdPct > 0 && <div className="input-lab__pressure-threshold" style={{ left: `${thresholdPct}%` }} />}
                </div>
                <div className="input-lab__readout">
                  <span className="mono">{live && liveDisplay ? `${liveDisplay.pressure} / ${surface.maxPressure || "?"}` : "—"}</span>
                  <span className="mono input-lab__muted">Max seen: {live ? (liveDisplay?.maxPressureSeen ?? 0) : "—"}</span>
                  {live && liveDisplay && (liveDisplay.tipPressed || fracPressure > 0) ? (
                    <Badge tone={liveDisplay.tipPressed && pressureClearsThreshold ? "good" : "neutral"}>{liveDisplay.tipPressed ? "Tip down" : "Tip up"}</Badge>
                  ) : null}
                </div>

                <canvas ref={pressureCanvasRef} width={CANVAS_W} height={90} className="input-lab__pressure-graph" />

                <Field
                  label="Activation threshold"
                  hint={
                    thresholdPct === 0
                      ? "Disabled - every hardware tip-down registers as a click."
                      : `Requires at least ${thresholdPct}% pressure before a tip-down counts as a click.`
                  }
                >
                  <div className="input-lab__slider-row">
                    <input
                      type="range"
                      className="input-lab__slider"
                      min={0}
                      max={MAX_THRESHOLD}
                      step={0.05}
                      value={threshold}
                      disabled={busy}
                      onChange={(e) => setThreshold(Number(e.target.value))}
                    />
                    <span className="input-lab__slider-value mono">{thresholdPct}%</span>
                  </div>
                </Field>
              </Card>
            </Section>
          </>
        )}
      </div>
    </Page>
  );
}

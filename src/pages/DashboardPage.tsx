import { useCallback, useEffect, useState } from "react";
import { Page, Section } from "@/components/layout/Page";
import { Card, CardHeader } from "@/components/ui/Card";
import { StatTile } from "@/components/ui/StatTile";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { ConfirmDialog } from "@/components/ui/Modal";
import { useToast } from "@/components/ui/Toast";
import { useNavigation } from "@/state/NavigationProvider";
import { useSettings } from "@/state/SettingsProvider";
import { errorMessage } from "@/services/ipc";
import { applyActiveProfile, getDriverStatus, getTestSessionStatus, restartDriver, scanTablets, startDriver, stopDriver } from "@/services/driver";
import { getActiveProfileId, getProfile, saveProfile } from "@/services/profiles";
import { getComputerName } from "@/services/system";
import { getAvailableMonitors, type MonitorInfo } from "@/services/window";
import { getOsuStatus, launchOsu } from "@/services/osu";
import { aspectRatioValue, effectiveSize, ratiosMatch } from "@/lib/aspectRatio";
import { activePresetLabel, presetByKind, PRESETS, type PresetKind } from "@/lib/presets";
import type { DriverStatus, FilterConfig, OsuStatus, OsuVariant, Profile, TestSessionStatus } from "@/types";
import "./DashboardPage.css";

/** Local system time only - no online API, matching the four ranges exactly
 * as specified (23:00-04:59 is the "else": everything the first three don't cover). */
function greetingForHour(hour: number): string {
  if (hour >= 5 && hour < 12) return "Good morning";
  if (hour >= 12 && hour < 18) return "Good afternoon";
  if (hour >= 18 && hour < 23) return "Good evening";
  return "Good night";
}

function mergeFilters(existing: FilterConfig[], incoming: FilterConfig[]): FilterConfig[] {
  const byId = new Map(existing.map((f) => [f.id, f]));
  for (const f of incoming) byId.set(f.id, f);
  return Array.from(byId.values());
}

interface ReadyCheck {
  label: string;
  ready: boolean;
  detail: string;
  onFix?: () => void;
}

export function DashboardPage() {
  const { navigate } = useNavigation();
  const { settings } = useSettings();
  const toast = useToast();

  const [status, setStatus] = useState<DriverStatus | null>(null);
  const [testSession, setTestSession] = useState<TestSessionStatus | null>(null);
  const [profile, setProfile] = useState<Profile | null>(null);
  const [monitors, setMonitors] = useState<MonitorInfo[]>([]);
  const [scannedCount, setScannedCount] = useState(0);
  const [osuStatus, setOsuStatus] = useState<OsuStatus | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [computerName, setComputerName] = useState<string | null>(null);
  const [confirmPreset, setConfirmPreset] = useState<PresetKind | null>(null);

  const load = useCallback(async () => {
    try {
      const [s, t] = await Promise.all([getDriverStatus(), getTestSessionStatus().catch(() => null)]);
      setStatus(s);
      setTestSession(t);
      // The active profile is a persisted concept independent of whether the
      // driver happens to be running right now, so it's loaded separately
      // rather than only through DriverStatus (which is empty while stopped).
      const activeId = await getActiveProfileId();
      setProfile(activeId ? await getProfile(activeId).catch(() => null) : null);
      const [tablets, mons, osu] = await Promise.all([scanTablets().catch(() => []), getAvailableMonitors(), getOsuStatus().catch(() => null)]);
      setScannedCount(tablets.length);
      setMonitors(mons);
      setOsuStatus(osu);
    } catch (e) {
      setLoadError(errorMessage(e));
    }
  }, []);

  useEffect(() => {
    void load();
    const id = window.setInterval(() => void load(), 2000);
    return () => window.clearInterval(id);
  }, [load]);

  // The machine name never changes during a session - fetched once, unlike
  // the polled driver/profile state above.
  useEffect(() => {
    void getComputerName().then(setComputerName);
  }, []);

  const guardDriver = async (fn: () => Promise<DriverStatus>) => {
    setBusy(true);
    try {
      setStatus(await fn());
      await load();
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  const rescan = () =>
    scanTablets()
      .then((found) => setScannedCount(found.length))
      .catch((e) => toast.error(errorMessage(e)));

  const applyPreset = (kind: PresetKind) =>
    (async () => {
      if (!profile) return;
      setBusy(true);
      try {
        const preset = presetByKind(kind);
        if (!preset) return;
        const saved = await saveProfile({ ...profile, filters: mergeFilters(profile.filters, preset.build()) });
        setProfile(saved);
        const s = await getDriverStatus();
        if (s.running && s.activeProfileId === saved.id) await applyActiveProfile();
        toast.success(`${preset.label} preset applied`);
      } catch (e) {
        toast.error(errorMessage(e));
      } finally {
        setBusy(false);
        setConfirmPreset(null);
      }
    })();

  const openOsu = () =>
    (async () => {
      if (!osuStatus) return;
      const bothFound = osuStatus.stable.pathExists && osuStatus.lazer.pathExists;
      const variant: OsuVariant | null = bothFound
        ? (settings.preferredOsuVariant ?? "stable")
        : osuStatus.stable.pathExists
          ? "stable"
          : osuStatus.lazer.pathExists
            ? "lazer"
            : null;
      if (!variant) {
        toast.error("osu! wasn't found. Set its executable path in Settings.");
        return;
      }
      try {
        await launchOsu(variant);
      } catch (e) {
        toast.error(errorMessage(e));
      }
    })();

  const loading = status === null && !loadError;
  const hasCandidate = scannedCount > 0;
  const driverTone = loadError ? "warn" : status?.running ? (status.connected ? "good" : "warn") : "neutral";
  const driverLabel = loading ? "…" : status?.running ? (status.connected ? "Running" : "Reconnecting") : "Stopped";

  const cardDescription = loadError
    ? `Couldn't reach the driver: ${loadError}`
    : status?.running
      ? status.connected
        ? "The driver is running and moving the cursor from tablet input."
        : "The driver is running but the tablet is disconnected - it will reconnect automatically."
      : hasCandidate
        ? "A supported tablet is connected but the driver isn't running yet."
        : "No supported tablet detected. Connect one to get started.";

  const tabletEffective = profile ? effectiveSize(profile.tabletArea) : null;
  const selectedMonitor = profile ? monitors.find((m) => Math.abs(m.width - profile.displayArea.width) < 1 && Math.abs(m.height - profile.displayArea.height) < 1) : undefined;
  const monitorSelected = Boolean(profile && profile.displayArea.width > 0 && profile.displayArea.height > 0);
  const aspectMatched = Boolean(
    profile &&
      tabletEffective &&
      monitorSelected &&
      ratiosMatch(aspectRatioValue(tabletEffective.width, tabletEffective.height), aspectRatioValue(profile.displayArea.width, profile.displayArea.height)),
  );

  // "Stable" here means the current rate is close to the session average,
  // not compared against any fixed target Hz - a real (if approximate)
  // signal, never a fabricated one. Needs a handful of samples first so a
  // brand-new session isn't judged on its opening blip.
  const rateStable = Boolean(
    testSession && testSession.sampleCount > 20 && testSession.rateAverage > 0 && Math.abs(testSession.rateCurrent - testSession.rateAverage) <= Math.max(5, testSession.rateAverage * 0.1),
  );

  const osuRunning = Boolean(osuStatus?.stable.running || osuStatus?.lazer.running);
  const osuRunningLabel =
    osuStatus?.stable.running && osuStatus?.lazer.running ? "Running (stable + lazer)" : osuStatus?.stable.running ? "Running (stable)" : osuStatus?.lazer.running ? "Running (lazer)" : "Not running";
  const osuFound = Boolean(osuStatus && (osuStatus.stable.pathExists || osuStatus.lazer.pathExists));

  const checks: ReadyCheck[] = [
    {
      label: "Tablet connected",
      ready: Boolean(status?.running && status.connected),
      detail: status?.running ? (status.connected ? "Connected" : "Reconnecting") : hasCandidate ? "Detected, not started" : "Not detected",
      onFix: hasCandidate ? (status?.running ? undefined : () => void guardDriver(startDriver)) : () => void rescan(),
    },
    {
      label: "Driver running",
      ready: Boolean(status?.running),
      detail: status?.running ? "Running" : "Stopped",
      onFix: hasCandidate && !status?.running ? () => void guardDriver(startDriver) : undefined,
    },
    {
      label: "Absolute mode enabled",
      ready: profile?.inputMode === "absolute",
      detail: profile ? (profile.inputMode === "absolute" ? "Absolute" : "Relative") : "No profile",
      onFix: () => navigate("tablet-area"),
    },
    {
      label: "Monitor selected",
      ready: monitorSelected,
      detail: monitorSelected ? (selectedMonitor?.name ?? "Custom region") : "Not set",
      onFix: () => navigate("tablet-area"),
    },
    {
      label: "Aspect ratio matched",
      ready: aspectMatched,
      detail: aspectMatched ? "Matched" : "Not matched",
      onFix: () => navigate("tablet-area"),
    },
    {
      label: "osu! profile loaded",
      ready: profile?.osuVariantAssignment != null,
      detail: profile ? (profile.osuVariantAssignment ? `Assigned (${profile.osuVariantAssignment})` : "Not assigned to osu!") : "No profile",
      onFix: () => navigate("profiles"),
    },
    {
      label: "Report rate stable",
      ready: rateStable,
      detail: testSession ? `${testSession.rateCurrent.toFixed(0)} Hz current / ${testSession.rateAverage.toFixed(0)} Hz average` : "Driver not running",
      onFix: () => navigate("calibration"),
    },
  ];
  const readyCount = checks.filter((c) => c.ready).length;

  const greeting = greetingForHour(new Date().getHours());
  const name = settings.displayName?.trim();

  return (
    <Page title={name ? `${greeting}, ${name}` : greeting} eyebrow="Overview" description={computerName ?? "Your PC"}>
      <div className="stack">
        <Section title="Tablet">
          <Card>
            <CardHeader
              title="Tablet status"
              description={cardDescription}
              actions={
                <>
                  <Badge tone={driverTone}>{driverLabel}</Badge>
                  <Button size="sm" variant="ghost" onClick={() => void rescan()} disabled={busy}>
                    Rescan
                  </Button>
                  {status?.running ? (
                    <Button size="sm" variant="secondary" onClick={() => void guardDriver(stopDriver)} loading={busy}>
                      Stop Driver
                    </Button>
                  ) : (
                    <Button size="sm" variant="primary" onClick={() => void guardDriver(startDriver)} loading={busy} disabled={!hasCandidate}>
                      Start Driver
                    </Button>
                  )}
                  <Button size="sm" variant="ghost" onClick={() => void guardDriver(restartDriver)} loading={busy} disabled={!status?.running && !hasCandidate}>
                    Restart
                  </Button>
                </>
              }
            />
            <div className="dash__grid">
              <StatTile label="Connected tablet" value={loading ? "…" : status?.tabletName || "None"} note={status?.running ? `${status.reportsPerSecond.toFixed(0)} Hz` : undefined} />
              <StatTile label="Current profile" value={profile?.name ?? "None"} note={profile ? undefined : "Create one on the Profiles page"} onClick={() => navigate("profiles")} />
              <StatTile label="Input mode" value={profile ? (profile.inputMode === "absolute" ? "Absolute" : "Relative") : "—"} onClick={() => navigate("tablet-area")} />
              <StatTile
                label="Tablet area"
                value={profile ? `${profile.tabletArea.width.toFixed(0)} × ${profile.tabletArea.height.toFixed(0)} mm` : "Not set"}
                onClick={() => navigate("tablet-area")}
              />
              <StatTile label="Selected monitor" value={selectedMonitor?.name ?? (profile ? "Custom region" : "Not set")} onClick={() => navigate("tablet-area")} />
              <StatTile label="Active filter preset" value={activePresetLabel(profile?.filters)} onClick={() => navigate("filters")} />
            </div>
            {status?.lastError && (
              <>
                <div className="rule dash__rule" />
                <p className="dash__error">Last driver error: {status.lastError}</p>
              </>
            )}
          </Card>
        </Section>

        <Section title="osu! status">
          <Card>
            <CardHeader title="osu!" description="Detected automatically - both osu! (stable) and osu!lazer are checked." actions={<Badge tone={osuRunning ? "good" : "neutral"}>{osuRunningLabel}</Badge>} />
            <div className="dash__grid">
              <StatTile label="osu! (stable)" value={osuStatus?.stable.pathExists ? (osuStatus.stable.running ? "Running" : "Found") : "Not found"} />
              <StatTile label="osu!lazer" value={osuStatus?.lazer.pathExists ? (osuStatus.lazer.running ? "Running" : "Found") : "Not found"} />
              <StatTile label="Active profile" value={profile?.name ?? "None"} onClick={() => navigate("profiles")} />
              <StatTile label="Tablet area" value={profile ? `${profile.tabletArea.width.toFixed(0)} × ${profile.tabletArea.height.toFixed(0)} mm` : "Not set"} onClick={() => navigate("tablet-area")} />
              <StatTile label="Mode" value={profile ? (profile.inputMode === "absolute" ? "Absolute" : "Relative") : "—"} onClick={() => navigate("tablet-area")} />
              <StatTile label="Monitor mapping" value={selectedMonitor?.name ?? (profile ? "Custom region" : "Not set")} onClick={() => navigate("tablet-area")} />
              <StatTile label="Aspect ratio" value={monitorSelected ? (aspectMatched ? "Matched" : "Not matched") : "Not set"} onClick={() => navigate("tablet-area")} />
              <StatTile label="Filter preset" value={activePresetLabel(profile?.filters)} onClick={() => navigate("filters")} />
            </div>
            {!osuFound && (
              <>
                <div className="rule dash__rule" />
                <p className="dash__hint">osu! wasn't found automatically. Set its executable path from Settings → osu!.</p>
              </>
            )}
          </Card>
        </Section>

        <Section title="osu! setup check" description={`${readyCount} of ${checks.length} ready`}>
          <Card flush>
            <ul className="dash__checklist">
              {checks.map((c) => (
                <li key={c.label} className={["dash__check", c.onFix ? "dash__check--clickable" : ""].filter(Boolean).join(" ")} onClick={c.onFix} role={c.onFix ? "button" : undefined}>
                  <Badge tone={c.ready ? "good" : "warn"}>{c.ready ? "Ready" : "Needs attention"}</Badge>
                  <span className="dash__check-label">{c.label}</span>
                  <span className="dash__check-detail mono">{c.detail}</span>
                </li>
              ))}
            </ul>
          </Card>
        </Section>

        <Section title="Quick actions">
          <Card>
            <div className="dash__quick-row">
              <Button size="sm" variant="primary" onClick={() => void openOsu()} disabled={!osuFound}>
                Open osu!
              </Button>
              <Button size="sm" variant="secondary" onClick={() => navigate("optimizer")}>
                Open Optimizer
              </Button>
              <Button size="sm" variant="secondary" onClick={() => navigate("tablet-area")}>
                Tablet Area
              </Button>
              <Button size="sm" variant="secondary" onClick={() => navigate("calibration")}>
                Input Test
              </Button>
            </div>
            <div className="rule dash__rule" />
            <p className="dash__row-hint">Filter presets - applying one replaces the active profile's current filter settings.</p>
            <div className="dash__quick-row">
              {PRESETS.map((p) => (
                <Button key={p.kind} size="sm" variant="ghost" onClick={() => setConfirmPreset(p.kind)} disabled={!profile || busy}>
                  {p.label}
                </Button>
              ))}
            </div>
          </Card>
        </Section>
      </div>

      <ConfirmDialog
        open={confirmPreset !== null}
        onClose={() => setConfirmPreset(null)}
        onConfirm={() => confirmPreset && applyPreset(confirmPreset)}
        title={confirmPreset ? `Apply the ${PRESETS.find((p) => p.kind === confirmPreset)?.label} preset?` : "Apply preset?"}
        confirmLabel="Apply"
        busy={busy}
        message="This replaces the active profile's current filter settings. You can still change any individual filter afterward."
      />
    </Page>
  );
}

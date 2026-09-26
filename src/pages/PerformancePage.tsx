import { useCallback, useEffect, useState } from "react";
import { Page } from "@/components/layout/Page";
import { Card, CardHeader } from "@/components/ui/Card";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { CodeBlock } from "@/components/ui/CodeBlock";
import { useToast } from "@/components/ui/Toast";
import { useNavigation } from "@/state/NavigationProvider";
import { errorMessage, isTauri } from "@/services/ipc";
import { generateDiagnosticReport, getDiagnostics, getRecentLogs } from "@/services/diagnostics";
import { getDriverStatus, getTestSessionStatus, restartDriver, stopDriver } from "@/services/driver";
import { revealPath } from "@/services/os";
import { FILTER_IDS, type DiagnosticsSnapshot, type DriverStatus, type TestSessionStatus } from "@/types";
import "./PerformancePage.css";

const FILTER_LABELS: Record<string, string> = {
  [FILTER_IDS.SMOOTHING]: "Smoothing",
  [FILTER_IDS.NOISE_REDUCTION]: "Noise reduction",
  [FILTER_IDS.ANTI_CHATTER]: "Anti-chatter",
  [FILTER_IDS.VELOCITY_SMOOTHING]: "Velocity-based smoothing",
  [FILTER_IDS.MICRO_JITTER]: "Micro-jitter",
  [FILTER_IDS.LIFT_OFF_DEBOUNCE]: "Lift-off debounce",
  [FILTER_IDS.ONE_EURO]: "One Euro Filter",
  [FILTER_IDS.SPIKE_REJECTION]: "Spike rejection",
  [FILTER_IDS.TAP_STABILIZATION]: "Tap stabilization",
};

export function PerformancePage() {
  const { navigate } = useNavigation();
  const toast = useToast();
  const [snapshot, setSnapshot] = useState<DiagnosticsSnapshot | null>(null);
  const [status, setStatus] = useState<DriverStatus | null>(null);
  const [testSession, setTestSession] = useState<TestSessionStatus | null>(null);
  const [logs, setLogs] = useState<string>("");
  const [busy, setBusy] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    try {
      const [s, d, t, l] = await Promise.all([
        getDiagnostics(),
        getDriverStatus(),
        getTestSessionStatus().catch(() => null),
        getRecentLogs(80).catch(() => ""),
      ]);
      setSnapshot(s);
      setStatus(d);
      setTestSession(t);
      setLogs(l);
    } catch (e) {
      setLoadError(errorMessage(e));
    }
  }, []);

  useEffect(() => {
    void reload();
    // Live-ish overview, not a high-frequency graph (that's Input Lab's job)
    // - a slow poll is enough to keep report rate/dropped-report figures
    // current without competing with the tablet input path for attention.
    const id = window.setInterval(() => void reload(), 2000);
    return () => window.clearInterval(id);
  }, [reload]);

  const guard = async (fn: () => Promise<void>) => {
    setBusy(true);
    try {
      await fn();
      await reload();
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  const copyReport = () =>
    guard(async () => {
      const report = await generateDiagnosticReport();
      await navigator.clipboard.writeText(report);
      toast.success("Diagnostic report copied");
    });

  const usbHidStatus = !status?.running ? (snapshot && snapshot.devices.length > 0 ? "Detected, not started" : "Not detected") : status.connected ? "Connected" : "Reconnecting";

  return (
    <Page
      title="Performance"
      eyebrow="osu! input performance"
      description="Real measurements only - anything Thomsen Tablet can't actually measure is left out rather than guessed at."
      actions={
        <>
          <Button size="sm" variant="secondary" onClick={() => void guard(async () => void (await restartDriver()))} disabled={busy}>
            Restart Driver
          </Button>
          <Button size="sm" variant="ghost" onClick={() => void guard(async () => void (await stopDriver()))} disabled={busy}>
            Stop Driver
          </Button>
          <Button size="sm" variant="secondary" onClick={() => void copyReport()} loading={busy}>
            Copy Report
          </Button>
        </>
      }
    >
      <div className="stack">
        {loadError && (
          <Card>
            <p className="diagnostics__error">{loadError}</p>
          </Card>
        )}

        {snapshot && (
          <>
            <Card>
              <CardHeader title="Live performance" description="Report rate and reliability, measured from the running driver." actions={<Badge tone={status?.running ? "good" : "neutral"}>{status?.running ? "Live" : "Driver stopped"}</Badge>} />
              <div className="diagnostics__grid">
                <div className="diagnostics__row">
                  <span className="diagnostics__label">Report rate</span>
                  <span className="diagnostics__value mono">{status?.running ? `${status.reportsPerSecond.toFixed(0)} Hz` : "Unavailable"}</span>
                </div>
                <div className="diagnostics__row">
                  <span className="diagnostics__label">Average report rate</span>
                  <span className="diagnostics__value mono">{testSession ? `${testSession.rateAverage.toFixed(1)} Hz` : "Unavailable"}</span>
                </div>
                <div className="diagnostics__row">
                  <span className="diagnostics__label">Dropped reports</span>
                  <span className="diagnostics__value mono">
                    {testSession ? `${testSession.timingGaps} (estimate)` : "Unavailable"}
                  </span>
                </div>
                <div className="diagnostics__row">
                  <span className="diagnostics__label">Jitter</span>
                  <span className="diagnostics__value">
                    Measured with a deliberate hold-still test, not shown as an ambient number.{" "}
                    <button type="button" className="diagnostics__link" onClick={() => navigate("calibration")}>
                      Run jitter test
                    </button>
                  </span>
                </div>
                <div className="diagnostics__row">
                  <span className="diagnostics__label">USB / HID status</span>
                  <span className="diagnostics__value">{usbHidStatus}</span>
                </div>
              </div>
            </Card>

            <Card>
              <CardHeader title="Application" actions={<Badge tone="neutral">v{snapshot.appVersion}</Badge>} />
              <div className="diagnostics__grid">
                <div className="diagnostics__row">
                  <span className="diagnostics__label">Platform</span>
                  <span className="diagnostics__value mono">
                    {snapshot.os} / {snapshot.arch}
                  </span>
                </div>
                <div className="diagnostics__row">
                  <span className="diagnostics__label">Driver status</span>
                  <span className="diagnostics__value">
                    {snapshot.driverRunning ? (snapshot.driverConnected ? "Running, connected" : "Running, reconnecting") : "Stopped"}
                  </span>
                </div>
                <div className="diagnostics__row">
                  <span className="diagnostics__label">Active profile</span>
                  <span className="diagnostics__value">{snapshot.activeProfileName ?? "None"}</span>
                </div>
                {snapshot.lastDriverError && (
                  <div className="diagnostics__row">
                    <span className="diagnostics__label">Last driver error</span>
                    <span className="diagnostics__value diagnostics__value--bad">{snapshot.lastDriverError}</span>
                  </div>
                )}
                <div className="diagnostics__row">
                  <span className="diagnostics__label">Config folder</span>
                  <span className="diagnostics__value mono diagnostics__path">{snapshot.configDir}</span>
                  {isTauri() && (
                    <Button size="sm" variant="secondary" onClick={() => void revealPath(snapshot.configDir)}>
                      Open
                    </Button>
                  )}
                </div>
                <div className="diagnostics__row">
                  <span className="diagnostics__label">Logs folder</span>
                  <span className="diagnostics__value mono diagnostics__path">{snapshot.logsDir}</span>
                  {isTauri() && (
                    <Button size="sm" variant="secondary" onClick={() => void revealPath(snapshot.logsDir)}>
                      Open Logs
                    </Button>
                  )}
                </div>
              </div>
            </Card>

            <Card>
              <CardHeader
                title="Filter pipeline"
                description="What's actually processing input right now, not just what a profile has toggled on."
              />
              <div className="diagnostics__grid">
                <div className="diagnostics__row">
                  <span className="diagnostics__label">Active chain</span>
                  {snapshot.activeFilterChain.length === 0 ? (
                    <span className="diagnostics__value">{snapshot.driverRunning ? "None (raw passthrough)" : "Driver not running"}</span>
                  ) : (
                    <div className="diagnostics__chain">
                      {snapshot.activeFilterChain.map((id) => (
                        <Badge key={id} tone="neutral">
                          {FILTER_LABELS[id] ?? id}
                        </Badge>
                      ))}
                    </div>
                  )}
                </div>
                <div className="diagnostics__row">
                  <span className="diagnostics__label">Spikes rejected</span>
                  <span className="diagnostics__value mono">{snapshot.spikesRejected}</span>
                </div>
              </div>
            </Card>

            <Card>
              <CardHeader title="Detected devices" description="Every HID interface Thomsen Tablet recognizes as a supported tablet, right now." />
              {snapshot.devices.length === 0 ? (
                <p className="diagnostics__empty">No tablet detected. Connect a supported tablet and reopen this page.</p>
              ) : (
                <ul className="diagnostics__devices">
                  {snapshot.devices.map((d, i) => (
                    <li key={i}>
                      <span className="diagnostics__device-name">{d.name}</span>
                      <span className="diagnostics__device-detail mono">
                        VID {d.vendorId} / PID {d.productId} · interface {d.interfaceNumber}
                      </span>
                      <span className="diagnostics__device-detail mono diagnostics__path">{d.hidPath}</span>
                    </li>
                  ))}
                </ul>
              )}
            </Card>

            <Card flush>
              <CardHeader title="Recent log lines" description="The tail of today's log file." />
              <CodeBlock text={logs || "(no logs yet)"} label="log" maxHeight={360} />
            </Card>
          </>
        )}
      </div>
    </Page>
  );
}

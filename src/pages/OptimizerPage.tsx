import { useCallback, useEffect, useMemo, useState } from "react";
import { Page, Section } from "@/components/layout/Page";
import { Card, CardHeader } from "@/components/ui/Card";
import { Button } from "@/components/ui/Button";
import { Toggle } from "@/components/ui/Toggle";
import { EmptyState } from "@/components/ui/EmptyState";
import { useToast } from "@/components/ui/Toast";
import { useNavigation } from "@/state/NavigationProvider";
import { errorMessage } from "@/services/ipc";
import { getActiveProfileId, getProfile, saveProfile } from "@/services/profiles";
import { applyActiveProfile, getDriverStatus, getTestSessionStatus, scanTablets } from "@/services/driver";
import { getAvailableMonitors, type MonitorInfo } from "@/services/window";
import { getOsuStatus } from "@/services/osu";
import { aspectRatioValue, effectiveSize, ratiosMatch, simplifyRatio } from "@/lib/aspectRatio";
import { PRESETS, filtersMatchPreset } from "@/lib/presets";
import { buildRecommendations, PREFERENCE_DEFS, snapshotOptimizableFields, restoreOptimizableFields, type Preference, type Recommendation } from "@/lib/optimizer";
import { saveRollbackSnapshot, getRollbackSnapshot, clearRollbackSnapshot, type RollbackSnapshot } from "@/lib/rollback";
import type { DriverStatus, OsuStatus, Profile, ScannedTablet, TestSessionStatus } from "@/types";
import "./OptimizerPage.css";

function detectPreference(profile: Profile): Preference {
  for (const preset of PRESETS) {
    if (filtersMatchPreset(profile.filters, preset.build())) return preset.kind;
  }
  return "custom";
}

export function OptimizerPage() {
  const { navigate } = useNavigation();
  const toast = useToast();

  const [profile, setProfile] = useState<Profile | null>(null);
  const [status, setStatus] = useState<DriverStatus | null>(null);
  const [testSession, setTestSession] = useState<TestSessionStatus | null>(null);
  const [tablet, setTablet] = useState<ScannedTablet | null>(null);
  const [monitors, setMonitors] = useState<MonitorInfo[]>([]);
  const [osuStatus, setOsuStatus] = useState<OsuStatus | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const [preference, setPreference] = useState<Preference>("custom");
  const [touched, setTouched] = useState(false);
  const [ignored, setIgnored] = useState<Set<string>>(new Set());
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [rollback, setRollback] = useState<RollbackSnapshot | null>(null);

  const reload = useCallback(async () => {
    try {
      const activeId = await getActiveProfileId();
      const p = activeId ? await getProfile(activeId) : null;
      setProfile(p);
      if (p && !touched) setPreference(detectPreference(p));

      const [s, t, tablets, mons, osu] = await Promise.all([
        getDriverStatus(),
        getTestSessionStatus().catch(() => null),
        scanTablets().catch(() => []),
        getAvailableMonitors(),
        getOsuStatus().catch(() => null),
      ]);
      setStatus(s);
      setTestSession(t);
      setTablet(tablets[0] ?? null);
      setMonitors(mons);
      setOsuStatus(osu);
    } catch (e) {
      setLoadError(errorMessage(e));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [touched]);

  useEffect(() => {
    void reload();
  }, [reload]);

  useEffect(() => {
    setRollback(getRollbackSnapshot());
  }, []);

  const selectedMonitor = profile ? monitors.find((m) => Math.abs(m.width - profile.displayArea.width) < 1 && Math.abs(m.height - profile.displayArea.height) < 1) : undefined;
  const tabletBounds = tablet ? { width: tablet.widthMm, height: tablet.heightMm } : null;

  const tabletEffective = profile ? effectiveSize(profile.tabletArea) : null;
  const tabletRatioLabel = tabletEffective ? simplifyRatio(tabletEffective.width, tabletEffective.height) : "—";
  const monitorRatioLabel = selectedMonitor ? simplifyRatio(selectedMonitor.width, selectedMonitor.height) : "—";
  const aspectMatched = Boolean(
    tabletEffective && selectedMonitor && ratiosMatch(aspectRatioValue(tabletEffective.width, tabletEffective.height), aspectRatioValue(selectedMonitor.width, selectedMonitor.height)),
  );

  const rateStable = Boolean(
    testSession && testSession.sampleCount > 20 && testSession.rateAverage > 0 && Math.abs(testSession.rateCurrent - testSession.rateAverage) <= Math.max(5, testSession.rateAverage * 0.1),
  );

  const osuDetected = osuStatus?.stable.running && osuStatus?.lazer.running ? "stable + lazer" : osuStatus?.stable.running ? "stable" : osuStatus?.lazer.running ? "lazer" : "not running";

  const recommendations = useMemo<Recommendation[]>(() => {
    if (!profile) return [];
    return buildRecommendations(profile, preference, selectedMonitor ? { width: selectedMonitor.width, height: selectedMonitor.height } : null, tabletBounds).filter(
      (r) => !ignored.has(r.id),
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [profile, preference, selectedMonitor?.width, selectedMonitor?.height, tabletBounds?.width, tabletBounds?.height, ignored]);

  // A fresh recommendation list starts with everything selected - re-syncing
  // whenever the underlying list changes (preference switched, an item was
  // ignored) rather than trying to diff and preserve partial selections
  // across a completely different set of rows.
  useEffect(() => {
    setSelected(new Set(recommendations.map((r) => r.id)));
  }, [recommendations]);

  const toggleSelected = (id: string) =>
    setSelected((s) => {
      const next = new Set(s);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const ignoreRecommendation = (id: string) => setIgnored((s) => new Set(s).add(id));

  const resetRecommendations = () => {
    setIgnored(new Set());
    setTouched(false);
    if (profile) setPreference(detectPreference(profile));
  };

  const applyRecommendationList = (toApply: Recommendation[]) =>
    (async () => {
      if (!profile || toApply.length === 0) return;
      setBusy(true);
      try {
        saveRollbackSnapshot({ profileId: profile.id, profileName: profile.name, savedAt: Date.now(), fields: snapshotOptimizableFields(profile) });
        const next = toApply.reduce((p, rec) => rec.apply(p), profile);
        const saved = await saveProfile(next);
        setProfile(saved);
        setRollback(getRollbackSnapshot());
        const s = await getDriverStatus();
        if (s.running && s.activeProfileId === saved.id) await applyActiveProfile();
        toast.success(`Applied ${toApply.length} change${toApply.length === 1 ? "" : "s"}`);
      } catch (e) {
        toast.error(errorMessage(e));
      } finally {
        setBusy(false);
      }
    })();

  const undoOptimization = () =>
    (async () => {
      const snap = rollback;
      if (!snap) return;
      setBusy(true);
      try {
        const target = await getProfile(snap.profileId);
        const restored = restoreOptimizableFields(target, snap.fields);
        const saved = await saveProfile(restored);
        clearRollbackSnapshot();
        setRollback(null);
        if (profile?.id === saved.id) setProfile(saved);
        const s = await getDriverStatus();
        if (s.running && s.activeProfileId === saved.id) await applyActiveProfile();
        toast.success(`Restored "${saved.name}" to before the last optimization`);
      } catch (e) {
        toast.error(errorMessage(e));
      } finally {
        setBusy(false);
      }
    })();

  return (
    <Page
      title="osu! Optimizer"
      eyebrow="Recommendations"
      description="Inspects your current setup and suggests changes based on a preference you choose - never a claim that one setup is objectively best."
      actions={
        rollback && (
          <Button size="sm" variant="ghost" onClick={() => void undoOptimization()} disabled={busy}>
            Undo Optimization ({rollback.profileName})
          </Button>
        )
      }
    >
      {loadError ? (
        <Card>
          <EmptyState title="Couldn't load the active profile" description={loadError} />
        </Card>
      ) : !profile ? (
        <Card>
          <EmptyState
            title="No active profile yet"
            description="The Optimizer works on a profile. Create or activate one on the Profiles page first."
            action={
              <Button size="sm" variant="secondary" onClick={() => navigate("profiles")}>
                Go to Profiles
              </Button>
            }
          />
        </Card>
      ) : (
        <div className="stack">
          <Section title="Current setup">
            <Card>
              <div className="optimizer__grid">
                <div className="optimizer__stat">
                  <span className="optimizer__stat-label">Tablet</span>
                  <span className="optimizer__stat-value">{status?.running ? status.tabletName : (tablet?.name ?? "Not detected")}</span>
                </div>
                <div className="optimizer__stat">
                  <span className="optimizer__stat-label">Tablet area</span>
                  <span className="optimizer__stat-value mono">
                    {profile.tabletArea.width.toFixed(1)} × {profile.tabletArea.height.toFixed(1)} mm ({tabletRatioLabel})
                  </span>
                </div>
                <div className="optimizer__stat">
                  <span className="optimizer__stat-label">Monitor</span>
                  <span className="optimizer__stat-value">{selectedMonitor ? `${selectedMonitor.name} (${monitorRatioLabel})` : "Not set"}</span>
                </div>
                <div className="optimizer__stat">
                  <span className="optimizer__stat-label">Aspect ratio</span>
                  <span className="optimizer__stat-value">{selectedMonitor ? (aspectMatched ? "Matched" : "Not matched") : "—"}</span>
                </div>
                <div className="optimizer__stat">
                  <span className="optimizer__stat-label">Input mode</span>
                  <span className="optimizer__stat-value">{profile.inputMode === "absolute" ? "Absolute" : "Relative"}</span>
                </div>
                <div className="optimizer__stat">
                  <span className="optimizer__stat-label">Report rate</span>
                  <span className="optimizer__stat-value mono">{status?.running ? `${status.reportsPerSecond.toFixed(0)} Hz` : "Driver not running"}</span>
                </div>
                <div className="optimizer__stat">
                  <span className="optimizer__stat-label">Report stability</span>
                  <span className="optimizer__stat-value">{status?.running ? (rateStable ? "Stable" : "Unstable") : "—"}</span>
                </div>
                <div className="optimizer__stat">
                  <span className="optimizer__stat-label">Dropped reports (est.)</span>
                  <span className="optimizer__stat-value mono">{testSession ? testSession.timingGaps : "—"}</span>
                </div>
                <div className="optimizer__stat">
                  <span className="optimizer__stat-label">osu! detected</span>
                  <span className="optimizer__stat-value">{osuDetected}</span>
                </div>
                <div className="optimizer__stat">
                  <span className="optimizer__stat-label">Active profile</span>
                  <span className="optimizer__stat-value">{profile.name}</span>
                </div>
              </div>
            </Card>
          </Section>

          <Section title="Preference" description="A starting philosophy, not a claim that one is objectively best - different players prefer different tradeoffs.">
            <Card>
              <div className="optimizer__preferences">
                {PREFERENCE_DEFS.map((p) => (
                  <button
                    key={p.value}
                    type="button"
                    className={["optimizer__preference", preference === p.value ? "is-selected" : ""].filter(Boolean).join(" ")}
                    onClick={() => {
                      setPreference(p.value);
                      setTouched(true);
                      setIgnored(new Set());
                    }}
                  >
                    <span className="optimizer__preference-title">{p.label}</span>
                    <span className="optimizer__preference-description">{p.description}</span>
                  </button>
                ))}
              </div>
            </Card>
          </Section>

          <Section
            title="Recommendations"
            description={preference === "custom" ? "Custom means full manual control - only structural checks (input mode, aspect ratio) are shown below." : `Comparing your current filters against the ${PREFERENCE_DEFS.find((p) => p.value === preference)?.label} preference.`}
            actions={
              recommendations.length > 0 && (
                <>
                  <Button size="sm" variant="ghost" onClick={resetRecommendations} disabled={busy}>
                    Reset Recommendations
                  </Button>
                  <Button size="sm" variant="secondary" onClick={() => void applyRecommendationList(recommendations.filter((r) => selected.has(r.id)))} disabled={busy || selected.size === 0}>
                    Apply Selected
                  </Button>
                  <Button size="sm" variant="primary" onClick={() => void applyRecommendationList(recommendations)} disabled={busy}>
                    Apply All
                  </Button>
                </>
              )
            }
          >
            {recommendations.length === 0 ? (
              <Card>
                <EmptyState title="Nothing to suggest" description="Your current setup already matches this preference (or there's nothing this preference can safely change)." />
              </Card>
            ) : (
              <div className="stack">
                {recommendations.map((rec) => (
                  <Card key={rec.id}>
                    <CardHeader
                      title={rec.setting}
                      actions={
                        <>
                          <Button size="sm" variant="ghost" onClick={() => ignoreRecommendation(rec.id)} disabled={busy}>
                            Ignore
                          </Button>
                          <Toggle checked={selected.has(rec.id)} onChange={() => toggleSelected(rec.id)} label={`Include ${rec.setting} change`} disabled={busy} />
                        </>
                      }
                    />
                    <div className="optimizer__rec-values">
                      <div>
                        <span className="optimizer__rec-label">Current</span>
                        <span className="optimizer__rec-value mono">{rec.current}</span>
                      </div>
                      <div>
                        <span className="optimizer__rec-label">Suggested</span>
                        <span className="optimizer__rec-value mono">{rec.suggested}</span>
                      </div>
                    </div>
                    <p className="optimizer__rec-reason">
                      <strong>Reason:</strong> {rec.reason}
                    </p>
                    <p className="optimizer__rec-tradeoff">
                      <strong>Tradeoff:</strong> {rec.tradeoff}
                    </p>
                  </Card>
                ))}
              </div>
            )}
          </Section>
        </div>
      )}
    </Page>
  );
}

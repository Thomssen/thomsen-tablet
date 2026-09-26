import { useCallback, useEffect, useState } from "react";
import { Page, Section } from "@/components/layout/Page";
import { Card, CardHeader } from "@/components/ui/Card";
import { Toggle } from "@/components/ui/Toggle";
import { Field } from "@/components/ui/Field";
import { Badge } from "@/components/ui/Badge";
import { EmptyState } from "@/components/ui/EmptyState";
import { Button } from "@/components/ui/Button";
import { useToast } from "@/components/ui/Toast";
import { useNavigation } from "@/state/NavigationProvider";
import { errorMessage } from "@/services/ipc";
import { getActiveProfileId, getProfile, saveProfile, defaultFilters } from "@/services/profiles";
import { applyActiveProfile, getDriverStatus, getTestSessionStatus, setFilterBypass } from "@/services/driver";
import { FILTER_META, filterTitle } from "@/lib/filterMeta";
import { PRESETS } from "@/lib/presets";
import type { DriverStatus, FilterConfig, Profile } from "@/types";
import "./FiltersPage.css";

function getFilter(profile: Profile, id: string): FilterConfig {
  return profile.filters.find((f) => f.id === id) ?? { id, enabled: false, params: {} };
}

/** Merges `incoming` filter configs into `existing` by id, so applying a
 * preset (or the defaults) replaces exactly the known filters and leaves
 * anything else on the profile untouched. */
function mergeFilters(existing: FilterConfig[], incoming: FilterConfig[]): FilterConfig[] {
  const byId = new Map(existing.map((f) => [f.id, f]));
  for (const f of incoming) byId.set(f.id, f);
  return Array.from(byId.values());
}

export function FiltersPage() {
  const { navigate } = useNavigation();
  const toast = useToast();
  const [profile, setProfile] = useState<Profile | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [driverStatus, setDriverStatus] = useState<DriverStatus | null>(null);
  const [bypass, setBypass] = useState(false);
  const [bypassPending, setBypassPending] = useState(false);

  const reload = useCallback(async () => {
    try {
      const activeId = await getActiveProfileId();
      if (!activeId) {
        setProfile(null);
        return;
      }
      setProfile(await getProfile(activeId));
    } catch (e) {
      setLoadError(errorMessage(e));
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  // Only needed for the "Active Filter Chain" readout and the bypass
  // toggle's live state - a slow poll is enough, this isn't a live-input page.
  useEffect(() => {
    let cancelled = false;
    const poll = () => {
      void getDriverStatus().then((s) => !cancelled && setDriverStatus(s));
      void getTestSessionStatus().then((s) => !cancelled && setBypass(s?.filterBypass ?? false));
    };
    poll();
    const id = window.setInterval(poll, 1000);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, []);

  const toggleBypass = (next: boolean) =>
    (async () => {
      setBypassPending(true);
      try {
        await setFilterBypass(next);
        setBypass(next);
      } catch (e) {
        toast.error(errorMessage(e));
      } finally {
        setBypassPending(false);
      }
    })();

  const update = (next: Profile, confirmMessage?: string) =>
    (async () => {
      setBusy(true);
      try {
        const saved = await saveProfile(next);
        setProfile(saved);
        const status = await getDriverStatus();
        if (status.running && status.activeProfileId === saved.id) {
          await applyActiveProfile();
        }
        if (confirmMessage) toast.success(confirmMessage);
      } catch (e) {
        toast.error(errorMessage(e));
      } finally {
        setBusy(false);
      }
    })();

  const setFilter = (id: string, patch: Partial<FilterConfig>) => {
    if (!profile) return;
    const existing = getFilter(profile, id);
    const merged: FilterConfig = { ...existing, ...patch, params: { ...existing.params, ...patch.params } };
    const filters = profile.filters.some((f) => f.id === id) ? profile.filters.map((f) => (f.id === id ? merged : f)) : [...profile.filters, merged];
    void update({ ...profile, filters });
  };

  const resetOneFilter = (id: string) => {
    if (!profile) return;
    const fresh = defaultFilters().find((f) => f.id === id);
    if (!fresh) return;
    setFilter(id, fresh);
    toast.success(`${filterTitle(id)} reset`);
  };

  const applyPreset = (preset: (typeof PRESETS)[number]) => {
    if (!profile) return;
    void update({ ...profile, filters: mergeFilters(profile.filters, preset.build()) }, `${preset.label} preset applied`);
  };

  return (
    <Page
      title="Filters"
      eyebrow="Signal processing"
      description="Applied to the active profile, in this order: spike rejection, micro-jitter, noise reduction, velocity-based smoothing, the One Euro filter, then smoothing. Anti-chatter, lift-off debounce, and tap stabilization each apply separately, to the tip/contact signal rather than position."
      actions={
        profile && (
          <Button size="sm" variant="ghost" onClick={() => navigate("calibration")}>
            Compare Raw vs Filtered
          </Button>
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
              description="Filters apply to a profile. Create or activate one on the Profiles page first."
              action={
                <Button size="sm" variant="secondary" onClick={() => navigate("profiles")}>
                  Go to Profiles
                </Button>
              }
            />
          </Card>
        ) : (
          <>
            {bypass && (
              <Card className="filters__bypass-banner">
                <Badge tone="warn">Filters bypassed</Badge>
                <span>Every filter below is currently skipped - the cursor is running on completely raw input. Turn this off below to restore your normal filtering.</span>
              </Card>
            )}

            <Section title="Input presets" description="Starting points, not rankings - pick whichever feels right, then fine-tune any filter below.">
              <Card>
                <div className="filters__presets">
                  {PRESETS.map((preset) => (
                    <div key={preset.kind} className="filters__preset">
                      <div>
                        <p className="filters__preset-title">{preset.label}</p>
                        <p className="filters__preset-description">{preset.description}</p>
                      </div>
                      <Button size="sm" variant="secondary" onClick={() => applyPreset(preset)} disabled={busy}>
                        Apply
                      </Button>
                    </div>
                  ))}
                </div>
              </Card>
            </Section>

            <Section title="Active filter chain" description="What's actually processing input right now, in pipeline order - not just what's toggled on below.">
              <Card>
                {!driverStatus?.running ? (
                  <p className="filters__chain-empty">Start the driver from the Dashboard to see the live chain here.</p>
                ) : (
                  <div className="filters__chain">
                    <span className="filters__chain-node filters__chain-node--endpoint">Raw HID Input</span>
                    {driverStatus.activeFilterChain.map((id) => (
                      <span key={id} className="filters__chain-step">
                        <span className="filters__chain-arrow">→</span>
                        <span className="filters__chain-node">{filterTitle(id)}</span>
                      </span>
                    ))}
                    <span className="filters__chain-step">
                      <span className="filters__chain-arrow">→</span>
                      <span className="filters__chain-node filters__chain-node--endpoint">Cursor Output</span>
                    </span>
                  </div>
                )}
                <div className="rule filters__chain-rule" />
                <div className="filters__row">
                  <div>
                    <p className="filters__row-title">Bypass all filters temporarily</p>
                    <p className="filters__row-hint">Session-only - never touches your saved filter settings. Turns off automatically when the driver restarts.</p>
                  </div>
                  <Toggle checked={bypass} onChange={toggleBypass} disabled={!driverStatus?.running || bypassPending} label="Bypass all filters" />
                </div>
              </Card>
            </Section>

            {FILTER_META.map((meta) => {
              const cfg = getFilter(profile, meta.id);
              return (
                <Card key={meta.id}>
                  <CardHeader
                    title={meta.title}
                    description={meta.description}
                    actions={
                      <>
                        <Button size="sm" variant="ghost" onClick={() => resetOneFilter(meta.id)} disabled={busy}>
                          Reset
                        </Button>
                        <Toggle checked={cfg.enabled} onChange={(v) => setFilter(meta.id, { enabled: v })} label={meta.title} disabled={busy} />
                      </>
                    }
                  />
                  <div className="filters__params">
                    {meta.params.map((param) => {
                      const value = cfg.params[param.key] ?? 0;
                      return (
                        <Field key={param.key} label={param.label} hint={!cfg.enabled ? "Enable this filter to adjust it." : undefined}>
                          <div className="filters__slider-row">
                            <input
                              type="range"
                              className="filters__slider"
                              min={param.min}
                              max={param.max}
                              step={param.step}
                              value={value}
                              disabled={!cfg.enabled || busy}
                              onChange={(e) => setFilter(meta.id, { params: { [param.key]: Number(e.target.value) } })}
                            />
                            <span className="filters__value mono">{param.format(value)}</span>
                          </div>
                        </Field>
                      );
                    })}
                  </div>
                </Card>
              );
            })}
          </>
        )}
      </div>
    </Page>
  );
}

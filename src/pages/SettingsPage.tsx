import { useCallback, useEffect, useState } from "react";
import { Page, Section } from "@/components/layout/Page";
import { Card } from "@/components/ui/Card";
import { Button } from "@/components/ui/Button";
import { Badge } from "@/components/ui/Badge";
import { SegmentedControl } from "@/components/ui/SegmentedControl";
import { Dropdown } from "@/components/ui/Dropdown";
import { Field, TextInput } from "@/components/ui/Field";
import { Toggle } from "@/components/ui/Toggle";
import { ConfirmDialog } from "@/components/ui/Modal";
import { useToast } from "@/components/ui/Toast";
import { useNavigation } from "@/state/NavigationProvider";
import { useSettings } from "@/state/SettingsProvider";
import { getAppInfo } from "@/services/system";
import { resetSettings as resetSettingsBackend } from "@/services/settings";
import { revealPath, openDialog } from "@/services/os";
import { getOsuStatus } from "@/services/osu";
import { getDriverStatus, restartDriver, scanTablets } from "@/services/driver";
import { listProfiles, saveProfile } from "@/services/profiles";
import { isTauri, errorMessage } from "@/services/ipc";
import { APP } from "@/config/app";
import type { DriverStatus, OsuInstallStatus, OsuStatus, OsuVariant, Profile, ThemeSetting, UsagePreset, WindowStyle } from "@/types";
import "./SettingsPage.css";

const NONE_PROFILE = "__none__";

const THEME_OPTIONS: { value: ThemeSetting; label: string }[] = [
  { value: "dark", label: "Dark" },
  { value: "light", label: "Light" },
  { value: "system", label: "System" },
];

const WINDOW_STYLE_OPTIONS: { value: WindowStyle; label: string }[] = [
  { value: "macos", label: "macOS" },
  { value: "windows", label: "Windows" },
];

const USAGE_PRESET_OPTIONS: { value: UsagePreset; label: string }[] = [
  { value: "osu", label: "osu!" },
  { value: "drawing", label: "Drawing" },
  { value: "general", label: "General" },
  { value: "custom", label: "Custom" },
];

const OSU_VARIANT_OPTIONS: { value: OsuVariant; label: string }[] = [
  { value: "stable", label: "Stable" },
  { value: "lazer", label: "Lazer" },
];

function osuStatusBadge(status: OsuInstallStatus | undefined) {
  if (!status) return <Badge tone="neutral">Checking…</Badge>;
  if (status.running) return <Badge tone="good">Running</Badge>;
  if (status.pathExists) return <Badge tone="neutral">Found</Badge>;
  return <Badge tone="neutral">Not found</Badge>;
}

export function SettingsPage() {
  const { navigate } = useNavigation();
  const { settings, update } = useSettings();
  const toast = useToast();

  const [dataDir, setDataDir] = useState("");
  const [busy, setBusy] = useState(false);
  const [confirmReset, setConfirmReset] = useState(false);
  const [nameDraft, setNameDraft] = useState(settings.displayName ?? "");
  const [osuStatus, setOsuStatus] = useState<OsuStatus | null>(null);
  const [osuStablePathDraft, setOsuStablePathDraft] = useState(settings.osuStablePath ?? "");
  const [osuLazerPathDraft, setOsuLazerPathDraft] = useState(settings.osuLazerPath ?? "");
  const [profiles, setProfiles] = useState<Profile[]>([]);
  const [driverStatus, setDriverStatus] = useState<DriverStatus | null>(null);
  const [tabletCount, setTabletCount] = useState(0);

  useEffect(() => {
    void getAppInfo()
      .then((i) => setDataDir(i.dataDir))
      .catch(() => {});
  }, []);

  const refreshOsuStatus = useCallback(() => {
    void getOsuStatus()
      .then(setOsuStatus)
      .catch(() => setOsuStatus(null));
  }, []);

  useEffect(() => {
    refreshOsuStatus();
  }, [refreshOsuStatus]);

  const refreshProfiles = useCallback(() => {
    void listProfiles()
      .then(setProfiles)
      .catch(() => setProfiles([]));
  }, []);

  useEffect(() => {
    refreshProfiles();
  }, [refreshProfiles]);

  const refreshDriver = useCallback(() => {
    void getDriverStatus().then(setDriverStatus);
    void scanTablets()
      .then((t) => setTabletCount(t.length))
      .catch(() => setTabletCount(0));
  }, []);

  useEffect(() => {
    refreshDriver();
    const id = window.setInterval(refreshDriver, 2000);
    return () => window.clearInterval(id);
  }, [refreshDriver]);

  // Keep the drafts in sync if these change elsewhere (e.g. onboarding just
  // set the name) without fighting the user while they're actively typing.
  useEffect(() => {
    setNameDraft(settings.displayName ?? "");
  }, [settings.displayName]);
  useEffect(() => {
    setOsuStablePathDraft(settings.osuStablePath ?? "");
  }, [settings.osuStablePath]);
  useEffect(() => {
    setOsuLazerPathDraft(settings.osuLazerPath ?? "");
  }, [settings.osuLazerPath]);

  const commitName = () => {
    const trimmed = nameDraft.trim();
    if (trimmed === (settings.displayName ?? "")) return;
    void update({ displayName: trimmed || null });
  };

  const commitOsuPath = (variant: OsuVariant, value: string) => {
    const trimmed = value.trim();
    const current = variant === "stable" ? settings.osuStablePath : settings.osuLazerPath;
    if (trimmed === (current ?? "")) return;
    const patch = variant === "stable" ? { osuStablePath: trimmed || null } : { osuLazerPath: trimmed || null };
    void update(patch).then(() => refreshOsuStatus());
  };

  const browseOsuPath = (variant: OsuVariant) =>
    guard(async () => {
      const path = await openDialog({ title: "Locate osu!.exe", filters: [{ name: "Executable", extensions: ["exe"] }] });
      if (!path) return;
      if (variant === "stable") {
        setOsuStablePathDraft(path);
        await update({ osuStablePath: path });
      } else {
        setOsuLazerPathDraft(path);
        await update({ osuLazerPath: path });
      }
      refreshOsuStatus();
    });

  const clearOsuPath = (variant: OsuVariant) =>
    guard(async () => {
      if (variant === "stable") {
        setOsuStablePathDraft("");
        await update({ osuStablePath: null });
      } else {
        setOsuLazerPathDraft("");
        await update({ osuLazerPath: null });
      }
      refreshOsuStatus();
    });

  const assignVariantProfile = (variant: OsuVariant, profileId: string) =>
    guard(async () => {
      // Unassign whatever profile currently holds this variant first (if
      // any) - saving the newly-picked one already clears it server-side,
      // but doing it explicitly here means an id of NONE_PROFILE (picking
      // "None") still does the right thing without a special-cased branch.
      const current = profiles.find((p) => p.osuVariantAssignment === variant);
      if (current && current.id !== profileId) {
        await saveProfile({ ...current, osuVariantAssignment: null });
      }
      if (profileId !== NONE_PROFILE) {
        const target = profiles.find((p) => p.id === profileId);
        if (target) await saveProfile({ ...target, osuVariantAssignment: variant });
      }
      refreshProfiles();
    });

  const runSetupAgain = () => void update({ onboardingCompleted: false });

  async function guard(fn: () => Promise<void>) {
    setBusy(true);
    try {
      await fn();
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  const doReset = () =>
    guard(async () => {
      const reset = await resetSettingsBackend();
      await update(reset);
      setConfirmReset(false);
      toast.success("Settings reset to defaults");
    });

  const bothOsuInstallsFound = Boolean(osuStatus?.stable.pathExists && osuStatus?.lazer.pathExists);

  const stableProfile = profiles.find((p) => p.osuVariantAssignment === "stable");
  const lazerProfile = profiles.find((p) => p.osuVariantAssignment === "lazer");
  const profileOptions = [{ value: NONE_PROFILE, label: "None" }, ...profiles.map((p) => ({ value: p.id, label: p.name }))];

  return (
    <Page title="Settings" eyebrow="Preferences">
      <div className="stack">
        <Section title="General">
          <Card>
            <Field label="Theme">
              <SegmentedControl aria-label="Theme" options={THEME_OPTIONS} value={settings.theme} onChange={(theme) => void update({ theme })} />
            </Field>

            <div className="rule settings__rule" />

            <Field label="Window controls" hint="The shape of the minimize/maximize/close controls in the title bar.">
              <SegmentedControl aria-label="Window style" options={WINDOW_STYLE_OPTIONS} value={settings.windowStyle} onChange={(windowStyle) => void update({ windowStyle })} />
            </Field>

            <div className="rule settings__rule" />

            <div className="settings__row">
              <div>
                <p className="settings__row-title">Start with Windows</p>
                <p className="settings__row-hint">Launch Thomsen Tablet automatically when you sign in, via a registered Windows autostart entry.</p>
              </div>
              <Toggle checked={settings.startWithWindows} onChange={(v) => void update({ startWithWindows: v })} label="Start with Windows" />
            </div>
            <div className="settings__row">
              <div>
                <p className="settings__row-title">Minimize to tray</p>
                <p className="settings__row-hint">Closing the window keeps Thomsen Tablet running in the system tray instead of exiting.</p>
              </div>
              <Toggle checked={settings.minimizeToTray} onChange={(v) => void update({ minimizeToTray: v })} label="Minimize to tray" />
            </div>
            <div className="settings__row">
              <div>
                <p className="settings__row-title">Start minimized</p>
                <p className="settings__row-hint">Open directly to the tray on launch instead of showing the window.</p>
              </div>
              <Toggle
                checked={settings.startMinimized}
                onChange={(v) => void update({ startMinimized: v })}
                label="Start minimized"
                disabled={!settings.minimizeToTray}
              />
            </div>
            <div className="settings__row">
              <div>
                <p className="settings__row-title">Check for updates</p>
                <p className="settings__row-hint">Check for new versions on launch. The update checker itself ships in v1.0.</p>
              </div>
              <Toggle checked={settings.checkForUpdates} onChange={(v) => void update({ checkForUpdates: v })} label="Check for updates" />
            </div>
          </Card>
        </Section>

        <Section title="Personalization">
          <Card>
            <Field label="Display name" hint="Used for the Dashboard greeting. Leave it blank to skip the name.">
              <TextInput
                value={nameDraft}
                placeholder="Thomsen"
                onChange={(e) => setNameDraft(e.target.value)}
                onBlur={commitName}
                onKeyDown={(e) => e.key === "Enter" && (e.currentTarget as HTMLInputElement).blur()}
              />
            </Field>

            <div className="rule settings__rule" />

            <Field label="Usage preset" hint="What you mainly use Thomsen Tablet for - a label for your own reference; changing it here doesn't change any other setting.">
              <SegmentedControl aria-label="Usage preset" options={USAGE_PRESET_OPTIONS} value={settings.usagePreset} onChange={(usagePreset) => void update({ usagePreset })} />
            </Field>
          </Card>
        </Section>

        <Section title="osu!">
          <Card>
            <div className="settings__row">
              <div>
                <p className="settings__row-title">Automatically switch profile when osu! starts</p>
                <p className="settings__row-hint">Activates whichever profile is assigned to the osu! variant (below or on the Profiles page) as soon as it's detected running.</p>
              </div>
              <Toggle
                checked={settings.autoSwitchOsuProfile}
                onChange={(v) => void update({ autoSwitchOsuProfile: v })}
                label="Automatically switch profile when osu! starts"
              />
            </div>
            <div className="settings__row">
              <div>
                <p className="settings__row-title">Restore previous profile after osu! closes</p>
                <p className="settings__row-hint">Switches back to whatever profile was active before osu! started.</p>
              </div>
              <Toggle
                checked={settings.restoreProfileAfterOsuClose}
                onChange={(v) => void update({ restoreProfileAfterOsuClose: v })}
                label="Restore previous profile after osu! closes"
                disabled={!settings.autoSwitchOsuProfile}
              />
            </div>
            <div className="settings__row">
              <div>
                <p className="settings__row-title">Session Mode</p>
                <p className="settings__row-hint">Shows a dedicated "session active" state on the Dashboard while osu! is running, on top of the same auto-switching above.</p>
              </div>
              <Toggle checked={settings.sessionModeEnabled} onChange={(v) => void update({ sessionModeEnabled: v })} label="Session Mode" />
            </div>

            <div className="rule settings__rule" />

            <Field label="osu! stable profile" hint="Which profile auto-switching activates when osu! (stable) starts.">
              <Dropdown
                aria-label="osu! stable profile"
                value={stableProfile?.id ?? NONE_PROFILE}
                options={profileOptions}
                onChange={(id) => void assignVariantProfile("stable", id)}
                disabled={busy || profiles.length === 0}
              />
            </Field>

            <div className="rule settings__rule" />

            <Field label="osu!lazer profile" hint="Which profile auto-switching activates when osu!lazer starts.">
              <Dropdown
                aria-label="osu!lazer profile"
                value={lazerProfile?.id ?? NONE_PROFILE}
                options={profileOptions}
                onChange={(id) => void assignVariantProfile("lazer", id)}
                disabled={busy || profiles.length === 0}
              />
            </Field>

            <div className="rule settings__rule" />

            <Field label="osu! (stable) executable" aside={osuStatusBadge(osuStatus?.stable)} hint="Auto-detected at the standard install location unless you set a custom path.">
              <div className="settings__path">
                <TextInput
                  value={osuStablePathDraft}
                  placeholder={osuStatus?.stable.path ?? "Not found - browse to set it manually"}
                  onChange={(e) => setOsuStablePathDraft(e.target.value)}
                  onBlur={(e) => commitOsuPath("stable", e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && (e.currentTarget as HTMLInputElement).blur()}
                />
                <Button size="sm" variant="secondary" onClick={() => browseOsuPath("stable")} disabled={busy}>
                  Browse…
                </Button>
                {settings.osuStablePath && (
                  <Button size="sm" variant="ghost" onClick={() => clearOsuPath("stable")} disabled={busy}>
                    Auto-detect
                  </Button>
                )}
              </div>
            </Field>

            <div className="rule settings__rule" />

            <Field label="osu!lazer executable" aside={osuStatusBadge(osuStatus?.lazer)} hint="Auto-detected at the standard install location unless you set a custom path.">
              <div className="settings__path">
                <TextInput
                  value={osuLazerPathDraft}
                  placeholder={osuStatus?.lazer.path ?? "Not found - browse to set it manually"}
                  onChange={(e) => setOsuLazerPathDraft(e.target.value)}
                  onBlur={(e) => commitOsuPath("lazer", e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && (e.currentTarget as HTMLInputElement).blur()}
                />
                <Button size="sm" variant="secondary" onClick={() => browseOsuPath("lazer")} disabled={busy}>
                  Browse…
                </Button>
                {settings.osuLazerPath && (
                  <Button size="sm" variant="ghost" onClick={() => clearOsuPath("lazer")} disabled={busy}>
                    Auto-detect
                  </Button>
                )}
              </div>
            </Field>

            {bothOsuInstallsFound && (
              <>
                <div className="rule settings__rule" />
                <Field label="Preferred installation" hint="Both stable and lazer were found - which one should 'Open osu!' launch?">
                  <SegmentedControl
                    aria-label="Preferred osu! installation"
                    options={OSU_VARIANT_OPTIONS}
                    value={settings.preferredOsuVariant ?? "stable"}
                    onChange={(preferredOsuVariant) => void update({ preferredOsuVariant })}
                  />
                </Field>
              </>
            )}

            <div className="rule settings__rule" />

            <div className="settings__row">
              <div>
                <p className="settings__row-title">Detection</p>
                <p className="settings__row-hint">Re-checks the paths above and whether either installation is currently running.</p>
              </div>
              <Button size="sm" variant="secondary" onClick={refreshOsuStatus}>
                Refresh
              </Button>
            </div>
          </Card>
        </Section>

        <Section title="Driver">
          <Card>
            <div className="settings__row">
              <div>
                <p className="settings__row-title">Driver state</p>
                <p className="settings__row-hint">{driverStatus?.running ? (driverStatus.connected ? "Running, connected" : "Running, reconnecting") : "Stopped"}</p>
              </div>
              <Badge tone={driverStatus?.running ? (driverStatus.connected ? "good" : "warn") : "neutral"}>{driverStatus?.running ? "Running" : "Stopped"}</Badge>
            </div>
            <div className="settings__row">
              <div>
                <p className="settings__row-title">Restart driver</p>
                <p className="settings__row-hint">Stops and restarts the driver, re-scanning for the tablet in the process.</p>
              </div>
              <Button
                size="sm"
                variant="secondary"
                onClick={() =>
                  void guard(async () => {
                    await restartDriver();
                    refreshDriver();
                  })
                }
                disabled={busy}
              >
                Restart
              </Button>
            </div>
            <div className="settings__row">
              <div>
                <p className="settings__row-title">Reconnect tablet</p>
                <p className="settings__row-hint">Re-scans for a connected tablet without stopping the driver{tabletCount > 0 ? ` - ${tabletCount} detected right now.` : "."}</p>
              </div>
              <Button size="sm" variant="secondary" onClick={refreshDriver} disabled={busy}>
                Rescan
              </Button>
            </div>
            <div className="settings__row">
              <div>
                <p className="settings__row-title">Diagnostics</p>
                <p className="settings__row-hint">Report rate, dropped-report estimates, and the active filter chain - all on the Performance page.</p>
              </div>
              <Button size="sm" variant="secondary" onClick={() => navigate("diagnostics")}>
                Open Performance
              </Button>
            </div>
          </Card>
        </Section>

        <Section title="Profiles">
          <Card>
            <Field label="Profile storage location" hint="Profiles are stored alongside your app settings and logs, in this data folder.">
              <div className="settings__path">
                <code className="mono selectable">{dataDir || "…"}</code>
                {isTauri() && dataDir && (
                  <Button size="sm" variant="secondary" onClick={() => void revealPath(dataDir)}>
                    Reveal
                  </Button>
                )}
              </div>
            </Field>

            <div className="rule settings__rule" />

            <div className="settings__row">
              <div>
                <p className="settings__row-title">Manage profiles</p>
                <p className="settings__row-hint">Create, duplicate, rename, delete, export, and import profiles from the Profiles page.</p>
              </div>
              <Button size="sm" variant="secondary" onClick={() => navigate("profiles")}>
                Go to Profiles
              </Button>
            </div>
          </Card>
        </Section>

        <Section title="Privacy">
          <Card>
            <ul className="settings__privacy">
              <li>Everything runs locally on this device - no account, sign-in, or internet connection required.</li>
              <li>No telemetry or usage data is collected or sent anywhere.</li>
              <li>No cloud storage - settings, profiles, and logs stay in the data folder above.</li>
            </ul>
          </Card>
        </Section>

        <Section title="Advanced">
          <Card>
            <div className="settings__row">
              <div>
                <p className="settings__row-title">Run setup again</p>
                <p className="settings__row-hint">Reopen the first-run setup wizard to revisit appearance, tablet detection, and starting presets.</p>
              </div>
              <Button size="sm" variant="secondary" onClick={runSetupAgain}>
                Run Setup Again
              </Button>
            </div>

            <div className="rule settings__rule" />

            <div className="settings__row">
              <div>
                <p className="settings__row-title">Reset app settings</p>
                <p className="settings__row-hint">Restores every setting on this page to its default.</p>
              </div>
              <Button size="sm" variant="danger" onClick={() => setConfirmReset(true)} disabled={busy}>
                Reset settings
              </Button>
            </div>
          </Card>
        </Section>

        <Section title="About">
          <Card>
            <div className="settings__about">
              <span>{APP.name}</span>
              <span className="mono">v{APP.version}</span>
            </div>
            <p className="settings__about-note">
              A dedicated osu! tablet optimization driver. Talks directly to supported hardware over raw USB HID - no OpenTabletDriver or other driver software required.
            </p>
            <div className="rule settings__rule" />
            <div className="settings__about-row">
              <span className="settings__row-title">Supported tablets</span>
              <span className="settings__row-hint">Wacom CTL-472, with more added over time - see NOTICE.md.</span>
            </div>
            <div className="settings__about-row">
              <span className="settings__row-title">Supported games</span>
              <span className="settings__row-hint">osu! (stable), osu!lazer</span>
            </div>
          </Card>
        </Section>
      </div>

      <ConfirmDialog
        open={confirmReset}
        onClose={() => setConfirmReset(false)}
        onConfirm={doReset}
        title="Reset settings"
        busy={busy}
        confirmLabel="Reset"
        message="This restores theme and startup behavior to their defaults."
      />
    </Page>
  );
}

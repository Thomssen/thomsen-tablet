import { useEffect, useState } from "react";
import { Card } from "@/components/ui/Card";
import { Button } from "@/components/ui/Button";
import { SegmentedControl } from "@/components/ui/SegmentedControl";
import { Field, TextInput } from "@/components/ui/Field";
import { Toggle } from "@/components/ui/Toggle";
import { Badge } from "@/components/ui/Badge";
import { useSettings } from "@/state/SettingsProvider";
import { useToast } from "@/components/ui/Toast";
import { errorMessage } from "@/services/ipc";
import { scanTablets } from "@/services/driver";
import { balancedFilters, competitiveFilters, ensureActiveProfile, rawFilters, saveProfile, smoothFilters, stableFilters } from "@/services/profiles";
import { getComputerName } from "@/services/system";
import { getAvailableMonitors, type MonitorInfo } from "@/services/window";
import { aspectRatioValue, effectiveSize, matchAspectRatio, ratiosMatch, simplifyRatio } from "@/lib/aspectRatio";
import { APP } from "@/config/app";
import type { FilterConfig, Profile, ScannedTablet, ThemeSetting, UsagePreset, WindowStyle } from "@/types";
import "./OnboardingWizard.css";

type FilterStyle = "raw" | "competitive" | "balanced" | "stable" | "smooth" | "custom";

const STEP_COUNT = 8;

const THEME_OPTIONS: { value: ThemeSetting; label: string }[] = [
  { value: "dark", label: "Dark" },
  { value: "light", label: "Light" },
  { value: "system", label: "System" },
];

const USAGE_CARDS: { value: UsagePreset; title: string; points: string[] }[] = [
  { value: "osu", title: "osu!", points: ["Absolute mode", "Prioritize low latency", "Match monitor aspect ratio", "Minimal filtering"] },
  { value: "drawing", title: "Drawing", points: ["Absolute mode", "Pressure activation kept off", "A touch of smoothing"] },
  { value: "general", title: "General use", points: ["Absolute mode", "Balanced, low-latency filtering"] },
  { value: "custom", title: "Custom", points: ["Nothing changed beyond what's needed to get started"] },
];

const FILTER_CARDS: { value: FilterStyle; title: string; points: string[] }[] = [
  { value: "raw", title: "Raw", points: ["Lowest processing", "Prioritizes responsiveness"] },
  { value: "competitive", title: "Competitive", points: ["Minimal filtering", "Focused on responsiveness"] },
  { value: "balanced", title: "Balanced", points: ["A small amount of stabilization", "Keeps latency low"] },
  { value: "stable", title: "Stable", points: ["More jitter reduction than Balanced", "Still suitable for fast gameplay"] },
  { value: "smooth", title: "Smooth", points: ["More stabilization", "For a steadier cursor feel"] },
  { value: "custom", title: "Custom later", points: ["Leaves the current filter settings alone"] },
];

function usageToFilterStyle(usage: UsagePreset): FilterStyle {
  if (usage === "osu") return "competitive";
  if (usage === "drawing") return "smooth";
  if (usage === "general") return "balanced";
  return "custom";
}

function filterStyleFilters(style: FilterStyle): FilterConfig[] | null {
  if (style === "raw") return rawFilters();
  if (style === "competitive") return competitiveFilters();
  if (style === "balanced") return balancedFilters();
  if (style === "stable") return stableFilters();
  if (style === "smooth") return smoothFilters();
  return null; // "custom later" - leave whatever's already there
}

/** Renders itself in place of the sidebar/content while
 * `settings.onboardingCompleted` is false - see `App.tsx`. Finishing calls
 * `update({ onboardingCompleted: true, ... })`, which flips that flag and
 * lets `App.tsx`'s own reactive render switch back to the normal app; no
 * separate "done" callback is needed for that to happen. */
export function OnboardingWizard() {
  const { settings, update } = useSettings();
  const toast = useToast();

  const [step, setStep] = useState(0);
  const [nameDraft, setNameDraft] = useState("");
  const [usageDraft, setUsageDraft] = useState<UsagePreset>("custom");
  const [optimizeOsu, setOptimizeOsu] = useState(true);
  const [filterStyleDraft, setFilterStyleDraft] = useState<FilterStyle>("balanced");
  const [filterStyleTouched, setFilterStyleTouched] = useState(false);

  const [tablet, setTablet] = useState<ScannedTablet | null>(null);
  const [tabletChecked, setTabletChecked] = useState(false);
  const [tabletBusy, setTabletBusy] = useState(false);
  const [monitors, setMonitors] = useState<MonitorInfo[]>([]);
  const [profile, setProfile] = useState<Profile | null>(null);
  const [computerName, setComputerName] = useState<string | null>(null);
  const [finishing, setFinishing] = useState(false);

  const refreshTablet = () => {
    setTabletBusy(true);
    void scanTablets()
      .then((found) => setTablet(found[0] ?? null))
      .catch(() => setTablet(null))
      .finally(() => {
        setTabletChecked(true);
        setTabletBusy(false);
      });
  };

  useEffect(() => {
    refreshTablet();
    void getAvailableMonitors().then(setMonitors).catch(() => setMonitors([]));
    void getComputerName().then(setComputerName).catch(() => setComputerName(null));
    void ensureActiveProfile()
      .then(setProfile)
      .catch(() => setProfile(null));
  }, []);

  // Picking a usage suggests a matching filter style for step 7, until the
  // user actually changes it themselves - after that, their choice sticks.
  useEffect(() => {
    if (!filterStyleTouched) setFilterStyleDraft(usageToFilterStyle(usageDraft));
  }, [usageDraft, filterStyleTouched]);

  const primaryMonitor = monitors[0] ?? null;
  const tabletBounds = tablet ? { width: tablet.widthMm, height: tablet.heightMm } : null;
  const currentRatioLabel = profile ? simplifyRatio(effectiveSize(profile.tabletArea).width, effectiveSize(profile.tabletArea).height) : "—";
  const monitorRatioLabel = primaryMonitor ? simplifyRatio(primaryMonitor.width, primaryMonitor.height) : "—";
  const aspectMatched =
    profile && primaryMonitor
      ? ratiosMatch(aspectRatioValue(effectiveSize(profile.tabletArea).width, effectiveSize(profile.tabletArea).height), aspectRatioValue(primaryMonitor.width, primaryMonitor.height))
      : false;

  const goNext = () => setStep((s) => Math.min(s + 1, STEP_COUNT - 1));
  const goBack = () => setStep((s) => Math.max(s - 1, 0));

  const finish = () =>
    (async () => {
      setFinishing(true);
      try {
        let nextProfile = profile ?? (await ensureActiveProfile());

        if (usageDraft !== "custom") {
          nextProfile = { ...nextProfile, inputMode: "absolute" };
        }

        const doOsuOptimize = usageDraft === "osu" && optimizeOsu;
        if (doOsuOptimize) {
          nextProfile = { ...nextProfile, filters: stableFilters() };
          if (primaryMonitor && tabletBounds) {
            const targetRatio = aspectRatioValue(primaryMonitor.width, primaryMonitor.height);
            nextProfile = { ...nextProfile, tabletArea: matchAspectRatio(nextProfile.tabletArea, targetRatio, tabletBounds) };
          }
        } else {
          const filters = filterStyleFilters(filterStyleDraft);
          if (filters) nextProfile = { ...nextProfile, filters };
        }

        if (doOsuOptimize || usageDraft !== "custom" || filterStyleFilters(filterStyleDraft)) {
          nextProfile = await saveProfile(nextProfile);
        }

        await update({
          displayName: nameDraft.trim() || null,
          usagePreset: usageDraft,
          onboardingCompleted: true,
        });
      } catch (e) {
        toast.error(errorMessage(e));
      } finally {
        setFinishing(false);
      }
    })();

  const skipName = () => {
    setNameDraft("");
    goNext();
  };

  return (
    <div className="onboarding">
      <div className="onboarding__panel">
        {step > 0 && (
          <div className="onboarding__progress">
            <span className="onboarding__step-label">
              Step {step + 1} of {STEP_COUNT}
            </span>
            <div className="onboarding__bar">
              <div className="onboarding__bar-fill" style={{ width: `${((step + 1) / STEP_COUNT) * 100}%` }} />
            </div>
          </div>
        )}

        <div className="onboarding__content">
          {step === 0 && <WelcomeStep onNext={goNext} />}
          {step === 1 && <AppearanceStep theme={settings.theme} onChange={(theme) => void update({ theme })} />}
          {step === 2 && <WindowStyleStep windowStyle={settings.windowStyle} onChange={(windowStyle) => void update({ windowStyle })} />}
          {step === 3 && <PersonalizationStep name={nameDraft} onNameChange={setNameDraft} computerName={computerName} />}
          {step === 4 && (
            <TabletSetupStep
              tablet={tablet}
              tabletChecked={tabletChecked}
              tabletBusy={tabletBusy}
              onRefresh={refreshTablet}
              monitor={primaryMonitor}
              inputMode={profile?.inputMode ?? "absolute"}
              aspectMatched={aspectMatched}
              currentRatioLabel={currentRatioLabel}
              monitorRatioLabel={monitorRatioLabel}
            />
          )}
          {step === 5 && <UsagePresetStep usage={usageDraft} onChange={setUsageDraft} optimizeOsu={optimizeOsu} onOptimizeOsuChange={setOptimizeOsu} />}
          {step === 6 && (
            <FilterPresetStep
              style={filterStyleDraft}
              onChange={(v) => {
                setFilterStyleDraft(v);
                setFilterStyleTouched(true);
              }}
              osuOptimizeActive={usageDraft === "osu" && optimizeOsu}
            />
          )}
          {step === 7 && (
            <ReviewStep
              theme={settings.theme}
              windowStyle={settings.windowStyle}
              name={nameDraft}
              tablet={tablet}
              inputMode={usageDraft === "custom" ? (profile?.inputMode ?? "absolute") : "absolute"}
              usage={usageDraft}
              filterStyle={usageDraft === "osu" && optimizeOsu ? null : filterStyleDraft}
              osuOptimizeActive={usageDraft === "osu" && optimizeOsu}
            />
          )}
        </div>

        {step > 0 && (
          <div className="onboarding__nav">
            <Button variant="ghost" onClick={goBack} disabled={finishing}>
              Back
            </Button>
            <div className="onboarding__nav-right">
              {step === 3 && (
                <Button variant="ghost" onClick={skipName}>
                  Skip
                </Button>
              )}
              {step < STEP_COUNT - 1 ? (
                <Button variant="primary" onClick={goNext}>
                  Continue
                </Button>
              ) : (
                <Button variant="primary" onClick={finish} loading={finishing}>
                  Finish Setup
                </Button>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

// -- Steps ----------------------------------------------------------------

function WelcomeStep({ onNext }: { onNext: () => void }) {
  return (
    <div className="onboarding__welcome">
      <span className="onboarding__logo" aria-hidden="true">
        T
      </span>
      <h1 className="onboarding__title">Welcome to {APP.name}</h1>
      <p className="onboarding__lead">Let's set up your tablet for osu! and personalize the basics before you get started.</p>
      <Button variant="primary" onClick={onNext}>
        Get Started
      </Button>
    </div>
  );
}

function AppearanceStep({ theme, onChange }: { theme: ThemeSetting; onChange: (t: ThemeSetting) => void }) {
  return (
    <div className="onboarding__step">
      <h2 className="onboarding__heading">Appearance</h2>
      <p className="onboarding__description">Choose how {APP.name} looks. This applies immediately, so you can see it before moving on.</p>
      <Card>
        <Field label="Theme">
          <SegmentedControl aria-label="Theme" options={THEME_OPTIONS} value={theme} onChange={onChange} />
        </Field>
        <div className="onboarding__preview onboarding__preview--theme">
          <div className="onboarding__preview-card">
            <div className="onboarding__preview-dot" />
            <div className="onboarding__preview-line onboarding__preview-line--title" />
            <div className="onboarding__preview-line" />
            <div className="onboarding__preview-line onboarding__preview-line--short" />
          </div>
          <p className="onboarding__preview-hint">{theme === "system" ? "Follows your Windows theme automatically." : `Always ${theme}, regardless of Windows.`}</p>
        </div>
      </Card>
    </div>
  );
}

function WindowStyleStep({ windowStyle, onChange }: { windowStyle: WindowStyle; onChange: (s: WindowStyle) => void }) {
  return (
    <div className="onboarding__step">
      <h2 className="onboarding__heading">Window button style</h2>
      <p className="onboarding__description">Pick how the title bar's window controls look. Check the top of this window - it's already updated.</p>
      <div className="onboarding__cards">
        <button type="button" className={["onboarding__card", windowStyle === "macos" ? "is-selected" : ""].filter(Boolean).join(" ")} onClick={() => onChange("macos")}>
          <div className="onboarding__winmock">
            <span className="onboarding__mockdot onboarding__mockdot--close" />
            <span className="onboarding__mockdot onboarding__mockdot--min" />
            <span className="onboarding__mockdot onboarding__mockdot--max" />
          </div>
          <span className="onboarding__card-title">macOS style</span>
          <span className="onboarding__card-hint">Colored traffic-light controls</span>
        </button>
        <button type="button" className={["onboarding__card", windowStyle === "windows" ? "is-selected" : ""].filter(Boolean).join(" ")} onClick={() => onChange("windows")}>
          <div className="onboarding__winmock onboarding__winmock--windows">
            <span className="onboarding__winmock-btn">─</span>
            <span className="onboarding__winmock-btn">□</span>
            <span className="onboarding__winmock-btn onboarding__winmock-btn--close">✕</span>
          </div>
          <span className="onboarding__card-title">Windows style</span>
          <span className="onboarding__card-hint">Minimize, maximize, close</span>
        </button>
      </div>
    </div>
  );
}

function PersonalizationStep({ name, onNameChange, computerName }: { name: string; onNameChange: (v: string) => void; computerName: string | null }) {
  return (
    <div className="onboarding__step">
      <h2 className="onboarding__heading">What should {APP.name} call you?</h2>
      <p className="onboarding__description">Optional - shown on the Dashboard greeting. You can change this anytime in Settings.</p>
      <Card>
        <Field label="Display name">
          <TextInput value={name} onChange={(e) => onNameChange(e.target.value)} placeholder="Thomsen" />
        </Field>
        {computerName && (
          <Button size="sm" variant="secondary" className="onboarding__use-pc-name" onClick={() => onNameChange(computerName)}>
            Use "{computerName}"
          </Button>
        )}
      </Card>
    </div>
  );
}

interface TabletSetupProps {
  tablet: ScannedTablet | null;
  tabletChecked: boolean;
  tabletBusy: boolean;
  onRefresh: () => void;
  monitor: MonitorInfo | null;
  inputMode: "absolute" | "relative";
  aspectMatched: boolean;
  currentRatioLabel: string;
  monitorRatioLabel: string;
}

function TabletSetupStep({ tablet, tabletChecked, tabletBusy, onRefresh, monitor, inputMode, aspectMatched, currentRatioLabel, monitorRatioLabel }: TabletSetupProps) {
  return (
    <div className="onboarding__step">
      <h2 className="onboarding__heading">Tablet setup</h2>
      <p className="onboarding__description">A quick look at what's connected right now, straight from the real detection system.</p>
      <Card>
        {!tablet && tabletChecked ? (
          <p className="onboarding__hint">No tablet detected. You can connect one later - everything here can be revisited from the Driver and Tablet Area pages.</p>
        ) : (
          <div className="onboarding__rows">
            <div className="onboarding__row">
              <span>Tablet</span>
              <span className="mono">{tablet ? tablet.name : "—"}</span>
            </div>
            <div className="onboarding__row">
              <span>Connection</span>
              <Badge tone={tablet ? "good" : "neutral"}>{tablet ? "Connected" : "Not connected"}</Badge>
            </div>
            <div className="onboarding__row">
              <span>Current monitor</span>
              <span className="mono">{monitor ? `${monitor.width} × ${monitor.height}` : "—"}</span>
            </div>
            <div className="onboarding__row">
              <span>Tablet mode</span>
              <span className="mono">{inputMode === "absolute" ? "Absolute" : "Relative"}</span>
            </div>
            <div className="onboarding__row">
              <span>Aspect ratio status</span>
              <Badge tone={aspectMatched ? "good" : "warn"}>{aspectMatched ? "Matched" : "Not matched"}</Badge>
            </div>
            {!aspectMatched && (
              <p className="onboarding__hint">
                Tablet area is {currentRatioLabel}, monitor is {monitorRatioLabel}. Choosing osu! in the next steps can fix this automatically, or adjust it later on the Tablet Area page.
              </p>
            )}
          </div>
        )}
        <Button size="sm" variant="secondary" onClick={onRefresh} loading={tabletBusy} className="onboarding__refresh">
          Refresh
        </Button>
      </Card>
    </div>
  );
}

function UsagePresetStep({
  usage,
  onChange,
  optimizeOsu,
  onOptimizeOsuChange,
}: {
  usage: UsagePreset;
  onChange: (v: UsagePreset) => void;
  optimizeOsu: boolean;
  onOptimizeOsuChange: (v: boolean) => void;
}) {
  return (
    <div className="onboarding__step">
      <h2 className="onboarding__heading">What will you mainly use your tablet for?</h2>
      <p className="onboarding__description">Just a sensible starting point - nothing here is locked in, and you can change every setting afterward.</p>
      <div className="onboarding__cards onboarding__cards--4">
        {USAGE_CARDS.map((c) => (
          <button key={c.value} type="button" className={["onboarding__card", usage === c.value ? "is-selected" : ""].filter(Boolean).join(" ")} onClick={() => onChange(c.value)}>
            <span className="onboarding__card-title">{c.title}</span>
            <ul className="onboarding__card-points">
              {c.points.map((p) => (
                <li key={p}>{p}</li>
              ))}
            </ul>
          </button>
        ))}
      </div>

      {usage === "osu" && (
        <Card className="onboarding__osu-card">
          <div className="onboarding__row">
            <div>
              <p className="onboarding__row-title">Optimize for osu!</p>
              <p className="onboarding__hint">
                Applies recommended starting settings: absolute mode, matching your monitor's aspect ratio, and minimal filtering for low latency. These are a starting point, not a claim
                that they're universally "the best" - you can change anything afterward.
              </p>
            </div>
            <Toggle checked={optimizeOsu} onChange={onOptimizeOsuChange} label="Optimize for osu!" />
          </div>
        </Card>
      )}
    </div>
  );
}

function FilterPresetStep({ style, onChange, osuOptimizeActive }: { style: FilterStyle; onChange: (v: FilterStyle) => void; osuOptimizeActive: boolean }) {
  return (
    <div className="onboarding__step">
      <h2 className="onboarding__heading">Choose an initial filter style</h2>
      <p className="onboarding__description">Reuses the same filters and presets from the Filters page - nothing new or hidden.</p>
      {osuOptimizeActive ? (
        <Card>
          <p className="onboarding__hint">
            "Optimize for osu!" is enabled from the previous step, which sets its own recommended filter configuration (the same "Stable" preset from the Filters page). Turn that off on
            the previous step to choose a filter style here instead.
          </p>
        </Card>
      ) : (
        <div className="onboarding__cards onboarding__cards--4">
          {FILTER_CARDS.map((c) => (
            <button key={c.value} type="button" className={["onboarding__card", style === c.value ? "is-selected" : ""].filter(Boolean).join(" ")} onClick={() => onChange(c.value)}>
              <span className="onboarding__card-title">{c.title}</span>
              <ul className="onboarding__card-points">
                {c.points.map((p) => (
                  <li key={p}>{p}</li>
                ))}
              </ul>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

interface ReviewProps {
  theme: ThemeSetting;
  windowStyle: WindowStyle;
  name: string;
  tablet: ScannedTablet | null;
  inputMode: "absolute" | "relative";
  usage: UsagePreset;
  filterStyle: FilterStyle | null;
  osuOptimizeActive: boolean;
}

const USAGE_LABELS: Record<UsagePreset, string> = { osu: "osu!", drawing: "Drawing", general: "General use", custom: "Custom" };
const FILTER_LABELS: Record<FilterStyle, string> = { raw: "Raw", competitive: "Competitive", balanced: "Balanced", stable: "Stable", smooth: "Smooth", custom: "Custom later" };

function ReviewStep({ theme, windowStyle, name, tablet, inputMode, usage, filterStyle, osuOptimizeActive }: ReviewProps) {
  return (
    <div className="onboarding__step">
      <h2 className="onboarding__heading">Your setup</h2>
      <p className="onboarding__description">Everything here can be changed later from Settings, the Filters page, or the Tablet Area page.</p>
      <Card>
        <div className="onboarding__rows">
          <div className="onboarding__row">
            <span>Theme</span>
            <span className="mono">{theme === "dark" ? "Dark" : theme === "light" ? "Light" : "System"}</span>
          </div>
          <div className="onboarding__row">
            <span>Window style</span>
            <span className="mono">{windowStyle === "macos" ? "macOS" : "Windows"}</span>
          </div>
          <div className="onboarding__row">
            <span>Name</span>
            <span className="mono">{name.trim() || "Not set"}</span>
          </div>
          <div className="onboarding__row">
            <span>Tablet</span>
            <span className="mono">{tablet ? tablet.name : "None detected"}</span>
          </div>
          <div className="onboarding__row">
            <span>Mode</span>
            <span className="mono">{inputMode === "absolute" ? "Absolute" : "Relative"}</span>
          </div>
          <div className="onboarding__row">
            <span>Usage</span>
            <span className="mono">
              {USAGE_LABELS[usage]}
              {osuOptimizeActive ? " (optimized)" : ""}
            </span>
          </div>
          <div className="onboarding__row">
            <span>Filter</span>
            <span className="mono">{osuOptimizeActive ? "Stable (osu! optimized)" : filterStyle ? FILTER_LABELS[filterStyle] : "—"}</span>
          </div>
        </div>
      </Card>
    </div>
  );
}

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";

import type { AppSettings } from "@/types";
import { getSettings, saveSettings } from "@/services/settings";
import { applyTheme, watchSystemTheme } from "./theme";

const FALLBACK: AppSettings = {
  theme: "dark",
  startWithWindows: false,
  minimizeToTray: false,
  startMinimized: false,
  checkForUpdates: true,
  windowStyle: "macos",
  displayName: null,
  usagePreset: "custom",
  onboardingCompleted: false,
  osuStablePath: null,
  osuLazerPath: null,
  autoSwitchOsuProfile: true,
  restoreProfileAfterOsuClose: true,
  preferredOsuVariant: null,
  sessionModeEnabled: true,
};

interface SettingsContextValue {
  settings: AppSettings;
  loading: boolean;
  /** Persist a partial change and update local state with the server's copy. */
  update: (patch: Partial<AppSettings>) => Promise<AppSettings>;
  reload: () => Promise<void>;
}

const SettingsContext = createContext<SettingsContextValue | null>(null);

export function SettingsProvider({ children }: { children: ReactNode }) {
  const [settings, setSettings] = useState<AppSettings>(FALLBACK);
  const [loading, setLoading] = useState(true);
  const stopWatch = useRef<() => void>(() => {});

  const reload = useCallback(async () => {
    try {
      const s = await getSettings();
      setSettings(s);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  // Keep <html data-theme> in step with the setting, following the OS when
  // the setting is "system".
  useEffect(() => {
    applyTheme(settings.theme);
    stopWatch.current();
    if (settings.theme === "system") {
      stopWatch.current = watchSystemTheme(() => applyTheme("system"));
    } else {
      stopWatch.current = () => {};
    }
    return () => stopWatch.current();
  }, [settings.theme]);

  const update = useCallback(
    async (patch: Partial<AppSettings>) => {
      const next = await saveSettings({ ...settings, ...patch });
      setSettings(next);
      return next;
    },
    [settings],
  );

  const value = useMemo<SettingsContextValue>(
    () => ({ settings, loading, update, reload }),
    [settings, loading, update, reload],
  );

  return <SettingsContext.Provider value={value}>{children}</SettingsContext.Provider>;
}

export function useSettings(): SettingsContextValue {
  const ctx = useContext(SettingsContext);
  if (!ctx) throw new Error("useSettings must be used within <SettingsProvider>");
  return ctx;
}

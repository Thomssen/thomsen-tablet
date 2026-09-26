import { useEffect, useState } from "react";
import { TitleBar } from "@/components/TitleBar/TitleBar";
import { Sidebar } from "@/components/Sidebar/Sidebar";
import { RouteView } from "@/app/RouteView";
import { OnboardingWizard } from "@/pages/onboarding/OnboardingWizard";
import { useSettings } from "@/state/SettingsProvider";
import { getAppInfo } from "@/services/system";
import "@/styles/app.css";

/** The frameless window shell: title bar on top, sidebar + content below -
 * or, before first-run setup has been completed (or after "Run Setup
 * Again"), the onboarding wizard in place of the sidebar/content, still
 * under the same title bar so window controls keep working. */
export default function App() {
  const { settings, loading } = useSettings();
  const [warnings, setWarnings] = useState<string[]>([]);
  const [dismissed, setDismissed] = useState(false);

  useEffect(() => {
    void getAppInfo()
      .then((info) => setWarnings(info.loadWarnings))
      .catch(() => {});
  }, []);

  // Settings (including onboardingCompleted) haven't loaded from disk yet -
  // render just the shell rather than flashing the wizard or the main app
  // based on the fallback default.
  if (loading) {
    return (
      <div className="app">
        <TitleBar />
        <div className="app__body" />
      </div>
    );
  }

  if (!settings.onboardingCompleted) {
    return (
      <div className="app">
        <TitleBar />
        <OnboardingWizard />
      </div>
    );
  }

  return (
    <div className="app">
      <TitleBar />
      <div className="app__body">
        <Sidebar />
        <main className="app__main">
          {warnings.length > 0 && !dismissed && (
            <div className="app__notice" role="status">
              <span>Some stored settings could not be read: {warnings.join("; ")}. Defaults were used instead.</span>
              <button type="button" onClick={() => setDismissed(true)}>
                Dismiss
              </button>
            </div>
          )}
          <RouteView />
        </main>
      </div>
    </div>
  );
}

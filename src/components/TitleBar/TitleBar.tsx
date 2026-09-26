import { useEffect, useState } from "react";
import { APP } from "@/config/app";
import { ROUTE_LABELS } from "@/config/navigation";
import { useNavigation } from "@/state/NavigationProvider";
import { useSettings } from "@/state/SettingsProvider";
import { MinimizeIcon, MaximizeIcon, RestoreIcon, CloseIcon } from "@/components/icons";
import { closeWindow, isWindowMaximized, minimizeWindow, onMaximizeChange, toggleMaximizeWindow } from "@/services/window";
import "./TitleBar.css";

function MacosControls({ maximized }: { maximized: boolean }) {
  return (
    <div className="titlebar__controls titlebar__controls--macos">
      <button type="button" className="titlebar__btn titlebar__btn--close" aria-label="Close" onClick={closeWindow}>
        <CloseIcon size={8} />
      </button>
      <button type="button" className="titlebar__btn titlebar__btn--minimize" aria-label="Minimize" onClick={minimizeWindow}>
        <MinimizeIcon size={8} />
      </button>
      <button type="button" className="titlebar__btn titlebar__btn--maximize" aria-label={maximized ? "Restore" : "Maximize"} onClick={toggleMaximizeWindow}>
        {maximized ? <RestoreIcon size={8} /> : <MaximizeIcon size={8} />}
      </button>
    </div>
  );
}

function WindowsControls({ maximized }: { maximized: boolean }) {
  return (
    <div className="titlebar__controls titlebar__controls--windows">
      <button type="button" className="titlebar__winbtn" aria-label="Minimize" onClick={minimizeWindow}>
        <MinimizeIcon size={10} />
      </button>
      <button type="button" className="titlebar__winbtn" aria-label={maximized ? "Restore" : "Maximize"} onClick={toggleMaximizeWindow}>
        {maximized ? <RestoreIcon size={10} /> : <MaximizeIcon size={10} />}
      </button>
      <button type="button" className="titlebar__winbtn titlebar__winbtn--close" aria-label="Close" onClick={closeWindow}>
        <CloseIcon size={10} />
      </button>
    </div>
  );
}

/**
 * Custom frameless title bar. The whole bar is a drag region; the controls
 * opt out. Double-click toggles maximize, as on native Windows. The button
 * style (macOS traffic lights vs a Windows-style rectangular cluster) is a
 * purely cosmetic choice from Settings/onboarding - both drive the exact
 * same window commands.
 */
export function TitleBar() {
  const { route } = useNavigation();
  const { settings } = useSettings();
  const [maximized, setMaximized] = useState(false);

  useEffect(() => {
    void isWindowMaximized().then(setMaximized);
    const unsub = onMaximizeChange(setMaximized);
    return () => {
      void unsub.then((fn) => fn());
    };
  }, []);

  return (
    <div className={["titlebar", settings.windowStyle === "windows" ? "titlebar--windows" : ""].filter(Boolean).join(" ")} data-tauri-drag-region onDoubleClick={toggleMaximizeWindow}>
      <div className="titlebar__label" data-tauri-drag-region>
        {APP.name}
        <span className="titlebar__sep">/</span>
        <span className="titlebar__route">{ROUTE_LABELS[route]}</span>
      </div>

      {settings.windowStyle === "windows" ? <WindowsControls maximized={maximized} /> : <MacosControls maximized={maximized} />}
    </div>
  );
}

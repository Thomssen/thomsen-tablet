import React from "react";
import ReactDOM from "react-dom/client";

import "@fontsource-variable/inter";
import "@/styles/tokens.css";
import "@/styles/base.css";

import App from "@/App";
import { SettingsProvider } from "@/state/SettingsProvider";
import { NavigationProvider } from "@/state/NavigationProvider";
import { ToastProvider } from "@/components/ui/Toast";

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <SettingsProvider>
      <ToastProvider>
        <NavigationProvider>
          <App />
        </NavigationProvider>
      </ToastProvider>
    </SettingsProvider>
  </React.StrictMode>,
);

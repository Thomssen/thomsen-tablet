import { useNavigation } from "@/state/NavigationProvider";
import { ErrorBoundary } from "@/components/ErrorBoundary";
import { DashboardPage } from "@/pages/DashboardPage";
import { OptimizerPage } from "@/pages/OptimizerPage";
import { TabletAreaPage } from "@/pages/TabletAreaPage";
import { FiltersPage } from "@/pages/FiltersPage";
import { InputLabPage } from "@/pages/InputLabPage";
import { ProfilesPage } from "@/pages/ProfilesPage";
import { PerformancePage } from "@/pages/PerformancePage";
import { SettingsPage } from "@/pages/SettingsPage";

export function RouteView() {
  const { route } = useNavigation();

  return (
    <ErrorBoundary resetKey={route}>
      <div className="routeview" key={route}>
        {route === "dashboard" && <DashboardPage />}
        {route === "optimizer" && <OptimizerPage />}
        {route === "tablet-area" && <TabletAreaPage />}
        {route === "filters" && <FiltersPage />}
        {route === "calibration" && <InputLabPage />}
        {route === "profiles" && <ProfilesPage />}
        {route === "diagnostics" && <PerformancePage />}
        {route === "settings" && <SettingsPage />}
      </div>
    </ErrorBoundary>
  );
}

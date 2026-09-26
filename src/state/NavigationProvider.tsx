/**
 * A tiny router. One active `Route` at a time. Dependency-free by design.
 */

import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from "react";

import { DEFAULT_ROUTE, type Route } from "@/config/navigation";

interface NavigationContextValue {
  route: Route;
  navigate: (route: Route) => void;
}

const NavigationContext = createContext<NavigationContextValue | null>(null);

export function NavigationProvider({ children }: { children: ReactNode }) {
  const [route, setRoute] = useState<Route>(DEFAULT_ROUTE);

  const navigate = useCallback((next: Route) => {
    setRoute((current) => (next === current ? current : next));
  }, []);

  const value = useMemo(() => ({ route, navigate }), [route, navigate]);

  return <NavigationContext.Provider value={value}>{children}</NavigationContext.Provider>;
}

export function useNavigation(): NavigationContextValue {
  const ctx = useContext(NavigationContext);
  if (!ctx) throw new Error("useNavigation must be used within <NavigationProvider>");
  return ctx;
}

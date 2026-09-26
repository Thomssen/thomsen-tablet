import { APP } from "@/config/app";
import { NAV_GROUPS, SETTINGS_ITEM, type Route } from "@/config/navigation";
import { useNavigation } from "@/state/NavigationProvider";
import "./Sidebar.css";

export function Sidebar() {
  const { route, navigate } = useNavigation();

  const linkClass = (r: Route) => ["sidebar__link", route === r ? "is-active" : ""].filter(Boolean).join(" ");

  return (
    <aside className="sidebar">
      <div className="sidebar__brand">
        <span className="sidebar__mark" aria-hidden="true">
          T
        </span>
        <span className="sidebar__wordmark">{APP.brand}</span>
      </div>

      <nav className="sidebar__nav" aria-label="Primary">
        {NAV_GROUPS.map((group, gi) => (
          <div className="sidebar__group" key={gi}>
            {group.map((item) => (
              <button key={item.route} type="button" className={linkClass(item.route)} aria-current={route === item.route ? "page" : undefined} onClick={() => navigate(item.route)}>
                {item.label}
              </button>
            ))}
          </div>
        ))}
      </nav>

      <div className="sidebar__footer">
        <button type="button" className={linkClass(SETTINGS_ITEM.route)} aria-current={route === "settings" ? "page" : undefined} onClick={() => navigate(SETTINGS_ITEM.route)}>
          {SETTINGS_ITEM.label}
        </button>
        <span className="sidebar__version">v{APP.version}</span>
      </div>
    </aside>
  );
}

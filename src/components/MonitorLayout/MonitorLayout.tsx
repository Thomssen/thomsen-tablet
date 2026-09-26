import type { MonitorInfo } from "@/services/window";
import "./MonitorLayout.css";

interface MonitorLayoutProps {
  monitors: MonitorInfo[];
  selectedIndex: number;
  onSelect: (index: number) => void;
  renderWidth?: number;
}

/**
 * A to-scale diagram of every connected monitor's real position in the
 * virtual desktop, with the selected one highlighted - so multi-monitor
 * setups are visible, not just a name in a dropdown.
 */
export function MonitorLayout({ monitors, selectedIndex, onSelect, renderWidth = 260 }: MonitorLayoutProps) {
  if (monitors.length === 0) {
    return <div className="monitor-layout monitor-layout--empty">No monitors detected</div>;
  }

  const minX = Math.min(...monitors.map((m) => m.x));
  const minY = Math.min(...monitors.map((m) => m.y));
  const maxX = Math.max(...monitors.map((m) => m.x + m.width));
  const maxY = Math.max(...monitors.map((m) => m.y + m.height));
  const spanW = maxX - minX;
  const spanH = maxY - minY;
  const scale = renderWidth / spanW;
  const renderHeight = spanH * scale;

  return (
    <div className="monitor-layout" style={{ width: renderWidth, height: renderHeight }}>
      {monitors.map((m, i) => (
        <button
          type="button"
          key={`${m.name}-${i}`}
          className={["monitor-layout__monitor", i === selectedIndex ? "is-selected" : ""].filter(Boolean).join(" ")}
          style={{
            left: (m.x - minX) * scale,
            top: (m.y - minY) * scale,
            width: m.width * scale,
            height: m.height * scale,
          }}
          onClick={() => onSelect(i)}
          title={`${m.name} - ${m.width}×${m.height}`}
        >
          {i + 1}
        </button>
      ))}
    </div>
  );
}

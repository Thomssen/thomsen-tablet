import { Card, CardHeader } from "@/components/ui/Card";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { aspectRatioValue, effectiveSize, matchAspectRatio, ratiosMatch, simplifyRatio } from "@/lib/aspectRatio";
import type { Area } from "@/types";
import "./AspectRatioCheck.css";

interface MonitorSize {
  width: number;
  height: number;
}

interface AspectRatioCheckProps {
  tabletArea: Area;
  /** The physical tablet surface - needed to clamp the "match" result. */
  tabletBounds: { width: number; height: number } | null;
  monitor: MonitorSize | null;
  onMatch: (next: Area) => void;
}

function ShapePreview({ label, width, height, variant }: { label: string; width: number; height: number; variant: "monitor" | "tablet" }) {
  const REF = 64;
  const valid = width > 0 && height > 0;
  const scale = valid ? REF / Math.max(width, height) : 0;
  return (
    <div className="aspect-check__shape">
      <div className="aspect-check__shape-box">
        {valid && (
          <div
            className={["aspect-check__shape-rect", `aspect-check__shape-rect--${variant}`].join(" ")}
            style={{ width: Math.max(width * scale, 4), height: Math.max(height * scale, 4) }}
          />
        )}
      </div>
      <span className="aspect-check__shape-label">{label}</span>
    </div>
  );
}

/**
 * Compares the active tablet area's shape against the selected monitor's
 * shape and, when they differ, offers a one-click fix. Pure display +
 * a callback - persistence is the same profile save the rest of the
 * Tablet Area page already uses.
 */
export function AspectRatioCheck({ tabletArea, tabletBounds, monitor, onMatch }: AspectRatioCheckProps) {
  const tabletEffective = effectiveSize(tabletArea);
  const tabletRatio = aspectRatioValue(tabletEffective.width, tabletEffective.height);
  const tabletLabel = simplifyRatio(tabletEffective.width, tabletEffective.height);

  const monitorRatio = monitor ? aspectRatioValue(monitor.width, monitor.height) : 0;
  const monitorLabel = monitor ? simplifyRatio(monitor.width, monitor.height) : "—";

  const matched = monitor !== null && ratiosMatch(tabletRatio, monitorRatio);

  const handleMatch = () => {
    if (!monitor || !tabletBounds) return;
    onMatch(matchAspectRatio(tabletArea, monitorRatio, tabletBounds));
  };

  return (
    <Card>
      <CardHeader
        title="Aspect Ratio"
        description="Whether your tablet area's shape matches your monitor's - a mismatch stretches movement unevenly between the two axes."
        actions={monitor ? <Badge tone={matched ? "good" : "warn"}>{matched ? "Aspect Ratio Matched" : "Aspect Ratio Mismatch"}</Badge> : undefined}
      />
      <div className="aspect-check">
        <div className="aspect-check__shapes">
          <ShapePreview label="Monitor" width={monitor?.width ?? 0} height={monitor?.height ?? 0} variant="monitor" />
          <span className="aspect-check__vs">vs</span>
          <ShapePreview label="Tablet Area" width={tabletEffective.width} height={tabletEffective.height} variant="tablet" />
        </div>
        <div className="aspect-check__values">
          <div className="aspect-check__row">
            <span className="aspect-check__label">Monitor</span>
            <span className="aspect-check__value mono">{monitorLabel}</span>
          </div>
          <div className="aspect-check__row">
            <span className="aspect-check__label">Tablet area</span>
            <span className="aspect-check__value mono">{tabletLabel}</span>
          </div>
        </div>
      </div>

      {!monitor && <p className="aspect-check__hint aspect-check__hint--standalone">Select a monitor above to compare aspect ratios.</p>}

      {monitor && !matched && (
        <>
          <div className="rule aspect-check__rule" />
          <div className="aspect-check__action">
            <p className="aspect-check__hint">Adjusts your tablet area's width or height - whichever changes less - to match your monitor's shape, without moving its center.</p>
            <Button size="sm" variant="secondary" onClick={handleMatch}>
              Match Monitor Aspect Ratio
            </Button>
          </div>
        </>
      )}
    </Card>
  );
}

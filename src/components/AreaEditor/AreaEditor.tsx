import { useCallback, useRef } from "react";
import type { Area } from "@/types";
import "./AreaEditor.css";

interface Bounds {
  width: number;
  height: number;
}

interface AreaEditorProps {
  /** The full outer surface this area lives within (tablet mm, or a monitor's pixels). */
  bounds: Bounds;
  value: Area;
  onChange: (next: Area) => void;
  lockAspectRatio?: boolean;
  /** The ratio to hold width:height to while locked (e.g. the selected
   * monitor's width/height). Falls back to the area's own ratio at the
   * moment a drag starts if omitted, so existing callers keep working. */
  aspectRatio?: number;
  minSize?: number;
  /** Rendered width in CSS pixels; height follows the bounds aspect ratio. */
  renderWidth?: number;
}

type DragMode = { kind: "move" } | { kind: "resize"; top?: boolean; bottom?: boolean; left?: boolean; right?: boolean };

interface DragState {
  mode: DragMode;
  startClientX: number;
  startClientY: number;
  startValue: Area;
  scale: number;
}

const CORNER_HANDLES: { key: string; mode: DragMode; cursor: string; style: React.CSSProperties }[] = [
  { key: "nw", mode: { kind: "resize", top: true, left: true }, cursor: "nwse-resize", style: { top: 0, left: 0, transform: "translate(-50%, -50%)" } },
  { key: "ne", mode: { kind: "resize", top: true, right: true }, cursor: "nesw-resize", style: { top: 0, right: 0, transform: "translate(50%, -50%)" } },
  { key: "sw", mode: { kind: "resize", bottom: true, left: true }, cursor: "nesw-resize", style: { bottom: 0, left: 0, transform: "translate(-50%, 50%)" } },
  { key: "se", mode: { kind: "resize", bottom: true, right: true }, cursor: "nwse-resize", style: { bottom: 0, right: 0, transform: "translate(50%, 50%)" } },
];

const EDGE_HANDLES: { key: string; mode: DragMode; cursor: string; style: React.CSSProperties }[] = [
  { key: "n", mode: { kind: "resize", top: true }, cursor: "ns-resize", style: { top: 0, left: "50%", transform: "translate(-50%, -50%)" } },
  { key: "s", mode: { kind: "resize", bottom: true }, cursor: "ns-resize", style: { bottom: 0, left: "50%", transform: "translate(-50%, 50%)" } },
  { key: "w", mode: { kind: "resize", left: true }, cursor: "ew-resize", style: { left: 0, top: "50%", transform: "translate(-50%, -50%)" } },
  { key: "e", mode: { kind: "resize", right: true }, cursor: "ew-resize", style: { right: 0, top: "50%", transform: "translate(50%, -50%)" } },
];

const clamp = (v: number, lo: number, hi: number) => Math.min(Math.max(v, lo), hi);

/**
 * A draggable, resizable rectangle (`value`) within a fixed outer surface
 * (`bounds`). Used for both the tablet's active area (bounds = physical
 * tablet size, mm) and a display's mapped region (bounds = a monitor's
 * pixel size) - the math is unit-agnostic, same as `thomsen-tablet-core`'s
 * own `Area`/`map_point`.
 *
 * Corner handles always resize both dimensions; edge handles resize one
 * dimension and are hidden when `lockAspectRatio` is on, since a
 * single-axis resize can't honor a locked ratio unambiguously.
 */
export function AreaEditor({ bounds, value, onChange, lockAspectRatio = false, aspectRatio, minSize = 2, renderWidth = 420 }: AreaEditorProps) {
  const dragRef = useRef<DragState | null>(null);
  const scale = renderWidth / bounds.width;
  const renderHeight = renderWidth * (bounds.height / bounds.width);

  const onPointerMove = useCallback(
    (e: PointerEvent) => {
      const drag = dragRef.current;
      if (!drag) return;
      const dx = (e.clientX - drag.startClientX) / drag.scale;
      const dy = (e.clientY - drag.startClientY) / drag.scale;

      if (drag.mode.kind === "move") {
        const halfW = drag.startValue.width / 2;
        const halfH = drag.startValue.height / 2;
        onChange({
          ...drag.startValue,
          x: clamp(drag.startValue.x + dx, halfW, bounds.width - halfW),
          y: clamp(drag.startValue.y + dy, halfH, bounds.height - halfH),
        });
        return;
      }

      let left = drag.startValue.x - drag.startValue.width / 2;
      let right = drag.startValue.x + drag.startValue.width / 2;
      let top = drag.startValue.y - drag.startValue.height / 2;
      let bottom = drag.startValue.y + drag.startValue.height / 2;

      if (drag.mode.right) right = clamp(right + dx, left + minSize, bounds.width);
      if (drag.mode.left) left = clamp(left + dx, 0, right - minSize);
      if (drag.mode.bottom) bottom = clamp(bottom + dy, top + minSize, bounds.height);
      if (drag.mode.top) top = clamp(top + dy, 0, bottom - minSize);

      if (lockAspectRatio) {
        const targetAspect = aspectRatio ?? drag.startValue.width / drag.startValue.height;

        // Only corner handles exist while locked, so exactly one horizontal
        // and one vertical edge are moving; the opposite pair is the fixed
        // anchor. Deriving both candidate sizes from the ratio and taking
        // whichever fits - rather than clamping height alone after the fact
        // - is what keeps the ratio exact even when the drag nears the
        // surface's edge (a plain post-hoc clamp would silently distort it).
        const anchorX = drag.mode.left ? right : left;
        const anchorY = drag.mode.top ? bottom : top;
        const maxWidthFromAnchor = drag.mode.left ? anchorX : bounds.width - anchorX;
        const maxHeightFromAnchor = drag.mode.top ? anchorY : bounds.height - anchorY;
        const rawWidth = Math.abs(right - left);

        let newWidth = Math.min(rawWidth, maxWidthFromAnchor, maxHeightFromAnchor * targetAspect);
        newWidth = Math.max(newWidth, minSize);
        const newHeight = Math.max(newWidth / targetAspect, minSize / targetAspect);

        if (drag.mode.left) left = right - newWidth;
        else right = left + newWidth;
        if (drag.mode.top) top = bottom - newHeight;
        else bottom = top + newHeight;
      }

      onChange({ width: right - left, height: bottom - top, x: (left + right) / 2, y: (top + bottom) / 2, rotation: drag.startValue.rotation });
    },
    [bounds, lockAspectRatio, aspectRatio, minSize, onChange],
  );

  const endDrag = useCallback(() => {
    dragRef.current = null;
    window.removeEventListener("pointermove", onPointerMove);
    window.removeEventListener("pointerup", endDrag);
  }, [onPointerMove]);

  const startDrag = (mode: DragMode) => (e: React.PointerEvent) => {
    e.preventDefault();
    e.stopPropagation();
    dragRef.current = { mode, startClientX: e.clientX, startClientY: e.clientY, startValue: value, scale };
    window.addEventListener("pointermove", onPointerMove);
    window.addEventListener("pointerup", endDrag);
  };

  const handles = lockAspectRatio ? CORNER_HANDLES : [...CORNER_HANDLES, ...EDGE_HANDLES];

  return (
    <div className="area-editor" style={{ width: renderWidth, height: renderHeight }}>
      <div
        className="area-editor__value"
        style={{
          left: (value.x - value.width / 2) * scale,
          top: (value.y - value.height / 2) * scale,
          width: value.width * scale,
          height: value.height * scale,
          transform: `rotate(${value.rotation}deg)`,
        }}
        onPointerDown={startDrag({ kind: "move" })}
      >
        {handles.map((h) => (
          <div key={h.key} className="area-editor__handle" style={{ ...h.style, cursor: h.cursor }} onPointerDown={startDrag(h.mode)} />
        ))}
      </div>
    </div>
  );
}

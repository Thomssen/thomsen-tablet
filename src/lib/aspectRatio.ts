import type { Area } from "@/types";

/**
 * Common video/monitor aspect ratios, checked before falling back to a
 * general best-fit search - so a 16:9 monitor reads "16:9", not "1.78:1"
 * or an equally-valid but unconventional reduction like "8:5" for 16:10.
 */
const COMMON_RATIOS: readonly (readonly [number, number])[] = [
  [1, 1],
  [5, 4],
  [4, 3],
  [3, 2],
  [16, 10],
  [16, 9],
  [21, 9],
  [32, 9],
  [4, 5],
  [3, 4],
  [2, 3],
  [10, 16],
  [9, 16],
  [9, 21],
  [9, 32],
];

const COMMON_RATIO_TOLERANCE = 0.008;

function gcd(a: number, b: number): number {
  a = Math.round(Math.abs(a));
  b = Math.round(Math.abs(b));
  while (b) [a, b] = [b, a % b];
  return a || 1;
}

/** A short, human label for a width:height ratio, e.g. "16:9" or "4:3". */
export function simplifyRatio(width: number, height: number): string {
  if (!(width > 0) || !(height > 0)) return "—";
  const ratio = width / height;

  let best: { num: number; den: number; diff: number } | null = null;
  for (const [num, den] of COMMON_RATIOS) {
    const diff = Math.abs(num / den - ratio);
    if (diff < COMMON_RATIO_TOLERANCE && (!best || diff < best.diff)) best = { num, den, diff };
  }
  if (best) return `${best.num}:${best.den}`;

  let bestNum = 1;
  let bestDen = 1;
  let bestDiff = Infinity;
  for (let den = 1; den <= 32; den++) {
    const num = Math.round(ratio * den);
    if (num < 1) continue;
    const diff = Math.abs(num / den - ratio);
    if (diff < bestDiff) {
      bestDiff = diff;
      bestNum = num;
      bestDen = den;
    }
  }
  const g = gcd(bestNum, bestDen);
  return `${bestNum / g}:${bestDen / g}`;
}

/**
 * The width/height a rotated rectangle actually occupies on screen (its
 * axis-aligned bounding box) - what a shape comparison needs, not the
 * rectangle's own unrotated width/height. `rotation` is in degrees. At 0/180°
 * this is just {width, height}; at 90°/270° it's the swapped {height, width};
 * in between it's the standard rotated-rect bounding box formula.
 */
export function effectiveSize(area: Pick<Area, "width" | "height" | "rotation">): { width: number; height: number } {
  const rad = (area.rotation * Math.PI) / 180;
  const c = Math.abs(Math.cos(rad));
  const s = Math.abs(Math.sin(rad));
  return {
    width: area.width * c + area.height * s,
    height: area.width * s + area.height * c,
  };
}

export function aspectRatioValue(width: number, height: number): number {
  return height > 0 && width > 0 ? width / height : 0;
}

/** Whether two aspect ratios are close enough to call "matched" - a little
 * slack for mm/px rounding, not for genuinely different shapes. */
export function ratiosMatch(a: number, b: number, tolerance = 0.02): boolean {
  if (!(a > 0) || !(b > 0)) return false;
  return Math.abs(a - b) / b <= tolerance;
}

/**
 * Scales `width`/`height` down (preserving their ratio) if needed so they
 * fit within `bounds`, and re-clamps the center point so the box stays
 * fully inside. Used anywhere an aspect-ratio-driven resize could otherwise
 * push the area past the physical tablet surface.
 */
export function fitWithinBounds(
  width: number,
  height: number,
  x: number,
  y: number,
  bounds: { width: number; height: number },
): { width: number; height: number; x: number; y: number } {
  const scale = Math.min(1, bounds.width / width, bounds.height / height);
  const w = width * scale;
  const h = height * scale;
  const halfW = w / 2;
  const halfH = h / 2;
  return {
    width: w,
    height: h,
    x: Math.min(Math.max(x, halfW), Math.max(halfW, bounds.width - halfW)),
    y: Math.min(Math.max(y, halfH), Math.max(halfH, bounds.height - halfH)),
  };
}

/**
 * Adjusts `area`'s width or height - whichever changes proportionally less -
 * so its effective (rotation-aware) aspect ratio matches `targetRatio`,
 * keeping the same center point and clamping to `bounds` if the result
 * would otherwise overflow the physical tablet surface.
 */
export function matchAspectRatio(area: Area, targetRatio: number, bounds: { width: number; height: number }): Area {
  if (!(targetRatio > 0) || !(area.width > 0) || !(area.height > 0)) return area;

  const rad = (area.rotation * Math.PI) / 180;
  const c = Math.abs(Math.cos(rad));
  const s = Math.abs(Math.sin(rad));

  // Rotated bounding box: bboxW = w*c + h*s, bboxH = w*s + h*c. Solve for
  // the width (holding height fixed) or height (holding width fixed) that
  // makes bboxW/bboxH equal targetRatio. At rotation 0 these reduce to the
  // obvious width = height*ratio / height = width/ratio.
  const denomW = c - targetRatio * s;
  const denomH = s - targetRatio * c;
  const candidateWidth = Math.abs(denomW) > 1e-6 ? (area.height * (targetRatio * c - s)) / denomW : area.height * targetRatio;
  const candidateHeight = Math.abs(denomH) > 1e-6 ? (area.width * (targetRatio * s - c)) / denomH : area.width / targetRatio;

  const relDeltaW = Math.abs(candidateWidth - area.width) / area.width;
  const relDeltaH = Math.abs(candidateHeight - area.height) / area.height;

  let width = area.width;
  let height = area.height;
  if (candidateWidth > 0 && (!(candidateHeight > 0) || relDeltaW <= relDeltaH)) {
    width = candidateWidth;
  } else if (candidateHeight > 0) {
    height = candidateHeight;
  }

  // Clamp to the physical surface, preserving the ratio just achieved.
  const eff = effectiveSize({ width, height, rotation: area.rotation });
  const scale = Math.min(1, bounds.width / eff.width, bounds.height / eff.height);
  if (scale < 1) {
    width *= scale;
    height *= scale;
  }

  const halfW = width / 2;
  const halfH = height / 2;
  const x = Math.min(Math.max(area.x, halfW), Math.max(halfW, bounds.width - halfW));
  const y = Math.min(Math.max(area.y, halfH), Math.max(halfH, bounds.height - halfH));

  return { ...area, width, height, x, y };
}

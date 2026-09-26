//! Tablet-area geometry and the coordinate transform pipeline.
//!
//! Everything here is unit-agnostic and hardware-agnostic: [`Area`] is used
//! both for a tablet's active area (millimeters) and a display's mapped
//! region (pixels). That's deliberate - it's what makes this whole module
//! fully unit-testable without a physical tablet. Only `thomsen-tablet-devices`
//! needs real hardware to verify.

use serde::{Deserialize, Serialize};

/// A rectangular area described by its **center** (`x`, `y`) and size
/// (`width`, `height`) - matching how tablet software conventionally models
/// an active area (OpenTabletDriver's `settings.json` uses this same
/// center-based shape). `rotation` is degrees, clockwise, around the area's
/// own center.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Area {
    pub width: f64,
    pub height: f64,
    pub x: f64,
    pub y: f64,
    pub rotation: f64,
}

impl Area {
    /// An unrotated area exactly covering `width` x `height`, centered.
    pub fn full(width: f64, height: f64) -> Self {
        Area { width, height, x: width / 2.0, y: height / 2.0, rotation: 0.0 }
    }

    pub fn left(&self) -> f64 {
        self.x - self.width / 2.0
    }
    pub fn top(&self) -> f64 {
        self.y - self.height / 2.0
    }
    pub fn right(&self) -> f64 {
        self.x + self.width / 2.0
    }
    pub fn bottom(&self) -> f64 {
        self.y + self.height / 2.0
    }

    /// Whether `p` falls within this area's bounds, ignoring rotation - used
    /// for area-limiting/clamping decisions, not for the mapping itself.
    pub fn contains(&self, p: Point) -> bool {
        p.x >= self.left() && p.x <= self.right() && p.y >= self.top() && p.y <= self.bottom()
    }
}

/// A point in some coordinate space - device units, millimeters, or pixels,
/// depending on context.
#[derive(Debug, Clone, Copy, PartialEq, Serialize)]
pub struct Point {
    pub x: f64,
    pub y: f64,
}

/// Maps a raw point measured in `source_area`'s coordinate space (e.g. a
/// tablet's configured active area, in millimeters) into `target_area`'s
/// space (e.g. the mapped screen region, in pixels).
///
/// Points outside the active area are still mapped, not clamped -
/// OpenTabletDriver calls clamping "area limiting" and makes it optional, so
/// that choice is left to the caller via [`Area::contains`].
pub fn map_point(raw: Point, source_area: &Area, target_area: &Area) -> Point {
    // Undo the source area's own rotation so the rest of the math can treat
    // it as an axis-aligned rectangle.
    let local = rotate_around(raw, Point { x: source_area.x, y: source_area.y }, -source_area.rotation);

    let norm_x = (local.x - source_area.left()) / source_area.width;
    let norm_y = (local.y - source_area.top()) / source_area.height;

    let mapped = Point {
        x: target_area.left() + norm_x * target_area.width,
        y: target_area.top() + norm_y * target_area.height,
    };

    // Then apply the target area's own rotation on the way out.
    rotate_around(mapped, Point { x: target_area.x, y: target_area.y }, target_area.rotation)
}

/// Rotates `p` by `degrees` clockwise around `center`, in a Y-down
/// coordinate system (screen/tablet convention: origin top-left, Y grows
/// downward) - verified by `rotating_90_clockwise_moves_top_to_right` below,
/// since "clockwise" flips meaning depending on which way Y points.
fn rotate_around(p: Point, center: Point, degrees: f64) -> Point {
    if degrees == 0.0 {
        return p;
    }
    let rad = degrees.to_radians();
    let (sin, cos) = rad.sin_cos();
    let dx = p.x - center.x;
    let dy = p.y - center.y;
    Point {
        x: center.x + dx * cos - dy * sin,
        y: center.y + dx * sin + dy * cos,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn approx_eq(a: Point, b: Point) {
        assert!((a.x - b.x).abs() < 1e-9 && (a.y - b.y).abs() < 1e-9, "expected {b:?}, got {a:?}");
    }

    #[test]
    fn center_maps_to_center() {
        let source = Area::full(152.0, 95.0); // real Wacom CTL-472 digitizer size
        let target = Area::full(1920.0, 1080.0);
        let center = Point { x: source.x, y: source.y };
        approx_eq(map_point(center, &source, &target), Point { x: target.x, y: target.y });
    }

    #[test]
    fn corners_map_to_corners_without_rotation() {
        let source = Area::full(152.0, 95.0);
        let target = Area::full(1920.0, 1080.0);
        approx_eq(map_point(Point { x: source.left(), y: source.top() }, &source, &target), Point { x: target.left(), y: target.top() });
        approx_eq(
            map_point(Point { x: source.right(), y: source.bottom() }, &source, &target),
            Point { x: target.right(), y: target.bottom() },
        );
    }

    #[test]
    fn smaller_active_area_off_center_still_maps_proportionally() {
        // Mirrors the real saved profile: a 30x16.87mm area centered on a
        // 152x95mm tablet, mapped to a full 1920x1080 display.
        let source = Area { width: 30.0, height: 16.87, x: 76.0, y: 47.5, rotation: 0.0 };
        let target = Area::full(1920.0, 1080.0);

        // The active area's own top-left corner should map to the display's
        // top-left corner, regardless of where that area sits on the tablet.
        approx_eq(map_point(Point { x: source.left(), y: source.top() }, &source, &target), Point { x: 0.0, y: 0.0 });
        approx_eq(map_point(Point { x: source.x, y: source.y }, &source, &target), Point { x: 960.0, y: 540.0 });
    }

    #[test]
    fn rotating_90_clockwise_moves_top_to_right() {
        // A point straight "north" of center, rotated 90 degrees clockwise,
        // should end up straight "east" of center (screen/tablet convention:
        // Y grows downward, so "north" is -Y and "east" is +X).
        let center = Point { x: 0.0, y: 0.0 };
        let north = Point { x: 0.0, y: -10.0 };
        approx_eq(rotate_around(north, center, 90.0), Point { x: 10.0, y: 0.0 });
    }

    #[test]
    fn rotated_source_area_still_maps_center_to_center() {
        let source = Area { width: 100.0, height: 60.0, x: 76.0, y: 47.5, rotation: 45.0 };
        let target = Area::full(1920.0, 1080.0);
        approx_eq(map_point(Point { x: source.x, y: source.y }, &source, &target), Point { x: target.x, y: target.y });
    }
}

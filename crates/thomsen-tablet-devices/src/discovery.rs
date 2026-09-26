//! Combines raw HID enumeration with the known-tablet database to answer
//! "is a tablet Thomsen Tablet recognizes currently connected?"

use crate::descriptor::{self, TabletDescriptor};
use crate::hid;

/// USB HID Usage Table values (USB Implementers Forum, "HID Usage Tables"
/// spec) identifying a digitizer pen - a public, vendor-independent
/// standard, not something reverse-engineered from any specific tablet.
/// Usage Page 0x0D is "Digitizers"; Usage 0x02 within it is "Pen". Used to
/// pick the pen-reporting interface out of a composite tablet's several HID
/// interfaces (see [`DiscoveredTablet`] and [`primary_per_device`]).
pub const USAGE_PAGE_DIGITIZER: u16 = 0x0D;
pub const USAGE_PEN: u16 = 0x02;

/// The standard USB HID "Generic Desktop" usage page, and the Mouse/Keyboard
/// usages within it. **Confirmed against a real, physically-connected Wacom
/// CTL-472** (2026-09-17): it exposes this exact usage (0x0001/0x0002) on a
/// mouse-compatibility collection, and Windows' own built-in HID-compliant
/// mouse class driver binds to that collection - a second application can
/// never get raw read access to it (`ReadFile` fails with `ERROR_ACCESS_DENIED`,
/// OS error 5, even though `hidapi` can still *open* it). These usages must
/// never be selected as "the" tablet interface.
pub const USAGE_PAGE_GENERIC_DESKTOP: u16 = 0x01;
pub const USAGE_MOUSE: u16 = 0x02;
pub const USAGE_KEYBOARD: u16 = 0x06;

#[derive(Debug, Clone)]
pub struct DiscoveredTablet {
    pub descriptor: TabletDescriptor,
    pub hid_path: String,
    pub interface_number: i32,
    pub usage_page: u16,
    pub usage: u16,
}

impl DiscoveredTablet {
    /// Whether this interface reports the standard Digitizer/Pen usage -
    /// see [`USAGE_PAGE_DIGITIZER`]/[`USAGE_PEN`].
    pub fn is_standard_pen_usage(&self) -> bool {
        self.usage_page == USAGE_PAGE_DIGITIZER && self.usage == USAGE_PEN
    }

    /// Whether this is a standard Mouse or Keyboard collection - see
    /// [`USAGE_PAGE_GENERIC_DESKTOP`]. Windows reserves these for its own
    /// input stack, so they must be treated as unusable for raw reads, never
    /// picked as a fallback.
    pub fn is_windows_reserved_usage(&self) -> bool {
        self.usage_page == USAGE_PAGE_GENERIC_DESKTOP && (self.usage == USAGE_MOUSE || self.usage == USAGE_KEYBOARD)
    }

    /// Lower sorts first - see [`primary_per_device`] for the reasoning.
    fn selection_priority(&self) -> u8 {
        if self.is_standard_pen_usage() {
            0
        } else if self.is_windows_reserved_usage() {
            2
        } else {
            1
        }
    }
}

/// Scans currently-connected HID devices for ones matching
/// `descriptor::KNOWN_TABLETS`.
///
/// A composite tablet exposes several HID interfaces under the same
/// vendor/product id (pen data, pad/buttons, a mouse-compatibility
/// fallback), so this can legitimately return more than one entry for a
/// single physical tablet - each `DiscoveredTablet` names its own
/// `interface_number`/`usage_page`/`usage`. Most callers want
/// [`primary_per_device`] instead, which picks the one interface per
/// physical tablet that actually carries pen reports; this function stays
/// public because seeing every raw interface is legitimately useful for
/// diagnostics.
pub fn scan() -> Result<Vec<DiscoveredTablet>, String> {
    let devices = hid::list_devices()?;
    Ok(devices
        .into_iter()
        .filter_map(|d| {
            descriptor::match_device(d.vendor_id, d.product_id).map(|desc| DiscoveredTablet {
                descriptor: *desc,
                hid_path: d.path,
                interface_number: d.interface_number,
                usage_page: d.usage_page,
                usage: d.usage,
            })
        })
        .collect())
}

/// Reduces `scan()`'s raw interface list to at most one [`DiscoveredTablet`]
/// per physical device (grouped by vendor/product id), choosing whichever
/// interface is most likely to carry pen reports rather than the first one
/// HID enumeration happens to list.
///
/// Selection order: the standard Digitizer/Pen usage
/// ([`DiscoveredTablet::is_standard_pen_usage`]) wins first; a standard
/// Mouse/Keyboard collection ([`DiscoveredTablet::is_windows_reserved_usage`])
/// always loses, since Windows' own class drivers claim those and raw reads
/// against them fail; everything else (typically a vendor-defined usage
/// page) ranks in between, tie-broken by the lowest `interface_number`.
///
/// **Why this matters, confirmed against real hardware:** a real,
/// physically-connected Wacom CTL-472 (2026-09-17) exposes three HID
/// collections under one vendor/product id - a vendor-defined one on
/// interface 1 (usage page `0xFF00`), a standard Mouse-compatibility one on
/// interface 0 (usage page `0x0001`, usage `0x0002`), and a second
/// vendor-defined one also on interface 0 (usage page `0xFF0D`) that is the
/// real pen-data channel. None report the standard Digitizer/Pen usage, so
/// this exact device exercises the fallback path, not the first branch -
/// and the *previous* version of this function (plain "lowest interface
/// number") picked the Mouse-compatibility collection, which is why
/// `start_driver` opened successfully but every subsequent read failed with
/// `ERROR_ACCESS_DENIED` (Windows' own mouse class driver already owned it).
/// This is still a heuristic, not something the tablet's descriptor states
/// outright - if a future supported model's real pen interface turns out to
/// use a standard Mouse/Keyboard usage for actual pen data (unusual, but
/// HID doesn't forbid it), this ranking would need a per-device override.
pub fn primary_per_device(candidates: Vec<DiscoveredTablet>) -> Vec<DiscoveredTablet> {
    let mut seen: Vec<(u16, u16)> = Vec::new();
    let mut result: Vec<DiscoveredTablet> = Vec::new();

    for key in candidates.iter().map(|t| (t.descriptor.vendor_id, t.descriptor.product_id)) {
        if seen.contains(&key) {
            continue;
        }
        seen.push(key);

        let mut group: Vec<&DiscoveredTablet> = candidates.iter().filter(|t| (t.descriptor.vendor_id, t.descriptor.product_id) == key).collect();
        group.sort_by_key(|t| (t.selection_priority(), t.interface_number));
        if let Some(best) = group.into_iter().next() {
            result.push(best.clone());
        }
    }

    result
}

/// [`scan`] followed by [`primary_per_device`] - what callers that open or
/// display "the tablet" (as opposed to raw diagnostics) should use.
pub fn scan_primary() -> Result<Vec<DiscoveredTablet>, String> {
    Ok(primary_per_device(scan()?))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::descriptor::KNOWN_TABLETS;

    fn candidate(interface_number: i32, usage_page: u16, usage: u16) -> DiscoveredTablet {
        DiscoveredTablet {
            descriptor: KNOWN_TABLETS[0],
            hid_path: format!("mock-path-{interface_number}"),
            interface_number,
            usage_page,
            usage,
        }
    }

    #[test]
    fn picks_the_standard_pen_usage_over_other_interfaces() {
        // A realistic composite device: pad/buttons on interface 0 (vendor
        // usage page), pen data on interface 1 (standard Digitizer/Pen), a
        // mouse-compatibility fallback on interface 2.
        let candidates = vec![candidate(0, 0xFF00, 0x01), candidate(1, USAGE_PAGE_DIGITIZER, USAGE_PEN), candidate(2, 0x01, 0x02)];
        let chosen = primary_per_device(candidates);
        assert_eq!(chosen.len(), 1);
        assert_eq!(chosen[0].interface_number, 1);
    }

    #[test]
    fn falls_back_to_lowest_interface_number_when_no_usage_matches() {
        let candidates = vec![candidate(2, 0xFF00, 0x01), candidate(0, 0xFF00, 0x01), candidate(1, 0xFF00, 0x01)];
        let chosen = primary_per_device(candidates);
        assert_eq!(chosen.len(), 1);
        assert_eq!(chosen[0].interface_number, 0);
    }

    #[test]
    fn never_selects_a_windows_reserved_mouse_or_keyboard_usage() {
        // The exact three interfaces a real, physically-connected Wacom
        // CTL-472 reported on 2026-09-17 (see the log excerpt in
        // `primary_per_device`'s doc comment) - none report the standard
        // Digitizer/Pen usage, and the naive "lowest interface number"
        // fallback used to pick the Mouse-compatibility one here, which is
        // exactly what caused every read to fail with ACCESS_DENIED.
        // Col01 and Col02 are genuinely both "interface 0" on the real
        // device (two collections within the same USB interface) - only
        // their usage/usage_page tell them apart, same as real hidapi data.
        let vendor_control = candidate(1, 0xFF00, 0x0080);
        let mouse_compat = candidate(0, USAGE_PAGE_GENERIC_DESKTOP, USAGE_MOUSE);
        let real_pen_channel = candidate(0, 0xFF0D, 0x0001);
        let candidates = vec![vendor_control, mouse_compat, real_pen_channel];

        let chosen = primary_per_device(candidates);
        assert_eq!(chosen.len(), 1);
        assert_eq!(chosen[0].usage_page, 0xFF0D, "must pick the vendor-defined channel, not the Windows-reserved mouse one");
        assert_eq!(chosen[0].usage, 0x0001);
    }

    #[test]
    fn one_result_per_distinct_vendor_product_pair() {
        let mut other = candidate(0, USAGE_PAGE_DIGITIZER, USAGE_PEN);
        other.descriptor.vendor_id = 0xABCD;
        other.descriptor.product_id = 0x1234;
        let candidates = vec![candidate(0, USAGE_PAGE_DIGITIZER, USAGE_PEN), candidate(1, 0xFF00, 0x01), other];
        let chosen = primary_per_device(candidates);
        assert_eq!(chosen.len(), 2);
    }

    #[test]
    fn empty_input_produces_empty_output() {
        assert!(primary_per_device(Vec::new()).is_empty());
    }
}

//! A small, honest, bundled database of tablets Thomsen Tablet knows how to
//! talk to. Deliberately short - see the project README's roadmap: v0.2's
//! whole point is making *one* real tablet work correctly before adding
//! more, rather than listing devices nobody has verified.
//!
//! `width_mm`/`height_mm`/`max_x`/`max_y`/`max_pressure` for the Wacom
//! CTL-472 entry are taken verbatim from OpenTabletDriver's own public
//! tablet-configuration data (LGPL-3.0; see the project's NOTICE.md) -
//! `OpenTabletDriver.Configurations/Configurations/Wacom/CTL-472.json`,
//! `Specifications.Digitizer` / `Specifications.Pen`. Only the *data* (a
//! hardware specification) is used, not any of OpenTabletDriver's code.

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub enum ReportFormat {
    /// The CTL-472's actual USB pen report format: 10-byte reports, report
    /// ID 2, plain little-endian 16-bit X/Y. Confirmed against a real,
    /// physically-connected CTL-472 on 2026-09-17 - see
    /// `report::parse_wacom_ctl472` for the exact layout and how it was
    /// derived (not the same layout originally guessed from Linux kernel
    /// documentation for a different Wacom generation - that guess was
    /// wrong, and real capture replaced it).
    WacomCtl472,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
pub struct TabletDescriptor {
    pub name: &'static str,
    pub vendor_id: u16,
    pub product_id: u16,
    pub width_mm: f64,
    pub height_mm: f64,
    pub max_x: i32,
    pub max_y: i32,
    pub max_pressure: i32,
    pub button_count: u8,
    pub report_format: ReportFormat,
}

pub const KNOWN_TABLETS: &[TabletDescriptor] = &[TabletDescriptor {
    name: "Wacom CTL-472",
    vendor_id: 0x056A, // 1386 decimal - Wacom Co., Ltd.
    product_id: 0x037A, // 890 decimal
    width_mm: 152.0,
    height_mm: 95.0,
    max_x: 15200,
    max_y: 9500,
    max_pressure: 2047,
    button_count: 2,
    report_format: ReportFormat::WacomCtl472,
}];

pub fn match_device(vendor_id: u16, product_id: u16) -> Option<&'static TabletDescriptor> {
    KNOWN_TABLETS.iter().find(|t| t.vendor_id == vendor_id && t.product_id == product_id)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn matches_the_real_ctl_472_ids() {
        // VID_056A&PID_037A - the real Wacom CTL-472 USB identifiers, taken
        // from OpenTabletDriver's public config data (see the module doc
        // comment), not a guessed or placeholder value. This does NOT assert
        // that a CTL-472 is physically connected to any particular machine -
        // that requires live `hidapi` enumeration, which is a separate,
        // hardware-dependent check.
        let found = match_device(0x056A, 0x037A).expect("CTL-472 should be in the bundled table");
        assert_eq!(found.name, "Wacom CTL-472");
    }

    #[test]
    fn unknown_device_does_not_match() {
        assert!(match_device(0xFFFF, 0xFFFF).is_none());
    }
}

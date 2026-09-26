//! Parses raw HID input reports from a Wacom CTL-472's USB pen protocol
//! into normalized sample values.
//!
//! **Provenance:** this layout was NOT derived from any external document -
//! it was reverse-engineered on 2026-09-17 from a live byte capture against
//! a real, physically-connected Wacom CTL-472 (see the project README for
//! the full story). An earlier version of this parser assumed a different,
//! more complex layout (big-endian X/Y with an extra bit packed into byte
//! 9) based on the Linux kernel's documentation of an older Wacom
//! "Intuos"-generation protocol (`drivers/hid/wacom_wac.c`,
//! `wacom_intuos_general`, GPL-2.0) - reading that file to understand the
//! *general shape* of Wacom USB pen reports (report ID, roughly where
//! X/Y/pressure live) is what motivated capturing real bytes and checking
//! the hypothesis it suggested. That hypothesis turned out to be wrong for
//! this specific device: real capture showed byte-for-byte that the CTL-472
//! uses a simpler, different encoding (see below), so this implementation
//! is now based entirely on the live capture, not on the kernel source.
//! Full attribution history is in the project's NOTICE.md.
//!
//! **How this was verified:** a temporary diagnostic build logged every raw
//! report's bytes and decoded fields while a real CTL-472's pen was dragged
//! slowly across the tablet. Reconstructing X and Y as little-endian 16-bit
//! values (byte\[2\]/byte\[3\] and byte\[4\]/byte\[5\]) produced a smooth,
//! monotonically-changing sequence matching the drag; the previously-assumed
//! big-endian-plus-extra-bit formula did not (it produced values jumping
//! across nearly the tablet's full range between consecutive 8ms samples -
//! not physically possible for a slow drag). Separately, releasing the pen
//! showed the device sends an all-zero payload (bytes 2-8) once it decides
//! the pen is fully out of range, which is what `in_range` now checks for.
//!
//! Report shape (10 bytes, report ID 2):
//!
//! ```text
//! byte  0      report ID (must be 2 for a pen report)
//! byte  1      bit 0: pressure LSB · bit 1: BTN_STYLUS (barrel) · bit 2: BTN_STYLUS2 (eraser)
//!              upper bits: decay as the pen leaves proximity - not fully
//!              characterized yet, not currently relied on (see `in_range`)
//! bytes 2-3    X, little-endian (byte 2 = low, byte 3 = high)
//! bytes 4-5    Y, little-endian (byte 4 = low, byte 5 = high)
//! byte  6      pressure, low 8 bits
//! byte  7      pressure, next bits (top 2 bits observed as always 0 in the
//!              capture this was verified against - pressure's full range
//!              has NOT been exercised against real hardware, see below)
//! bytes 2-8    all zero <=> pen is out of range (device-confirmed, see above)
//! ```
//!
//! **What's still unverified:** the pressure formula is carried over from
//! the original (wrong-for-X/Y) hypothesis and happened to produce a
//! plausible-looking, if somewhat noisy, sequence in the one capture this
//! was checked against - but since that same hypothesis was proven wrong
//! for X/Y, pressure should be treated as unconfirmed too until checked
//! against a capture that deliberately varies pressure from zero to
//! maximum. This does not block osu! use (osu! doesn't read pen pressure),
//! which is why fixing X/Y first was the priority.
use serde::Serialize;

pub const CTL472_REPORT_LEN: usize = 10;
const REPORT_ID_PEN: u8 = 2;

#[derive(Debug, Clone, Copy, PartialEq, Serialize)]
pub struct RawSample {
    pub x: i32,
    pub y: i32,
    pub pressure: i32,
    /// True once the device reports anything other than its all-zero
    /// "fully out of range" payload - see the module doc comment.
    pub in_range: bool,
    pub tip_pressed: bool,
    pub barrel_button: bool,
    pub eraser_button: bool,
    pub hover_distance: u8,
}

/// Returns `None` if `data` isn't a pen report this parser recognizes (wrong
/// report ID or too short), rather than guessing at a partial decode.
pub fn parse_wacom_ctl472(data: &[u8], max_pressure: i32) -> Option<RawSample> {
    if data.len() < CTL472_REPORT_LEN || data[0] != REPORT_ID_PEN {
        return None;
    }

    let x = i32::from(data[2]) | (i32::from(data[3]) << 8);
    let y = i32::from(data[4]) | (i32::from(data[5]) << 8);

    // Carried over unchanged from the original (pre-real-data) hypothesis -
    // NOT re-derived from the capture the way X/Y and `in_range` were. It
    // happens to produce a plausible-looking, self-consistent sequence
    // against the one real capture checked so far (pressure values stayed
    // in the low-to-middle range, where byte 7's masked bits were always
    // observed as 0), but since that same hypothesis was proven wrong for
    // X/Y, treat this as unconfirmed until checked against a capture that
    // deliberately varies pressure from zero to maximum.
    let mut pressure = (i32::from(data[6]) << 3) | (i32::from(data[7] & 0xC0) >> 5) | i32::from(data[1] & 1);
    if max_pressure < 2047 {
        pressure >>= 1;
    }

    let tip_pressed = pressure > 0;
    let barrel_button = data[1] & 0x02 != 0;
    let eraser_button = data[1] & 0x04 != 0;
    // The device's own "fully out of range" signal: bytes 2-8 all zero.
    // hover_distance isn't populated by this device (no evidence any byte
    // encodes it the way the original Intuos-generation hypothesis assumed)
    // - kept at 0 rather than guessing.
    let in_range = data[2..=8].iter().any(|&b| b != 0) || tip_pressed;
    let hover_distance = 0;

    Some(RawSample { x, y, pressure, in_range, tip_pressed, barrel_button, eraser_button, hover_distance })
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A real report captured from a physically-connected Wacom CTL-472 on
    /// 2026-09-17 (see the module doc comment) - not synthetic. Pen touching
    /// the tablet, moderate pressure.
    const REAL_CAPTURED_REPORT: [u8; 10] = [0x02, 0xe1, 0x82, 0x1f, 0x89, 0x16, 0x6a, 0x05, 0x1f, 0x00];

    #[test]
    fn decodes_a_real_captured_report_correctly() {
        let sample = parse_wacom_ctl472(&REAL_CAPTURED_REPORT, 2047).expect("valid pen report");
        // x = 0x82 | (0x1f << 8) = 130 + 7936
        assert_eq!(sample.x, 8066);
        // y = 0x89 | (0x16 << 8) = 137 + 5632
        assert_eq!(sample.y, 5769);
        assert!(sample.tip_pressed);
        assert!(sample.in_range);
        assert!(!sample.barrel_button);
        assert!(!sample.eraser_button);
    }

    /// The exact idle payload the device sends once it decides the pen is
    /// fully out of range - also captured live, not synthetic.
    const REAL_OUT_OF_RANGE_REPORT: [u8; 10] = [0x02, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00];

    #[test]
    fn all_zero_payload_is_out_of_range() {
        let sample = parse_wacom_ctl472(&REAL_OUT_OF_RANGE_REPORT, 2047).expect("still a structurally valid report");
        assert!(!sample.in_range);
        assert!(!sample.tip_pressed);
        assert_eq!(sample.x, 0);
        assert_eq!(sample.y, 0);
    }

    #[test]
    fn a_hovering_report_with_position_but_no_pressure_is_still_in_range() {
        // Real captured sample from the release sequence: pressure/tip are
        // both zero (pen lifted) but X/Y are still being reported (hovering)
        // - this must stay in_range, unlike the fully-idle payload above.
        let hovering: [u8; 10] = [0x02, 0xc0, 0xec, 0x1e, 0xcb, 0x12, 0x00, 0x00, 0x18, 0x00];
        let sample = parse_wacom_ctl472(&hovering, 2047).expect("valid pen report");
        assert!(sample.in_range);
        assert!(!sample.tip_pressed);
    }

    #[test]
    fn rejects_reports_with_the_wrong_id() {
        let mut wrong_id = REAL_CAPTURED_REPORT;
        wrong_id[0] = 99;
        assert!(parse_wacom_ctl472(&wrong_id, 2047).is_none());
    }

    #[test]
    fn rejects_reports_that_are_too_short() {
        assert!(parse_wacom_ctl472(&REAL_CAPTURED_REPORT[..8], 2047).is_none());
    }

    #[test]
    fn zero_pressure_report_is_not_tip_pressed() {
        let mut hover_only = REAL_CAPTURED_REPORT;
        hover_only[1] = 0x00;
        hover_only[6] = 0x00;
        hover_only[7] = 0x00;
        let sample = parse_wacom_ctl472(&hover_only, 2047).expect("valid pen report");
        assert_eq!(sample.pressure, 0);
        assert!(!sample.tip_pressed);
    }
}

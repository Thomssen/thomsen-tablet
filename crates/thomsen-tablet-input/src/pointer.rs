//! Real Windows cursor/click output via `SendInput`.
//!
//! This is the one file in the whole workspace that touches the user's
//! actual mouse cursor - kept small and isolated so it's easy to audit.
//! Absolute-mode games (osu! included) read plain absolute mouse position,
//! not Windows' pressure-sensitive pen/pointer API, so that's what this
//! emits: `MOUSEEVENTF_MOVE | MOUSEEVENTF_ABSOLUTE` for position,
//! left/right button events for the tip and barrel button. True
//! pressure-sensitive pen injection (recognized as a pen, not a mouse, by
//! drawing apps) is a possible future enhancement, not implemented here.
//!
//! Verified by moving the real cursor to a known point and reading it back
//! with `GetCursorPos` (see `thomsen-tablet-input`'s own test below) - this
//! doesn't need a tablet, since it only tests the Windows API plumbing, not
//! anything HID-related.

use windows::Win32::Foundation::POINT;
use windows::Win32::UI::Input::KeyboardAndMouse::{
    SendInput, INPUT, INPUT_0, INPUT_MOUSE, MOUSEEVENTF_ABSOLUTE, MOUSEEVENTF_LEFTDOWN, MOUSEEVENTF_LEFTUP, MOUSEEVENTF_MOVE,
    MOUSEEVENTF_RIGHTDOWN, MOUSEEVENTF_RIGHTUP, MOUSEEVENTF_VIRTUALDESK, MOUSEINPUT, MOUSE_EVENT_FLAGS,
};
use windows::Win32::UI::WindowsAndMessaging::{
    GetCursorPos, GetSystemMetrics, SM_CXVIRTUALSCREEN, SM_CYVIRTUALSCREEN, SM_XVIRTUALSCREEN, SM_YVIRTUALSCREEN,
};

/// The virtual desktop's bounds (spans every connected monitor), in pixels.
#[derive(Debug, Clone, Copy)]
pub struct VirtualScreen {
    pub x: i32,
    pub y: i32,
    pub width: i32,
    pub height: i32,
}

pub fn virtual_screen() -> VirtualScreen {
    // SAFETY: GetSystemMetrics is a plain, side-effect-free query with no
    // pointers involved - always safe to call.
    unsafe {
        VirtualScreen {
            x: GetSystemMetrics(SM_XVIRTUALSCREEN),
            y: GetSystemMetrics(SM_YVIRTUALSCREEN),
            width: GetSystemMetrics(SM_CXVIRTUALSCREEN),
            height: GetSystemMetrics(SM_CYVIRTUALSCREEN),
        }
    }
}

/// Moves the cursor to an absolute point in screen pixels (virtual-desktop
/// coordinates - can be negative/beyond the primary monitor with multiple
/// displays).
pub fn move_absolute(screen_x: f64, screen_y: f64) {
    let vs = virtual_screen();
    if vs.width <= 0 || vs.height <= 0 {
        return;
    }
    // MOUSEEVENTF_ABSOLUTE expects 0..=65535 normalized across the target
    // (virtual, with MOUSEEVENTF_VIRTUALDESK) screen rectangle.
    let norm_x = (((screen_x - vs.x as f64) / vs.width as f64) * 65535.0).round() as i32;
    let norm_y = (((screen_y - vs.y as f64) / vs.height as f64) * 65535.0).round() as i32;
    send_mouse(norm_x, norm_y, MOUSEEVENTF_MOVE | MOUSEEVENTF_ABSOLUTE | MOUSEEVENTF_VIRTUALDESK);
}

/// Moves the cursor by a relative pixel delta.
pub fn move_relative(dx: i32, dy: i32) {
    send_mouse(dx, dy, MOUSEEVENTF_MOVE);
}

pub fn set_tip_button(down: bool) {
    send_mouse(0, 0, if down { MOUSEEVENTF_LEFTDOWN } else { MOUSEEVENTF_LEFTUP });
}

pub fn set_barrel_button(down: bool) {
    send_mouse(0, 0, if down { MOUSEEVENTF_RIGHTDOWN } else { MOUSEEVENTF_RIGHTUP });
}

/// Reads the cursor's current screen position - used to self-verify the
/// functions above actually moved it.
pub fn cursor_position() -> Option<(i32, i32)> {
    let mut p = POINT::default();
    // SAFETY: `p` is a valid, correctly-sized out-pointer for the duration
    // of this call.
    unsafe { GetCursorPos(&mut p) }.ok()?;
    Some((p.x, p.y))
}

fn send_mouse(dx: i32, dy: i32, flags: MOUSE_EVENT_FLAGS) {
    let input = INPUT {
        r#type: INPUT_MOUSE,
        Anonymous: INPUT_0 {
            mi: MOUSEINPUT {
                dx,
                dy,
                mouseData: 0,
                dwFlags: flags,
                time: 0,
                dwExtraInfo: 0,
            },
        },
    };
    // SAFETY: `input` is a single, fully-initialized INPUT struct and
    // `size_of::<INPUT>()` matches its own layout - exactly what SendInput
    // requires.
    unsafe {
        SendInput(&[input], std::mem::size_of::<INPUT>() as i32);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Moves the real cursor and reads it back - genuinely exercises the
    /// Windows API plumbing (not a tablet-dependent test; run with
    /// `cargo test -p thomsen-tablet-input -- --ignored --test-threads=1`
    /// since it visibly moves the cursor on whatever machine runs it).
    #[test]
    #[ignore]
    fn move_absolute_lands_on_the_requested_point() {
        let vs = virtual_screen();
        let target_x = vs.x as f64 + vs.width as f64 * 0.5;
        let target_y = vs.y as f64 + vs.height as f64 * 0.5;
        move_absolute(target_x, target_y);
        let (x, y) = cursor_position().expect("GetCursorPos should succeed");
        // Rounding through the 0..65535 normalization can be off by a pixel.
        assert!((x as f64 - target_x).abs() <= 2.0, "x={x} expected near {target_x}");
        assert!((y as f64 - target_y).abs() <= 2.0, "y={y} expected near {target_y}");
    }
}

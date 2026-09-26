# Thomsen Tablet

A standalone tablet driver for Windows, built especially for osu! players. Same visual family as [Thomsen OSINT](../Thomsen%20OSINT) - dark, minimal, premium.

**Thomsen Tablet talks to supported tablets' hardware directly.** It does not require OpenTabletDriver, Wacom's official driver, or any other driver software to be installed - install Thomsen Tablet and it's the only thing you need. See [NOTICE.md](NOTICE.md) for exactly what hardware-protocol references informed this (and their licenses/attribution) - understanding how a protocol works is not the same as reusing another project's driver, and that file documents the difference carefully.

## Architecture

Driver logic lives in its own Cargo workspace crates, never in UI code:

```
crates/thomsen-tablet-core     Tablet abstraction: coordinate geometry, mapping math,
                                profiles, the filter pipeline seam. No HID/Windows/UI
                                dependencies - pure, fully unit-tested logic.

crates/thomsen-tablet-devices  USB/HID discovery (via `hidapi`), the bundled tablet-
                                definition database, and raw HID report parsing.

crates/thomsen-tablet-input    Runs the live read loop: opens a discovered tablet, reads
                                its reports on a background thread, converts them to
                                millimeters, runs the active profile's filter chain, maps
                                them to screen space, and emits real cursor/click output
                                via `SendInput` - with auto-reconnect if the tablet drops.

src-tauri/                     UI-integration layer only. Tauri commands orchestrate
                                the crates above - no HID/report/mapping logic of its
                                own. Also owns Thomsen Tablet's own settings (theme,
                                startup prefs) and logging setup.

src/                           Frontend (React + TypeScript), matching Thomsen OSINT's
                                design-token system (plain CSS, no framework).
```

This mirrors a Core/Devices/Input/UI split by design: each driver layer is independently testable (see each crate's own `#[cfg(test)]` modules), and a future feature (more tablets, filters, profiles) extends the right layer without touching the others.

## How tablet communication actually works here

No custom kernel driver, no special Windows permissions: tablets like the ones supported so far expose themselves as standard USB HID devices, and Thomsen Tablet reads their raw input reports the same way any user-mode HID application would (via the `hidapi` crate, Windows' own `hid.dll` under the hood). The hard part isn't *accessing* the device - it's that each tablet family reports its data (X/Y/pressure/buttons) in its own vendor-specific byte layout, undocumented by any official spec. `thomsen-tablet-devices::report` implements that decoding per protocol family, learned from independent, publicly-documented reverse-engineering (see NOTICE.md) - not by reading or reusing any existing driver's code.

## Development

Requires Node.js, Rust, and the [Tauri prerequisites](https://tauri.app/start/prerequisites/) for Windows (MSVC build tools + WebView2).

```bash
npm install
npm run start   # tauri dev - opens the native window with hot reload
cargo test --workspace   # run the driver crates' unit tests
```

`npm run dev` alone runs just the Vite dev server in a browser tab for fast UI iteration; Tauri-only APIs (window controls, backend commands) fall back to no-ops/mocks outside the native shell.

## Status: v0.1-v0.4 done, plus most of v0.5/v1.0 - real hardware now confirmed working

| Version | Scope | Status |
|---|---|---|
| v0.1 | Driver architecture (workspace crates), device enumeration, HID scanner, logging | Done |
| v0.2 | One known tablet: connection, raw report reading, X/Y/pressure/buttons | Done - **confirmed against a real, physically-connected Wacom CTL-472** (2026-09-17), after fixing two real bugs that only showed up with real hardware - see below |
| v0.3 | Absolute cursor output, monitor mapping, tablet area editor (drag/resize, W/H/X/Y/rotation, lock aspect ratio, full/center) | Done |
| v0.4 | Relative mode, smoothing, noise reduction, anti-chatter, profiles (CRUD, duplicate, import/export), per-application auto-switching | Done |
| v0.5 | More tablet models | Not started - still just the one Wacom CTL-472 definition, deliberately: making one tablet work end-to-end (see below) matters more right now than listing devices nobody's verified |
| v1.0 | Installer, autostart, tray, updater, diagnostics, supported-device DB, crash recovery, config backup | Installer (NSIS, with an uninstall hook), autostart, tray, and diagnostics are done; updater, crash recovery, and config backup are not started |

Also built, alongside that table: a **Calibration** page (live position readout against the physical tablet surface, live pressure bar, and a tip-pressure activation threshold that gates hardware tip-clicks), a **Driver** page (start/stop/restart/rescan, live status, live raw sample), and a **Diagnostics** page (detected devices, driver/profile snapshot, log tail, one-click report copy). The very first UI-only shell (sidebar nav, theme system) predates the table above and is still the app you're looking at - only the *backend* direction changed: it was originally a frontend for an external OpenTabletDriver install, and is now a standalone driver. See git history / prior memory for that earlier phase if it matters.

### A known, deliberate limitation: no pressure-sensitive output

Pen pressure is read from the hardware, shown live (Driver/Calibration pages), and can gate whether a touch counts as a tip-click (the Calibration page's activation threshold) - but it is **not forwarded to Windows apps as pressure-sensitive input**. Cursor output is plain `SendInput` mouse events (position + left/right click), which is exactly what osu! and other absolute/relative-position games read, but a drawing app asking for real pen pressure (via Wintab or the Windows Ink pointer API) won't see any. Making pressure reach those apps as a recognized pen, not a mouse, is a substantial separate subsystem (see `pointer.rs`'s doc comment) and is out of scope for the osu!-focused goal this project was built for.

### A correction, stated plainly (superseded below - kept for the record)

An earlier pass of this README claimed a Wacom CTL-472 was "connected" on the dev machine and that detection had been "confirmed against actual hardware." That was wrong at the time: `Get-PnpDevice` without `-PresentOnly` returns every USB device Windows has *ever* seen, including ones no longer plugged in, and live `hidapi` enumeration found no tablet at all. That correction stood for a while - v0.2's hardware-communication code had genuinely never run against a real device. It has now, and the story below is what actually happened once one was connected.

### Real hardware, finally - and two real bugs it found (2026-09-17)

A real Wacom CTL-472 was connected during a QA pass and the driver was started against it for the first time. It failed immediately with `ERROR_ACCESS_DENIED` on every read. Investigating with the app's own tracing logs (not guesswork) found the real cause: this composite device exposes three HID collections under one vendor/product id - a vendor-defined one, a **standard Mouse-compatibility one**, and a second vendor-defined one - and none report the standard Digitizer/Pen usage the original interface-picking logic looked for. Its fallback ("lowest interface number") picked the Mouse-compatibility collection, which Windows' own HID mouse class driver already owns exclusively - a second application can never get raw reads from it. Fixed by teaching `thomsen-tablet-devices::discovery::primary_per_device` to actively avoid standard Mouse/Keyboard usages and prefer vendor-defined ones instead.

With that fixed, reads succeeded - but the cursor moved erratically ("jumping around the screen") instead of tracking the pen. A temporary diagnostic build logged every raw report's bytes alongside the decoded fields while the pen was dragged slowly across the tablet. That showed the *second* real bug: `report::parse_intuos_gen4` (the original name - see below) assumed a big-endian X/Y encoding with an extra bit borrowed from byte 9, based on reading the Linux kernel's documentation of a *different* Wacom generation's protocol. Reconstructing X/Y as **plain little-endian 16-bit values instead** (byte\[2\]/byte\[3\] and byte\[4\]/byte\[5\]) produced a smooth, monotonic sequence matching the drag exactly; the original formula produced values jumping across nearly the tablet's full range between consecutive 8ms samples - not something a human hand can do. The function has been renamed `parse_wacom_ctl472` and rewritten around the real layout, with the real captured bytes now committed as test fixtures (`report.rs`'s tests use the actual hex bytes, not synthetic ones). Releasing the pen also revealed the device's real "out of range" signal: an all-zero payload, not the `hover_distance` byte the original code assumed (which this device never populates) - `in_range` now checks for that instead.

See `NOTICE.md` for the corrected attribution: the report format is no longer "the documented Linux kernel protocol" (that hypothesis was wrong for this device) - it's independently reverse-engineered from live capture, which the kernel reference only pointed the way toward investigating.

### What's verified, and how

- **Live HID device enumeration** via `hidapi`: finds real connected peripherals correctly, confirmed against 18 genuine devices before a tablet was ever available, and against a real Wacom CTL-472 since.
- **HID interface selection** (`discovery::primary_per_device`): now informed by a real device's actual enumeration data (three real interfaces, captured and used as test fixtures), not just a hypothesis - see above.
- **Coordinate mapping math** (`thomsen-tablet-core::area::map_point`): unit-tested (rotation, off-center active areas, proportional scaling, absolute *and* relative mode) - pure math, hardware-independent.
- **The filter pipeline** (smoothing, noise reduction, anti-chatter) and the **pressure activation gate**: unit-tested against synthetic values.
- **Profile persistence** (`ProfileStore`) and **app settings persistence** (`Store`, including corrupted-file recovery): unit-tested against real temp directories and real save/reload cycles.
- **Real cursor/click output** (`thomsen-tablet-input::pointer`): moves the actual Windows cursor via `SendInput` and reads it back with `GetCursorPos`.
- **Windows autostart**: the actual registry round trip (`HKCU\...\Run`) was confirmed by toggling the setting, restarting the real app, and checking the registry directly - both directions (key created, then removed).
- **Raw report parsing** (`thomsen-tablet-devices::report::parse_wacom_ctl472`): X/Y and the in-range signal are now confirmed against real captured bytes from a physically-connected CTL-472 (see above) - this is the piece that was unverified in every earlier version of this README.

### What's still open

- **Pressure's exact byte formula is unconfirmed.** It was carried over unchanged from the original (wrong-for-X/Y) hypothesis, and happens to look plausible in the one capture checked so far - but that's weak evidence given the same hypothesis was wrong for X/Y. Doesn't block osu! use (osu! doesn't read pen pressure); does need a capture that deliberately varies pressure from zero to maximum before it's trusted.
- **Extended real-world tracking accuracy** - one slow drag confirmed the byte layout is right; it hasn't yet been used through a full osu! session to confirm the mapped cursor behaves well end to end (smoothing feel, edge behavior, click responsiveness).
- Everything already listed in "known, deliberate limitation" and the roadmap table above.

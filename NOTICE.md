# Third-party notices

Thomsen Tablet is a standalone tablet driver: it talks to supported tablets'
USB/HID hardware directly and does not require OpenTabletDriver, Wacom's
official driver, or any other driver software to be installed. It is not
affiliated with, endorsed by, or sponsored by OpenTabletDriver, Wacom, the
Linux kernel project, or any tablet manufacturer.

Building a driver from scratch means understanding hardware protocols other
projects have already documented. This file records exactly what was used
from where, and how, so attribution stays accurate as the project grows.

## Tablet configuration data - OpenTabletDriver

- Project: [OpenTabletDriver](https://github.com/OpenTabletDriver/OpenTabletDriver)
- License: **GNU Lesser General Public License v3.0 (LGPL-3.0)**
- Copyright: OpenTabletDriver contributors

`crates/thomsen-tablet-devices/src/descriptor.rs` bundles a small table of
tablet hardware specifications (physical digitizer size, max coordinate
values, pressure levels). The Wacom CTL-472 entry's numbers are taken
verbatim from OpenTabletDriver's public configuration data
(`OpenTabletDriver.Configurations/Configurations/Wacom/CTL-472.json`,
`Specifications.Digitizer` / `Specifications.Pen`) - a factual hardware
specification, not source code. No OpenTabletDriver **code** is copied,
vendored, linked, or adapted anywhere in this project.

## Protocol reference - Linux kernel Wacom HID driver (superseded by real capture)

- Project: [Linux kernel](https://kernel.org/) (`drivers/hid/wacom_wac.c`)
- License: **GPL-2.0**
- Copyright: Linux kernel contributors

The report parser in `crates/thomsen-tablet-devices/src/report.rs`
(`parse_wacom_ctl472`) started from a hypothesis formed by reading this
file's `wacom_intuos_general` function - a completely separate, independent
project from OpenTabletDriver - solely to understand *how Wacom USB pen
reports are generally shaped* (report ID, roughly where X/Y/pressure live),
not to copy a specification to implement verbatim. That hypothesis was then
checked against a real, physically-connected Wacom CTL-472 on 2026-09-17 and
turned out to be wrong for this device's actual byte layout (a real capture
showed plain little-endian X/Y, not the more complex encoding the kernel
reference described for that other Wacom generation). The current
implementation is based entirely on that real capture - independently
reverse-engineered from live device output, not derived from or resembling
the kernel's documented format. No GPL-2.0 source code is copied into this
project, and this project does not link against or embed any part of the
Linux kernel. This section is kept (rather than deleted) as an honest record
of what was consulted and how the understanding changed.

**Disclaimer:** the above reflects a good-faith, standard "clean room"
approach to protocol interoperability (understanding a factual specification
from one source, then writing an independent implementation) - it is not
legal advice. Anyone planning to redistribute Thomsen Tablet widely, or add
support for more tablets by the same method, should keep this same
discipline (document what was consulted and why, write original code) and
consider independent legal review.

## Libraries

- [hidapi](https://github.com/ruabmbua/hidapi-rs) (Rust crate) - MIT. Used
  with its `windows-native` feature, which talks to Windows' `hid.dll`
  directly rather than bundling the separate C `hidapi` library (which is
  itself BSD/GPL-2.0/HIDAPI-license triple-licensed) - so that C library is
  not part of Thomsen Tablet's build at all on Windows.
- [Tauri](https://tauri.app/) - MIT / Apache-2.0
- [tauri-plugin-autostart](https://github.com/tauri-apps/plugins-workspace) -
  MIT / Apache-2.0. On Windows this delegates to the
  [auto-launch](https://github.com/zzzgydi/auto-launch) crate (MIT), which is
  what actually writes the "Start with Windows" registry value under
  `HKCU\SOFTWARE\Microsoft\Windows\CurrentVersion\Run` - also the value the
  NSIS uninstaller hook (`src-tauri/windows/hooks.nsh`) removes on uninstall.
- [React](https://react.dev/) - MIT
- [tracing](https://github.com/tokio-rs/tracing) / `tracing-subscriber` /
  `tracing-appender` - MIT
- [uuid](https://github.com/uuid-rs/uuid) - MIT / Apache-2.0 (profile ids)

## Fonts

- [Inter](https://rsms.me/inter/) - SIL Open Font License 1.1, bundled via
  `@fontsource-variable/inter`.

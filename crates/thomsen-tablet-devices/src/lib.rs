//! USB/HID tablet discovery, the bundled tablet-definition database, and raw
//! report parsing. No coordinate mapping, profiles, or UI concerns here -
//! see `thomsen-tablet-core` for those, and `thomsen-tablet-input` for how
//! this crate's output feeds into it.

pub mod descriptor;
pub mod discovery;
pub mod hid;
pub mod report;

pub use descriptor::{match_device, ReportFormat, TabletDescriptor, KNOWN_TABLETS};
pub use discovery::{primary_per_device, scan, scan_primary, DiscoveredTablet, USAGE_PAGE_DIGITIZER, USAGE_PEN};
pub use hid::HidDeviceInfo;
pub use report::{parse_wacom_ctl472, RawSample, CTL472_REPORT_LEN};

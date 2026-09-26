//! Thin wrapper around the `hidapi` crate for enumerating and opening HID
//! devices. Kept separate from `discovery` (matches devices against
//! `descriptor::KNOWN_TABLETS`) and `report` (parses their bytes), so each
//! concern is testable independently.

use hidapi::{HidApi, HidDevice};

#[derive(Debug, Clone)]
pub struct HidDeviceInfo {
    pub vendor_id: u16,
    pub product_id: u16,
    pub product_string: Option<String>,
    pub path: String,
    /// Which top-level HID interface this is. Composite tablets expose
    /// several (pen data, pad/buttons, a mouse-compatibility fallback) that
    /// all share the same vendor/product id, so this is how callers tell
    /// them apart once they know which interface carries pen reports.
    pub interface_number: i32,
    pub usage_page: u16,
    pub usage: u16,
}

pub fn list_devices() -> Result<Vec<HidDeviceInfo>, String> {
    let api = HidApi::new().map_err(|e| format!("could not initialize HID access: {e}"))?;
    Ok(api
        .device_list()
        .map(|d| HidDeviceInfo {
            vendor_id: d.vendor_id(),
            product_id: d.product_id(),
            product_string: d.product_string().map(str::to_string),
            path: d.path().to_string_lossy().into_owned(),
            interface_number: d.interface_number(),
            usage_page: d.usage_page(),
            usage: d.usage(),
        })
        .collect())
}

pub fn open_by_path(path: &str) -> Result<HidDevice, String> {
    let api = HidApi::new().map_err(|e| format!("could not initialize HID access: {e}"))?;
    let c_path = std::ffi::CString::new(path).map_err(|e| e.to_string())?;
    api.open_path(&c_path).map_err(|e| format!("could not open {path}: {e}"))
}

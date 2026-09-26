//! Process-wide state handed to every command via `tauri::State`.

use std::sync::Mutex;

use thomsen_tablet_core::ProfileStore;
use thomsen_tablet_input::Driver;

use crate::store::Store;

pub struct AppState {
    /// Thomsen Tablet's own settings. Guards are taken briefly and never
    /// held across another lock or a slow call.
    pub store: Mutex<Store>,
    /// Saved tablet profiles (area, mode, filters, ...) - a Core concept,
    /// just given a directory to live in here.
    pub profiles: ProfileStore,
    /// The live driver session, if one is running. `None` means stopped.
    pub driver: Mutex<Option<Driver>>,
}

impl AppState {
    pub fn new(store: Store, profiles: ProfileStore) -> Self {
        AppState {
            store: Mutex::new(store),
            profiles,
            driver: Mutex::new(None),
        }
    }
}

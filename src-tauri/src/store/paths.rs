//! Where Thomsen Tablet keeps its own data on disk.
//!
//! ```text
//! %APPDATA%\Thomsen Tablet\
//!   settings.json
//! ```
//!
//! Thomsen Tablet is a standalone driver - this is its only on-disk config
//! (alongside `profiles/` and `logs/` written by other modules under the
//! same root), not something shared with or read from any other driver.

use std::path::{Path, PathBuf};

use tauri::{AppHandle, Manager};

use crate::error::{AppError, AppResult};

pub const DATA_DIR_NAME: &str = "Thomsen Tablet";

/// `%APPDATA%\Thomsen Tablet` (Roaming). Created if missing.
pub fn data_dir(app: &AppHandle) -> AppResult<PathBuf> {
    let base = app
        .path()
        .data_dir()
        .map_err(|e| AppError::msg(format!("cannot resolve %APPDATA%: {e}")))?;
    let dir = base.join(DATA_DIR_NAME);
    std::fs::create_dir_all(&dir)?;
    Ok(dir)
}

pub fn settings_file(root: &Path) -> PathBuf {
    root.join("settings.json")
}

/// Write `bytes` to `path` atomically: write a sibling `.tmp` then rename over
/// the target. `std::fs::rename` replaces an existing file on Windows.
pub fn atomic_write(path: &Path, bytes: &[u8]) -> AppResult<()> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let tmp = path.with_extension("json.tmp");
    std::fs::write(&tmp, bytes)?;
    std::fs::rename(&tmp, path)?;
    Ok(())
}

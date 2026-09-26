//! Profile persistence: one JSON file per profile under `<root>/profiles/`,
//! plus a small index file recording which profile is active.
//!
//! This crate has no opinion on where `<root>` is - the UI layer resolves
//! that (Thomsen Tablet's own app-data directory) and passes it in, the same
//! separation of concerns as the rest of this crate.

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::profile::Profile;

#[derive(Debug, thiserror::Error)]
pub enum StoreError {
    #[error("{0}")]
    Io(String),
    #[error("{0}")]
    Serde(String),
    #[error("no profile with id \"{0}\"")]
    NotFound(String),
}

impl From<std::io::Error> for StoreError {
    fn from(e: std::io::Error) -> Self {
        StoreError::Io(e.to_string())
    }
}
impl From<serde_json::Error> for StoreError {
    fn from(e: serde_json::Error) -> Self {
        StoreError::Serde(e.to_string())
    }
}

#[derive(Debug, Default, Serialize, Deserialize)]
struct Index {
    active_profile_id: Option<String>,
}

pub struct ProfileStore {
    root: PathBuf,
}

impl ProfileStore {
    pub fn new(root: PathBuf) -> Self {
        ProfileStore { root }
    }

    fn profiles_dir(&self) -> PathBuf {
        self.root.join("profiles")
    }
    fn profile_file(&self, id: &str) -> PathBuf {
        self.profiles_dir().join(format!("{id}.json"))
    }
    fn index_file(&self) -> PathBuf {
        self.root.join("profile-index.json")
    }

    /// One unreadable or corrupted profile file is skipped, not fatal to the
    /// whole list - a single bad file (truncated write, manual edit gone
    /// wrong) should never take down every other saved profile along with
    /// it. Contrast with `get`, where a *specific requested* profile being
    /// unreadable is a real error the caller needs to know about.
    pub fn list(&self) -> Result<Vec<Profile>, StoreError> {
        let dir = self.profiles_dir();
        if !dir.exists() {
            return Ok(Vec::new());
        }
        let mut out = Vec::new();
        for entry in std::fs::read_dir(&dir)? {
            let Ok(entry) = entry else { continue };
            if entry.path().extension().and_then(|e| e.to_str()) != Some("json") {
                continue;
            }
            let Ok(text) = std::fs::read_to_string(entry.path()) else { continue };
            if let Ok(mut profile) = serde_json::from_str::<Profile>(&text) {
                profile.backfill_missing_filters();
                out.push(profile);
            }
        }
        out.sort_by_key(|p| p.name.to_lowercase());
        Ok(out)
    }

    pub fn get(&self, id: &str) -> Result<Profile, StoreError> {
        let text = std::fs::read_to_string(self.profile_file(id)).map_err(|_| StoreError::NotFound(id.to_string()))?;
        let mut profile: Profile = serde_json::from_str(&text)?;
        profile.backfill_missing_filters();
        Ok(profile)
    }

    pub fn save(&self, profile: &Profile) -> Result<(), StoreError> {
        std::fs::create_dir_all(self.profiles_dir())?;
        let bytes = serde_json::to_vec_pretty(profile)?;
        atomic_write(&self.profile_file(&profile.id), &bytes)
    }

    pub fn delete(&self, id: &str) -> Result<(), StoreError> {
        let path = self.profile_file(id);
        if path.exists() {
            std::fs::remove_file(path)?;
        }
        let mut idx = self.load_index()?;
        if idx.active_profile_id.as_deref() == Some(id) {
            idx.active_profile_id = None;
            self.save_index(&idx)?;
        }
        Ok(())
    }

    pub fn active_profile_id(&self) -> Result<Option<String>, StoreError> {
        Ok(self.load_index()?.active_profile_id)
    }

    pub fn set_active(&self, id: Option<&str>) -> Result<(), StoreError> {
        let mut idx = self.load_index()?;
        idx.active_profile_id = id.map(str::to_string);
        self.save_index(&idx)
    }

    fn load_index(&self) -> Result<Index, StoreError> {
        let path = self.index_file();
        if !path.exists() {
            return Ok(Index::default());
        }
        let text = std::fs::read_to_string(path)?;
        Ok(serde_json::from_str(&text).unwrap_or_default())
    }

    fn save_index(&self, idx: &Index) -> Result<(), StoreError> {
        let bytes = serde_json::to_vec_pretty(idx)?;
        atomic_write(&self.index_file(), &bytes)
    }
}

fn atomic_write(path: &Path, bytes: &[u8]) -> Result<(), StoreError> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let tmp = path.with_extension("json.tmp");
    std::fs::write(&tmp, bytes)?;
    std::fs::rename(&tmp, path)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::area::Area;

    fn temp_root() -> PathBuf {
        let dir = std::env::temp_dir().join(format!("thomsen-tablet-test-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn round_trips_a_profile() {
        let root = temp_root();
        let store = ProfileStore::new(root.clone());
        let profile = Profile::new("osu!", Area::full(152.0, 95.0), Area::full(1920.0, 1080.0));

        store.save(&profile).unwrap();
        let loaded = store.get(&profile.id).unwrap();
        assert_eq!(loaded.name, "osu!");
        assert_eq!(loaded.id, profile.id);

        let listed = store.list().unwrap();
        assert_eq!(listed.len(), 1);

        std::fs::remove_dir_all(root).ok();
    }

    #[test]
    fn tracks_the_active_profile_and_clears_it_on_delete() {
        let root = temp_root();
        let store = ProfileStore::new(root.clone());
        let profile = Profile::new("Desktop", Area::full(152.0, 95.0), Area::full(1920.0, 1080.0));
        store.save(&profile).unwrap();
        store.set_active(Some(&profile.id)).unwrap();
        assert_eq!(store.active_profile_id().unwrap(), Some(profile.id.clone()));

        store.delete(&profile.id).unwrap();
        assert_eq!(store.active_profile_id().unwrap(), None);

        std::fs::remove_dir_all(root).ok();
    }

    #[test]
    fn missing_profile_is_not_found_not_a_panic() {
        let root = temp_root();
        let store = ProfileStore::new(root.clone());
        assert!(matches!(store.get("nonexistent"), Err(StoreError::NotFound(_))));
        std::fs::remove_dir_all(root).ok();
    }

    /// A profile file written before `velocity_smoothing`/`micro_jitter`/
    /// `lift_off_debounce` existed - missing those three ids entirely, the
    /// real on-disk shape of any profile saved with an older build - must
    /// come back with them backfilled to their real defaults on both read
    /// paths, not just left absent (which the UI would otherwise show as a
    /// blank `0` for every one of that filter's sliders).
    #[test]
    fn get_and_list_backfill_filters_missing_from_an_older_saved_profile() {
        let root = temp_root();
        let store = ProfileStore::new(root.clone());
        std::fs::create_dir_all(store.profiles_dir()).unwrap();
        let old_json = r#"{
            "id": "old-profile",
            "name": "Old Profile",
            "tabletArea": { "width": 152.0, "height": 95.0, "x": 0.0, "y": 0.0, "rotation": 0.0 },
            "displayArea": { "width": 1920.0, "height": 1080.0, "x": 0.0, "y": 0.0, "rotation": 0.0 },
            "lockAspectRatio": false,
            "inputMode": "absolute",
            "relativeSettings": { "xSensitivity": 10.0, "ySensitivity": 10.0 },
            "filters": [
                { "id": "smoothing", "enabled": true, "params": { "strength": 0.3 } }
            ],
            "appBindings": []
        }"#;
        std::fs::write(store.profiles_dir().join("old-profile.json"), old_json).unwrap();

        let fetched = store.get("old-profile").unwrap();
        assert_eq!(fetched.filters.len(), crate::profile::default_filters().len());
        let velocity = fetched.filters.iter().find(|f| f.id == "velocity_smoothing").unwrap();
        assert_eq!(velocity.params["slow_strength"], 0.5);
        let smoothing = fetched.filters.iter().find(|f| f.id == "smoothing").unwrap();
        assert!(smoothing.enabled, "the pre-existing filter's own saved state must survive backfill untouched");

        let listed = store.list().unwrap();
        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0].filters.len(), crate::profile::default_filters().len());

        std::fs::remove_dir_all(root).ok();
    }

    /// One truncated/corrupted profile file must not block every other
    /// saved profile from listing - each file is independent.
    #[test]
    fn one_corrupted_profile_file_does_not_break_listing_the_rest() {
        let root = temp_root();
        let store = ProfileStore::new(root.clone());
        let good = Profile::new("Good Profile", Area::full(152.0, 95.0), Area::full(1920.0, 1080.0));
        store.save(&good).unwrap();
        std::fs::write(store.profiles_dir().join("corrupted.json"), b"{ not valid json").unwrap();

        let listed = store.list().unwrap();
        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0].name, "Good Profile");

        std::fs::remove_dir_all(root).ok();
    }
}

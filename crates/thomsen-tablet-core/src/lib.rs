//! Thomsen Tablet's core abstraction layer: coordinate geometry, profiles,
//! profile persistence, and the filter pipeline.
//!
//! Deliberately has no dependency on any HID library, Windows API, or UI
//! framework - see `thomsen-tablet-devices` for hardware communication and
//! `thomsen-tablet-input` for how the two connect. That separation is what
//! makes this crate's logic fully unit-testable without a physical tablet.

pub mod area;
pub mod filter;
pub mod profile;
pub mod store;

pub use area::{map_point, Area, Point};
pub use filter::{AntiChatter, Filter, TapStabilizer};
pub use profile::{default_filters, pressure_gate, FilterConfig, InputMode, OsuVariant, Profile, RelativeSettings};
pub use store::{ProfileStore, StoreError};

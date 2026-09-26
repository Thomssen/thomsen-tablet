//! Wires `thomsen-tablet-devices`' raw reports through
//! `thomsen-tablet-core`'s filters and coordinate mapping, and out through
//! real Windows cursor/click output (`pointer`).
//!
//! See `driver::Driver` for the live pipeline and `pointer` for the one
//! module that touches the user's actual cursor.

pub mod driver;
pub mod foreground;
pub mod pointer;

pub use driver::{Driver, DriverStatus, TestSessionStatus};

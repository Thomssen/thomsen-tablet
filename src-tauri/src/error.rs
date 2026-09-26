//! One error type for the whole backend. It serializes to a plain string so the
//! frontend can surface it directly in a toast or an inline message.

use serde::{Serialize, Serializer};

#[derive(Debug, thiserror::Error)]
pub enum AppError {
    /// A human-readable message, shown as-is in the UI.
    #[error("{0}")]
    Message(String),

    /// The user's input failed validation before any work started.
    #[error("{0}")]
    Invalid(String),

    #[error("{0}")]
    Io(String),
}

impl AppError {
    pub fn msg(s: impl Into<String>) -> Self {
        AppError::Message(s.into())
    }
}

impl From<std::io::Error> for AppError {
    fn from(e: std::io::Error) -> Self {
        AppError::Io(e.to_string())
    }
}

impl From<serde_json::Error> for AppError {
    fn from(e: serde_json::Error) -> Self {
        AppError::Message(format!("data error: {e}"))
    }
}

impl From<thomsen_tablet_core::StoreError> for AppError {
    fn from(e: thomsen_tablet_core::StoreError) -> Self {
        AppError::Message(e.to_string())
    }
}

impl Serialize for AppError {
    fn serialize<S: Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        s.serialize_str(&self.to_string())
    }
}

pub type AppResult<T> = Result<T, AppError>;

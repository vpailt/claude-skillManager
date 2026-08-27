//! Single error type for the whole crate. Maps to a JS-friendly string when
//! returned from a `#[tauri::command]`.

use serde::{Serialize, Serializer};
use thiserror::Error;

#[derive(Debug, Error)]
pub enum Error {
    #[error("io: {0}")]
    Io(#[from] std::io::Error),

    #[error("json: {0}")]
    Json(#[from] serde_json::Error),

    #[error("http: {0}")]
    Http(#[from] reqwest::Error),

    #[error("zip: {0}")]
    Zip(#[from] zip::result::ZipError),

    #[error("github: {0}")]
    GitHub(String),

    #[error("invalid input: {0}")]
    Invalid(String),

    #[error("not found: {0}")]
    NotFound(String),

    #[error("{0}")]
    Other(String),
}

/// Full cause chain of an error, for logs.
///
/// `reqwest`'s `Display` stops at `error sending request for url (…)` and hides
/// its source — which is the only part that says whether the call timed out,
/// was refused, lost its TLS session or failed to resolve. Logging the head
/// alone turns a five-second diagnosis into an afternoon of guessing.
pub fn chain(e: &dyn std::error::Error) -> String {
    let mut out = e.to_string();
    let mut cur = e.source();
    while let Some(s) = cur {
        out.push_str(" <- ");
        out.push_str(&s.to_string());
        cur = s.source();
    }
    out
}

impl Error {
    /// This error and every cause behind it, for logs. See [`chain`].
    pub fn chain(&self) -> String {
        chain(self)
    }
}

impl Serialize for Error {
    fn serialize<S: Serializer>(&self, s: S) -> std::result::Result<S::Ok, S::Error> {
        s.serialize_str(self.to_string().as_ref())
    }
}

pub type Result<T> = std::result::Result<T, Error>;

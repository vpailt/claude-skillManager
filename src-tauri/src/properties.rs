//! Tiny `.properties` parser/serializer (Java-style).
//!
//! Supports:
//! - `key=value` and `key:value` lines
//! - `#` and `!` comments
//! - Leading/trailing whitespace stripped from keys and values
//!
//! Does NOT support:
//! - Multi-line values (backslash continuation)
//! - Unicode escapes (\uXXXX)
//!
//! For our config files (scalar values only) this is sufficient.

use std::collections::BTreeMap;
use std::fs;
use std::path::Path;

use crate::error::{Error, Result};

#[derive(Debug, Clone, Default)]
pub struct Properties {
    inner: BTreeMap<String, String>,
}

impl Properties {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn from_str(text: &str) -> Self {
        let mut out = Self::new();
        for raw in text.lines() {
            let line = raw.trim();
            if line.is_empty() || line.starts_with('#') || line.starts_with('!') {
                continue;
            }
            let split = line.find(|c: char| c == '=' || c == ':');
            let Some(eq) = split else { continue };
            let key = line[..eq].trim().to_string();
            if key.is_empty() {
                continue;
            }
            let value = line[eq + 1..].trim().to_string();
            out.inner.insert(key, value);
        }
        out
    }

    pub fn load(path: &Path) -> Result<Self> {
        if !path.exists() {
            return Ok(Self::new());
        }
        let text = fs::read_to_string(path).map_err(Error::from)?;
        Ok(Self::from_str(&text))
    }

    /// Get a string value or `None` if missing/empty.
    pub fn get(&self, key: &str) -> Option<&str> {
        self.inner
            .get(key)
            .map(|s| s.as_str())
            .filter(|s| !s.is_empty())
    }

    pub fn get_or(&self, key: &str, default: &str) -> String {
        self.get(key).unwrap_or(default).to_string()
    }

    pub fn get_bool(&self, key: &str, default: bool) -> bool {
        match self.get(key) {
            Some(v) => matches!(
                v.to_ascii_lowercase().as_str(),
                "true" | "1" | "yes" | "on" | "y"
            ),
            None => default,
        }
    }

    pub fn get_u32(&self, key: &str, default: u32) -> u32 {
        self.get(key)
            .and_then(|v| v.parse::<u32>().ok())
            .unwrap_or(default)
    }

    pub fn set<K: Into<String>, V: Into<String>>(&mut self, key: K, value: V) {
        self.inner.insert(key.into(), value.into());
    }

    pub fn remove(&mut self, key: &str) {
        self.inner.remove(key);
    }

    pub fn set_bool<K: Into<String>>(&mut self, key: K, value: bool) {
        self.set(key, if value { "true" } else { "false" });
    }

    pub fn set_u32<K: Into<String>>(&mut self, key: K, value: u32) {
        self.set(key, value.to_string());
    }

    pub fn render(&self) -> String {
        let mut out = String::new();
        for (k, v) in &self.inner {
            out.push_str(k);
            out.push('=');
            out.push_str(v);
            out.push('\n');
        }
        out
    }

    /// Render with section banners for legibility. Keys whose prefix matches a
    /// section header are grouped together; ungrouped keys go in "Other".
    pub fn render_with_sections(&self, sections: &[(&str, &[&str])]) -> String {
        let mut out = String::new();
        let mut used = std::collections::HashSet::<&str>::new();
        for (title, prefixes) in sections {
            let keys: Vec<&String> = self
                .inner
                .keys()
                .filter(|k| prefixes.iter().any(|p| k.starts_with(p)))
                .collect();
            if keys.is_empty() {
                continue;
            }
            if !out.is_empty() {
                out.push('\n');
            }
            out.push_str(&format!("# --- {title} ---\n"));
            for k in keys {
                let v = self.inner.get(k).map(|s| s.as_str()).unwrap_or("");
                out.push_str(&format!("{k}={v}\n"));
                used.insert(k.as_str());
            }
        }
        let leftover: Vec<&String> = self
            .inner
            .keys()
            .filter(|k| !used.contains(k.as_str()))
            .collect();
        if !leftover.is_empty() {
            if !out.is_empty() {
                out.push('\n');
            }
            out.push_str("# --- Other ---\n");
            for k in leftover {
                let v = self.inner.get(k).map(|s| s.as_str()).unwrap_or("");
                out.push_str(&format!("{k}={v}\n"));
            }
        }
        out
    }
}

pub fn write_atomic(path: &Path, content: &str) -> Result<()> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(Error::from)?;
    }
    let tmp = path.with_extension("tmp");
    fs::write(&tmp, content).map_err(Error::from)?;
    fs::rename(&tmp, path).map_err(Error::from)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_basic() {
        let p = Properties::from_str("# comment\nfoo=bar\nbaz : 42\n");
        assert_eq!(p.get("foo"), Some("bar"));
        assert_eq!(p.get_u32("baz", 0), 42);
    }

    #[test]
    fn bool_truthy() {
        let p = Properties::from_str("a=true\nb=YES\nc=0\nd=off\n");
        assert!(p.get_bool("a", false));
        assert!(p.get_bool("b", false));
        assert!(!p.get_bool("c", true));
        assert!(!p.get_bool("d", true));
    }

    #[test]
    fn round_trip() {
        let mut p = Properties::new();
        p.set("k1", "v1");
        p.set_bool("k2", true);
        p.set_u32("k3", 7);
        let rendered = p.render();
        let q = Properties::from_str(&rendered);
        assert_eq!(q.get("k1"), Some("v1"));
        assert!(q.get_bool("k2", false));
        assert_eq!(q.get_u32("k3", 0), 7);
    }
}

//! Tiny YAML-frontmatter parser — port of src/frontmatter.py.
//!
//! Only `name`, `description`, `type` are exercised in practice. Avoids
//! pulling a full YAML crate to keep bundle size small.

use std::collections::BTreeMap;

pub type Fields = BTreeMap<String, String>;

/// Returns (fields, body). Falls back to ({}, original_text) when there's no frontmatter.
pub fn parse_frontmatter(text: &str) -> (Fields, String) {
    let mut fields = Fields::new();
    if !text.starts_with("---") {
        return (fields, text.to_string());
    }
    let lines: Vec<&str> = text.split_inclusive('\n').collect();
    if lines.is_empty() || lines[0].trim() != "---" {
        return (fields, text.to_string());
    }
    let mut end: Option<usize> = None;
    for (i, line) in lines.iter().enumerate().skip(1) {
        if line.trim() == "---" {
            end = Some(i);
            break;
        }
    }
    let Some(end) = end else {
        return (fields, text.to_string());
    };

    let mut current_key: Option<String> = None;
    let mut buf: Vec<String> = Vec::new();

    for line in &lines[1..end] {
        // strip trailing newline for inspection but preserve indentation logic
        let line_trim_eol = line.trim_end_matches(['\n', '\r']);
        let starts_with_space = line_trim_eol
            .chars()
            .next()
            .map(|c| c == ' ' || c == '\t')
            .unwrap_or(false);
        if starts_with_space && current_key.is_some() {
            buf.push(line_trim_eol.trim().to_string());
            continue;
        }
        if let Some(k) = current_key.take() {
            fields.insert(k, buf.join(" ").trim().to_string());
            buf.clear();
        }
        if let Some(idx) = line_trim_eol.find(':') {
            let k = line_trim_eol[..idx].trim().to_string();
            let v = line_trim_eol[idx + 1..].trim().to_string();
            let v = if v.starts_with('"') && v.ends_with('"') && v.len() >= 2 {
                v[1..v.len() - 1].to_string()
            } else {
                v
            };
            if v.is_empty() || v == ">" || v == "|" {
                current_key = Some(k);
                buf.clear();
            } else {
                fields.insert(k, v);
            }
        }
    }
    if let Some(k) = current_key.take() {
        if !buf.is_empty() {
            fields.insert(k, buf.join(" ").trim().to_string());
        }
    }

    let body: String = lines[end + 1..].concat();
    (fields, body)
}

/// Rewrite top-level scalar fields in YAML frontmatter, preserving body.
pub fn update_frontmatter(text: &str, updates: &Fields) -> String {
    let (mut fields, body) = parse_frontmatter(text);
    for (k, v) in updates {
        fields.insert(k.clone(), v.clone());
    }
    let mut out = String::from("---\n");
    for (k, v) in &fields {
        if v.contains('\n') || v.len() > 200 {
            out.push_str(&format!("{k}: >\n"));
            out.push_str(&format!("  {}\n", v.replace('\n', " ")));
        } else {
            out.push_str(&format!("{k}: {v}\n"));
        }
    }
    out.push_str("---\n");
    out.push_str(&body);
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn simple_fields() {
        let (f, body) = parse_frontmatter("---\nname: foo\ndescription: bar\n---\nbody\n");
        assert_eq!(f.get("name").map(String::as_str), Some("foo"));
        assert_eq!(f.get("description").map(String::as_str), Some("bar"));
        assert_eq!(body.trim(), "body");
    }

    #[test]
    fn no_frontmatter() {
        let (f, body) = parse_frontmatter("hello world");
        assert!(f.is_empty());
        assert_eq!(body, "hello world");
    }
}

//! Tiny YAML-frontmatter parser — port of src/frontmatter.py.
//!
//! Only `name`, `description`, `type` are exercised in practice. Avoids
//! pulling a full YAML crate to keep bundle size small.

use std::collections::BTreeMap;

pub type Fields = BTreeMap<String, String>;

/// Returns (fields, body). Falls back to ({}, original_text) when there's no frontmatter.
///
/// Supports two indented-block shapes:
/// - `key: >` / `key: |` — block scalar; indented lines are joined into the value.
/// - `key:` (empty value) — nested mapping; indented `subkey: value` lines are
///   exposed under the dotted name `key.subkey`.
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

    enum Block {
        None,
        Scalar(String, Vec<String>),
        Mapping(String),
    }
    let mut block = Block::None;

    let flush_scalar = |fields: &mut Fields, k: String, buf: Vec<String>| {
        fields.insert(k, buf.join(" ").trim().to_string());
    };

    for line in &lines[1..end] {
        let line_trim_eol = line.trim_end_matches(['\n', '\r']);
        let starts_with_space = line_trim_eol
            .chars()
            .next()
            .map(|c| c == ' ' || c == '\t')
            .unwrap_or(false);

        if starts_with_space {
            match &mut block {
                Block::Scalar(_, buf) => {
                    buf.push(line_trim_eol.trim().to_string());
                    continue;
                }
                Block::Mapping(parent) => {
                    let inner = line_trim_eol.trim();
                    if let Some(idx) = inner.find(':') {
                        let sub_k = inner[..idx].trim();
                        let sub_v = inner[idx + 1..].trim();
                        if !sub_k.is_empty() && !sub_k.contains(char::is_whitespace) {
                            fields.insert(format!("{parent}.{sub_k}"), unquote(sub_v));
                            continue;
                        }
                    }
                    // Indented but not a `subkey: value` — ignore (sequences,
                    // comments, etc. aren't represented here).
                    continue;
                }
                Block::None => {
                    // Stray indentation at top level — ignore.
                    continue;
                }
            }
        }

        // Non-indented line closes the open block.
        match std::mem::replace(&mut block, Block::None) {
            Block::Scalar(k, buf) => flush_scalar(&mut fields, k, buf),
            Block::Mapping(_) | Block::None => {}
        }

        if let Some(idx) = line_trim_eol.find(':') {
            let k = line_trim_eol[..idx].trim().to_string();
            let v = unquote(line_trim_eol[idx + 1..].trim());
            if v.is_empty() {
                block = Block::Mapping(k);
            } else if v == ">" || v == "|" {
                block = Block::Scalar(k, Vec::new());
            } else {
                fields.insert(k, v);
            }
        }
    }

    if let Block::Scalar(k, buf) = block {
        if !buf.is_empty() {
            flush_scalar(&mut fields, k, buf);
        }
    }

    let body: String = lines[end + 1..].concat();
    (fields, body)
}

fn unquote(v: &str) -> String {
    if v.len() >= 2
        && ((v.starts_with('"') && v.ends_with('"'))
            || (v.starts_with('\'') && v.ends_with('\'')))
    {
        v[1..v.len() - 1].to_string()
    } else {
        v.to_string()
    }
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

    #[test]
    fn nested_mapping_exposes_dotted_keys() {
        let src = "---\nname: foo\nmetadata:\n  version: \"0.5.1\"\n  last_updated: \"2026-04-08\"\n---\nbody\n";
        let (f, _) = parse_frontmatter(src);
        assert_eq!(f.get("name").map(String::as_str), Some("foo"));
        assert_eq!(f.get("metadata.version").map(String::as_str), Some("0.5.1"));
        assert_eq!(
            f.get("metadata.last_updated").map(String::as_str),
            Some("2026-04-08")
        );
    }

    #[test]
    fn block_scalar_still_accumulates() {
        let src = "---\ndescription: >\n  line one\n  line two\nname: bar\n---\n";
        let (f, _) = parse_frontmatter(src);
        assert_eq!(
            f.get("description").map(String::as_str),
            Some("line one line two")
        );
        assert_eq!(f.get("name").map(String::as_str), Some("bar"));
    }
}

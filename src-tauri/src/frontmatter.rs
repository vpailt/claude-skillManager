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

/// Set top-level scalar fields **in place**, touching nothing else.
///
/// Unlike [`update_frontmatter`], which re-renders the whole block from the
/// parsed map, this one edits the raw lines, so a nested `metadata:` mapping
/// survives untouched. Round-tripping such a file through the parser flattens
/// it into literal `metadata.version:` keys — valid YAML, different document,
/// and the skill's own metadata quietly destroyed. The add flow writes
/// user-supplied `name` / `description` / `version` into files the user did not
/// author, so it cannot afford that.
///
/// A file with no frontmatter gets one prepended. An existing key is replaced
/// where it stands (its indented block-scalar continuation going with it); a
/// missing one is appended just before the closing `---`. Empty values are
/// skipped rather than written as blanks.
pub fn set_fields(text: &str, updates: &Fields) -> String {
    let updates: Vec<(&String, &String)> = updates
        .iter()
        .filter(|(_, v)| !v.trim().is_empty())
        .collect();
    if updates.is_empty() {
        return text.to_string();
    }
    // The parser joins an indented block back into one line, so a value
    // carrying newlines has to go out as a block scalar to survive a round trip.
    let render = |k: &str, v: &str| -> String {
        if v.contains('\n') {
            let mut out = format!("{k}: >\n");
            for part in v.split('\n') {
                out.push_str(&format!("  {}\n", part.trim()));
            }
            out
        } else {
            format!("{k}: {v}\n")
        }
    };

    let lines: Vec<&str> = text.split_inclusive('\n').collect();
    let end = if lines.first().map(|l| l.trim()) == Some("---") {
        lines
            .iter()
            .enumerate()
            .skip(1)
            .find(|(_, l)| l.trim() == "---")
            .map(|(i, _)| i)
    } else {
        None
    };
    let Some(end) = end else {
        // No frontmatter at all — write one and keep the text as the body.
        let mut out = String::from("---\n");
        for (k, v) in &updates {
            out.push_str(&render(k, v.trim()));
        }
        out.push_str("---\n");
        out.push_str(text);
        return out;
    };

    let mut out = String::from(lines[0]);
    let mut written: Vec<&str> = Vec::new();
    let mut skipping_block = false;
    for line in &lines[1..end] {
        let trimmed_eol = line.trim_end_matches(['\n', '\r']);
        let indented = trimmed_eol
            .chars()
            .next()
            .map(|c| c == ' ' || c == '\t')
            .unwrap_or(false);
        if indented {
            // Continuation of the key just replaced — it goes with its owner.
            if !skipping_block {
                out.push_str(line);
            }
            continue;
        }
        skipping_block = false;
        let key = trimmed_eol.split(':').next().unwrap_or("").trim();
        if let Some((k, v)) = updates.iter().find(|(k, _)| k.as_str() == key) {
            out.push_str(&render(k, v.trim()));
            written.push(k.as_str());
            skipping_block = true;
            continue;
        }
        out.push_str(line);
    }
    for (k, v) in &updates {
        if !written.contains(&k.as_str()) {
            out.push_str(&render(k, v.trim()));
        }
    }
    out.push_str(lines[end]);
    out.push_str(&lines[end + 1..].concat());
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
    fn set_fields_preserves_nested_mapping() {
        let src = "---\nname: foo\nmetadata:\n  version: \"0.5.1\"\n---\nbody\n";
        let mut up = Fields::new();
        up.insert("description".into(), "une description".into());
        let out = set_fields(src, &up);
        assert!(out.contains("metadata:\n  version: \"0.5.1\"\n"), "{out}");
        assert!(out.contains("description: une description\n"), "{out}");
        assert!(out.trim_end().ends_with("body"), "{out}");
    }

    #[test]
    fn set_fields_replaces_block_scalar_in_place() {
        let src = "---\ndescription: >\n  ancienne\n  description\nname: bar\n---\ncorps\n";
        let mut up = Fields::new();
        up.insert("description".into(), "nouvelle".into());
        let out = set_fields(src, &up);
        assert!(out.contains("description: nouvelle\n"), "{out}");
        assert!(!out.contains("ancienne"), "{out}");
        assert!(out.contains("name: bar\n"), "{out}");
    }

    #[test]
    fn set_fields_creates_frontmatter_when_absent() {
        let mut up = Fields::new();
        up.insert("name".into(), "foo".into());
        let out = set_fields("# Titre\n", &up);
        let (f, body) = parse_frontmatter(&out);
        assert_eq!(f.get("name").map(String::as_str), Some("foo"));
        assert_eq!(body.trim(), "# Titre");
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

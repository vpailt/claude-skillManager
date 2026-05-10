"""Tiny YAML-frontmatter parser. We only need: name, description, type.

Avoids pulling PyYAML into the bundle.
"""
from __future__ import annotations


def parse_frontmatter(text: str) -> tuple[dict[str, str], str]:
    """Return (fields, body). If no frontmatter, fields is empty and body is the original text."""
    if not text.startswith("---"):
        return {}, text
    lines = text.splitlines()
    if not lines or lines[0].strip() != "---":
        return {}, text
    end = -1
    for i, line in enumerate(lines[1:], start=1):
        if line.strip() == "---":
            end = i
            break
    if end == -1:
        return {}, text
    fields: dict[str, str] = {}
    current_key: str | None = None
    buf: list[str] = []
    for line in lines[1:end]:
        if line and (line[0] == " " or line[0] == "\t") and current_key is not None:
            buf.append(line.strip())
            continue
        if current_key is not None:
            fields[current_key] = " ".join(buf).strip()
            buf = []
            current_key = None
        if ":" in line:
            k, _, v = line.partition(":")
            k = k.strip()
            v = v.strip()
            if v.startswith('"') and v.endswith('"') and len(v) >= 2:
                v = v[1:-1]
            if v == "" or v == ">" or v == "|":
                current_key = k
                buf = []
            else:
                fields[k] = v
    if current_key is not None and buf:
        fields[current_key] = " ".join(buf).strip()
    body = "\n".join(lines[end + 1:])
    return fields, body


def update_frontmatter(text: str, updates: dict[str, str]) -> str:
    """Rewrite top-level scalar fields in YAML frontmatter, preserving body."""
    fields, body = parse_frontmatter(text)
    fields.update({k: v for k, v in updates.items() if v is not None})
    lines = ["---"]
    for k, v in fields.items():
        if "\n" in v or len(v) > 200:
            lines.append(f"{k}: >")
            lines.append("  " + v.replace("\n", " "))
        else:
            lines.append(f"{k}: {v}")
    lines.append("---")
    return "\n".join(lines) + "\n" + body

"""Helper used by the SKILL.md editor: rebuild a file with new frontmatter and body."""
from __future__ import annotations

from .frontmatter import parse_frontmatter


def replace_body(existing: str, new_body: str, new_fields: dict[str, str]) -> str:
    fm, _ = parse_frontmatter(existing)
    fm.update({k: v for k, v in new_fields.items() if v is not None})
    lines = ["---"]
    for k, v in fm.items():
        if v is None:
            continue
        if "\n" in v or len(v) > 200:
            lines.append(f"{k}: >")
            lines.append("  " + v.replace("\n", " "))
        else:
            lines.append(f"{k}: {v}")
    lines.append("---")
    body = new_body if new_body.startswith("\n") else "\n" + new_body
    return "\n".join(lines) + body.rstrip() + "\n"

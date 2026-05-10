"""Help dialog: explains what the app does and how to use it."""
from __future__ import annotations

from PySide6.QtCore import Qt
from PySide6.QtWidgets import (
    QDialog, QVBoxLayout, QHBoxLayout, QPushButton, QTextBrowser,
)


_HELP_HTML = """
<h2>Claude SkillManager</h2>
<p>A standalone GUI over <b>Claude Code's plugin install state</b>. The app
reads and writes the same files Claude Code uses under
<code>%USERPROFILE%\\.claude\\</code>. No <code>git</code>, <code>gh</code> or
<code>claude</code> CLI is required &mdash; everything goes through the GitHub
REST API.</p>

<h3>Concepts</h3>
<ul>
  <li><b>Marketplace</b> &mdash; a GitHub repo holding
      <code>.claude-plugin/marketplace.json</code>, an index of plugins.</li>
  <li><b>Plugin</b> &mdash; the actual unit you install. Its files live in
      <code>~/.claude/plugins/cache/&lt;mp&gt;/&lt;plugin&gt;/&lt;version&gt;/</code>.
      A plugin is referenced by the marketplace index but typically lives in
      its own GitHub repo.</li>
  <li><b>Skill</b> &mdash; a piece of authored guidance bundled inside a plugin
      (<code>SKILL.md</code> + folder). Standalone user skills under
      <code>~/.claude/skills/</code> are surfaced under a synthetic
      <i>(local skills)</i> marketplace.</li>
</ul>

<h3>Main window</h3>
<ul>
  <li><b>Refresh (F5)</b> &mdash; rescans local install state and (for
      marketplaces with a configured GitHub repo) merges in remote data:
      latest versions, plugin sources, remote-only skills.</li>
  <li><b>Filter</b> &mdash; live-filters the tree by name / description.</li>
  <li><b>Tree (left)</b> &mdash; marketplaces &rarr; plugins &rarr; skills.
      Right-click for per-row actions; selection drives the detail panel.</li>
  <li><b>Detail panel (right)</b> &mdash; per-item info plus contextual
      actions: install / update / uninstall, enable / disable, open folder,
      edit a skill in VS&nbsp;Code, upload a local skill to a marketplace.</li>
</ul>

<h3>Settings menu</h3>
<p><b>Git authentication</b> &mdash; store a GitHub Personal Access Token.
The token is kept locally in
<code>%APPDATA%\\SkillManager\\settings.json</code>. Public browsing works
without one but hits lower rate limits; uploads / PR creation require a token
with the <code>repo</code> scope.</p>

<h3>Admin (toolbar)</h3>
<p>Three tabs cover everything you can do as a marketplace owner:</p>
<ul>
  <li><b>Marketplaces</b> &mdash; add / rename / remove a marketplace, set
      its GitHub repo and branch, toggle <i>Owned</i> (gates the Plugins /
      Skills tabs) and <i>Auto-update</i> (re-pull on refresh when the remote
      SHA differs), install / uninstall locally.</li>
  <li><b>Plugins</b> &mdash; for an owned marketplace, add a plugin entry,
      bump a plugin's version, or remove a plugin. Each edit opens a pull
      request against <code>marketplace.json</code>.</li>
  <li><b>Skills</b> &mdash; push a new <code>SKILL.md</code> or upload a local
      skill folder into a plugin of an owned marketplace. The PR targets the
      plugin's source repo (separate-repo case) or the marketplace repo
      (monorepo case).</li>
</ul>

<h3>Where data lives</h3>
<ul>
  <li><code>~/.claude/plugins/installed_plugins.json</code> &mdash; plugin
      install records.</li>
  <li><code>~/.claude/plugins/known_marketplaces.json</code> &mdash; registered
      marketplaces (incl. the <code>autoUpdate</code> flag).</li>
  <li><code>~/.claude/plugins/cache/&lt;mp&gt;/&lt;plugin&gt;/&lt;version&gt;/</code>
      &mdash; extracted plugin contents.</li>
  <li><code>~/.claude/plugins/marketplaces/&lt;name&gt;/</code> &mdash;
      extracted marketplace repo.</li>
  <li><code>~/.claude/settings.json</code> &mdash; <code>enabledPlugins</code>
      keys (enable / disable).</li>
  <li><code>~/.claude/skills/&lt;name&gt;/</code> &mdash; standalone user
      skills.</li>
  <li><code>%APPDATA%\\SkillManager\\settings.json</code> &mdash; the app's
      own settings (token + per-marketplace config). Kept separate so the
      <code>.exe</code> stays portable.</li>
</ul>
"""


class HelpDialog(QDialog):
    def __init__(self, parent=None):
        super().__init__(parent)
        self.setWindowTitle("Help — Claude SkillManager")
        self.resize(720, 640)

        layout = QVBoxLayout(self)

        body = QTextBrowser()
        body.setOpenExternalLinks(True)
        body.setHtml(_HELP_HTML)
        layout.addWidget(body, 1)

        btns = QHBoxLayout()
        btns.addStretch(1)
        close = QPushButton("Close")
        close.setDefault(True)
        close.clicked.connect(self.accept)
        btns.addWidget(close)
        layout.addLayout(btns)

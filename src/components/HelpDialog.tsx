import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Badge } from "@/components/ui/badge";
import {
  Globe,
  HardDrive,
  Keyboard,
  LayoutDashboard,
  Package,
  ShieldCheck,
  Sparkles,
  Github,
  FolderOpen,
  Bug,
} from "lucide-react";
import { useAppVersion } from "@/hooks/useAppVersion";

interface HelpDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

// Visual "TL;DR" of what each tab does and where data lives on disk.
// Loaded lazily from the Sidebar's "?" button — keep it readable on a 1024px
// window: scrollable body, ~520px wide.
export function HelpDialog({ open, onOpenChange }: HelpDialogProps) {
  const version = useAppVersion();
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl gap-0 p-0">
        <DialogHeader className="border-b px-6 py-4">
          <DialogTitle className="flex items-center gap-2">
            <Sparkles className="h-5 w-5 text-primary" />
            SkillManager — how it works
            {version && (
              <Badge variant="outline" className="ml-auto font-mono text-[11px]">
                v{version}
              </Badge>
            )}
          </DialogTitle>
          <DialogDescription>
            A portable GUI for Claude Code plugins, marketplaces and skills.
            Nothing here calls <code>git</code>, <code>gh</code> or{" "}
            <code>claude</code> — everything goes through the GitHub REST API.
          </DialogDescription>
        </DialogHeader>
        <ScrollArea className="max-h-[70vh]">
          <div className="space-y-6 px-6 py-5 text-sm">
            <section className="space-y-2">
              <h3 className="text-base font-semibold">In a nutshell</h3>
              <p className="text-muted-foreground">
                SkillManager reads and writes the same files Claude Code does
                under <code>~/.claude/</code>: <code>installed_plugins.json</code>,
                <code> known_marketplaces.json</code>, <code>settings.json</code>
                (the <code>enabledPlugins</code> map) and the per-skill folders
                under <code>~/.claude/skills/</code>. Anything you do in this
                app is something Claude Code itself would have done — only the
                UI changes.
              </p>
            </section>

            <section className="space-y-2">
              <h3 className="text-base font-semibold">The four tabs</h3>
              <ul className="space-y-3">
                <li className="flex gap-3">
                  <LayoutDashboard className="mt-0.5 h-4 w-4 shrink-0 text-primary" />
                  <div>
                    <div className="font-medium">Overview</div>
                    <div className="text-xs text-muted-foreground">
                      Counts (marketplaces / plugins / skills), GitHub auth
                      status, rate-limit budget. A snapshot, no actions.
                    </div>
                  </div>
                </li>
                <li className="flex gap-3">
                  <Package className="mt-0.5 h-4 w-4 shrink-0 text-primary" />
                  <div>
                    <div className="font-medium">Plugins</div>
                    <div className="text-xs text-muted-foreground">
                      Tree of marketplaces → plugins → skills. Install, update,
                      uninstall, or toggle a plugin's <em>enabled</em> flag
                      (which is the only thing Claude Code looks at when
                      deciding whether to load it).
                    </div>
                  </div>
                </li>
                <li className="flex gap-3">
                  <Sparkles className="mt-0.5 h-4 w-4 shrink-0 text-primary" />
                  <div>
                    <div className="font-medium">Skills</div>
                    <div className="text-xs text-muted-foreground">
                      Flat skill search across plugins + your local
                      <code> ~/.claude/skills/</code> folder. The Duplicate
                      panel calls out local skills that also exist inside an
                      installed plugin (so you can archive the local copy and
                      keep the one Claude Code prefers). Archived skills can be
                      restored at any time.
                    </div>
                  </div>
                </li>
                <li className="flex gap-3">
                  <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0 text-primary" />
                  <div>
                    <div className="font-medium">Admin</div>
                    <div className="text-xs text-muted-foreground">
                      <strong>Local</strong> — manage marketplaces and bulk
                      installs without touching GitHub.{" "}
                      <strong>Distant</strong> — push registry changes (add
                      plugin, bump version, upload a skill, delete a skill)
                      through GitHub Pull Requests. <strong>PR history</strong>{" "}
                      — track the PRs SkillManager opened and refresh their
                      status (open / merged / closed).
                    </div>
                  </div>
                </li>
              </ul>
            </section>

            <section className="space-y-2">
              <h3 className="text-base font-semibold flex items-center gap-2">
                <Github className="h-4 w-4" />
                GitHub token
              </h3>
              <div className="text-muted-foreground">
                Required to install plugins from private repos and to use the
                Admin → Distant workflows. A classic PAT with the{" "}
                <code>repo</code> scope works, as does a fine-grained token
                with <code>Contents: write</code> +{" "}
                <code>Pull requests: write</code> on the target repos. Stored
                in <code>config/config.properties</code> alongside the exe —
                never written to <code>%APPDATA%</code>.
              </div>
            </section>

            <section className="space-y-2">
              <h3 className="text-base font-semibold flex items-center gap-2">
                <Globe className="h-4 w-4" />
                Marketplace vs plugin
              </h3>
              <div className="text-muted-foreground">
                A <em>marketplace</em> is just a GitHub repo whose{" "}
                <code>.claude-plugin/marketplace.json</code> lists plugins. Each
                plugin's <code>source</code> usually points to a different
                GitHub repo where the plugin code lives. Installing a plugin
                downloads the zipball of <em>that</em> repo into{" "}
                <code>~/.claude/plugins/cache/&lt;mp&gt;/&lt;plugin&gt;/&lt;version&gt;/</code>.
              </div>
            </section>

            <section className="space-y-2">
              <h3 className="text-base font-semibold flex items-center gap-2">
                <FolderOpen className="h-4 w-4" />
                Where files live
              </h3>
              <div className="space-y-1 text-xs">
                <div>
                  <strong>App state (portable, next to the exe)</strong>
                </div>
                <ul className="ml-4 list-disc text-muted-foreground">
                  <li>
                    <code>config/config.properties</code> — token, polling, UI
                    prefs
                  </li>
                  <li>
                    <code>config/logging.properties</code> — log enable/level/
                    rotation
                  </li>
                  <li>
                    <code>config/marketplaces.json</code> — list of registered
                    marketplaces
                  </li>
                  <li>
                    <code>config/pr_history.json</code> +{" "}
                    <code>config/pending_prs.json</code> — admin workflow state
                  </li>
                  <li>
                    <code>logs/skillmanager.YYYY-MM-DD.log</code> — daily
                    rolling log file
                  </li>
                </ul>
                <div className="pt-2">
                  <strong>Claude Code state (under ~/.claude/)</strong>
                </div>
                <ul className="ml-4 list-disc text-muted-foreground">
                  <li>
                    <code>plugins/installed_plugins.json</code> — what's
                    installed
                  </li>
                  <li>
                    <code>plugins/known_marketplaces.json</code> — registered
                    marketplaces (incl. <code>autoUpdate</code> flag)
                  </li>
                  <li>
                    <code>plugins/cache/…</code> — actual plugin contents
                  </li>
                  <li>
                    <code>settings.json</code> →{" "}
                    <code>enabledPlugins["&lt;plugin&gt;@&lt;mp&gt;"]</code>
                  </li>
                  <li>
                    <code>skills/&lt;name&gt;/</code> — your standalone user
                    skills
                  </li>
                </ul>
              </div>
            </section>

            <section className="space-y-2">
              <h3 className="text-base font-semibold flex items-center gap-2">
                <Keyboard className="h-4 w-4" />
                Keyboard shortcuts
              </h3>
              <ul className="space-y-1 text-muted-foreground">
                <li>
                  <kbd className="rounded border px-1 text-[10px]">Ctrl</kbd>+
                  <kbd className="rounded border px-1 text-[10px]">K</kbd>
                  &nbsp;— Command palette (jump to any page / plugin / skill)
                </li>
                <li>
                  Refresh button in the sidebar — re-scans local install +
                  re-fetches remote registries
                </li>
                <li>
                  Theme button in the sidebar — cycles light → dark → auto
                </li>
              </ul>
            </section>

            <section className="space-y-2">
              <h3 className="text-base font-semibold flex items-center gap-2">
                <HardDrive className="h-4 w-4" />
                Portability
              </h3>
              <div className="text-muted-foreground">
                Zip the SkillManager folder and move it — your token,
                marketplace list, PR history and logs come with you. Nothing is
                written to <code>%APPDATA%</code> (a one-shot migration is run
                if a legacy blob is found there).
              </div>
            </section>

            <section className="space-y-2">
              <h3 className="text-base font-semibold flex items-center gap-2">
                <Bug className="h-4 w-4" />
                Reporting an issue
              </h3>
              <div className="text-muted-foreground">
                Open Settings → Logging → <em>View logs</em>, or grab the file
                at <code>logs/skillmanager.&lt;today&gt;.log</code>. Backend
                operations (install / uninstall / PR submission / settings
                changes) and frontend errors are both written there. Including
                the relevant snippet in a bug report saves a lot of guessing.
              </div>
            </section>
          </div>
        </ScrollArea>
      </DialogContent>
    </Dialog>
  );
}

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
            SkillManager — comment ça marche
            {version && (
              <Badge variant="outline" className="ml-auto font-mono text-[11px]">
                v{version}
              </Badge>
            )}
          </DialogTitle>
          <DialogDescription>
            Une interface portable pour les plugins, marketplaces et skills de
            Claude Code. Rien ici n'appelle <code>git</code>, <code>gh</code> ou{" "}
            <code>claude</code> — tout passe par l'API REST GitHub.
          </DialogDescription>
        </DialogHeader>
        <ScrollArea className="max-h-[70vh]">
          <div className="space-y-6 px-6 py-5 text-sm">
            <section className="space-y-2">
              <h3 className="text-base font-semibold">En résumé</h3>
              <p className="text-muted-foreground">
                SkillManager lit et écrit les mêmes fichiers que Claude Code
                sous <code>~/.claude/</code> : <code>installed_plugins.json</code>,
                <code> known_marketplaces.json</code>, <code>settings.json</code>
                (la map <code>enabledPlugins</code>) et les dossiers par skill
                sous <code>~/.claude/skills/</code>. Tout ce que tu fais dans
                cette app, Claude Code l'aurait fait lui-même — seule l'interface
                change.
              </p>
            </section>

            <section className="space-y-2">
              <h3 className="text-base font-semibold">Les quatre onglets</h3>
              <ul className="space-y-3">
                <li className="flex gap-3">
                  <LayoutDashboard className="mt-0.5 h-4 w-4 shrink-0 text-primary" />
                  <div>
                    <div className="font-medium">Aperçu</div>
                    <div className="text-xs text-muted-foreground">
                      Compteurs (marketplaces / plugins / skills), état d'auth
                      GitHub, budget de quota. Un aperçu, aucune action.
                    </div>
                  </div>
                </li>
                <li className="flex gap-3">
                  <Package className="mt-0.5 h-4 w-4 shrink-0 text-primary" />
                  <div>
                    <div className="font-medium">Plugins</div>
                    <div className="text-xs text-muted-foreground">
                      Arborescence des marketplaces → plugins → skills. Installer,
                      mettre à jour, désinstaller, ou basculer l'indicateur{" "}
                      <em>activé</em> d'un plugin (la seule chose que Claude Code
                      regarde pour décider s'il doit le charger).
                    </div>
                  </div>
                </li>
                <li className="flex gap-3">
                  <Sparkles className="mt-0.5 h-4 w-4 shrink-0 text-primary" />
                  <div>
                    <div className="font-medium">Skills</div>
                    <div className="text-xs text-muted-foreground">
                      Recherche à plat des skills dans les plugins + ton dossier
                      local <code> ~/.claude/skills/</code>. Le panneau Doublons
                      signale les skills locaux qui existent aussi dans un plugin
                      installé (pour que tu puisses archiver la copie locale et
                      garder celle que Claude Code préfère). Les skills archivés
                      peuvent être restaurés à tout moment.
                    </div>
                  </div>
                </li>
                <li className="flex gap-3">
                  <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0 text-primary" />
                  <div>
                    <div className="font-medium">Admin</div>
                    <div className="text-xs text-muted-foreground">
                      <strong>Local</strong> — gérer les marketplaces et les
                      installations en masse sans toucher à GitHub.{" "}
                      <strong>Distant</strong> — pousser des changements de
                      registre (ajouter un plugin, incrémenter une version,
                      envoyer un skill, supprimer un skill) via des Pull Requests
                      GitHub. <strong>Historique des PR</strong>{" "}
                      — suivre les PR ouvertes par SkillManager et rafraîchir
                      leur statut (ouverte / mergée / fermée).
                    </div>
                  </div>
                </li>
              </ul>
            </section>

            <section className="space-y-2">
              <h3 className="text-base font-semibold flex items-center gap-2">
                <Github className="h-4 w-4" />
                Token GitHub
              </h3>
              <div className="text-muted-foreground">
                Requis pour installer des plugins depuis des repos privés et
                pour utiliser les workflows Admin → Distant. Un PAT classique
                avec le scope <code>repo</code> fonctionne, tout comme un token
                fine-grained avec <code>Contents: write</code> +{" "}
                <code>Pull requests: write</code> sur les repos cibles. Stocké
                dans <code>config/config.properties</code> à côté de l'exe —
                jamais écrit dans <code>%APPDATA%</code>.
              </div>
            </section>

            <section className="space-y-2">
              <h3 className="text-base font-semibold flex items-center gap-2">
                <Globe className="h-4 w-4" />
                Marketplace vs plugin
              </h3>
              <div className="text-muted-foreground">
                Un <em>marketplace</em> est simplement un repo GitHub dont le{" "}
                <code>.claude-plugin/marketplace.json</code> liste les plugins.
                Le <code>source</code> de chaque plugin pointe généralement vers
                un autre repo GitHub où vit le code du plugin. Installer un
                plugin télécharge le zipball de <em>ce</em> repo dans{" "}
                <code>~/.claude/plugins/cache/&lt;mp&gt;/&lt;plugin&gt;/&lt;version&gt;/</code>.
              </div>
            </section>

            <section className="space-y-2">
              <h3 className="text-base font-semibold flex items-center gap-2">
                <FolderOpen className="h-4 w-4" />
                Où vivent les fichiers
              </h3>
              <div className="space-y-1 text-xs">
                <div>
                  <strong>État de l'app (portable, à côté de l'exe)</strong>
                </div>
                <ul className="ml-4 list-disc text-muted-foreground">
                  <li>
                    <code>config/config.properties</code> — token, polling,
                    préférences UI
                  </li>
                  <li>
                    <code>config/logging.properties</code> — activation/niveau/
                    rotation des logs
                  </li>
                  <li>
                    <code>config/marketplaces.json</code> — liste des
                    marketplaces enregistrés
                  </li>
                  <li>
                    <code>config/pr_history.json</code> +{" "}
                    <code>config/pending_prs.json</code> — état du workflow admin
                  </li>
                  <li>
                    <code>logs/skillmanager.YYYY-MM-DD.log</code> — fichier de
                    log à rotation quotidienne
                  </li>
                </ul>
                <div className="pt-2">
                  <strong>État de Claude Code (sous ~/.claude/)</strong>
                </div>
                <ul className="ml-4 list-disc text-muted-foreground">
                  <li>
                    <code>plugins/installed_plugins.json</code> — ce qui est
                    installé
                  </li>
                  <li>
                    <code>plugins/known_marketplaces.json</code> — marketplaces
                    enregistrés (incl. l'indicateur <code>autoUpdate</code>)
                  </li>
                  <li>
                    <code>plugins/cache/…</code> — contenu réel des plugins
                  </li>
                  <li>
                    <code>settings.json</code> →{" "}
                    <code>enabledPlugins["&lt;plugin&gt;@&lt;mp&gt;"]</code>
                  </li>
                  <li>
                    <code>skills/&lt;name&gt;/</code> — tes skills utilisateur
                    autonomes
                  </li>
                </ul>
              </div>
            </section>

            <section className="space-y-2">
              <h3 className="text-base font-semibold flex items-center gap-2">
                <Keyboard className="h-4 w-4" />
                Raccourcis clavier
              </h3>
              <ul className="space-y-1 text-muted-foreground">
                <li>
                  <kbd className="rounded border px-1 text-[10px]">Ctrl</kbd>+
                  <kbd className="rounded border px-1 text-[10px]">K</kbd>
                  &nbsp;— Palette de commandes (accède à n'importe quelle page /
                  plugin / skill)
                </li>
                <li>
                  Bouton Rafraîchir dans la barre — re-scanne l'installation
                  locale + récupère à nouveau les registres distants
                </li>
                <li>
                  Bouton Thème dans la barre — bascule clair → sombre → auto
                </li>
              </ul>
            </section>

            <section className="space-y-2">
              <h3 className="text-base font-semibold flex items-center gap-2">
                <HardDrive className="h-4 w-4" />
                Portabilité
              </h3>
              <div className="text-muted-foreground">
                Zippe le dossier SkillManager et déplace-le — ton token, ta
                liste de marketplaces, l'historique des PR et les logs te
                suivent. Rien n'est écrit dans <code>%APPDATA%</code> (une
                migration unique est lancée si un ancien blob y est trouvé).
              </div>
            </section>

            <section className="space-y-2">
              <h3 className="text-base font-semibold flex items-center gap-2">
                <Bug className="h-4 w-4" />
                Signaler un problème
              </h3>
              <div className="text-muted-foreground">
                Ouvre Paramètres → Logging → <em>Voir les logs</em>, ou récupère
                le fichier <code>logs/skillmanager.&lt;aujourd'hui&gt;.log</code>.
                Les opérations backend (installation / désinstallation / envoi
                de PR / changements de paramètres) et les erreurs frontend y sont
                toutes écrites. Inclure l'extrait pertinent dans un rapport de
                bug évite bien des devinettes.
              </div>
            </section>
          </div>
        </ScrollArea>
      </DialogContent>
    </Dialog>
  );
}

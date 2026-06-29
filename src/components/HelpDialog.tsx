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
              <Badge variant="outline" className="ml-auto font-mono text-xs">
                v{version}
              </Badge>
            )}
          </DialogTitle>
          <DialogDescription>
            Une interface portable pour les plugins, marketplaces et skills de
            Claude Code. Rien ici n'appelle <code>git</code>, <code>gh</code> ou{" "}
            <code>claude</code> — tout passe par l'API REST de GitHub ou de Gitea.
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
                sous <code>~/.claude/skills/</code>. Tout ce que vous faites dans
                cette app, Claude Code l'aurait fait lui-même — seule l'interface
                change.
              </p>
            </section>

            <section className="space-y-2">
              <h3 className="text-base font-semibold">Les trois onglets</h3>
              <ul className="space-y-3">
                <li className="flex gap-3">
                  <LayoutDashboard className="mt-0.5 h-4 w-4 shrink-0 text-primary" />
                  <div>
                    <div className="font-medium">Dashboard</div>
                    <div className="text-xs text-muted-foreground">
                      Vue d'ensemble : compteurs (marketplaces / plugins /
                      skills), état des connexions GitHub et Gitea, plugins{" "}
                      <em>à traiter</em> (mises à jour disponibles), suivi des PR
                      des marketplaces, et activité récente. Un aperçu, peu
                      d'actions.
                    </div>
                  </div>
                </li>
                <li className="flex gap-3">
                  <Sparkles className="mt-0.5 h-4 w-4 shrink-0 text-primary" />
                  <div>
                    <div className="font-medium">Skills</div>
                    <div className="text-xs text-muted-foreground">
                      L'écran principal. Une arborescence unifiée{" "}
                      <strong>marketplace → plugin → skills</strong> : installer,
                      mettre à jour, désinstaller ou activer un plugin (l'indicateur{" "}
                      <em>activé</em> est la seule chose que Claude Code regarde
                      pour décider de charger un pack). En sélectionnant une
                      compétence, son <code>SKILL.md</code> s'affiche directement à
                      droite. Les panneaux <em>Doublons</em> et <em>Archivés</em>{" "}
                      aident à garder une seule copie de chaque compétence. Un
                      filtre permet de n'afficher que les compétences installées ou
                      non.
                    </div>
                  </div>
                </li>
                <li className="flex gap-3">
                  <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0 text-primary" />
                  <div>
                    <div className="font-medium">Administration</div>
                    <div className="text-xs text-muted-foreground">
                      <strong>Proposer une amélioration</strong> — pousser des
                      changements de registre (ajouter un plugin, incrémenter une
                      version, envoyer ou supprimer un skill) via des Pull
                      Requests. <strong>Suivi Marketplace</strong> — suivre les PR
                      ouvertes sur les marketplaces que vous surveillez et leurs
                      plugins. (La gestion locale des marketplaces et plugins se
                      fait dans l'onglet <strong>Skills</strong>.)
                    </div>
                  </div>
                </li>
              </ul>
            </section>

            <section className="space-y-2">
              <h3 className="text-base font-semibold flex items-center gap-2">
                <Github className="h-4 w-4" />
                Connexions (GitHub & Gitea)
              </h3>
              <div className="text-muted-foreground">
                Un <strong>token GitHub</strong> est requis pour installer des
                plugins depuis des repos privés et pour <em>Proposer une
                amélioration</em>. Un PAT classique avec le scope <code>repo</code>{" "}
                fonctionne, tout comme un token fine-grained avec{" "}
                <code>Contents: write</code> + <code>Pull requests: write</code>{" "}
                sur les repos cibles. Pour la marketplace interne AlmaviaCX,
                ajoutez une <strong>instance Gitea</strong> (URL + token) et
                activez le VPN GlobalProtect. Les <strong>tokens</strong> sont
                conservés dans le coffre d'identifiants Windows (chiffré DPAPI) ;
                les autres réglages vivent dans{" "}
                <code>config/config.properties</code> à côté de l'exe — jamais
                dans <code>%APPDATA%</code>. Réglages dans{" "}
                <strong>Paramètres → Connexions</strong>.
              </div>
            </section>

            <section className="space-y-2">
              <h3 className="text-base font-semibold flex items-center gap-2">
                <Globe className="h-4 w-4" />
                Marketplace vs plugin
              </h3>
              <div className="text-muted-foreground">
                Un <em>marketplace</em> est simplement un repo dont le{" "}
                <code>.claude-plugin/marketplace.json</code> liste les plugins.
                Le <code>source</code> de chaque plugin pointe généralement vers
                un autre repo où vit le code du plugin. Installer un plugin
                télécharge l'archive de <em>ce</em> repo dans{" "}
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
                    <code>config/config.properties</code> — polling, préférences
                    UI (le token n'y est <strong>pas</strong>)
                  </li>
                  <li>
                    Coffre d'identifiants Windows — tokens GitHub &amp; Gitea
                    (chiffré DPAPI, hors du dossier portable)
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
                    <code>skills/&lt;name&gt;/</code> — vos skills utilisateur
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
                  <kbd className="rounded border px-1 text-xs">Ctrl</kbd>+
                  <kbd className="rounded border px-1 text-xs">K</kbd>
                  &nbsp;— Palette de commandes (accédez à n'importe quelle page /
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
                Zippez le dossier SkillManager et déplacez-le — votre liste de
                marketplaces, l'historique des PR et les logs vous suivent. Seul
                le <strong>token</strong> reste sur la machine (coffre
                d'identifiants Windows, lié au compte) : reconfigurez-le sur le
                nouveau poste. Rien n'est écrit dans <code>%APPDATA%</code>.
              </div>
            </section>

            <section className="space-y-2">
              <h3 className="text-base font-semibold flex items-center gap-2">
                <Bug className="h-4 w-4" />
                Signaler un problème
              </h3>
              <div className="text-muted-foreground">
                Ouvrez Paramètres → Logs → <em>Voir les logs</em>, ou récupérez
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

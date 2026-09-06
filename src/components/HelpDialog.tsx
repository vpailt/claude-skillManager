import { useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { ScrollArea } from "@/components/ui/scroll-area";
import { ScrollFade } from "@/components/ScrollFade";
import { Badge } from "@/components/ui/badge";
import {
  BarChart3,
  Bug,
  FolderOpen,
  Github,
  Globe,
  HardDrive,
  History,
  Keyboard,
  LayoutDashboard,
  Radar,
  ScrollText,
  Sparkles,
  UploadCloud,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { useAppVersion } from "@/hooks/useAppVersion";

interface HelpDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

type Tab = "overview" | "connexions" | "raccourcis" | "fichiers";

const TABS: { id: Tab; label: string }[] = [
  { id: "overview", label: "Vue d'ensemble" },
  { id: "connexions", label: "Connexions" },
  { id: "raccourcis", label: "Raccourcis" },
  { id: "fichiers", label: "Fichiers" },
];

/** One keyboard shortcut, as a table row. */
function Shortcut({ keys, children }: { keys: string[]; children: React.ReactNode }) {
  return (
    <tr className="border-b last:border-0">
      <td className="whitespace-nowrap py-1.5 pr-4 align-top">
        {keys.map((k, i) => (
          <span key={k}>
            {i > 0 && <span className="px-0.5 text-muted-foreground">+</span>}
            <kbd className="rounded border bg-muted px-1.5 py-0.5 font-mono text-xs">
              {k}
            </kbd>
          </span>
        ))}
      </td>
      <td className="py-1.5 align-top text-muted-foreground">{children}</td>
    </tr>
  );
}

function Section({
  icon: Icon,
  title,
  children,
}: {
  icon?: typeof Globe;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <section className="space-y-2">
      <h3 className="flex items-center gap-2 text-base font-semibold">
        {Icon && <Icon className="h-4 w-4" />}
        {title}
      </h3>
      {children}
    </section>
  );
}

function TabRow({
  icon: Icon,
  name,
  children,
}: {
  icon: typeof Globe;
  name: string;
  children: React.ReactNode;
}) {
  return (
    <li className="flex gap-3">
      <Icon className="mt-0.5 h-4 w-4 shrink-0 text-primary" />
      <div>
        <div className="font-medium">{name}</div>
        <div className="text-xs text-muted-foreground">{children}</div>
      </div>
    </li>
  );
}

/**
 * What the app is, tab by tab. Four panes rather than one long scroll: the
 * three questions people actually arrive with — what does this do, why is my
 * forge not connected, what are the shortcuts — were separated by a page of
 * text each. Reached from the title bar's `?`, and from F1.
 */
export function HelpDialog({ open, onOpenChange }: HelpDialogProps) {
  const version = useAppVersion();
  const [tab, setTab] = useState<Tab>("overview");

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

        <div role="tablist" className="flex gap-1 border-b px-4 pt-2">
          {TABS.map((t) => (
            <button
              key={t.id}
              type="button"
              role="tab"
              aria-selected={tab === t.id}
              onClick={() => setTab(t.id)}
              className={cn(
                "-mb-px border-b-2 px-3 py-2 text-sm transition-colors",
                tab === t.id
                  ? "border-primary font-medium text-foreground"
                  : "border-transparent text-muted-foreground hover:text-foreground"
              )}
            >
              {t.label}
            </button>
          ))}
        </div>
        <ScrollFade className="max-h-[65vh]" wraps>
          <ScrollArea className="max-h-[65vh]">
          <div className="space-y-6 px-6 py-5 text-sm" role="tabpanel">
            {tab === "overview" && (
              <>
                <Section title="À quoi sert cette application">
                  <p className="text-muted-foreground">
                    SkillManager lit et écrit les mêmes fichiers que Claude Code
                    sous <code>~/.claude/</code> : <code>installed_plugins.json</code>,
                    <code> known_marketplaces.json</code>, <code>settings.json</code>{" "}
                    (la map <code>enabledPlugins</code>) et les dossiers par skill
                    sous <code>~/.claude/skills/</code>. Tout ce que vous faites
                    ici, Claude Code l'aurait fait lui-même — seule l'interface
                    change. Elle y ajoute ce que la ligne de commande ne donne
                    pas : une vue d'ensemble de ce qui est installé, la détection
                    de ce qui a bougé en local ou en amont, et la publication de
                    vos modifications sous forme de Pull Request.
                  </p>
                </Section>

                <Section title="Les onglets">
                  <ul className="space-y-3">
                    <TabRow icon={LayoutDashboard} name="Dashboard">
                      Vue d'ensemble : compteurs (marketplaces / plugins /
                      skills), plugins <em>à traiter</em> (mises à jour
                      disponibles), suivi des PR des marketplaces, et activité
                      récente. Un aperçu, peu d'actions.
                    </TabRow>
                    <TabRow icon={Sparkles} name="Skills">
                      L'écran principal. Une arborescence unifiée{" "}
                      <strong>marketplace → plugin → skills</strong> : installer,
                      mettre à jour, désinstaller ou activer un plugin
                      (l'indicateur <em>activé</em> est la seule chose que Claude
                      Code regarde pour décider de charger un pack). En
                      sélectionnant une compétence, son <code>SKILL.md</code>{" "}
                      s'affiche à droite. Les panneaux <em>Doublons</em> et{" "}
                      <em>Archivés</em> aident à garder une seule copie de chaque
                      compétence, et un filtre restreint l'arbre à ce qui est
                      installé — ou à ce qui ne l'est pas.
                    </TabRow>
                    <TabRow icon={UploadCloud} name="Changements">
                      Tout ce que vous avez modifié, ajouté ou supprimé
                      localement dans un plugin installé, groupé par plugin :
                      <strong> un groupe = une Pull Request</strong>, avec son
                      propre niveau de version et ses notes. Les suppressions
                      voyagent dans la même PR que les modifications du même
                      plugin. Le diff est consultable avant publication.
                    </TabRow>
                    <TabRow icon={Radar} name="Suivi marketplace">
                      Les Pull Requests ouvertes sur les marketplaces que vous
                      surveillez et sur leurs plugins, séparées en{" "}
                      <em>mes demandes</em> et <em>demandes à valider</em>. Pour
                      proposer un changement, passez par l'onglet{" "}
                      <strong>Changements</strong>.
                    </TabRow>
                    <TabRow icon={BarChart3} name="Audit d'utilisation">
                      Ce qui sert vraiment : top plugins, plugins jamais
                      utilisés, et le détail par skill (nombre d'utilisations,
                      projets concernés) sur une plage de dates, exportable en
                      Excel. Reconstruit depuis les transcripts de session
                      locaux — aucune télémétrie, rien ne sort de la machine.
                    </TabRow>
                    <TabRow icon={History} name="Activité récente">
                      Installations, désinstallations, PR, exports et mises à
                      jour, horodatés et filtrables. Lue depuis les fichiers de
                      log : ce que la page montre est ce qu'un rapport de bug
                      contiendrait.
                    </TabRow>
                    <TabRow icon={ScrollText} name="Logs">
                      Le contenu brut des journaux, un fichier par jour, avec
                      filtre par niveau, par plage horaire et recherche plein
                      texte.
                    </TabRow>
                  </ul>
                </Section>

                <Section icon={Globe} title="Marketplace vs plugin">
                  <div className="text-muted-foreground">
                    Un <em>marketplace</em> est un <strong>index</strong>, pas un
                    conteneur : un repo dont le{" "}
                    <code>.claude-plugin/marketplace.json</code> liste des
                    plugins. Le <code>source</code> de chaque plugin pointe
                    presque toujours vers <em>un autre repo</em>, celui où le
                    plugin vit réellement.
                    <div className="mt-2 rounded-md border bg-muted/40 p-3 text-xs">
                      <div>
                        <strong>Installer un marketplace</strong> = récupérer
                        l'index, donc la <em>liste</em> de ce qui est
                        disponible. Rien n'est encore utilisable par Claude Code.
                      </div>
                      <div className="mt-1.5">
                        <strong>Installer un plugin</strong> = lire son{" "}
                        <code>source</code> dans l'index, télécharger l'archive
                        de <em>ce</em> repo-là, et l'extraire dans{" "}
                        <code>
                          ~/.claude/plugins/cache/&lt;mp&gt;/&lt;plugin&gt;/&lt;version&gt;/
                        </code>
                        .
                      </div>
                    </div>
                    Un même plugin peut donc être listé par plusieurs
                    marketplaces, et mettre à jour un marketplace ne met à jour
                    aucun plugin — cela ne fait qu'actualiser le catalogue.
                  </div>
                </Section>
              </>
            )}

            {tab === "connexions" && (
              <>
                <Section icon={Github} title="GitHub">
                  <div className="text-muted-foreground">
                    Un <strong>token</strong> est requis pour installer des
                    plugins depuis des repos privés et pour publier vos
                    changements depuis l'onglet <strong>Changements</strong>. Un
                    PAT classique avec le scope <code>repo</code> fonctionne,
                    tout comme un token fine-grained avec{" "}
                    <code>Contents: write</code> +{" "}
                    <code>Pull requests: write</code> sur les repos cibles.
                    <div className="mt-2 text-xs">
                      Sans token, la lecture publique reste possible mais le
                      quota tombe à 60 requêtes par heure et par adresse IP — ce
                      que la barre d'état signale quand il s'épuise.
                    </div>
                  </div>
                </Section>

                <Section icon={Globe} title="Gitea">
                  <div className="text-muted-foreground">
                    Pour une marketplace interne, ajoutez une{" "}
                    <strong>instance Gitea</strong> (URL + token) dans{" "}
                    <strong>Paramètres → Connexions</strong>. L'instance interne
                    AlmaviaCX exige le <strong>VPN GlobalProtect</strong> et une
                    autorité de certification interne : la vérification TLS y est
                    désactivée par défaut, ce qui reste modifiable par
                    instance.
                    <div className="mt-2 text-xs">
                      La forge d'un marketplace est déduite de l'URL que vous
                      collez, jamais d'un réglage : un lien{" "}
                      <code>github.com</code> est enregistré sur GitHub même si
                      une instance Gitea est configurée.
                    </div>
                  </div>
                </Section>

                <Section title="Où vivent les tokens">
                  <div className="text-muted-foreground">
                    Dans le <strong>coffre d'identifiants Windows</strong>
                    (chiffré DPAPI, lié au compte), jamais sur le disque à côté
                    de l'application. Les autres réglages vivent dans{" "}
                    <code>config/config.properties</code>, à côté de l'exe — rien
                    n'est écrit dans <code>%APPDATA%</code>. En déplaçant le
                    dossier sur une autre machine, le token est donc la seule
                    chose à ressaisir.
                  </div>
                </Section>

                <Section title="Quand ça ne se connecte pas">
                  <div className="text-muted-foreground">
                    La <strong>barre d'état</strong>, en bas, porte un segment
                    par forge : vert connecté, rouge non. Un clic dessus ouvre
                    directement le bon onglet des paramètres. Après avoir
                    rebranché le VPN, utilisez <strong>Rafraîchir</strong> dans
                    la barre latérale : un hôte injoignable est mis de côté
                    quatre-vingt-dix secondes pour ne pas geler l'application, et
                    ce bouton remet le compteur à zéro immédiatement.
                  </div>
                </Section>
              </>
            )}

            {tab === "raccourcis" && (
              <>
                <Section icon={Keyboard} title="Raccourcis clavier">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="border-b text-xs uppercase tracking-wide text-muted-foreground">
                        <th className="w-40 py-1.5 pr-4 text-left font-medium">
                          Raccourci
                        </th>
                        <th className="py-1.5 text-left font-medium">Action</th>
                      </tr>
                    </thead>
                    <tbody>
                      <Shortcut keys={["Ctrl", "K"]}>
                        Placer le curseur dans la recherche, en haut de la
                        fenêtre — pages, marketplaces, plugins et skills, y
                        compris leur description
                      </Shortcut>
                      <Shortcut keys={["Ctrl", "B"]}>
                        Replier ou déplier la barre latérale
                      </Shortcut>
                      <Shortcut keys={["Ctrl", ","]}>Ouvrir les paramètres</Shortcut>
                      <Shortcut keys={["F1"]}>Ouvrir cette aide</Shortcut>
                      <Shortcut keys={["↑", "↓"]}>
                        Parcourir les résultats de la recherche
                      </Shortcut>
                      <Shortcut keys={["Entrée"]}>
                        Ouvrir le résultat sélectionné
                      </Shortcut>
                      <Shortcut keys={["Échap"]}>
                        Fermer la recherche, un menu ou une boîte de dialogue
                      </Shortcut>
                    </tbody>
                  </table>
                </Section>

                <Section title="À la souris">
                  <table className="w-full text-sm">
                    <tbody>
                      <tr className="border-b">
                        <td className="w-40 whitespace-nowrap py-1.5 pr-4 align-top font-medium">
                          Bord de la barre latérale
                        </td>
                        <td className="py-1.5 align-top text-muted-foreground">
                          Glisser pour régler la largeur ; sous 140 px, relâcher
                          la replie en icônes. Double-clic : replier ou déplier.
                        </td>
                      </tr>
                      <tr className="border-b">
                        <td className="w-40 whitespace-nowrap py-1.5 pr-4 align-top font-medium">
                          Version, en bas à gauche
                        </td>
                        <td className="py-1.5 align-top text-muted-foreground">
                          Ouvre l'historique des versions — et permet d'en
                          réinstaller une.
                        </td>
                      </tr>
                      <tr className="border-b">
                        <td className="w-40 whitespace-nowrap py-1.5 pr-4 align-top font-medium">
                          Maj + clic dans l'arbre
                        </td>
                        <td className="py-1.5 align-top text-muted-foreground">
                          Sélectionner une plage de lignes, pour une action
                          groupée.
                        </td>
                      </tr>
                      <tr>
                        <td className="w-40 whitespace-nowrap py-1.5 pr-4 align-top font-medium">
                          Rafraîchir
                        </td>
                        <td className="py-1.5 align-top text-muted-foreground">
                          Re-scanne l'installation locale et interroge à nouveau
                          les forges, en oubliant les hôtes mis de côté.
                        </td>
                      </tr>
                    </tbody>
                  </table>
                </Section>
              </>
            )}

            {tab === "fichiers" && (
              <>
                <Section icon={FolderOpen} title="Où vivent les fichiers">
                  <div className="space-y-1 text-xs">
                    <div>
                      <strong>État de l'app (portable, à côté de l'exe)</strong>
                    </div>
                    <ul className="ml-4 list-disc text-muted-foreground">
                      <li>
                        <code>config/config.properties</code> — polling,
                        préférences UI (le token n'y est <strong>pas</strong>)
                      </li>
                      <li>
                        Coffre d'identifiants Windows — tokens GitHub &amp; Gitea
                        (chiffré DPAPI, hors du dossier portable)
                      </li>
                      <li>
                        <code>config/logging.properties</code> —
                        activation/niveau/rotation des logs
                      </li>
                      <li>
                        <code>config/marketplaces.json</code> — liste des
                        marketplaces enregistrés
                      </li>
                      <li>
                        <code>config/pr_history.json</code> +{" "}
                        <code>config/pending_prs.json</code> — état du workflow
                        admin
                      </li>
                      <li>
                        <code>logs/skillmanager.YYYY-MM-DD.log</code> — fichier
                        de log à rotation quotidienne
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
                        <code>plugins/known_marketplaces.json</code> —
                        marketplaces enregistrés (incl. l'indicateur{" "}
                        <code>autoUpdate</code>)
                      </li>
                      <li>
                        <code>plugins/cache/…</code> — contenu réel des plugins
                      </li>
                      <li>
                        <code>settings.json</code> →{" "}
                        <code>enabledPlugins["&lt;plugin&gt;@&lt;mp&gt;"]</code>
                      </li>
                      <li>
                        <code>skills/&lt;name&gt;/</code> — vos skills
                        utilisateur autonomes
                      </li>
                    </ul>
                  </div>
                </Section>

                <Section icon={HardDrive} title="Portabilité">
                  <div className="text-muted-foreground">
                    Zippez le dossier SkillManager et déplacez-le — votre liste
                    de marketplaces, l'historique des PR et les logs vous
                    suivent. Seul le <strong>token</strong> reste sur la machine
                    (coffre d'identifiants Windows, lié au compte).
                    <div className="mt-2 text-xs">
                      À éviter : installer dans un dossier synchronisé (OneDrive,
                      Dropbox, un Bureau redirigé). Chaque écriture sous{" "}
                      <code>config/</code> déclencherait un envoi vers le nuage.
                    </div>
                  </div>
                </Section>

                <Section icon={Bug} title="Signaler un problème">
                  <div className="text-muted-foreground">
                    Ouvrez l'onglet <strong>Logs</strong>, ou récupérez le
                    fichier <code>logs/skillmanager.&lt;aujourd'hui&gt;.log</code>.
                    Les opérations backend (installation, désinstallation, envoi
                    de PR, changements de paramètres) et les erreurs frontend y
                    sont toutes écrites. Inclure l'extrait pertinent évite bien
                    des devinettes.
                  </div>
                </Section>
              </>
            )}
          </div>
          </ScrollArea>
        </ScrollFade>
      </DialogContent>
    </Dialog>
  );
}

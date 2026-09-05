// Add-marketplace-from-URL dialog.
//
// Registers a marketplace (GitHub or Gitea) into the app's settings by parsing
// `owner/repo` from a Git URL, then installs it locally in one step. Defaults to
// the AlmaviaCX Gitea instance and proposes its default marketplace. Self-
// contained: depends only on `parseMarketplaceUrl` + `settingsUpsertMarketplace`
// + `installMarketplace`, so it can be hosted from either the Admin-local panel
// or the Skills page.
import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { KeyRound, Loader2, Sparkles } from "lucide-react";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { api } from "@/lib/api";
import { useNotifications } from "@/stores/notifications";
import { useSettingsDialog } from "@/stores/settingsDialog";
import { forceRefresh } from "@/hooks/useRefresh";
import type { Provider } from "@/lib/types";

// The AlmaviaCX Gitea instance (fixed/auto-seeded) and its default marketplace.
const ACX_GITEA_URL = "https://git.almaviacx.local";
const ACX_GITEA_HOST = "git.almaviacx.local";
const DEFAULT_MARKETPLACE_URL = `${ACX_GITEA_URL}/Claude/acx-cl-marketplace`;

const hostOf = (url: string) =>
  url.trim().replace(/^https?:\/\//, "").split("/")[0];

export function AddMarketplaceDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const qc = useQueryClient();
  const notify = useNotifications((s) => s.push);
  const openSettingsTo = useSettingsDialog((s) => s.openTo);
  const settingsQuery = useQuery({
    queryKey: ["app-settings"],
    queryFn: api.loadAppSettings,
  });
  const giteaInstances = settingsQuery.data?.giteaInstances ?? [];

  // Gitea by default — this app is primarily an AlmaviaCX Gitea front-end.
  const [provider, setProvider] = useState<Provider>("gitea");
  const [giteaBaseUrl, setGiteaBaseUrl] = useState("");
  const [url, setUrl] = useState("");
  const [name, setName] = useState("");
  const [parsedRepo, setParsedRepo] = useState<string | null>(null);
  const [detectedHost, setDetectedHost] = useState("");
  // The URL's host matched neither github.com nor a registered Gitea instance.
  // There is no token for it and no instance record, so the install would 404
  // against whichever forge the toggle happened to be on.
  const [unknownHost, setUnknownHost] = useState(false);
  const [error, setError] = useState("");

  // When the dialog opens with no instance picked, default to the AlmaviaCX
  // instance (or the first registered one). Also re-runs once the settings query
  // resolves, so the preselection survives a slow first load.
  useEffect(() => {
    if (!open || provider !== "gitea" || giteaBaseUrl) return;
    const acx = giteaInstances.find((i) => hostOf(i.baseUrl) === ACX_GITEA_HOST);
    setGiteaBaseUrl(acx?.baseUrl ?? giteaInstances[0]?.baseUrl ?? "");
  }, [open, provider, giteaBaseUrl, giteaInstances]);

  const reset = () => {
    setProvider("gitea");
    setGiteaBaseUrl("");
    setUrl("");
    setName("");
    setParsedRepo(null);
    setDetectedHost("");
    setUnknownHost(false);
    setError("");
  };

  // Read the forge off the URL instead of off a toggle.
  //
  // The toggle defaulted to Gitea, so pasting a github.com URL without noticing
  // it registered the marketplace against the internal Gitea instance and tried
  // to download `owner/repo` from *there*. The URL already says which forge it
  // is — `owner/repo` parses identically on both, which is exactly why the
  // mismatch was silent up to the download.
  const parseUrlInto = async (value: string) => {
    setError("");
    const trimmed = value.trim();
    if (!trimmed) {
      setParsedRepo(null);
      setUnknownHost(false);
      return;
    }
    const guess = await api.guessForgeForUrl(trimmed);
    if (!guess.repo) {
      setError(`Impossible d'extraire owner/repo depuis : ${trimmed}`);
      setParsedRepo(null);
      setUnknownHost(false);
      return;
    }
    setParsedRepo(guess.repo);
    setUnknownHost(!guess.known);
    if (guess.known) {
      setProvider(guess.provider);
      setGiteaBaseUrl(guess.baseUrl);
      setDetectedHost(guess.host);
    } else {
      // An unknown host cannot be installed from: there is no token for it and
      // no instance record. Say so here rather than let the download 404.
      setDetectedHost("");
      setError(
        `Hôte inconnu : ${guess.host}. Enregistrez d'abord cette instance Gitea ` +
          `dans Paramètres → Connexions, ou utilisez une URL github.com.`
      );
    }
    if (!name.trim()) setName(guess.repo.split("/").pop() || "");
  };

  const onUrlBlur = () => parseUrlInto(url);

  // One-click "proposal": fill in the AlmaviaCX default marketplace and parse it.
  const proposeDefault = async () => {
    setUrl(DEFAULT_MARKETPLACE_URL);
    await parseUrlInto(DEFAULT_MARKETPLACE_URL);
  };

  const selectedInstance = giteaInstances.find(
    (i) => hostOf(i.baseUrl) === hostOf(giteaBaseUrl)
  );
  // Gitea needs a token to read/clone; block add+install until one is set.
  const giteaTokenMissing =
    provider === "gitea" && !!giteaBaseUrl && !selectedInstance?.hasToken;

  const goConfigureToken = () => {
    onOpenChange(false);
    openSettingsTo("connexions", "gitea");
  };

  const upsert = useMutation({
    mutationFn: async () => {
      if (!parsedRepo) throw new Error("L'URL est invalide");
      if (!name.trim()) throw new Error("Le nom du marketplace est requis");
      if (provider === "gitea" && !giteaBaseUrl) {
        throw new Error("Choisissez une instance Gitea (ajoutez-en une dans Paramètres d'abord)");
      }
      if (giteaTokenMissing) {
        throw new Error("Configurez d'abord votre token Gitea pour cette instance.");
      }
      const cfgName = name.trim();
      const baseUrl = provider === "gitea" ? giteaBaseUrl : "";
      // Ask the repo for its default branch rather than assuming `main`: a repo
      // on `master` (or anything else) was registered against a branch it does
      // not have, and every later read — registry, manifest, tree — resolved to
      // nothing while looking like a permission problem.
      const branch = await api.resolveDefaultBranch(parsedRepo, provider, baseUrl);
      // Register the marketplace with auto-update AND PR tracking ON by default.
      await api.settingsUpsertMarketplace({
        name: cfgName,
        githubRepo: parsedRepo,
        defaultBranch: branch,
        owned: false,
        sourcePath: "",
        autoUpdate: true,
        trackPrs: true,
        provider,
        baseUrl,
      });
      // Install it right away — download it locally and make it visible to
      // Claude Code, no separate "Installer" step.
      await api.installMarketplace(cfgName, parsedRepo, branch, true, provider, baseUrl);
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["app-settings"] });
      // "user", not "local": the backend reuses a recent sweep for background
      // triggers, and that result predates the marketplace we just created —
      // reusing it is precisely how an added marketplace ends up appearing
      // nowhere. The full mode also earns its cost here, since a brand-new
      // catalogue has no memoised versions at all and the whole point of adding
      // it is to see what is in it.
      forceRefresh(qc, "user");
      notify({
        kind: "success",
        title: "Marketplace ajouté et installé",
        body: name.trim(),
      });
      reset();
      onOpenChange(false);
    },
    onError: (e) => setError(e instanceof Error ? e.message : String(e)),
  });

  const blocked =
    !parsedRepo ||
    unknownHost ||
    !name.trim() ||
    (provider === "gitea" && !giteaBaseUrl) ||
    giteaTokenMissing ||
    upsert.isPending;

  return (
    <Dialog
      open={open}
      onOpenChange={(v) => {
        if (!v) reset();
        onOpenChange(v);
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Ajouter un marketplace depuis une URL Git</DialogTitle>
          <DialogDescription>
            Enregistre le marketplace (<code>.claude-plugin/marketplace.json</code>),
            l'installe directement en local et active la mise à jour automatique
            ainsi que le suivi des PR.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div>
            <label className="mb-1 block text-xs text-muted-foreground">
              Fournisseur
            </label>
            <div className="flex items-center gap-1">
              {(["gitea", "github"] as const).map((p) => (
                <Button
                  key={p}
                  size="sm"
                  variant={provider === p ? "default" : "outline"}
                  className="h-7 px-3 text-xs capitalize"
                  onClick={() => setProvider(p)}
                >
                  {p}
                </Button>
              ))}
              {detectedHost && (
                <span className="ml-1 text-xs text-muted-foreground">
                  détecté depuis l'URL : <code>{detectedHost}</code>
                </span>
              )}
            </div>
          </div>

          {provider === "gitea" && (
            <div>
              <label className="mb-1 block text-xs text-muted-foreground">
                Instance Gitea
              </label>
              {giteaInstances.length === 0 ? (
                <div className="rounded-md border border-amber-500/40 bg-amber-500/5 p-2 text-xs text-amber-600 dark:text-amber-400">
                  Aucune instance Gitea enregistrée pour le moment. Ajoutez-en une (URL + token) dans{" "}
                  <strong>Paramètres → Instances Gitea</strong> d'abord.
                </div>
              ) : (
                <select
                  className="h-9 w-full rounded-md border bg-background px-2 text-sm"
                  value={giteaBaseUrl}
                  onChange={(e) => setGiteaBaseUrl(e.target.value)}
                >
                  {giteaInstances.map((i) => (
                    <option key={i.baseUrl} value={i.baseUrl}>
                      {i.baseUrl}
                      {i.hasToken ? "" : " (sans token)"}
                    </option>
                  ))}
                </select>
              )}
            </div>
          )}

          <div>
            <label className="mb-1 block text-xs text-muted-foreground">
              URL Git
            </label>
            <Input
              placeholder={
                provider === "gitea"
                  ? "https://git.example.com/owner/repo"
                  : "https://github.com/owner/repo"
              }
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              onBlur={onUrlBlur}
              autoFocus
            />
            {provider === "gitea" && (
              <button
                type="button"
                onClick={proposeDefault}
                className="mt-1 inline-flex items-center gap-1 text-xs text-primary underline underline-offset-2 hover:opacity-80"
              >
                <Sparkles className="h-3 w-3" />
                Proposition : marketplace AlmaviaCX (Claude/acx-cl-marketplace)
              </button>
            )}
            {parsedRepo && (
              <div className="mt-1 text-xs text-muted-foreground">
                Extrait : <code>{parsedRepo}</code>
              </div>
            )}
          </div>
          <div>
            <label className="mb-1 block text-xs text-muted-foreground">
              Nom du marketplace
            </label>
            <Input
              placeholder="(par défaut : nom du repo)"
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          </div>

          {giteaTokenMissing && (
            <div className="rounded-md border border-amber-500/40 bg-amber-500/5 p-2 text-xs text-amber-600 dark:text-amber-400">
              <div className="flex items-start gap-2">
                <KeyRound className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                <div>
                  Aucun token configuré pour <code>{hostOf(giteaBaseUrl)}</code>.
                  Configurez d'abord votre token Gitea pour pouvoir ajouter et
                  installer ce marketplace.{" "}
                  <button
                    type="button"
                    onClick={goConfigureToken}
                    className="font-medium underline underline-offset-2"
                  >
                    Configurer le token Gitea
                  </button>
                </div>
              </div>
            </div>
          )}

          {error && (
            <div className="rounded-md border border-destructive/40 bg-destructive/5 p-2 text-xs text-destructive">
              {error}
            </div>
          )}
        </div>
        <DialogFooter>
          <DialogClose asChild>
            <Button variant="outline">Annuler</Button>
          </DialogClose>
          <Button onClick={() => upsert.mutate()} disabled={blocked}>
            {upsert.isPending && <Loader2 className="mr-1 h-3 w-3 animate-spin" />}
            Ajouter et installer
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

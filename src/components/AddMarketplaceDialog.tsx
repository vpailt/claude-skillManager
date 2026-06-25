// Add-marketplace-from-URL dialog.
//
// Registers a marketplace (GitHub or Gitea) into the app's settings by parsing
// `owner/repo` from a Git URL and fetching its registry. Self-contained: only
// depends on `parseMarketplaceUrl` + `settingsUpsertMarketplace`, so it can be
// hosted from either the Admin-local panel or the Skills page.
import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Loader2 } from "lucide-react";
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
import type { Provider } from "@/lib/types";

export function AddMarketplaceDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const qc = useQueryClient();
  const settingsQuery = useQuery({
    queryKey: ["app-settings"],
    queryFn: api.loadAppSettings,
  });
  const giteaInstances = settingsQuery.data?.giteaInstances ?? [];

  const [provider, setProvider] = useState<Provider>("github");
  const [giteaBaseUrl, setGiteaBaseUrl] = useState("");
  const [url, setUrl] = useState("");
  const [name, setName] = useState("");
  const [parsedRepo, setParsedRepo] = useState<string | null>(null);
  const [error, setError] = useState("");

  const reset = () => {
    setProvider("github");
    setGiteaBaseUrl("");
    setUrl("");
    setName("");
    setParsedRepo(null);
    setError("");
  };

  const onUrlBlur = async () => {
    setError("");
    if (!url.trim()) {
      setParsedRepo(null);
      return;
    }
    const repo = await api.parseMarketplaceUrl(url.trim());
    if (!repo) {
      setError(`Impossible d'extraire owner/repo depuis : ${url}`);
      setParsedRepo(null);
      return;
    }
    setParsedRepo(repo);
    if (!name.trim()) setName(repo.split("/").pop() || "");
  };

  const upsert = useMutation({
    mutationFn: async () => {
      if (!parsedRepo) throw new Error("L'URL est invalide");
      if (!name.trim()) throw new Error("Le nom du marketplace est requis");
      if (provider === "gitea" && !giteaBaseUrl) {
        throw new Error("Choisissez une instance Gitea (ajoutez-en une dans Paramètres d'abord)");
      }
      return api.settingsUpsertMarketplace({
        name: name.trim(),
        githubRepo: parsedRepo,
        defaultBranch: "main",
        owned: false,
        sourcePath: "",
        autoUpdate: false,
        provider,
        baseUrl: provider === "gitea" ? giteaBaseUrl : "",
      });
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["app-settings"] });
      qc.invalidateQueries({ queryKey: ["refresh"] });
      reset();
      onOpenChange(false);
    },
    onError: (e) => setError(e instanceof Error ? e.message : String(e)),
  });

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
            Récupère le registre du marketplace (<code>.claude-plugin/marketplace.json</code>) et
            l'enregistre dans les paramètres de l'app. Utilisez « Installer » ensuite pour le télécharger localement.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div>
            <label className="mb-1 block text-xs text-muted-foreground">
              Fournisseur
            </label>
            <div className="flex gap-1">
              {(["github", "gitea"] as const).map((p) => (
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
                  <option value="">— choisir —</option>
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
          <Button
            onClick={() => upsert.mutate()}
            disabled={
              !parsedRepo ||
              !name.trim() ||
              (provider === "gitea" && !giteaBaseUrl) ||
              upsert.isPending
            }
          >
            {upsert.isPending && <Loader2 className="mr-1 h-3 w-3 animate-spin" />}
            Ajouter
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

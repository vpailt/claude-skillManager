import { useEffect, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Save,
  ShieldAlert,
  CheckCircle2,
  Loader2,
  HelpCircle,
  ExternalLink,
  KeyRound,
} from "lucide-react";
import { api } from "@/lib/api";
import type { Settings as SettingsType } from "@/lib/types";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
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
import { Switch } from "@/components/ui/switch";
import { Badge } from "@/components/ui/badge";
import { useNotifications } from "@/stores/notifications";
import { openExternal } from "@/lib/utils";

const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e));

// The single, fixed Gitea instance this app talks to. Locked by design — the
// user can set its token / TLS mode but cannot remove it or add another.
const ACX_GITEA_URL = "https://git.almaviacx.local";
const ACX_GITEA_HOST = "git.almaviacx.local";
const ACX_TOKEN_SETTINGS_URL = `${ACX_GITEA_URL}/user/settings/applications`;

const hostOf = (url: string) =>
  url
    .trim()
    .replace(/^https?:\/\//, "")
    .split("/")[0];

/// Manage the AlmaviaCX Gitea instance: token + TLS mode. The instance itself
/// is fixed (https://git.almaviacx.local) and auto-seeded — there is no add /
/// remove. A help dialog walks through generating a Gitea access token.
export function GiteaInstancesCard() {
  const qc = useQueryClient();
  const push = useNotifications((s) => s.push);
  const settingsQuery = useQuery({
    queryKey: ["app-settings"],
    queryFn: api.loadAppSettings,
  });
  const instances = settingsQuery.data?.giteaInstances ?? [];
  const inst = instances.find((i) => hostOf(i.baseUrl) === ACX_GITEA_HOST);

  // Auto auth-status (mirrors the GitHub card's "Authenticated as @…", shown
  // without clicking Test). Shared query key with the dashboard/sidebar.
  const statusQuery = useQuery({
    queryKey: ["gitea-status"],
    queryFn: api.giteaStatusAll,
    staleTime: 60_000,
  });
  const auto = statusQuery.data?.find((s) => hostOf(s.baseUrl) === ACX_GITEA_HOST);

  const [tokenDraft, setTokenDraft] = useState("");
  const [authResult, setAuthResult] = useState<{ ok: boolean; msg: string } | null>(
    null,
  );
  const [helpOpen, setHelpOpen] = useState(false);

  const onSettings = (s: SettingsType) => {
    qc.setQueryData<SettingsType>(["app-settings"], s);
    // Token/instance changes affect auth status — re-check (here and on the
    // dashboard/sidebar, which share this query key).
    qc.invalidateQueries({ queryKey: ["gitea-status"] });
  };

  // Seed the fixed instance once if it isn't registered yet, so the token vault
  // key + TLS mode + status query have something to hang off of.
  const seededRef = useRef(false);
  const seed = useMutation({
    mutationFn: () => api.settingsUpsertGiteaInstance(ACX_GITEA_URL, false),
    onSuccess: onSettings,
  });
  useEffect(() => {
    if (settingsQuery.data && !inst && !seededRef.current && !seed.isPending) {
      seededRef.current = true;
      seed.mutate();
    }
  }, [settingsQuery.data, inst, seed]);

  const setToken = useMutation({
    mutationFn: (token: string) =>
      api.settingsSetGiteaToken(ACX_GITEA_URL, token),
    onSuccess: (s) => {
      onSettings(s);
      setTokenDraft("");
      push({ kind: "success", title: "Token Gitea enregistré" });
    },
    onError: (e) =>
      push({ kind: "error", title: "Échec de l'enregistrement du token", body: errMsg(e) }),
  });

  const toggleInsecure = useMutation({
    mutationFn: (insecure: boolean) =>
      api.settingsUpsertGiteaInstance(ACX_GITEA_URL, insecure),
    onSuccess: onSettings,
    onError: (e) =>
      push({ kind: "error", title: "Échec de la mise à jour du mode TLS", body: errMsg(e) }),
  });

  const checkAuth = useMutation({
    mutationFn: () => api.giteaAuthCheck(ACX_GITEA_URL),
    onSuccess: ([ok, msg]) => setAuthResult({ ok, msg }),
    onError: (e) => setAuthResult({ ok: false, msg: errMsg(e) }),
  });

  const res = authResult ?? (auto ? { ok: auto.ok, msg: auto.user } : null);

  return (
    <Card id="gitea" className="mb-6 scroll-mt-6">
      <CardHeader>
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div>
            <CardTitle>Gitea — AlmaviaCX</CardTitle>
            <CardDescription>
              Forge interne <code>{ACX_GITEA_URL}</code>, accessible via le VPN
              GlobalProtect. Le token est stocké dans le coffre d'identifiants
              Windows (clé par hôte), jamais sur disque. Les marketplaces Gitea
              peuvent ensuite être ajoutées depuis l'onglet Administration.
            </CardDescription>
          </div>
          <Button
            size="sm"
            variant="outline"
            className="shrink-0"
            onClick={() => setHelpOpen(true)}
          >
            <HelpCircle className="mr-1 h-3 w-3" />
            Comment générer un token ?
          </Button>
        </div>
      </CardHeader>
      <CardContent className="space-y-3 text-sm">
        <div className="space-y-2 rounded-md border p-3">
          <div className="flex flex-wrap items-center gap-2">
            <code className="text-xs">{ACX_GITEA_URL}</code>
            <Badge variant={inst?.hasToken ? "success" : "warning"}>
              {inst?.hasToken ? "token défini" : "aucun token"}
            </Badge>
            {inst?.insecureTls && (
              <Badge variant="outline" className="gap-1 text-amber-600">
                <ShieldAlert className="h-3 w-3" />
                vérif. TLS désactivée
              </Badge>
            )}
            <Badge variant="secondary" className="ml-auto">
              instance par défaut
            </Badge>
          </div>

          <div className="flex items-center gap-2">
            <Input
              type="password"
              placeholder="Token Gitea (définir / remplacer)"
              value={tokenDraft}
              onChange={(e) => setTokenDraft(e.target.value)}
            />
            <Button
              size="sm"
              onClick={() => setToken.mutate(tokenDraft)}
              disabled={!tokenDraft.trim() || setToken.isPending}
            >
              <Save className="mr-1 h-3 w-3" />
              Enregistrer
            </Button>
            <Button
              size="sm"
              variant="outline"
              onClick={() => checkAuth.mutate()}
              disabled={checkAuth.isPending}
            >
              {checkAuth.isPending ? (
                <Loader2 className="mr-1 h-3 w-3 animate-spin" />
              ) : (
                <CheckCircle2 className="mr-1 h-3 w-3" />
              )}
              Tester
            </Button>
          </div>

          <label className="flex cursor-pointer items-center gap-2 text-xs">
            <Switch
              checked={inst?.insecureTls ?? false}
              onCheckedChange={(v) => toggleInsecure.mutate(v)}
              disabled={!inst || toggleInsecure.isPending}
            />
            <span>
              Ignorer la vérification du certificat TLS
              <span className="ml-1 text-muted-foreground">
                (CA interne / auto-signée uniquement)
              </span>
            </span>
          </label>

          {res && (
            <div className="text-xs">
              {res.ok ? (
                <Badge variant="success">Authentifié en tant que @{res.msg}</Badge>
              ) : (
                <Badge variant="warning">{res.msg}</Badge>
              )}
            </div>
          )}
        </div>
      </CardContent>

      <GiteaTokenHelpDialog open={helpOpen} onOpenChange={setHelpOpen} />
    </Card>
  );
}

// ============================================================
// Token generation help dialog
// ============================================================

function GiteaTokenHelpDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <KeyRound className="h-4 w-4" />
            Générer un token Gitea
          </DialogTitle>
          <DialogDescription>
            Un token d'accès personnel autorise SkillManager à lire et proposer
            des changements sur la forge AlmaviaCX. Il faut être connecté au VPN.
          </DialogDescription>
        </DialogHeader>

        <ol className="list-decimal space-y-3 pl-5 text-sm">
          <li>
            Ouvrir{" "}
            <button
              type="button"
              className="font-medium text-primary hover:underline"
              onClick={() => openExternal(ACX_GITEA_URL)}
            >
              {ACX_GITEA_URL}
            </button>{" "}
            via <strong>Trustelem</strong> et se connecter (VPN{" "}
            <strong>GlobalProtect</strong> requis).
          </li>
          <li>
            <strong>
              Paramètres → Applications → Gérer les jetons d'accès → Générer un
              nouveau jeton
            </strong>
            .
          </li>
          <li>
            Nom : <code>SkillManager</code>. Sélectionner les autorisations
            (scopes) :
            <ul className="mt-1 list-disc space-y-0.5 pl-5 text-xs">
              <li>
                <code>read:repository</code> + <code>write:repository</code>{" "}
                <span className="text-muted-foreground">
                  (lecture/écriture du contenu + ouverture de PR)
                </span>
              </li>
              <li>
                <code>read:user</code>
              </li>
              <li>
                <code>read:organization</code>
              </li>
            </ul>
          </li>
          <li>
            Copier le jeton généré, le coller dans le champ{" "}
            <em>Token Gitea</em> puis cliquer <strong>Enregistrer</strong>.
          </li>
        </ol>

        <DialogFooter className="sm:justify-between">
          <Button
            variant="outline"
            size="sm"
            onClick={() => openExternal(ACX_TOKEN_SETTINGS_URL)}
          >
            <ExternalLink className="mr-1 h-3 w-3" />
            Ouvrir la page des jetons
          </Button>
          <DialogClose asChild>
            <Button size="sm">Fermer</Button>
          </DialogClose>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

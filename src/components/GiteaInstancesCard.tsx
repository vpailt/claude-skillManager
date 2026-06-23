import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Save, Trash2, Plus, ShieldAlert, CheckCircle2, Loader2 } from "lucide-react";
import { api } from "@/lib/api";
import type { Settings as SettingsType } from "@/lib/types";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { Badge } from "@/components/ui/badge";
import { useNotifications } from "@/stores/notifications";

const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e));

/// Manage self-hosted Gitea instances: URL + TLS mode + per-host token.
/// GitHub keeps its own token card above; this is purely additive.
export function GiteaInstancesCard() {
  const qc = useQueryClient();
  const push = useNotifications((s) => s.push);
  const settingsQuery = useQuery({
    queryKey: ["app-settings"],
    queryFn: api.loadAppSettings,
  });
  const instances = settingsQuery.data?.giteaInstances ?? [];

  // New-instance form.
  const [newUrl, setNewUrl] = useState("");
  const [newInsecure, setNewInsecure] = useState(false);
  const [newToken, setNewToken] = useState("");

  // Per-instance token drafts and auth-check results, keyed by baseUrl.
  const [tokenDrafts, setTokenDrafts] = useState<Record<string, string>>({});
  const [authResults, setAuthResults] = useState<
    Record<string, { ok: boolean; msg: string }>
  >({});

  const onSettings = (s: SettingsType) =>
    qc.setQueryData<SettingsType>(["app-settings"], s);

  const addInstance = useMutation({
    mutationFn: async () => {
      const url = newUrl.trim();
      if (!url) throw new Error("Instance URL is required");
      await api.settingsUpsertGiteaInstance(url, newInsecure);
      if (newToken.trim()) {
        await api.settingsSetGiteaToken(url, newToken.trim());
      }
      return api.loadAppSettings();
    },
    onSuccess: (s) => {
      onSettings(s);
      setNewUrl("");
      setNewInsecure(false);
      setNewToken("");
      push({ kind: "success", title: "Gitea instance saved" });
    },
    onError: (e) =>
      push({ kind: "error", title: "Save instance failed", body: errMsg(e) }),
  });

  const setToken = useMutation({
    mutationFn: ({ baseUrl, token }: { baseUrl: string; token: string }) =>
      api.settingsSetGiteaToken(baseUrl, token),
    onSuccess: (s, { baseUrl }) => {
      onSettings(s);
      setTokenDrafts((d) => ({ ...d, [baseUrl]: "" }));
      push({ kind: "success", title: "Gitea token saved" });
    },
    onError: (e) =>
      push({ kind: "error", title: "Save token failed", body: errMsg(e) }),
  });

  const toggleInsecure = useMutation({
    mutationFn: ({ baseUrl, insecure }: { baseUrl: string; insecure: boolean }) =>
      api.settingsUpsertGiteaInstance(baseUrl, insecure),
    onSuccess: (s) => onSettings(s),
    onError: (e) =>
      push({ kind: "error", title: "Update TLS mode failed", body: errMsg(e) }),
  });

  const removeInstance = useMutation({
    mutationFn: (baseUrl: string) => api.settingsRemoveGiteaInstance(baseUrl),
    onSuccess: (s) => {
      onSettings(s);
      push({ kind: "info", title: "Gitea instance removed" });
    },
    onError: (e) =>
      push({ kind: "error", title: "Remove failed", body: errMsg(e) }),
  });

  const checkAuth = useMutation({
    mutationFn: (baseUrl: string) => api.giteaAuthCheck(baseUrl),
    onSuccess: ([ok, msg], baseUrl) =>
      setAuthResults((r) => ({ ...r, [baseUrl]: { ok, msg } })),
    onError: (e, baseUrl) =>
      setAuthResults((r) => ({
        ...r,
        [baseUrl]: { ok: false, msg: errMsg(e) },
      })),
  });

  return (
    <Card className="mb-6">
      <CardHeader>
        <CardTitle>Gitea instances</CardTitle>
        <CardDescription>
          Self-hosted Gitea servers (e.g. an internal{" "}
          <code>https://git.example.com</code> reachable over VPN). Each instance
          has its own token, stored in the OS credential vault keyed by host.
          Marketplaces can then be added against a Gitea instance from the Admin
          tab.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4 text-sm">
        {/* Existing instances */}
        {instances.length > 0 && (
          <div className="space-y-3">
            {instances.map((inst) => {
              const draft = tokenDrafts[inst.baseUrl] ?? "";
              const res = authResults[inst.baseUrl];
              return (
                <div
                  key={inst.baseUrl}
                  className="space-y-2 rounded-md border p-3"
                >
                  <div className="flex flex-wrap items-center gap-2">
                    <code className="text-xs">{inst.baseUrl}</code>
                    <Badge variant={inst.hasToken ? "success" : "warning"}>
                      {inst.hasToken ? "token set" : "no token"}
                    </Badge>
                    {inst.insecureTls && (
                      <Badge variant="outline" className="gap-1 text-amber-600">
                        <ShieldAlert className="h-3 w-3" />
                        TLS verify off
                      </Badge>
                    )}
                    <Button
                      size="sm"
                      variant="ghost"
                      className="ml-auto h-7 px-2 text-destructive"
                      onClick={() => removeInstance.mutate(inst.baseUrl)}
                      disabled={removeInstance.isPending}
                    >
                      <Trash2 className="mr-1 h-3 w-3" />
                      Remove
                    </Button>
                  </div>

                  <div className="flex items-center gap-2">
                    <Input
                      type="password"
                      placeholder="Gitea token (set / replace)"
                      value={draft}
                      onChange={(e) =>
                        setTokenDrafts((d) => ({
                          ...d,
                          [inst.baseUrl]: e.target.value,
                        }))
                      }
                    />
                    <Button
                      size="sm"
                      onClick={() =>
                        setToken.mutate({ baseUrl: inst.baseUrl, token: draft })
                      }
                      disabled={!draft.trim() || setToken.isPending}
                    >
                      <Save className="mr-1 h-3 w-3" />
                      Save
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => checkAuth.mutate(inst.baseUrl)}
                      disabled={checkAuth.isPending}
                    >
                      {checkAuth.isPending && checkAuth.variables === inst.baseUrl ? (
                        <Loader2 className="mr-1 h-3 w-3 animate-spin" />
                      ) : (
                        <CheckCircle2 className="mr-1 h-3 w-3" />
                      )}
                      Test
                    </Button>
                  </div>

                  <label className="flex cursor-pointer items-center gap-2 text-xs">
                    <Switch
                      checked={inst.insecureTls}
                      onCheckedChange={(v) =>
                        toggleInsecure.mutate({
                          baseUrl: inst.baseUrl,
                          insecure: v,
                        })
                      }
                    />
                    <span>
                      Skip TLS certificate verification
                      <span className="ml-1 text-muted-foreground">
                        (for internal / self-signed CAs only)
                      </span>
                    </span>
                  </label>

                  {res && (
                    <div className="text-xs">
                      {res.ok ? (
                        <Badge variant="success">
                          Authenticated as @{res.msg}
                        </Badge>
                      ) : (
                        <Badge variant="warning">{res.msg}</Badge>
                      )}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}

        {/* Add instance */}
        <div className="space-y-2 rounded-md border border-dashed p-3">
          <div className="text-xs font-medium text-muted-foreground">
            Add a Gitea instance
          </div>
          <Input
            placeholder="https://git.almaviacx.local"
            value={newUrl}
            onChange={(e) => setNewUrl(e.target.value)}
          />
          <Input
            type="password"
            placeholder="Gitea token (optional now, can set later)"
            value={newToken}
            onChange={(e) => setNewToken(e.target.value)}
          />
          <label className="flex cursor-pointer items-center gap-2 text-xs">
            <Switch checked={newInsecure} onCheckedChange={setNewInsecure} />
            <span>
              Skip TLS certificate verification
              <span className="ml-1 text-muted-foreground">
                (internal / self-signed CA)
              </span>
            </span>
          </label>
          <Button
            size="sm"
            onClick={() => addInstance.mutate()}
            disabled={!newUrl.trim() || addInstance.isPending}
          >
            {addInstance.isPending ? (
              <Loader2 className="mr-1 h-3 w-3 animate-spin" />
            ) : (
              <Plus className="mr-1 h-3 w-3" />
            )}
            Add instance
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

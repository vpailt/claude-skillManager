import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Plus, Trash2, RefreshCw, Save } from "lucide-react";
import { api } from "@/lib/api";
import type { MarketplaceConfig, Settings as SettingsType } from "@/lib/types";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { Badge } from "@/components/ui/badge";

const EMPTY_CFG: MarketplaceConfig = {
  name: "",
  githubRepo: "",
  defaultBranch: "main",
  owned: false,
  sourcePath: "",
  autoUpdate: false,
};

export function SettingsPage() {
  const qc = useQueryClient();
  const settingsQuery = useQuery({
    queryKey: ["app-settings"],
    queryFn: api.loadAppSettings,
  });

  const [token, setToken] = useState("");
  const [draft, setDraft] = useState<MarketplaceConfig>(EMPTY_CFG);

  useEffect(() => {
    if (settingsQuery.data) setToken(settingsQuery.data.githubToken);
  }, [settingsQuery.data]);

  const setTokenMutation = useMutation({
    mutationFn: api.settingsSetToken,
    onSuccess: (s) => {
      qc.setQueryData<SettingsType>(["app-settings"], s);
      qc.invalidateQueries({ queryKey: ["github-auth"] });
      qc.invalidateQueries({ queryKey: ["github-rate"] });
    },
  });
  const upsertMutation = useMutation({
    mutationFn: api.settingsUpsertMarketplace,
    onSuccess: (s) => {
      qc.setQueryData<SettingsType>(["app-settings"], s);
      qc.invalidateQueries({ queryKey: ["refresh"] });
      setDraft(EMPTY_CFG);
    },
  });
  const removeMutation = useMutation({
    mutationFn: api.settingsRemoveMarketplace,
    onSuccess: (s) => {
      qc.setQueryData<SettingsType>(["app-settings"], s);
      qc.invalidateQueries({ queryKey: ["refresh"] });
    },
  });

  const auth = useQuery({
    queryKey: ["github-auth"],
    queryFn: api.githubAuthCheck,
  });

  const settings = settingsQuery.data;

  return (
    <div className="h-full overflow-auto p-6">
      <h1 className="mb-1 text-2xl font-semibold">Settings</h1>
      <p className="mb-6 text-sm text-muted-foreground">
        GitHub credentials and marketplace registrations. Stored at{" "}
        <code className="text-xs">%APPDATA%\SkillManager\settings.json</code>.
      </p>

      <Card className="mb-6">
        <CardHeader>
          <CardTitle>GitHub token</CardTitle>
          <CardDescription>
            Personal access token with <code>repo</code> scope (or fine-grained
            with read+write content). Used for everything: install,
            marketplace fetch, admin PRs.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="flex items-center gap-2">
            <Input
              type="password"
              placeholder="github_pat_…"
              value={token}
              onChange={(e) => setToken(e.target.value)}
            />
            <Button
              onClick={() => setTokenMutation.mutate(token)}
              disabled={setTokenMutation.isPending}
            >
              <Save className="mr-1 h-3 w-3" />
              Save
            </Button>
          </div>
          {auth.data && (
            <div className="text-sm">
              {auth.data[0] ? (
                <Badge variant="success">Authenticated as @{auth.data[1]}</Badge>
              ) : (
                <Badge variant="warning">{auth.data[1]}</Badge>
              )}
            </div>
          )}
        </CardContent>
      </Card>

      <Card className="mb-6">
        <CardHeader>
          <CardTitle>Marketplaces</CardTitle>
          <CardDescription>
            Each entry exposes a marketplace's plugin index. Use <code>owner/repo</code>{" "}
            for GitHub-hosted marketplaces.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="space-y-2">
            {settings?.marketplaces.map((m) => (
              <div
                key={m.name}
                className="flex items-center gap-3 rounded-md border p-3 text-sm"
              >
                <div className="flex-1">
                  <div className="flex items-center gap-2 font-medium">
                    {m.name}
                    {m.autoUpdate && (
                      <Badge variant="secondary">auto-update</Badge>
                    )}
                  </div>
                  <div className="text-xs text-muted-foreground">
                    {m.githubRepo || m.sourcePath || "—"} ({m.defaultBranch})
                  </div>
                </div>
                <Switch
                  checked={m.autoUpdate}
                  onCheckedChange={(v) =>
                    upsertMutation.mutate({ ...m, autoUpdate: v })
                  }
                />
                <Button
                  size="icon"
                  variant="ghost"
                  onClick={() => removeMutation.mutate(m.name)}
                >
                  <Trash2 className="h-4 w-4" />
                </Button>
              </div>
            ))}
            {settings?.marketplaces.length === 0 && (
              <div className="rounded-md border border-dashed p-4 text-sm text-muted-foreground">
                No marketplaces yet. Add one below.
              </div>
            )}
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Add a marketplace</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="grid grid-cols-2 gap-3">
            <Input
              placeholder="Display name"
              value={draft.name}
              onChange={(e) => setDraft({ ...draft, name: e.target.value })}
            />
            <Input
              placeholder="owner/repo"
              value={draft.githubRepo}
              onChange={(e) =>
                setDraft({ ...draft, githubRepo: e.target.value })
              }
            />
            <Input
              placeholder="default branch"
              value={draft.defaultBranch}
              onChange={(e) =>
                setDraft({ ...draft, defaultBranch: e.target.value || "main" })
              }
            />
            <Input
              placeholder="local checkout (optional)"
              value={draft.sourcePath}
              onChange={(e) =>
                setDraft({ ...draft, sourcePath: e.target.value })
              }
            />
          </div>
          <div className="flex items-center gap-3 text-sm">
            <label className="flex items-center gap-2">
              <Switch
                checked={draft.autoUpdate}
                onCheckedChange={(v) => setDraft({ ...draft, autoUpdate: v })}
              />
              Auto-update on refresh
            </label>
            <label className="flex items-center gap-2">
              <Switch
                checked={draft.owned}
                onCheckedChange={(v) => setDraft({ ...draft, owned: v })}
              />
              I own this marketplace (admin)
            </label>
          </div>
          <div className="flex gap-2">
            <Button
              onClick={() => upsertMutation.mutate(draft)}
              disabled={!draft.name || upsertMutation.isPending}
            >
              <Plus className="mr-1 h-3 w-3" />
              Add
            </Button>
            {draft.githubRepo && (
              <Button
                variant="outline"
                onClick={() =>
                  api
                    .installMarketplace(
                      draft.name,
                      draft.githubRepo,
                      draft.defaultBranch,
                      draft.autoUpdate
                    )
                    .then(() =>
                      qc.invalidateQueries({ queryKey: ["refresh"] })
                    )
                }
                disabled={!draft.name}
              >
                <RefreshCw className="mr-1 h-3 w-3" />
                Add & install
              </Button>
            )}
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

// Shared "install a registered marketplace" mutation.
//
// Installing a marketplace clones its index repo into
// `~/.claude/plugins/marketplaces/<name>/` and registers it in
// `known_marketplaces.json` so Claude Code recognises it. Note that installing
// a *plugin* does NOT require this (it fetches the plugin's own repo), so this
// is the optional "make Claude Code aware of the index" step.
//
// Used by both the Admin-local marketplaces table and the Skills page so the
// repo/branch/provider/Gitea resolution stays in lockstep.
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { useNotifications } from "@/stores/notifications";
import type { Marketplace } from "@/lib/types";

const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e));

export function useInstallMarketplace() {
  const qc = useQueryClient();
  const notify = useNotifications((s) => s.push);
  return useMutation({
    mutationFn: async (mp: Marketplace) => {
      // Prefer the saved config (carries provider/baseUrl/autoUpdate), fall back
      // to whatever the scanned marketplace object exposes.
      const cfg = await api
        .loadAppSettings()
        .then((s) => s.marketplaces.find((m) => m.name === mp.name));
      const repo = cfg?.githubRepo || mp.sourceRepo;
      const branch = cfg?.defaultBranch || "main";
      const auto = cfg?.autoUpdate ?? null;
      if (!repo) throw new Error("Aucun repo configuré pour ce marketplace");
      return api.installMarketplace(
        mp.name,
        repo,
        branch,
        auto,
        cfg?.provider ?? "github",
        cfg?.baseUrl ?? ""
      );
    },
    onSuccess: (_, mp) => {
      qc.invalidateQueries({ queryKey: ["refresh"] });
      notify({ kind: "success", title: "Marketplace installé", body: mp.name });
    },
    // Without explicit onError, React Query swallows install failures and the
    // button looks like a no-op. The most common cause for public-marketplace
    // installs is "missing token + private repo" or rate-limit on unauth
    // requests — surface the backend error verbatim so the user sees it.
    onError: (e, mp) =>
      notify({
        kind: "error",
        title: `Échec de l'installation : ${mp.name}`,
        body: errMsg(e),
      }),
  });
}

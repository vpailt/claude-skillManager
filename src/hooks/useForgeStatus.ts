// Connection state of every forge the app talks to, in one place.
//
// Three queries used to be re-declared by five components — the dashboard's
// health strip, the AlmaviaCX card, the onboarding card, the sidebar and the
// Settings dialog — each with its own options. A query key with mixed staleness
// refetches on the most aggressive observer's mount, so visiting the dashboard
// cost a GitHub `/user`, a `/rate_limit` and one Gitea `/user` per instance,
// the last of which is VPN-gated and pays a timeout when the VPN is down.
//
// One hook, one set of options. Token changes still show up at once: the
// Settings dialog invalidates these exact keys after saving a token.
import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/api";
import type { GiteaStatus } from "@/lib/types";

/** Connection state changes when the user edits a token, and those edits
 *  invalidate these keys explicitly. Nothing else moves it, so it does not need
 *  to be re-read every minute. */
const STATUS_STALE_MS = 10 * 60_000;

export interface ForgeStatus {
  /** No answer yet from any of the three probes. */
  loading: boolean;
  github: {
    /** The probe has answered (whatever it said). */
    known: boolean;
    ok: boolean;
    user: string;
    /** Remaining / total API calls, `-1` when unknown. */
    remaining: number;
    limit: number;
    /** Quota low enough to be worth telling the user about. */
    lowQuota: boolean;
  };
  gitea: GiteaStatus[];
  /** At least one forge is usable — what onboarding calls "connected". */
  anyConnected: boolean;
}

export function useForgeStatus(): ForgeStatus {
  const auth = useQuery({
    queryKey: ["github-auth"],
    queryFn: api.githubAuthCheck,
    staleTime: STATUS_STALE_MS,
  });
  const rate = useQuery({
    queryKey: ["github-rate"],
    queryFn: api.githubRateLimit,
    staleTime: STATUS_STALE_MS,
  });
  const gitea = useQuery({
    queryKey: ["gitea-status"],
    queryFn: api.giteaStatusAll,
    staleTime: STATUS_STALE_MS,
  });

  const remaining = rate.data?.[0] ?? -1;
  const limit = rate.data?.[1] ?? -1;
  const instances = gitea.data ?? [];

  return {
    loading: !auth.data && !rate.data && !gitea.data,
    github: {
      known: !!auth.data,
      ok: !!auth.data?.[0],
      user: auth.data?.[1] ?? "",
      remaining,
      limit,
      // The same threshold the sidebar has always used: the last 10 % of the
      // budget, floored at 50 calls so a small limit still warns in time.
      lowQuota:
        remaining >= 0 && limit > 0 && remaining < Math.max(50, limit * 0.1),
    },
    gitea: instances,
    anyConnected: !!auth.data?.[0] || instances.some((g) => g.ok),
  };
}

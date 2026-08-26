// Runs a list of operations one after another, reporting progress as it goes.
//
// Sequential on purpose: `installPlugin`, `uninstallPlugin` and
// `setPluginEnabled` all rewrite the same files (`installed_plugins.json`,
// `~/.claude/settings.json`), so concurrent invokes would race on them.
//
// It never aborts on the first failure — a failed operation is recorded and the
// run carries on, because the alternative (stopping mid-way) leaves the user
// with a half-applied batch and no report of what did land. Query invalidation
// happens once at the end rather than once per operation.
import { useCallback, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useNotifications } from "@/stores/notifications";
import { createLogger } from "@/lib/logger";

const log = createLogger("bulk-runner");

export interface BulkOp<T = unknown> {
  /** Stable identity, used as the React key and to correlate results. */
  id: string;
  /** Human-readable, shown in the progress line and the failure list. */
  label: string;
  run: () => Promise<T>;
}

export interface BulkOpResult<T = unknown> {
  id: string;
  label: string;
  ok: boolean;
  error?: string;
  value?: T;
}

export interface BulkRunnerOptions {
  /** Query keys invalidated once, after the whole batch. */
  invalidate?: readonly unknown[][];
  /** Title used by the summary toast, e.g. "Installation". */
  summaryTitle?: string;
  /** Set false to skip the summary toast (the caller shows its own). */
  notify?: boolean;
}

const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e));

export function useBulkRunner<T = unknown>(options: BulkRunnerOptions = {}) {
  const { invalidate = [], summaryTitle = "Opérations", notify = true } = options;
  const qc = useQueryClient();
  const push = useNotifications((s) => s.push);

  const [running, setRunning] = useState(false);
  const [total, setTotal] = useState(0);
  const [done, setDone] = useState(0);
  const [current, setCurrent] = useState<string | null>(null);
  const [results, setResults] = useState<BulkOpResult<T>[]>([]);
  const cancelRef = useRef(false);
  // Callers pass `invalidate` as an inline literal, so it is a new array on
  // every render; a ref keeps `run` stable without capturing the first one.
  const invalidateRef = useRef(invalidate);
  invalidateRef.current = invalidate;

  const cancel = useCallback(() => {
    cancelRef.current = true;
  }, []);

  const reset = useCallback(() => {
    setResults([]);
    setDone(0);
    setTotal(0);
    setCurrent(null);
  }, []);

  const run = useCallback(
    async (ops: BulkOp<T>[]): Promise<BulkOpResult<T>[]> => {
      if (ops.length === 0) return [];
      cancelRef.current = false;
      setRunning(true);
      setResults([]);
      setDone(0);
      setTotal(ops.length);

      const collected: BulkOpResult<T>[] = [];
      for (const op of ops) {
        if (cancelRef.current) break;
        setCurrent(op.label);
        try {
          const value = await op.run();
          collected.push({ id: op.id, label: op.label, ok: true, value });
        } catch (e) {
          log.error(`${op.label} a échoué :`, e);
          collected.push({
            id: op.id,
            label: op.label,
            ok: false,
            error: errMsg(e),
          });
        }
        setResults([...collected]);
        setDone(collected.length);
      }

      setCurrent(null);
      setRunning(false);

      for (const key of invalidateRef.current) {
        qc.invalidateQueries({ queryKey: key });
      }

      if (notify) {
        const failed = collected.filter((r) => !r.ok);
        const skipped = ops.length - collected.length;
        if (failed.length === 0 && skipped === 0) {
          push({
            kind: "success",
            title: summaryTitle,
            body: `${collected.length} opération${collected.length > 1 ? "s" : ""} réussie${collected.length > 1 ? "s" : ""}.`,
          });
        } else {
          push({
            kind: failed.length === collected.length ? "error" : "warning",
            title: summaryTitle,
            body: [
              `${collected.length - failed.length}/${ops.length} réussie(s)`,
              failed.length > 0 ? `${failed.length} en échec` : null,
              skipped > 0 ? `${skipped} annulée(s)` : null,
            ]
              .filter(Boolean)
              .join(" · "),
          });
        }
      }

      return collected;
    },
    [qc, push, summaryTitle, notify]
  );

  return { running, total, done, current, results, run, cancel, reset };
}

// Long-running work, as the status bar shows it.
//
// The app already had three unrelated ways of saying "something is running":
// `useIsFetching(["refresh"])` spun an icon in the sidebar, `useBulkRunner`
// kept its own `running/done/total`, and the self-updater emitted progress
// events onto a banner. None of them was visible from the page the user was
// actually on, and the two that mattered most (a sweep, an install) said
// nothing at all about *what* they were doing.
//
// This is the one queue behind the status bar's progress slot. Anything that
// takes long enough to be worth a bar registers a task here; the bar renders
// the one that wins on priority and counts the rest.
//
// The self-update is deliberately NOT in here: it has its own store
// (`stores/appUpdate.ts`), fed by backend events that outlive the window, and
// the status bar reads that directly. Mirroring it would mean two copies of
// the same three fields — exactly the drift `UpdateProgressBar` was written to
// end.
import { create } from "zustand";

export type TaskKind =
  | "refresh"
  | "install"
  | "uninstall"
  | "marketplace"
  | "publish"
  | "audit"
  | "tracking";

/** Higher wins the single visible slot. A gesture the user just made outranks
 *  the background sweep it probably triggered — the sweep is the slowest thing
 *  in the app and would otherwise mask everything else. */
const PRIORITY: Record<TaskKind, number> = {
  publish: 5,
  install: 4,
  uninstall: 4,
  marketplace: 4,
  tracking: 2,
  audit: 2,
  refresh: 1,
};

export interface ProgressTask {
  id: string;
  kind: TaskKind;
  /** What is happening, e.g. "Installation". */
  label: string;
  /** What it is happening to, e.g. "cl-library · acx-cl". */
  detail: string | null;
  /** 0–100, or null for indeterminate (most remote work has no total). */
  pct: number | null;
  startedAt: number;
}

export interface TaskInit {
  /** Explicit id when the caller needs to update or end the task later.
   *  Omitted, one is generated. */
  id?: string;
  kind: TaskKind;
  label: string;
  detail?: string | null;
  pct?: number | null;
}

interface ProgressState {
  tasks: ProgressTask[];
  begin: (init: TaskInit) => string;
  update: (id: string, patch: Partial<Omit<ProgressTask, "id">>) => void;
  end: (id: string) => void;
}

let seq = 0;

export const useProgress = create<ProgressState>((set) => ({
  tasks: [],
  begin: ({ id, kind, label, detail = null, pct = null }) => {
    const taskId = id ?? `${kind}-${++seq}`;
    set((s) => {
      const task: ProgressTask = {
        id: taskId,
        kind,
        label,
        detail,
        pct,
        startedAt: Date.now(),
      };
      // Re-begin under the same id restarts the task rather than stacking a
      // duplicate — `useRefresh` does exactly that on every sweep.
      const rest = s.tasks.filter((t) => t.id !== taskId);
      return { tasks: [...rest, task] };
    });
    return taskId;
  },
  update: (id, patch) =>
    set((s) => ({
      tasks: s.tasks.map((t) => (t.id === id ? { ...t, ...patch } : t)),
    })),
  end: (id) => set((s) => ({ tasks: s.tasks.filter((t) => t.id !== id) })),
}));

/** The task the status bar shows: highest priority, most recent within it. */
export function pickVisible(tasks: ProgressTask[]): ProgressTask | null {
  let best: ProgressTask | null = null;
  for (const t of tasks) {
    if (
      !best ||
      PRIORITY[t.kind] > PRIORITY[best.kind] ||
      (PRIORITY[t.kind] === PRIORITY[best.kind] && t.startedAt > best.startedAt)
    ) {
      best = t;
    }
  }
  return best;
}

/**
 * Run `fn` with a task on the bar for its whole duration, whatever the outcome.
 *
 * Usable outside React (mutation functions, plain async helpers), which is the
 * point: install/uninstall live in `mutationFn`s, not in components.
 */
export async function withTask<T>(init: TaskInit, fn: () => Promise<T>): Promise<T> {
  const { begin, end } = useProgress.getState();
  const id = begin(init);
  try {
    return await fn();
  } finally {
    end(id);
  }
}

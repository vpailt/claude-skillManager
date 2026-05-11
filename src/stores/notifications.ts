import { create } from "zustand";

export type NotificationKind = "info" | "success" | "warning" | "error";

export interface Notification {
  id: string;
  kind: NotificationKind;
  title: string;
  body?: string;
  createdAt: number;
}

interface State {
  items: Notification[];
  push: (n: Omit<Notification, "id" | "createdAt">) => void;
  dismiss: (id: string) => void;
  clear: () => void;
}

export const useNotifications = create<State>((set) => ({
  items: [],
  push: (n) => {
    const id = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    set((s) => ({
      items: [
        { ...n, id, createdAt: Date.now() },
        ...s.items.slice(0, 19),
      ],
    }));
    setTimeout(() => {
      set((s) => ({ items: s.items.filter((it) => it.id !== id) }));
    }, 8000);
  },
  dismiss: (id) =>
    set((s) => ({ items: s.items.filter((it) => it.id !== id) })),
  clear: () => set({ items: [] }),
}));

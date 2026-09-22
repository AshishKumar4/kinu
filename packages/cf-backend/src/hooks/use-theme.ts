import { useSyncExternalStore } from "react";

/**
 * Follows OS `prefers-color-scheme` until a manual toggle persists. The snapshot is cached:
 * `useSyncExternalStore` re-renders forever on a fresh object. The store opens on first use,
 * not on import, because static-markup renders have no `window`.
 */
export type ThemeMode = "light" | "dark";

export interface Theme {
  readonly mode: ThemeMode;
}

const MODE_KEY = "theme";

/** Server snapshot: the mode `index.css`'s `:root` draws. */
const SERVER_THEME: Theme = { mode: "dark" };

interface ThemeStore {
  snapshot: Theme;
  readonly listeners: Set<() => void>;
  readonly mql: MediaQueryList;
}

let store: ThemeStore | null = null;

function storedMode(): ThemeMode | null {
  const v = localStorage.getItem(MODE_KEY);

  return v === "light" || v === "dark" ? v : null;
}

function apply(theme: Theme): void {
  const root = document.documentElement;
  root.setAttribute("data-mode", theme.mode);
  root.style.colorScheme = theme.mode;
}

function commit(open: ThemeStore, next: Theme): void {
  open.snapshot = next;
  apply(next);

  for (const l of open.listeners) l();
}

function browserStore(): ThemeStore {
  if (store !== null) return store;
  const mql = window.matchMedia("(prefers-color-scheme: dark)");
  const opened: ThemeStore = { mql, listeners: new Set(), snapshot: { mode: storedMode() ?? (mql.matches ? "dark" : "light") } };

  mql.addEventListener("change", () => {
    if (!storedMode()) commit(opened, { ...opened.snapshot, mode: mql.matches ? "dark" : "light" });
  });
  store = opened;

  return opened;
}

function setMode(mode: ThemeMode): void {
  const open = browserStore();
  localStorage.setItem(MODE_KEY, mode);
  commit(open, { ...open.snapshot, mode });
}

export function toggleMode(): void {
  setMode(browserStore().snapshot.mode === "dark" ? "light" : "dark");
}

export function useTheme(): Theme {
  return useSyncExternalStore(
    (cb) => {
      const { listeners } = browserStore();
      listeners.add(cb);

      return () => listeners.delete(cb);
    },
    () => browserStore().snapshot,
    () => SERVER_THEME,
  );
}

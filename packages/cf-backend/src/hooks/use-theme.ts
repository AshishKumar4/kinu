import { useSyncExternalStore } from "react";

/**
 * Theme store — the one axis the design has, shared by the sidebar footer
 * toggle and the user-menu row. The pre-paint script in index.html applies
 * the initial theme before React mounts; this keeps the live document and
 * every toggle affordance in sync.
 *
 * MODE is light/dark. When the user has never chosen explicitly (no `theme`
 * in localStorage) the app follows the OS `prefers-color-scheme`, live. A
 * manual toggle persists and from then on wins over the OS preference.
 *
 * There is one palette: the owner's app mock, warm blacks and gold, drawn
 * by `index.css`'s `:root` and `[data-mode="light"]` blocks.
 *
 * The snapshot is cached rather than rebuilt per read: `useSyncExternalStore`
 * re-renders forever if `getSnapshot` returns a fresh object each call.
 *
 * The store opens on first use, not on import: a component that reads the
 * theme (the inline slate card inside every message) is also rendered to
 * static markup, where there is no `window`, and that render takes the
 * server snapshot below — the product's default mode — never the store.
 */
export type ThemeMode = "light" | "dark";

export interface Theme {
  readonly mode: ThemeMode;
}

const MODE_KEY = "theme";

/** What a render with no document sees: the mode `index.css`'s `:root`
 *  draws before any preference is read. */
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

/** The browser's store, opened once. */
function browserStore(): ThemeStore {
  if (store !== null) return store;
  const mql = window.matchMedia("(prefers-color-scheme: dark)");
  const opened: ThemeStore = { mql, listeners: new Set(), snapshot: { mode: storedMode() ?? (mql.matches ? "dark" : "light") } };

  // Follow the OS live until the user makes an explicit choice.
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

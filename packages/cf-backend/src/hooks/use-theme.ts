import { useSyncExternalStore } from "react";
import { DEFAULT_THEME, themeNamed, type ThemeName } from "@kinu.run/core";

/**
 * The mode follows OS `prefers-color-scheme` until a manual toggle persists it on this device. The theme is the
 * account's, named on `<html data-theme>` by the server before the page paints; a choice in Settings re-points it here.
 * The snapshot is cached: `useSyncExternalStore` re-renders forever on a fresh object. The store opens on first use,
 * not on import, because static-markup renders have no `window`.
 */
export type ThemeMode = "light" | "dark";

export interface Theme {
  readonly mode: ThemeMode;
  readonly name: ThemeName;
}

const MODE_KEY = "theme";

/** Server snapshot: what `:root` draws. */
const SERVER_THEME: Theme = { mode: "dark", name: DEFAULT_THEME };

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
  root.setAttribute("data-theme", theme.name);
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

  const opened: ThemeStore = {
    mql, listeners: new Set(),
    snapshot: { mode: storedMode() ?? (mql.matches ? "dark" : "light"), name: themeNamed(document.documentElement.dataset.theme) ?? DEFAULT_THEME },
  };

  mql.addEventListener("change", () => {
    if (!storedMode()) commit(opened, { ...opened.snapshot, mode: mql.matches ? "dark" : "light" });
  });
  store = opened;

  return opened;
}

export function setMode(mode: ThemeMode): void {
  const open = browserStore();
  localStorage.setItem(MODE_KEY, mode);
  commit(open, { ...open.snapshot, mode });
}

/** Once the account holds the choice: this page re-points to it, as the server will every page after. */
export function wearTheme(name: ThemeName): void {
  const open = browserStore();
  commit(open, { ...open.snapshot, name });
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

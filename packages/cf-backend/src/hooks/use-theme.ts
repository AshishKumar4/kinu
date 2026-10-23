import { useSyncExternalStore } from "react";
import { DEFAULT_THEME, MODE_KEY, modeFor, PREFERS_LIGHT, themeNamed, type Mode, type ThemeName } from "@kinu.run/core";

/**
 * The mode follows the system until a manual toggle persists it on this device, by core's one rule (`modeFor`), which
 * the page's head already drew before any module loaded. The theme is the account's, named on `<html data-theme>` by
 * the server before the page paints; a choice in Settings re-points it here. The snapshot is cached:
 * `useSyncExternalStore` re-renders forever on a fresh object. The store opens on first use, not on import, because
 * static-markup renders have no `window`.
 */
export type ThemeMode = Mode;

export interface Theme {
  readonly mode: ThemeMode;
  readonly name: ThemeName;
}

/** Server snapshot: what `:root` draws. */
const SERVER_THEME: Theme = { mode: "dark", name: DEFAULT_THEME };

interface ThemeStore {
  snapshot: Theme;
  readonly listeners: Set<() => void>;
  readonly mql: MediaQueryList;
}

let store: ThemeStore | null = null;

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
  const mql = window.matchMedia(PREFERS_LIGHT);

  const opened: ThemeStore = {
    mql, listeners: new Set(),
    snapshot: { mode: modeFor(localStorage.getItem(MODE_KEY), mql.matches), name: themeNamed(document.documentElement.dataset.theme) ?? DEFAULT_THEME },
  };

  // Drawn in the mode it holds from the moment it opens: the head drew the same rule, but the system may have changed
  // before this store opened, with no change left for it to hear.
  apply(opened.snapshot);
  mql.addEventListener("change", () => {
    const mode = modeFor(localStorage.getItem(MODE_KEY), mql.matches);

    if (mode !== opened.snapshot.mode) commit(opened, { ...opened.snapshot, mode });
  });
  store = opened;

  return opened;
}

/** Opens the store as a page boots: from its first frame on, the page is drawn in the mode the store holds and follows
 *  the system, whether or not any component reads the theme. */
export function startTheme(): void {
  browserStore();
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

import { useSyncExternalStore } from "react";

/**
 * Theme store — single source of truth for the two axes the design has, shared
 * by the sidebar footer toggles and the user-menu rows. The pre-paint script in
 * index.html applies the initial theme before React mounts; this keeps the live
 * document and every toggle affordance in sync.
 *
 * MODE is light/dark. When the user has never chosen explicitly (no `theme` in
 * localStorage) the app follows the OS `prefers-color-scheme`, live. A manual
 * toggle persists and from then on wins over the OS preference.
 *
 * PALETTE is which set of `--c-*` values the modes are drawn from: `silk`, the
 * indigo-and-fibre pair named for 絹, or `umber`, the landing page's brass on
 * warm dark. It is the same mechanism as mode — an attribute on <html> that
 * `index.css` selects on — so the two axes compose into four themes with one
 * store, one persistence path and one apply step. `silk` is the default — the
 * product is named for it, and the public pages already boot into it — while
 * `index.css` keeps umber on `:root` so an absent or unknown attribute still
 * renders a complete palette.
 *
 * The snapshot is cached rather than rebuilt per read: `useSyncExternalStore`
 * re-renders forever if `getSnapshot` returns a fresh object each call.
 */
export type ThemeMode = "light" | "dark";
export type ThemePalette = "umber" | "silk";

export interface Theme {
  readonly mode: ThemeMode;
  readonly palette: ThemePalette;
}

const MODE_KEY = "theme";
const PALETTE_KEY = "palette";

const mql = window.matchMedia("(prefers-color-scheme: dark)");

function storedMode(): ThemeMode | null {
  const v = localStorage.getItem(MODE_KEY);
  return v === "light" || v === "dark" ? v : null;
}

function storedPalette(): ThemePalette | null {
  const v = localStorage.getItem(PALETTE_KEY);
  return v === "umber" || v === "silk" ? v : null;
}

function osMode(): ThemeMode {
  return mql.matches ? "dark" : "light";
}

function apply(theme: Theme): void {
  const root = document.documentElement;
  root.setAttribute("data-mode", theme.mode);
  root.setAttribute("data-palette", theme.palette);
  root.style.colorScheme = theme.mode;
}

let snapshot: Theme = { mode: storedMode() ?? osMode(), palette: storedPalette() ?? "silk" };

const listeners = new Set<() => void>();

function commit(next: Theme): void {
  snapshot = next;
  apply(next);
  for (const l of listeners) l();
}

// Follow the OS live until the user makes an explicit choice.
mql.addEventListener("change", () => {
  if (!storedMode()) commit({ ...snapshot, mode: osMode() });
});

function setMode(mode: ThemeMode): void {
  localStorage.setItem(MODE_KEY, mode);
  commit({ ...snapshot, mode });
}

export function toggleMode(): void {
  setMode(snapshot.mode === "dark" ? "light" : "dark");
}

function setPalette(palette: ThemePalette): void {
  localStorage.setItem(PALETTE_KEY, palette);
  commit({ ...snapshot, palette });
}

export function togglePalette(): void {
  setPalette(snapshot.palette === "umber" ? "silk" : "umber");
}

export function useTheme(): Theme {
  return useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    () => snapshot,
    () => snapshot,
  );
}

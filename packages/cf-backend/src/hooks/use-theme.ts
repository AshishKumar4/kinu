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
 */
export type ThemeMode = "light" | "dark";

export interface Theme {
  readonly mode: ThemeMode;
}

const MODE_KEY = "theme";

const mql = window.matchMedia("(prefers-color-scheme: dark)");

function storedMode(): ThemeMode | null {
  const v = localStorage.getItem(MODE_KEY);
  return v === "light" || v === "dark" ? v : null;
}

function osMode(): ThemeMode {
  return mql.matches ? "dark" : "light";
}

function apply(theme: Theme): void {
  const root = document.documentElement;
  root.setAttribute("data-mode", theme.mode);
  root.style.colorScheme = theme.mode;
}

let snapshot: Theme = { mode: storedMode() ?? osMode() };

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

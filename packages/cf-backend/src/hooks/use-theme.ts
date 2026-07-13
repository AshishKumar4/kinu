import { useSyncExternalStore } from "react";

/**
 * Theme store — single source of truth for light/dark, shared by the sidebar
 * footer toggle and the user-menu row. The pre-paint script in index.html
 * applies the initial mode before React mounts; this keeps the live document
 * and every toggle affordance in sync.
 *
 * When the user has never chosen explicitly (no `theme` in localStorage) the
 * app follows the OS `prefers-color-scheme`, live. A manual toggle persists and
 * from then on wins over the OS preference.
 */
export type ThemeMode = "light" | "dark";

const mql = window.matchMedia("(prefers-color-scheme: dark)");

function stored(): ThemeMode | null {
  const v = localStorage.getItem("theme");
  return v === "light" || v === "dark" ? v : null;
}

function osMode(): ThemeMode {
  return mql.matches ? "dark" : "light";
}

function current(): ThemeMode {
  return stored() ?? osMode();
}

function apply(mode: ThemeMode): void {
  document.documentElement.setAttribute("data-mode", mode);
  document.documentElement.style.colorScheme = mode;
}

const listeners = new Set<() => void>();
function emit(): void {
  for (const l of listeners) l();
}

// Follow the OS live until the user makes an explicit choice.
mql.addEventListener("change", () => {
  if (!stored()) {
    apply(osMode());
    emit();
  }
});

export function setTheme(mode: ThemeMode): void {
  localStorage.setItem("theme", mode);
  apply(mode);
  emit();
}

export function toggleTheme(): void {
  setTheme(current() === "dark" ? "light" : "dark");
}

export function useTheme(): ThemeMode {
  return useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    current,
    current,
  );
}

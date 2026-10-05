import { MoonIcon, SunIcon } from "@phosphor-icons/react";
import { useTheme, toggleMode } from "../hooks/use-theme";

export function ThemeToggle() {
  const { mode } = useTheme();
  const label = mode === "light" ? "Switch to dark mode" : "Switch to light mode";

  return (
    <button type="button" onClick={toggleMode} aria-label={label} title={label}
      className="flex size-7 shrink-0 items-center justify-center rounded-lg p-text-4 transition-colors hover:bg-[var(--c-neutral-tint)] hover:p-text">
      {mode === "light" ? <MoonIcon size={14} /> : <SunIcon size={14} />}
    </button>
  );
}

/** Shares the theme store with the compact footer toggle. */
export function ModeToggle() {
  const { mode } = useTheme();

  return (
    <button
      type="button"
      onClick={toggleMode}
      className="w-full flex items-center gap-2 px-2 py-1.5 text-sm rounded-sm p-card-hover text-left"
    >
      {mode === "light" ? <MoonIcon size={14} /> : <SunIcon size={14} />}
      <span>{mode === "light" ? "Dark mode" : "Light mode"}</span>
    </button>
  );
}

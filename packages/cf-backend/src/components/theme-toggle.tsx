import { MoonIcon, SunIcon } from "@phosphor-icons/react";
import { useTheme, toggleMode } from "../hooks/use-theme";

/**
 * The labelled mode row in the Sidebar user menu. Shares the theme store with
 * the compact footer toggle, so both affordances stay in sync — one source of
 * truth for the one axis the design has.
 */
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

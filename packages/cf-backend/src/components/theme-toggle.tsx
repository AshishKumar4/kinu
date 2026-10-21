import { MoonIcon, SunIcon } from "@phosphor-icons/react";
import { useTheme, toggleMode } from "../hooks/use-theme";

/** The theme switch in the account menu. `data-mode-toggle` names it to the checks that switch the theme through it. */
export function ModeToggle() {
  const { mode } = useTheme();

  return (
    <button
      type="button"
      onClick={toggleMode}
      data-mode-toggle
      className="t-body w-full flex items-center gap-2 px-2 py-1 rounded-sm p-card-hover text-left"
    >
      {mode === "light" ? <MoonIcon size={14} /> : <SunIcon size={14} />}
      <span>{mode === "light" ? "Dark mode" : "Light mode"}</span>
    </button>
  );
}

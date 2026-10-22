import { MoonIcon, SunIcon } from "@phosphor-icons/react";
import { useTheme, toggleMode } from "../hooks/use-theme";
import { Pressable } from "@/components/ui/Pressable";

/** The theme switch in the account menu. `data-mode-toggle` names it to the checks that switch the theme through it. */
export function ModeToggle() {
  const { mode } = useTheme();

  return (
    <Pressable className="t-body flex items-center gap-2 px-2 py-1" onClick={toggleMode} data-mode-toggle>
      {mode === "light" ? <MoonIcon size={14} /> : <SunIcon size={14} />}
      <span>{mode === "light" ? "Dark mode" : "Light mode"}</span>
    </Pressable>
  );
}

import { MoonIcon, SunIcon, SwatchesIcon } from "@phosphor-icons/react";
import { useTheme, toggleMode, togglePalette } from "../hooks/use-theme";

/**
 * The labelled theme rows in the Sidebar user menu — one per axis. Both share
 * the theme store with the compact footer toggles, so all four affordances stay
 * in sync and neither axis gets a second source of truth.
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

/** Umber (the landing page's brass on warm dark) or silk (絹 — indigo dye and
 *  raw fibre). The label names the palette you would GET, matching the mode row
 *  above rather than describing the one you are in. */
export function PaletteToggle() {
  const { palette } = useTheme();
  return (
    <button
      type="button"
      onClick={togglePalette}
      className="w-full flex items-center gap-2 px-2 py-1.5 text-sm rounded-sm p-card-hover text-left"
    >
      <SwatchesIcon size={14} />
      <span>{palette === "silk" ? "Umber palette" : "Silk palette"}</span>
    </button>
  );
}

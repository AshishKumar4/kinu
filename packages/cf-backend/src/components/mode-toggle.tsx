import { useState, useEffect } from "react";
import { MoonIcon, SunIcon } from "@phosphor-icons/react";

/**
 * Light/dark switcher — rendered as a row in the Sidebar user menu.
 * The chosen mode persists in localStorage and is applied before first paint
 * by the inline script in index.html; this component keeps the live document
 * in sync when the user flips it.
 */
export function ModeToggle() {
  const [mode, setMode] = useState(
    () => localStorage.getItem("theme") || "dark"
  );

  useEffect(() => {
    document.documentElement.setAttribute("data-mode", mode);
    document.documentElement.style.colorScheme = mode;
    localStorage.setItem("theme", mode);
  }, [mode]);

  return (
    <button
      type="button"
      onClick={() => setMode((m) => (m === "light" ? "dark" : "light"))}
      className="w-full flex items-center gap-2 px-2 py-1.5 text-sm rounded hover:p-card-hover text-left"
    >
      {mode === "light" ? <MoonIcon size={14} /> : <SunIcon size={14} />}
      <span>{mode === "light" ? "Dark mode" : "Light mode"}</span>
    </button>
  );
}

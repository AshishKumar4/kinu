/**
 * The desktop rail lane: the roster, and the choice to hide it. Collapsed, the
 * lane keeps only the handle that brings it back, riding the content edge the
 * way the inspector's does.
 *
 * One mount owns the lane so every surface that shows the workbench shows the
 * same rail — the app shell around the route outlet, and the landing page's
 * sample frames. Below `md` there is no lane at all: the shell summons the
 * roster as a drawer from its own header, and a page with no header shows no
 * rail rather than a second drawer nobody can open.
 */
import { useState } from "react";
import { CaretLeftIcon, CaretRightIcon } from "@phosphor-icons/react";

import Sidebar from "./Sidebar";

/** The rail's own open/close choice, beside the theme and section folds in
 *  localStorage — the same shelf the inspector's choice sits on, read once at
 *  mount and written only on toggle. */
const RAIL_KEY = "kinu:rail-open";

export function SidebarRail() {
  const [railOpen, setRailOpen] = useState(() => localStorage.getItem(RAIL_KEY) !== "0");

  if (!railOpen) {
    return (
      <div className="relative hidden shrink-0 md:block" data-rail-collapsed>
        <button
          type="button"
          onClick={() => { localStorage.setItem(RAIL_KEY, "1"); setRailOpen(true); }}
          aria-label="Show sidebar"
          title="Show sidebar"
          data-rail-expand
          className="absolute left-0 top-1/2 z-[3] flex h-16 w-5 -translate-y-1/2 items-center justify-center rounded-r-md border border-l-0 p-border p-sidebar-veil p-text-3 shadow-sm transition-colors hover:p-text"
        >
          <CaretRightIcon size={12} weight="bold" />
        </button>
      </div>
    );
  }

  return (
    <aside className="relative hidden w-60 shrink-0 p-sidebar-veil border-r p-border md:block" data-rail>
      <Sidebar />
      <button
        type="button"
        onClick={() => { localStorage.setItem(RAIL_KEY, "0"); setRailOpen(false); }}
        aria-label="Hide sidebar"
        title="Hide sidebar"
        data-rail-collapse
        className="absolute -right-2.5 top-1/2 z-[3] hidden h-16 w-5 -translate-y-1/2 items-center justify-center rounded-l-md border border-r-0 p-border p-elevated p-text-3 shadow-sm transition-colors hover:p-text md:flex"
      >
        <CaretLeftIcon size={12} weight="bold" />
      </button>
    </aside>
  );
}

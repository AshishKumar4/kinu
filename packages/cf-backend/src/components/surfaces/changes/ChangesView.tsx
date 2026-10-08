/**
 * The Changes panel with its review notes, a chunk of its own loaded the first time Changes is shown: the notes'
 * annotation toolbar and popover (`@plannotator/ui`, 84 KB on 2026-10-08) are nothing the workspace's first screen
 * draws.
 */
import type { ComponentProps, Key, ReactNode } from "react";
import { ChangesPanel } from "./ChangesPanel";
import { NotesProvider } from "./notes-provider";

export interface ChangesViewProps {
  readonly notes: Omit<ComponentProps<typeof NotesProvider>, "children">;
  readonly panel: ComponentProps<typeof ChangesPanel>;
  /** A new focus remounts the panel on its file. */
  readonly panelKey: Key;
  readonly banner: ReactNode;
}

export function ChangesView({ notes, panel, panelKey, banner }: ChangesViewProps) {
  return (
    <NotesProvider {...notes}>
      <div className="flex h-full min-h-0 flex-col">
        {banner}
        <div className="min-h-0 flex-1">
          <ChangesPanel key={panelKey} {...panel} />
        </div>
      </div>
    </NotesProvider>
  );
}

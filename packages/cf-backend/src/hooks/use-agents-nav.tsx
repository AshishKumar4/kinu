import { createContext, useCallback, useContext, useMemo, useRef, useState, type ReactNode, type RefObject } from "react";
import { useLocation } from "react-router-dom";
import type { PanelAgent } from "@kinu.run/core";

/** What a chat's tab, and its row in the sidebar, offer: a rename, and a delete, which for Main clears it instead. */
export interface ChatActions {
  readonly rename: (name: string) => Promise<void>;
  readonly remove?: () => void;
  readonly clears?: boolean;
}

export interface WorkspaceAgentsPanel {
  readonly workspace: string;
  readonly list: readonly PanelAgent[];
  readonly shown: string | null;
  readonly open: (agent: PanelAgent) => void;
  /** The same rename and delete as the chat's tab, with the same dialogs. */
  readonly actions: (agent: PanelAgent) => ChatActions;
}

interface AgentsNavValue {
  readonly drilled: string | null;
  readonly panel: WorkspaceAgentsPanel | null;
  readonly entries: number;
  readonly trigger: RefObject<HTMLButtonElement | null>;
  readonly enter: (workspace: string) => void;
  readonly back: () => void;
  readonly publish: (panel: WorkspaceAgentsPanel | null) => void;
}

const NO_AGENTS_NAV: AgentsNavValue = {
  drilled: null, panel: null, entries: 0, trigger: { current: null },
  enter: () => {}, back: () => {}, publish: () => {},
};

const AgentsNavContext = createContext<AgentsNavValue>(NO_AGENTS_NAV);

export function AgentsNavProvider({ children }: { readonly children: ReactNode }) {
  const [drilled, setDrilled] = useState<string | null>(null);
  const [panel, publish] = useState<WorkspaceAgentsPanel | null>(null);
  const [entries, setEntries] = useState(0);
  const trigger = useRef<HTMLButtonElement | null>(null);

  const enter = useCallback((workspace: string) => {
    if (drilled === workspace) {
      setDrilled(null);

      return;
    }

    setDrilled(workspace);
    setEntries((count) => count + 1);
  }, [drilled]);

  const back = useCallback(() => {
    setDrilled(null);
    requestAnimationFrame(() => { trigger.current?.focus(); });
  }, []);

  const { pathname } = useLocation();
  const inside = drilled !== null && (pathname === `/workspace/${drilled}` || pathname.startsWith(`/workspace/${drilled}/`));

  const value = useMemo(
    () => ({ drilled: inside ? drilled : null, panel, entries, trigger, enter, back, publish }),
    [inside, drilled, panel, entries, enter, back],
  );

  return <AgentsNavContext.Provider value={value}>{children}</AgentsNavContext.Provider>;
}

export function useAgentsNav(): AgentsNavValue {
  return useContext(AgentsNavContext);
}

/** The open workspace's agents, and whether the sidebar shows them in place of the workspace list. */
export interface OpenAgentsPanel {
  readonly panel: WorkspaceAgentsPanel | null;
  readonly drilled: boolean;
}

export function useOpenAgentsPanel(workspace: string | undefined): OpenAgentsPanel {
  const { drilled, panel } = useAgentsNav();
  const open = panel !== null && panel.workspace === workspace ? panel : null;

  return { panel: open, drilled: open !== null && drilled === workspace };
}

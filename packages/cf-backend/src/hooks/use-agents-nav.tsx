import { createContext, useCallback, useContext, useMemo, useRef, useState, type ReactNode, type RefObject } from "react";
import { useLocation } from "react-router-dom";
import type { PanelAgent } from "@kinu.run/core";
import { KinuError, settleSync } from "@kinu.run/core/obs";
import { Effect } from "effect";

export interface WorkspaceAgentsPanel {
  readonly workspace: string;
  readonly list: readonly PanelAgent[];
  readonly shown: string | null;
  readonly open: (agent: PanelAgent) => void;
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

const AgentsNavContext = createContext<AgentsNavValue | null>(null);

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
  const nav = useContext(AgentsNavContext);

  if (nav !== null) return nav;

  return settleSync(Effect.fail(new KinuError("bad_input", "useAgentsNav requires AgentsNavProvider")));
}

export function useDrilledPanel(workspace: string | undefined): WorkspaceAgentsPanel | null {
  const { drilled, panel } = useAgentsNav();

  return panel !== null && drilled === panel.workspace && panel.workspace === workspace ? panel : null;
}

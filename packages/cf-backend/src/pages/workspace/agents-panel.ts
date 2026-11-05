import { useCallback, useMemo, type RefObject } from "react";
import { useNavigate } from "react-router-dom";
import { agentRoute, workspaceRoute } from "@kinu.run/core";
import { mainPanelAgent, type PanelAgent } from "@kinu.run/core";
import { type ChatTab } from "@/components/WorkspaceHeader";
import { settleLogged } from "@kinu.run/core/obs";
import { type WorkbenchHandle } from "@/components/WorkbenchPanels";

/** Main's row before the roster is read. */
export const MAIN_UNREAD = mainPanelAgent({ activity: "idle" });

export function useAgentsPanel({ listed, live, workspace = "", node, subName, workbench }: {
  listed: readonly PanelAgent[] | null;
  live: boolean;
  workspace: string | undefined;
  node: string | null;
  subName: string | undefined;
  workbench: RefObject<WorkbenchHandle | null>;
}) {
  const navigate = useNavigate();

  const agents = useMemo((): readonly PanelAgent[] => {
    const main = listed?.find((agent) => agent.category === "main") ?? MAIN_UNREAD;

    return [{ ...main, activity: mainActivity(main.activity, live) }, ...(listed ?? []).filter((agent) => agent.category !== "main")];
  }, [listed, live]);

  const shownAgent = useMemo(() => shownPanelAgent(agents, node, subName), [agents, node, subName]);

  const open = useCallback((agent: PanelAgent) => settleLogged("agents.open_failed", { doing: "open an agent's chat", otherwise: "io" }, async () => {
    await navigate(agentPagePath(workspace, agent));
    workbench.current?.showChat();
  }), [navigate, workspace, workbench]);

  const shown = shownAgent?.key ?? null;
  const panel = useMemo(() => ({ list: agents, shown, open }), [agents, shown, open]);

  return {
    shownAgent,
    rosterLoaded: listed !== null,
    panel,
  };
}

/** Main's mark follows this page's own socket for working, so the bar and the composer's Stop never disagree; a
 *  question for the person outranks either. */
export function mainActivity(listed: PanelAgent["activity"], live: boolean): PanelAgent["activity"] {
  if (listed === "waiting") return listed;

  if (live) return "working";

  return listed === "working" ? "idle" : listed;
}

export function shownPanelAgent(agents: readonly PanelAgent[], node: string | null, subName: string | undefined): PanelAgent | undefined {
  if (node !== null) return agents.find((agent) => agent.key === node);

  return agents.find((agent) => agent.open.kind === "chat" && agent.open.path === (subName ?? null));
}

export function agentPagePath(workspace: string, { open }: PanelAgent): string {
  if (open.kind === "chat") return open.path === null ? workspaceRoute(workspace) : agentRoute(workspace, open.path);
  const owner = open.owner === null ? "" : `&owner=${encodeURIComponent(open.owner)}`;

  return `${workspaceRoute(workspace)}?node=${encodeURIComponent(`${open.runId}/${open.nodeId}`)}${owner}`;
}

/** Main is the workspace's own chat: its × clears the conversation and Main stays. A chat the person opened is deleted. */
export function chatTab(workspace: string, agent: PanelAgent, actions: {
  renameMain: (title: string) => Promise<void>;
  renameChat: (path: string, title: string) => Promise<void>;
  clearMain: () => void;
  remove: (path: string) => void;
}): ChatTab {
  const path = agent.open.kind === "chat" ? agent.open.path : null;

  if (path === null) return { agent, to: workspaceRoute(workspace), rename: actions.renameMain, remove: actions.clearMain, clears: true };

  return {
    agent, to: agentRoute(workspace, path),
    rename: (title: string) => actions.renameChat(path, title),
    remove: () => actions.remove(path),
  };
}

/** The bar's open item: the overview, or the chat shown when it has a tab. */
export function openBarItem(view: string | undefined, shown: PanelAgent | undefined): string | null {
  if (view === "overview") return "overview";

  return view === undefined && shown?.tab === true ? shown.key : null;
}

export function subagentBase(workspace: string, subName: string): string {
  return `${agentRoute(workspace, subName)}/`;
}

/** A subagent below a direct child is addressed by its `/`-joined path of names, as its socket and RPCs take it. */
export function routedAgentPath({ subName, "*": below }: Readonly<Record<string, string | undefined>>): string | undefined {
  if (subName === undefined) return undefined;

  return [subName, ...(below ?? "").split("/").filter(Boolean)].join("/");
}

import { askedBy } from "@/components/QuestionCard";
import { createContext, useContext, useEffect, useCallback, useMemo } from "react";
import { Link } from "react-router-dom";
import { Loader } from "@/components/ui/Loader";
import { Button } from "@/components/ui/Button";
import { WarningCircleIcon } from "@phosphor-icons/react";
import { newestOpener, ownerAsks } from "@kinu.run/core";
import { type OwedOwnerIntent, type PlanReview } from "@kinu.run/core";
import type { UIMessage } from "ai";
import type { SubagentView } from "@kinu.run/core/protocol";
import { useActorChat, useKinu } from "@/hooks/use-kinu";
import { useChatThread } from "@/hooks/use-chat-thread";
import { useConversationUiState, usePlanApprovedMode } from "@/hooks/use-conversation-ui-state";
import { useAsyncResource } from "@/hooks/use-async-resource";
import { LoadFailure } from "@/components/ui/LoadFailure";
import { SubagentChatBase } from "@/components/MessageView";
import { ChatColumn } from "@/components/ChatColumn";
import { AttentionStack, type AttentionStackProps } from "@/components/AttentionStack";
import { agentTitle, nestedAgent, type AgentLinkIds, type ForkNode, type PanelAgent } from "@kinu.run/core";
import { ViewOnlyBar } from "@/components/ViewOnlyBar";
import { NodeTranscript } from "@/components/NodeTranscript";
import { KinuMark } from "@/components/ui/KinuLogo";
import { KeptChatColumn } from "@/components/KeptChatColumn";
import { settleLogged, detachPromise } from "@kinu.run/core/obs";
import type { WorkspaceRpc } from "@/lib/workspace-rpc";
import { subagentBase } from "./agents-panel";

export interface TerminalCloseState {
  readonly code: number;
  readonly reason: string;
  readonly message: string;
}

/** What a terminal close says, in the boundary and in the bar alike: 1008 is the server's policy refusal. */
export function closeWords(close: TerminalCloseState) {
  return { title: close.code === 1008 ? "Access to this workspace was denied" : "This workspace is unavailable", detail: close.reason || close.message };
}

export function retryIsOwed(intents: readonly OwedOwnerIntent[], actor: string | null, messages: readonly UIMessage[]): boolean {
  const newest = newestOpener(messages);

  return newest !== undefined && intents.some((intent) => intent.kind === "retry" && intent.actor === actor && intent.target === newest);
}

/** A terminal close means the SDK stopped redialling; it is not a reconnecting state. */
export function TerminalCloseBoundary({ close, onRetry }: {
  close: TerminalCloseState;
  onRetry: () => void;
}) {
  return (
    <div className="h-full flex flex-col items-center justify-center gap-3 px-6 text-center">
      <WarningCircleIcon size={28} className="p-danger" />
      <p className="t-body p-text">{closeWords(close).title}</p>
      <p className="t-meta p-text-3 max-w-sm break-words">{closeWords(close).detail}</p>
      <div className="flex items-center gap-3">
        <Button variant="ghost" size="sm" onClick={onRetry}>Try again</Button>
        <Link to="/" className="t-meta p-link">Back to your workspaces</Link>
      </div>
    </div>
  );
}

function NestedAgentColumn({ workspace, path, rpc, ids, input }: { workspace: string; path: string; rpc: WorkspaceRpc; ids: AgentLinkIds; input: boolean }) {
  const load = useCallback(() => nestedAgent((request) => rpc("inspectSubagent", [request]), path, ids), [rpc, path, ids]);
  const { resource, reload } = useAsyncResource(load, undefined, `${path}|${ids.actor ?? ""}|${ids.parent ?? ""}`);

  if (resource.status === "loading") return <div className="flex flex-1 items-center justify-center"><Loader size="sm" /></div>;

  if (resource.status === "error") return <LoadFailure className="p-4" what={`${path}'s place in its roster`} message={resource.message} onRetry={reload} />;
  const agent = resource.value;

  if (agent === null) return <p className="t-body p-4 p-text-3">No agent is at {path} in this workspace.</p>;

  return (
    <SubagentChatBase.Provider value={{ base: subagentBase(workspace, path), parent: agent.actorId }}>
      {agent.live
        ? <SubagentChatColumn workspace={workspace} subName={path} title={agent.title} input={input} />
        : <KeptChatColumn workspace={workspace} subName={path} title={agent.title} rpc={rpc} actorId={agent.actorId} />}
    </SubagentChatBase.Provider>
  );
}

function SwarmNodeColumn({ main, ownerPath, runId, nodeId, agent }: {
  main: ReturnType<typeof useKinu>;
  ownerPath: string | null;
  runId: string;
  nodeId: string;
  agent: PanelAgent;
}) {
  const working = agent.activity === "working";

  const trees = useMemo(() => new Map<string, ForkNode>([[runId, {
    id: nodeId, parentId: null, depth: 0, value: null, visits: null, status: working ? "running" : "terminal",
    action: agent.label, children: [],
  }]]), [runId, nodeId, working, agent.label]);

  return (
    <div className="@container relative flex flex-col flex-1 min-h-0" data-agent-pane={`node/${runId}/${nodeId}`}>
      <div className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto px-4 py-4">
        {agent.parent !== null && <p className="t-meta p-text-3">Swarm worker from {agent.parent}</p>}
        {/* Main's socket reads every journal and carries every head's stream. */}
        <NodeTranscript selection={{ runId, nodeId }} ownerPath={ownerPath} trees={trees} rpc={main.rpc} headActivity={main.headActivity}
          headDeltas={main.headDeltas} onSelect={() => undefined} />
      </div>
      {/* The workspace holds every running worker, whoever started the swarm; its siblings run on. */}
      <ViewOnlyBar running={working} onStop={() => detachPromise(() => settleLogged("agents.stop_failed", { doing: "stop a swarm worker", otherwise: "io" },
        () => main.rpc("stopSwarmWorker", [nodeId])))} />
    </div>
  );
}

/** `node` is `<run>/<node>`. */
export function SwarmNodePane({ main, node, ownerPath, agent, rosterLoaded }: {
  main: ReturnType<typeof useKinu>;
  node: string;
  ownerPath: string | null;
  agent: PanelAgent | undefined;
  rosterLoaded: boolean;
}) {
  const [runId = "", ...rest] = node.split("/");
  const nodeId = rest.join("/");

  if (agent === undefined) {
    return (
      <div className="t-meta flex flex-1 items-center justify-center px-6 text-center p-text-3" data-agent-pane={`node/${node}`}>
        {rosterLoaded ? "This swarm worker is no longer listed. Open the Agents panel to pick another." : "Loading this swarm worker…"}
      </div>
    );
  }

  return <SwarmNodeColumn main={main} ownerPath={ownerPath} runId={runId} nodeId={nodeId} agent={agent} />;
}

/** The shown agent's plan and its window's RPC: an agent's plan is reviewed through its own window (D9), so the work
 *  surface takes both from the agent's pane, never from the workspace's socket. */
export interface AgentPlanWindow {
  readonly plan: PlanReview | null;
  readonly rpc: WorkspaceRpc;
}

export const AgentPlanWindowContext = createContext<(window: AgentPlanWindow | null) => void>(() => {});

/** The workspace's asks and the stack's calls, so an agent's own pane stacks the asks it raised (`ownerAsks`). */
export const AttentionContext = createContext<{
  readonly reads: Parameters<typeof ownerAsks>[0];
  readonly stack: Omit<AttentionStackProps, "asks">;
} | null>(null);

export function AgentChatColumn({ workspace, subName, subagents, rpc, ids, input }: {
  workspace: string;
  subName: string;
  subagents: readonly SubagentView[];
  rpc: WorkspaceRpc;
  ids: AgentLinkIds;
  input: boolean;
}) {
  if (subName.includes("/")) return <NestedAgentColumn workspace={workspace} path={subName} rpc={rpc} ids={ids} input={input} />;
  const rosterEntry = subagents.find((entry) => entry.name === subName);
  let column = <SubagentChatColumn workspace={workspace} subName={subName} title={rosterEntry ? agentTitle(rosterEntry) : subName} input={input} />;

  if (rosterEntry?.status === "dismissed") {
    // A dismissed agent has no socket; its kept chat is paged over this workspace's.
    column = <KeptChatColumn workspace={workspace} subName={subName} title={agentTitle(rosterEntry)} rpc={rpc} actorId={rosterEntry.actorId} />;
  }

  // A subagent this agent asked opens below it.
  return <SubagentChatBase.Provider value={{ base: subagentBase(workspace, subName), parent: rosterEntry?.actorId ?? null }}>{column}</SubagentChatBase.Provider>;
}

/** One subagent's chat over its own facet socket; Work Surface and Timeline stay on
 *  the parent socket. The facet exposes no fork/feedback/takes/restore. */
function SubagentChatColumn({
  workspace, subName, title, input,
}: {
  workspace: string;
  subName: string;
  title: string;
  input: boolean;
}) {
  const state = useActorChat({ workspace, subagent: subName });
  const pane = `${workspace}/agents/${subName}`;
  const ui = useConversationUiState(pane);

  usePlanApprovedMode(state.activePlan, ui.setMode);

  const showPlanWindow = useContext(AgentPlanWindowContext);
  const attention = useContext(AttentionContext);
  const retryOwed = state.paneActorId !== null && retryIsOwed(attention?.stack.owedIntents ?? [], state.paneActorId, state.messages);

  useEffect(() => { showPlanWindow({ plan: state.activePlan, rpc: state.rpc }); }, [showPlanWindow, state.activePlan, state.rpc]);
  useEffect(() => () => { showPlanWindow(null); }, [showPlanWindow]);

  const chat = useChatThread({
    rpc: state.rpc, live: state.messages, seeded: state.transcriptSeeded, seedEdge: state.seedEdge,
    steerRuns: state.steerRuns, actor: state.paneActorId,
  });

  // Its answers' blocks resolve in its own chat, once the pane knows whose that is.
  const answerChat = useMemo(() => (state.paneActorId === null ? undefined : { actorId: state.paneActorId }), [state.paneActorId]);
  // Its own questions, from the workspace's read, for each call's record.
  const questions = attention?.reads.questions;
  const asked = useMemo(() => (state.paneActorId === null ? [] : askedBy(questions ?? [], state.paneActorId)), [questions, state.paneActorId]);

  if (state.terminalClose && !state.actorSnapshot) {
    return <TerminalCloseBoundary close={state.terminalClose} onRetry={state.retryLoad} />;
  }

  if (state.connectionStatus === "connecting" && !state.actorSnapshot) {
    return (
      <div className="flex flex-1 items-center justify-center">
        <div className="t-body flex items-center gap-2 p-text-2"><Loader size="sm" /><span>Connecting…</span></div>
      </div>
    );
  }

  const live = state.liveness.kind === "live";

  return (
    <ChatColumn pane={pane} label="Agent chat" state={state} ui={ui} chat={chat} retryOwed={retryOwed} input={input}
      placeholder={live ? `Steer ${title}…` : `Message ${title}…`}
      attention={attention !== null && state.paneActorId !== null
        ? <AttentionStack asks={ownerAsks(attention.reads, { raisedBy: state.paneActorId })} {...attention.stack} />
        : undefined}
      empty={
        <div className="flex h-full flex-col items-center justify-center text-center">
          <KinuMark size={30} className="mb-3 p-accent opacity-60" />
          <p className="t-body p-text-3">This agent's conversation starts here.</p>
        </div>
      }
      asked={asked} answerSlates={answerChat} layout={{ startFirst: false, padClass: "pt-5 pb-12" }} extras={{ opening: true }} />
  );
}

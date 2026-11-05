import { askedBy } from "@/components/QuestionCard";
import { Effect, Cause } from 'effect';
import { startTransition, useState, useRef, useEffect, useCallback, useMemo } from "react";
import { useParams, useLocation, Link, Navigate, useMatch, useNavigate, useSearchParams } from "react-router-dom";
import { Loader } from "@/components/ui/Loader";
import { Button } from "@/components/ui/Button";
import { ArrowsClockwiseIcon, WarningCircleIcon } from "@phosphor-icons/react";
import { CLOUD_MAX_INLINE_ATTACHMENT_BYTES, ownerAsks, planSurface, workspaceRoute } from "@kinu.run/core";
import { APP_ROUTES, rowText, threadLiveTail, type SignalCard, type WorkspaceLayout } from "@kinu.run/core";
import type { UIMessage } from "ai";
import { useKinu } from "@/hooks/use-kinu";
import { useChatThread } from "@/hooks/use-chat-thread";
import { useConversationUiState, usePlanApprovedMode } from "@/hooks/use-conversation-ui-state";
import { useWorkspaceRoster } from "@/hooks/use-workspace-roster";
import { useAgentsNav } from "@/hooks/use-agents-nav";
import { usePendingAttachments } from "@/hooks/use-pending-attachments";
import { useFileDrop } from "@/hooks/use-file-drop";
import { useFocusLine } from "@/hooks/use-focus-line";
import { BackgroundWork } from "@/components/BackgroundWork";
import { useWorkbenchSurfaces } from "@/hooks/use-workbench-surfaces";
import { useTurnAnnotations } from "@/hooks/use-turn-annotations";
import { touchWorkspace } from "@/lib/user-api";
import { readFailureText } from "@kinu.run/core";
import { workspaceCommands } from "@/lib/workspace-commands";
import { TurnRevert } from "@/components/RevertTurnDialog";
import { DeviceOfflineRow, SubagentChatBase } from "@/components/MessageView";
import { ChatColumn, EmptyConversation } from "@/components/ChatColumn";
import { ModelMenuProvider } from "@/components/ModelPicker";
import { ProgrammaticTurnCard } from "@/components/ProgrammaticTurnCard";
import { AttentionStack, type AttentionStackProps } from "@/components/AttentionStack";
import { ChatImageContext } from "@/components/ChatImages";
import { placeEvents, subagentEventRow, type PlacedEvent } from "@/components/ChatEvents";
import { TakesChip, BranchRunChip } from "@/components/AlternateTakes";
import { hasComparableTakes } from "@kinu.run/core";
import { classifyProgrammaticTurn, messageSignalId, messagesUpTo, splicesSeenOn, turnRows } from "@kinu.run/core";
import { WorkSurface } from "@/components/surfaces/WorkSurface";
import { SlateInlineContext } from "@/components/slates/context";
import { ChatSlates } from "@/components/slates/InlineSlate";
import { SLATE_PREFIX, siteSurface, surfacePreviewTarget, type AgentLinkIds, type PanelAgent } from "@kinu.run/core";
import { FileLinkContext } from "@/components/surfaces/shared";
import { type ChatTab } from "@/components/WorkspaceHeader";
import { useWorkspaceArea } from "@/components/layout";
import { workspaceDisplayTitle, workspaceTitleDraft } from "@kinu.run/core";
import { attempt, renderThrownChain, showing, detach, settle, type KinuError, detachPromise } from "@kinu.run/core/obs";
import { WorkbenchPanels, type InspectorControl } from "@/components/WorkbenchPanels";
import { useCarriedAttachments } from "@/components/workspaces/NewChatView";
import { OpenWorkspaceProvider } from "@/hooks/use-open-workspace";
import { closeWords, retryIsOwed, TerminalCloseBoundary, SwarmNodePane, type AgentPlanWindow, AgentPlanWindowContext, AttentionContext, AgentChatColumn } from "./workspace/agent-panes";
import { useAgentsPanel, chatTab, subagentBase, routedAgentPath } from "./workspace/agents-panel";
import { ForkModal, DeleteChat, MainClearDialog, type FocusIdentity, WorkspaceBar, WorkspaceView, GoneWorkspace } from "./workspace/chrome";

/** The workspace's own chat, where its answers' blocks resolve. */
const WORKSPACE_CHAT = { actorId: null } as const;

/** The workspace's own pages share the chat route's key, so the socket and the bar stay mounted across them. */
const WORKSPACE_VIEW = "/workspace/:agentId/:view";

/** The plan the work surface reviews and the RPC its decisions go through: the workspace's own on the main pane, the
 *  shown agent's from its pane otherwise. */
function useReviewedPlan(subName: string | undefined, root: AgentPlanWindow) {
  const [agentWindow, setAgentWindow] = useState<AgentPlanWindow | null>(null);
  const shown = subName === undefined ? root : agentWindow ?? { plan: null, rpc: root.rpc };

  return { plan: shown.plan, planRpc: shown.rpc, showAgentWindow: setAgentWindow };
}

/** The work read names an owner by its own name, the last of its path. */
function planOwnerName(subName: string | undefined, agentId: string | undefined): string {
  if (subName !== undefined) return subName.slice(subName.lastIndexOf("/") + 1);

  return agentId ?? "main";
}

/** Each source keeps its own error so one recovery never hides another failure, and a
 *  failed hydrate never renders as "there is nothing". */
const SIDE_SOURCES = [
  { source: "visit", label: "record this visit" },
  { source: "feedback", label: "load your turn feedback" },
  { source: "takes", label: "load alternate takes" },
] as const;

type SideSource = (typeof SIDE_SOURCES)[number]["source"];

/**
 * Live steers' rule: a card spliced into a running turn goes into the last message when that is the answer being
 * written. A card the chat already draws is not live: the page keeps its cards until it closes, and three a long turn
 * read moved into every later answer once its own had kept them (quiet-cairn-da44d09f, 2026-10-30).
 */
function useLiveSplices(entries: readonly { readonly message: UIMessage }[], cards: readonly SignalCard[], drawn: ReadonlySet<string>): readonly SignalCard[] {
  const answering = entries.at(-1)?.message.role === "assistant";

  return useMemo(() => (answering ? cards.filter((card) => card.atStep !== undefined && !drawn.has(card.id)) : []), [answering, cards, drawn]);
}

/** A workspace's page, the one its route names; Home names the assistant's (`workspace`): its chat, with nothing above it. */
interface WorkspacePageProps {
  readonly workspace?: string;
  /** The layout the caller already knows, drawn until the workspace's own status says: Home's assistant is `focus`. */
  readonly layout?: WorkspaceLayout;
}

/** A message's files, read back from where the chat shows them and given to the composer as dropped files are. */
function reattached(message: UIMessage, add: (files: FileList) => void): Effect.Effect<void, KinuError> {
  const files = message.parts.flatMap((part) => (part.type === "file" ? [part] : []));

  if (files.length === 0) return Effect.void;

  return Effect.gen(function* () {
    const transfer = new DataTransfer();

    for (const part of files) {
      const blob = yield* attempt({ doing: "reading a reverted message's file back", otherwise: 'unavailable' }, async () => (await fetch(part.url)).blob());
      transfer.items.add(new File([blob], part.filename ?? "attachment", { type: part.mediaType }));
    }

    add(transfer.files);
  });
}

export default function WorkspacePage(props: WorkspacePageProps = {}) {
  const routed = useParams().agentId;
  const agentId = props.workspace ?? routed;
  const [gone, setGone] = useState<string | null>(null);
  const home = useWorkspaceRoster().entries.some((entry) => entry.name === agentId && entry.home === true);
  const own = useMatch(APP_ROUTES.workspace) !== null;
  const { search, hash } = useLocation();

  // The owner's assistant is Home: its own address opens Home, and its other pages are in its layout from the start.
  if (props.workspace === undefined && home && own) return <Navigate to={{ pathname: APP_ROUTES.home, search, hash }} replace />;

  // Its route always names it; an address without one has no workspace to open.
  if (agentId === undefined) return <Navigate to={APP_ROUTES.workspaces} replace />;

  if (gone === agentId) return <GoneWorkspace />;

  // Unmounting closes its socket and every read it polls.
  return (
    <ModelMenuProvider key={agentId}>
      <OpenWorkspace onGone={setGone} workspace={agentId} elsewhere={props.workspace !== undefined} layout={props.layout ?? (home ? "focus" : undefined)} />
    </ModelMenuProvider>
  );
}

/** Shown where its route is not (Home), a workspace still draws the phone's one bar. */
function useOwnBar(shownElsewhere: boolean): void {
  const area = useWorkspaceArea();

  useEffect(() => {
    if (!shownElsewhere || area === null) return undefined;
    area.ownBar(true);

    return () => { area.ownBar(false); };
  }, [shownElsewhere, area]);
}

/** The `focus` layout's bar and composer: whom they name, and what the bar says of them. Null in `workbench`. `said`
 *  is the main agent's own line (`useFocusLine`), which another agent's chat does not take. */
function focusOf(layout: WorkspaceLayout | undefined, title: string, agents: { shown: PanelAgent | undefined; all: readonly PanelAgent[]; loaded: boolean }, said: string | null): FocusIdentity | null {
  if (layout !== "focus") return null;

  // Before the agents are read, no name rather than a wrong one: the stand-in main agent is "Main".
  if (!agents.loaded) return { line: "" };
  const speaking = agents.shown ?? agents.all.find((agent) => agent.category === "main");

  return { label: speaking?.label ?? title, line: (speaking?.category === "main" ? said : null) ?? activityLine(speaking) };
}

/** Neither the workspace's status nor its caller has named its layout, and the roster may yet say it is Home's assistant,
 *  whose own address goes Home: until one answers, no workbench is drawn. */
function useLayoutPending(known: WorkspaceLayout | undefined): boolean {
  const { loading, error } = useWorkspaceRoster();

  return known === undefined && loading && error === null;
}

/** What the composer says while no turn runs: in `focus`, whom it addresses. */
const restingPlaceholder = (focus: FocusIdentity | null) => (focus?.label === undefined ? "Send a message..." : `Message ${focus.label}…`);

/** The inspector's layout is decided: a landing that opens a surface in it can, and not before. */
function inspectorReady(control: InspectorControl | null): boolean {
  return control?.ready === true;
}

/** `elsewhere`: drawn where its route is not (Home). */
function OpenWorkspace({ onGone, workspace: agentId, elsewhere, layout }: {
  workspace: string;
  elsewhere: boolean;
  layout?: WorkspaceLayout;
  onGone: (workspace: string) => void;
}) {
  const params = useParams();

  useOwnBar(elsewhere);
  const subName = routedAgentPath(params);
  const [search] = useSearchParams();
  const linkIds = useMemo<AgentLinkIds>(() => ({ actor: search.get("actor"), parent: search.get("parent") }), [search]);
  // `&owner=` names the agent whose swarm it is.
  const shownNode = search.get("node");
  const nodeOwner = search.get("owner");
  const location = useLocation();
  const navigate = useNavigate();
  const state = useKinu(agentId);
  const live = state.liveness.kind === "live";
  const { entries: workspaceEntries } = useWorkspaceRoster();

  const view = useMatch(WORKSPACE_VIEW)?.params.view;
  const [inspectorControl, setInspectorControl] = useState<InspectorControl | null>(null);

  const [sideErrors, setSideErrors] = useState<Partial<Record<SideSource, string>>>({});

  const reportSide = useCallback((source: SideSource, message: string | null) => {
    setSideErrors((prev) => {
      if ((prev[source] ?? null) === message) return prev;
      const next = { ...prev };

      if (message === null) delete next[source];
      else next[source] = message;

      return next;
    });
  }, []);

  const sideFailed = useCallback((source: SideSource) => (failed: Cause.Cause<unknown>) => Effect.sync(() => {
    reportSide(source, readFailureText({ cause: Cause.squash(failed) }));
  }), [reportSide]);

  const reviewed = useReviewedPlan(subName, { plan: state.activePlan, rpc: state.rpc });
  const visiblePlan = reviewed.plan;

  // Which surface the inspector shows, and every way the chat, the stack and a landing ask for one.
  const {
    workbench, surface, setSurface, show, previewAddress, openPreview, filesFocus, fileLinks, chatImages, changesFocus, openChangeNote, forkLanding, forkLandingOpened,
    desktopLanding, desktopLanded,
  } = useWorkbenchSurfaces({
    workspace: agentId, executors: state.executors, slates: state.slates, search: location.search,
    inspectorReady: inspectorReady(inspectorControl),
  });

  const { shownAgent, rosterLoaded, panel: agentsPanel } = useAgentsPanel({ listed: state.workspaceAgents, live, workspace: agentId, node: shownNode, subName, workbench });
  const agentsNav = useAgentsNav();
  const { publish } = agentsNav;
  const [clearingMain, setClearingMain] = useState(false);
  const [deletingChat, setDeletingChat] = useState<{ title: string; path: string } | null>(null);
  // `useKinu` answers new functions on every render: the actions read them when called, so publishing them once per
  // workspace does not publish again on every render, which re-rendered this page without end.
  const latestState = useRef(state);
  latestState.current = state;

  // A chat renames and deletes alike from its tab and its sidebar row, through the same dialogs.
  const chatActions = useCallback((agent: PanelAgent): ChatTab => chatTab(agentId, agent, {
    renameMain: async (name) => { await latestState.current.rpc("renameMainChat", [name]); },
    renameChat: async (path, name) => { await latestState.current.renameSubagent(path, name); },
    clearMain: () => { setClearingMain(true); },
    remove: (path) => { setDeletingChat({ title: agent.label, path }); },
  }), [agentId]);

  useEffect(() => {
    publish({ workspace: agentId, ...agentsPanel, actions: chatActions });
  }, [agentId, agentsPanel, chatActions, publish]);

  // The stack answers through the workspace's own calls on every pane: one queue, whichever pane asks. The account's
  // memory proposals come from the owner's user object, on the roster's socket the shell already holds.
  const { rpc: workspaceRpc, resolveConsent, refreshPendingActions } = state;
  const { accountProposals, decideAccountProposal } = useWorkspaceRoster();

  // The workspace agent's questions, for each call's record in the transcript.
  const asked = useMemo(() => askedBy(state.ownerQuestions, null), [state.ownerQuestions]);

  // The card the stack shows first: a Work row opens its ask here, on the workspace's own chat, which stacks them all.
  const [askFocus, setAskFocus] = useState<string | null>(null);

  // On an agent's chat, the workspace's own chat is opened: its stack holds every ask.
  const openAsk = useCallback(async (key: string): Promise<void> => {
    setAskFocus(key);

    if (subName !== undefined) await navigate(workspaceRoute(agentId));
    workbench.current?.showChat();
  }, [subName, navigate, agentId, workbench]);

  const attentionCalls = useMemo((): Omit<AttentionStackProps, "asks"> => ({
    rpc: workspaceRpc,
    owedIntents: state.owedIntents,
    resolveConsent,
    onDecided: refreshPendingActions,
    onReview: (plan) => show(planSurface(plan)),
    decideMemory: decideAccountProposal,
    focus: { chosen: askFocus, choose: setAskFocus },
  }), [workspaceRpc, state.owedIntents, resolveConsent, refreshPendingActions, show, decideAccountProposal, askFocus]);

  const mainPane = `${agentId}/main`;
  const ui = useConversationUiState(mainPane);

  usePlanApprovedMode(subName === undefined ? state.activePlan : null, ui.setMode);

  const [forkFor, setForkFor] = useState<string | null>(null);

  // `state.messages` is the SDK's newest window with streamed messages; older history pages from storage.
  const chat = useChatThread({
    rpc: state.rpc, live: state.messages, seeded: state.transcriptSeeded, seedEdge: state.seedEdge, steerRuns: state.steerRuns,
    total: state.actorSnapshot?.messageCount,
  });

  const { history, thread, positions, transcript } = chat;
  const retryOwed = retryIsOwed(state.owedIntents, null, state.messages);

  // The hook spends the per-message aggregate cap (one DO row, see core/cloud-wire) inside its
  // reducer, so concurrent additions cannot reserve the same remaining capacity.
  const attachments = usePendingAttachments(CLOUD_MAX_INLINE_ATTACHMENT_BYTES);
  useCarriedAttachments(attachments.offer);
  const chatDrop = useFileDrop(attachments.add);

  // A visit the roster does not take is a gone workspace; asked again when the socket drops.
  const dropped = state.connectionStatus === "disconnected";

  useEffect(() => {
    startTransition(() => settle(Effect.catchCause(Effect.gen(function* () {
      const taken = yield* Effect.promise(async () => touchWorkspace(agentId));

      if (!taken) onGone(agentId);
      reportSide("visit", null);
    }), sideFailed("visit"))));
  }, [agentId, dropped, onGone, reportSide, sideFailed]);

  // Steer-as-Branch: runs the draft as a parallel head while the live turn continues.
  const [branchNotice, setBranchNotice] = useState<string | null>(null);

  const handleBranch = useCallback((t: string, draft: string) => {
    if (!t || !live || ui.mode === "plan") return;
    setBranchNotice(null);
    // Clear the draft only once the branch is accepted, and only if it was not edited meanwhile.
    startTransition(() => settle(Effect.catchCause(Effect.gen(function* () {
      const result = yield* Effect.promise(async () => state.rpc("branchTurn", [t]));

      if (result.accepted) ui.updateDraft((current) => current.trim() === draft ? "" : current);
      else setBranchNotice(result.reason ?? "Branching is unavailable right now.");
    }), showing(setBranchNotice))));
  }, [ui.mode, live, state]);

  // Identity-stable handlers so memo(MessageView) holds across stream ticks.
  const onForkMessage = useCallback((mid: string) => setForkFor(mid), []);

  const { feedback: feedbackByMessage, rate: onMessageFeedback, takes: takesByTurn, pickTake: onPickTake } = useTurnAnnotations({
    rpc: state.rpc, connected: state.connectionStatus === "connected", live,
    settledBranches: state.branchRuns.filter((b) => b.status === "settled").length, report: reportSide,
  });

  // A signal that started a turn renders on its message; one spliced into a running turn renders inside the answer
  // that read it, at the step that read it, and is kept there once seen. Each card renders once.
  const cardStates = useMemo(
    () => new Map(state.signalCards.map((card) => [card.id, card.state])),
    [state.signalCards]);

  const drawnCardIds = useMemo(() => new Set([
    ...transcript.flatMap((msg) => {
      const id = messageSignalId({ metadata: msg.metadata });

      return id ? [id] : [];
    }),
    ...thread.entries.flatMap(({ message, landed = [] }) => [...splicesSeenOn({ metadata: message.metadata }), ...landed].map((splice) => splice.id)),
  ]), [transcript, thread.entries]);

  const liveSplices = useLiveSplices(thread.entries, state.signalCards, drawnCardIds);

  // An agent given work or reporting, and a signal with nowhere else to go, each where it happened.
  const looseEvents = useMemo((): PlacedEvent[] => [
    ...state.signalCards.flatMap((card): PlacedEvent[] => {
      if (drawnCardIds.has(card.id) || liveSplices.includes(card)) return [];
      const turn = classifyProgrammaticTurn({ metadata: card.metadata });

      return turn ? [{
        key: card.id,
        at: card.at,
        fold: JSON.stringify([turn.kind, card.text, card.state]),
        draw: (count) => <ProgrammaticTurnCard turn={turn} text={card.text} state={card.state} count={count} />,
      }] : [];
    }),
    ...state.subagentEvents.map((event) => subagentEventRow(event, agentId)),
  ], [state.signalCards, state.subagentEvents, drawnCardIds, liveSplices, agentId]);

  const threadMessages = useMemo(() => thread.entries.map(({ message }) => message), [thread.entries]);
  // The newest comparison the thread shows, which `/takes` opens: the chip it opens is that turn's.
  const latestTakes = useMemo(() => threadMessages.map((message) => takesByTurn[message.id]).filter(hasComparableTakes).at(-1), [threadMessages, takesByTurn]);
  const [takesAsked, setTakesAsked] = useState<{ readonly id: string; readonly nonce: number } | null>(null);
  const placed = useMemo(() => placeEvents(threadMessages, looseEvents), [threadMessages, looseEvents]);

  // A turn being reverted, and what the revert said once done.
  const [revertFor, setRevertFor] = useState<string | null>(null);
  const [restoreNotice, setRestoreNotice] = useState<string | null>(null);

  // The reverted message goes back to the composer, its words and its files, as it was sent (owner, 2026-10-25). The
  // paged history resets with the revert: an in-flight first page would otherwise restore the removed messages.
  const returnReverted = useCallback(() => {
    const message = threadMessages.find((each) => each.id === revertFor);

    history.reset();

    if (message === undefined) return;
    const words = rowText(message);

    ui.updateDraft((current) => (current.trim() === "" ? words : `${words}\n\n${current}`));
    detach(Effect.catchCause(reattached(message, attachments.add), (failed) => Effect.sync(() => {
      setRestoreNotice(`The reverted message's files did not come back to the composer: ${renderThrownChain({ cause: Cause.squash(failed) })}`);
    })));
  }, [threadMessages, revertFor, history, ui, attachments.add]);

  const slateInline = useMemo(() => ({
    rpc: state.rpc,
    openSlate: (id: string): void => show(`${SLATE_PREFIX}${id}`),
    openSite: (url: string) => {
      const shows = siteSurface(url, state.pinnedPorts);

      return shows === null ? undefined : () => { openPreview(shows, url); };
    },
    savedAs: (page: string) => state.slates.find((slate) => slate.page === page) ?? null,
  }), [state.rpc, state.slates, state.pinnedPorts, show, openPreview]);

  // What the inspector shows beside the chat, a slate or a site, folds its chat previews; a phone never shows both.
  const panelShows = (control: InspectorControl): string | null =>
    control.beside && !control.collapsed ? surfacePreviewTarget(surface, state.pinnedPorts) : null;

  const knownLayout = state.status?.layout ?? layout;
  const pending = useLayoutPending(knownLayout);
  // What the focus bar says of the main agent: its live step, else its watches (Muse's status and Upcoming, 1018-xao).
  const mainLine = useFocusLine(state.rpc, knownLayout === "focus", threadLiveTail({ last: state.messages.at(-1), liveness: state.liveness }));

  const as = state.actorSnapshot;
  // The roster holds the title; the visit (`touchWorkspace`) makes this workspace its newest row.
  const rosterEntry = workspaceEntries.find((entry) => entry.name === agentId);
  // Blank until the row is read: `agentId` is the URL slug, not a title, and "Untitled" would be a false one.
  const shownTitle = rosterEntry === undefined ? "" : workspaceDisplayTitle(rosterEntry);
  const focus = focusOf(knownLayout, shownTitle, { shown: shownAgent, all: agentsPanel.list, loaded: rosterLoaded }, mainLine);

  // The delete dialog goes with the bar, so a chat deleted from its sidebar row while the page connects asks too.
  const bar = (
    <>
      <WorkspaceBar workspace={agentId} title={shownTitle} editValue={rosterEntry === undefined ? "" : workspaceTitleDraft(rosterEntry)}
        state={state} agents={agentsPanel.list} shown={shownAgent} view={view} inspector={inspectorControl} actions={chatActions}
        focus={focus} pending={pending} />
      <DeleteChat chat={deletingChat} workspace={agentId} shown={subName} dismiss={state.dismissSubagent} onClose={() => setDeletingChat(null)} />
    </>
  );

  // Never unmount on transient WS errors.
  if (state.connectionStatus === "connecting" && !state.actorSnapshot) return (
    <div className="h-full flex flex-col">
      {bar}
      <div className="flex flex-1 items-center justify-center"><div className="t-body flex items-center gap-2 p-text-2"><Loader size="sm" /><span>Connecting...</span></div></div>
    </div>
  );

  if (state.terminalClose && !state.actorSnapshot) {
    return <div className="h-full flex flex-col">{bar}<div className="min-h-0 flex-1"><TerminalCloseBoundary close={state.terminalClose} onRetry={state.retryLoad} /></div></div>;
  }

  return (
    <OpenWorkspaceProvider value={agentId}>
    <SlateInlineContext.Provider value={slateInline}><FileLinkContext.Provider value={fileLinks}><ChatImageContext.Provider value={chatImages}>
    <div className="h-full flex flex-col" data-workbench>
      {/* The chat stays mounted through reconnect so the in-flight turn survives. */}
      {state.connectionStatus === "disconnected" && !state.terminalClose && (
        <div className="p-banner-warning t-meta flex items-center justify-center gap-2 px-3 py-1 p-warning border-b p-border">
          <ArrowsClockwiseIcon size={12} className="animate-spin" />Reconnecting...
        </div>
      )}
      {state.terminalClose && (
        <div className="p-banner-danger t-meta flex flex-wrap items-center justify-center gap-2 px-3 py-1 p-danger border-b p-border">
          <WarningCircleIcon size={12} className="shrink-0" />
          <span className="break-words">{closeWords(state.terminalClose).title}. {closeWords(state.terminalClose).detail}</span>
          <Button variant="ghost" size="sm" onClick={state.retryLoad}>Try again</Button>
          <Link to="/" className="p-link">Back to your workspaces</Link>
        </div>
      )}

      {bar}

      {view !== undefined && <WorkspaceView view={view} workspace={agentId} title={shownTitle} state={state} agents={agentsPanel.list}
        open={(agent) => { detachPromise(() => agentsPanel.open(agent)); }} clearMain={() => setClearingMain(true)} />}
      {view === undefined && (
      <WorkbenchPanels
        ref={workbench}
        workspace={agentId}
        contents={state}
        quiet={focus !== null}
        onInspector={setInspectorControl}
        chat={(control) => <SubagentChatBase.Provider value={{ base: `${workspaceRoute(agentId)}/agents/`, parent: null }}><ChatSlates shownInPanel={panelShows(control)}>
            {shownNode !== null && (
              <SwarmNodePane key={shownNode} main={state} node={shownNode} ownerPath={nodeOwner} agent={shownAgent} rosterLoaded={rosterLoaded} />
            )}
            {shownNode === null && (subName ? (
              <AgentPlanWindowContext.Provider value={reviewed.showAgentWindow}>
                <AttentionContext.Provider value={{ reads: { ...state, questions: state.ownerQuestions }, stack: attentionCalls }}>
                  <AgentChatColumn key={subName} workspace={agentId} subName={subName} subagents={state.subagents} rpc={state.rpc} ids={linkIds}
                    input={shownAgent?.input ?? true} />
                </AttentionContext.Provider>
              </AgentPlanWindowContext.Provider>
            ) : (
            <ChatColumn pane={mainPane} label="Chat" state={state} ui={ui} chat={chat} retryOwed={retryOwed} input
              placeholder={live ? "Steer the running turn…" : restingPlaceholder(focus)}
              attention={<AttentionStack asks={ownerAsks({ ...state, accountProposals, questions: state.ownerQuestions })} {...attentionCalls} />}
              empty={<EmptyConversation mission={as?.mission ?? ""} />}
              asked={asked} answerSlates={WORKSPACE_CHAT} layout={{ startFirst: true, padClass: "pt-6 pb-12" }}
              extras={{
                float: (
                  <BackgroundWork workspace={agentId} agents={agentsPanel.list} jobs={state.backgroundJobs}
                    open={(agent) => { detachPromise(() => agentsPanel.open(agent)); }} openWork={() => show("Work")} />
                ),
                before: (i) => placed.before.get(i),
                row: (msg, i) => {
                  const takes = takesByTurn[msg.id];
                  const signalId = messageSignalId({ metadata: msg.metadata });

                  return {
                    splices: i === thread.entries.length - 1 ? liveSplices : undefined,
                    onFork: onForkMessage,
                    onFeedback: onMessageFeedback,
                    feedback: feedbackByMessage[msg.id] ?? null,
                    onRevert: setRevertFor,
                    takesChip: hasComparableTakes(takes) ? <TakesChip set={takes} onPick={onPickTake} opened={takesAsked?.id === takes.id ? takesAsked.nonce : undefined} /> : undefined,
                    signalState: signalId === null ? undefined : cardStates.get(signalId),
                    onOpenChangeNote: openChangeNote,
                  };
                },
                afterTail: placed.after,
                trailing: (
                  <>
                    {state.branchRuns.map((run) => (
                      <BranchRunChip
                        key={run.branchId}
                        run={run}
                        takes={run.turnId ? takesByTurn[run.turnId] : undefined}
                        rpc={state.rpc}
                        headActivity={state.headActivity}
                        headDeltas={state.headDeltas}
                        onPick={onPickTake}
                        onDismiss={() => state.dismissBranchRun(run.branchId)}
                      />
                    ))}
                    <DeviceOfflineRow devices={state.unavailableDevices} />
                  </>
                ),
                attachments,
                drop: chatDrop,
                onBranch: handleBranch,
                commands: (say) => workspaceCommands({
                  workspace: agentId, say, clear: () => { setClearingMain(true); }, compact: async () => state.rpc("compactConversation", []), show, go: (path) => Effect.promise(async () => navigate(path)),
                  history: chat.readAll,
                  walkBack: setRevertFor,
                  rename: (name) => Effect.catchCause(Effect.asVoid(Effect.promise(async () => state.rpc("renameMainChat", [name]))),
                    (failed) => Effect.sync(() => { say(`Could not rename this chat: ${readFailureText({ cause: Cause.squash(failed) })}`); })),
                  role: {
                    current: async () => (await state.rpc("getAgentStatus", [])).roleId ?? null,
                    choose: async (id) => (await state.rpc("setRole", [id])).role,
                  },
                  takes: {
                    latest: latestTakes,
                    open: (set) => { setTakesAsked((before) => ({ id: set.id, nonce: (before?.nonce ?? 0) + 1 })); },
                    pick: (set, nodeId) => onPickTake(set.id, nodeId),
                  },
                }),
                notices: [
                  ...SIDE_SOURCES.flatMap(({ source, label }) => {
                    const message = sideErrors[source];

                    return message
                      ? [{ id: `side-${source}`, tone: "warning" as const,
                          text: `Could not ${label}: ${message}`,
                          onDismiss: () => reportSide(source, null) }]
                      : [];
                  }),
                  ...(branchNotice ? [{ id: "branch", tone: "warning" as const, hooks: { "data-branch-notice": "" },
                    text: `Branch unavailable: ${branchNotice}`, onDismiss: () => setBranchNotice(null) }] : []),
                  ...(restoreNotice ? [{ id: "restore", tone: "neutral" as const, text: restoreNotice,
                    onDismiss: () => setRestoreNotice(null) }] : []),
                ],
              }} />
            ))}
        </ChatSlates></SubagentChatBase.Provider>}
        inspector={(
          // `planOwner` is the actor's registered name, as the work read reports it; the root's is the workspace's.
          <WorkSurface
            surface={surface}
            previewFocus={state.previewFocus}
            planFocus={state.planFocus}
            changesFocus={changesFocus}
            filesFocus={filesFocus}
            planOwner={planOwnerName(subName, agentId)}
            planRpc={reviewed.planRpc}
            workspacePlanArrival={state.workspacePlanArrival}
            onReviewActor={async (name, actorId) => {
              await navigate(`${subagentBase(agentId, name).slice(0, -1)}${actorId === undefined ? "" : `?actor=${encodeURIComponent(actorId)}`}`);
              workbench.current?.showChat();
            }}
            onSurface={setSurface}
            agents={agentsPanel}
            pinnedPorts={state.pinnedPorts}
            previewAddress={previewAddress}
            previewError={state.previewError}
            previewStarting={state.previewStarting}
            onRefreshPorts={() => detachPromise(state.refreshExposedPorts)}
            plan={visiblePlan}
            owedIntents={state.owedIntents}
            snapshot={state.snapshot}
            onRetryLoad={state.retryLoad}
            memory={state.memory}
            memoryContent={state.memoryContent}
            onSearchMemory={state.searchMemory}
            mctsTrees={state.mctsTrees}
            headActivity={state.headActivity}
            headDeltas={state.headDeltas}
            isStreaming={live}
            executors={state.executors}
            executorOutputs={state.executorOutputs}
            lastActiveExecutor={state.lastActiveExecutor}
            onExecute={state.executeInExecutor}
            backgroundJobs={state.backgroundJobs}
            inspectedWork={state.inspectedWork}
            onRefreshJobs={() => detachPromise(state.refreshBackgroundJobs)}
            pendingActions={state.pendingActions}
            onOpenAsk={openAsk}
            slates={state.slates}
            slateReloads={state.slateReloads}
            changesMoved={state.changesMoved}
            readMoves={state.readMoves}
            contextMeasures={state.contextMeasures}
            tabPresence={state.tabPresence}
            presencePending={state.tabPresence === undefined}
            rpc={state.rpc}
            workspace={agentId}
            forkLanding={forkLanding}
            onForkLandingOpened={forkLandingOpened}
            desktopLanding={desktopLanding}
            onDesktopLanded={desktopLanded}
          />
        )}
      />
      )}

      {forkFor && (
        <ForkModal
          sourceName={shownTitle}
          messagesUpToHere={messagesUpTo(transcript, forkFor, state.actorSnapshot?.messageCount, { positions, inFlight: turnRows(transcript, live) })}
          onCancel={() => setForkFor(null)}
          onSubmit={(name) => settle(Effect.catchCause(Effect.gen(function* () {
            const result = yield* Effect.promise(async () => state.forkAgent(forkFor, name ? { name } : undefined));
            setForkFor(null);
            yield* Effect.promise(async () => navigate(result.url));
          }), (failed) => Effect.gen(function* () {
            const err = Cause.squash(failed);

            return yield* Effect.die(err instanceof Error ? err : new Error(String(err)));
          })))}
        />
      )}

      <MainClearDialog open={clearingMain} agents={agentsPanel.list} onClose={() => setClearingMain(false)}
        // Only once the server has cleared: a refusal stays in the dialog over the transcript it kept. The paged
        // history resets with it, or an in-flight first page would restore the cleared messages.
        onClear={async () => { await state.clearConversation(); history.reset(); }} />

      <TurnRevert messageId={revertFor} rpc={state.rpc} onClose={() => setRevertFor(null)}
        onReverted={returnReverted} onNotice={setRestoreNotice} />

    </div>
    </ChatImageContext.Provider></FileLinkContext.Provider></SlateInlineContext.Provider>
    </OpenWorkspaceProvider>
  );
}

/** A chat's line in the `focus` bar: what its agent is doing, in words. */
function activityLine(agent: PanelAgent | undefined): string {
  if (agent === undefined) return "";

  const doing: Partial<Record<PanelAgent["activity"], string>> = { working: "Working", waiting: "Waiting on you", stopped: "Stopped", failed: "Last run failed" };

  return doing[agent.activity] ?? "Idle";
}

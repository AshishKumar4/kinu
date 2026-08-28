/**
 * TUI Chat Application — the single OpenTUI React chat surface for both
 * backends, parameterized by an AgentClient (LocalAgentClient over
 * LocalAgentSession, CloudAgentClient over the OrchestratorAgent DO). The
 * client owns transport, recording, and history; this renders its
 * AgentClientEvent stream into scrollable message history with streaming text,
 * tool rows, evolution markers, status, shared workspace navigation, profile
 * hubs, and exclusive consent overlays.
 *
 * The input reducer owns turn state. The semantic action registry owns every
 * key chord, so queue, branch, cancel, and editor behavior stay preset-safe.
 */

import {
  createCliRenderer,
  type ScrollBoxRenderable,
  type TextareaRenderable,
} from '@opentui/core';
import { createRoot, useKeyboard, useRenderer, useTerminalDimensions } from '@opentui/react';
import { useState, useCallback, useRef, useEffect, useMemo } from 'react';

import {
  DEFAULT_ROLE_ID, TIER_IDS, TUI_COMPOSER_PLACEHOLDER, effectiveRoleCatalog,
  type AlternateTakeCandidate, type AlternateTakeSet, type ChangelogEntry, type TierId,
} from '@kinu.run/core';
import {
  findForkPivot,
  forkCandidates,
  type AgentChangelogView,
  type AgentClient,
  type AgentClientEvent,
  type AgentClientSendOptions,
  type AgentClientStatus,
  type DeviceConsentDecision,
  type ForkPoint,
  type PendingDeviceConsent,
} from '../agent-client';
import {
  commandsForClient,
  describeBranchStatus,
  describeTakePick,
  executeSlashCommand,
  filterCommands,
  isBranchStatusEvent,
  performUndo,
  resolveCommandDraft,
  setModelPreference,
  setReasoningEffortPreference,
  type SlashOutcome,
} from '../slash-commands';
import { describePromptAttachment, resolvePromptAttachments } from '../attachments';
import { listSidebarAgents } from '../agent-list';
import { watchDeviceConsents } from '../consent-watch';
import { contextWindowForSpec, EMPTY_MODEL_MENU, type AgentModelEntry, type AgentModelMenu } from '../model-catalog';
import { requireInteractiveTerminal } from '../prompt';
import { loadActiveProfile } from '../profiles';
import { canonicalProjectRoot } from '../config';
import { guideFailure } from '../provider-guidance';
import { openBrowser } from '../commands/auth';
import { StatusBar } from './status-bar';
import { MessageList, type DisplayMessage } from './messages';
import {
  ChangelogOverlay,
  CommandHintOverlay,
  deviceConsentCanApprove,
  CommandPaletteOverlay,
  DeviceConnectOverlay,
  DeviceConsentOverlay,
  ModelPickerOverlay,
  PhaseLine,
  TakesOverlay,
  SettingsOverlay,
  type TuiSettingChoice,
  WalkbackOverlay,
} from './overlays';
import { useDeviceConnectPrompt } from './use-device-connect';
import { estimateContextTokens } from './context-status';
import { useStreamingBuffer } from './streaming-buffer';
import { initialInputState, reduceInput, type InputEffect, type InputMachineEvent } from './input-state';
import { agentDisplayLabel, clipText } from './format';
import { createKeyDispatcher, openTuiKeyBindings, type TuiActionId } from './actions';
import { buildAgentHubEntries, HubOverlay, type TuiHubData, type TuiHubView } from './hubs';
import { useTuiTheme } from './theme';
import {
  TuiProductProvider,
  TuiShell,
  tuiLayoutForWidth,
  usePreservedScrollAnchor,
  useTuiProduct,
  useAgentRoster,
  agentSourceFromList,
  type TuiRuntimeOptions,
  type TuiAgentSource,
  type TuiAgentSummary,
} from './tui-shell';
import { diagnostics, renderThrownChain, toKinuError } from '@kinu.run/core/obs';

/** What a host's one-click creator produced, and how the scene proceeds:
 *  a `local-peer` is a full root in the current virtual workspace and is
 *  opened in place; a `cloud-additional` agent runs beside the workspace's
 *  conversation server-side, so the scene announces it instead. */
export interface TuiCreatedAgent {
  name: string;
  displayName: string;
  kind: 'local-peer' | 'cloud-additional';
  /** A host-prepared client for a conversation that is not in the workspace
   * navigator, such as a direct cloud additional-agent facet. */
  client?: AgentClient;
}

export interface ChatAppOpts {
  client: AgentClient;
  /** Seed the message list from client.history() before accepting input. */
  hydrateHistory?: boolean;
  onExit?: () => void;
  /** A cloud walk-back fork swaps in a sibling client; the host needs the
   *  current one so exit cleanup closes the right connection. */
  onClientChange?: (client: AgentClient) => void;
  workspaceSource?: TuiAgentSource;
  onWorkspaceSelect?: (name: string) => Promise<AgentClient>;
  /** One-click additional agent beside the CURRENT client's conversation —
   *  no role, no mission form. Wired by the host because creation is a host
   *  concern (local ref registry / cloud backend client). */
  onNewAgent?: (client: AgentClient) => Promise<TuiCreatedAgent>;
  profileMutations?: {
    setModel(spec: string): Promise<{ spec: string }>;
    setReasoningEffort(effort: 'low' | 'medium' | 'high'): Promise<{ effort: 'low' | 'medium' | 'high' }>;
  };
  tui?: TuiRuntimeOptions;
  hubData?: TuiHubData;
}

type ActiveSurface =
  | { kind: 'commands' }
  | { kind: 'settings' }
  | { kind: 'hub'; view: TuiHubView }
  | { kind: 'model'; menu: AgentModelMenu; loading: boolean; error: string | null }
  | { kind: 'changelog'; view: AgentChangelogView }
  | { kind: 'takes'; set: AlternateTakeSet }
  | null;


interface CaughtFailure {
  cause: unknown;
}

function persistedTranscriptEvent(event: AgentClientEvent): boolean {
  return event.type === 'turn-start'
    || event.type === 'text-delta'
    || event.type === 'tool-call'
    || event.type === 'tool-result'
    || event.type === 'step-finish'
    || event.type === 'turn-end'
    || event.type === 'error';
}

let globalExit: (() => void) | null = null;

export function ChatApp(props: ChatAppOpts) {
  return (
    <TuiProductProvider runtime={props.tui}>
      <ChatScene {...props} />
    </TuiProductProvider>
  );
}

function ChatScene({
  client: initialClient,
  hydrateHistory,
  onExit,
  onClientChange,
  workspaceSource: workspaceSourceInput,
  onWorkspaceSelect,
  onNewAgent,
  profileMutations: suppliedProfileMutations,
  hubData,
}: ChatAppOpts) {
  const { width, height } = useTerminalDimensions();
  const { colors } = useTuiTheme();
  const { keybindings, updatePreferences } = useTuiProduct();
  const keyDispatcher = useMemo(() => createKeyDispatcher(keybindings), [keybindings]);
  const workspaceSource = useMemo(
    () => workspaceSourceInput ?? agentSourceFromList(listSidebarAgents),
    [workspaceSourceInput],
  );
  const roster = useAgentRoster(workspaceSource);
  const [navigationOpen, setNavigationOpen] = useState(false);
  // The client can be swapped mid-session: a cloud walk-back fork returns a
  // sibling client pointed at the forked agent.
  const [client, setClient] = useState(initialClient);
  const [messages, setMessages] = useState<DisplayMessage[]>(() => [welcomeMessage(client.agentName)]);
  const messagesRef = useRef(messages);
  messagesRef.current = messages;
  const [turnPhase, setTurnPhase] = useState<string | null>(null);
  const [ready, setReady] = useState(false);
  const [status, setStatus] = useState<AgentClientStatus | null>(null);
  const [modelSpec, setModelSpec] = useState<string>('');
  const [nextTier, setNextTier] = useState<TierId | null>(null);
  const [modelCatalog, setModelCatalog] = useState<AgentModelEntry[]>([]);
  const [activeSurface, setActiveSurface] = useState<ActiveSurface>(null);
  const [pendingConsent, setPendingConsent] = useState<PendingDeviceConsent | null>(null);
  const modelPicker = activeSurface?.kind === 'model' ? activeSurface : null;
  const changelogView = activeSurface?.kind === 'changelog' ? activeSurface.view : null;
  const takesView = activeSurface?.kind === 'takes' ? activeSurface.set : null;
  const commandPalette = activeSurface?.kind === 'commands';
  const hubView = activeSurface?.kind === 'hub' ? activeSurface.view : null;
  const settingsOpen = activeSurface?.kind === 'settings';
  // The hub describes ONE open workspace, so its state carries that
  // workspace's identity: a switch resets it synchronously alongside every
  // other per-client piece, and the refresh effect re-derives it from the
  // same active target — no second record of which workspace it describes.
  const [hub, setHub] = useState<{ identity: string; data: TuiHubData } | null>(
    hubData ? { identity: `${initialClient.mode}:${initialClient.agentName}`, data: hubData } : null,
  );
  const [draft, setDraft] = useState('');
  // Each conversation keeps its own composer draft across switches — leaving
  // saves under the OLD client's key, arriving restores under the new one's.
  const draftsRef = useRef(new Map<string, string>());
  const [inputState, setInputState] = useState(initialInputState);
  /** Steer-as-Branch runs in flight, branchId → task (status-bar segment). */
  const profileMutations = suppliedProfileMutations ?? {
    setModel: (spec: string) => setModelPreference(client, spec),
    setReasoningEffort: (effort: 'low' | 'medium' | 'high') =>
      setReasoningEffortPreference(client, effort),
  };
  const [branchTasks, setBranchTasks] = useState<Record<string, string>>({});
  const [toolDetailsExpanded, setToolDetailsExpanded] = useState(false);

  const msgIdRef = useRef(0);
  const historyRef = useRef<ScrollBoxRenderable | null>(null);
  const inputRef = useRef<TextareaRenderable | null>(null);
  const scrollAnchor = usePreservedScrollAnchor(historyRef);
  const handleNavigationFocusChange = useCallback((focused: boolean) => {
    if (focused) inputRef.current?.blur();
    else if (ready) inputRef.current?.focus();
  }, [ready]);
  // Mirrors the input's declarative `focused` condition so a click can reassert
  // focus without introducing a second focus state.
  const inputShouldFocusRef = useRef(false);
  const machineRef = useRef(initialInputState);
  /** A fork swap re-points the message list itself — skip the next hydration. */
  const selectionPendingRef = useRef(false);
  const skipHydrationRef = useRef(false);
  const preconnectedClientRef = useRef<AgentClient | null>(null);
  const preconnectedEventsRef = useRef<{
    client: AgentClient;
    events: AgentClientEvent[];
    historyBoundary: number;
    stop: () => void;
  } | null>(null);
  const clientGenerationRef = useRef(0);
  const clientActionCountRef = useRef(0);
  /** Take sets already hinted at, so a turn without a new convergence is quiet. */
  const hintedTakesRef = useRef<string | null>(null);
  const modelRequestRef = useRef(0);
  const commands = useMemo(() => commandsForClient(client), [client]);
  const deviceConnect = useDeviceConnectPrompt();
  const settings = useMemo<TuiSettingChoice[]>(() => {
    const effort = status?.reasoningEffort ?? 'medium';
    const rows: TuiSettingChoice[] = [
      {
        id: 'model',
        group: 'Model',
        label: 'Active model',
        value: modelSpec || 'default',
        command: '/model',
      },
      ...(['low', 'medium', 'high'] as const).map((value) => ({
        id: `effort-${value}`,
        group: 'Model',
        label: `Reasoning effort: ${value}`,
        value: value === effort ? 'current' : '',
        command: `/effort ${value}`,
      })),
    ];
    if (client.localControls) {
      const approval = client.localControls.getShellApprovalMode();
      rows.push(...(['strict', 'allow_all', 'deny_all'] as const).map((value) => ({
        id: `approval-${value}`,
        group: 'Local shell',
        label: value.replaceAll('_', ' '),
        value: value === approval ? 'current' : '',
        command: `/approval ${value}`,
      })));
      const activeSkills = client.localControls.getAlwaysActiveSkills();
      rows.push({
        id: 'always-active-skills',
        group: 'Skills',
        label: 'Always active',
        value: activeSkills.length > 0 ? activeSkills.join(', ') : 'none',
        command: '/always ',
      });
    }
    return rows;

  }, [client, modelSpec, status?.reasoningEffort]);
  useEffect(() => {
    if (activeSurface?.kind !== 'model') modelRequestRef.current += 1;
  }, [activeSurface?.kind]);

  const isProcessing = inputState.activeTurns > 0;

  const addMessage = useCallback((msg: Omit<DisplayMessage, 'id'>) => {
    const id = `msg-${++msgIdRef.current}`;
    setMessages((prev) => [...prev, { ...msg, id }]);
  }, []);


  const addError = useCallback((failure: CaughtFailure) => {
    addMessage({ role: 'system', content: errorLine(renderThrownChain(failure)) });
  }, [addMessage]);
  // ── Live assistant text segments — the key to chronological interleaving.
  // Streamed text-deltas flow into a `live` assistant message that sits at its
  // real position in the array. A tool-call SEALS the active segment so the
  // next text-delta opens a fresh segment AFTER the tool, giving true
  // text → tool → text → tool order (rather than buffering all text to a
  // trailing block that renders after every tool card).
  const activeSegmentRef = useRef<string | null>(null);
  /** Whether the current turn streamed any assistant text. When false at
   *  turn-end, turn.text was synthesized server-side (no deltas) and must be
   *  appended once so the answer isn't dropped from the live view. */
  const turnStreamedTextRef = useRef(false);

  /** Stream-buffer flush target: write coalesced text into the live segment. */
  const writeActiveSegment = useCallback((value: string | null) => {
    const id = activeSegmentRef.current;
    if (!id || value === null) return;
    setMessages((prev) => prev.map((m) => (m.id === id ? { ...m, content: value } : m)));
  }, []);
  const stream = useStreamingBuffer(writeActiveSegment);

  /** Open a fresh live assistant segment and route streamed text into it. */
  const beginSegment = useCallback(() => {
    const id = `msg-${++msgIdRef.current}`;
    activeSegmentRef.current = id;
    setMessages((prev) => [...prev, { id, role: 'assistant', content: '', live: true }]);
    stream.start();
  }, [stream]);

  /** Seal the live segment in place: stop streaming, keep its text, drop the
   *  cursor. An empty segment (tool fired before any text) is removed. */
  const sealSegment = useCallback(() => {
    const id = activeSegmentRef.current;
    activeSegmentRef.current = null;
    stream.clear();
    if (!id) return;
    setMessages((prev) =>
      prev.flatMap((m) => (m.id === id ? (m.content.trim() ? [{ ...m, live: false }] : []) : [m])),
    );
  }, [stream]);

  /** All input transitions flow through the one reducer; effects come back to
   *  the caller so client events and keypresses never race over state. */
  const dispatchInput = useCallback((event: InputMachineEvent): InputEffect[] => {
    const { state, effects } = reduceInput(machineRef.current, event);
    machineRef.current = state;
    setInputState(state);
    return effects;
  }, []);

  const setInputText = useCallback((text: string) => {
    inputRef.current?.setText(text);
    setDraft(text);
  }, []);

  /** Send (or steer) one user prompt. @path mentions (plus quoted/~ path
   *  tokens) become attachments: images and PDFs inline as file parts, other
   *  files stay path references. */
  const sendPrompt = useCallback(async (input: string) => {
    const generation = clientGenerationRef.current;
    clientActionCountRef.current += 1;
    try {
      const prompt = await resolvePromptAttachments(input, { limitBytes: client.inlineAttachmentLimitBytes });
      if (clientGenerationRef.current !== generation) return;
      for (const problem of prompt.errors) addMessage({ role: 'system', content: problem });
      const steering = machineRef.current.activeTurns > 0;
      const message: Omit<DisplayMessage, 'id'> = {
        role: 'user',
        content: prompt.text,
      };
      if (prompt.attached.length > 0) message.attachments = prompt.attached.map(describePromptAttachment);
      if (steering) message.steered = true;
      addMessage(message);
      const payload = prompt.files.length > 0 ? { text: prompt.text, files: prompt.files } : prompt.text;
      const sendOptions: AgentClientSendOptions = { cwd: process.cwd() };
      if (nextTier) sendOptions.tier = nextTier;
      if (steering && client.steer(payload, sendOptions)) {
        setNextTier(null);
        return;
      }
      setNextTier(null);
      await client.send(payload, sendOptions);
    } catch (err) {
      if (clientGenerationRef.current === generation) addError({ cause: err });
    } finally {
      clientActionCountRef.current -= 1;
    }
  }, [addError, addMessage, client, nextTier]);

  /** Run the draft as a parallel branch of the live turn — never interrupts
   *  it; progress lands in the status bar and settles into /takes. Falls back
   *  to a normal send when the turn just finished. */
  const performBranch = useCallback(async (input: string) => {
    const text = input.trim();
    if (!text) return;
    if (machineRef.current.activeTurns > 0 && client.branch(text, { cwd: process.cwd() })) {
      addMessage({ role: 'user', content: text, branched: true });
      return;
    }
    await sendPrompt(text);
  }, [addMessage, client, sendPrompt]);

  /** Fork before the picked user message, truncate the rendered transcript to
   *  match, and put the message back in the input for editing. */
  const performWalkback = useCallback(async (point: ForkPoint) => {
    if (selectionPendingRef.current) return;
    selectionPendingRef.current = true;
    setReady(false);
    dispatchInput({ type: 'walkback-closed' });
    try {
      const result = await client.fork(point);
      if (result.client !== client) {
        setReady(false);
        setStatus(null);
        setModelSpec('');
        clientGenerationRef.current += 1;
        setModelCatalog([]);
        setBranchTasks({});
        skipHydrationRef.current = true;
        const previous = client;
        setClient(result.client);
        onClientChange?.(result.client);
        void previous.close().catch((closeError) => {
          const reason = renderThrownChain({ cause: closeError });
          addMessage({ role: 'system', content: `The pre-fork session did not close cleanly: ${reason}` });
        });
      }
      setMessages((prev) => {
        const pivot = findForkPivot(prev, point);
        const kept = pivot < 0 ? prev : prev.slice(0, pivot);
        return [...kept, {
          id: `msg-${++msgIdRef.current}`,
          role: 'system',
          content: `Forked ${result.label} — edit the message and press Enter to resend.`,
        }];
      });

      setInputText(point.text);
    } catch (err) {
      addError({ cause: err });
    } finally {
      selectionPendingRef.current = false;
      setReady(true);
    }
  }, [addError, addMessage, client, dispatchInput, onClientChange, setInputText]);
  const switchWorkspace = useCallback(async (
    workspace: TuiAgentSummary,
    preparedClient?: AgentClient,
  ) => {
    if (!preparedClient && workspace.name === client.agentName && workspace.mode === client.mode) {
      setNavigationOpen(false);
      return;
    }
    if (!onWorkspaceSelect && !preparedClient) {
      setNavigationOpen(false);
      addMessage({ role: 'system', content: 'Workspace switching is unavailable in this host.' });
      return;
    }
    if (machineRef.current.activeTurns > 0 || clientActionCountRef.current > 0) {
      setNavigationOpen(false);
      addMessage({ role: 'system', content: 'Finish or stop the active workspace action before switching.' });
      return;
    }
    if (selectionPendingRef.current) return;
    selectionPendingRef.current = true;
    setNavigationOpen(false);
    setReady(false);
    let candidate: AgentClient | null = null;
    const bufferedEvents: AgentClientEvent[] = [];
    let stopBuffering: (() => void) | null = null;
    let historyBoundary = 0;
    try {
      if (preparedClient) candidate = preparedClient;
      else if (onWorkspaceSelect) candidate = await onWorkspaceSelect(workspace.name);
      else throw new Error('Workspace switching is unavailable in this host.');
      stopBuffering = candidate.subscribe((event) => { bufferedEvents.push(event); });
      await candidate.connect();
      let history: DisplayMessage[] = [];
      let historyFailure: string | null = null;
      try {
        history = await candidate.history();
        historyBoundary = bufferedEvents.length;
      } catch (error) {
        historyFailure = errorLine(`Earlier messages could not be loaded: ${renderThrownChain({ cause: error })}`);
      }
      const previous = client;
      // The draft belongs to the conversation being left, and the one being
      // entered gets its own back (or a clean line the first time).
      draftsRef.current.set(`${previous.mode}:${previous.agentName}`, inputRef.current?.plainText ?? '');
      preconnectedClientRef.current = candidate;
      preconnectedEventsRef.current = {
        client: candidate,
        events: bufferedEvents,
        historyBoundary,
        stop: stopBuffering,
      };
      stopBuffering = null;
      skipHydrationRef.current = true;
      clientGenerationRef.current += 1;
      activeSegmentRef.current = null;
      setTurnPhase(null);
      setStatus(null);
      setModelSpec('');
      setModelCatalog([]);
      setBranchTasks({});
      // A pending next-turn tier belongs to the conversation being left; the
      // hub is re-derived from the target below. Neither survives a switch.
      setNextTier(null);
      setHub(null);
      setInputState(initialInputState);
      setInputText(draftsRef.current.get(`${candidate.mode}:${candidate.agentName}`) ?? '');
      setMessages([
        welcomeMessage(candidate.agentName),
        ...history,
        ...(historyFailure
          ? [{ id: `switch-history-${++msgIdRef.current}`, role: 'system' as const, content: historyFailure }]
          : []),
      ]);
      setClient(candidate);
      onClientChange?.(candidate);
      candidate = null;
      void previous.close().catch((error) => {
        addMessage({
          role: 'system',
          content: errorLine(`The previous workspace did not close cleanly: ${renderThrownChain({ cause: error })}`),
        });
      });
    } catch (error) {
      stopBuffering?.();
      if (candidate) {
        try {
          await candidate.close();
        } catch (closeError) {
          diagnostics.failure(
            'tui.workspace_candidate_close_failed',
            toKinuError({
              doing: 'closing a failed workspace switch candidate',
              cause: closeError,
              otherwise: 'io',
            }),
            { workspace: candidate.agentName },
          );
        }
      }
      setReady(true);
      addError({ cause: error });
    } finally {
      selectionPendingRef.current = false;
    }
  }, [addError, addMessage, client, onClientChange, onWorkspaceSelect, setInputText, stream]);


  /** One-click additional agent — the Agent Hub's `n`. Both backends open the
   * new conversation in place; cloud supplies a prepared facet client because
   * that conversation is nested under its parent workspace. */
  const createNewAgent = useCallback(async () => {
    if (onNewAgent === undefined || selectionPendingRef.current) return;
    if (machineRef.current.activeTurns > 0 || clientActionCountRef.current > 0) {
      addMessage({ role: 'system', content: 'Finish or stop the active workspace action before creating an agent.' });
      return;
    }
    addMessage({ role: 'system', content: 'Creating a new agent…' });
    try {
      const created = await onNewAgent(client);
      if (created.client) {
        await roster.reload();
        await switchWorkspace(
          { name: created.name, label: agentDisplayLabel(created.displayName), mode: 'cloud' },
          created.client,
        );
        return;
      }
      await roster.reload();
      await switchWorkspace({ name: created.name, label: agentDisplayLabel(created.displayName), mode: 'local' });
    } catch (error) {
      addError({ cause: error });
    }
  }, [addError, addMessage, client, onNewAgent, roster, switchWorkspace]);
  useEffect(() => {
    const identity = `${client.mode}:${client.agentName}`;
    if (hub !== null && hub.identity === identity) return;
    let cancelled = false;
    loadHubData(client, client.agentName)
      .then((fresh) => { if (!cancelled) setHub({ identity, data: fresh }); })
      .catch((error) => {
        diagnostics.failure(
          'tui.hub_refresh_failed',
          toKinuError({ doing: 'refreshing the agent hub', cause: error, otherwise: 'unavailable' }),
          { workspace: client.agentName },
        );
      });
    return () => { cancelled = true; };
  }, [client, hub]);

  // The hub's agent rows, live: the current virtual workspace's members from
  // the same roster the navigator reads, with the open agent's role/tier from
  // its loaded profile row and its status from this scene.
  const projectRoot = useMemo(() => canonicalProjectRoot(), []);
  const hubLive = useMemo<TuiHubData | undefined>(() => !hub ? undefined : {
    ...hub.data,
    agents: buildAgentHubEntries({
      items: roster.page.items,
      current: { name: client.agentName, mode: client.mode },
      currentEntry: {
        ...(hub.data.agents[0] ?? { kind: 'main' as const }),
        id: `${client.mode}:${client.agentName}`,
        label: status?.name ?? client.agentName,
        kind: 'main',
        status: isProcessing ? 'running' : 'idle',
        workspace: hub.data.agents[0]?.workspace ?? client.agentName,
      },
      projectRoot,
    }),
  }, [hub, roster.page.items, client, status?.name, isProcessing, projectRoot]);

  const openModelPicker = useCallback(async () => {
    const request = ++modelRequestRef.current;
    setActiveSurface({ kind: 'model', menu: EMPTY_MODEL_MENU, loading: true, error: null });
    try {
      const menu = await client.listModels();
      if (modelRequestRef.current !== request) return;
      setModelCatalog(menu.models);
      setActiveSurface({ kind: 'model', menu, loading: false, error: null });
    } catch (err) {
      if (modelRequestRef.current !== request) {
        diagnostics.failure(
          'tui.model_list_stale_failure',
          toKinuError({
            doing: 'listing models for a closed TUI panel',
            cause: err,
            otherwise: 'unavailable',
          }),
          { workspace: client.agentName },
        );
      } else {
        setActiveSurface({
          kind: 'model',
          menu: EMPTY_MODEL_MENU,
          loading: false,
          error: renderThrownChain({ cause: err }),
        });
      }
    }
  }, [client]);

  const selectModel = useCallback(async (model: AgentModelEntry) => {
    if (selectionPendingRef.current) return;
    setReady(false);
    selectionPendingRef.current = true;
    setActiveSurface(null);
    try {
      const result = await profileMutations.setModel(model.spec);
      setModelSpec(result.spec);
      addMessage({ role: 'system', content: `Model: ${result.spec}` });
    } catch (err) {
      addError({ cause: err });
    } finally {
      selectionPendingRef.current = false;
      setReady(true);
    }
  }, [addError, addMessage, client]);

  /** Enter on a changelog line: revert revertables through the real paths,
   *  explain informational lines; the overlay refreshes with the new digest. */
  const revertChangelogEntry = useCallback(async (entry: ChangelogEntry) => {
    if (selectionPendingRef.current) return;
    selectionPendingRef.current = true;
    setActiveSurface(null);
    setReady(false);
    try {
      if (!entry.revert) {
        addMessage({ role: 'system', content: `"${entry.summary}" is informational (${entry.kind}) — nothing to revert.` });
        return;
      }
      const result = await client.revertChangelogEntry(entry.id);
      addMessage({
        role: 'system',
        content: result.ok
          ? `Reverted: ${entry.summary}\n→ ${result.detail ?? 'done'}`
          : `Revert failed: ${result.error ?? 'unknown error'}`,
      });
    } catch (err) {
      addError({ cause: err });
    } finally {
      selectionPendingRef.current = false;
      setReady(true);
    }
  }, [addError, addMessage, client]);

  /** Enter on a take: record the pick (ledger + repoint); a changed answer
   *  streams its continuation as the next programmatic turn. */
  const pickTake = useCallback(async (set: AlternateTakeSet, candidate: AlternateTakeCandidate) => {
    if (selectionPendingRef.current) return;
    selectionPendingRef.current = true;
    setActiveSurface(null);
    setReady(false);
    try {
      const index = set.candidates.findIndex((entry) => entry.nodeId === candidate.nodeId) + 1;
      const result = await client.pickTake(set.id, candidate.nodeId);
      addMessage({ role: 'system', content: describeTakePick(result, index) });
    } catch (err) {
      addError({ cause: err });
    } finally {
      selectionPendingRef.current = false;
      setReady(true);
    }
  }, [addError, addMessage, client]);

  const applySlashOutcome = useCallback(async (outcome: SlashOutcome) => {
    switch (outcome.kind) {
      case 'text':
        addMessage({ role: 'system', content: outcome.text });
        return;
      case 'changelog':
        setActiveSurface({ kind: 'changelog', view: outcome.view });
        return;
      case 'takes':
        setActiveSurface({ kind: 'takes', set: outcome.set });
        return;
      case 'model-set':
        setModelSpec(outcome.spec);
        addMessage({ role: 'system', content: `Model: ${outcome.spec}` });
        return;
      case 'effort-set':
        setStatus((current) => current ? { ...current, reasoningEffort: outcome.effort } : current);
        addMessage({ role: 'system', content: `Reasoning effort: ${outcome.effort}` });
        return;
      case 'role-set':
        setStatus((current) => current ? { ...current, roleId: outcome.role } : current);
        addMessage({ role: 'system', content: `Role: ${outcome.role}` });
        return;
      case 'status':
        setStatus(outcome.status);
        setModelSpec(outcome.status.model ?? '');
        addMessage({ role: 'system', content: '', status: outcome.status });
        return;
      case 'exit':
        if (onExit) onExit();
        else globalExit?.();
        return;
      case 'model-picker':
        await openModelPicker();
        return;
      case 'settings':
        setActiveSurface({ kind: 'settings' });
        return;
      case 'device-connect':
        await deviceConnect.open();
        return;
      case 'queue':
      case 'fork':
      case 'undo':
        // Surface-owned outcomes — handleSubmit intercepts them before this.
        return;
      case 'cancel': {
        if (!activeSurface) {
          addMessage({ role: 'system', content: 'Nothing to cancel.' });
          return;
        }
        const cancelled = {
          settings: 'Settings closed.',
          commands: 'Command palette closed.',
          hub: 'Agent hub closed.',
          model: 'Model selection cancelled.',
          changelog: 'Changelog closed — everything kept.',
          takes: 'Takes closed — the answered take stays.',
        } satisfies Record<NonNullable<ActiveSurface>['kind'], string>;
        setActiveSurface(null);
        addMessage({ role: 'system', content: cancelled[activeSurface.kind] });
        return;
      }
      case 'unknown':
        addMessage({ role: 'system', content: `Unknown command: ${outcome.command}. Type /help` });
        return;
    }
  }, [
    activeSurface,
    addMessage,
    client,
    deviceConnect.open,
    onExit,
    openModelPicker,
  ]);

  const runInputEffects = useCallback((effects: InputEffect[]) => {
    // Steers accepted mid-turn but not delivered return to the composer on
    // interrupt. A queue restore in the same batch appends instead of replacing.
    let droppedSteers: string[] = [];
    for (const effect of effects) {
      switch (effect.kind) {
        case 'interrupt':
          droppedSteers = client.stop();
          addMessage({ role: 'system', content: 'Interrupting the active turn… (Esc again to walk back)' });
          break;
        case 'exit':
          if (onExit) onExit();
          else globalExit?.();
          break;
        case 'clear-input':
          setInputText('');
          break;
        case 'set-input':
          setInputText([...droppedSteers.splice(0), effect.text].filter(Boolean).join('\n'));
          break;
        case 'hint':
          addMessage({ role: 'system', content: effect.text });
          break;
        case 'send-queued':
          void sendPrompt(effect.text);
          break;
        case 'send-branch':
          void performBranch(effect.text);
          break;
      }
    }
    if (droppedSteers.length > 0) {
      setInputText([...droppedSteers, inputRef.current?.plainText ?? ''].filter(Boolean).join('\n'));
    }
  }, [addMessage, client, onExit, performBranch, sendPrompt, setInputText]);

  const handleSubmit = useCallback(async (input: string) => {
    const text = input.trim();
    if (!text) return;
    if (!ready) {
      addMessage({ role: 'system', content: 'Still connecting.' });
      return;
    }
    const generation = clientGenerationRef.current;
    try {
      const submitted = text.startsWith('/') ? resolveCommandDraft(commands, text) : text;
      if (!submitted.startsWith('/')) {
        await sendPrompt(submitted);
        return;
      }
      clientActionCountRef.current += 1;
      try {
        const outcome = await executeSlashCommand(client, submitted);
        if (clientGenerationRef.current !== generation) return;
        if (outcome.kind === 'queue') {
          if (outcome.text) runInputEffects(dispatchInput({ type: 'queue', text: outcome.text }));
          else addMessage({ role: 'system', content: 'Usage: /queue <text> — it sends after the running turn (or immediately when idle).' });
          return;
        }
        if (outcome.kind === 'branch') {
          if (outcome.text) await performBranch(outcome.text);
          else addMessage({ role: 'system', content: `Usage: /branch <text> (or ${keybindings.hint('conversation.branch')} on a draft) — runs the redirect as a parallel branch of the running turn.` });
          return;
        }
        if (outcome.kind === 'fork') {
          const candidates = forkCandidates(messages);
          if (candidates.length === 0) {
            addMessage({ role: 'system', content: 'No user messages to walk back to.' });
            return;
          }
          if (!outcome.ref) {
            dispatchInput({ type: 'open-walkback' });
            return;
          }
          const index = Number.parseInt(outcome.ref, 10) - 1;
          const picked = Number.isInteger(index) ? candidates[index] : undefined;
          if (!picked) {
            addMessage({ role: 'system', content: `No walk-back candidate "${outcome.ref}". Esc-Esc (or /fork) lists them.` });
            return;
          }
          await performWalkback(picked);
          return;
        }
        if (outcome.kind === 'undo') {
          const undone = await performUndo(client, outcome.ref);
          addMessage({ role: 'system', content: undone.text });
          if (undone.restored && forkCandidates(messages).length > 0) {
            // opencode parity: files + conversation together — reuse the
            // Esc-Esc walk-back picker for the conversation half.
            addMessage({ role: 'system', content: 'Pick a message to also walk back the conversation, or Esc to keep it.' });
            dispatchInput({ type: 'open-walkback' });
          }
          return;
        }
        await applySlashOutcome(outcome);
      } finally {
        clientActionCountRef.current -= 1;
      }
    } catch (err) {
      if (clientGenerationRef.current === generation) addError({ cause: err });
      else {
        diagnostics.failure(
          'tui.stale_submit_failed',
          toKinuError({ doing: 'finishing a submit for a previous workspace', cause: err, otherwise: 'unavailable' }),
          { workspace: client.agentName },
        );
      }
    }
  }, [addError, addMessage, applySlashOutcome, client, commands, dispatchInput, messages, performBranch, performWalkback, ready, runInputEffects, sendPrompt]);

  const handleClientEvent = useCallback((event: AgentClientEvent) => {
    switch (event.type) {
      case 'turn-start': {
        runInputEffects(dispatchInput({ type: 'turn-start' }));
        // A new segment opens lazily on the first text-delta — start clean.
        sealSegment();
        turnStreamedTextRef.current = false;
        setTurnPhase(event.kind === 'programmatic' ? 'running background work' : 'thinking');
        if (event.kind === 'programmatic') {
          addMessage({ role: 'evolution', content: `» ${event.event ?? 'event'}: ${event.text.slice(0, 100)}` });
        }
        break;
      }
      case 'text-delta':
        if (!event.delta) break;
        turnStreamedTextRef.current = true;
        if (!activeSegmentRef.current) beginSegment();
        stream.append(event.delta);
        setTurnPhase((current) => current === 'writing' ? current : 'writing');
        break;
      case 'tool-call':
        // Seal the preceding text run so this tool — and any text that follows
        // it — lands at its true chronological position.
        sealSegment();
        setTurnPhase(`calling ${event.toolName}`);
        addMessage({ role: 'tool_call', content: '', toolName: event.toolName, args: JSON.stringify(event.args) });
        break;
      case 'tool-result':
        setTurnPhase(`finished ${event.toolName}`);
        addMessage({ role: 'tool_result', content: event.result, success: event.success });
        break;
      case 'step-finish':
        setTurnPhase(`step ${event.stepIndex}`);
        break;
      case 'evolution':
      case 'background':
        addMessage({ role: 'evolution', content: `[${event.event}] ${event.message}` });
        break;
      case 'error':
        sealSegment();
        addMessage({ role: 'system', content: errorLine(event.message) });
        break;
      case 'turn-end': {
        if (activeSegmentRef.current) stream.finish();
        sealSegment();
        if (!turnStreamedTextRef.current && event.turn.text.trim()) {
          addMessage({ role: 'assistant', content: event.turn.text.trim() });
        }
        runInputEffects(dispatchInput({ type: 'turn-settled' }));
        if (machineRef.current.activeTurns === 0) setTurnPhase(null);
        if (event.turn.toolCalls.some((call) => call.name === 'agents')) {
          const generation = clientGenerationRef.current;
          void client.latestTakes().then((set) => {
            if (clientGenerationRef.current !== generation) return;
            if (!set || set.candidates.length < 2 || set.chosenNodeId) return;
            if (hintedTakesRef.current === set.id) return;
            hintedTakesRef.current = set.id;
            addMessage({ role: 'system', content: `${set.candidates.length} takes — /takes to compare` });
          }).catch((takesError) => {
            if (clientGenerationRef.current === generation) {
              addMessage({ role: 'system', content: errorLine(`This turn's takes could not be read: ${renderThrownChain({ cause: takesError })}`) });
            } else {
              diagnostics.failure(
                'tui.stale_takes_read_failed',
                toKinuError({
                  doing: 'reading takes for a previous workspace',
                  cause: takesError,
                  otherwise: 'unavailable',
                }),
                { workspace: client.agentName },
              );
            }
          });
        }
        break;
      }
      case 'broadcast': {
        if (!isBranchStatusEvent(event.event)) break;
        const status = event.event;
        setBranchTasks((prev) => {
          const next = { ...prev };
          if (status.status === 'running') next[status.branchId] = status.task;
          else delete next[status.branchId];
          return next;
        });
        // The settle/error line IS the takes affordance (the running state
        // lives in the status bar).
        if (status.status !== 'running') addMessage({ role: 'system', content: describeBranchStatus(status) });
        break;
      }
      case 'run-event':
        break;
    }
  }, [addMessage, beginSegment, client, dispatchInput, runInputEffects, sealSegment, stream]);

  // Connect once per client: event subscription, startup resources, initial
  // hydration. Re-runs when a walk-back fork swaps in a sibling client.
  useEffect(() => {
    const preconnected = preconnectedClientRef.current === client;
    if (preconnected) preconnectedClientRef.current = null;
    else setReady(false);
    const generation = clientGenerationRef.current;
    const buffered = preconnected && preconnectedEventsRef.current?.client === client
      ? preconnectedEventsRef.current
      : null;
    const bufferedCount = buffered?.events.length ?? 0;
    const unsubscribe = client.subscribe((event) => {
      if (clientGenerationRef.current === generation) handleClientEvent(event);
    });
    if (buffered) {
      buffered.stop();
      preconnectedEventsRef.current = null;
      const replay = buffered.events.slice(0, bufferedCount)
        .filter((event, index) =>
          index >= buffered.historyBoundary || !persistedTranscriptEvent(event));
      for (const event of replay) handleClientEvent(event);
    }
    let cancelled = false;
    const connect = async () => {
      if (hydrateHistory && !skipHydrationRef.current) {
        try {
          const history = await client.history();
          if (!cancelled && history.length > 0) {
            setMessages([welcomeMessage(client.agentName), ...history]);
          }
        } catch (historyError) {
          if (!cancelled) {
            addMessage({ role: 'system', content: errorLine(`Earlier messages could not be loaded: ${renderThrownChain({ cause: historyError })}`) });
          }
        }
      }
      skipHydrationRef.current = false;
      let connected = true;
      try {
        if (!preconnected) await client.connect();
      } catch (error) {
        connected = false;
        if (!cancelled) addError({ cause: error });
      }
      if (!connected || cancelled) return;
      setReady(true);
      if (client.mode !== 'cloud') return;
      try {
        await deviceConnect.offerIfUnconnected();
      } catch (cause) {
        // A courtesy offer, never the user's work: its failure is a
        // diagnostic, not a conversation line.
        diagnostics.failure(
          'tui.device_connect_offer_failed',
          toKinuError({ doing: 'offering the device-connect prompt', cause, otherwise: 'unavailable' }),
          { workspace: client.agentName },
        );
      }
    };
    void connect();
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [addError, addMessage, client, deviceConnect.offerIfUnconnected, handleClientEvent, hydrateHistory]);

  useEffect(() => {
    let cancelled = false;
    const note = (line: string) => {
      if (!cancelled) addMessage({ role: 'system', content: errorLine(line) });
    };
    void client.status()
      .then((next) => {
        if (cancelled) return;
        setStatus(next);
        setModelSpec((current) => current || (next.model ?? ''));
      })
      .catch((error) => note(`Workspace status could not be read: ${renderThrownChain({ cause: error })}`));
    void client.listModels()
      .then((menu) => { if (!cancelled) setModelCatalog(menu.models); })
      .catch((error) => note(`The model catalog could not be read: ${renderThrownChain({ cause: error })}`));
    return () => { cancelled = true; };
  }, [addMessage, client]);

  // Watch pending device consents while a turn is processing (cloud agents).
  // The shared watcher presents each consent once (no re-show when a poll tick
  // races the resolution) and cancels the overlay when the turn settles.
  const consentDecisionRef = useRef<((decision: DeviceConsentDecision | 'cancelled') => void) | null>(null);
  useEffect(() => {
    const consents = client.consents;
    if (!consents || !isProcessing) {
      setPendingConsent(null);
      return;
    }
    const watcher = watchDeviceConsents(consents, {
      present: (consent, signal) => new Promise((resolve) => {
        const settle = (outcome: DeviceConsentDecision | 'cancelled') => {
          consentDecisionRef.current = null;
          setPendingConsent(null);
          setTimeout(() => { resolve(outcome); }, 0);
        };
        consentDecisionRef.current = settle;
        setPendingConsent(consent);
        signal.addEventListener('abort', () => settle('cancelled'), { once: true });
      }),
      note: (kind, message) => {
        addMessage({ role: 'system', content: kind === 'error' ? errorLine(message) : message });
      },
    });
    return () => watcher.stop();
  }, [addMessage, client, isProcessing]);

  const resolvePendingConsent = useCallback((decision: DeviceConsentDecision) => {
    consentDecisionRef.current?.(decision);
  }, []);

  const overlayOpen = Boolean(
    activeSurface || navigationOpen || inputState.walkbackOpen || pendingConsent || deviceConnect.state,
  );


  // Auto-copy selected text to clipboard (OSC 52) on mouse release.
  const rendererInstance = useRenderer();
  useEffect(() => {
    if (!rendererInstance?.root) return;
    let copied = false;
    rendererInstance.root.onMouseUp = () => {
      // Defer slightly so the selection is finalized by the renderer.
      setTimeout(() => {
        if (!rendererInstance.hasSelection) { copied = false; return; }
        if (copied) return; // already copied this selection
        const selection = rendererInstance.getSelection();
        if (!selection) return;
        // Walk selected renderables and extract text.
        const parts: string[] = [];
        for (const r of selection.selectedRenderables ?? []) {
          const text = r.getSelectedText();
          if (text) parts.push(text);
        }
        const text = parts.join('\n').trim();
        if (text) {
          rendererInstance.copyToClipboardOSC52(text);
          copied = true;
        }
        // A click (to scroll, or to select+copy) moves native focus off the
        // input; reclaim it so the user can keep typing without a manual click.
        if (inputShouldFocusRef.current) inputRef.current?.focus();
      }, 10);
    };
    return () => { rendererInstance.root.onMouseUp = undefined; };
  }, [rendererInstance]);

  useKeyboard((key) => {
    if (deviceConnect.handleKey(key)) {
      key.preventDefault();
      return;
    }
    if (pendingConsent) {
      key.preventDefault();
      const actionId = keyDispatcher.feed(key, ['consent']).actionId;
      const canApprove = deviceConsentCanApprove(pendingConsent, { width, height });
      if (actionId === 'consent.once' && canApprove) resolvePendingConsent('once');
      else if (actionId === 'consent.always' && canApprove) resolvePendingConsent('always');
      else if (actionId === 'consent.deny') resolvePendingConsent('deny');
      return;
    }
    if (selectionPendingRef.current) {
      key.preventDefault();
      return;
    }
    if (navigationOpen && tuiLayoutForWidth(width) !== 'wide') return;
    const modalActive = activeSurface !== null || inputState.walkbackOpen;
    const result = keyDispatcher.feed(key, modalActive ? ['modal'] : ['editor', 'conversation', 'global']);
    if (result.pending) {
      key.preventDefault();
      return;
    }
    const actionId = result.actionId;
    if (actionId === null) return;
    if (modalActive) {
      if (actionId === 'hub.new-agent' && activeSurface?.kind === 'hub'
        && activeSurface.view === 'agents' && onNewAgent !== undefined) {
        key.preventDefault();
        setActiveSurface(null);
        void createNewAgent();
        return;
      }
      if (actionId === 'modal.close') {
        key.preventDefault();
        if (activeSurface?.kind === 'model') modelRequestRef.current += 1;
        setActiveSurface(null);
        if (inputState.walkbackOpen) runInputEffects(dispatchInput({ type: 'walkback-closed' }));
      }
      return;
    }
    if (actionId === 'settings.toggle') {
      key.preventDefault();
      setActiveSurface(settingsOpen ? null : { kind: 'settings' });
      return;
    }
    if (actionId === 'palette.toggle') {
      key.preventDefault();
      setActiveSurface(commandPalette ? null : { kind: 'commands' });
      return;
    }
    if (actionId === 'workspace.toggle') {
      key.preventDefault();
      if (machineRef.current.activeTurns > 0 || clientActionCountRef.current > 0) {
        addMessage({ role: 'system', content: 'Finish or stop the active workspace action before switching.' });
      } else if (tuiLayoutForWidth(width) === 'wide') {
        updatePreferences((current) => ({ ...current, wideSidebarOpen: !current.wideSidebarOpen }));
      } else {
        setNavigationOpen((open) => !open);
      }
      return;
    }
    if (actionId === 'link.open-last') {
      key.preventDefault();
      const url = lastUrlFromMessages(messagesRef.current);
      if (url) openBrowser(url);
      return;
    }
    if (actionId === 'model.open') {
      key.preventDefault();
      void openModelPicker();
      return;
    }
    if (actionId === 'tier.cycle' || actionId === 'tier.cycle-reverse') {
      key.preventDefault();
      const current = nextTier ?? TIER_IDS.find((id) => id === status?.tierId) ?? 'default';
      const delta = actionId === 'tier.cycle' ? 1 : -1;
      const index = (TIER_IDS.indexOf(current) + delta + TIER_IDS.length) % TIER_IDS.length;
      setNextTier(TIER_IDS[index] ?? 'default');
      return;
    }
    if (actionId === 'hub.agents' || actionId === 'hub.roles' || actionId === 'hub.tiers'
      || actionId === 'tier.quick') {
      if (hub === null) return;
      key.preventDefault();
      const view: TuiHubView = actionId === 'hub.agents'
        ? 'agents'
        : actionId === 'hub.roles' ? 'roles' : 'tiers';
      setActiveSurface({ kind: 'hub', view });
      return;
    }
    if (actionId === 'tool.toggle') {
      key.preventDefault();
      setToolDetailsExpanded((expanded) => !expanded);
      return;
    }
    if (actionId === 'effort.cycle') {
      key.preventDefault();
      const efforts = ['low', 'medium', 'high'] as const;
      const current = status?.reasoningEffort ?? 'medium';
      const next = efforts[(efforts.indexOf(current) + 1) % efforts.length]!;
      void profileMutations.setReasoningEffort(next)
        .then(() => setStatus((value) => value === null ? value : { ...value, reasoningEffort: next }))
        .catch((cause) => addError({ cause }));
      return;
    }
    if (actionId === 'conversation.branch') {
      key.preventDefault();
      runInputEffects(dispatchInput({ type: 'branch', draft: inputRef.current?.plainText ?? '' }));
      return;
    }
    if (actionId === 'queue.add') {
      key.preventDefault();
      runInputEffects(dispatchInput({ type: 'queue', text: inputRef.current?.plainText ?? '' }));
      return;
    }
    if (actionId === 'queue.edit-last') {
      runInputEffects(dispatchInput({ type: 'backspace', draft: inputRef.current?.plainText ?? '' }));
      return;
    }
    if (actionId === 'history.page-up' || actionId === 'history.page-down' || actionId === 'history.line-up' || actionId === 'history.line-down') {
      if (handleHistoryScrollAction(actionId, inputRef.current?.plainText ?? '', historyRef.current)) {
        key.preventDefault();
        scrollAnchor.remember();
      }
      return;
    }
    if (actionId !== 'conversation.cancel') return;
    key.preventDefault();
    runInputEffects(dispatchInput({
      type: 'escape',
      now: Date.now(),
      draft: inputRef.current?.plainText ?? '',
      hasUserMessages: messages.some((message) => message.role === 'user'),
    }));
  });

  const onInputSubmit = useCallback(() => {
    const value = inputRef.current?.plainText ?? '';
    if (!value.trim()) return;
    setInputText('');
    void handleSubmit(value);
  }, [handleSubmit, setInputText]);

  const draftLines = Math.min(6, Math.max(1, draft.split('\n').length));
  const commandHints = !settingsOpen && !commandPalette && !modelPicker && hubView === null
    && !changelogView && !takesView && !inputState.walkbackOpen && !navigationOpen
    && !isProcessing && !/\s/.test(draft.trimStart())
    ? filterCommands(commands, draft)
    : [];
  const inputFocused = ready && !overlayOpen;
  const contextTokens = estimateContextTokens(messages);
  const contextWindow = contextWindowForSpec(modelCatalog, modelSpec);
  const walkbackList = inputState.walkbackOpen ? forkCandidates(messages) : [];
  const surfaceTitle = settingsOpen
    ? 'Settings ›'
    : commandPalette
      ? 'Commands ›'
      : hubView !== null
        ? `${hubView[0]!.toUpperCase()}${hubView.slice(1)} ›`
        : modelPicker
          ? 'Model picker ›'
          : changelogView
            ? 'Changelog ›'
            : takesView
              ? 'Takes ›'
              : inputState.walkbackOpen
                ? 'Walk back ›'
                : null;
  const composerTitle = isProcessing
    ? '⟳ processing…'
    : surfaceTitle
      ?? `${client.agentName} · ${keybindings.hint('palette.toggle')} commands · ${keybindings.hint('workspace.toggle')} workspaces · ${keybindings.hint('settings.toggle')} settings`;
  const composerPlaceholder = !ready
    ? 'Connecting…'
    : isProcessing
      ? `Type to steer · ${keybindings.hint('queue.add')} queues · ${keybindings.hint('conversation.branch')} branches · ${keybindings.hint('conversation.cancel')} interrupts`
      : `${TUI_COMPOSER_PLACEHOLDER} · ${keybindings.hint('editor.newline')} newline`;
  useEffect(() => {
    if (inputFocused) inputRef.current?.focus();
  }, [inputFocused]);
  inputShouldFocusRef.current = inputFocused;

  return (
    <TuiShell
      scene="chat"
      roster={roster}
      currentAgent={{ name: client.agentName, mode: client.mode }}
      navigationOverlayOpen={navigationOpen}
      onNavigationOverlayChange={setNavigationOpen}
      onNavigationFocusChange={handleNavigationFocusChange}
      onAgentSelect={(agent) => { void switchWorkspace(agent); }}
    >
    <box flexDirection="column" style={{ width: '100%', height: '100%' }}>
      <StatusBar
        name={status?.name ?? client.agentName}
        mode={client.mode}
        model={modelSpec}
        reasoningEffort={status?.reasoningEffort ?? 'medium'}
        onModelSelect={() => { if (!overlayOpen) void openModelPicker(); }}
        connected={ready}
        scaffoldVersion={status?.scaffoldVersion}
        toolCount={status?.toolCount}
        autoEvolve={status?.autoEvolve}
        contextTokens={contextTokens}
        contextWindow={contextWindow}
        branchCount={Object.keys(branchTasks).length}
        profile={hub?.data.profile.resolved}
      />

      <scrollbox
        ref={(value) => { historyRef.current = value; }}
        focused={!isProcessing}
        stickyScroll={true}
        stickyStart="bottom"
        onMouseScroll={() => queueMicrotask(scrollAnchor.remember)}
        style={{
          flexGrow: 1,
          rootOptions: { backgroundColor: colors.background.canvas },
          viewportOptions: { backgroundColor: colors.background.canvas },
          contentOptions: { backgroundColor: colors.background.canvas },
          scrollbarOptions: {
            trackOptions: { foregroundColor: colors.border.strong, backgroundColor: colors.background.surface },
          },
        }}
      >
        <MessageList messages={messages} toolDetailsExpanded={toolDetailsExpanded} />
        <PhaseLine label={isProcessing ? (turnPhase ?? 'thinking') : nextTier ? `next turn · ${nextTier}` : null} />
      </scrollbox>

      {inputState.queue.length > 0 && (
        <box flexDirection="column" style={{ paddingLeft: 2, paddingRight: 2 }}>
          {inputState.queue.map((text, i) => (
            <text key={`queued-${i}`}>
              <span fg={colors.intent.warningMuted}>⧗ </span>
              <span fg={colors.text.muted}>{i + 1} · </span>
              <span fg={colors.text.primary}>{clipText(text.replace(/\s+/g, ' '), Math.max(8, width - 12))}</span>
            </text>
          ))}
          <text><span fg={colors.text.muted}>queued · {keybindings.hint('queue.edit-last')} on an empty input edits the last</span></text>
        </box>
      )}

      <box
        style={{
          height: draftLines + 2,
          border: true,
          borderStyle: 'single',
          borderColor: isProcessing ? colors.border.strong : colors.border.default,
          backgroundColor: colors.background.surface,
          paddingLeft: 1,
        }}
        title={composerTitle}
      >
        <textarea
          ref={(value) => { inputRef.current = value; }}
          focused={inputFocused}
          placeholder={composerPlaceholder}
          wrapMode="word"
          keyBindings={[
            ...openTuiKeyBindings(keybindings, 'editor.submit'),
            ...openTuiKeyBindings(keybindings, 'editor.newline'),
          ]}
          onContentChange={() => setDraft(inputRef.current?.plainText ?? '')}
          onSubmit={onInputSubmit}
        />
      </box>

      {settingsOpen ? (
        <SettingsOverlay
          settings={settings}
          terminal={{ width, height }}
          onSelect={(setting) => {
            setActiveSurface(null);
            if (setting.command === '/model') void openModelPicker();
            else if (setting.command.endsWith(' ')) setInputText(setting.command);
            else void handleSubmit(setting.command);
          }}
        />
      ) : hubView !== null && hubLive !== undefined ? (
        <HubOverlay
          view={hubView}
          data={hubLive}
          width={width}
          height={height}
          {...(onNewAgent !== undefined ? { newAgentHint: keybindings.hint('hub.new-agent') } : {})}
        />
      ) : commandPalette ? (
        <CommandPaletteOverlay
          commands={commands}
          terminal={{ width, height }}
          onSelect={(command) => {
            setActiveSurface(null);
            setInputText(`${command.name}${command.usage ? ' ' : ''}`);
          }}
        />
      ) : modelPicker ? (
        <ModelPickerOverlay
          models={modelPicker.menu.models}
          failures={modelPicker.menu.failures}
          currentSpec={modelSpec}
          terminal={{ width, height }}
          loading={modelPicker.loading}
          error={modelPicker.error}
          onSelect={(model) => { void selectModel(model); }}
        />
      ) : changelogView ? (
        <ChangelogOverlay
          view={changelogView}
          terminal={{ width, height }}
          onSelect={(entry) => { void revertChangelogEntry(entry); }}
        />
      ) : takesView ? (
        <TakesOverlay
          set={takesView}
          terminal={{ width, height }}
          onSelect={(candidate) => { void pickTake(takesView, candidate); }}
        />
      ) : inputState.walkbackOpen && walkbackList.length > 0 ? (
        <WalkbackOverlay
          candidates={walkbackList}
          terminal={{ width, height }}
          onSelect={(point) => { void performWalkback(point); }}
        />
      ) : (
        <CommandHintOverlay commands={commandHints} terminal={{ width, height }} />
      )}
      {pendingConsent && <DeviceConsentOverlay consent={pendingConsent} terminal={{ width, height }} />}
      {deviceConnect.state && <DeviceConnectOverlay prompt={deviceConnect.state} terminal={{ width, height }} />}
    </box>
    </TuiShell>
  );
}

interface HistoryScrollTarget {
  scrollTop: number;
  viewport: { height: number };
  scrollTo(position: number): void;
}

function handleHistoryScrollAction(
  actionId: Extract<TuiActionId, 'history.page-up' | 'history.page-down' | 'history.line-up' | 'history.line-down'>,
  draft: string,
  history: HistoryScrollTarget | null,
): boolean {
  const page = actionId === 'history.page-up' || actionId === 'history.page-down';
  if (history === null || (!page && draft.length > 0)) return false;
  const direction = actionId === 'history.page-up' || actionId === 'history.line-up' ? -1 : 1;
  const viewportFraction = page ? 0.5 : 0.2;
  const delta = Math.max(1, Math.floor(history.viewport.height * viewportFraction));
  history.scrollTo(history.scrollTop + direction * delta);
  return true;
}

/** A failure as a transcript entry: the provider's own words, plus the next
 *  command when the failure class implies one. Plain text — the TUI styles
 *  system messages itself, so no ANSI here. */
function errorLine(message: string): string {
  const guided = guideFailure({ cause: message });
  return guided.hint ? `Error: ${guided.message}\n${guided.hint}` : `Error: ${guided.message}`;
}

/** Extract the last URL from assistant message content. */
function lastUrlFromMessages(messages: DisplayMessage[]): string | null {
  const urlRe = /https?:\/\/[^\s)\]}>'"]+/g;
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg.role !== 'assistant' && msg.role !== 'system') continue;
    const matches = msg.content.match(urlRe);
    if (matches && matches.length > 0) return matches[matches.length - 1];
  }
  return null;
}

function welcomeMessage(agentName: string): DisplayMessage {
  return { id: 'welcome', role: 'system', content: `Connected to ${agentName}. Type a message or /help for commands.` };
}

async function loadHubData(client: AgentClient, workspace: string): Promise<TuiHubData> {
  const [envelope, status] = await Promise.all([loadActiveProfile(), client.status()]);
  const roles = effectiveRoleCatalog(envelope.catalog);
  const activeRoleId = status.roleId && roles[status.roleId] ? status.roleId : DEFAULT_ROLE_ID;
  const tierId = TIER_IDS.find((id) => id === status.tierId) ?? roles[activeRoleId]?.tier ?? 'default';
  return {
    agents: [{
      id: workspace,
      label: status.name,
      kind: 'main',
      status: 'idle',
      roleId: activeRoleId,
      tierId,
      workspace,
    }],
    profile: {
      envelope,
      activeRoleId,
      allowedRoleIds: Object.keys(roles),
    },
  };
}

export async function runTuiChat(opts: ChatAppOpts): Promise<void> {
  requireInteractiveTerminal();
  const hubData = opts.hubData ?? await loadHubData(opts.client, opts.client.agentName);
  const renderOptions: ChatAppOpts = { ...opts, hubData };
  const renderer = await createCliRenderer({ exitOnCtrlC: false, useMouse: true });
  const root = createRoot(renderer);
  let currentClient = opts.client;

  const cleanup = async () => {
    let closeFailure: string | null = null;
    try {
      await currentClient.close();
    } catch (error) {
      closeFailure = renderThrownChain({ cause: error });
    }
    root.render(<box />);
    renderer.destroy();
    if (closeFailure) console.error(`\n  The workspace did not close cleanly: ${closeFailure}`);
    console.log('\n  Goodbye.\n');
    process.exit(0);
  };

  globalExit = () => { void cleanup(); };
  process.on('SIGINT', () => { void cleanup(); });

  root.render(<ChatApp {...renderOptions} onClientChange={(client) => { currentClient = client; }} />);

  // Keep the process alive
  await new Promise<void>(() => {});
}

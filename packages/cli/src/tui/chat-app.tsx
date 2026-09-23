/** OpenTUI chat surface for both backends. The input reducer owns turn state; the action registry owns key chords. */

import {
  createCliRenderer,
  type ScrollBoxRenderable,
  type TextareaRenderable,
} from '@opentui/core';
import { createRoot, useKeyboard, useRenderer, useTerminalDimensions } from '@opentui/react';
import { useState, useCallback, useRef, useEffect, useMemo, type ReactNode } from 'react';

import { tierIdsOf,
  DEFAULT_ROLE_ID, TUI_COMPOSER_PLACEHOLDER, TUI_COMPOSER_STEERING_PLACEHOLDER, nextReasoningEffort, offeredReasoningEfforts,
  composerVisibleRows, effectiveRoleCatalog,
  type AlternateTakeCandidate, type AlternateTakeSet, type ChangelogEntry, type ReasoningEffort, type TierId,
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
  renderPlanReview,
  performUndo,
  resolveCommandDraft,
  type SlashOutcome,
} from '../slash-commands';
import { describePromptAttachment, resolvePromptAttachments } from '../attachments';
import { listSidebarAgents } from '../agent-list';
import { watchDeviceConsents } from '../consent-watch';
import { contextWindowForSpec, EMPTY_MODEL_MENU, type AgentModelEntry, type AgentModelMenu } from '@kinu.run/core';
import { requireInteractiveTerminal, TUI_EXIT_SIGNALS } from '../prompt';
import { loadActiveProfile } from '../default-model';
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
  ShellApprovalOverlay,
  PromptHistoryOverlay,
  shellApprovalCanApprove,
  ModelPickerOverlay,
  PhaseLine,
  TakesOverlay,
  SettingsOverlay,
  ThemePickerOverlay,
  type TuiSettingChoice,
  WalkbackOverlay,
} from './overlays';
import { useDeviceConnectPrompt, type DeviceConnectPromptState } from './use-device-connect';
import { useShellApproval } from './use-shell-approval';
import type { ShellApprovalRequest, WorkMode } from '@kinu.run/core';
import { useComposerPaste } from './use-composer-paste';
import { useDraftEditing } from './use-draft-editing';
import { composerHelp } from './help-view';
import { consentKeyDecision } from './approval-keys';
import { composerKeyHandlers } from './draft-keys';
import { modalKeyHandlers, sceneKeyHandlers } from './surface-keys';
import type { ComposerKeyDeps } from './draft-keys';
import type { SurfaceKeyDeps } from './surface-keys';
import { estimateContextTokens } from '@kinu.run/core';
import { useStreamingBuffer } from './streaming-buffer';
import { initialInputState, reduceInput, type InputEffect, type InputMachineEvent } from '@kinu.run/core';
import { agentDisplayLabel, clipText } from '@kinu.run/core';
import { createKeyDispatcher, openTuiKeyBindings } from './actions';
import { buildAgentHubEntries, HubOverlay, type TuiHubData, type TuiHubView } from './hubs';
import { DEFAULT_TUI_THEME_SELECTION, useTuiTheme, type ThemeSelection } from './theme';
import {
  TuiProductProvider,
  TuiShell,
  tuiLayoutForWidth,
  usePreservedScrollAnchor,
  sceneWidthFor,
  useTuiProduct,
  useAgentRoster,
  agentSourceFromList,
  type TuiRuntimeOptions,
  type TuiAgentSource,
  type TuiAgentSummary,
} from './tui-shell';
import { diagnostics, renderThrownChain, toKinuError } from '@kinu.run/core/obs';

/** `local-peer` opens in place; `cloud-additional` runs server-side and is announced. */
export interface TuiCreatedAgent {
  name: string;
  displayName: string;
  kind: 'local-peer' | 'cloud-additional';
  /** For a conversation outside the navigator (e.g. a cloud additional-agent facet). */
  client?: AgentClient;
}

export interface ChatAppOpts {
  client: AgentClient;
  hydrateHistory?: boolean;
  onExit?: () => void | Promise<void>;
  /** Walk-back forks swap clients; exit cleanup must close the current one. */
  onClientChange?: (client: AgentClient) => void;
  workspaceSource?: TuiAgentSource;
  onWorkspaceSelect?: (name: string) => Promise<AgentClient>;
  /** Host-wired: creation is a host concern. */
  onNewAgent?: (client: AgentClient) => Promise<TuiCreatedAgent>;
  tui?: TuiRuntimeOptions;
  hubData?: TuiHubData;
  /** A host that supplies `hubData` must supply this too. */
  readHub?: (client: AgentClient) => Promise<TuiHubData>;
}

export type ActiveSurface =
  | { kind: 'commands' }
  | { kind: 'history' }
  | { kind: 'settings' }
  | { kind: 'theme' }
  | { kind: 'hub'; view: TuiHubView }
  | { kind: 'model'; menu: AgentModelMenu; loading: boolean; error: string | null }
  | { kind: 'changelog'; view: AgentChangelogView }
  | { kind: 'takes'; set: AlternateTakeSet }
  | null;

function surfaceTitleFor(surface: ActiveSurface, walkbackOpen: boolean): string | null {
  if (surface === null) return walkbackOpen ? 'Walk back ›' : null;

  switch (surface.kind) {
    case 'settings': return 'Settings ›';
    case 'theme': return 'Theme ›';
    case 'commands': return 'Commands ›';
    case 'hub': return `${surface.view[0].toUpperCase()}${surface.view.slice(1)} ›`;
    case 'model': return 'Model picker ›';
    case 'changelog': return 'Changelog ›';
    case 'takes': return 'Takes ›';
    case 'history': return 'Prompt history ›';
  }
}

function anyOverlayOpen(input: {
  activeSurface: ActiveSurface;
  navigationOpen: boolean;
  walkbackOpen: boolean;
  pendingConsent: PendingDeviceConsent | null;
  shellApproval: ShellApprovalRequest | null;
  deviceConnect: DeviceConnectPromptState | null;
}): boolean {
  return input.activeSurface !== null
    || input.navigationOpen
    || input.walkbackOpen
    || input.pendingConsent !== null
    || input.shellApproval !== null
    || input.deviceConnect !== null;
}


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

let globalExit: (() => Promise<void>) | null = null;

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
  hubData,
  readHub,
}: ChatAppOpts) {
  const { width, height } = useTerminalDimensions();
  const rendererInstance = useRenderer();
  const { colors, definition: activeTheme } = useTuiTheme();
  const { keybindings, preferences, updatePreferences } = useTuiProduct();
  const sceneWidth = sceneWidthFor(width, preferences.wideSidebarOpen);
  const keyDispatcher = useMemo(() => createKeyDispatcher(keybindings), [keybindings]);

  const workspaceSource = useMemo(
    () => workspaceSourceInput ?? agentSourceFromList(listSidebarAgents),
    [workspaceSourceInput],
  );

  const roster = useAgentRoster(workspaceSource);
  const [navigationOpen, setNavigationOpen] = useState(false);
  // A cloud walk-back fork swaps in a sibling client mid-session.
  const [client, setClient] = useState(initialClient);
  const shellApproval = useShellApproval(client);
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
  const themePickerOpen = activeSurface?.kind === 'theme';

  // The hub carries its workspace's identity so a switch resets it alongside other per-client state.
  const [hub, setHub] = useState<{ identity: string; data: TuiHubData } | null>(
    hubData ? { identity: `${initialClient.mode}:${initialClient.agentName}`, data: hubData } : null,
  );

  const [draft, setDraft] = useState('');
  const draftValueRef = useRef('');
  const projectRoot = useMemo(() => canonicalProjectRoot(), []);
  const promptHistoryKey = JSON.stringify([client.mode, projectRoot, client.agentName]);
  const promptHistory = preferences.promptHistory?.[promptHistoryKey] ?? [];
  const promptCursorRef = useRef<{ index: number; draft: string } | null>(null);

  const rememberPrompt = useCallback((text: string) => {
    if (!text.trim()) return;
    updatePreferences((current) => {
      const entries = current.promptHistory?.[promptHistoryKey] ?? [];

      if (entries.at(-1) === text) return current;

      return { ...current, promptHistory: { ...current.promptHistory, [promptHistoryKey]: [...entries, text].slice(-500) } };
    });
  }, [promptHistoryKey, updatePreferences]);

  // Editor-wrapped visual rows, not typed lines.
  const [composerRows, setComposerRows] = useState(1);
  const draftsRef = useRef(new Map<string, string>());
  const [inputState, setInputState] = useState(initialInputState);

  const [branchTasks, setBranchTasks] = useState<Record<string, string>>({});
  const [toolDetailsExpanded, setToolDetailsExpanded] = useState(false);

  const msgIdRef = useRef(0);
  const historyRef = useRef<ScrollBoxRenderable | null>(null);
  const inputRef = useRef<TextareaRenderable | null>(null);
  const draftEditing = useDraftEditing(inputRef, rendererInstance);
  const scrollAnchor = usePreservedScrollAnchor(historyRef);

  useEffect(draftEditing.reset, [client, draftEditing.reset]);

  const handleNavigationFocusChange = useCallback((focused: boolean) => {
    if (focused) inputRef.current?.blur();
    else if (ready) inputRef.current?.focus();
  }, [ready]);

  // Mirrors the input's `focused` condition so a click can reassert focus without a second focus state.
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
  const hintedTakesRef = useRef<string | null>(null);
  const modelRequestRef = useRef(0);
  // Effects cannot return their tasks; these refs hold scene-owned work until cleanup.
  const hubRefreshTaskRef = useRef<Promise<void> | null>(null);
  const connectionTaskRef = useRef<Promise<void> | null>(null);
  const metadataTaskRef = useRef<Promise<void> | null>(null);
  const commands = useMemo(() => commandsForClient(client), [client]);
  const deviceConnect = useDeviceConnectPrompt();

  // The stored level stays listed even if the catalog drops it.
  const efforts = useMemo(
    () => effortsForModel(modelCatalog, modelSpec, status),
    [modelCatalog, modelSpec, status],
  );

  const effort = status?.reasoningEffort ?? 'medium';

  const settings = useMemo<TuiSettingChoice[]>(() => {
    const rows: TuiSettingChoice[] = [
      {
        id: 'model',
        group: 'Model',
        label: 'Active model',
        value: modelSpec || 'default',
        command: '/model',
      },
      ...efforts.map((value) => ({
        id: `effort-${value}`,
        group: 'Model',
        label: `Reasoning effort: ${value}`,
        value: value === effort ? 'current' : '',
        command: `/effort ${value}`,
      })),
      {
        id: 'theme',
        group: 'Appearance',
        label: 'Theme',
        value: activeTheme.label,
        command: '/theme',
      },
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
  }, [activeTheme.label, client, efforts, modelSpec, effort]);

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

  const pasteNote = useCallback((content: string) => addMessage({ role: 'system', content }), [addMessage]);

  const expandPastes = useComposerPaste({ renderer: rendererInstance, input: inputRef,
    enabled: inputShouldFocusRef, limitBytes: client.inlineAttachmentLimitBytes, note: pasteNote });

  // Live assistant segments: a tool-call seals the active segment so the next text-delta opens one after the tool,
  // keeping text and tools in chronological order.
  const activeSegmentRef = useRef<string | null>(null);
  /** If false at turn-end, turn.text is appended once. */
  const turnStreamedTextRef = useRef(false);

  const writeActiveSegment = useCallback((value: string | null) => {
    const id = activeSegmentRef.current;

    if (!id || value === null) return;
    setMessages((prev) => prev.map((m) => (m.id === id ? { ...m, content: value } : m)));
  }, []);

  const stream = useStreamingBuffer(writeActiveSegment);

  const beginSegment = useCallback(() => {
    const id = `msg-${++msgIdRef.current}`;
    activeSegmentRef.current = id;
    const segment: DisplayMessage = { id, role: 'assistant', content: '', live: true };
    setMessages((prev) => [...prev, segment]);
    stream.start();
  }, [stream]);

  /** An empty segment (tool before any text) is removed. */
  const sealSegment = useCallback(() => {
    const id = activeSegmentRef.current;
    activeSegmentRef.current = null;
    stream.clear();

    if (!id) return;
    setMessages((prev) => prev.flatMap((m) => {
      if (m.id !== id) return [m];

      return m.content.trim() ? [{ ...m, live: false }] : [];
    }));
  }, [stream]);

  /** Effects return to the caller so events and keys never race over state. */
  const dispatchInput = useCallback((event: InputMachineEvent): InputEffect[] => {
    const { state, effects } = reduceInput(machineRef.current, event);
    machineRef.current = state;
    setInputState(state);

    return effects;
  }, []);

  /** Only the editor knows the wrap; re-read after edits and resizes. */
  const syncComposerRows = useCallback(() => {
    const input = inputRef.current;

    if (!input) return;
    setComposerRows(composerVisibleRows(input.editorView.getTotalVirtualLineCount()));
  }, []);

  const setInputText = useCallback((text: string) => {
    promptCursorRef.current = null;
    draftValueRef.current = text;
    draftEditing.replace(text);
    setDraft(text);
    syncComposerRows();
  }, [draftEditing.replace, syncComposerRows]);

  /** @path mentions become attachments: images and PDFs inline, other files as path references. */
  const sendPrompt = useCallback(async (input: string, mode?: WorkMode) => {
    rememberPrompt(input);
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
        attachments: prompt.attached.length > 0 ? prompt.attached.map(describePromptAttachment) : undefined,
        steered: steering,
      };

      addMessage(message);
      const payload = prompt.files.length > 0 ? { text: prompt.text, files: prompt.files } : prompt.text;
      const sendOptions: AgentClientSendOptions = { cwd: process.cwd(), ...(mode !== undefined && { mode }) };

      if (nextTier) sendOptions.tier = nextTier;

      setNextTier(null);
      await client.send(payload, sendOptions);
    } catch (err) {
      if (clientGenerationRef.current === generation) addError({ cause: err });
    } finally {
      clientActionCountRef.current -= 1;
    }
  }, [addError, addMessage, client, nextTier, rememberPrompt]);

  /** Falls back to a normal send when the turn just finished. */
  const performBranch = useCallback(async (input: string) => {
    try {
      const text = input.trim();

      if (!text) return;

      if (machineRef.current.activeTurns > 0 && client.branch(text, { cwd: process.cwd() })) {
        const branch: Omit<DisplayMessage, 'id'> = { role: 'user', content: text, branched: true };
        addMessage(branch);

        return;
      }

      await sendPrompt(text);
    } catch (cause) {
      addError({ cause });
    }
  }, [addError, addMessage, client, sendPrompt]);

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

        try {
          await previous.close();
        } catch (closeError) {
          const reason = renderThrownChain({ cause: closeError });
          addMessage({ role: 'system', content: `The pre-fork session did not close cleanly: ${reason}` });
        }
      }

      setMessages((prev) => {
        const pivot = findForkPivot(prev, point);
        const kept = pivot < 0 ? prev : prev.slice(0, pivot);

        return [...kept, {
          id: `msg-${++msgIdRef.current}`,
          role: 'system',
          content: `Forked ${result.label}. Edit the message and press Enter to resend.`,
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
      addMessage({ role: 'system', content: 'Exit to the home screen to open another workspace.' });

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
      else throw new Error('Exit to the home screen to open another workspace.');
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
      // A pending next-turn tier does not survive a switch.
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

      try {
        await previous.close();
      } catch (error) {
        addMessage({
          role: 'system',
          content: errorLine(`The previous workspace did not close cleanly: ${renderThrownChain({ cause: error })}`),
        });
      }
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


  /** Cloud supplies a facet client: the conversation nests under its parent workspace. */
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
          { name: created.name, label: agentDisplayLabel({ name: created.name, label: created.displayName }), mode: 'cloud' },
          created.client,
        );

        return;
      }

      await roster.reload();
      await switchWorkspace({ name: created.name, label: agentDisplayLabel({ name: created.name, label: created.displayName }), mode: 'local' });
    } catch (error) {
      addError({ cause: error });
    }
  }, [addError, addMessage, client, onNewAgent, roster, switchWorkspace]);

  useEffect(() => {
    const identity = `${client.mode}:${client.agentName}`;

    if (hub !== null && hub.identity === identity) return;
    const abort = new AbortController();
    let task: Promise<void> | null = null;
    let settled = false;
    task = (async () => {
      try {
        const fresh = await (readHub ?? loadHubData)(client);

        if (!abort.signal.aborted) setHub({ identity, data: fresh });
      } catch (cause) {
        diagnostics.failure(
          'tui.hub_refresh_failed',
          toKinuError({ doing: 'refreshing the agent hub', cause, otherwise: 'unavailable' }),
          { workspace: client.agentName },
        );
      } finally {
        settled = true;

        if (task !== null && hubRefreshTaskRef.current === task) hubRefreshTaskRef.current = null;
      }
    })();
    hubRefreshTaskRef.current = task;

    if (settled && hubRefreshTaskRef.current === task) hubRefreshTaskRef.current = null;

    return () => { abort.abort(); };
  }, [client, hub, readHub]);

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
      const result = await client.setModel(model.spec);
      setModelSpec(result.spec);
      addMessage({ role: 'system', content: `Model: ${result.spec}` });
    } catch (err) {
      addError({ cause: err });
    } finally {
      selectionPendingRef.current = false;
      setReady(true);
    }
  }, [addError, addMessage, client]);

  const revertChangelogEntry = useCallback(async (entry: ChangelogEntry) => {
    if (selectionPendingRef.current) return;
    selectionPendingRef.current = true;
    setActiveSurface(null);
    setReady(false);

    try {
      if (!entry.revert) {
        addMessage({ role: 'system', content: `"${entry.summary}" is informational (${entry.kind}). Nothing to revert.` });

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

  /** A changed answer streams its continuation as the next turn. */
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

  const selectReasoningEffort = useCallback(async (chosen: ReasoningEffort) => {
    try {
      await client.setReasoningEffort(chosen);
      setStatus((value) => value === null ? value : { ...value, reasoningEffort: chosen });
    } catch (cause) {
      addError({ cause });
    }
  }, [addError, client]);

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
        const note: Omit<DisplayMessage, 'id'> = { role: 'system', content: '', status: outcome.status };
        addMessage(note);

        return;
      case 'exit':
        if (onExit) await onExit();
        else if (globalExit) await globalExit();

        return;
      case 'model-picker':
        await openModelPicker();

        return;
      case 'settings':
        setActiveSurface({ kind: 'settings' });

        return;
      case 'theme':
        setActiveSurface({ kind: 'theme' });

        return;
      case 'device-connect':
        await deviceConnect.open();

        return;
      case 'queue':
      case 'branch':
      case 'plan':
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
          theme: 'Theme picker closed. Your theme is unchanged.',
          commands: 'Command palette closed.',
          history: 'Prompt history closed.',
          hub: 'Agent hub closed.',
          model: 'Model selection cancelled.',
          changelog: 'Changelog closed. Everything kept.',
          takes: 'Takes closed. The answered take stays.',
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
    // Undelivered mid-turn steers return to the composer on interrupt; a queue restore in the same batch appends.
    let droppedSteers: string[] = [];
    let action: Promise<void> | undefined;

    for (const effect of effects) {
      switch (effect.kind) {
        case 'interrupt':
          droppedSteers = client.stop();
          addMessage({ role: 'system', content: 'Interrupting the active turn… (Esc again to walk back)' });
          break;
        case 'exit':
          if (onExit) return onExit();

          return globalExit?.();
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
          action = sendPrompt(effect.text);
          break;
        case 'send-branch':
          action = performBranch(effect.text);
          break;
      }
    }

    if (droppedSteers.length > 0) {
      setInputText([...droppedSteers, inputRef.current?.plainText ?? ''].filter(Boolean).join('\n'));
    }

    return action;
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

        if (submitted === '/help' && outcome.kind === 'text') {
          addMessage({ role: 'system', content: `${outcome.text}\n\n${composerHelp(keybindings)}` });

          return;
        }

        if (clientGenerationRef.current !== generation) return;

        if (outcome.kind === 'queue') {
          if (outcome.text) await runInputEffects(dispatchInput({ type: 'queue', text: outcome.text }));
          else addMessage({ role: 'system', content: 'Usage: /queue <text>. It sends after the running turn, or at once when idle.' });

          return;
        }

        if (outcome.kind === 'branch') {
          if (outcome.text) await performBranch(outcome.text);
          else addMessage({ role: 'system', content: `Usage: /branch <text> (or ${keybindings.hint('conversation.branch')} on a draft). It runs the redirect as a parallel branch of the running turn.` });

          return;
        }

        if (outcome.kind === 'plan') {
          if (outcome.text) await sendPrompt(outcome.text, 'plan');
          else addMessage({ role: 'system', content: 'Usage: /plan <what to plan>. It drafts a plan for you to approve (/plan approve) or send back (/plan changes <feedback>).' });

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
            // Files plus conversation: reuse the Esc-Esc walk-back picker for the conversation half.
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

  /** Once per set, never for one already picked from. */
  const hintAlternateTakes = useCallback(async () => {
    const generation = clientGenerationRef.current;

    try {
      const set = await client.latestTakes();

      if (
        clientGenerationRef.current === generation
        && set
        && set.candidates.length >= 2
        && !set.chosenNodeId
        && hintedTakesRef.current !== set.id
      ) {
        hintedTakesRef.current = set.id;
        addMessage({ role: 'system', content: `${set.candidates.length} takes: /takes to compare` });
      }
    } catch (takesError) {
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
    }
  }, [addMessage, client]);

  const handleTurnEnd = useCallback(async (event: Extract<AgentClientEvent, { type: 'turn-end' }>) => {
    if (activeSegmentRef.current) stream.finish();
    sealSegment();

    if (!turnStreamedTextRef.current && event.turn.text.trim()) {
      addMessage({ role: 'assistant', content: event.turn.text.trim() });
    }

    const inputEffects = runInputEffects(dispatchInput({ type: 'turn-settled' }));

    if (machineRef.current.activeTurns === 0) setTurnPhase(null);

    if (event.turn.toolCalls.some((call) => call.name === 'agents')) await hintAlternateTakes();

    await inputEffects;
  }, [addMessage, dispatchInput, hintAlternateTakes, runInputEffects, sealSegment, setTurnPhase, stream]);

  const handleBroadcast = useCallback((event: Extract<AgentClientEvent, { type: 'broadcast' }>) => {
    if (event.event.type === 'plan_updated' && event.event.plan) {
      addMessage({ role: 'system', content: renderPlanReview(event.event.plan) });

      return;
    }

    if (!isBranchStatusEvent(event.event)) return;
    const branchStatus = event.event;
    setBranchTasks((prev) => {
      const next = { ...prev };

      if (branchStatus.status === 'running') next[branchStatus.branchId] = branchStatus.task;
      else delete next[branchStatus.branchId];

      return next;
    });

    // The settle/error line is the takes affordance; running state lives in the status bar.
    if (branchStatus.status !== 'running') addMessage({ role: 'system', content: describeBranchStatus(branchStatus) });
  }, [addMessage, setBranchTasks]);

  const handleClientEvent = useCallback(async (event: AgentClientEvent) => {
    switch (event.type) {
      case 'turn-start': {
        dispatchInput({ type: 'turn-start' });
        // A new segment opens lazily on the first text-delta — start clean.
        sealSegment();
        turnStreamedTextRef.current = false;
        setTurnPhase(event.kind === 'programmatic' ? 'running background work' : 'thinking');

        if (event.kind === 'programmatic') {
          addMessage({ role: 'evolution', content: `» ${event.event ?? 'event'}: ${event.text.slice(0, 100)}` });
        }

        return;
      }

      case 'text-delta':
        if (!event.delta) return;
        turnStreamedTextRef.current = true;

        if (!activeSegmentRef.current) beginSegment();
        stream.append(event.delta);
        setTurnPhase((current) => current === 'writing' ? current : 'writing');

        return;
      case 'tool-call':
        sealSegment();
        setTurnPhase(`calling ${event.toolName}`);
        addMessage({
          role: 'tool_call', content: '', toolName: event.toolName, toolCallId: event.toolCallId,
          args: JSON.stringify(event.args),
        } satisfies Omit<DisplayMessage, 'id'>);

        return;
      case 'tool-result':
        setTurnPhase(`finished ${event.toolName}`);
        addMessage({
          role: 'tool_result', content: event.result, success: event.success,
          toolName: event.toolName, toolCallId: event.toolCallId,
        } satisfies Omit<DisplayMessage, 'id'>);

        return;
      case 'step-finish':
        setTurnPhase(`step ${event.stepIndex}`);

        return;
      case 'evolution':
      case 'background':
        addMessage({ role: 'evolution', content: `[${event.event}] ${event.message}` });

        return;
      case 'error':
        sealSegment();
        addMessage({ role: 'system', content: errorLine(event.message) });

        return;
      case 'turn-end':
        await handleTurnEnd(event);

        return;
      case 'broadcast':
        handleBroadcast(event);

        return;
      case 'run-event': {
        // `provider_wait`: the endpoint asked to wait (rate limit). The next phase-setting event replaces it.
        if (event.event.type === 'provider_wait') {
          const notice = event.event;

          setTurnPhase(`waiting on ${notice.provider} (retry in ${Math.ceil(notice.waitMs / 1000)}s)`);
        }

        return;
      }
    }
  }, [addMessage, beginSegment, dispatchInput, handleBroadcast, handleTurnEnd, sealSegment, setTurnPhase, stream]);

  // Connect once per client; re-runs when a walk-back fork swaps in a sibling client.
  useEffect(() => {
    const preconnected = preconnectedClientRef.current === client;

    if (preconnected) preconnectedClientRef.current = null;
    else setReady(false);
    const generation = clientGenerationRef.current;

    const buffered = preconnected && preconnectedEventsRef.current?.client === client
      ? preconnectedEventsRef.current
      : null;

    const bufferedCount = buffered?.events.length ?? 0;
    const abort = new AbortController();

    const unsubscribe = client.subscribe((event) => {
      if (clientGenerationRef.current === generation && !abort.signal.aborted) {
        return handleClientEvent(event);
      }
    });

    let replayTask: Promise<void> | null = null;

    if (buffered) {
      buffered.stop();
      preconnectedEventsRef.current = null;

      const replay = buffered.events.slice(0, bufferedCount)
        .filter((event, index) =>
          index >= buffered.historyBoundary || !persistedTranscriptEvent(event));

      replayTask = (async () => {
        await Promise.all(replay.map((event) => handleClientEvent(event)));
      })();
    }

    let task: Promise<void> | null = null;
    let settled = false;
    task = (async () => {
      try {
        if (hydrateHistory && !skipHydrationRef.current) {
          try {
            const history = await client.history();

            if (!abort.signal.aborted && history.length > 0) {
              setMessages([welcomeMessage(client.agentName), ...history]);
            }
          } catch (historyError) {
            if (!abort.signal.aborted) {
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

          if (!abort.signal.aborted) addError({ cause: error });
        }

        if (!connected || abort.signal.aborted) return;
        setReady(true);

        if (client.mode !== 'cloud') return;

        try {
          await deviceConnect.offerIfUnconnected();
        } catch (cause) {
          // A courtesy offer: failure is a diagnostic, not a conversation line.
          diagnostics.failure(
            'tui.device_connect_offer_failed',
            toKinuError({ doing: 'offering the device-connect prompt', cause, otherwise: 'unavailable' }),
            { workspace: client.agentName },
          );
        }
      } catch (cause) {
        if (!abort.signal.aborted) addError({ cause });
      } finally {
        try {
          if (replayTask) await replayTask;
        } finally {
          settled = true;

          if (task !== null && connectionTaskRef.current === task) connectionTaskRef.current = null;
        }
      }
    })();
    connectionTaskRef.current = task;

    if (settled && connectionTaskRef.current === task) connectionTaskRef.current = null;

    return () => {
      abort.abort();
      unsubscribe();
    };
  }, [addError, addMessage, client, deviceConnect.offerIfUnconnected, handleClientEvent, hydrateHistory]);

  useEffect(() => {
    const abort = new AbortController();
    let task: Promise<void> | null = null;
    let settled = false;
    task = (async () => {
      try {
        await Promise.all([
          (async () => {
            try {
              const next = await client.status();

              if (abort.signal.aborted) return;
              setStatus(next);
              setModelSpec((current) => current || (next.model ?? ''));
            } catch (cause) {
              if (!abort.signal.aborted) {
                addMessage({
                  role: 'system',
                  content: errorLine(`Workspace status could not be read: ${renderThrownChain({ cause })}`),
                });
              }
            }
          })(),
          (async () => {
            try {
              const menu = await client.listModels();

              if (!abort.signal.aborted) setModelCatalog(menu.models);
            } catch (cause) {
              if (!abort.signal.aborted) {
                addMessage({
                  role: 'system',
                  content: errorLine(`The model catalog could not be read: ${renderThrownChain({ cause })}`),
                });
              }
            }
          })(),
        ]);
      } finally {
        settled = true;

        if (task !== null && metadataTaskRef.current === task) metadataTaskRef.current = null;
      }
    })();
    metadataTaskRef.current = task;

    if (settled && metadataTaskRef.current === task) metadataTaskRef.current = null;

    return () => { abort.abort(); };
  }, [addMessage, client]);

  // The shared watcher shows each consent once and cancels on settle.
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

  const overlayOpen = anyOverlayOpen({
    activeSurface, navigationOpen, walkbackOpen: inputState.walkbackOpen,
    pendingConsent, shellApproval: shellApproval.pending, deviceConnect: deviceConnect.state,
  });

  // Auto-copy selected text to clipboard (OSC 52) on mouse release.
  useEffect(() => {
    if (!rendererInstance?.root) return;
    let copied = false;

    const copySelection = () => {
      if (!rendererInstance.hasSelection) {
        copied = false;

        return;
      }

      if (copied) return;
      const selection = rendererInstance.getSelection();

      if (!selection) return;
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
    };

    rendererInstance.root.onMouseUp = () => {
      setTimeout(() => {
        copySelection();

        // A click moves native focus off the input; reclaim it.
        if (inputShouldFocusRef.current) inputRef.current?.focus();
      }, 10);
    };

    return () => { rendererInstance.root.onMouseUp = undefined; };
  }, [rendererInstance]);

  const surfaceKeys: SurfaceKeyDeps = {
    activeSurface,
    setActiveSurface,
    walkbackOpen: inputState.walkbackOpen,
    closeWalkback: () => dispatchInput({ type: 'walkback-closed' }),
    settingsOpen,
    commandPalette,
    wideLayout: tuiLayoutForWidth(width) === 'wide',
    setNavigationOpen,
    toggleWideSidebar: () => updatePreferences((current) => ({ ...current, wideSidebarOpen: !current.wideSidebarOpen })),
    busy: () => machineRef.current.activeTurns > 0 || clientActionCountRef.current > 0,
    addMessage,
    lastUrl: () => lastUrlFromMessages(messagesRef.current),
    openBrowser,
    openModelPicker,
    hub,
    nextTier,
    turnTier: status?.tierId,
    setNextTier,
    toggleToolDetails: () => setToolDetailsExpanded((expanded) => !expanded),
    cycleReasoningEffort: () => selectReasoningEffort(nextReasoningEffort(efforts, effort)),
    history: historyRef.current,
    rememberScroll: scrollAnchor.remember,
    createNewAgent: onNewAgent === undefined ? undefined : createNewAgent,
    bumpModelRequest: () => { modelRequestRef.current += 1; },
  };

  const composerKeys: ComposerKeyDeps = {
    input: inputRef,
    promptHistory,
    promptCursor: () => promptCursorRef.current,
    setPromptCursor: (cursor) => { promptCursorRef.current = cursor; },
    setInputText,
    undoDraft: draftEditing.undo,
    externalDraft: draftEditing.external,
    expandPastes,
    rememberPrompt,
    setSelectionPending: (pending) => { selectionPendingRef.current = pending; },
    focusInput: () => inputRef.current?.focus(),
    addError,
    dispatchInput,
    runInputEffects,
    hasUserMessages: () => messages.some((message) => message.role === 'user'),
    openSurface: setActiveSurface,
  };

  const sceneKeys = { ...sceneKeyHandlers(surfaceKeys), ...composerKeyHandlers(composerKeys) };
  const modalKeys = modalKeyHandlers(surfaceKeys);
  useKeyboard(async (key) => {
    draftEditing.changed();

    if (shellApproval.pending) {
      key.preventDefault();
      const decision = consentKeyDecision(key, keyDispatcher, shellApprovalCanApprove(shellApproval.pending, { width: sceneWidth, height }));

      if (decision === 'once') shellApproval.decide('allow');
      else if (decision === 'always') shellApproval.decide('allow_always');
      else if (decision === 'deny') shellApproval.decide('deny');

      return;
    }

    if (deviceConnect.handleKey(key)) {
      key.preventDefault();

      return;
    }

    if (pendingConsent) {
      key.preventDefault();
      const decision = consentKeyDecision(key, keyDispatcher, deviceConsentCanApprove(pendingConsent, { width, height }));

      if (decision === 'once') resolvePendingConsent('once');
      else if (decision === 'always') resolvePendingConsent('always');
      else if (decision === 'deny') resolvePendingConsent('deny');

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

    if (result.actionId === null) return;

    // Each handler owns its preventDefault.
    return await (modalActive ? modalKeys : sceneKeys)[result.actionId]?.(key);
  });

  const onInputSubmit = useCallback(() => {
    if (overlayOpen) return;
    const value = inputRef.current?.plainText ?? '';

    if (!value.trim()) return;
    setInputText('');
    draftEditing.reset();

    return handleSubmit(expandPastes(value));
  }, [draftEditing.reset, expandPastes, handleSubmit, overlayOpen, setInputText]);

  const commandHints = !settingsOpen && !themePickerOpen && !commandPalette && !modelPicker && hubView === null
    && !changelogView && !takesView && !inputState.walkbackOpen && !navigationOpen
    && !isProcessing && !/\s/.test(draft.trimStart())
    ? filterCommands(commands, draft)
    : [];

  const inputFocused = ready && !overlayOpen;
  const contextTokens = estimateContextTokens(messages);
  const contextWindow = contextWindowForSpec(modelCatalog, modelSpec);
  const walkbackList = inputState.walkbackOpen ? forkCandidates(messages) : [];

  const surfaceTitle = surfaceTitleFor(activeSurface, inputState.walkbackOpen);
  // Turn progress stays in the phase line.
  const composerTitle = surfaceTitle ?? undefined;

  const composerPlaceholder = composerPlaceholderFor(ready, isProcessing);

  useEffect(() => {
    if (inputFocused) inputRef.current?.focus();
  }, [inputFocused]);
  // A resize re-wraps without an edit event.
  useEffect(syncComposerRows, [width, syncComposerRows]);
  inputShouldFocusRef.current = inputFocused;

  /** Exactly one overlay is on screen, first match wins. */
  function activeOverlay(): ReactNode {
    if (activeSurface?.kind === 'history') {
      return (
        <PromptHistoryOverlay entries={promptHistory} terminal={{ width: sceneWidth, height }} onSelect={(text) => {
          setActiveSurface(null);
          setInputText(text);
          inputRef.current?.gotoBufferEnd();
        }} />
      );
    }

    if (themePickerOpen) {
      return (
        <ThemePickerOverlay
          terminal={{ width: sceneWidth, height }}
          selection={preferences.theme ?? DEFAULT_TUI_THEME_SELECTION}
          onSelect={(selection: ThemeSelection) => {
            setActiveSurface(null);
            updatePreferences((current) => ({ ...current, theme: selection }));
          }}
        />
      );
    }

    if (settingsOpen) {
      return (
        <SettingsOverlay
          settings={settings}
          terminal={{ width: sceneWidth, height }}
          onSelect={(setting) => {
            setActiveSurface(null);

            if (setting.command === '/model') return openModelPicker();

            if (setting.command.endsWith(' ')) {
              setInputText(setting.command);

              return;
            }

            return handleSubmit(setting.command);
          }}
        />
      );
    }

    if (hubView !== null && hubLive !== undefined) {
      return (
        <HubOverlay
          view={hubView}
          data={hubLive}
          width={sceneWidth}
          height={height}
          {...(onNewAgent !== undefined ? { newAgentHint: keybindings.hint('hub.new-agent') } : {})}
        />
      );
    }

    if (commandPalette) {
      return (
        <CommandPaletteOverlay
          commands={commands}
          terminal={{ width: sceneWidth, height }}
          onSelect={(command) => {
            setActiveSurface(null);
            setInputText(`${command.name}${command.usage ? ' ' : ''}`);
          }}
        />
      );
    }

    if (modelPicker) {
      return (
        <ModelPickerOverlay
          models={modelPicker.menu.models}
          failures={modelPicker.menu.failures}
          currentSpec={modelSpec}
          terminal={{ width: sceneWidth, height }}
          loading={modelPicker.loading}
          error={modelPicker.error}
          onSelect={selectModel}
        />
      );
    }

    if (changelogView) {
      return (
        <ChangelogOverlay
          view={changelogView}
          terminal={{ width: sceneWidth, height }}
          onSelect={revertChangelogEntry}
        />
      );
    }

    if (takesView) {
      return (
        <TakesOverlay
          set={takesView}
          terminal={{ width: sceneWidth, height }}
          onSelect={(candidate) => pickTake(takesView, candidate)}
        />
      );
    }

    if (inputState.walkbackOpen && walkbackList.length > 0) {
      return (
        <WalkbackOverlay
          candidates={walkbackList}
          terminal={{ width: sceneWidth, height }}
          onSelect={performWalkback}
        />
      );
    }

    return (

      <CommandHintOverlay commands={commandHints} terminal={{ width: sceneWidth, height }} />

    );
  }

  return (
    <TuiShell
      scene="chat"
      roster={roster}
      currentAgent={{ name: client.agentName, mode: client.mode }}
      navigationOverlayOpen={navigationOpen}
      onNavigationOverlayChange={setNavigationOpen}
      onNavigationFocusChange={handleNavigationFocusChange}
      onAgentSelect={switchWorkspace}
    >
    <box flexDirection="column" style={{ width: '100%', height: '100%' }}>
      <StatusBar
        name={status?.name ?? client.agentName}
        mode={client.mode}
        model={modelSpec}
        reasoningEffort={effort}
        onModelSelect={() => {
          if (!overlayOpen) return openModelPicker();
        }}
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
            trackOptions: { foregroundColor: colors.border.strong, backgroundColor: colors.background.canvas ?? colors.background.recessed },
          },
        }}
      >
        <MessageList messages={messages} toolDetailsExpanded={toolDetailsExpanded} />
        <PhaseLine label={phaseLineLabel(isProcessing, turnPhase, nextTier)} />
      </scrollbox>

      {inputState.queue.length > 0 && (
        <box flexDirection="column" style={{ paddingLeft: 2, paddingRight: 2 }}>
          {inputState.queue.map((text, i) => (
            <text key={`queued-${i}`}>
              <span fg={colors.text.muted}>⧗ {i + 1} · </span>
              <span fg={colors.text.primary}>{clipText(text.replace(/\s+/g, ' '), Math.max(8, sceneWidth - 12))}</span>
            </text>
          ))}
          <text><span fg={colors.text.muted}>queued · {keybindings.hint('queue.edit-last')} on an empty input edits the last</span></text>
        </box>
      )}

      <box
        style={{
          height: composerRows + 2,
          border: true,
          borderStyle: 'rounded',
          borderColor: inputFocused ? colors.border.focus : colors.border.user,
          backgroundColor: colors.background.user,
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
          onContentChange={() => {
            draftEditing.changed();
            const text = inputRef.current?.plainText ?? '';

            if (text !== draftValueRef.current) promptCursorRef.current = null;
            draftValueRef.current = text;
            setDraft(text);
            syncComposerRows();
          }}
          onCursorChange={draftEditing.cursorMoved}
          onSubmit={onInputSubmit}
          style={{
            backgroundColor: colors.background.user,
            focusedBackgroundColor: colors.background.user,
            textColor: colors.text.strong,
            focusedTextColor: colors.text.strong,
            placeholderColor: colors.text.muted,
            cursorColor: colors.intent.accent,
          }}
        />
      </box>

      {activeOverlay()}
      {pendingConsent && <DeviceConsentOverlay consent={pendingConsent} terminal={{ width: sceneWidth, height }} />}
      {deviceConnect.state && <DeviceConnectOverlay prompt={deviceConnect.state} terminal={{ width: sceneWidth, height }} />}
      {shellApproval.pending && <ShellApprovalOverlay request={shellApproval.pending} terminal={{ width: sceneWidth, height }} />}
    </box>
    </TuiShell>
  );
}


function composerPlaceholderFor(ready: boolean, isProcessing: boolean): string {
  if (!ready) return 'Connecting…';

  return isProcessing ? TUI_COMPOSER_STEERING_PLACEHOLDER : TUI_COMPOSER_PLACEHOLDER;
}

function phaseLineLabel(isProcessing: boolean, turnPhase: string | null, nextTier: TierId | null): string | null {
  if (isProcessing) return turnPhase ?? 'thinking';

  return nextTier === null ? null : `next turn · ${nextTier}`;
}

/** Plain text: the TUI styles system messages itself. */
function errorLine(message: string): string {
  const guided = guideFailure({ cause: message });

  return guided.hint ? `Error: ${guided.message}\n${guided.hint}` : `Error: ${guided.message}`;
}

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

async function loadHubData(client: AgentClient): Promise<TuiHubData> {
  const workspace = client.agentName;
  const [envelope, status] = await Promise.all([loadActiveProfile(), client.status()]);
  const roles = effectiveRoleCatalog(envelope.catalog);
  const activeRoleId = status.roleId && roles[status.roleId] ? status.roleId : DEFAULT_ROLE_ID;
  const tierId = status.tierId && tierIdsOf(envelope.catalog).includes(status.tierId) ? status.tierId : roles[activeRoleId]?.tier ?? 'default';

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
  const hubData = opts.hubData ?? await loadHubData(opts.client);
  const renderOptions: ChatAppOpts = { ...opts, hubData };
  const renderer = await createCliRenderer({ exitOnCtrlC: false, useMouse: true, exitSignals: [] });
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

  const shutDown = async () => {
    try {
      await cleanup();
    } catch (cause) {
      console.error(`\n  The TUI could not shut down cleanly: ${renderThrownChain({ cause })}`);
      process.exit(1);
    }
  };

  let exiting: Promise<void> | null = null;

  const exit = () => {
    exiting ??= shutDown();

    return exiting;
  };

  globalExit = exit;

  for (const signal of TUI_EXIT_SIGNALS) process.on(signal, exit);

  root.render(<ChatApp {...renderOptions} onClientChange={(client) => { currentClient = client; }} />);

  await new Promise<void>(() => {});
}

function effortsForModel(
  catalog: readonly AgentModelEntry[],
  spec: string,
  status: AgentClientStatus | null,
): ReasoningEffort[] {
  return offeredReasoningEfforts(catalog.find((model) => model.spec === spec)?.reasoningEfforts, status?.reasoningEffort);
}

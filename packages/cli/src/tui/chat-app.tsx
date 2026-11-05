/** OpenTUI chat surface for both backends. The input reducer owns turn state; the action registry owns key chords. */

import { createCliRenderer, type ScrollBoxRenderable, type TextareaRenderable } from '@opentui/core';
import { createRoot, useRenderer, useTerminalDimensions } from '@opentui/react';
import { useState, useCallback, useRef, useEffect, useMemo } from 'react';

import { nextReasoningEffort, type AlternateTakeCandidate, type AlternateTakeSet, type ChangelogEntry, type PendingDeviceConsent, type ReasoningEffort, type TierId } from '@kinu.run/core';
import { composerVisibleRows } from '@kinu.run/core/tui';
import { findForkPivot, forkCandidates, type AgentClient, type AgentClientEvent, type AgentClientSendOptions, type AgentClientStatus, type DeviceConsentDecision, type ForkPoint } from '../agent-client';
import { commandsForClient, describeBranchStatus, executeSlashCommand, isBranchStatusEvent, renderPlanReview, performUndo, type SlashOutcome } from '../slash-commands';
import { describePromptAttachment, resolvePromptAttachments } from '../attachments';
import { listSidebarAgents } from '../agent-list';
import { watchDeviceConsents } from '../consent-watch';
import { ASK_OWNER_TOOL, contextWindowForSpec, describeTakePick, EMPTY_MODEL_MENU, filterCommands, resolveCommandDraft, type AgentModelEntry, type AskingAgent, type OwnerAnswer } from '@kinu.run/core';
import { requireInteractiveTerminal, TUI_EXIT_SIGNALS } from '../prompt';
import { canonicalProjectRoot } from '../config';
import { openBrowser } from '../commands/auth';
import { StatusBar } from './status-bar';
import { MessageList, type DisplayMessage } from './messages';
import { useSubagentChat } from './use-subagent-chat';
import { loadHubData, useHub } from './use-hub';
import { createHostShell } from '@kinu.run/cli-backend';

import { deviceConsentCanApprove, DeviceConnectOverlay, DeviceConsentOverlay, ApprovalOverlay, approvalCanApprove, PhaseLine, type TuiSettingChoice } from './overlays';
import { useDeviceConnectPrompt } from './use-device-connect';
import { useApprovals } from './use-approvals';
import { JobOutputFrameSchema, READS_CHANGED_EVENT, type WorkMode } from '@kinu.run/core';
import * as v from 'valibot';
import { useComposerPaste } from './use-composer-paste';
import { useDraftEditing } from './use-draft-editing';
import { composerHelp } from './help-view';
import { consentKeyDecision } from './approval-keys';
import { composerKeyHandlers } from './draft-keys';
import { modalKeyHandlers, sceneKeyHandlers } from './surface-keys';
import type { ComposerKeyDeps } from './draft-keys';
import type { SurfaceKeyDeps } from './surface-keys';

import { initialInputState, reduceInput, type InputEffect, type InputMachineEvent } from '@kinu.run/core';
import { agentDisplayLabel, clipText } from '@kinu.run/core/tui';
import { createKeyDispatcher, openTuiKeyBindings } from './actions';
import { type TuiHubData, type TuiHubRow } from './hubs';
import { useTuiTheme } from './theme';
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
import { attempt, attemptInItsWords, chainOf, detach, diagnostics, flight, renderThrownChain, settle } from '@kinu.run/core/obs';
import { Cause, Effect } from 'effect';
import { useKeyboard } from './use-keys';
import { copyRefused, type ContextNumber, contextNumberOf, headerMeter, composerTakesKeys, composerPlaceholderFor, countStreamed, commandWorking, phaseLineLabel, errorLine, shownHistory, lastUrlFromMessages, unreadLine, tried, welcomeMessage, effortsForModel, persistedTranscriptEvent, modelOf, withModel, type CaughtFailure } from './chat-scene-text';
import { type ActiveSurface, anyOverlayOpen, surfaceTitleFor } from './chat-surface';
import { useTurnStream } from './use-turn-stream';
import { ChatOverlay } from './chat-overlay';

/** `local-peer` opens in place; `cloud-additional` runs server-side and is announced. */
interface TuiCreatedAgent {
  name: string;
  displayName: string;
  kind: 'local-peer' | 'cloud-additional';
  /** For a conversation outside the navigator (e.g. a cloud additional-agent facet). */
  client?: AgentClient;
}

export interface ChatAppOpts {
  client: AgentClient;
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

/** The app's exit once `runTuiChat` has drawn it: every call joins the first. */
let globalExit: (() => Effect.Effect<void>) | null = null;

export function ChatApp(props: ChatAppOpts) {
  return (
    <TuiProductProvider runtime={props.tui}>
      <ChatScene {...props} />
    </TuiProductProvider>
  );
}

function ChatScene({
  client: initialClient,
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
  const [messages, setMessages] = useState<DisplayMessage[]>(() => [welcomeMessage(client.agentName)]);
  const messagesRef = useRef(messages);
  messagesRef.current = messages;
  const [turnPhase, setTurnPhase] = useState<string | null>(null);
  const [commandPhase, setCommandPhase] = useState<string | null>(null);
  const [ready, setReady] = useState(false);
  // The workspace's configuration as one snapshot (model, effort, role): each operation updates it once.
  const [status, setStatus] = useState<AgentClientStatus | null>(null);
  const modelSpec = modelOf(status);
  const [nextTier, setNextTier] = useState<TierId | null>(null);
  const [liveContext, setLiveContext] = useState<ContextNumber | null>(null);
  const [modelCatalog, setModelCatalog] = useState<AgentModelEntry[]>([]);
  const [activeSurface, setActiveSurface] = useState<ActiveSurface>(null);
  const [pendingConsent, setPendingConsent] = useState<PendingDeviceConsent | null>(null);
  const commandPalette = activeSurface?.kind === 'commands';
  const hubView = activeSurface?.kind === 'hub' ? activeSurface.view : null;
  const settingsOpen = activeSurface?.kind === 'settings';

  const [hubSelectedId, setHubSelectedIdState] = useState<string | null>(null);
  // Keys between renders read the latest choice.
  const hubSelectedRef = useRef<string | null>(null);

  const setHubSelectedId = useCallback((id: string | null) => {
    hubSelectedRef.current = id;
    setHubSelectedIdState(id);
  }, []);

  const subagentScrollRef = useRef<ScrollBoxRenderable | null>(null);

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

  // The agent hub: what it shows, read for the open workspace and moved by the frames that name its reads.
  const { hub, live: hubLive, shownRoster, answered, reset: resetHub, jobOutput: hubJobOutput, readsChanged: hubReadsChanged } = useHub({
    client, seed: hubData, readHub, view: hubView, roster, label: status?.name, running: isProcessing, messages,
  });

  const addMessage = useCallback((msg: Omit<DisplayMessage, 'id'>): string => {
    const id = `msg-${++msgIdRef.current}`;
    setMessages((prev) => [...prev, { ...msg, id }]);

    return id;
  }, []);

  const addError = useCallback((failure: CaughtFailure) => {
    addMessage({ role: 'system', content: errorLine(renderThrownChain(failure)) });
  }, [addMessage]);

  /** What a read that failed is said as, unless what asked for it has gone. */
  const sayUnread = useCallback((signal: AbortSignal, what: string) => (failed: { readonly cause: unknown }) => {
    if (!signal.aborted) addMessage({ role: 'system', content: unreadLine(what, failed) });
  }, [addMessage]);

  /** The scene's own exit when it was given one, else the app's. */
  const leave = useCallback((): Promise<void> => settle(onExit === undefined ? (globalExit?.() ?? Effect.void) : Effect.promise(async () => onExit())), [onExit]);

  /** A step whose failure is said in the transcript; it never rejects. */
  const reported = useCallback(<A,>(step: () => PromiseLike<A>): Promise<void> => settle(Effect.catchCause(
    Effect.asVoid(Effect.promise(async () => step())),
    (failed) => Effect.sync(() => { addError({ cause: Cause.squash(failed) }); }),
  )), [addError]);

  /** Closes a client the page has left; a close that fails is said, worded by `say`, and never fails the step. */
  const closeSaying = useCallback((left: AgentClient, say: (reason: string) => string): Promise<void> => settle(Effect.catchCause(
    Effect.promise(() => left.close()),
    (failed) => Effect.sync(() => { addMessage({ role: 'system', content: say(chainOf(failed)) }); }),
  )), [addMessage]);

  /** A step chosen from a panel: one at a time, with input held until it settles and the panel closed. */
  const selecting = useCallback(<A,>(step: () => PromiseLike<A>): Promise<void> => {
    if (selectionPendingRef.current) return Promise.resolve();
    selectionPendingRef.current = true;
    setActiveSurface(null);
    setReady(false);

    return settle(Effect.ensuring(Effect.promise(() => reported(step)), Effect.sync(() => {
      selectionPendingRef.current = false;
      setReady(true);
    })));
  }, [reported]);

  const approvalNote = useCallback((kind: 'decided' | 'error', message: string) => {
    addMessage({ role: 'system', content: kind === 'error' ? errorLine(message) : message });
  }, [addMessage]);

  const overlays = { activeSurface, navigationOpen, walkbackOpen: inputState.walkbackOpen, pendingConsent, deviceConnect: deviceConnect.state };

  const approval = useApprovals(client, {
    running: isProcessing, ready, draft, othersOpen: anyOverlayOpen({ ...overlays, approval: null }), note: approvalNote,
  });

  const pasteNote = useCallback((content: string) => addMessage({ role: 'system', content }), [addMessage]);

  const expandPastes = useComposerPaste({ renderer: rendererInstance, input: inputRef,
    enabled: inputShouldFocusRef, limitBytes: client.inlineAttachmentLimitBytes, note: pasteNote });

  // Live assistant segments: a tool-call seals the active segment so the next text-delta opens one after the tool,
  // keeping text and tools in chronological order.
  const {
    activeSegmentRef, turnStreamedTextRef, stream, activeThinkingRef, thinkingStream, turnMeterRef, stepOutputsRef,
    appendThinking, beginSegment, sealThinking, sealSegment,
  } = useTurnStream(setMessages, msgIdRef);

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
  const [connectFailed, setConnectFailed] = useState(false);
  const [connectAttempt, setConnectAttempt] = useState(0);

  /** `!command` output for the next prompt, as in omp. */
  const localOutputsRef = useRef<string[]>([]);

  const forgetSessionTurn = useCallback(() => {
    localOutputsRef.current = [];
    setLiveContext(null);
    turnMeterRef.current = null;
    activeThinkingRef.current = null;
    thinkingStream.clear();
  }, [thinkingStream]);

  const sendPrompt = useCallback((input: string, mode?: WorkMode) => {
    rememberPrompt(input);
    const generation = clientGenerationRef.current;
    clientActionCountRef.current += 1;
    let sentRow: string | null = null;

    // A send that failed was never admitted: its row goes, and the failure says why, unless the workspace changed.
    return settle(Effect.ensuring(Effect.catchCause(Effect.promise(async () => {
      const prompt = await resolvePromptAttachments(input, { limitBytes: client.inlineAttachmentLimitBytes, planes: client.planes ?? undefined });

      if (clientGenerationRef.current !== generation) return;

      for (const problem of prompt.errors) addMessage({ role: 'system', content: problem });

      // Shown as sent; whether it steered the running turn is the client's answer once it lands, never a guess here.
      const sentMessage: Omit<DisplayMessage, 'id'> = {
        role: 'user',
        content: prompt.text,
        attachments: prompt.attached.length > 0 ? prompt.attached.map(describePromptAttachment) : undefined,
        steered: false,
      };

      sentRow = addMessage(sentMessage);
      const text = [...localOutputsRef.current.splice(0), prompt.text].join('\n\n');
      const payload = prompt.files.length > 0 ? { text, files: prompt.files } : text;
      const sendOptions: AgentClientSendOptions = { cwd: process.cwd(), ...(mode !== undefined && { mode }) };

      if (nextTier) sendOptions.tier = nextTier;

      setNextTier(null);
      const sent = await client.send(payload, sendOptions);
      const shown = sentRow;

      if (sent.landed === 'mid-turn') setMessages((prev) => prev.map((m) => (m.id === shown ? { ...m, steered: true } : m)));
    }), (failed) => Effect.sync(() => {
      const unsent = sentRow;

      if (clientGenerationRef.current !== generation) return;

      if (unsent !== null) setMessages((prev) => prev.filter((m) => m.id !== unsent));
      addError({ cause: Cause.squash(failed) });
    })), Effect.sync(() => { clientActionCountRef.current -= 1; })));
  }, [addError, addMessage, client, nextTier, rememberPrompt]);

  /** Falls back to a normal send when the turn just finished. */
  const performBranch = useCallback((input: string) => reported(async () => {
    const text = input.trim();

    if (!text) return;

    if (machineRef.current.activeTurns > 0 && client.branch(text, { cwd: process.cwd() })) {
      const branch: Omit<DisplayMessage, 'id'> = { role: 'user', content: text, branched: true };
      addMessage(branch);

      return;
    }

    await sendPrompt(text);
  }), [addMessage, client, reported, sendPrompt]);

  const performWalkback = useCallback((point: ForkPoint) => {
    if (selectionPendingRef.current) return Promise.resolve();
    selectionPendingRef.current = true;
    setReady(false);
    dispatchInput({ type: 'walkback-closed' });

    return settle(Effect.ensuring(Effect.promise(() => reported(async () => {
      const result = await client.fork(point);

      if (result.client !== client) {
        setReady(false);
        setStatus(null);
        clientGenerationRef.current += 1;
        setModelCatalog([]);
        setBranchTasks({});
        skipHydrationRef.current = true;
        forgetSessionTurn();
        const previous = client;
        setClient(result.client);
        onClientChange?.(result.client);
        await closeSaying(previous, (reason) => `The pre-fork session did not close cleanly: ${reason}`);
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
    })), Effect.sync(() => {
      selectionPendingRef.current = false;
      setReady(true);
    })));
  }, [closeSaying, client, dispatchInput, forgetSessionTurn, onClientChange, reported, setInputText]);

  const switchWorkspace = useCallback((
    workspace: Pick<TuiAgentSummary, 'name' | 'label' | 'mode'>,
    preparedClient?: AgentClient,
  ) => {
    if (!preparedClient && workspace.name === client.agentName && workspace.mode === client.mode) {
      setNavigationOpen(false);

      return Promise.resolve();
    }

    if (!onWorkspaceSelect && !preparedClient) {
      setNavigationOpen(false);
      addMessage({ role: 'system', content: 'Exit to the home screen to open another workspace.' });

      return Promise.resolve();
    }

    if (machineRef.current.activeTurns > 0 || clientActionCountRef.current > 0) {
      setNavigationOpen(false);
      addMessage({ role: 'system', content: 'Finish or stop the active workspace action before switching.' });

      return Promise.resolve();
    }

    if (selectionPendingRef.current) return Promise.resolve();
    selectionPendingRef.current = true;
    setNavigationOpen(false);
    setReady(false);
    let candidate: AgentClient | null = null;
    const bufferedEvents: AgentClientEvent[] = [];
    let stopBuffering: (() => void) | null = null;
    let historyBoundary = 0;

    return settle(Effect.catchCause(Effect.gen(function* () {
      // One of the two is present, as checked above.
      const chosen = preparedClient ?? (yield* Effect.promise(async () => onWorkspaceSelect?.(workspace.name)));

      if (chosen === undefined) return;
      candidate = chosen;
      stopBuffering = chosen.subscribe((event) => { bufferedEvents.push(event); });
      yield* Effect.promise(() => chosen.connect());
      // Earlier messages that do not load are said in their place; the workspace still opens.

      const { history, historyFailure } = yield* Effect.match(Effect.tryPromise({ try: () => chosen.history(), catch: (cause) => ({ cause }) }), {
        onSuccess: (read) => {
          historyBoundary = bufferedEvents.length;

          return { history: shownHistory(read), historyFailure: null };
        },
        onFailure: (failed) => ({ history: [], historyFailure: unreadLine('Earlier messages', failed) }),
      });

      const previous = client;
      draftsRef.current.set(`${previous.mode}:${previous.agentName}`, inputRef.current?.plainText ?? '');
      preconnectedClientRef.current = chosen;
      preconnectedEventsRef.current = {
        client: chosen,
        events: bufferedEvents,
        historyBoundary,
        stop: stopBuffering,
      };
      stopBuffering = null;
      skipHydrationRef.current = true;
      clientGenerationRef.current += 1;
      activeSegmentRef.current = null;
      forgetSessionTurn();
      setTurnPhase(null);
      setStatus(null);
      setModelCatalog([]);
      setBranchTasks({});
      // A pending next-turn tier does not survive a switch.
      setNextTier(null);
      resetHub();
      setInputState(initialInputState);
      setInputText(draftsRef.current.get(`${chosen.mode}:${chosen.agentName}`) ?? '');
      setMessages([
        welcomeMessage(chosen.agentName),
        ...history,
        ...(historyFailure
          ? [{ id: `switch-history-${++msgIdRef.current}`, role: 'system' as const, content: historyFailure }]
          : []),
      ]);
      setClient(chosen);
      setReady(true);
      onClientChange?.(chosen);
      candidate = null;
      selectionPendingRef.current = false;
      yield* Effect.promise(() => closeSaying(previous, (reason) => errorLine(`The previous workspace did not close cleanly: ${reason}`)));
    }), (failed) => Effect.gen(function* () {
      stopBuffering?.();
      // A candidate opened for the switch that failed is closed; a close that fails too is recorded.
      const opened: AgentClient | null = candidate;

      if (opened !== null) {
        yield* Effect.catch(attempt({ doing: 'closing a failed workspace switch candidate', otherwise: 'io' }, () => opened.close()), (unclosed) => Effect.sync(() => {
          diagnostics.failure('tui.workspace_candidate_close_failed', unclosed, { workspace: opened.agentName });
        }));
      }

      setReady(true);
      addError({ cause: Cause.squash(failed) });
      selectionPendingRef.current = false;
    })));
  }, [addError, client, closeSaying, forgetSessionTurn, onClientChange, onWorkspaceSelect, setInputText, stream]);

  /** Cloud supplies a facet client: the conversation nests under its parent workspace. */
  const createNewAgent = useCallback(async () => {
    if (onNewAgent === undefined || selectionPendingRef.current) return;

    if (machineRef.current.activeTurns > 0 || clientActionCountRef.current > 0) {
      addMessage({ role: 'system', content: 'Finish or stop the active workspace action before creating an agent.' });

      return;
    }

    addMessage({ role: 'system', content: 'Creating a new agent…' });

    await reported(async () => {
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
    });
  }, [addMessage, client, onNewAgent, reported, roster, switchWorkspace]);

  const openSubagent = useCallback((entry: TuiHubRow) => {
    if (entry.path === undefined) return;
    setActiveSurface({ kind: 'subagent', path: entry.path, label: entry.label, actorId: entry.actorId ?? null });
  }, []);

  const subagentSurface = activeSurface?.kind === 'subagent' ? activeSurface : null;

  const subagentChat = useSubagentChat(client, subagentSurface);

  const openModelPicker = useCallback(() => {
    const request = ++modelRequestRef.current;
    setActiveSurface({ kind: 'model', menu: EMPTY_MODEL_MENU, loading: true, error: null });

    // A list that fails for a panel since closed is recorded; one for the open panel is said in it.
    return settle(Effect.match(attempt({ doing: 'listing models for a closed TUI panel', otherwise: 'unavailable' }, () => client.listModels()), {
      onSuccess: (menu) => {
        if (modelRequestRef.current !== request) return;
        setModelCatalog(menu.models);
        setActiveSurface({ kind: 'model', menu, loading: false, error: null });
      },
      onFailure: (failed) => {
        if (modelRequestRef.current !== request) diagnostics.failure('tui.model_list_stale_failure', failed, { workspace: client.agentName });
        else setActiveSurface({ kind: 'model', menu: EMPTY_MODEL_MENU, loading: false, error: renderThrownChain({ cause: failed.cause ?? failed }) });
      },
    }));
  }, [client]);

  const openQuestions = useCallback(async () => {
    const open = (await client.questions?.list() ?? []).find((asking) => asking.asked.status === 'open');

    if (open !== undefined) setActiveSurface((surface) => surface ?? { kind: 'questions', asking: open });
  }, [client]);

  /** A refused answer is said in the transcript; the questions stay open for `/answer`. */
  const answerQuestions = useCallback((asking: AskingAgent, answers: readonly OwnerAnswer[]) => {
    setActiveSurface(null);

    return Effect.catch(
      Effect.map(attemptInItsWords('unavailable', async () => client.questions?.answer(asking.asked.id, answers)), (owed) => {
        if (owed !== undefined && owed !== null) addMessage({ role: 'system', content: 'Your answer is on its way: the agent takes it when it next wakes.' });
      }),
      (failure) => Effect.sync(() => addError({ cause: failure })),
    );
  }, [addError, addMessage, client]);

  const selectModel = useCallback((spec: string) => selecting(async () => {
    const result = await client.setModel(spec);

    setStatus(withModel(result.spec));
    addMessage({ role: 'system', content: `Model: ${result.spec}` });
  }), [addMessage, client, selecting]);

  const revertChangelogEntry = useCallback((entry: ChangelogEntry) => selecting(async () => {
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
  }), [addMessage, client, selecting]);

  /** A changed answer streams its continuation as the next turn. */
  const pickTake = useCallback((set: AlternateTakeSet, candidate: AlternateTakeCandidate) => selecting(async () => {
    const index = set.candidates.findIndex((entry) => entry.nodeId === candidate.nodeId) + 1;
    const result = await client.pickTake(set.id, candidate.nodeId);

    addMessage({ role: 'system', content: describeTakePick(result, index) });
  }), [addMessage, client, selecting]);

  const selectReasoningEffort = useCallback((chosen: ReasoningEffort) => reported(async () => {
    await client.setReasoningEffort(chosen);
    setStatus((value) => value === null ? value : { ...value, reasoningEffort: chosen });
  }), [client, reported]);

  const openWorkspaces = useCallback(() => {
    setNavigationOpen(true);
    updatePreferences((current) => ({ ...current, wideSidebarOpen: true }));
  }, [updatePreferences]);

  const applySlashOutcome = useCallback(async (outcome: SlashOutcome) => {
    switch (outcome.kind) {
      case 'text':
        if (outcome.cleared) setMessages([]);

        if (outcome.workspaces) {
          openWorkspaces();

          return;
        }

        addMessage({ role: 'system', content: copyRefused(outcome, rendererInstance) ?? outcome.text });

        return;
      case 'changelog':
        setActiveSurface({ kind: 'changelog', view: outcome.view });

        return;
      case 'takes':
        setActiveSurface({ kind: 'takes', set: outcome.set });

        return;
      case 'questions':
        setActiveSurface({ kind: 'questions', asking: outcome.asking });

        return;
      case 'model-set':
        setStatus(withModel(outcome.spec));
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
        const note: Omit<DisplayMessage, 'id'> = { role: 'system', content: '', status: outcome.status };
        addMessage(note);

        return;
      case 'exit':
        await leave();

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
          questions: 'The questions wait for you: /answer opens them again.',
          subagent: 'Subagent conversation closed.',
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
    leave,
    openModelPicker,
    openWorkspaces,
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
          return leave();
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
  }, [addMessage, client, leave, performBranch, sendPrompt, setInputText]);

  const runLocalCommand = useCallback(async (typed: string) => {
    const shared = !typed.startsWith('!!');
    const command = typed.replace(/^!!?/u, '').trim();
    const result = await createHostShell(process.cwd()).exec(command);
    const output = [result.stdout.trimEnd(), result.stderr.trimEnd()].filter((part) => part !== '').join('\n');
    const shown = `$ ${command}\n${output}${result.exitCode === 0 ? '' : `\nexit ${String(result.exitCode)}`}`;

    if (shared) localOutputsRef.current.push(`<local_command>\n${shown}\n</local_command>`);
    addMessage({ role: 'system', content: shown });
  }, [addMessage]);

  const handleSubmit = useCallback((input: string) => {
    const text = input.trim();

    if (!text) return;

    if (text.startsWith('!')) return runLocalCommand(text);

    if (!ready) {
      addMessage({ role: 'system', content: 'Still connecting.' });

      return;
    }

    const generation = clientGenerationRef.current;
    const submitted = text.startsWith('/') ? resolveCommandDraft(commands, text) : text;

    if (!submitted.startsWith('/')) return sendPrompt(submitted);

    clientActionCountRef.current += 1;
    setCommandPhase(commandWorking(commands, submitted));

    // A command that fails for the workspace still open is said; one for a workspace since left is recorded.
    return settle(Effect.ensuring(Effect.catch(attempt({ doing: 'finishing a submit for a previous workspace', otherwise: 'unavailable' }, async () => {
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
    }), (failed) => Effect.sync(() => {
      if (clientGenerationRef.current === generation) addError({ cause: failed.cause ?? failed });
      else diagnostics.failure('tui.stale_submit_failed', failed, { workspace: client.agentName });
    })), Effect.sync(() => {
      setCommandPhase(null);
      clientActionCountRef.current -= 1;
    })));
  }, [addError, addMessage, applySlashOutcome, client, commands, dispatchInput, messages, performBranch, performWalkback, ready, runInputEffects, sendPrompt, runLocalCommand]);

  /** Once per set, never for one already picked from. */
  const hintAlternateTakes = useCallback(() => {
    const generation = clientGenerationRef.current;

    return settle(Effect.match(attempt({ doing: 'reading takes for a previous workspace', otherwise: 'unavailable' }, () => client.latestTakes()), {
      onSuccess: (set) => {
        if (clientGenerationRef.current !== generation || !set || set.candidates.length < 2 || set.chosenNodeId || hintedTakesRef.current === set.id) return;
        hintedTakesRef.current = set.id;
        addMessage({ role: 'system', content: `${set.candidates.length} takes: /takes to compare` });
      },
      onFailure: (failed) => {
        if (clientGenerationRef.current === generation) {
          addMessage({ role: 'system', content: errorLine(`This turn's takes could not be read: ${renderThrownChain({ cause: failed.cause ?? failed })}`) });
        } else {
          diagnostics.failure('tui.stale_takes_read_failed', failed, { workspace: client.agentName });
        }
      },
    }));
  }, [addMessage, client]);

  const handleTurnEnd = useCallback(async (event: Extract<AgentClientEvent, { type: 'turn-end' }>) => {
    sealThinking();

    if (activeSegmentRef.current) stream.finish();
    sealSegment();

    if (!turnStreamedTextRef.current && event.turn.text.trim()) {
      addMessage({ role: 'assistant', content: event.turn.text.trim() });
    }

    const inputEffects = runInputEffects(dispatchInput({ type: 'turn-settled' }));

    if (machineRef.current.activeTurns === 0) {
      setTurnPhase(null);
      turnMeterRef.current = null;
    }

    if (event.turn.toolCalls.some((call) => call.name === 'agents')) await hintAlternateTakes();

    // A turn that asked the owner opens its questions; Esc leaves them for /answer.
    if (event.turn.toolCalls.some((call) => call.name === ASK_OWNER_TOOL)) await openQuestions();

    await inputEffects;
  }, [addMessage, dispatchInput, hintAlternateTakes, openQuestions, runInputEffects, sealSegment, sealThinking, setTurnPhase, stream]);

  const handleBroadcast = useCallback((event: Extract<AgentClientEvent, { type: 'broadcast' }>) => {
    const printed = v.safeParse(JobOutputFrameSchema, event.event);

    if (printed.success) {
      const frame = printed.output;
      hubJobOutput(frame);

      return;
    }

    if (event.event.type === READS_CHANGED_EVENT) {
      const reads = event.event.reads ?? [];
      hubReadsChanged(reads);

      if (reads.includes('listPendingActions')) approval.queueMoved();

      return;
    }

    if (event.event.type === 'context_fill') {
      const measured = contextNumberOf(event.event);
      setLiveContext(measured);

      // No true number: the recorded one is the cleared conversation's too.
      if (measured === null) setStatus((current) => current === null ? current : { ...current, context: null });

      return;
    }

    if (event.event.type === 'plan_updated' && event.event.plan) {
      addMessage({ role: 'system', content: renderPlanReview(event.event.plan) });

      return;
    }

    if (event.event.type === 'model_fallback' && event.event.message !== undefined) {
      sealSegment();
      addMessage({ role: 'system', content: event.event.message });

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
  }, [addMessage, approval.queueMoved, sealSegment, setBranchTasks]);

  const handleClientEvent = useCallback(async (event: AgentClientEvent) => {
    switch (event.type) {
      case 'turn-start': {
        dispatchInput({ type: 'turn-start' });
        // A new segment opens lazily on the first text-delta — start clean.
        sealSegment();
        sealThinking();
        stepOutputsRef.current.clear();
        turnStreamedTextRef.current = false;
        turnMeterRef.current ??= { startedAt: Date.now(), streamedChars: 0 };
        setTurnPhase(event.kind === 'programmatic' ? 'running background work' : 'thinking');

        if (event.kind === 'programmatic') {
          addMessage({ role: 'evolution', content: `» ${event.event ?? 'event'}: ${event.text.slice(0, 100)}` });
        }

        return;
      }

      case 'reasoning-delta':
        countStreamed(turnMeterRef.current, event.delta);
        appendThinking(event.delta);

        return;
      case 'text-delta':
        if (!event.delta) return;
        sealThinking();
        countStreamed(turnMeterRef.current, event.delta);
        turnStreamedTextRef.current = true;

        if (!activeSegmentRef.current) beginSegment();
        stream.append(event.delta);
        setTurnPhase((current) => current === 'writing' ? current : 'writing');

        return;
      case 'tool-call':
        sealThinking();
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
      case 'step-cut': {
        const cut = stepOutputsRef.current;
        stepOutputsRef.current = new Set();
        activeSegmentRef.current = null;
        activeThinkingRef.current = null;
        stream.clear();
        thinkingStream.clear();
        setMessages((previous) => previous.filter((message) => !cut.has(message.id)));
        setTurnPhase('thinking');

        return;
      }

      case 'step-finish':
        if (activeSegmentRef.current) stream.finish();
        sealSegment();
        sealThinking();
        stepOutputsRef.current.clear();
        setTurnPhase(`step ${event.stepIndex}`);

        return;
      case 'evolution':
      case 'background':
        addMessage({ role: 'evolution', content: `[${event.event}] ${event.message}` });

        return;
      case 'error':
        sealThinking();
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
  }, [addMessage, appendThinking, beginSegment, dispatchInput, handleBroadcast, handleTurnEnd, sealSegment, sealThinking, setTurnPhase, stream, thinkingStream]);

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
      if (clientGenerationRef.current !== generation || abort.signal.aborted) return;
      detach(Effect.promise(() => handleClientEvent(event)));
    });

    let replayTask: Promise<void> = Promise.resolve();

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

    // Each part's failure is said in its own words; the replay of what arrived meanwhile always finishes.
    detach(Effect.ensuring(Effect.catchCause(Effect.gen(function* () {
      if (!skipHydrationRef.current) {
        yield* Effect.match(tried(() => client.history()), {
          onSuccess: (read) => {
            const history = shownHistory(read);

            if (!abort.signal.aborted && history.length > 0) setMessages([welcomeMessage(client.agentName), ...history]);
          },
          onFailure: sayUnread(abort.signal, 'Earlier messages'),
        });
      }

      skipHydrationRef.current = false;

      const connected = preconnected || (yield* Effect.match(tried(() => client.connect()), {
        onSuccess: () => true,
        onFailure: (failed) => {
          if (!abort.signal.aborted) {
            addError(failed);
            setConnectFailed(true);
          }

          return false;
        },
      }));

      if (!connected || abort.signal.aborted) return;
      setConnectFailed(false);
      setReady(true);

      if (client.mode !== 'cloud') return;

      // A courtesy offer: failure is a diagnostic, not a conversation line.
      yield* Effect.catch(attempt({ doing: 'offering the device-connect prompt', otherwise: 'unavailable' }, () => deviceConnect.offerIfUnconnected()), (failed) => Effect.sync(() => {
        diagnostics.failure('tui.device_connect_offer_failed', failed, { workspace: client.agentName });
      }));
    }), (failed) => Effect.sync(() => {
      if (!abort.signal.aborted) addError({ cause: Cause.squash(failed) });
    })), Effect.promise(async () => { await replayTask; })));

    return () => {
      abort.abort();
      unsubscribe();
    };
  }, [addError, client, connectAttempt, deviceConnect.offerIfUnconnected, handleClientEvent, sayUnread]);

  useEffect(() => {
    const abort = new AbortController();
    // Either read that fails says so in the transcript; the other still lands.
    detach(Effect.all([
      Effect.match(tried(() => client.status()), {
        onSuccess: (next) => { if (!abort.signal.aborted) setStatus(next); },
        onFailure: sayUnread(abort.signal, 'Workspace status'),
      }),
      Effect.match(tried(() => client.listModels()), {
        onSuccess: (menu) => { if (!abort.signal.aborted) setModelCatalog(menu.models); },
        onFailure: sayUnread(abort.signal, 'The model catalog'),
      }),
    ], { concurrency: 'unbounded' }));

    return () => { abort.abort(); };
  }, [client, sayUnread]);

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
        const decide = (outcome: DeviceConsentDecision | 'cancelled') => {
          consentDecisionRef.current = null;
          setPendingConsent(null);
          setTimeout(() => { resolve(outcome); }, 0);
        };

        consentDecisionRef.current = decide;
        setPendingConsent(consent);
        signal.addEventListener('abort', () => decide('cancelled'), { once: true });
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

  const overlayOpen = anyOverlayOpen({ ...overlays, approval: approval.prompt });

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
    toggleWideSidebar: () => {
      const closing = preferences.wideSidebarOpen && navigationOpen;
      updatePreferences((current) => ({ ...current, wideSidebarOpen: !closing }));
      setNavigationOpen(!closing);
    },
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
    hubAgents: hubLive === undefined ? [] : [...hubLive.agents, ...hubLive.work, ...answered],
    hubSelectedId: () => hubSelectedRef.current,
    setHubSelectedId,
    openSubagent,
    subagentHistory: () => subagentScrollRef.current,
  };

  const runComposerInputEffects = useCallback((effects: InputEffect[]) => {
    const task = runInputEffects(effects);

    if (!task) return;
    detach(Effect.promise(() => task));
  }, [runInputEffects]);

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
    runInputEffects: runComposerInputEffects,
    hasUserMessages: () => messages.some((message) => message.role === 'user'),
    openSurface: setActiveSurface,
  };

  const sceneKeys = { ...sceneKeyHandlers(surfaceKeys), ...composerKeyHandlers(composerKeys) };
  const modalKeys = modalKeyHandlers(surfaceKeys);
  useKeyboard((key) => detach(Effect.promise(async () => {
    draftEditing.changed();

    if (approval.prompt) {
      key.preventDefault();
      const decision = consentKeyDecision(key, keyDispatcher, approvalCanApprove(approval.prompt, { width: sceneWidth, height }));

      if (decision !== null) approval.answer(decision);

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

    if (navigationOpen) return;
    const modalActive = activeSurface !== null || inputState.walkbackOpen;
    const result = keyDispatcher.feed(key, modalActive ? ['modal'] : ['editor', 'conversation', 'global']);

    if (result.pending) {
      key.preventDefault();

      return;
    }

    if (result.actionId === null) return;

    // Each handler owns its preventDefault.
    return await (modalActive ? modalKeys : sceneKeys)[result.actionId]?.(key);
  })));

  const onInputSubmit = useCallback(() => {
    if (overlayOpen) return;

    if (connectFailed) {
      setConnectFailed(false);
      setConnectAttempt((tries) => tries + 1);

      return;
    }

    const value = inputRef.current?.plainText ?? '';

    if (!value.trim()) return;
    setInputText('');
    draftEditing.reset();

    return handleSubmit(expandPastes(value));
  }, [connectFailed, draftEditing.reset, expandPastes, handleSubmit, overlayOpen, setInputText]);

  const commandHints = !overlayOpen && !isProcessing && !/\s/.test(draft.trimStart()) ? filterCommands(commands, draft) : [];

  const inputFocused = composerTakesKeys(ready, connectFailed, overlayOpen);
  const meter = headerMeter(liveContext, status, contextWindowForSpec(modelCatalog, modelSpec));
  const walkbackList = inputState.walkbackOpen ? forkCandidates(messages) : [];

  const surfaceTitle = surfaceTitleFor(activeSurface, inputState.walkbackOpen);
  // Turn progress stays in the phase line.
  const composerTitle = surfaceTitle ?? undefined;

  const composerPlaceholder = composerPlaceholderFor(ready, isProcessing, connectFailed);

  useEffect(() => {
    if (inputFocused) inputRef.current?.focus();
  }, [inputFocused]);
  // A resize re-wraps without an edit event.
  useEffect(syncComposerRows, [width, syncComposerRows]);
  inputShouldFocusRef.current = inputFocused;

  return (
    <TuiShell
      scene="chat"
      roster={shownRoster}
      currentAgent={{ name: client.agentName, mode: client.mode }}
      navigationOverlayOpen={navigationOpen}
      navigationFocused={navigationOpen}
      onNavigationOverlayChange={setNavigationOpen}
      onNavigationFocusChange={handleNavigationFocusChange}
      onAgentSelect={(selection) => detach(Effect.promise(() => switchWorkspace(selection)))}
    >
    <box flexDirection="column" style={{ width: '100%', height: '100%' }}>
      <StatusBar
        name={status?.name ?? client.agentName}
        mode={client.mode}
        model={modelSpec}
        reasoningEffort={effort}
        onModelSelect={() => {
          if (overlayOpen) return;
          detach(Effect.promise(openModelPicker));
        }}
        connected={ready}
        scaffoldVersion={status?.scaffoldVersion}
        toolCount={status?.toolCount}
        autoEvolve={status?.autoEvolve}
        contextTokens={meter.tokens}
        contextWindow={meter.window}
        branchCount={Object.keys(branchTasks).length}
        profile={hub?.data.profile.resolved}
      />

      <scrollbox
        ref={(value) => { historyRef.current = value; }}
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
        <MessageList messages={messages} toolDetailsExpanded={toolDetailsExpanded} fileLinks={client.fileLinks} />
        <PhaseLine label={phaseLineLabel(isProcessing, turnPhase, nextTier, commandPhase)} meter={turnMeterRef} />
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
          onSubmit={() => {
            const task = onInputSubmit();

            if (!task) return;
            detach(Effect.promise(() => task));
          }}
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

      <ChatOverlay
        surface={activeSurface} width={sceneWidth} height={height} client={client} commands={commands} commandHints={commandHints}
        promptHistory={promptHistory} settings={settings} modelSpec={modelSpec} subagentChat={subagentChat} subagentScrollRef={subagentScrollRef}
        hubLive={hubLive} answered={answered} hubSelectedId={hubSelectedId} canCreateAgent={onNewAgent !== undefined}
        walkbackList={walkbackList} walkbackOpen={inputState.walkbackOpen}
        close={() => setActiveSurface(null)} setInputText={setInputText} toInputEnd={() => inputRef.current?.gotoBufferEnd()}
        addMessage={addMessage} openModelPicker={openModelPicker} handleSubmit={handleSubmit} selectModel={selectModel}
        revertChangelogEntry={revertChangelogEntry} answerQuestions={answerQuestions} pickTake={pickTake} performWalkback={performWalkback}
      />
      {pendingConsent && <DeviceConsentOverlay consent={pendingConsent} terminal={{ width: sceneWidth, height }} />}
      {deviceConnect.state && <DeviceConnectOverlay prompt={deviceConnect.state} terminal={{ width: sceneWidth, height }} />}
      {approval.prompt && <ApprovalOverlay prompt={approval.prompt} terminal={{ width: sceneWidth, height }} />}
    </box>
    </TuiShell>
  );
}

export async function runTuiChat(opts: ChatAppOpts): Promise<void> {
  requireInteractiveTerminal();
  const hubData = opts.hubData ?? await loadHubData(opts.client);
  const renderOptions: ChatAppOpts = { ...opts, hubData };
  const renderer = await createCliRenderer({ exitOnCtrlC: false, useMouse: true, exitSignals: [] });
  const root = createRoot(renderer);
  let currentClient = opts.client;

  // The one exit: closes the workspace, tears the screen down and ends the process; a later call joins the first. A
  // failure on the way is said, and the process ends with 1.
  const exit = flight(() => Effect.catchCause(Effect.gen(function* () {
    const closeFailure = yield* Effect.match(tried(() => currentClient.close()), { onSuccess: () => null, onFailure: renderThrownChain });

    root.render(<box />);
    renderer.destroy();

    if (closeFailure) console.error(`\n  The workspace did not close cleanly: ${closeFailure}`);
    console.log('\n  Goodbye.\n');
    process.exit(0);
  }), (failed) => Effect.sync(() => {
    console.error(`\n  The TUI could not shut down cleanly: ${chainOf(failed)}`);
    process.exit(1);
  })), { keep: 'exit' });

  globalExit = exit;

  for (const signal of TUI_EXIT_SIGNALS) process.on(signal, () => detach(exit()));

  root.render(<ChatApp {...renderOptions} onClientChange={(client) => { currentClient = client; }} />);

  await new Promise<void>(() => {});
}


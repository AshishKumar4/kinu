/**
 * TUI Chat Application — the single OpenTUI React chat surface for both
 * backends, parameterized by an AgentClient (LocalAgentClient over
 * LocalAgentSession, CloudAgentClient over the OrchestratorAgent DO). The
 * client owns transport, recording, and history; this renders its
 * AgentClientEvent stream into scrollable message history with streaming text,
 * tool cards, evolution markers, a status bar, model/session pickers, and the
 * device-consent overlay.
 *
 * Input is driven by ONE state machine (tui/input-state.ts): Enter while a
 * turn runs STEERS it (client.steer), Tab queues the draft for after the turn,
 * Ctrl+B runs the draft as a parallel BRANCH (client.branch — settles into
 * Alternate Takes), Esc interrupts, and Esc-Esc opens the walk-back picker
 * that forks the conversation before an earlier user message (client.fork)
 * with that message pre-filled for editing.
 */

import {
  createCliRenderer,
  type KeyEvent,
  type ScrollBoxRenderable,
  type TextareaRenderable,
} from '@opentui/core';
import { createRoot, useKeyboard, useRenderer, useTerminalDimensions } from '@opentui/react';
import { useState, useCallback, useRef, useEffect, useMemo } from 'react';

import type { AlternateTakeCandidate, AlternateTakeSet, ChangelogEntry } from '@kinu.run/core';
import {
  findForkPivot,
  forkCandidates,
  type AgentChangelogView,
  type AgentClient,
  type AgentClientEvent,
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
  type SlashOutcome,
} from '../slash-commands';
import { describePromptAttachment, resolvePromptAttachments } from '../attachments';
import { listKnownAgents, type ListedAgent } from '../agent-list';
import { watchDeviceConsents } from '../consent-watch';
import { contextWindowForSpec, EMPTY_MODEL_MENU, type AgentModelEntry, type AgentModelMenu } from '../model-catalog';
import { requireInteractiveTerminal } from '../prompt';
import { guideFailure } from '../provider-guidance';
import { openBrowser } from '../commands/auth';
import type { CliSessionInfo } from '../session';
import { StatusBar } from './status-bar';
import { MessageList, type DisplayMessage } from './messages';
import {
  ChangelogOverlay,
  CommandHintOverlay,
  CommandPaletteOverlay,
  DeviceConnectOverlay,
  DeviceConsentOverlay,
  ModelPickerOverlay,
  PhaseLine,
  SessionPickerOverlay,
  TakesOverlay,
  SettingsOverlay,
  type TuiSettingChoice,
  WalkbackOverlay,
  WorkspaceDrawerOverlay,
} from './overlays';
import { useDeviceConnectPrompt } from './use-device-connect';
import { estimateContextTokens } from './context-status';
import { useStreamingBuffer } from './streaming-buffer';
import { renderSessionBrowser, selectSession } from './session-browser';
import { initialInputState, reduceInput, type InputEffect, type InputMachineEvent } from './input-state';
import { clipText } from './format';
import { tuiColors } from './theme';
import { diagnostics, renderThrownChain, toKinuError } from '@kinu.run/core/obs';

export interface ChatAppOpts {
  client: AgentClient;
  /** Seed the message list from client.history() before accepting input. */
  hydrateHistory?: boolean;
  onExit?: () => void;
  /** A cloud walk-back fork swaps in a sibling client; the host needs the
   *  current one so exit cleanup closes the right connection. */
  onClientChange?: (client: AgentClient) => void;
  /** Resolve one cached workspace choice through the same client factory used
   *  at startup. The TUI keeps navigation backend-neutral. */
  listWorkspaces?: () => readonly ListedAgent[];
  onWorkspaceSelect?: (name: string) => Promise<AgentClient>;
}

type ActiveSurface =
  | { kind: 'commands' }
  | { kind: 'settings' }
  | { kind: 'workspaces'; workspaces: readonly ListedAgent[] }
  | { kind: 'model'; menu: AgentModelMenu; loading: boolean; error: string | null }
  | { kind: 'sessions'; sessions: CliSessionInfo[] }
  | { kind: 'changelog'; view: AgentChangelogView }
  | { kind: 'takes'; set: AlternateTakeSet }
  | null;


interface CaughtFailure {
  cause: unknown;
}

let globalExit: (() => void) | null = null;

export function ChatApp({
  client: initialClient,
  hydrateHistory,
  onExit,
  onClientChange,
  listWorkspaces = listKnownAgents,
  onWorkspaceSelect,
}: ChatAppOpts) {
  const { width, height } = useTerminalDimensions();
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
  const [modelCatalog, setModelCatalog] = useState<AgentModelEntry[]>([]);
  const [activeSurface, setActiveSurface] = useState<ActiveSurface>(null);
  const [pendingConsent, setPendingConsent] = useState<PendingDeviceConsent | null>(null);
  const sessionPicker = activeSurface?.kind === 'sessions' ? activeSurface : null;
  const modelPicker = activeSurface?.kind === 'model' ? activeSurface : null;
  const changelogView = activeSurface?.kind === 'changelog' ? activeSurface.view : null;
  const takesView = activeSurface?.kind === 'takes' ? activeSurface.set : null;
  const commandPalette = activeSurface?.kind === 'commands';
  const workspaceDrawer = activeSurface?.kind === 'workspaces' ? activeSurface.workspaces : null;
  const settingsOpen = activeSurface?.kind === 'settings';
  const [draft, setDraft] = useState('');
  const [activeSessionId, setActiveSessionId] = useState(client.cliSession.id);
  const [inputState, setInputState] = useState(initialInputState);
  /** Steer-as-Branch runs in flight, branchId → task (status-bar segment). */
  const [branchTasks, setBranchTasks] = useState<Record<string, string>>({});

  const msgIdRef = useRef(0);
  const historyRef = useRef<ScrollBoxRenderable | null>(null);
  const inputRef = useRef<TextareaRenderable | null>(null);
  // Mirrors the input's declarative `focused` condition so the mouse handler can
  // reassert focus imperatively — a click moves OpenTUI's native focus without
  // re-rendering React, so the declarative prop alone never wins it back.
  const inputShouldFocusRef = useRef(false);
  const machineRef = useRef(initialInputState);
  /** A fork swap re-points the message list itself — skip the next hydration. */
  const skipHydrationRef = useRef(false);
  /** Take sets already hinted at, so a turn without a new convergence is quiet. */
  const hintedTakesRef = useRef<string | null>(null);
  /** Explicit workspace switches always hydrate the selected workspace. */
  const modelRequestRef = useRef(0);
  const hydrateNextClientRef = useRef(false);
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
    const prompt = await resolvePromptAttachments(input, { limitBytes: client.inlineAttachmentLimitBytes });
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
    if (steering && client.steer(payload, { cwd: process.cwd() })) return;
    try {
      await client.send(payload, { cwd: process.cwd() });
    } catch (err) {
      // Transport/pre-flight failures never reach the event stream.
      addError({ cause: err });
    }
  }, [addError, addMessage, client]);

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
    dispatchInput({ type: 'walkback-closed' });
    try {
      const result = await client.fork(point);
      if (result.client !== client) {
        setReady(false);
        setStatus(null);
        setModelSpec('');
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
      setActiveSessionId(result.client.cliSession.id);

      setInputText(point.text);
    } catch (err) {
      addError({ cause: err });
    }
  }, [addError, addMessage, client, dispatchInput, onClientChange, setInputText]);
  const switchWorkspace = useCallback(async (workspace: ListedAgent) => {
    if (workspace.name === client.agentName) {
      setActiveSurface(null);
      return;
    }
    if (!onWorkspaceSelect) {
      setActiveSurface(null);
      addMessage({ role: 'system', content: 'Workspace switching is unavailable in this host.' });
      return;
    }
    setReady(false);
    try {
      const next = await onWorkspaceSelect(workspace.name);
      const previous = client;
      hydrateNextClientRef.current = true;
      skipHydrationRef.current = false;
      activeSegmentRef.current = null;
      stream.clear();
      setTurnPhase(null);
      setActiveSurface(null);
      setStatus(null);
      setModelSpec('');
      setModelCatalog([]);
      setBranchTasks({});
      machineRef.current = initialInputState;
      setInputState(initialInputState);
      setInputText('');
      setMessages([welcomeMessage(next.agentName)]);
      setActiveSessionId(next.cliSession.id);
      setClient(next);
      onClientChange?.(next);
      void previous.close().catch((error) => {
        addMessage({
          role: 'system',
          content: errorLine(`The previous workspace did not close cleanly: ${renderThrownChain({ cause: error })}`),
        });
      });
    } catch (error) {
      setReady(true);
      addError({ cause: error });
    }
  }, [addError, addMessage, client, onClientChange, onWorkspaceSelect, setInputText, stream]);

  const resumeSession = useCallback(async (input: string, available?: CliSessionInfo[]) => {
    const sessionHistory = client.sessionHistory;
    if (!sessionHistory) {
      addMessage({ role: 'system', content: 'Recorded conversation resume is available for local workspaces.' });
      return;
    }
    const sessions = available ?? sessionHistory.list();
    const selected = selectSession(sessions, input);
    if (!selected) {
      addMessage({ role: 'system', content: `No matching session for "${input}". Type /resume to choose again.` });
      return;
    }
    setReady(false);
    try {
      await sessionHistory.resume(selected.info.id);
      const history = await client.history();
      activeSegmentRef.current = null;
      stream.clear();
      setTurnPhase(null);
      setActiveSurface(null);
      setActiveSessionId(client.cliSession.id);
      setMessages([
        { id: `resume-${selected.info.id}`, role: 'system', content: `Resumed ${selected.label}` },
        ...history,
      ]);
    } finally {
      setReady(true);
    }
  }, [addMessage, client, stream]);

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
    try {
      const result = await setModelPreference(client, model.spec);
      setModelSpec(result.spec);
      setActiveSurface(null);
      addMessage({ role: 'system', content: `Model: ${result.spec}` });
    } catch (err) {
      addError({ cause: err });
    }
  }, [addError, addMessage, client]);

  /** Enter on a changelog line: revert revertables through the real paths,
   *  explain informational lines; the overlay refreshes with the new digest. */
  const revertChangelogEntry = useCallback(async (entry: ChangelogEntry) => {
    if (!entry.revert) {
      addMessage({ role: 'system', content: `"${entry.summary}" is informational (${entry.kind}) — nothing to revert.` });
      return;
    }
    setActiveSurface(null);
    try {
      const result = await client.revertChangelogEntry(entry.id);
      addMessage({
        role: 'system',
        content: result.ok
          ? `Reverted: ${entry.summary}\n→ ${result.detail ?? 'done'}`
          : `Revert failed: ${result.error ?? 'unknown error'}`,
      });
      if (result.ok) setActiveSurface({ kind: 'changelog', view: await client.changelog() });
    } catch (err) {
      addError({ cause: err });
    }
  }, [addError, addMessage, client]);

  /** Enter on a take: record the pick (ledger + repoint); a changed answer
   *  streams its continuation as the next programmatic turn. */
  const pickTake = useCallback(async (set: AlternateTakeSet, candidate: AlternateTakeCandidate) => {
    setActiveSurface(null);
    try {
      const index = set.candidates.findIndex((c) => c.nodeId === candidate.nodeId) + 1;
      const result = await client.pickTake(set.id, candidate.nodeId);
      addMessage({ role: 'system', content: describeTakePick(result, index) });
    } catch (err) {
      addError({ cause: err });
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
      case 'sessions': {
        const sessions = client.sessionHistory?.list() ?? [];
        if (sessions.length === 0) {
          addMessage({ role: 'system', content: 'No recorded CLI sessions yet.' });
          return;
        }
        if (outcome.mode === 'resume' && outcome.resumeRef) {
          await resumeSession(outcome.resumeRef, sessions);
          return;
        }
        if (outcome.mode === 'resume') {
          setActiveSurface({ kind: 'sessions', sessions });
          return;
        }
        addMessage({ role: 'system', content: renderSessionBrowser('list', sessions) });
        return;
      }
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
          workspaces: 'Workspace drawer closed.',
          model: 'Model selection cancelled.',
          changelog: 'Changelog closed — everything kept.',
          takes: 'Takes closed — the answered take stays.',
          sessions: 'Resume cancelled.',
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
    resumeSession,
  ]);

  const runInputEffects = useCallback((effects: InputEffect[]) => {
    // Steers accepted mid-turn but never delivered come back to the composer
    // on interrupt — the same restore contract as the Tab queue (a queue
    // restore in the same batch merges behind them instead of clobbering).
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
    if (sessionPicker && !text.startsWith('/')) {
      try {
        await resumeSession(text, sessionPicker.sessions);
      } catch (err) {
        addError({ cause: err });
      }
      return;
    }
    const submitted = text.startsWith('/') ? resolveCommandDraft(commands, text) : text;
    if (submitted.startsWith('/')) {
      try {
        const outcome = await executeSlashCommand(client, submitted);
        if (outcome.kind === 'queue') {
          if (outcome.text) runInputEffects(dispatchInput({ type: 'queue', text: outcome.text }));
          else addMessage({ role: 'system', content: 'Usage: /queue <text> — it sends after the running turn (or immediately when idle).' });
          return;
        }
        if (outcome.kind === 'branch') {
          if (outcome.text) await performBranch(outcome.text);
          else addMessage({ role: 'system', content: 'Usage: /branch <text> (or Ctrl+B on a draft) — runs the redirect as a parallel branch of the running turn.' });
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
      } catch (err) {
        addError({ cause: err });
      }
      return;
    }
    await sendPrompt(submitted);
  }, [addError, addMessage, applySlashOutcome, client, commands, dispatchInput, messages, performBranch, performWalkback, ready, resumeSession, runInputEffects, sendPrompt, sessionPicker]);

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
        addMessage({ role: 'tool_result', content: event.result });
        break;
      case 'step-finish':
        setTurnPhase(`step ${event.stepIndex}`);
        break;
      case 'evolution':
        addMessage({ role: 'evolution', content: `[${event.event}] ${event.message}` });
        break;
      case 'error':
        // Informational: the lifecycle settles through the paired turn-end.
        sealSegment();
        addMessage({ role: 'system', content: errorLine(event.message) });
        break;
      case 'turn-end': {
        // Flush the trailing streamed text into the live segment, then seal it.
        // The streamed segments ARE the transcript — re-appending turn.text here
        // would duplicate the text after the tool cards (the old regrouping bug).
        if (activeSegmentRef.current) stream.finish();
        sealSegment();
        // Synthesized-text fallback: when the backend produced text without
        // streaming deltas (ended on a tool call, server-built summary), no
        // live segment captured it — surface it once.
        if (!turnStreamedTextRef.current && event.turn.text.trim()) {
          addMessage({ role: 'assistant', content: event.turn.text.trim() });
        }
        runInputEffects(dispatchInput({ type: 'turn-settled' }));
        if (machineRef.current.activeTurns === 0) setTurnPhase(null);
        // A fork run may have converged on near-tied approaches — hint once
        // per new take set so the comparison is one /takes away.
        if (event.turn.toolCalls.some((call) => call.name === 'agents')) {
          void client.latestTakes().then((set) => {
            if (!set || set.candidates.length < 2 || set.chosenNodeId) return;
            if (hintedTakesRef.current === set.id) return;
            hintedTakesRef.current = set.id;
            addMessage({ role: 'system', content: `${set.candidates.length} takes — /takes to compare` });
          }).catch((takesError) => {
            addMessage({ role: 'system', content: errorLine(`This turn's takes could not be read: ${renderThrownChain({ cause: takesError })}`) });
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
    setReady(false);
    const unsubscribe = client.subscribe(handleClientEvent);
    let cancelled = false;
    void (async () => {
      if ((hydrateHistory || hydrateNextClientRef.current) && !skipHydrationRef.current) {
        try {
          const history = await client.history();
          if (!cancelled && history.length > 0) {
            setMessages([welcomeMessage(client.agentName), ...history]);
          }
        } catch (historyError) {
          // An unread history renders as an empty transcript, which is exactly
          // what a brand-new workspace looks like. Say which this is.
          if (!cancelled) {
            addMessage({ role: 'system', content: errorLine(`Earlier messages could not be loaded: ${renderThrownChain({ cause: historyError })}`) });
          }
        }
      }
      skipHydrationRef.current = false;
      hydrateNextClientRef.current = false;
      await client.connect();
      if (cancelled) return;
      setReady(true);
      // Natural device access: a cloud chat with no connected PC offers to
      // connect this one (at most once per CLI invocation).
      if (client.mode === 'cloud') void deviceConnect.offerIfUnconnected();
    })();
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [addMessage, client, deviceConnect.offerIfUnconnected, handleClientEvent, hydrateHistory]);

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
    activeSurface || inputState.walkbackOpen || pendingConsent || deviceConnect.state,
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
    if (deviceConnect.handleKey(key)) return;
    if (pendingConsent) {
      if (key.name === 'o' || key.name === 'y' || key.name === 'return') {
        resolvePendingConsent('once');
      } else if (key.name === 'a') {
        resolvePendingConsent('always');
      } else if (key.name === 'n' || key.name === 'escape') {
        resolvePendingConsent('deny');
      }
      return;
    }
    if (key.name === 'g' && key.ctrl) {
      if (settingsOpen) setActiveSurface(null);
      else if (!overlayOpen) setActiveSurface({ kind: 'settings' });
      return;
    }
    if (key.name === 'k' && key.ctrl) {
      if (commandPalette) setActiveSurface(null);
      else if (!overlayOpen) setActiveSurface({ kind: 'commands' });
      return;
    }
    if (key.name === 'o' && key.ctrl) {
      if (workspaceDrawer) setActiveSurface(null);
      else if (!overlayOpen) setActiveSurface({ kind: 'workspaces', workspaces: listWorkspaces() });
      return;
    }
    if (key.name === 'l' && key.ctrl && !overlayOpen) {
      const url = lastUrlFromMessages(messagesRef.current);
      if (url) openBrowser(url);
      return;
    }
    if (key.name === 'p' && key.ctrl) {
      if (!overlayOpen) void openModelPicker();
      return;
    }
    if (key.name === 'b' && key.ctrl) {
      if (!overlayOpen) runInputEffects(dispatchInput({
        type: 'branch',
        draft: inputRef.current?.plainText ?? '',
      }));
      return;
    }
    if (key.name === 'tab') {
      if (!overlayOpen) runInputEffects(dispatchInput({
        type: 'tab',
        draft: inputRef.current?.plainText ?? '',
      }));
      return;
    }
    if (key.name === 'backspace') {
      if (!overlayOpen) runInputEffects(dispatchInput({
        type: 'backspace',
        draft: inputRef.current?.plainText ?? '',
      }));
      return;
    }
    if (key.name !== 'escape') return;
    if (activeSurface) {
      setActiveSurface(null);
      return;
    }
    runInputEffects(dispatchInput({
      type: 'escape',
      now: Date.now(),
      draft: inputRef.current?.plainText ?? '',
      hasUserMessages: messages.some((msg) => msg.role === 'user'),
    }));
  });

  const onInputSubmit = useCallback(() => {
    const value = inputRef.current?.plainText ?? '';
    if (!value.trim()) return;
    setInputText('');
    void handleSubmit(value);
  }, [handleSubmit, setInputText]);

  const draftLines = Math.min(6, Math.max(1, draft.split('\n').length));
  const commandHints = !settingsOpen && !commandPalette && !workspaceDrawer && !modelPicker
    && !changelogView && !takesView && !inputState.walkbackOpen
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
      : workspaceDrawer
        ? 'Workspaces ›'
        : modelPicker
          ? 'Model picker ›'
          : changelogView
            ? 'Changelog ›'
            : takesView
              ? 'Takes ›'
              : inputState.walkbackOpen
                ? 'Walk back ›'
                : sessionPicker
                  ? 'Resume ›'
                  : null;
  const composerTitle = isProcessing
    ? '⟳ processing…'
    : surfaceTitle
      ?? `${client.agentName} · ${activeSessionId.slice(0, 10)} · Ctrl+K commands · Ctrl+O workspaces · Ctrl+G settings`;
  const composerPlaceholder = !ready
    ? 'Connecting…'
    : isProcessing
      ? 'Type to steer · Tab queues · Ctrl+B branches · Esc interrupts'
      : 'Send a message… · Shift+Enter newline';
  useEffect(() => {
    if (inputFocused) inputRef.current?.focus();
  }, [inputFocused]);
  inputShouldFocusRef.current = inputFocused;

  return (
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
      />

      <scrollbox
        ref={(value) => { historyRef.current = value; }}
        focused={!isProcessing}
        stickyScroll={true}
        stickyStart="bottom"
        style={{
          flexGrow: 1,
          rootOptions: { backgroundColor: tuiColors.bg },
          viewportOptions: { backgroundColor: tuiColors.bg },
          contentOptions: { backgroundColor: tuiColors.bg },
          scrollbarOptions: {
            trackOptions: { foregroundColor: tuiColors.borderMuted, backgroundColor: tuiColors.panelStrong },
          },
        }}
      >
        <MessageList messages={messages} />
        <PhaseLine label={isProcessing ? (turnPhase ?? 'thinking') : null} />
      </scrollbox>

      {inputState.queue.length > 0 && (
        <box flexDirection="column" style={{ paddingLeft: 2, paddingRight: 2 }}>
          {inputState.queue.map((text, i) => (
            <text key={`queued-${i}`}>
              <span fg={tuiColors.amberDeep}>⧗ </span>
              <span fg={tuiColors.muted}>{i + 1} · </span>
              <span fg={tuiColors.text}>{clipText(text.replace(/\s+/g, ' '), Math.max(8, width - 12))}</span>
            </text>
          ))}
          <text><span fg={tuiColors.muted}>queued — sends after this turn · Backspace (empty input) edits the last</span></text>
        </box>
      )}

      <box
        style={{
          height: draftLines + 2,
          border: true,
          borderStyle: 'single',
          borderColor: isProcessing ? tuiColors.borderMuted : tuiColors.border,
          backgroundColor: tuiColors.panelStrong,
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
            { name: 'return', action: 'submit' },
            { name: 'return', shift: true, action: 'newline' },
            { name: 'return', meta: true, action: 'newline' },
            { name: 'j', ctrl: true, action: 'newline' },
          ]}
          onKeyDown={(event) => {
            handleHistoryScrollKey(event, inputRef.current?.plainText ?? '', historyRef.current);
          }}
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
      ) : workspaceDrawer ? (
        <WorkspaceDrawerOverlay
          workspaces={workspaceDrawer}
          current={client.agentName}
          terminal={{ width, height }}
          onSelect={(workspace) => { void switchWorkspace(workspace); }}
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
      ) : sessionPicker ? (
        <SessionPickerOverlay
          sessions={sessionPicker.sessions}
          cwd={process.cwd()}
          terminal={{ width, height }}
          onSelect={(session) => { void resumeSession(session.id, sessionPicker.sessions); }}
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
  );
}

interface HistoryScrollTarget {
  scrollTop: number;
  viewport: { height: number };
  scrollTo(position: number): void;
}

export function handleHistoryScrollKey(
  event: Pick<KeyEvent, 'name' | 'preventDefault'>,
  draft: string,
  history: HistoryScrollTarget | null,
): boolean {
  const isPageKey = event.name === 'pageup' || event.name === 'pagedown';
  const isEmptyDraftArrow = draft.length === 0 && (event.name === 'up' || event.name === 'down');
  if (!history || (!isPageKey && !isEmptyDraftArrow)) return false;

  const direction = event.name === 'up' || event.name === 'pageup' ? -1 : 1;
  const viewportFraction = isPageKey ? 0.5 : 0.2;
  const delta = Math.max(1, Math.floor(history.viewport.height * viewportFraction));
  history.scrollTo(history.scrollTop + direction * delta);
  event.preventDefault();
  return true;
}

/** A failure as a transcript entry: the provider's own words, plus the next
 *  command when the failure class implies one. Plain text — the TUI styles
 *  system messages itself, so no ANSI here. */
function errorLine(message: string): string {
  const guided = guideFailure(message);
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

export async function runTuiChat(opts: ChatAppOpts): Promise<void> {
  requireInteractiveTerminal();
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

  root.render(<ChatApp {...opts} onClientChange={(client) => { currentClient = client; }} />);

  // Keep the process alive
  await new Promise<void>(() => {});
}

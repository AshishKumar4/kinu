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

import { createCliRenderer, type TextareaRenderable } from '@opentui/core';
import { createRoot, useKeyboard, useTerminalDimensions } from '@opentui/react';
import { useState, useCallback, useRef, useEffect, useMemo } from 'react';

import type { AlternateTakeCandidate, AlternateTakeSet, ChangelogEntry } from '@proteus/core';
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
} from '../agent-client.js';
import {
  commandsForClient,
  describeBranchStatus,
  describeTakePick,
  executeSlashCommand,
  filterCommands,
  isBranchStatusEvent,
  performUndo,
  resolveCommandDraft,
  type SlashOutcome,
} from '../slash-commands.js';
import { describePromptAttachment, resolvePromptAttachments } from '../attachments.js';
import { watchDeviceConsents } from '../consent-watch.js';
import { contextWindowForSpec, type AgentModelEntry } from '../model-catalog.js';
import { requireInteractiveTerminal } from '../prompt.js';
import type { CliSessionInfo } from '../session.js';
import { StatusBar } from './status-bar.js';
import { MessageList, type DisplayMessage } from './messages.js';
import { StatusView } from './help-view.js';
import { ChangelogOverlay, CommandHintOverlay, DeviceConnectOverlay, DeviceConsentOverlay, ModelPickerOverlay, PhaseLine, TakesOverlay, WalkbackOverlay } from './overlays.js';
import { useDeviceConnectPrompt } from './use-device-connect.js';
import { estimateContextTokens } from './context-status.js';
import { useStreamingBuffer } from './streaming-buffer.js';
import { renderSessionBrowser, selectSession } from './session-browser.js';
import { initialInputState, reduceInput, type InputEffect, type InputMachineEvent } from './input-state.js';
import { clipText } from './format.js';
import { tuiColors } from './theme.js';

export interface ChatAppOpts {
  client: AgentClient;
  /** Seed the message list from client.history() before accepting input. */
  hydrateHistory?: boolean;
  initialPrompt?: string;
  onExit?: () => void;
  /** A cloud walk-back fork swaps in a sibling client; the host needs the
   *  current one so exit cleanup closes the right connection. */
  onClientChange?: (client: AgentClient) => void;
}

const STATUS_VIEW = 'STATUS_VIEW';

let globalExit: (() => void) | null = null;

export function ChatApp({ client: initialClient, hydrateHistory, initialPrompt, onExit, onClientChange }: ChatAppOpts) {
  const { width, height } = useTerminalDimensions();
  // The client can be swapped mid-session: a cloud walk-back fork returns a
  // sibling client pointed at the forked agent.
  const [client, setClient] = useState(initialClient);
  const [messages, setMessages] = useState<DisplayMessage[]>(() => [welcomeMessage(client.agentName)]);
  const [streamingText, setStreamingText] = useState<string | null>(null);
  const [turnPhase, setTurnPhase] = useState<string | null>(null);
  const [ready, setReady] = useState(false);
  const [status, setStatus] = useState<AgentClientStatus | null>(null);
  const [modelSpec, setModelSpec] = useState<string>('');
  const [modelCatalog, setModelCatalog] = useState<AgentModelEntry[]>([]);
  const [sessionPicker, setSessionPicker] = useState<{ sessions: CliSessionInfo[] } | null>(null);
  const [modelPicker, setModelPicker] = useState<{ models: AgentModelEntry[]; loading: boolean; error: string | null } | null>(null);
  const [changelogView, setChangelogView] = useState<AgentChangelogView | null>(null);
  const [takesView, setTakesView] = useState<AlternateTakeSet | null>(null);
  const [pendingConsent, setPendingConsent] = useState<PendingDeviceConsent | null>(null);
  const [draft, setDraft] = useState('');
  const [activeSessionId, setActiveSessionId] = useState(client.cliSession.id);
  const [inputState, setInputState] = useState(initialInputState);
  /** Steer-as-Branch runs in flight, branchId → task (status-bar segment). */
  const [branchTasks, setBranchTasks] = useState<Record<string, string>>({});

  const msgIdRef = useRef(0);
  const inputRef = useRef<TextareaRenderable | null>(null);
  const initialPromptSentRef = useRef(false);
  const machineRef = useRef(initialInputState);
  /** A fork swap re-points the message list itself — skip the next hydration. */
  const skipHydrationRef = useRef(false);
  /** Take sets already hinted at, so a turn without a new convergence is quiet. */
  const hintedTakesRef = useRef<string | null>(null);
  const stream = useStreamingBuffer(setStreamingText);
  const commands = useMemo(() => commandsForClient(client), [client]);
  const deviceConnect = useDeviceConnectPrompt();

  const isProcessing = inputState.activeTurns > 0;

  const addMessage = useCallback((msg: Omit<DisplayMessage, 'id'>) => {
    const id = `msg-${++msgIdRef.current}`;
    setMessages((prev) => [...prev, { ...msg, id }]);
  }, []);

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
    const prompt = await resolvePromptAttachments(input);
    for (const problem of prompt.errors) addMessage({ role: 'system', content: problem });
    const steering = machineRef.current.activeTurns > 0;
    addMessage({
      role: 'user',
      content: prompt.text,
      ...(prompt.attached.length > 0 ? { attachments: prompt.attached.map(describePromptAttachment) } : {}),
      ...(steering ? { steered: true } : {}),
    });
    const payload = prompt.files.length > 0 ? { text: prompt.text, files: prompt.files } : prompt.text;
    if (steering && client.steer(payload, { cwd: process.cwd() })) return;
    try {
      await client.send(payload, { cwd: process.cwd() });
    } catch (err) {
      // Transport/pre-flight failures never reach the event stream.
      addMessage({ role: 'system', content: `Error: ${err instanceof Error ? err.message : String(err)}` });
    }
  }, [addMessage, client]);

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
        skipHydrationRef.current = true;
        const previous = client;
        setClient(result.client);
        onClientChange?.(result.client);
        void previous.close().catch(() => {});
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
      addMessage({ role: 'system', content: `Error: ${err instanceof Error ? err.message : String(err)}` });
    }
  }, [addMessage, client, dispatchInput, onClientChange, setInputText]);

  const resumeSession = useCallback(async (input: string, available?: CliSessionInfo[]) => {
    const sessions = available ?? client.listSessions();
    const selected = selectSession(sessions, input);
    if (!selected) {
      addMessage({ role: 'system', content: `No matching session for "${input}". Type /resume to choose again.` });
      return;
    }
    setSessionPicker(null);
    setModelPicker(null);
    setReady(false);
    setStreamingText(null);
    setTurnPhase(null);
    await client.resumeConversation(selected.info.id);
    const history = await client.history().catch(() => []);
    setActiveSessionId(client.cliSession.id);
    setMessages([
      { id: `resume-${selected.info.id}`, role: 'system', content: `Resumed ${selected.label}` },
      ...history,
    ]);
    setReady(true);
  }, [addMessage, client]);

  const openModelPicker = useCallback(async () => {
    setModelPicker({ models: [], loading: true, error: null });
    try {
      const models = await client.listModels();
      setModelCatalog(models);
      setModelPicker({ models, loading: false, error: null });
    } catch (err) {
      setModelPicker({ models: [], loading: false, error: err instanceof Error ? err.message : String(err) });
    }
  }, [client]);

  const selectModel = useCallback(async (model: AgentModelEntry) => {
    try {
      const result = await client.setModel(model.spec);
      setModelSpec(result.spec);
      setModelPicker(null);
      addMessage({ role: 'system', content: `Model: ${result.spec}` });
    } catch (err) {
      addMessage({ role: 'system', content: `Error: ${err instanceof Error ? err.message : String(err)}` });
    }
  }, [addMessage, client]);

  /** Enter on a changelog line: revert revertables through the real paths,
   *  explain informational lines; the overlay refreshes with the new digest. */
  const revertChangelogEntry = useCallback(async (entry: ChangelogEntry) => {
    if (!entry.revert) {
      addMessage({ role: 'system', content: `"${entry.summary}" is informational (${entry.kind}) — nothing to revert.` });
      return;
    }
    setChangelogView(null);
    try {
      const result = await client.revertChangelogEntry(entry.id);
      addMessage({
        role: 'system',
        content: result.ok
          ? `Reverted: ${entry.summary}\n→ ${result.detail ?? 'done'}`
          : `Revert failed: ${result.error ?? 'unknown error'}`,
      });
      if (result.ok) setChangelogView(await client.changelog());
    } catch (err) {
      addMessage({ role: 'system', content: `Error: ${err instanceof Error ? err.message : String(err)}` });
    }
  }, [addMessage, client]);

  /** Enter on a take: record the pick (ledger + repoint); a changed answer
   *  streams its continuation as the next programmatic turn. */
  const pickTake = useCallback(async (set: AlternateTakeSet, candidate: AlternateTakeCandidate) => {
    setTakesView(null);
    try {
      const index = set.candidates.findIndex((c) => c.nodeId === candidate.nodeId) + 1;
      const result = await client.pickTake(set.id, candidate.nodeId);
      addMessage({ role: 'system', content: describeTakePick(result, index) });
    } catch (err) {
      addMessage({ role: 'system', content: `Error: ${err instanceof Error ? err.message : String(err)}` });
    }
  }, [addMessage, client]);

  const applySlashOutcome = useCallback(async (outcome: SlashOutcome) => {
    switch (outcome.kind) {
      case 'text':
        addMessage({ role: 'system', content: outcome.text });
        return;
      case 'changelog':
        setChangelogView(outcome.view);
        return;
      case 'takes':
        setTakesView(outcome.set);
        return;
      case 'model-set':
        setModelSpec(outcome.spec);
        addMessage({ role: 'system', content: `Model: ${outcome.spec}` });
        return;
      case 'status':
        setStatus(outcome.status);
        setModelSpec(outcome.status.model ?? '');
        addMessage({ role: 'system', content: STATUS_VIEW });
        return;
      case 'exit':
        onExit ? onExit() : globalExit?.();
        return;
      case 'model-picker':
        await openModelPicker();
        return;
      case 'sessions': {
        const sessions = client.listSessions();
        if (sessions.length === 0) {
          addMessage({ role: 'system', content: 'No recorded CLI sessions yet.' });
          return;
        }
        if (outcome.mode === 'resume' && outcome.resumeRef) {
          await resumeSession(outcome.resumeRef, sessions);
          return;
        }
        if (outcome.mode === 'resume') setSessionPicker({ sessions });
        addMessage({ role: 'system', content: renderSessionBrowser(outcome.mode, sessions) });
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
      case 'cancel':
        if (modelPicker) {
          setModelPicker(null);
          addMessage({ role: 'system', content: 'Model selection cancelled.' });
        } else if (changelogView) {
          setChangelogView(null);
          addMessage({ role: 'system', content: 'Changelog closed — everything kept.' });
        } else if (takesView) {
          setTakesView(null);
          addMessage({ role: 'system', content: 'Takes closed — the answered take stays.' });
        } else if (sessionPicker) {
          setSessionPicker(null);
          addMessage({ role: 'system', content: 'Resume cancelled.' });
        } else {
          addMessage({ role: 'system', content: 'Nothing to cancel.' });
        }
        return;
      case 'unknown':
        addMessage({ role: 'system', content: `Unknown command: ${outcome.command}. Type /help` });
        return;
    }
  }, [addMessage, changelogView, client, deviceConnect.open, modelPicker, onExit, openModelPicker, resumeSession, sessionPicker, takesView]);

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
          onExit ? onExit() : globalExit?.();
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
        addMessage({ role: 'system', content: `Error: ${err instanceof Error ? err.message : String(err)}` });
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
        addMessage({ role: 'system', content: `Error: ${err instanceof Error ? err.message : String(err)}` });
      }
      return;
    }
    await sendPrompt(submitted);
  }, [addMessage, applySlashOutcome, client, commands, dispatchInput, messages, performBranch, performWalkback, ready, resumeSession, runInputEffects, sendPrompt, sessionPicker]);

  const handleClientEvent = useCallback((event: AgentClientEvent) => {
    switch (event.type) {
      case 'turn-start': {
        const wasIdle = machineRef.current.activeTurns === 0;
        runInputEffects(dispatchInput({ type: 'turn-start' }));
        if (wasIdle) stream.start();
        setTurnPhase(event.kind === 'programmatic' ? 'running background work' : 'thinking');
        if (event.kind === 'programmatic') {
          addMessage({ role: 'evolution', content: `⚡ ${event.event ?? 'event'}: ${event.text.slice(0, 100)}` });
        }
        break;
      }
      case 'text-delta':
        stream.append(event.delta);
        setTurnPhase((current) => current === 'writing' ? current : 'writing');
        break;
      case 'tool-call':
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
        addMessage({ role: 'system', content: `Error: ${event.message}` });
        stream.clear();
        break;
      case 'turn-end': {
        stream.clear();
        if (event.turn.text.trim()) {
          addMessage({ role: 'assistant', content: event.turn.text.trim() });
        }
        runInputEffects(dispatchInput({ type: 'turn-settled' }));
        if (machineRef.current.activeTurns === 0) setTurnPhase(null);
        // A think run may have converged on near-tied approaches — hint once
        // per new take set so the comparison is one /takes away.
        if (event.turn.toolCalls.some((call) => call.name === 'think')) {
          void client.latestTakes().then((set) => {
            if (!set || set.candidates.length < 2 || set.chosenNodeId) return;
            if (hintedTakesRef.current === set.id) return;
            hintedTakesRef.current = set.id;
            addMessage({ role: 'system', content: `${set.candidates.length} takes — /takes to compare` });
          }).catch(() => {});
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
    }
  }, [addMessage, client, dispatchInput, runInputEffects, stream]);

  // Connect once per client: event subscription, startup resources, initial
  // hydration. Re-runs when a walk-back fork swaps in a sibling client.
  useEffect(() => {
    const unsubscribe = client.subscribe(handleClientEvent);
    let cancelled = false;
    void (async () => {
      if (hydrateHistory && !skipHydrationRef.current) {
        try {
          const history = await client.history();
          if (!cancelled && history.length > 0) {
            setMessages([welcomeMessage(client.agentName), ...history]);
          }
        } catch { /* hydration is best effort; the welcome message stands */ }
      }
      skipHydrationRef.current = false;
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
  }, [client, deviceConnect.offerIfUnconnected, handleClientEvent, hydrateHistory]);

  useEffect(() => {
    let cancelled = false;
    void client.status()
      .then((next) => {
        if (cancelled) return;
        setStatus(next);
        setModelSpec((current) => current || (next.model ?? ''));
      })
      .catch(() => {});
    void client.listModels()
      .then((models) => { if (!cancelled) setModelCatalog(models); })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [client]);

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
          resolve(outcome);
        };
        consentDecisionRef.current = settle;
        setPendingConsent(consent);
        signal.addEventListener('abort', () => settle('cancelled'), { once: true });
      }),
      note: (kind, message) => {
        addMessage({ role: 'system', content: kind === 'error' ? `Error: ${message}` : message });
      },
    });
    return () => watcher.stop();
  }, [addMessage, client, isProcessing]);

  const resolvePendingConsent = useCallback((decision: DeviceConsentDecision) => {
    consentDecisionRef.current?.(decision);
  }, []);

  useEffect(() => {
    if (!ready || initialPromptSentRef.current) return;
    const prompt = initialPrompt?.trim();
    if (!prompt) return;
    initialPromptSentRef.current = true;
    void handleSubmit(prompt);
  }, [handleSubmit, initialPrompt, ready]);

  useKeyboard((key) => {
    if (deviceConnect.handleKey(key)) return;
    if (pendingConsent) {
      if (key.name === 'o' || key.name === 'y' || key.name === 'return') {
        resolvePendingConsent('once');
        return;
      }
      if (key.name === 'a') {
        resolvePendingConsent('always');
        return;
      }
      if (key.name === 'n' || key.name === 'escape') {
        resolvePendingConsent('deny');
        return;
      }
    }
    const overlayOpen = Boolean(modelPicker || sessionPicker || changelogView || takesView || inputState.walkbackOpen);
    if (key.name === 'b' && key.ctrl) {
      if (!overlayOpen) runInputEffects(dispatchInput({ type: 'branch', draft: inputRef.current?.plainText ?? '' }));
      return;
    }
    if (key.name === 'tab') {
      if (!overlayOpen) runInputEffects(dispatchInput({ type: 'tab', draft: inputRef.current?.plainText ?? '' }));
      return;
    }
    if (key.name === 'backspace') {
      if (!overlayOpen) runInputEffects(dispatchInput({ type: 'backspace', draft: inputRef.current?.plainText ?? '' }));
      return;
    }
    if (key.name !== 'escape') return;
    if (modelPicker) {
      setModelPicker(null);
      return;
    }
    if (changelogView) {
      setChangelogView(null); // keep everything — the default
      return;
    }
    if (takesView) {
      setTakesView(null); // keep the answered take — the default
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
  const commandHints = !modelPicker && !changelogView && !takesView && !inputState.walkbackOpen && !isProcessing && !/\s/.test(draft.trimStart()) ? filterCommands(commands, draft) : [];
  const contextTokens = estimateContextTokens(messages, streamingText);
  const contextWindow = contextWindowForSpec(modelCatalog, modelSpec);
  const walkbackList = inputState.walkbackOpen ? forkCandidates(messages) : [];

  return (
    <box flexDirection="column" style={{ width: '100%', height: '100%' }}>
      <StatusBar
        name={status?.name ?? client.agentName}
        mode={client.mode}
        model={modelSpec}
        connected={ready}
        scaffoldVersion={status?.scaffoldVersion}
        toolCount={status?.toolCount}
        autoEvolve={status?.autoEvolve}
        contextTokens={contextTokens}
        contextWindow={contextWindow}
        branchCount={Object.keys(branchTasks).length}
      />

      <scrollbox
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
        {status && messages.some((msg) => msg.role === 'system' && msg.content === STATUS_VIEW)
          ? <StatusView status={status} />
          : null}
        <MessageList
          messages={messages.filter((msg) => !(msg.role === 'system' && msg.content === STATUS_VIEW))}
          streamingText={streamingText}
        />
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
        title={isProcessing ? '⟳ processing… · Enter steers · Tab queues · Ctrl+B branches · Esc interrupts' : modelPicker ? 'Model picker' : changelogView ? 'Changelog ›' : takesView ? 'Takes ›' : inputState.walkbackOpen ? 'Walk back ›' : sessionPicker ? 'Resume ›' : `${client.agentName} · ${activeSessionId.slice(0, 18)} ›`}
      >
        <textarea
          ref={(value) => { inputRef.current = value; }}
          focused={ready && !modelPicker && !changelogView && !takesView && !deviceConnect.state && !inputState.walkbackOpen}
          placeholder={!ready ? 'Connecting…' : isProcessing ? 'Type to steer the running turn… (Tab queues · Ctrl+B branches)' : modelPicker ? 'Select a model or Esc' : changelogView ? 'Enter reverts the selected line · Esc keeps everything' : takesView ? 'Enter uses the selected take · Esc keeps the answer' : inputState.walkbackOpen ? 'Pick a message to walk back to, or Esc' : sessionPicker ? 'Type session number/id or /cancel' : 'Type a message or /help · Shift+Enter for a new line'}
          wrapMode="word"
          keyBindings={[
            { name: 'return', action: 'submit' },
            { name: 'return', shift: true, action: 'newline' },
            { name: 'return', meta: true, action: 'newline' },
            { name: 'j', ctrl: true, action: 'newline' },
          ]}
          onContentChange={() => setDraft(inputRef.current?.plainText ?? '')}
          onSubmit={onInputSubmit}
        />
      </box>

      {modelPicker ? (
        <ModelPickerOverlay
          models={modelPicker.models}
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
  );
}

function welcomeMessage(agentName: string): DisplayMessage {
  return { id: 'welcome', role: 'system', content: `Connected to ${agentName}. Type a message or /help for commands.` };
}

export async function runTuiChat(opts: ChatAppOpts): Promise<void> {
  requireInteractiveTerminal();
  const renderer = await createCliRenderer({ exitOnCtrlC: false });
  const root = createRoot(renderer);
  let currentClient = opts.client;

  const cleanup = async () => {
    try { await currentClient.close(); } catch { /* best effort */ }
    root.render(<box />);
    renderer.destroy();
    console.log('\n  Goodbye.\n');
    process.exit(0);
  };

  globalExit = () => { void cleanup(); };
  process.on('SIGINT', () => { void cleanup(); });

  root.render(<ChatApp {...opts} onClientChange={(client) => { currentClient = client; }} />);

  // Keep the process alive
  await new Promise<void>(() => {});
}

/**
 * TUI Chat Application — the single OpenTUI React chat surface for both
 * backends, parameterized by an AgentClient (LocalAgentClient over
 * LocalAgentSession, CloudAgentClient over the OrchestratorAgent DO). The
 * client owns transport, recording, and history; this renders its
 * AgentClientEvent stream into scrollable message history with streaming text,
 * tool cards, evolution markers, a status bar, model/session pickers, and the
 * device-consent overlay. Esc interrupts an in-flight turn via client.stop().
 */

import { createCliRenderer, type TextareaRenderable } from '@opentui/core';
import { createRoot, useKeyboard, useTerminalDimensions } from '@opentui/react';
import { useState, useCallback, useRef, useEffect, useMemo } from 'react';

import type {
  AgentClient,
  AgentClientEvent,
  AgentClientStatus,
  DeviceConsentDecision,
  PendingDeviceConsent,
} from '../agent-client.js';
import {
  commandsForClient,
  executeSlashCommand,
  filterCommands,
  resolveCommandDraft,
  type SlashOutcome,
} from '../slash-commands.js';
import { contextWindowForSpec, type AgentModelEntry } from '../model-catalog.js';
import type { CliSessionInfo } from '../session.js';
import { StatusBar } from './status-bar.js';
import { MessageList, type DisplayMessage } from './messages.js';
import { StatusView } from './help-view.js';
import { CommandHintOverlay, DeviceConsentOverlay, ModelPickerOverlay, PhaseLine } from './overlays.js';
import { estimateContextTokens } from './context-status.js';
import { useStreamingBuffer } from './streaming-buffer.js';
import { renderSessionBrowser, selectSession } from './session-browser.js';
import { tuiColors } from './theme.js';

export interface ChatAppOpts {
  client: AgentClient;
  /** Seed the message list from client.history() before accepting input. */
  hydrateHistory?: boolean;
  initialPrompt?: string;
  onExit?: () => void;
}

const STATUS_VIEW = 'STATUS_VIEW';

let globalExit: (() => void) | null = null;

export function ChatApp({ client, hydrateHistory, initialPrompt, onExit }: ChatAppOpts) {
  const { width, height } = useTerminalDimensions();
  const [messages, setMessages] = useState<DisplayMessage[]>(() => [welcomeMessage(client.agentName)]);
  const [streamingText, setStreamingText] = useState<string | null>(null);
  const [isProcessing, setIsProcessing] = useState(false);
  const [turnPhase, setTurnPhase] = useState<string | null>(null);
  const [ready, setReady] = useState(false);
  const [status, setStatus] = useState<AgentClientStatus | null>(null);
  const [modelSpec, setModelSpec] = useState<string>('');
  const [modelCatalog, setModelCatalog] = useState<AgentModelEntry[]>([]);
  const [sessionPicker, setSessionPicker] = useState<{ sessions: CliSessionInfo[] } | null>(null);
  const [modelPicker, setModelPicker] = useState<{ models: AgentModelEntry[]; loading: boolean; error: string | null } | null>(null);
  const [pendingConsent, setPendingConsent] = useState<PendingDeviceConsent | null>(null);
  const [draft, setDraft] = useState('');
  const [activeSessionId, setActiveSessionId] = useState(client.cliSession.id);

  const msgIdRef = useRef(0);
  const inputRef = useRef<TextareaRenderable | null>(null);
  const initialPromptSentRef = useRef(false);
  const stream = useStreamingBuffer(setStreamingText);
  const commands = useMemo(() => commandsForClient(client), [client]);

  const addMessage = useCallback((msg: Omit<DisplayMessage, 'id'>) => {
    const id = `msg-${++msgIdRef.current}`;
    setMessages((prev) => [...prev, { ...msg, id }]);
  }, []);

  const handleClientEvent = useCallback((event: AgentClientEvent) => {
    switch (event.type) {
      case 'turn-start':
        stream.start();
        setIsProcessing(true);
        setTurnPhase(event.kind === 'programmatic' ? 'running background work' : 'thinking');
        if (event.kind === 'programmatic') {
          addMessage({ role: 'evolution', content: `⚡ ${event.event ?? 'event'}: ${event.text.slice(0, 100)}` });
        }
        break;
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
        addMessage({ role: 'system', content: `Error: ${event.message}` });
        stream.clear();
        setIsProcessing(false);
        setTurnPhase(null);
        break;
      case 'turn-end':
        stream.clear();
        setIsProcessing(false);
        setTurnPhase(null);
        if (event.turn.text.trim()) {
          addMessage({ role: 'assistant', content: event.turn.text.trim() });
        }
        break;
      case 'broadcast':
        break;
    }
  }, [addMessage, stream]);

  // Connect once: event subscription, startup resources, initial hydration.
  useEffect(() => {
    const unsubscribe = client.subscribe(handleClientEvent);
    let cancelled = false;
    void (async () => {
      if (hydrateHistory) {
        try {
          const history = await client.history();
          if (!cancelled && history.length > 0) {
            setMessages([welcomeMessage(client.agentName), ...history]);
          }
        } catch { /* hydration is best effort; the welcome message stands */ }
      }
      await client.connect();
      if (!cancelled) setReady(true);
    })();
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [client, handleClientEvent, hydrateHistory]);

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

  // Poll pending device consents while a turn is processing (cloud agents).
  useEffect(() => {
    const consents = client.consents;
    if (!consents || !isProcessing) {
      setPendingConsent(null);
      return;
    }
    let cancelled = false;
    const refresh = async () => {
      try {
        const pending = await consents.listPending();
        if (!cancelled) setPendingConsent(pending[0] ?? null);
      } catch {
        if (!cancelled) setPendingConsent(null);
      }
    };
    void refresh();
    const interval = setInterval(refresh, 750);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [client, isProcessing]);

  const resolvePendingConsent = useCallback((decision: DeviceConsentDecision) => {
    const consent = pendingConsent;
    const consents = client.consents;
    if (!consent || !consents) return;
    setPendingConsent(null);
    void consents.resolve(consent.consentId, decision)
      .then((result) => {
        if (!result.ok) addMessage({ role: 'system', content: 'That PC access request is no longer pending.' });
      })
      .catch((err) => {
        addMessage({ role: 'system', content: `Error: ${err instanceof Error ? err.message : String(err)}` });
      });
  }, [addMessage, client, pendingConsent]);

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
    setIsProcessing(false);
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

  const applySlashOutcome = useCallback(async (outcome: SlashOutcome) => {
    switch (outcome.kind) {
      case 'text':
        addMessage({ role: 'system', content: outcome.text });
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
      case 'cancel':
        if (modelPicker) {
          setModelPicker(null);
          addMessage({ role: 'system', content: 'Model selection cancelled.' });
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
  }, [addMessage, client, modelPicker, onExit, openModelPicker, resumeSession, sessionPicker]);

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
        await applySlashOutcome(await executeSlashCommand(client, submitted));
      } catch (err) {
        addMessage({ role: 'system', content: `Error: ${err instanceof Error ? err.message : String(err)}` });
      }
      return;
    }
    addMessage({ role: 'user', content: submitted });
    // Errors surface as client error events.
    try { await client.send(submitted, { cwd: process.cwd() }); } catch { /* rendered via events */ }
  }, [addMessage, applySlashOutcome, client, commands, ready, resumeSession, sessionPicker]);

  useEffect(() => {
    if (!ready || initialPromptSentRef.current) return;
    const prompt = initialPrompt?.trim();
    if (!prompt) return;
    initialPromptSentRef.current = true;
    void handleSubmit(prompt);
  }, [handleSubmit, initialPrompt, ready]);

  useKeyboard((key) => {
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
    if (key.name !== 'escape') return;
    if (modelPicker) {
      setModelPicker(null);
      return;
    }
    if (isProcessing) {
      client.stop();
      addMessage({ role: 'system', content: 'Interrupting the active turn…' });
      return;
    }
    globalExit?.();
  });

  const onInputSubmit = useCallback(() => {
    const value = inputRef.current?.plainText ?? '';
    if (!value.trim()) return;
    inputRef.current?.setText('');
    setDraft('');
    void handleSubmit(value);
  }, [handleSubmit]);

  const draftLines = Math.min(6, Math.max(1, draft.split('\n').length));
  const commandHints = !modelPicker && !isProcessing && !/\s/.test(draft.trimStart()) ? filterCommands(commands, draft) : [];
  const contextTokens = estimateContextTokens(messages, streamingText);
  const contextWindow = contextWindowForSpec(modelCatalog, modelSpec);

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

      <box
        style={{
          height: draftLines + 2,
          border: true,
          borderStyle: 'single',
          borderColor: isProcessing ? tuiColors.borderMuted : tuiColors.border,
          backgroundColor: tuiColors.panelStrong,
          paddingLeft: 1,
        }}
        title={isProcessing ? '⟳ processing… (Esc interrupts)' : modelPicker ? 'Model picker' : sessionPicker ? 'Resume ›' : `${client.agentName} · ${activeSessionId.slice(0, 18)} ›`}
      >
        <textarea
          ref={(value) => { inputRef.current = value; }}
          focused={ready && !isProcessing && !modelPicker}
          placeholder={!ready ? 'Connecting…' : isProcessing ? 'Waiting for response… (Esc interrupts)' : modelPicker ? 'Select a model or Esc' : sessionPicker ? 'Type session number/id or /cancel' : 'Type a message or /help · Shift+Enter for a new line'}
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
      ) : (
        <CommandHintOverlay commands={commandHints} terminal={{ width, height }} />
      )}
      {pendingConsent && <DeviceConsentOverlay consent={pendingConsent} terminal={{ width, height }} />}
    </box>
  );
}

function welcomeMessage(agentName: string): DisplayMessage {
  return { id: 'welcome', role: 'system', content: `Connected to ${agentName}. Type a message or /help for commands.` };
}

export async function runTuiChat(opts: ChatAppOpts): Promise<void> {
  const renderer = await createCliRenderer({ exitOnCtrlC: false });
  const root = createRoot(renderer);

  const cleanup = async () => {
    try { await opts.client.close(); } catch { /* best effort */ }
    root.render(<box />);
    renderer.destroy();
    console.log('\n  Goodbye.\n');
    process.exit(0);
  };

  globalExit = () => { void cleanup(); };
  process.on('SIGINT', () => { void cleanup(); });

  root.render(<ChatApp {...opts} />);

  // Keep the process alive
  await new Promise<void>(() => {});
}

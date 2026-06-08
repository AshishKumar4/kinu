/**
 * TUI Chat Application — OpenTUI React terminal UI over LocalAgentSession.
 *
 * The session (in @proteus/cli-backend) owns the whole agent loop; this renders
 * its SessionEvent stream into scrollable message history with streaming text,
 * tool cards, evolution/background-event markers, and a status bar. Slash
 * commands (/help, /status, /tools, /memory, /tree, /exit) operate on the
 * runtime directly.
 */

import { createCliRenderer, type InputRenderable } from '@opentui/core';
import { createRoot, useKeyboard, useTerminalDimensions } from '@opentui/react';
import { useState, useCallback, useRef, useEffect } from 'react';
import type { AgentRuntime, AgentInfo, LLMProviderConfig, SearchNode } from '@proteus/core';
import { LocalAgentSession, resolveChatModel, type LocalModelResolver, type LocalSessionDb, type SessionEvent, type McpServerConfig } from '@proteus/cli-backend';

import { StatusBar } from './status-bar.js';
import { MessageList, type DisplayMessage } from './messages.js';
import { StatusView } from './help-view.js';
import { commandHelp, filterCommands, resolveCommandDraft } from './commands.js';
import { normalizeModelEntries, type TuiModelEntry } from './model-types.js';
import { CommandHintOverlay, ModelPickerOverlay, PhaseLine } from './overlays.js';
import {
  createCliSession,
  defaultConversationIdForCliOptions,
  defaultAgentSessionId,
  listCliSessions,
  readCliSessionTranscript,
  type CliSession,
  type CliSessionInfo,
  type CliSessionOptions,
} from '../session.js';
import { recordCliSessionEvent } from '../session-recorder.js';
import { renderSessionBrowser, selectSession, transcriptToMessages } from './session-browser.js';

export interface ChatAppOpts {
  rt: AgentRuntime;
  db: LocalSessionDb;
  info: AgentInfo;
  dbSize: number;
  llmConfig: LLMProviderConfig;
  modelResolver?: LocalModelResolver;
  refreshInfo: () => AgentInfo;
  noAutoEvolve?: boolean;
  mcpServers?: Record<string, McpServerConfig>;
  initialPrompt?: string;
  cliSession?: CliSession;
  localSessionId?: string;
  sessionOptions?: Pick<CliSessionOptions, 'sessionDir'>;
  hydrateTranscript?: boolean;
  onExit?: () => void;
  close?: () => void;
}

let globalExit: (() => void) | null = null;
let globalSessionCleanup: (() => Promise<void>) | null = null;

export function ChatApp({ rt, db, info: initialInfo, dbSize, llmConfig, modelResolver, refreshInfo, noAutoEvolve, mcpServers, initialPrompt, cliSession, localSessionId, sessionOptions, hydrateTranscript, onExit }: ChatAppOpts) {
  const { height } = useTerminalDimensions();
  const [messages, setMessages] = useState<DisplayMessage[]>(() => initialMessages(initialInfo.name, cliSession, sessionOptions, hydrateTranscript));
  const [streamingText, setStreamingText] = useState<string | null>(null);
  const [isProcessing, setIsProcessing] = useState(false);
  const [turnPhase, setTurnPhase] = useState<string | null>(null);
  const [mcpReady, setMcpReady] = useState(!mcpServers || Object.keys(mcpServers).length === 0);
  const [info, setInfo] = useState(initialInfo);
  const [modelSpec, setModelSpec] = useState(llmConfig.model);
  const [sessionPicker, setSessionPicker] = useState<{ sessions: CliSessionInfo[] } | null>(null);
  const [modelPicker, setModelPicker] = useState<{ models: TuiModelEntry[]; loading: boolean; error: string | null } | null>(null);
  const [draft, setDraft] = useState('');
  const [activeSessionId, setActiveSessionId] = useState(cliSession?.id ?? localSessionId ?? defaultAgentSessionId());

  const msgIdRef = useRef(0);
  const streamRef = useRef('');
  const inputRef = useRef<InputRenderable | null>(null);
  const initialPromptSentRef = useRef(false);
  const activeCliSessionRef = useRef<CliSession | undefined>(cliSession);

  const addMessage = useCallback((msg: Omit<DisplayMessage, 'id'>) => {
    const id = `msg-${++msgIdRef.current}`;
    setMessages((prev) => [...prev, { ...msg, id }]);
  }, []);

  const createAgentSession = useCallback((sessionId: string) => new LocalAgentSession({
    rt,
    db,
    model: resolveChatModel(llmConfig),
    modelResolver,
    noAutoEvolve,
    sessionId,
    persistMessages: true,
    onEvent: (event: SessionEvent) => {
      recordCliSessionEvent(activeCliSessionRef.current, event, 'local');
      switch (event.type) {
        case 'turn-start':
          streamRef.current = '';
          setStreamingText('');
          setIsProcessing(true);
          setTurnPhase(event.kind === 'programmatic' ? 'running background work' : 'thinking');
          if (event.kind === 'programmatic') {
            addMessage({ role: 'evolution', content: `⚡ ${event.event ?? 'event'}: ${event.text.slice(0, 100)}` });
          }
          break;
        case 'text-delta':
          streamRef.current += event.delta;
          setStreamingText(streamRef.current);
          setTurnPhase('writing');
          break;
        case 'tool-call':
          setTurnPhase(`calling ${event.toolName}`);
          addMessage({ role: 'tool_call', content: '', toolName: event.toolName, args: JSON.stringify(event.args) });
          break;
        case 'tool-result':
          setTurnPhase(`finished ${event.toolName}`);
          addMessage({ role: 'tool_result', content: event.result });
          break;
        case 'evolution':
          addMessage({ role: 'evolution', content: `[${event.event}] ${event.message}` });
          break;
        case 'error':
          addMessage({ role: 'system', content: `Error: ${event.message}` });
          setTurnPhase(null);
          break;
        case 'turn-end':
          setStreamingText(null);
          setIsProcessing(false);
          setTurnPhase(null);
          if (event.turn.assistantResponse.trim()) {
            addMessage({ role: 'assistant', content: event.turn.assistantResponse.trim() });
          }
          break;
        case 'broadcast':
          break;
      }
    },
  }), [addMessage, db, llmConfig, modelResolver, noAutoEvolve, rt]);

  const sessionRef = useRef<LocalAgentSession | null>(null);
  if (!sessionRef.current) {
    sessionRef.current = createAgentSession(localSessionId ?? cliSession?.conversationId ?? defaultAgentSessionId());
  }
  const session = sessionRef.current;

  const resumeSession = useCallback(async (input: string, available?: CliSessionInfo[]) => {
    const sessions = available ?? listCliSessions(initialInfo.name, sessionOptions);
    const selected = selectSession(sessions, input);
    if (!selected) {
      addMessage({ role: 'system', content: `No matching session for "${input}". Type /resume to choose again.` });
      return;
    }

    const transcript = readCliSessionTranscript(initialInfo.name, selected.info.id, sessionOptions);
    const nextCliSession = createCliSession(initialInfo.name, { ...sessionOptions, session: selected.info.id });
    await sessionRef.current?.end().catch(() => {});
    const nextAgentSession = createAgentSession(nextCliSession.conversationId);
    sessionRef.current = nextAgentSession;
    activeCliSessionRef.current = nextCliSession;
    setActiveSessionId(nextCliSession.id);
    setSessionPicker(null);
    setModelPicker(null);
    setStreamingText(null);
    setIsProcessing(false);
    setTurnPhase(null);
    setMessages(transcriptToMessages(transcript));
    if (mcpServers && Object.keys(mcpServers).length > 0) {
      setMcpReady(false);
      await nextAgentSession.connectMcp(mcpServers);
      setMcpReady(true);
    }
    await nextAgentSession.recoverBackgroundJobs();
  }, [addMessage, createAgentSession, initialInfo.name, mcpServers, sessionOptions]);

  const openModelPicker = useCallback(async () => {
    setModelPicker({ models: [], loading: true, error: null });
    try {
      const models = normalizeModelEntries(await (sessionRef.current ?? session).listAvailableModels());
      setModelPicker({ models, loading: false, error: null });
    } catch (err) {
      setModelPicker({
        models: [],
        loading: false,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }, [session]);

  const selectModel = useCallback((model: TuiModelEntry) => {
    try {
      const result = (sessionRef.current ?? session).setModel(model.spec);
      setModelSpec(result.spec);
      setModelPicker(null);
      addMessage({ role: 'system', content: `Model: ${result.spec}` });
    } catch (err) {
      addMessage({ role: 'system', content: `Error: ${err instanceof Error ? err.message : String(err)}` });
    }
  }, [addMessage, session]);

  const handleSlash = useCallback(async (input: string) => {
    const [rawCmd, ...rest] = input.split(/\s+/);
    const cmd = rawCmd!.toLowerCase();
    const arg = rest.join(' ').trim();
    const currentSession = sessionRef.current ?? session;
    switch (cmd) {
      case '/exit':
      case '/quit':
        onExit ? onExit() : globalExit?.();
        return;
      case '/cancel':
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
      case '/help':
        addMessage({ role: 'system', content: commandHelp('local') });
        return;
      case '/status': {
        setInfo(refreshInfo());
        addMessage({ role: 'system', content: 'STATUS_VIEW' });
        return;
      }
      case '/tools': {
        const builtIn = currentSession.describeTools().map(({ name, description }) => `  ${name} — ${description}`);
        const crafted = rt.craftStore.list().map((t) => `  ${t.name} — ${t.description.slice(0, 50)}`);
        const lines = ['Built-in:', ...builtIn];
        if (crafted.length > 0) lines.push('', 'Crafted:', ...crafted);
        addMessage({ role: 'system', content: lines.join('\n') });
        return;
      }
      case '/memory': {
        const content = await rt.memory.read('memory/MEMORY.md');
        addMessage({ role: 'system', content: content ? `Memory:\n${content.slice(0, 1500)}` : 'Memory is empty.' });
        return;
      }
      case '/always': {
        const args = input.split(/\s+/).slice(1);
        if (args.length === 0) {
          const cur = currentSession.getAlwaysActiveSkills();
          addMessage({ role: 'system', content: cur.length ? `Always-active skills: ${cur.join(', ')}` : 'No always-active skills set. Usage: /always <name>… (or "none" to clear).' });
        } else {
          const names = args[0] === 'none' ? [] : args;
          currentSession.setAlwaysActiveSkills(names);
          addMessage({ role: 'system', content: names.length ? `Always-active skills: ${names.join(', ')}` : 'Cleared always-active skills.' });
        }
        return;
      }
      case '/approval': {
        const mode = input.slice(cmd.length).trim();
        if (!mode) {
          addMessage({ role: 'system', content: `Shell approval: ${currentSession.getShellApprovalMode().mode}` });
          return;
        }
        if (mode !== 'strict' && mode !== 'allow_all' && mode !== 'deny_all') {
          addMessage({ role: 'system', content: 'Usage: /approval strict | allow_all | deny_all' });
          return;
        }
        const result = currentSession.setShellApprovalMode(mode);
        addMessage({ role: 'system', content: `Shell approval: ${result.mode}` });
        return;
      }
      case '/model': {
        const spec = input.slice(cmd.length).trim();
        if (!spec) {
          await openModelPicker();
          return;
        }
        try {
          const result = currentSession.setModel(spec);
          setModelSpec(result.spec);
          addMessage({ role: 'system', content: `Model: ${result.spec}` });
        } catch (err) {
          addMessage({ role: 'system', content: `Error: ${(err as Error).message}` });
        }
        return;
      }
      case '/models': {
        const providers = await currentSession.listModelProviders();
        if (providers.length === 0) {
          addMessage({ role: 'system', content: 'No local provider registry is configured for this session.' });
          return;
        }
        const lines = ['Providers:'];
        for (const p of providers) lines.push(`  ${p.id} — ${p.available ? 'available' : p.unavailableReason ?? 'unavailable'}`);
        const models = await currentSession.listAvailableModels();
        if (models.length > 0) {
          lines.push('', 'Models:');
          for (const m of models.slice(0, 40)) lines.push(`  ${m.provider}/${m.id} — ${m.label ?? m.id}`);
          if (models.length > 40) lines.push(`  ... ${models.length - 40} more`);
        }
        addMessage({ role: 'system', content: lines.join('\n') });
        return;
      }
      case '/sessions':
      case '/resume': {
        const sessions = listCliSessions(initialInfo.name, sessionOptions);
        if (sessions.length === 0) {
          addMessage({ role: 'system', content: 'No recorded CLI sessions yet.' });
          return;
        }
        if (cmd === '/resume' && arg) {
          await resumeSession(arg, sessions);
          return;
        }
        if (cmd === '/resume') setSessionPicker({ sessions });
        addMessage({ role: 'system', content: renderSessionBrowser(cmd === '/resume' ? 'resume' : 'list', sessions) });
        return;
      }
      case '/stop': {
        currentSession.interrupt();
        addMessage({ role: 'system', content: 'Stop requested for the active local turn.' });
        return;
      }
      case '/jobs': {
        const jobs = await currentSession.listBackgroundJobs(20);
        addMessage({
          role: 'system',
          content: jobs.length
            ? jobs.map((job) => `${job.id}  ${job.kind}  ${job.status}`).join('\n')
            : 'No background jobs.',
        });
        return;
      }
      case '/tree': {
        const nodes = rt.storage.sql<SearchNode>`SELECT * FROM search_nodes ORDER BY depth, created_at`;
        if (nodes.length === 0) {
          addMessage({ role: 'system', content: 'No MCTS nodes yet. Use /evolve or ask complex questions.' });
        } else {
          const lines = nodes.map((n) => {
            const prefix = '  '.repeat(n.depth) + (n.status === 'pruned' ? '◌' : n.status === 'terminal' ? '★' : '○');
            return `${prefix} ${n.value.toFixed(3)} n=${n.visits} ${n.action?.slice(0, 40) ?? ''}`;
          });
          addMessage({ role: 'system', content: `MCTS Tree (${nodes.length} nodes):\n${lines.join('\n')}` });
        }
        return;
      }
      default:
        addMessage({ role: 'system', content: `Unknown command: ${cmd}. Type /help` });
    }
  }, [addMessage, initialInfo.name, modelPicker, openModelPicker, refreshInfo, resumeSession, rt, session, sessionOptions, sessionPicker]);

  const handleSubmit = useCallback(async (input: string) => {
    const text = input.trim();
    if (!text) return;
    if (!mcpReady) {
      addMessage({ role: 'system', content: 'MCP tools are still connecting.' });
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
    const submitted = text.startsWith('/') ? resolveCommandDraft('local', text) : text;
    if (submitted.startsWith('/')) {
      try {
        await handleSlash(submitted);
      } catch (err) {
        addMessage({ role: 'system', content: `Error: ${err instanceof Error ? err.message : String(err)}` });
      }
      return;
    }
    addMessage({ role: 'user', content: submitted });
    activeCliSessionRef.current?.append('user', { text: submitted, cwd: process.cwd(), backend: 'local' });
    try { await sessionRef.current?.send(submitted); } catch { /* errors surface as SessionEvents */ }
  }, [addMessage, handleSlash, mcpReady, resumeSession, sessionPicker]);

  // opentui's `input` intrinsic merges with React DOM's, so onSubmit's type is
  // the intersection of (value: string) and (event: SubmitEvent). opentui passes
  // the value string at runtime; accept the union and forward the string.
  const onInputSubmit = useCallback((value: string | object) => {
    if (typeof value === 'string') {
      setDraft('');
      if (inputRef.current) inputRef.current.value = '';
      void handleSubmit(value);
    }
  }, [handleSubmit]);

  // Fire a partial-session evolution flush on exit; connect MCP + recover once.
  useEffect(() => {
    let cancelled = false;
    globalSessionCleanup = async () => { await sessionRef.current?.end(); };
    void (async () => {
      if (mcpServers && Object.keys(mcpServers).length > 0) await session.connectMcp(mcpServers);
      if (!cancelled) setMcpReady(true);
      await session.recoverBackgroundJobs();
    })();
    return () => { cancelled = true; globalSessionCleanup = null; };
  }, [session, mcpServers]);

  useEffect(() => {
    if (!mcpReady || initialPromptSentRef.current) return;
    const prompt = initialPrompt?.trim();
    if (!prompt) return;
    initialPromptSentRef.current = true;
    void handleSubmit(prompt);
  }, [handleSubmit, initialPrompt, mcpReady]);

  useKeyboard((key) => {
    if (key.name === 'escape' && modelPicker) {
      setModelPicker(null);
      return;
    }
    if (key.name === 'escape') globalExit?.();
  });

  const scrollHeight = Math.max(1, height - 7);
  const commandHints = !modelPicker && !isProcessing && !/\s/.test(draft.trimStart()) ? filterCommands('local', draft) : [];

  return (
    <box flexDirection="column" style={{ height: '100%' }}>
      <StatusBar
        info={info}
        model={modelSpec}
        toolCount={session.toolNames().length}
        autoEvolve={!noAutoEvolve}
        connected={true}
      />

      <scrollbox
        focused={!isProcessing}
        style={{
          flexGrow: 1,
          height: scrollHeight,
          rootOptions: { backgroundColor: '#0f0f23' },
          viewportOptions: { backgroundColor: '#0f0f23' },
          contentOptions: { backgroundColor: '#0f0f23' },
          scrollbarOptions: {
            trackOptions: { foregroundColor: '#4a4a6a', backgroundColor: '#1a1a2e' },
          },
        }}
      >
        {messages.map((msg) => {
          if (msg.role === 'system' && msg.content === 'STATUS_VIEW') return <StatusView key={msg.id} info={info} dbSize={dbSize} toolCount={session.toolNames().length} />;
          return null;
        })}
        <MessageList
          messages={messages.filter((m) => !(m.role === 'system' && m.content === 'STATUS_VIEW'))}
          streamingText={streamingText}
        />
        <PhaseLine label={isProcessing ? (turnPhase ?? 'thinking') : null} />
      </scrollbox>

      {modelPicker ? (
        <ModelPickerOverlay
          models={modelPicker.models}
          currentSpec={modelSpec}
          loading={modelPicker.loading}
          error={modelPicker.error}
          onSelect={selectModel}
        />
      ) : (
        <CommandHintOverlay commands={commandHints} />
      )}

      <box
        style={{
          height: 3,
          border: true,
          borderStyle: 'single',
          borderColor: isProcessing ? '#4a4a6a' : '#3b3b5c',
          backgroundColor: '#1a1a2e',
          paddingLeft: 1,
        }}
        title={isProcessing ? '⟳ processing…' : modelPicker ? 'Model picker open' : sessionPicker ? 'Resume ›' : `${info.name} · ${activeSessionId.slice(0, 18)} ›`}
      >
        <input
          ref={(value) => { inputRef.current = value; }}
          focused={mcpReady && !isProcessing && !modelPicker}
          value={draft}
          placeholder={!mcpReady ? 'Connecting MCP…' : isProcessing ? 'Waiting for response…' : modelPicker ? 'Select a model above or Esc' : sessionPicker ? 'Type session number/id or /cancel' : 'Type a message or /help'}
          onInput={setDraft}
          onSubmit={onInputSubmit}
        />
      </box>
    </box>
  );
}

function initialMessages(
  agentName: string,
  cliSession: CliSession | undefined,
  sessionOptions: Pick<CliSessionOptions, 'sessionDir'> | undefined,
  hydrateTranscript: boolean | undefined,
): DisplayMessage[] {
  if (hydrateTranscript && cliSession?.id) {
    try {
      return transcriptToMessages(readCliSessionTranscript(agentName, cliSession.id, sessionOptions));
    } catch (err) {
      return [{
        id: 'welcome',
        role: 'system',
        content: `Connected to ${agentName}. Could not load the requested transcript: ${err instanceof Error ? err.message : String(err)}`,
      }];
    }
  }
  return [{ id: 'welcome', role: 'system', content: `Connected to ${agentName}. Type a message or /help for commands.` }];
}

export async function runTuiChat(opts: ChatAppOpts): Promise<void> {
  const renderer = await createCliRenderer({ exitOnCtrlC: false });
  const root = createRoot(renderer);

  const cleanup = async () => {
    try { await globalSessionCleanup?.(); } catch { /* best effort */ }
    try { opts.close?.(); } catch { /* best effort */ }
    root.render(<box />);
    renderer.destroy();
    console.log('\n  Goodbye.\n');
    process.exit(0);
  };

  globalExit = cleanup;
  process.on('SIGINT', cleanup);

  root.render(<ChatApp {...opts} />);

  // Keep the process alive
  await new Promise<void>(() => {});
}

export function createDefaultTuiSession(agentName: string, opts: CliSessionOptions = {}): {
  cliSession: CliSession;
  localSessionId: string;
} {
  const cliSession = createCliSession(agentName, {
    ...opts,
    conversationId: opts.conversationId ?? defaultConversationIdForCliOptions(opts),
  });
  return {
    cliSession,
    localSessionId: cliSession.conversationId,
  };
}

/**
 * TUI Chat Application — OpenTUI React terminal UI over LocalAgentSession.
 *
 * The session (in @proteus/cli-backend) owns the whole agent loop; this renders
 * its SessionEvent stream into scrollable message history with streaming text,
 * tool cards, evolution/background-event markers, and a status bar. Slash
 * commands (/help, /status, /tools, /memory, /tree, /exit) operate on the
 * runtime directly.
 */

import { createCliRenderer } from '@opentui/core';
import { createRoot, useKeyboard, useTerminalDimensions } from '@opentui/react';
import { useState, useCallback, useRef, useEffect } from 'react';
import type { AgentRuntime, AgentInfo, LLMProviderConfig, SearchNode } from '@proteus/core';
import { LocalAgentSession, resolveChatModel, type LocalModelResolver, type LocalSessionDb, type SessionEvent, type McpServerConfig } from '@proteus/cli-backend';

import { StatusBar } from './status-bar.js';
import { MessageList, type DisplayMessage } from './messages.js';
import { HelpView, StatusView } from './help-view.js';
import { createCliSession, defaultAgentSessionId, listCliSessions, type CliSession, type CliSessionOptions } from '../session.js';

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
  onExit?: () => void;
  close?: () => void;
}

let globalExit: (() => void) | null = null;
let globalSessionCleanup: (() => Promise<void>) | null = null;

export function ChatApp({ rt, db, info: initialInfo, dbSize, llmConfig, modelResolver, refreshInfo, noAutoEvolve, mcpServers, initialPrompt, cliSession, localSessionId, onExit }: ChatAppOpts) {
  const { height } = useTerminalDimensions();
  const [messages, setMessages] = useState<DisplayMessage[]>([
    { id: 'welcome', role: 'system', content: `Connected to ${initialInfo.name}. Type a message or /help for commands.` },
  ]);
  const [streamingText, setStreamingText] = useState<string | null>(null);
  const [isProcessing, setIsProcessing] = useState(false);
  const [mcpReady, setMcpReady] = useState(!mcpServers || Object.keys(mcpServers).length === 0);
  const [info, setInfo] = useState(initialInfo);
  const [modelSpec, setModelSpec] = useState(llmConfig.model);

  const msgIdRef = useRef(0);
  const streamRef = useRef('');
  const initialPromptSentRef = useRef(false);

  const addMessage = useCallback((msg: Omit<DisplayMessage, 'id'>) => {
    const id = `msg-${++msgIdRef.current}`;
    setMessages((prev) => [...prev, { ...msg, id }]);
  }, []);

  // The agent loop — built once. Its SessionEvent stream drives React state.
  const sessionRef = useRef<LocalAgentSession | null>(null);
  if (!sessionRef.current) {
    sessionRef.current = new LocalAgentSession({
      rt,
      db,
      model: resolveChatModel(llmConfig),
      modelResolver,
      noAutoEvolve,
      sessionId: localSessionId ?? defaultAgentSessionId(),
      persistMessages: true,
      onEvent: (event: SessionEvent) => {
        recordSessionEvent(cliSession, event);
        switch (event.type) {
          case 'turn-start':
            streamRef.current = '';
            setStreamingText('');
            setIsProcessing(true);
            if (event.kind === 'programmatic') {
              addMessage({ role: 'evolution', content: `⚡ ${event.event ?? 'event'}: ${event.text.slice(0, 100)}` });
            }
            break;
          case 'text-delta':
            streamRef.current += event.delta;
            setStreamingText(streamRef.current);
            break;
          case 'tool-call':
            addMessage({ role: 'tool_call', content: '', toolName: event.toolName, args: JSON.stringify(event.args) });
            break;
          case 'tool-result':
            addMessage({ role: 'tool_result', content: event.result });
            break;
          case 'evolution':
            addMessage({ role: 'evolution', content: `[${event.event}] ${event.message}` });
            break;
          case 'error':
            addMessage({ role: 'system', content: `Error: ${event.message}` });
            break;
          case 'turn-end':
            setStreamingText(null);
            setIsProcessing(false);
            if (event.turn.assistantResponse.trim()) {
              addMessage({ role: 'assistant', content: event.turn.assistantResponse.trim() });
            }
            break;
          case 'broadcast':
            break;
        }
      },
    });
  }
  const session = sessionRef.current;

  const handleSlash = useCallback(async (input: string) => {
    const cmd = input.split(/\s+/)[0]!.toLowerCase();
    switch (cmd) {
      case '/exit':
      case '/quit':
        onExit ? onExit() : globalExit?.();
        return;
      case '/help':
        addMessage({ role: 'system', content: 'HELP_VIEW' });
        return;
      case '/status': {
        setInfo(refreshInfo());
        addMessage({ role: 'system', content: 'STATUS_VIEW' });
        return;
      }
      case '/tools': {
        const builtIn = session.describeTools().map(({ name, description }) => `  ${name} — ${description}`);
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
          const cur = session.getAlwaysActiveSkills();
          addMessage({ role: 'system', content: cur.length ? `Always-active skills: ${cur.join(', ')}` : 'No always-active skills set. Usage: /always <name>… (or "none" to clear).' });
        } else {
          const names = args[0] === 'none' ? [] : args;
          session.setAlwaysActiveSkills(names);
          addMessage({ role: 'system', content: names.length ? `Always-active skills: ${names.join(', ')}` : 'Cleared always-active skills.' });
        }
        return;
      }
      case '/approval': {
        const mode = input.slice(cmd.length).trim();
        if (!mode) {
          addMessage({ role: 'system', content: `Shell approval: ${session.getShellApprovalMode().mode}` });
          return;
        }
        if (mode !== 'strict' && mode !== 'allow_all' && mode !== 'deny_all') {
          addMessage({ role: 'system', content: 'Usage: /approval strict | allow_all | deny_all' });
          return;
        }
        const result = session.setShellApprovalMode(mode);
        addMessage({ role: 'system', content: `Shell approval: ${result.mode}` });
        return;
      }
      case '/model': {
        const spec = input.slice(cmd.length).trim();
        if (!spec) {
          addMessage({ role: 'system', content: `Stored model: ${session.getStoredModelSpec().spec ?? '(default)'}\nEffective: ${session.getEffectiveModelSpec()}` });
          return;
        }
        try {
          const result = session.setModel(spec);
          setModelSpec(result.spec);
          addMessage({ role: 'system', content: `Model: ${result.spec}` });
        } catch (err) {
          addMessage({ role: 'system', content: `Error: ${(err as Error).message}` });
        }
        return;
      }
      case '/models': {
        const providers = await session.listModelProviders();
        if (providers.length === 0) {
          addMessage({ role: 'system', content: 'No local provider registry is configured for this session.' });
          return;
        }
        const lines = ['Providers:'];
        for (const p of providers) lines.push(`  ${p.id} — ${p.available ? 'available' : p.unavailableReason ?? 'unavailable'}`);
        const models = await session.listAvailableModels();
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
        const sessions = listCliSessions(initialInfo.name);
        if (sessions.length === 0) {
          addMessage({ role: 'system', content: 'No recorded CLI sessions yet.' });
          return;
        }
        const lines = sessions.slice(0, 12).map((s, index) => {
          const title = s.name ?? s.firstUserText ?? '(untitled)';
          return `${index + 1}. ${s.id}  ${title}`;
        });
        addMessage({
          role: 'system',
          content: `${cmd === '/resume' ? 'Resume' : 'Sessions'}\n${lines.join('\n')}\n\nUse: proteus chat ${initialInfo.name} --session <id>`,
        });
        return;
      }
      case '/stop': {
        session.interrupt();
        addMessage({ role: 'system', content: 'Stop requested for the active local turn.' });
        return;
      }
      case '/jobs': {
        const jobs = await session.listBackgroundJobs(20);
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
  }, [addMessage, refreshInfo, rt, session]);

  const handleSubmit = useCallback(async (input: string) => {
    const text = input.trim();
    if (!text) return;
    if (!mcpReady) {
      addMessage({ role: 'system', content: 'MCP tools are still connecting.' });
      return;
    }
    if (text.startsWith('/')) { await handleSlash(text); return; }
    addMessage({ role: 'user', content: text });
    cliSession?.append('user', { text, cwd: process.cwd(), backend: 'local' });
    try { await session.send(text); } catch { /* errors surface as SessionEvents */ }
  }, [addMessage, cliSession, handleSlash, mcpReady, session]);

  // opentui's `input` intrinsic merges with React DOM's, so onSubmit's type is
  // the intersection of (value: string) and (event: SubmitEvent). opentui passes
  // the value string at runtime; accept the union and forward the string.
  const onInputSubmit = useCallback((value: string | object) => {
    if (typeof value === 'string') void handleSubmit(value);
  }, [handleSubmit]);

  // Fire a partial-session evolution flush on exit; connect MCP + recover once.
  useEffect(() => {
    let cancelled = false;
    globalSessionCleanup = async () => { await session.end(); };
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
    if (key.name === 'escape') globalExit?.();
  });

  const scrollHeight = Math.max(1, height - 7);

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
          if (msg.role === 'system' && msg.content === 'HELP_VIEW') return <HelpView key={msg.id} />;
          if (msg.role === 'system' && msg.content === 'STATUS_VIEW') return <StatusView key={msg.id} info={info} dbSize={dbSize} />;
          return null;
        })}
        <MessageList
          messages={messages.filter((m) => !(m.role === 'system' && (m.content === 'HELP_VIEW' || m.content === 'STATUS_VIEW')))}
          streamingText={streamingText}
        />
        {isProcessing && streamingText === '' && (
          <box style={{ paddingLeft: 2 }}>
            <text><span fg="#7c3aed">⟳ thinking…</span></text>
          </box>
        )}
      </scrollbox>

      <box
        style={{
          height: 3,
          border: true,
          borderStyle: 'single',
          borderColor: isProcessing ? '#4a4a6a' : '#3b3b5c',
          backgroundColor: '#1a1a2e',
          paddingLeft: 1,
        }}
        title={isProcessing ? '⟳ processing…' : `${info.name} ›`}
      >
        <input
          focused={mcpReady && !isProcessing}
          placeholder={!mcpReady ? 'Connecting MCP…' : isProcessing ? 'Waiting for response…' : 'Type a message or /help'}
          onSubmit={onInputSubmit}
        />
      </box>
    </box>
  );
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
  const cliSession = createCliSession(agentName, opts);
  return {
    cliSession,
    localSessionId: opts.noSession || opts.session || opts.continue || opts.resume || opts.fork
      ? cliSession.id
      : defaultAgentSessionId(),
  };
}

function recordSessionEvent(session: CliSession | undefined, event: SessionEvent): void {
  if (!session) return;
  switch (event.type) {
    case 'tool-call':
      session.append('tool_call', { toolName: event.toolName, args: event.args });
      break;
    case 'tool-result':
      session.append('tool_result', { toolName: event.toolName, result: event.result });
      break;
    case 'turn-end':
      session.append('assistant', {
        text: event.turn.assistantResponse,
        steps: event.turn.steps,
        durationMs: event.turn.durationMs,
        hadError: event.turn.hadError,
      });
      break;
    case 'error':
      session.append('error', { message: event.message, backend: 'local' });
      break;
  }
}

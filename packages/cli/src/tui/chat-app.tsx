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
import { LocalAgentSession, resolveChatModel, type LocalSessionDb, type SessionEvent } from '@proteus/cli-backend';

import { StatusBar } from './status-bar.js';
import { MessageList, type DisplayMessage } from './messages.js';
import { HelpView, StatusView } from './help-view.js';

export interface ChatAppOpts {
  rt: AgentRuntime;
  db: LocalSessionDb;
  info: AgentInfo;
  dbSize: number;
  llmConfig: LLMProviderConfig;
  refreshInfo: () => AgentInfo;
  noAutoEvolve?: boolean;
}

let globalExit: (() => void) | null = null;
let globalSessionCleanup: (() => Promise<void>) | null = null;

function ChatApp({ rt, db, info: initialInfo, dbSize, llmConfig, refreshInfo, noAutoEvolve }: ChatAppOpts) {
  const { height } = useTerminalDimensions();
  const [messages, setMessages] = useState<DisplayMessage[]>([
    { id: 'welcome', role: 'system', content: `Connected to ${initialInfo.name}. Type a message or /help for commands.` },
  ]);
  const [streamingText, setStreamingText] = useState<string | null>(null);
  const [isProcessing, setIsProcessing] = useState(false);
  const [info, setInfo] = useState(initialInfo);

  const msgIdRef = useRef(0);
  const streamRef = useRef('');

  const addMessage = useCallback((msg: Omit<DisplayMessage, 'id'>) => {
    const id = `msg-${++msgIdRef.current}`;
    setMessages((prev) => [...prev, { ...msg, id }]);
  }, []);

  // The agent loop — built once. Its SessionEvent stream drives React state.
  const sessionRef = useRef<LocalAgentSession | null>(null);
  if (!sessionRef.current) {
    sessionRef.current = new LocalAgentSession({
      rt, db, model: resolveChatModel(llmConfig), noAutoEvolve,
      onEvent: (event: SessionEvent) => {
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
        globalExit?.();
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
    if (text.startsWith('/')) { await handleSlash(text); return; }
    addMessage({ role: 'user', content: text });
    try { await session.send(text); } catch { /* errors surface as SessionEvents */ }
  }, [addMessage, handleSlash, session]);

  // opentui's `input` intrinsic merges with React DOM's, so onSubmit's type is
  // the intersection of (value: string) and (event: SubmitEvent). opentui passes
  // the value string at runtime; accept the union and forward the string.
  const onInputSubmit = useCallback((value: string | object) => {
    if (typeof value === 'string') void handleSubmit(value);
  }, [handleSubmit]);

  // Fire a partial-session evolution flush on exit; recover orphaned bg jobs once.
  useEffect(() => {
    globalSessionCleanup = async () => { await session.end(); };
    void session.recoverBackgroundJobs();
    return () => { globalSessionCleanup = null; };
  }, [session]);

  useKeyboard((key) => {
    if (key.name === 'escape') globalExit?.();
  });

  const scrollHeight = Math.max(1, height - 7);

  return (
    <box flexDirection="column" style={{ height: '100%' }}>
      <StatusBar
        info={info}
        model={llmConfig.model}
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
          focused={!isProcessing}
          placeholder={isProcessing ? 'Waiting for response…' : 'Type a message or /help'}
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

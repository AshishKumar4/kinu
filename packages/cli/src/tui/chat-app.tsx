/**
 * TUI Chat Application — OpenTUI React-based terminal UI for Proteus.
 *
 * Replaces the raw readline chat-loop with a proper terminal UI featuring:
 * - Scrollable message history
 * - Streaming text with cursor indicator
 * - Tool call/result display
 * - Status bar with agent info
 * - Slash command support (/help, /status, /tools, /memory, /tree, /exit)
 */

import { createCliRenderer } from '@opentui/core';
import { createRoot, useKeyboard, useRenderer, useTerminalDimensions } from '@opentui/react';
import { useState, useCallback, useRef, useEffect } from 'react';
import type { CoreMessage, ToolSet } from 'ai';
import type { AgentRuntime, AgentInfo, LLMProviderConfig, SearchNode } from '@proteus/core';
import {
  EvolutionEngine,
  buildBuiltinTools,
  buildSystemPromptSync,
  createChatModel,
  runChat,
  resolveMaxSteps,
  type CompletedTurn,
  type ToolCallRecord,
  type ChatEvent,
} from '@proteus/core';
import { createNodeCraftedExecute, createNodeExecuteToolFactory } from '@proteus/cli-backend';

import { StatusBar } from './status-bar.js';
import { MessageList, type DisplayMessage } from './messages.js';
import { HelpView, StatusView } from './help-view.js';

export interface ChatAppOpts {
  rt: AgentRuntime;
  info: AgentInfo;
  dbSize: number;
  llmConfig: LLMProviderConfig;
  refreshInfo: () => AgentInfo;
  noAutoEvolve?: boolean;
}

let globalExit: (() => void) | null = null;
let globalSessionCleanup: (() => Promise<void>) | null = null;

function ChatApp({ rt, info: initialInfo, dbSize, llmConfig, refreshInfo, noAutoEvolve }: ChatAppOpts) {
  const renderer = useRenderer();
  const { height } = useTerminalDimensions();
  const [messages, setMessages] = useState<DisplayMessage[]>([
    { id: 'welcome', role: 'system', content: `Connected to ${initialInfo.name}. Type a message or /help for commands.` },
  ]);
  const [streamingText, setStreamingText] = useState<string | null>(null);
  const [isProcessing, setIsProcessing] = useState(false);
  const [info, setInfo] = useState(initialInfo);

  const historyRef = useRef<CoreMessage[]>([]);
  const msgIdRef = useRef(0);
  const sessionTurnsRef = useRef<CompletedTurn[]>([]);

  const model = createChatModel({
    kind: 'openai-compat',
    name: llmConfig.name,
    baseURL: llmConfig.baseURL,
    headers: llmConfig.headers,
    modelId: llmConfig.model,
  });

  const engineRef = useRef<EvolutionEngine | null>(null);
  if (!engineRef.current) {
    engineRef.current = new EvolutionEngine(rt, { enabled: !noAutoEvolve });
    engineRef.current.onEvent((event) => {
      addMessage({ role: 'evolution', content: `[${event.type}] ${event.message}` });
    });
  }

  // CLI tool surface: execute_tools + run + memory (the always-on builtins).
  // think / fact / skills are CF-only (they need a HeadController / FactsStore /
  // SkillsVfs the CLI doesn't provision). The CLI wires the Node execute-tools
  // factory and the Node crafted-tool executor; codemodeLoader is a sentinel so
  // the factory branch is selected. `engine` drives auto-evolution, not a tool.
  const tools: ToolSet = buildBuiltinTools({
    rt,
    craftedToolExecute: createNodeCraftedExecute(),
    createExecuteTool: createNodeExecuteToolFactory({
      vfs: rt.storage.vfs,
      memory: rt.memory,
      shell: rt.shell,
    }) as never,
    codemodeLoader: { __cli: true } as unknown,
  });

  const addMessage = useCallback((msg: Omit<DisplayMessage, 'id'>) => {
    const id = `msg-${++msgIdRef.current}`;
    setMessages(prev => [...prev, { ...msg, id }]);
  }, []);

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
        const fresh = refreshInfo();
        setInfo(fresh);
        addMessage({ role: 'system', content: 'STATUS_VIEW' });
        return;
      }
      case '/tools': {
        const builtIn = Object.entries(tools).map(([name, t]) =>
          `  ${name} — ${(t as { description?: string }).description ?? ''}`,
        );
        const crafted = rt.craftStore.list();
        const craftedLines = crafted.map(t => `  ${t.name} — ${t.description.slice(0, 50)}`);
        const lines = ['Built-in:', ...builtIn];
        if (craftedLines.length > 0) lines.push('', 'Crafted:', ...craftedLines);
        addMessage({ role: 'system', content: lines.join('\n') });
        return;
      }
      case '/memory': {
        const content = await rt.memory.read('memory/MEMORY.md');
        addMessage({ role: 'system', content: content ? `Memory:\n${content.slice(0, 1500)}` : 'Memory is empty.' });
        return;
      }
      case '/tree': {
        const nodes = rt.storage.sql<SearchNode>`SELECT * FROM search_nodes ORDER BY depth, created_at`;
        if (nodes.length === 0) {
          addMessage({ role: 'system', content: 'No MCTS nodes yet. Use /evolve or ask complex questions.' });
        } else {
          const lines = nodes.map(n => {
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
  }, [addMessage, refreshInfo, rt, tools]);

  const handleSubmit = useCallback(async (input: string) => {
    const text = input.trim();
    if (!text) return;

    if (text.startsWith('/')) {
      await handleSlash(text);
      return;
    }

    addMessage({ role: 'user', content: text });
    setIsProcessing(true);
    setStreamingText('');

    const turnStart = Date.now();
    const knowledge = (await rt.memory.read('memory/MEMORY.md'))?.slice(0, 2000) ?? '';
    const executorNames = (rt.executionRouter?.listExecutors() ?? []).map(e => e.name);
    const systemPrompt = buildSystemPromptSync(rt, {
      extraKnowledge: knowledge || undefined,
      registeredExecutors: executorNames,
    });

    historyRef.current.push({ role: 'user', content: text });

    const turnToolCalls: ToolCallRecord[] = [];
    let fullText = '';
    let stepCount = 0;
    let hadError = false;

    try {
      for await (const event of runChat({
        model,
        system: systemPrompt,
        history: historyRef.current,
        tools,
        maxSteps: resolveMaxSteps(),
      })) {
        switch (event.type) {
          case 'text-delta':
            fullText += event.delta;
            setStreamingText(fullText);
            break;
          case 'tool-call':
            addMessage({ role: 'tool_call', content: '', toolName: event.toolName, args: JSON.stringify(event.args) });
            turnToolCalls.push({ name: event.toolName, args: event.args, result: null });
            break;
          case 'tool-result': {
            addMessage({ role: 'tool_result', content: event.result });
            const lastCall = turnToolCalls.findLast(tc => tc.name === event.toolName && tc.result === null);
            if (lastCall) lastCall.result = event.result;
            break;
          }
          case 'done':
            for (const msg of (event as any).responseMessages ?? []) {
              historyRef.current.push(msg);
            }
            if (!fullText.trim() && event.text.trim()) fullText = event.text;
            break;
        }
      }
    } catch (err) {
      hadError = true;
      addMessage({ role: 'system', content: `Error: ${(err as Error).message}` });
    }

    setStreamingText(null);
    setIsProcessing(false);

    if (fullText.trim()) {
      addMessage({ role: 'assistant', content: fullText.trim() });
    }

    // Store in DB
    const msgId = crypto.randomUUID();
    const sessionId = 'tui-' + Date.now();
    rt.storage.sql`INSERT INTO messages (id, session_id, role, content) VALUES (${msgId}, ${sessionId}, ${'user'}, ${text})`;
    rt.storage.sql`INSERT INTO messages (id, session_id, parent_id, role, content) VALUES (${crypto.randomUUID()}, ${sessionId}, ${msgId}, ${'assistant'}, ${fullText})`;

    const turn: CompletedTurn = {
      userMessage: text, assistantResponse: fullText, toolCalls: turnToolCalls,
      steps: stepCount, durationMs: Date.now() - turnStart, feedback: null, hadError,
    };
    sessionTurnsRef.current.push(turn);
    await engineRef.current?.onTurnComplete(turn);
  }, [addMessage, handleSlash, model, rt, tools]);

  // Register session cleanup so the exit handler can fire session evolution
  const sessionStartRef = useRef(Date.now());
  useEffect(() => {
    globalSessionCleanup = async () => {
      if (sessionTurnsRef.current.length > 0 && engineRef.current) {
        await engineRef.current.onSessionComplete({
          sessionId: `tui-${sessionStartRef.current}`,
          turns: sessionTurnsRef.current,
          startedAt: sessionStartRef.current,
          endedAt: Date.now(),
        });
      }
    };
    return () => { globalSessionCleanup = null; };
  }, []);

  // Escape to exit
  useKeyboard((key) => {
    if (key.name === 'escape') {
      globalExit?.();
    }
  });

  const scrollHeight = Math.max(1, height - 7);

  return (
    <box flexDirection="column" style={{ height: '100%' }}>
      <StatusBar
        info={info}
        model={llmConfig.model}
        toolCount={Object.keys(tools).length}
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
          messages={messages.filter(m => !(m.role === 'system' && (m.content === 'HELP_VIEW' || m.content === 'STATUS_VIEW')))}
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
          onSubmit={handleSubmit}
        />
      </box>
    </box>
  );
}

export async function runTuiChat(opts: ChatAppOpts): Promise<void> {
  const renderer = await createCliRenderer({ exitOnCtrlC: false });
  const root = createRoot(renderer);

  const cleanup = async () => {
    // Fire session-level evolution before exit
    try { await globalSessionCleanup?.(); } catch { /* best effort */ }
    root.render(<box />);
    renderer.cleanup();
    console.log('\n  Goodbye.\n');
    process.exit(0);
  };

  globalExit = cleanup;
  process.on('SIGINT', cleanup);

  root.render(<ChatApp {...opts} />);

  // Keep the process alive
  await new Promise<void>(() => {});
}

import { createCliRenderer } from '@opentui/core';
import { createRoot, useKeyboard, useTerminalDimensions } from '@opentui/react';
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  getCloudAgentModel,
  getCloudAgentStatus,
  getCloudAgentTools,
  getCloudMctsTree,
  getCloudMemoryContent,
  listCloudJobs,
  runCloudTurn,
  setCloudAgentModel,
  stopCloudAgent,
} from '../cloud-api.js';
import { listCliSessions, type CliSession } from '../session.js';
import { MessageList, type DisplayMessage } from './messages.js';

export interface CloudChatAppOpts {
  origin: string;
  token: string;
  agentName: string;
  cloudName: string;
  session: CliSession;
  initialPrompt?: string;
}

let cloudExit: (() => void) | null = null;

function CloudChatApp({ origin, token, agentName, cloudName, session, initialPrompt }: CloudChatAppOpts) {
  const { height } = useTerminalDimensions();
  const [messages, setMessages] = useState<DisplayMessage[]>([
    { id: 'welcome', role: 'system', content: `Connected to ${agentName}. Type a message or /help for commands.` },
  ]);
  const [streamingText, setStreamingText] = useState<string | null>(null);
  const [isProcessing, setIsProcessing] = useState(false);
  const [model, setModel] = useState('cloud');
  const msgIdRef = useRef(0);
  const initialPromptSentRef = useRef(false);

  const addMessage = useCallback((msg: Omit<DisplayMessage, 'id'>) => {
    const id = `msg-${++msgIdRef.current}`;
    setMessages((prev) => [...prev, { ...msg, id }]);
  }, []);

  useEffect(() => {
    let cancelled = false;
    void getCloudAgentModel(origin, token, cloudName)
      .then((result) => { if (!cancelled) setModel(result.spec ?? 'cloud/default'); })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [cloudName, origin, token]);

  const handleSlash = useCallback(async (input: string) => {
    const [cmd, ...rest] = input.split(/\s+/);
    const arg = rest.join(' ').trim();
    switch (cmd?.toLowerCase()) {
      case '/exit':
      case '/quit':
        cloudExit?.();
        return;
      case '/help':
        addMessage({ role: 'system', content: [
          'Commands',
          '  /help       Show this help',
          '  /status     Agent state and stats',
          '  /tools      List available tools',
          '  /model      Show or set the active model',
          '  /memory     Show memory',
          '  /mcts       Show MCTS node count',
          '  /sessions   List recorded CLI sessions',
          '  /resume     Show resumable sessions',
          '  /jobs       List background jobs',
          '  /stop       Stop cloud work',
          '  /exit       Exit chat',
        ].join('\n') });
        return;
      case '/status': {
        const status = await getCloudAgentStatus(origin, token, cloudName);
        addMessage({ role: 'system', content: [
          `Name: ${status.displayName ?? status.name}`,
          `Purpose: ${status.purpose.slice(0, 120)}`,
          `Messages: ${status.messageCount}`,
          `MCTS nodes: ${status.searchNodeCount}`,
          `Crafted tools: ${status.craftedToolCount}`,
          `Model: ${status.model ?? '(default)'}`,
        ].join('\n') });
        return;
      }
      case '/tools': {
        const tools = await getCloudAgentTools(origin, token, cloudName);
        const builtIn = tools.builtIn.map((tool) => `  ${tool.name} - ${tool.description}`);
        const crafted = tools.crafted.map((tool) => `  ${tool.name} - ${tool.description}`);
        addMessage({ role: 'system', content: ['Built-in:', ...builtIn, ...(crafted.length ? ['', 'Crafted:', ...crafted] : [])].join('\n') });
        return;
      }
      case '/model': {
        if (!arg) {
          const result = await getCloudAgentModel(origin, token, cloudName);
          addMessage({ role: 'system', content: `Model: ${result.spec ?? '(default)'}` });
          return;
        }
        const result = await setCloudAgentModel(origin, token, cloudName, arg);
        setModel(result.spec);
        addMessage({ role: 'system', content: `Model: ${result.spec}` });
        return;
      }
      case '/memory': {
        const result = await getCloudMemoryContent(origin, token, cloudName);
        addMessage({ role: 'system', content: result.content ? `Memory:\n${result.content.slice(0, 1500)}` : 'Memory is empty.' });
        return;
      }
      case '/mcts':
      case '/tree': {
        const tree = await getCloudMctsTree(origin, token, cloudName);
        addMessage({ role: 'system', content: Array.isArray(tree) && tree.length ? `MCTS nodes: ${tree.length}` : 'No MCTS nodes yet.' });
        return;
      }
      case '/jobs': {
        const jobs = await listCloudJobs(origin, token, cloudName, 20);
        addMessage({ role: 'system', content: jobs.length ? jobs.map((job) => `${job.id}  ${job.kind}  ${job.status}`).join('\n') : 'No background jobs.' });
        return;
      }
      case '/stop': {
        await stopCloudAgent(origin, token, cloudName);
        addMessage({ role: 'system', content: 'Stop requested for cloud work.' });
        return;
      }
      case '/sessions':
      case '/resume': {
        const sessions = listCliSessions(agentName);
        addMessage({
          role: 'system',
          content: sessions.length
            ? sessions.slice(0, 12).map((s, i) => `${i + 1}. ${s.id}  ${s.name ?? s.firstUserText ?? '(untitled)'}`).join('\n')
            : 'No recorded CLI sessions yet.',
        });
        return;
      }
      default:
        addMessage({ role: 'system', content: `Unknown command: ${cmd}. Type /help` });
    }
  }, [addMessage, agentName, cloudName, origin, token]);

  const send = useCallback(async (text: string) => {
    const prompt = text.trim();
    if (!prompt || isProcessing) return;
    if (prompt.startsWith('/')) {
      await handleSlash(prompt);
      return;
    }

    addMessage({ role: 'user', content: prompt });
    session.append('user', { text: prompt, cwd: process.cwd(), backend: 'cloud' });
    setStreamingText('');
    setIsProcessing(true);
    try {
      const result = await runCloudTurn(origin, token, cloudName, prompt, process.cwd());
      for (const call of result.toolCalls ?? []) {
        addMessage({ role: 'tool_call', content: '', toolName: call.name, args: JSON.stringify(call.args) });
        if (call.result !== undefined) addMessage({ role: 'tool_result', content: call.result });
      }
      session.append('assistant', {
        text: result.text,
        toolCalls: result.toolCalls ?? [],
        steps: result.steps ?? 0,
        backend: 'cloud',
      });
      setStreamingText(null);
      if (result.text.trim()) addMessage({ role: 'assistant', content: result.text.trim() });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      session.append('error', { message, backend: 'cloud' });
      addMessage({ role: 'system', content: `Error: ${message}` });
      setStreamingText(null);
    } finally {
      setIsProcessing(false);
    }
  }, [addMessage, cloudName, handleSlash, isProcessing, origin, session, token]);

  useEffect(() => {
    const prompt = initialPrompt?.trim();
    if (!prompt || initialPromptSentRef.current) return;
    initialPromptSentRef.current = true;
    void send(prompt);
  }, [initialPrompt, send]);

  useKeyboard((key) => {
    if (key.name === 'escape') cloudExit?.();
  });

  const onSubmit = useCallback((value: string | object) => {
    if (typeof value === 'string') void send(value);
  }, [send]);
  const scrollHeight = Math.max(1, height - 7);

  return (
    <box flexDirection="column" style={{ height: '100%' }}>
      <box
        style={{
          height: 3,
          border: true,
          borderStyle: 'single',
          borderColor: '#3b3b5c',
          backgroundColor: '#1a1a2e',
          paddingLeft: 1,
          paddingRight: 1,
          flexDirection: 'row',
          justifyContent: 'space-between',
          alignItems: 'center',
        }}
      >
        <text><strong fg="#c4b5fd">{agentName}</strong> <span fg="#6b7280">cloud</span></text>
        <text><span fg="#6b7280">{model.split('/').pop()}</span>  <span fg="#4ade80">● connected</span></text>
      </box>

      <scrollbox
        focused={!isProcessing}
        style={{
          flexGrow: 1,
          height: scrollHeight,
          rootOptions: { backgroundColor: '#0f0f23' },
          viewportOptions: { backgroundColor: '#0f0f23' },
          contentOptions: { backgroundColor: '#0f0f23' },
        }}
      >
        <MessageList messages={messages} streamingText={streamingText} />
        {isProcessing && streamingText === '' && (
          <box style={{ paddingLeft: 2 }}>
            <text><span fg="#7c3aed">thinking...</span></text>
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
        title={isProcessing ? 'processing...' : `${agentName} >`}
      >
        <input
          focused={!isProcessing}
          placeholder={isProcessing ? 'Waiting for response...' : 'Type a message or /help'}
          onSubmit={onSubmit}
        />
      </box>
    </box>
  );
}

export async function runCloudTuiChat(opts: CloudChatAppOpts): Promise<void> {
  const renderer = await createCliRenderer({ exitOnCtrlC: false });
  const root = createRoot(renderer);
  const cleanup = () => {
    root.render(<box />);
    renderer.destroy();
    console.log('\n  Goodbye.\n');
    process.exit(0);
  };
  cloudExit = cleanup;
  process.on('SIGINT', cleanup);
  root.render(<CloudChatApp {...opts} />);
  await new Promise<void>(() => {});
}

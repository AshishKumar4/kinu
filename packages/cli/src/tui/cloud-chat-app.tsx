import { createCliRenderer, type InputRenderable } from '@opentui/core';
import { createRoot, useKeyboard, useTerminalDimensions } from '@opentui/react';
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  getCloudAgentModel,
  getCloudAgentStatus,
  getCloudAgentTools,
  getCloudMctsTree,
  getCloudMemoryContent,
  listCloudAvailableModels,
  listCloudJobs,
  setCloudAgentModel,
  stopCloudAgent,
} from '../cloud-api.js';
import { runCloudTurnWithLocalModel } from '../cloud-local-turn.js';
import {
  createCliSession,
  listCliSessions,
  readCliSessionTranscript,
  type CliSession,
  type CliSessionInfo,
  type CliSessionOptions,
} from '../session.js';
import { MessageList, type DisplayMessage } from './messages.js';
import { renderSessionBrowser, selectSession, transcriptToMessages } from './session-browser.js';
import { clipText } from './format.js';
import { commandHelp, filterCommands, resolveCommandDraft } from './commands.js';
import { normalizeModelEntries, type TuiModelEntry } from './model-types.js';
import { CommandHintOverlay, ModelPickerOverlay, PhaseLine } from './overlays.js';

export interface CloudChatAppOpts {
  origin: string;
  token: string;
  agentName: string;
  cloudName: string;
  session: CliSession;
  sessionOptions?: Pick<CliSessionOptions, 'sessionDir'>;
  hydrateTranscript?: boolean;
  initialPrompt?: string;
}

let cloudExit: (() => void) | null = null;

function CloudChatApp({ origin, token, agentName, cloudName, session, sessionOptions, hydrateTranscript, initialPrompt }: CloudChatAppOpts) {
  const { height } = useTerminalDimensions();
  const [messages, setMessages] = useState<DisplayMessage[]>(() => initialMessages(agentName, session, sessionOptions, hydrateTranscript));
  const [streamingText, setStreamingText] = useState<string | null>(null);
  const [isProcessing, setIsProcessing] = useState(false);
  const [turnPhase, setTurnPhase] = useState<string | null>(null);
  const [model, setModel] = useState('cloud');
  const [sessionPicker, setSessionPicker] = useState<{ sessions: CliSessionInfo[] } | null>(null);
  const [modelPicker, setModelPicker] = useState<{ models: TuiModelEntry[]; loading: boolean; error: string | null } | null>(null);
  const [draft, setDraft] = useState('');
  const [activeSessionId, setActiveSessionId] = useState(session.id);
  const msgIdRef = useRef(0);
  const inputRef = useRef<InputRenderable | null>(null);
  const initialPromptSentRef = useRef(false);
  const sessionRef = useRef(session);

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

  const resumeSession = useCallback((input: string, available?: CliSessionInfo[]) => {
    const sessions = available ?? listCliSessions(agentName, sessionOptions);
    const selected = selectSession(sessions, input);
    if (!selected) {
      addMessage({ role: 'system', content: `No matching session for "${input}". Type /resume to choose again.` });
      return;
    }
    const transcript = readCliSessionTranscript(agentName, selected.info.id, sessionOptions);
    const nextSession = createCliSession(agentName, { ...sessionOptions, session: selected.info.id });
    sessionRef.current = nextSession;
    setActiveSessionId(nextSession.id);
    setSessionPicker(null);
    setModelPicker(null);
    setMessages([
      ...transcriptToMessages(transcript),
      {
        id: `cloud-session-${nextSession.id}`,
        role: 'system',
        content: 'Cloud agent state remains durable in Proteus; this switches the CLI transcript used for this terminal.',
      },
    ]);
  }, [addMessage, agentName, sessionOptions]);

  const openModelPicker = useCallback(async () => {
    setModelPicker({ models: [], loading: true, error: null });
    try {
      const models = normalizeModelEntries(await listCloudAvailableModels(origin, token));
      setModelPicker({ models, loading: false, error: null });
    } catch (err) {
      setModelPicker({
        models: [],
        loading: false,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }, [origin, token]);

  const selectModel = useCallback(async (entry: TuiModelEntry) => {
    try {
      const result = await setCloudAgentModel(origin, token, cloudName, entry.spec);
      setModel(result.spec);
      setModelPicker(null);
      addMessage({ role: 'system', content: `Model: ${result.spec}` });
    } catch (err) {
      addMessage({ role: 'system', content: `Error: ${err instanceof Error ? err.message : String(err)}` });
    }
  }, [addMessage, cloudName, origin, token]);

  const handleSlash = useCallback(async (input: string) => {
    const [cmd, ...rest] = input.split(/\s+/);
    const arg = rest.join(' ').trim();
    switch (cmd?.toLowerCase()) {
      case '/exit':
      case '/quit':
        cloudExit?.();
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
        addMessage({ role: 'system', content: commandHelp('cloud') });
        return;
      case '/status': {
        const status = await getCloudAgentStatus(origin, token, cloudName);
        addMessage({ role: 'system', content: [
          `Name: ${status.displayName ?? status.name}`,
          `Mission: ${status.purpose.slice(0, 120)}`,
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
          await openModelPicker();
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
        const sessions = listCliSessions(agentName, sessionOptions);
        if (sessions.length === 0) {
          addMessage({ role: 'system', content: 'No recorded CLI sessions yet.' });
          return;
        }
        if (cmd.toLowerCase() === '/resume' && arg) {
          resumeSession(arg, sessions);
          return;
        }
        if (cmd.toLowerCase() === '/resume') setSessionPicker({ sessions });
        addMessage({ role: 'system', content: renderSessionBrowser(cmd.toLowerCase() === '/resume' ? 'resume' : 'list', sessions) });
        return;
      }
      default:
        addMessage({ role: 'system', content: `Unknown command: ${cmd}. Type /help` });
    }
  }, [addMessage, agentName, cloudName, modelPicker, openModelPicker, origin, resumeSession, sessionOptions, sessionPicker, token]);

  const send = useCallback(async (text: string) => {
    const prompt = text.trim();
    if (!prompt || isProcessing) return;
    if (sessionPicker && !prompt.startsWith('/')) {
      try {
        resumeSession(prompt, sessionPicker.sessions);
      } catch (err) {
        addMessage({ role: 'system', content: `Error: ${err instanceof Error ? err.message : String(err)}` });
      }
      return;
    }
    const submitted = prompt.startsWith('/') ? resolveCommandDraft('cloud', prompt) : prompt;
    if (submitted.startsWith('/')) {
      try {
        await handleSlash(submitted);
      } catch (err) {
        addMessage({ role: 'system', content: `Error: ${err instanceof Error ? err.message : String(err)}` });
      }
      return;
    }

    addMessage({ role: 'user', content: submitted });
    sessionRef.current.append('user', { text: submitted, cwd: process.cwd(), backend: 'cloud' });
    setStreamingText('');
    setIsProcessing(true);
    setTurnPhase('preparing cloud turn');
    try {
      const result = await runCloudTurnWithLocalModel({
        origin,
        token,
        name: cloudName,
        prompt: submitted,
        cwd: process.cwd(),
        onEvent: (event) => {
          if (event.type === 'text-delta') {
            setStreamingText((prev) => `${prev ?? ''}${event.delta}`);
            setTurnPhase('writing');
          } else if (event.type === 'tool-call') {
            setTurnPhase(`calling ${event.toolName}`);
            addMessage({ role: 'tool_call', content: '', toolName: event.toolName, args: JSON.stringify(event.args) });
          } else if (event.type === 'tool-result') {
            setTurnPhase(`finished ${event.toolName}`);
            addMessage({ role: 'tool_result', content: event.result });
          } else if (event.type === 'step-finish') {
            setTurnPhase(`step ${event.stepIndex}`);
          }
        },
      });
      sessionRef.current.append('assistant', {
        text: result.text,
        toolCalls: result.toolCalls ?? [],
        steps: result.steps ?? 0,
        backend: 'cloud',
      });
      setStreamingText(null);
      if (result.text.trim()) addMessage({ role: 'assistant', content: result.text.trim() });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      sessionRef.current.append('error', { message, backend: 'cloud' });
      addMessage({ role: 'system', content: `Error: ${message}` });
      setStreamingText(null);
    } finally {
      setIsProcessing(false);
      setTurnPhase(null);
    }
  }, [addMessage, cloudName, handleSlash, isProcessing, origin, resumeSession, sessionPicker, token]);

  useEffect(() => {
    const prompt = initialPrompt?.trim();
    if (!prompt || initialPromptSentRef.current) return;
    initialPromptSentRef.current = true;
    void send(prompt);
  }, [initialPrompt, send]);

  useKeyboard((key) => {
    if (key.name === 'escape' && modelPicker) {
      setModelPicker(null);
      return;
    }
    if (key.name === 'escape') cloudExit?.();
  });

  const onSubmit = useCallback((value: string | object) => {
    if (typeof value === 'string') {
      setDraft('');
      if (inputRef.current) inputRef.current.value = '';
      void send(value);
    }
  }, [send]);
  const scrollHeight = Math.max(1, height - 7);
  const commandHints = !modelPicker && !isProcessing && !/\s/.test(draft.trimStart()) ? filterCommands('cloud', draft) : [];

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
        <text><strong fg="#c4b5fd">{clipText(agentName, 32)}</strong> <span fg="#6b7280">cloud</span></text>
        <text><span fg="#6b7280">{clipText(model.split('/').pop() ?? model, 24)}</span>  <span fg="#4ade80">● connected</span></text>
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
        <PhaseLine label={isProcessing ? (turnPhase ?? 'thinking') : null} />
      </scrollbox>

      {modelPicker ? (
        <ModelPickerOverlay
          models={modelPicker.models}
          currentSpec={model}
          loading={modelPicker.loading}
          error={modelPicker.error}
          onSelect={(entry) => { void selectModel(entry); }}
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
        title={isProcessing ? 'processing...' : modelPicker ? 'Model picker open' : sessionPicker ? 'Resume >' : `${agentName} · ${activeSessionId.slice(0, 18)} >`}
      >
        <input
          ref={(value) => { inputRef.current = value; }}
          focused={!isProcessing && !modelPicker}
          value={draft}
          placeholder={isProcessing ? 'Waiting for response...' : modelPicker ? 'Select a model above or Esc' : sessionPicker ? 'Type session number/id or /cancel' : 'Type a message or /help'}
          onInput={setDraft}
          onSubmit={onSubmit}
        />
      </box>
    </box>
  );
}

function initialMessages(
  agentName: string,
  cliSession: CliSession,
  sessionOptions: Pick<CliSessionOptions, 'sessionDir'> | undefined,
  hydrateTranscript: boolean | undefined,
): DisplayMessage[] {
  if (hydrateTranscript) {
    try {
      return [
        ...transcriptToMessages(readCliSessionTranscript(agentName, cliSession.id, sessionOptions)),
        {
          id: `cloud-session-${cliSession.id}`,
          role: 'system',
          content: 'Cloud agent state remains durable in Proteus; this switches the CLI transcript used for this terminal.',
        },
      ];
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

import { createCliRenderer, type InputRenderable } from '@opentui/core';
import { createRoot, useKeyboard, useTerminalDimensions } from '@opentui/react';
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  getCloudAgentModel,
  getCloudAgentMessages,
  getCloudAgentStatus,
  getCloudAgentTools,
  getCloudMctsTree,
  getCloudMemoryContent,
  listCloudAvailableModels,
  listCloudJobs,
  listCloudPendingConsents,
  resolveCloudDeviceConsent,
  setCloudAgentModel,
  stopCloudAgent,
  type CloudPendingConsent,
} from '../cloud-api.js';
import { CloudAgentClient } from '../cloud-agent-client.js';
import {
  createCliSession,
  listCliSessions,
  type CliSession,
  type CliSessionInfo,
  type CliSessionOptions,
} from '../session.js';
import { MessageList, type DisplayMessage } from './messages.js';
import { renderSessionBrowser, selectSession } from './session-browser.js';
import { clipText } from './format.js';
import { commandHelp, filterCommands, resolveCommandDraft } from './commands.js';
import { contextWindowForSpec, normalizeModelEntries, type TuiModelEntry } from './model-types.js';
import { CommandHintOverlay, DeviceConsentOverlay, ModelPickerOverlay, PhaseLine } from './overlays.js';
import { estimateContextTokens, formatContextUsage, modelDisplayName } from './context-status.js';
import { useStreamingBuffer } from './streaming-buffer.js';

export interface CloudChatAppOpts {
  origin: string;
  token: string;
  agentName: string;
  cloudName: string;
  session: CliSession;
  sessionOptions?: Pick<CliSessionOptions, 'sessionDir'>;
  hydrateTranscript?: boolean;
  initialPrompt?: string;
  model?: string;
  baseUrl?: string;
  auth?: string;
}

let cloudExit: (() => void) | null = null;

function CloudChatApp({ origin, token, agentName, cloudName, session, sessionOptions, initialPrompt, model: requestedModel }: CloudChatAppOpts) {
  const { width, height } = useTerminalDimensions();
  const [messages, setMessages] = useState<DisplayMessage[]>(() => initialMessages(agentName));
  const [streamingText, setStreamingText] = useState<string | null>(null);
  const [isProcessing, setIsProcessing] = useState(false);
  const [turnPhase, setTurnPhase] = useState<string | null>(null);
  const [model, setModel] = useState(() => requestedModel ?? 'cloud/default');
  const [modelCatalog, setModelCatalog] = useState<TuiModelEntry[]>([]);
  const [modelContextWindow, setModelContextWindow] = useState<number | undefined>(undefined);
  const [sessionPicker, setSessionPicker] = useState<{ sessions: CliSessionInfo[] } | null>(null);
  const [modelPicker, setModelPicker] = useState<{ models: TuiModelEntry[]; loading: boolean; error: string | null } | null>(null);
  const [pendingConsent, setPendingConsent] = useState<CloudPendingConsent | null>(null);
  const [draft, setDraft] = useState('');
  const [activeSessionId, setActiveSessionId] = useState(session.id);
  const msgIdRef = useRef(0);
  const inputRef = useRef<InputRenderable | null>(null);
  const initialPromptSentRef = useRef(false);
  const requestedModelAppliedRef = useRef(false);
  const sessionRef = useRef(session);
  const clientRef = useRef<CloudAgentClient | null>(null);
  const stream = useStreamingBuffer(setStreamingText);

  if (!clientRef.current) {
    clientRef.current = new CloudAgentClient({ origin, token, name: cloudName });
  }

  const addMessage = useCallback((msg: Omit<DisplayMessage, 'id'>) => {
    const id = `msg-${++msgIdRef.current}`;
    setMessages((prev) => [...prev, { ...msg, id }]);
  }, []);

  useEffect(() => {
    let cancelled = false;
    void getCloudAgentModel(origin, token, cloudName)
      .then(async (result) => {
        if (cancelled) return;
        const next = requestedModel ?? result.spec ?? 'cloud/default';
        if (requestedModel && !requestedModelAppliedRef.current) {
          requestedModelAppliedRef.current = true;
          await setCloudAgentModel(origin, token, cloudName, requestedModel);
        }
        if (!cancelled) setModel(next);
      })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [cloudName, origin, requestedModel, token]);

  useEffect(() => {
    setModelContextWindow(contextWindowForSpec(modelCatalog, model));
  }, [model, modelCatalog]);

  useEffect(() => {
    let cancelled = false;
    void listCloudModels(origin, token)
      .then((models) => {
        if (!cancelled) setModelCatalog(models);
      })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [origin, token]);

  useEffect(() => () => clientRef.current?.close(), []);

  useEffect(() => {
    if (initialPrompt?.trim()) return;
    let cancelled = false;
    void getCloudAgentMessages(origin, token, cloudName)
      .then((rows) => {
        if (cancelled || rows.length === 0) return;
        setMessages(rows.map((row) => ({
          id: row.id,
          role: row.role,
          content: row.content,
        })));
      })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [cloudName, initialPrompt, origin, token]);

  useEffect(() => {
    if (!isProcessing) {
      setPendingConsent(null);
      return;
    }
    let cancelled = false;
    const refresh = async () => {
      try {
        const consents = await listCloudPendingConsents(origin, token, cloudName);
        if (!cancelled) setPendingConsent(consents[0] ?? null);
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
  }, [cloudName, isProcessing, origin, token]);

  const resolvePendingConsent = useCallback((decision: 'once' | 'always' | 'deny') => {
    const consent = pendingConsent;
    if (!consent) return;
    setPendingConsent(null);
    void resolveCloudDeviceConsent(origin, token, cloudName, consent.consentId, decision)
      .then((result) => {
        if (!result.ok) addMessage({ role: 'system', content: 'That PC access request is no longer pending.' });
      })
      .catch((err) => {
        addMessage({ role: 'system', content: `Error: ${err instanceof Error ? err.message : String(err)}` });
      });
  }, [addMessage, cloudName, origin, pendingConsent, token]);

  const hydrateCloudHistory = useCallback(async (systemMessage?: string) => {
    const rows = await getCloudAgentMessages(origin, token, cloudName);
    setMessages([
      ...rows.map((row) => ({
        id: row.id,
        role: row.role,
        content: row.content,
      })),
      ...(systemMessage ? [{ id: `cloud-session-${Date.now()}`, role: 'system' as const, content: systemMessage }] : []),
    ]);
  }, [cloudName, origin, token]);

  const resumeSession = useCallback(async (input: string, available?: CliSessionInfo[]) => {
    const sessions = available ?? listCliSessions(agentName, sessionOptions);
    const selected = selectSession(sessions, input);
    if (!selected) {
      addMessage({ role: 'system', content: `No matching session for "${input}". Type /resume to choose again.` });
      return;
    }
    const nextSession = createCliSession(agentName, { ...sessionOptions, session: selected.info.id });
    sessionRef.current = nextSession;
    setActiveSessionId(nextSession.id);
    setSessionPicker(null);
    setModelPicker(null);
    await hydrateCloudHistory('Cloud chat was reloaded from the durable Proteus agent. Local transcript files are not used as cloud history.');
  }, [addMessage, agentName, hydrateCloudHistory, sessionOptions]);

  const openModelPicker = useCallback(async () => {
    setModelPicker({ models: [], loading: true, error: null });
    try {
      const models = await listCloudModels(origin, token);
      setModelCatalog(models);
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
      await setCloudAgentModel(origin, token, cloudName, entry.spec);
      setModel(entry.spec);
      setModelContextWindow(entry.contextWindow);
      setModelPicker(null);
      addMessage({ role: 'system', content: `Model: ${entry.spec}` });
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
        await setCloudAgentModel(origin, token, cloudName, arg);
        setModel(arg);
        setModelContextWindow(contextWindowForSpec(modelCatalog, arg));
        addMessage({ role: 'system', content: `Model: ${arg}` });
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
          await resumeSession(arg, sessions);
          return;
        }
        if (cmd.toLowerCase() === '/resume') setSessionPicker({ sessions });
        addMessage({ role: 'system', content: renderSessionBrowser(cmd.toLowerCase() === '/resume' ? 'resume' : 'list', sessions) });
        return;
      }
      default:
        addMessage({ role: 'system', content: `Unknown command: ${cmd}. Type /help` });
    }
  }, [addMessage, agentName, cloudName, modelCatalog, modelPicker, openModelPicker, origin, resumeSession, sessionOptions, sessionPicker, token]);

  const send = useCallback(async (text: string) => {
    const prompt = text.trim();
    if (!prompt || isProcessing) return;
    if (sessionPicker && !prompt.startsWith('/')) {
      try {
        await resumeSession(prompt, sessionPicker.sessions);
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
    stream.start();
    setIsProcessing(true);
    setTurnPhase('connecting to cloud agent');
    try {
      const result = await clientRef.current!.send(submitted, {
        cwd: process.cwd(),
        onEvent: (event) => {
          if (event.type === 'text-delta') {
            stream.append(event.delta);
            setTurnPhase((current) => current === 'writing' ? current : 'writing');
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
      stream.clear();
      if (result.text.trim()) addMessage({ role: 'assistant', content: result.text.trim() });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      sessionRef.current.append('error', { message, backend: 'cloud' });
      addMessage({ role: 'system', content: `Error: ${message}` });
      stream.clear();
    } finally {
      setIsProcessing(false);
      setTurnPhase(null);
    }
  }, [addMessage, handleSlash, isProcessing, resumeSession, sessionPicker, stream]);

  useEffect(() => {
    const prompt = initialPrompt?.trim();
    if (!prompt || initialPromptSentRef.current) return;
    initialPromptSentRef.current = true;
    void send(prompt);
  }, [initialPrompt, send]);

  useKeyboard((key) => {
    if (pendingConsent) {
      if (key.name === 'o' || key.name === 'return') {
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
  const contextTokens = estimateContextTokens(messages, streamingText);

  return (
    <box flexDirection="column" style={{ width: '100%', height: '100%' }}>
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
        <text>
          <span fg="#d1d5db">{clipText(modelDisplayName(model), 24)}</span>
          {'  '}
          <span fg="#6b7280">{formatContextUsage(model, contextTokens, modelContextWindow)}</span>
          {'  '}
          <span fg="#4ade80">● connected</span>
        </text>
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

      <box
        style={{
          height: 3,
          border: true,
          borderStyle: 'single',
          borderColor: isProcessing ? '#4a4a6a' : '#3b3b5c',
          backgroundColor: '#1a1a2e',
          paddingLeft: 1,
        }}
        title={isProcessing ? 'processing...' : modelPicker ? 'Model picker' : sessionPicker ? 'Resume >' : `${agentName} · ${activeSessionId.slice(0, 18)} >`}
      >
        <input
          ref={(value) => { inputRef.current = value; }}
          focused={!isProcessing && !modelPicker}
          value={draft}
          placeholder={isProcessing ? 'Waiting for response...' : modelPicker ? 'Select a model or Esc' : sessionPicker ? 'Type session number/id or /cancel' : 'Type a message or /help'}
          onInput={setDraft}
          onSubmit={onSubmit}
        />
      </box>

      {modelPicker ? (
        <ModelPickerOverlay
          models={modelPicker.models}
          currentSpec={model}
          terminal={{ width, height }}
          loading={modelPicker.loading}
          error={modelPicker.error}
          onSelect={(entry) => { void selectModel(entry); }}
        />
      ) : (
        <CommandHintOverlay commands={commandHints} terminal={{ width, height }} />
      )}
      {pendingConsent && <DeviceConsentOverlay consent={pendingConsent} terminal={{ width, height }} />}
    </box>
  );
}

async function listCloudModels(origin: string, token: string): Promise<TuiModelEntry[]> {
  const rows = normalizeModelEntries(await listCloudAvailableModels(origin, token))
    .map((entry) => ({ ...entry, source: 'cloud' as const }));
  if (rows.length === 0) throw new Error('No cloud models are available.');
  return dedupeModels(rows);
}

function dedupeModels(rows: TuiModelEntry[]): TuiModelEntry[] {
  const bySpec = new Map<string, TuiModelEntry>();
  for (const row of rows) {
    const existing = bySpec.get(row.spec);
    if (!existing) {
      bySpec.set(row.spec, row);
      continue;
    }
    bySpec.set(row.spec, {
      ...existing,
      capabilities: [...new Set([...(existing.capabilities ?? []), ...(row.capabilities ?? [])])],
      source: existing.source === row.source ? existing.source : 'both',
    });
  }
  return [...bySpec.values()].sort((a, b) => modelRank(a) - modelRank(b) || a.label.localeCompare(b.label));
}

function modelRank(model: TuiModelEntry): number {
  if (model.spec.includes('kimi-k2.6')) return 0;
  if (model.provider === 'workers-ai') return 1;
  return 2;
}

function initialMessages(
  agentName: string,
): DisplayMessage[] {
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

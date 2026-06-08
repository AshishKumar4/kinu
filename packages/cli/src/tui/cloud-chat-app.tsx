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
  getConfiguredLocalModelSpec,
  createConfiguredLocalModelResolver,
  type LocalModelResolverOptions,
} from '../local-model-resolver.js';
import { loadConfigFile, upsertAgentConfig } from '../config.js';
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
import { estimateContextTokens, formatContextUsage, modelDisplayName } from './context-status.js';

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

function CloudChatApp({ origin, token, agentName, cloudName, session, sessionOptions, hydrateTranscript, initialPrompt, model: requestedModel, baseUrl, auth }: CloudChatAppOpts) {
  const { width, height } = useTerminalDimensions();
  const [messages, setMessages] = useState<DisplayMessage[]>(() => initialMessages(agentName, session, sessionOptions, hydrateTranscript));
  const [streamingText, setStreamingText] = useState<string | null>(null);
  const [isProcessing, setIsProcessing] = useState(false);
  const [turnPhase, setTurnPhase] = useState<string | null>(null);
  const localResolverOpts: LocalModelResolverOptions = { model: requestedModel, baseUrl, auth };
  const [model, setModel] = useState(() => initialCloudCliModel(agentName, localResolverOpts));
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
      .then((result) => {
        if (cancelled) return;
        const localDefault = getConfiguredLocalModelSpec(localResolverOpts);
        setModel(storedCloudCliModel(agentName) ?? requestedModel ?? localDefault ?? result.spec ?? 'cloud/default');
      })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [agentName, auth, baseUrl, cloudName, origin, requestedModel, token]);

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
      const models = await listCloudAndLocalModels(origin, token, localResolverOpts);
      setModelPicker({ models, loading: false, error: null });
    } catch (err) {
      setModelPicker({
        models: [],
        loading: false,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }, [auth, baseUrl, origin, requestedModel, token]);

  const selectModel = useCallback(async (entry: TuiModelEntry) => {
    try {
      saveCloudCliModel(agentName, entry.spec);
      if (entry.source === 'cloud' || entry.source === 'both') {
        await setCloudAgentModel(origin, token, cloudName, entry.spec);
      }
      setModel(entry.spec);
      setModelPicker(null);
      addMessage({ role: 'system', content: `Model: ${entry.spec}` });
    } catch (err) {
      addMessage({ role: 'system', content: `Error: ${err instanceof Error ? err.message : String(err)}` });
    }
  }, [addMessage, agentName, cloudName, origin, token]);

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
        const normalized = normalizeLocalModelSpec(arg, localResolverOpts) ?? arg;
        saveCloudCliModel(agentName, normalized);
        setModel(normalized);
        addMessage({ role: 'system', content: `Model: ${normalized}` });
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
  }, [addMessage, agentName, auth, baseUrl, cloudName, modelPicker, openModelPicker, origin, requestedModel, resumeSession, sessionOptions, sessionPicker, token]);

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
        modelSpec: model,
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
  }, [addMessage, cloudName, handleSlash, isProcessing, model, origin, resumeSession, sessionPicker, token]);

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
          <span fg="#6b7280">{formatContextUsage(model, contextTokens)}</span>
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
    </box>
  );
}

async function listCloudAndLocalModels(
  origin: string,
  token: string,
  localOpts: LocalModelResolverOptions,
): Promise<TuiModelEntry[]> {
  const [cloud, local] = await Promise.allSettled([
    listCloudAvailableModels(origin, token),
    listLocalModels(localOpts),
  ]);
  const rows: TuiModelEntry[] = [];
  if (cloud.status === 'fulfilled') {
    rows.push(...normalizeModelEntries(cloud.value).map((entry) => ({ ...entry, source: 'cloud' as const })));
  }
  if (local.status === 'fulfilled') {
    rows.push(...normalizeModelEntries(local.value).map((entry) => ({ ...entry, source: 'local' as const })));
  }
  if (rows.length === 0) {
    const reason = [
      cloud.status === 'rejected' ? cloud.reason : null,
      local.status === 'rejected' ? local.reason : null,
    ].filter(Boolean).map(String).join('; ');
    throw new Error(reason || 'No connected model providers.');
  }
  return dedupeModels(rows);
}

async function listLocalModels(localOpts: LocalModelResolverOptions) {
  return await createConfiguredLocalModelResolver(localOpts).resolver.listModels();
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
  if (model.provider === 'codex') return 1;
  if (model.provider === 'openai') return 2;
  if (model.source === 'cloud') return 3;
  return 4;
}

function initialCloudCliModel(agentName: string, opts: LocalModelResolverOptions): string {
  return storedCloudCliModel(agentName) ?? opts.model ?? getConfiguredLocalModelSpec(opts) ?? 'cloud/default';
}

function storedCloudCliModel(agentName: string): string | null {
  return loadConfigFile().agents?.[agentName]?.cliModel ?? null;
}

function saveCloudCliModel(agentName: string, spec: string): void {
  const existing = loadConfigFile().agents?.[agentName];
  if (!existing) return;
  upsertAgentConfig({ ...existing, cliModel: spec });
}

function normalizeLocalModelSpec(spec: string, opts: LocalModelResolverOptions): string | null {
  try {
    return createConfiguredLocalModelResolver({ ...opts, model: spec }).resolver.normalizeSpecSync(spec);
  } catch {
    return null;
  }
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

import { existsSync, readFileSync } from 'node:fs';
import * as readline from 'node:readline';
import { Database } from 'bun:sqlite';
import { createLocalModelResolver, LocalAgentSession, openAgentCLI, resolveChatModel, type SessionEvent } from '@proteus/cli-backend';
import {
  CONFIG_PATH, agentDbPath, createCodexAuthStore, requireAuthConfig, resolveLLMConfig,
  resolveMcpServers, resolveProviderCredentials,
} from '../config.js';
import { resolveAgentTarget, type AgentTarget } from '../agent-target.js';
import {
  createCloudWebhookTrigger,
  executeCloudExecutor,
  getCloudAgentModel,
  getCloudAgentState,
  getCloudAgentStatus,
  getCloudAgentTools,
  getCloudGepaRun,
  getCloudMctsNode,
  getCloudMemoryContent,
  getCloudMctsTree,
  getCloudProductBoard,
  listCloudEvents,
  listCloudExecutors,
  listCloudGepaRuns,
  listCloudHeads,
  listCloudJobs,
  listCloudTimeline,
  listCloudTriggers,
  searchCloudMemory,
  setCloudAgentModel,
  stopCloudAgent,
  type CloudTurnResult,
} from '../cloud-api.js';
import { runCloudTurnWithLocalModel } from '../cloud-local-turn.js';
import { renderCloudTurn } from '../cloud-chat-loop.js';
import { chatCommand } from './chat.js';
import { ensureLocalDaemonRunning } from './daemon.js';
import { ACCENT, DIM, ERR, printToolCall, printToolResult } from '../display.js';
import {
  executeLocalExecutor,
  getLocalAgentState,
  getLocalStoredModel,
  getLocalGepaRun,
  getLocalMctsNode,
  getLocalProductBoard,
  getLocalToolSurface,
  listLocalEvents,
  listLocalExecutors,
  listLocalGepaRuns,
  listLocalHeads,
  listLocalJobs,
  listLocalMcts,
  listLocalTriggers,
  listLocalTimeline,
  markLocalBackgroundJobsCancelled,
  readLocalMemory,
  searchLocalMemory,
  setLocalStoredModel,
} from '../local-inspection.js';
import {
  createCliSession,
  defaultConversationIdForCliOptions,
  type CliSession,
} from '../session.js';
import { recordCliSessionEvent } from '../session-recorder.js';

export async function runCommand(name: string, promptParts: string[], opts: {
  model?: string; baseUrl?: string; auth?: string; classic?: boolean;
  mode?: string; print?: boolean;
  continue?: boolean; resume?: boolean; session?: string; sessionDir?: string; noSession?: boolean; name?: string; fork?: string;
}): Promise<void> {
  const outputMode = normalizeOutputMode(opts.mode);
  const target = resolveAgentTarget(name);
  const canonicalName = target.name;

  if (outputMode === 'rpc') {
    await runRpc(target, opts);
    return;
  }

  const prompt = await buildPrompt(promptParts);

  if (!prompt) {
    await chatCommand(target.requestedName, opts);
    return;
  }

  const session = createCliSession(canonicalName, {
    ...opts,
    conversationId: target.mode === 'local'
      ? defaultConversationIdForCliOptions(opts)
      : undefined,
  });
  session.append('user', { text: prompt, cwd: process.cwd(), backend: target.mode });

  if (target.mode === 'cloud') {
    const auth = requireAuthConfig();
    const result = await runCloudTurnWithLocalModel({
      origin: auth.origin,
      token: auth.token,
      name: target.cloudName,
      prompt,
      cwd: process.cwd(),
    });
    session.append('assistant', { text: result.text, toolCalls: result.toolCalls ?? [], steps: result.steps ?? 0 });
    if (outputMode === 'json') writeCloudJsonEvents(session, canonicalName, result);
    else renderCloudTurn(result);
    return;
  }

  ensureLocalDaemonRunning();
  await runLocalTurn(target.localName, prompt, opts, session, outputMode);
}

async function runLocalTurn(
  name: string,
  prompt: string,
  opts: {
    model?: string; baseUrl?: string; auth?: string;
    noSession?: boolean; session?: string; continue?: boolean; resume?: boolean; fork?: string;
  },
  cliSession: CliSession,
  outputMode: 'text' | 'json',
): Promise<void> {
  const dbPath = agentDbPath(name);
  if (!existsSync(dbPath)) throw new Error(`Agent "${name}" not found. Create it with: proteus create ${name}`);

  const writer = outputMode === 'json' ? new JsonEventWriter(cliSession, name) : null;
  const llmConfig = resolveLLMConfig(opts);
  const providerCredentials = resolveProviderCredentials();
  const codexAuthStore = createCodexAuthStore();
  const modelResolver = createLocalModelResolver({ llm: llmConfig, credentials: providerCredentials, codexAuthStore });
  const mcpServers = resolveMcpServers();
  const db = new Database(dbPath);
  const { rt } = openAgentCLI(db, dbPath, { llm: llmConfig, providerCredentials, codexAuthStore, codexConfigPath: CONFIG_PATH });
  const session = new LocalAgentSession({
    rt,
    db,
    model: resolveChatModel(llmConfig),
    modelResolver,
    sessionId: durableLocalSessionId(opts, cliSession),
    persistMessages: !opts.noSession,
    onEvent: (event) => {
      recordCliSessionEvent(cliSession, event, 'local');
      if (writer) writer.write(event);
      else renderEvent(event);
    },
  });
  if (Object.keys(mcpServers).length > 0) await session.connectMcp(mcpServers);
  try {
    await session.recoverBackgroundJobs();
    await session.send(prompt);
    await session.end();
  } finally {
    db.close();
  }
}

async function runRpc(
  target: AgentTarget,
  opts: {
    model?: string; baseUrl?: string; auth?: string;
    noSession?: boolean; session?: string; continue?: boolean; resume?: boolean; fork?: string;
  },
): Promise<void> {
  const name = target.name;
  const cliSession = createCliSession(name, {
    ...opts,
    conversationId: target.mode === 'local'
      ? defaultConversationIdForCliOptions(opts)
      : undefined,
  });
  const output = (value: unknown) => process.stdout.write(`${JSON.stringify(value)}\n`);
  output({ type: 'session', id: cliSession.id, agent: name, backend: target.mode, cwd: process.cwd() });

  if (target.mode === 'cloud') {
    const auth = requireAuthConfig();
    const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
    for await (const line of rl) {
      if (!line.trim()) continue;
      const cmd = parseRpc(line);
      if (!cmd.ok) { output({ type: 'response', success: false, error: cmd.error }); continue; }
      if (cmd.value.type === 'exit' || cmd.value.type === 'shutdown') break;
      if (cmd.value.type !== 'prompt') {
        try {
          const data = await runCloudRpcCommand(auth.origin, auth.token, target.cloudName, cmd.value);
          output({ id: cmd.value.id, type: 'response', command: cmd.value.type, success: true, data });
        } catch (err) {
          output({ id: cmd.value.id, type: 'response', command: cmd.value.type, success: false, error: err instanceof Error ? err.message : String(err) });
        }
        continue;
      }
      const message = String(cmd.value.message ?? '').trim();
      if (!message) {
        output({ id: cmd.value.id, type: 'response', command: 'prompt', success: false, error: 'message required' });
        continue;
      }
      cliSession.append('user', { text: message, backend: 'cloud' });
      output({ type: 'turn_start', id: cmd.value.id });
      const result = await runCloudTurnWithLocalModel({
        origin: auth.origin,
        token: auth.token,
        name: target.cloudName,
        prompt: message,
        cwd: process.cwd(),
      });
      cliSession.append('assistant', { text: result.text, toolCalls: result.toolCalls ?? [], steps: result.steps ?? 0 });
      output({ type: 'message_end', role: 'assistant', text: result.text });
      output({ id: cmd.value.id, type: 'response', command: 'prompt', success: true });
      output({ type: 'turn_end', steps: result.steps ?? 0 });
    }
    return;
  }

  const localAgentName = target.localName;
  const dbPath = agentDbPath(localAgentName);
  if (!existsSync(dbPath)) throw new Error(`Agent "${localAgentName}" not found. Create it with: proteus create ${localAgentName}`);
  let db: Database | null = null;
  let session: LocalAgentSession | null = null;

  const ensureSession = async (): Promise<LocalAgentSession> => {
    if (session) return session;
    ensureLocalDaemonRunning();
    const llmConfig = resolveLLMConfig(opts);
    const providerCredentials = resolveProviderCredentials();
    const codexAuthStore = createCodexAuthStore();
    const modelResolver = createLocalModelResolver({ llm: llmConfig, credentials: providerCredentials, codexAuthStore });
    const mcpServers = resolveMcpServers();
    db = new Database(dbPath);
    const { rt } = openAgentCLI(db, dbPath, { llm: llmConfig, providerCredentials, codexAuthStore, codexConfigPath: CONFIG_PATH });
    session = new LocalAgentSession({
      rt,
      db,
      model: resolveChatModel(llmConfig),
      modelResolver,
      sessionId: durableLocalSessionId(opts, cliSession),
      persistMessages: !opts.noSession,
      onEvent: (event) => {
        recordCliSessionEvent(cliSession, event, 'local');
        output({ type: 'event', event });
      },
    });
    if (Object.keys(mcpServers).length > 0) await session.connectMcp(mcpServers);
    await session.recoverBackgroundJobs();
    return session;
  };

  try {
    const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
    for await (const line of rl) {
      if (!line.trim()) continue;
      const cmd = parseRpc(line);
      if (!cmd.ok) { output({ type: 'response', success: false, error: cmd.error }); continue; }
      if (cmd.value.type === 'exit' || cmd.value.type === 'shutdown') break;
      if (cmd.value.type !== 'prompt') {
        try {
          const data = await runLocalRpcCommand(localAgentName, cmd.value, session, cliSession.id);
          output({ id: cmd.value.id, type: 'response', command: cmd.value.type, success: true, data });
        } catch (err) {
          output({ id: cmd.value.id, type: 'response', command: cmd.value.type, success: false, error: err instanceof Error ? err.message : String(err) });
        }
        continue;
      }
      const message = String(cmd.value.message ?? '').trim();
      if (!message) {
        output({ id: cmd.value.id, type: 'response', command: 'prompt', success: false, error: 'message required' });
        continue;
      }
      cliSession.append('user', { text: message, backend: 'local' });
      await (await ensureSession()).send(message);
      output({ id: cmd.value.id, type: 'response', command: 'prompt', success: true });
    }
  } finally {
    const liveSession = session as LocalAgentSession | null;
    const liveDb = db as Database | null;
    await liveSession?.end().catch(() => {});
    liveDb?.close();
  }
}

async function runCloudRpcCommand(origin: string, token: string, name: string, cmd: Record<string, unknown>): Promise<unknown> {
  const type = String(cmd.type);
  switch (type) {
    case 'get_state':
    case 'state':
      return getCloudAgentState(origin, token, name);
    case 'status':
      return getCloudAgentStatus(origin, token, name);
    case 'tools':
      return getCloudAgentTools(origin, token, name);
    case 'model': {
      const spec = stringField(cmd, 'spec');
      return spec ? setCloudAgentModel(origin, token, name, spec) : getCloudAgentModel(origin, token, name);
    }
    case 'triggers':
      return listCloudTriggers(origin, token, name);
    case 'jobs':
      return listCloudJobs(origin, token, name, numberField(cmd, 'limit') ?? 20);
    case 'memory': {
      const query = stringField(cmd, 'query');
      return query
        ? searchCloudMemory(origin, token, name, query, numberField(cmd, 'limit') ?? 10)
        : getCloudMemoryContent(origin, token, name);
    }
    case 'events':
      return listCloudEvents(origin, token, name, {
        variant: stringField(cmd, 'variant'),
        since: numberField(cmd, 'since'),
        limit: numberField(cmd, 'limit') ?? 50,
      });
    case 'timeline':
      return listCloudTimeline(origin, token, name, { limit: numberField(cmd, 'limit') ?? 100 });
    case 'mcts': {
      const nodeId = stringField(cmd, 'nodeId') ?? stringField(cmd, 'id');
      return nodeId ? getCloudMctsNode(origin, token, name, nodeId) : getCloudMctsTree(origin, token, name);
    }
    case 'heads':
      return listCloudHeads(origin, token, name, numberField(cmd, 'limit') ?? 20);
    case 'gepa': {
      const runId = stringField(cmd, 'runId') ?? stringField(cmd, 'id');
      return runId ? getCloudGepaRun(origin, token, name, runId) : listCloudGepaRuns(origin, token, name, numberField(cmd, 'limit') ?? 20);
    }
    case 'executors':
      return listCloudExecutors(origin, token, name);
    case 'exec': {
      const executor = stringField(cmd, 'executor') ?? stringField(cmd, 'executorId');
      const command = stringField(cmd, 'command');
      if (!executor) throw new Error('executor required');
      if (!command) throw new Error('command required');
      return executeCloudExecutor(origin, token, name, executor, command);
    }
    case 'product':
      return getCloudProductBoard(origin, token, name, numberField(cmd, 'limit') ?? 20);
    case 'stop':
      return stopCloudAgent(origin, token, name);
    case 'webhook': {
      const label = stringField(cmd, 'label');
      if (!label) throw new Error('label required');
      return createCloudWebhookTrigger(origin, token, name, {
        label,
        auth_mode: webhookAuthMode(stringField(cmd, 'authMode') ?? stringField(cmd, 'auth_mode')),
        ...(stringField(cmd, 'secret') ? { secret: stringField(cmd, 'secret') } : {}),
        ...(stringField(cmd, 'contentType') ? { accepted_content_type: stringField(cmd, 'contentType') } : {}),
        ...(numberField(cmd, 'rateLimit') ? { rate_limit_per_min: numberField(cmd, 'rateLimit') } : {}),
      });
    }
    default:
      throw new Error('Unsupported command');
  }
}

async function runLocalRpcCommand(name: string, cmd: Record<string, unknown>, session: LocalAgentSession | null, sessionId: string): Promise<unknown> {
  const type = String(cmd.type);
  switch (type) {
    case 'get_state':
    case 'state':
      return {
        ...(getLocalAgentState(name) as Record<string, unknown>),
        sessionId,
        tools: session ? session.toolNames() : getLocalToolSurface(name),
        model: session ? session.getEffectiveModelSpec() : getLocalStoredModel(name).spec,
      };
    case 'status':
      return getLocalAgentState(name);
    case 'tools':
      return session ? session.describeTools() : getLocalToolSurface(name);
    case 'model': {
      const spec = stringField(cmd, 'spec');
      return spec
        ? (session ? session.setModel(spec) : setLocalStoredModel(name, spec))
        : (session ? session.getStoredModelSpec() : getLocalStoredModel(name));
    }
    case 'triggers':
      return session ? session.listTriggers() : listLocalTriggers(name);
    case 'jobs':
      return session ? session.listBackgroundJobs(numberField(cmd, 'limit') ?? 20) : listLocalJobs(name, numberField(cmd, 'limit') ?? 20);
    case 'memory': {
      const query = stringField(cmd, 'query');
      return query ? searchLocalMemory(name, query, numberField(cmd, 'limit') ?? 10) : { content: readLocalMemory(name) };
    }
    case 'events':
      return listLocalEvents(name, {
        variant: stringField(cmd, 'variant'),
        since: numberField(cmd, 'since'),
        limit: numberField(cmd, 'limit') ?? 50,
      });
    case 'timeline':
      return listLocalTimeline(name, numberField(cmd, 'limit') ?? 100);
    case 'mcts': {
      const nodeId = stringField(cmd, 'nodeId') ?? stringField(cmd, 'id');
      return nodeId ? getLocalMctsNode(name, nodeId) : listLocalMcts(name);
    }
    case 'heads':
      return listLocalHeads(name, numberField(cmd, 'limit') ?? 20);
    case 'gepa': {
      const runId = stringField(cmd, 'runId') ?? stringField(cmd, 'id');
      return runId ? getLocalGepaRun(name, runId) : listLocalGepaRuns(name, numberField(cmd, 'limit') ?? 20);
    }
    case 'executors':
      return listLocalExecutors();
    case 'exec': {
      const executor = stringField(cmd, 'executor') ?? stringField(cmd, 'executorId');
      const command = stringField(cmd, 'command');
      if (!executor) throw new Error('executor required');
      if (!command) throw new Error('command required');
      return executeLocalExecutor(name, executor, command);
    }
    case 'product':
      return getLocalProductBoard(name, numberField(cmd, 'limit') ?? 20);
    case 'stop':
      session?.interrupt();
      return { interrupted: true, cancelledBackgroundJobs: markLocalBackgroundJobsCancelled(name) };
    default:
      throw new Error('Unsupported command');
  }
}

function stringField(cmd: Record<string, unknown>, key: string): string | undefined {
  const value = cmd[key];
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function numberField(cmd: Record<string, unknown>, key: string): number | undefined {
  const value = cmd[key];
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim()) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

function webhookAuthMode(value: string | undefined): 'hmac' | 'bearer' | 'mtls' {
  const raw = (value ?? 'hmac').toLowerCase();
  if (raw === 'hmac' || raw === 'bearer' || raw === 'mtls') return raw;
  throw new Error('authMode must be hmac, bearer, or mtls');
}

function durableLocalSessionId(opts: {
  noSession?: boolean;
  session?: string;
  continue?: boolean;
  resume?: boolean;
  fork?: string;
}, cliSession: CliSession): string {
  if (opts.noSession) return cliSession.id;
  return cliSession.conversationId;
}

function renderEvent(event: SessionEvent): void {
  switch (event.type) {
    case 'text-delta':
      process.stdout.write(event.delta);
      break;
    case 'tool-call':
      printToolCall(event.toolName, event.args);
      break;
    case 'tool-result':
      printToolResult(event.result);
      break;
    case 'error':
      console.log(`\n${ERR('error')} ${event.message}`);
      break;
    case 'turn-end':
      console.log('');
      break;
    case 'turn-start':
    case 'evolution':
    case 'broadcast':
      break;
  }
}

async function buildPrompt(parts: string[]): Promise<string> {
  const stdin = !process.stdin.isTTY ? await new Response(Bun.stdin.stream()).text() : '';
  const chunks: string[] = [];
  for (const part of parts) {
    if (part.startsWith('@') && part.length > 1) {
      const path = part.slice(1);
      const content = readFileSync(path, 'utf-8');
      chunks.push(`<file path="${escapeAttr(path)}">\n${content}\n</file>`);
    } else {
      chunks.push(part);
    }
  }
  if (stdin.trim()) chunks.push(`<stdin>\n${stdin.trim()}\n</stdin>`);
  return chunks.join(' ').trim();
}

function writeCloudJsonEvents(session: CliSession, agent: string, result: CloudTurnResult): void {
  const output = (value: unknown) => process.stdout.write(`${JSON.stringify(value)}\n`);
  output({ type: 'session', id: session.id, agent, backend: 'cloud', cwd: process.cwd() });
  output({ type: 'turn_start', kind: 'user' });
  for (const call of result.toolCalls ?? []) {
    output({ type: 'tool_call', toolName: call.name, args: call.args });
    if (call.result !== undefined) output({ type: 'tool_result', toolName: call.name, result: call.result });
  }
  output({ type: 'message_end', role: 'assistant', text: result.text });
  output({ type: 'turn_end', steps: result.steps ?? 0 });
}

class JsonEventWriter {
  private wroteHeader = false;
  constructor(private readonly session: CliSession, private readonly agent: string) {}
  write(event: SessionEvent): void {
    if (!this.wroteHeader) {
      process.stdout.write(`${JSON.stringify({ type: 'session', id: this.session.id, agent: this.agent, backend: 'local', cwd: process.cwd() })}\n`);
      this.wroteHeader = true;
    }
    for (const value of localJsonEvents(event)) {
      process.stdout.write(`${JSON.stringify(value)}\n`);
    }
  }
}

function localJsonEvents(event: SessionEvent): unknown[] {
  switch (event.type) {
    case 'turn-start':
      return [{ type: 'turn_start', kind: event.kind, text: event.text, ...(event.event ? { event: event.event } : {}) }];
    case 'text-delta':
      return [{ type: 'message_delta', role: 'assistant', delta: event.delta }];
    case 'tool-call':
      return [{ type: 'tool_call', toolName: event.toolName, args: event.args }];
    case 'tool-result':
      return [{ type: 'tool_result', toolName: event.toolName, result: event.result }];
    case 'turn-end':
      return [
        { type: 'message_end', role: 'assistant', text: event.turn.assistantResponse },
        { type: 'turn_end', steps: event.turn.steps, durationMs: event.turn.durationMs, hadError: event.turn.hadError },
      ];
    case 'error':
      return [{ type: 'error', message: event.message }];
    case 'evolution':
      return [{ type: 'evolution', event: event.event, message: event.message }];
    case 'broadcast':
      return [{ type: 'broadcast', event: event.event }];
  }
}

function parseRpc(line: string): { ok: true; value: Record<string, unknown> } | { ok: false; error: string } {
  try {
    const value = JSON.parse(line) as unknown;
    if (!value || typeof value !== 'object' || !('type' in value)) return { ok: false, error: 'Command must be an object with type' };
    return { ok: true, value: value as Record<string, unknown> };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

function escapeAttr(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
}

function normalizeOutputMode(raw: string | undefined): 'text' | 'json' | 'rpc' {
  const mode = (raw ?? 'text').toLowerCase();
  if (mode === 'text' || mode === 'json' || mode === 'rpc') return mode;
  throw new Error('--mode must be text, json, or rpc');
}

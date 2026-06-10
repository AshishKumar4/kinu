import * as readline from 'node:readline';
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
} from '../cloud-api.js';
import { requireAuthConfig } from '../config.js';
import { resolveAgentTarget, type AgentTarget } from '../agent-target.js';
import { createAgentClient } from '../client-factory.js';
import type { AgentClient, AgentClientEvent } from '../agent-client.js';
import { chatCommand } from './chat.js';
import { ensureLocalDaemonRunning } from './daemon.js';
import { resolvePromptAttachments } from '../attachments.js';
import { watchTerminalConsents } from '../consent-watch.js';
import { ERR, printToolCall, printToolResult } from '../display.js';
import {
  executeLocalExecutor,
  getLocalAgentState,
  getLocalGepaRun,
  getLocalMctsNode,
  getLocalProductBoard,
  getLocalToolSurface,
  listLocalEvents,
  listLocalExecutors,
  listLocalGepaRuns,
  listLocalHeads,
  listLocalMcts,
  listLocalTriggers,
  listLocalTimeline,
  markLocalBackgroundJobsCancelled,
  readLocalMemory,
  searchLocalMemory,
} from '../local-inspection.js';

export async function runCommand(name: string, promptParts: string[], opts: {
  model?: string; baseUrl?: string; auth?: string; classic?: boolean;
  mode?: string;
  continue?: boolean; resume?: boolean; session?: string; sessionDir?: string; noSession?: boolean; name?: string; fork?: string;
}): Promise<void> {
  const outputMode = normalizeOutputMode(opts.mode);
  const target = resolveAgentTarget(name);

  if (outputMode === 'rpc') {
    await runRpc(target, opts);
    return;
  }

  const rawPrompt = await buildPrompt(promptParts);

  if (!rawPrompt) {
    await chatCommand(target.requestedName, opts);
    return;
  }

  // Same @path semantics as the chat surfaces: images/PDFs inline as file
  // parts, other files stay path references the agent reads with its tools.
  const prompt = await resolvePromptAttachments(rawPrompt);
  for (const problem of prompt.errors) console.error(`${ERR('error')} ${problem}`);

  if (target.mode === 'local') ensureLocalDaemonRunning();
  const client = createAgentClient(target, opts);
  const render = outputMode === 'json' ? createJsonEventWriter(client) : renderRunEvent;
  const unsubscribe = client.subscribe(render);
  const consentWatch = client.consents && outputMode === 'text'
    ? watchTerminalConsents(client.consents, client.agentName, askLineOnce)
    : null;
  try {
    await client.connect();
    await client.send(
      prompt.files.length > 0 ? { text: prompt.text, files: prompt.files } : prompt.text,
      { cwd: process.cwd() },
    );
  } finally {
    consentWatch?.stop();
    unsubscribe();
    await client.close();
  }
}

/** One-shot runs have no resident readline — open one per consent question
 *  and close it as soon as the line (or an abort) settles. */
function askLineOnce(question: string, signal: AbortSignal): Promise<string | null> {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    let settled = false;
    const settle = (answer: string | null) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener('abort', onAbort);
      rl.close();
      resolve(answer);
    };
    const onAbort = () => settle(null);
    signal.addEventListener('abort', onAbort, { once: true });
    rl.once('close', () => settle(null));
    rl.question(question, settle);
  });
}

async function runRpc(
  target: AgentTarget,
  opts: {
    model?: string; baseUrl?: string; auth?: string;
    noSession?: boolean; session?: string; sessionDir?: string; continue?: boolean; resume?: boolean; fork?: string; name?: string;
  },
): Promise<void> {
  const output = (value: unknown) => process.stdout.write(`${JSON.stringify(value)}\n`);

  if (target.mode === 'cloud') {
    const auth = requireAuthConfig();
    const client = createAgentClient(target, opts);
    output({ type: 'session', id: client.cliSession.id, agent: target.name, backend: 'cloud', cwd: process.cwd() });
    const unsubscribe = client.subscribe((event) => output({ type: 'event', event }));
    const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
    try {
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
        output({ type: 'turn_start', id: cmd.value.id });
        const result = await client.send(message, { cwd: process.cwd() });
        output({ type: 'message_end', role: 'assistant', text: result.text });
        output({ id: cmd.value.id, type: 'response', command: 'prompt', success: true });
        output({ type: 'turn_end', steps: result.steps });
      }
    } finally {
      unsubscribe();
      await client.close();
    }
    return;
  }

  ensureLocalDaemonRunning();
  const client = createAgentClient(target, opts);
  client.subscribe((event) => output({ type: 'event', event }));
  output({ type: 'session', id: client.cliSession.id, agent: target.name, backend: 'local', cwd: process.cwd() });
  // Defer MCP connection and job recovery until the first prompt.
  let connected = false;
  const ensureConnected = async () => {
    if (connected) return;
    connected = true;
    await client.connect();
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
          const data = await runLocalRpcCommand(target.localName, cmd.value, client);
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
      await ensureConnected();
      await client.send(message, { cwd: process.cwd() });
      output({ id: cmd.value.id, type: 'response', command: 'prompt', success: true });
    }
  } finally {
    await client.close().catch(() => {});
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

async function runLocalRpcCommand(name: string, cmd: Record<string, unknown>, client: AgentClient): Promise<unknown> {
  const type = String(cmd.type);
  switch (type) {
    case 'get_state':
    case 'state':
      return {
        ...(getLocalAgentState(name) as Record<string, unknown>),
        sessionId: client.cliSession.id,
        tools: getLocalToolSurface(name),
        model: await client.getModelSpec(),
      };
    case 'status':
      return getLocalAgentState(name);
    case 'tools':
      return client.describeTools();
    case 'model': {
      const spec = stringField(cmd, 'spec');
      return spec ? client.setModel(spec) : { spec: await client.getModelSpec() };
    }
    case 'triggers':
      return listLocalTriggers(name);
    case 'jobs':
      return client.listJobs(numberField(cmd, 'limit') ?? 20);
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
      client.stop();
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

/** Plain streaming renderer for one-shot runs (pipe-friendly: raw deltas). */
function renderRunEvent(event: AgentClientEvent): void {
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
    case 'step-finish':
    case 'evolution':
    case 'broadcast':
      break;
  }
}

function createJsonEventWriter(client: AgentClient): (event: AgentClientEvent) => void {
  let wroteHeader = false;
  const output = (value: unknown) => process.stdout.write(`${JSON.stringify(value)}\n`);
  return (event) => {
    if (!wroteHeader) {
      wroteHeader = true;
      output({ type: 'session', id: client.cliSession.id, agent: client.agentName, backend: client.mode, cwd: process.cwd() });
    }
    for (const value of jsonEvents(event)) output(value);
  };
}

function jsonEvents(event: AgentClientEvent): unknown[] {
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
        { type: 'message_end', role: 'assistant', text: event.turn.text },
        { type: 'turn_end', steps: event.turn.steps, durationMs: event.turn.durationMs, hadError: event.turn.hadError },
      ];
    case 'step-finish':
      return [];
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

async function buildPrompt(parts: string[]): Promise<string> {
  const stdin = !process.stdin.isTTY ? await new Response(Bun.stdin.stream()).text() : '';
  const chunks = [...parts];
  if (stdin.trim()) chunks.push(`<stdin>\n${stdin.trim()}\n</stdin>`);
  return chunks.join(' ').trim();
}

function normalizeOutputMode(raw: string | undefined): 'text' | 'json' | 'rpc' {
  const mode = (raw ?? 'text').toLowerCase();
  if (mode === 'text' || mode === 'json' || mode === 'rpc') return mode;
  throw new Error('--mode must be text, json, or rpc');
}

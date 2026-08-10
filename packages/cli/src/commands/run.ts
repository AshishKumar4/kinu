import * as readline from 'node:readline';
import { callAgentRpc, createCloudWebhookTrigger } from '../cloud-api.js';
import { listConfiguredAgentRefs, requireAuthConfig } from '../config.js';
import { resolveAgentTarget, type AgentTarget } from '../agent-target.js';
import { createAgentClient, type AgentClientFlags } from '../client-factory.js';
import type { AgentClient, AgentClientEvent } from '../agent-client.js';
import type { CliSessionOptions } from '../session.js';
import { chatCommand } from './chat.js';
import { ensureLocalDaemonRunning } from './daemon.js';
import { resolvePromptAttachments } from '../attachments.js';
import { watchHeadlessConsents, watchTerminalConsents } from '../consent-watch.js';
import { ERR, formatFailure, printFailure, printToolCall, printToolResult } from '../display.js';
import { guideFailure } from '../provider-guidance.js';
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

/** Session flags as Commander actually delivers them: `--no-session` arrives
 *  as `session: false` on the shared option key, not as `noSession: true`. */
interface OneShotSessionFlags {
  continue?: boolean;
  resume?: boolean;
  session?: string | false;
  sessionDir?: string;
  noSession?: boolean;
  name?: string;
  fork?: string;
}

export async function runCommand(name: string, promptParts: string[], opts: AgentClientFlags & OneShotSessionFlags & {
  classic?: boolean;
  mode?: string;
}): Promise<void> {
  const outputMode = normalizeOutputMode(opts.mode);
  const target = resolveAgentTarget(name);

  if (outputMode === 'rpc') {
    await runRpc(target, opts);
    return;
  }

  const rawPrompt = await buildPrompt(promptParts);

  if (!rawPrompt) {
    await chatCommand(target.requestedName, {
      model: opts.model,
      baseUrl: opts.baseUrl,
      auth: opts.auth,
      classic: opts.classic,
      ...sessionOptions(opts),
    });
    return;
  }

  const failed = await runOneShot(target, rawPrompt, opts, {
    json: outputMode === 'json',
    headless: false,
  });
  exitOneShot(failed);
}

export interface ExecOptions extends Omit<AgentClientFlags, 'noAutoEvolve'> {
  workspace?: string;
  json?: boolean;
  /** Commander delivers `--no-auto-evolve` as `autoEvolve: false`. */
  autoEvolve?: boolean;
  resume?: string;
  session?: string | false;
  sessionDir?: string;
  name?: string;
}

/**
 * `proteus exec` — the headless face of the one-shot run machinery. Built for
 * CI: no prompts of any kind (device consents are denied, fail closed, with
 * pre-authorization instructions), `--json` streams line-delimited events,
 * and the exit code is honest — 0 only when the turn completed without
 * errors or denied consents.
 */
export async function execCommand(promptParts: string[], opts: ExecOptions): Promise<void> {
  const rawPrompt = await buildPrompt(promptParts);
  if (!rawPrompt) {
    throw new Error('A task prompt is required. Usage: proteus exec "task" [--workspace <name>] [--json]');
  }
  const target = resolveAgentTarget(resolveExecWorkspaceName(opts.workspace));
  const failed = await runOneShot(target, rawPrompt, {
    model: opts.model,
    baseUrl: opts.baseUrl,
    auth: opts.auth,
    noAutoEvolve: opts.autoEvolve === false,
    session: opts.resume ?? opts.session,
    sessionDir: opts.sessionDir,
    name: opts.name,
  }, {
    json: opts.json === true,
    headless: true,
  });
  exitOneShot(failed);
}

/**
 * End the one-shot command.
 *
 * A one-shot run is over once its turn and its bounded background drain are:
 * there is nothing left for this process to do. It still cannot simply return,
 * because the shell it ran commands through keeps a handle on every child it
 * spawned — so a `run` the agent deliberately left running in the background (a
 * server, a VM, a training job) holds the process open long after the answer was
 * printed. That was measured at 6.4 of 16.2 agent-hours of pure idle tail across
 * an 89-task benchmark run, all of it after the agent had already finished.
 *
 * Exiting here does not disturb that work: every child is spawned into its own
 * process group and outlives us, which is precisely what "I left it running"
 * has to mean for the task that asked for a running server.
 */
function exitOneShot(failed: boolean): never {
  process.exit(failed ? 1 : 0);
}

/** exec is non-interactive, so an omitted --workspace only works when there
 *  is exactly one configured workspace to mean. */
function resolveExecWorkspaceName(explicit?: string): string {
  if (explicit?.trim()) return explicit.trim();
  const agents = listConfiguredAgentRefs();
  if (agents.length === 1) return agents[0]!.name;
  throw new Error(agents.length === 0
    ? 'No workspaces configured. Create one with: proteus create <name>, or pass --workspace <name>.'
    : `Multiple workspaces configured — pass --workspace <name>. Configured: ${agents.map((a) => a.name).join(', ')}.`);
}

/**
 * The single one-shot run path behind `proteus run <name> "prompt"` and
 * `proteus exec`: resolve attachments, stream the turn through the
 * AgentClient seam, watch device consents (interactively or fail-closed),
 * and report whether anything failed.
 */
async function runOneShot(
  target: AgentTarget,
  rawPrompt: string,
  opts: AgentClientFlags & OneShotSessionFlags,
  surface: { json: boolean; headless: boolean },
): Promise<boolean> {
  // Same @path semantics as the chat surfaces: images/PDFs inline as file
  // parts, other files stay path references the agent reads with its tools.
  const prompt = await resolvePromptAttachments(rawPrompt);
  for (const problem of prompt.errors) console.error(`${ERR('error')} ${problem}`);

  // The daemon is this process's deferred-work host: a one-shot run never
  // starts the cadence-heavy evolution pass it cannot finish, so the daemon is
  // what eventually runs it (see AgentOrchestrator's exit contract).
  if (target.mode === 'local') ensureLocalDaemonRunning();
  const client = createAgentClient(
    target,
    { model: opts.model, baseUrl: opts.baseUrl, auth: opts.auth, noAutoEvolve: opts.noAutoEvolve, ...sessionOptions(opts) },
    'one-shot',
  );

  let failed = false;
  const render = surface.json ? createJsonEventWriter(client) : renderRunEvent;
  const unsubscribe = client.subscribe((event) => {
    if (event.type === 'error') failed = true;
    render(event);
  });
  const consentWatch = !client.consents
    ? null
    : surface.headless
      ? watchHeadlessConsents(client.consents, client.agentName, { json: surface.json, onDenied: () => { failed = true; } })
      : surface.json
        ? null
        : watchTerminalConsents(client.consents, client.agentName, askLineOnce);
  try {
    await client.connect();
    const result = await client.send(
      prompt.files.length > 0 ? { text: prompt.text, files: prompt.files } : prompt.text,
      { cwd: process.cwd() },
    );
    if (result.hadError) failed = true;
    // A tool that auto-detached (>30s) ends the turn early; its result arrives
    // as a wake turn. This one-shot process exits after send(), so drain those
    // wake turns to completion HERE — while the subscription is still live, so
    // their events stream — instead of losing the second half of the work.
    await client.settleBackgroundWork?.();
  } catch (err) {
    // In-stream failures already surfaced as an error event; only report
    // failures that never reached the stream (connect, ticket, transport).
    const alreadyReported = failed;
    failed = true;
    if (!alreadyReported) {
      if (surface.json) process.stdout.write(`${JSON.stringify({ type: 'error', ...guideFailure(err) })}\n`);
      else printFailure(err);
    }
  } finally {
    consentWatch?.stop();
    unsubscribe();
    await client.close();
  }
  return failed;
}

function sessionOptions(opts: OneShotSessionFlags): CliSessionOptions {
  return {
    continue: opts.continue,
    resume: opts.resume === true,
    session: typeof opts.session === 'string' ? opts.session : undefined,
    sessionDir: opts.sessionDir,
    noSession: opts.noSession === true || opts.session === false,
    name: opts.name,
    fork: opts.fork,
  };
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
  opts: AgentClientFlags & OneShotSessionFlags,
): Promise<void> {
  const output = (value: unknown) => process.stdout.write(`${JSON.stringify(value)}\n`);
  const clientOpts = { model: opts.model, baseUrl: opts.baseUrl, auth: opts.auth, ...sessionOptions(opts) };

  if (target.mode === 'cloud') {
    const auth = requireAuthConfig();
    const client = createAgentClient(target, clientOpts);
    output({ type: 'session', id: client.cliSession.id, workspace: target.name, backend: 'cloud', cwd: process.cwd() });
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
  const client = createAgentClient(target, clientOpts);
  client.subscribe((event) => output({ type: 'event', event }));
  output({ type: 'session', id: client.cliSession.id, workspace: target.name, backend: 'local', cwd: process.cwd() });
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
  const rpc = (method: string, args: unknown[] = []) => callAgentRpc(origin, token, name, method, args);
  const type = String(cmd.type);
  switch (type) {
    case 'get_state':
    case 'state':
      return rpc('getWorkspaceSnapshot');
    case 'status':
      return rpc('getAgentStatus');
    case 'tools':
      return rpc('getToolDescriptions');
    case 'model': {
      const spec = stringField(cmd, 'spec');
      return spec ? rpc('setModel', [spec]) : rpc('getStoredModelSpec');
    }
    case 'triggers':
      return rpc('listTriggers');
    case 'jobs':
      return rpc('listBackgroundJobs', [numberField(cmd, 'limit') ?? 20]);
    case 'memory': {
      const query = stringField(cmd, 'query');
      return query
        ? rpc('searchMemoryHybrid', [query, numberField(cmd, 'limit') ?? 10])
        : { content: await rpc('getMemoryContent') };
    }
    case 'events':
      return rpc('listRecentEvents', [{
        variant: stringField(cmd, 'variant'),
        since: numberField(cmd, 'since'),
        limit: numberField(cmd, 'limit') ?? 50,
      }]);
    case 'timeline':
      return rpc('getRunTimeline', [{ limit: numberField(cmd, 'limit') ?? 100 }]);
    case 'mcts': {
      const nodeId = stringField(cmd, 'nodeId') ?? stringField(cmd, 'id');
      return nodeId ? rpc('getMctsNodeDetail', [nodeId]) : rpc('getMctsTree');
    }
    case 'heads':
      return rpc('getHeadRuns', [numberField(cmd, 'limit') ?? 20]);
    case 'gepa': {
      const runId = stringField(cmd, 'runId') ?? stringField(cmd, 'id');
      return runId ? rpc('getGepaRun', [runId]) : rpc('getGepaRuns', [numberField(cmd, 'limit') ?? 20]);
    }
    case 'executors':
      return rpc('getExecutors');
    case 'exec': {
      const executor = stringField(cmd, 'executor') ?? stringField(cmd, 'executorId');
      const command = stringField(cmd, 'command');
      if (!executor) throw new Error('executor required');
      if (!command) throw new Error('command required');
      return rpc('executeInExecutor', [executor, command]);
    }
    case 'product':
      return rpc('getProductChangeBoard', [numberField(cmd, 'limit') ?? 20]);
    case 'stop':
      return rpc('cancelCurrentWork');
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
      console.log(`\n${formatFailure(event.message)}`);
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
      output({ type: 'session', id: client.cliSession.id, workspace: client.agentName, backend: client.mode, cwd: process.cwd() });
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
        {
          type: 'turn_end',
          steps: event.turn.steps,
          durationMs: event.turn.durationMs,
          hadError: event.turn.hadError,
          ...(event.turn.usage ? { usage: event.turn.usage } : {}),
        },
      ];
    case 'step-finish':
      return [];
    case 'error':
      return [{ type: 'error', ...guideFailure(event.message) }];
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

/** Grace period for OPTIONAL stdin — see buildPrompt. Long enough for a real
 *  pipe that already holds data, short enough that a harness which inherits an
 *  idle stdin is not stalled. */
const OPTIONAL_STDIN_GRACE_MS = 250;

async function readStdin(): Promise<string> {
  return await new Response(Bun.stdin.stream()).text();
}

/**
 * Assemble the turn prompt from argv and, where it makes sense, stdin.
 *
 * When argv carries no prompt, stdin IS the prompt (`cat notes | proteus exec`)
 * and waiting for EOF is correct. When argv already carries one, stdin is
 * supplementary context — and waiting on it hangs forever against a pipe that
 * is open but idle, which is exactly what a harness or CI runner inherits.
 * That hang made every scripted use of `proteus exec` require a `</dev/null`
 * incantation to work at all.
 */
async function buildPrompt(parts: string[]): Promise<string> {
  const chunks = [...parts];
  const argvPrompt = chunks.join(' ').trim();
  let stdin = '';
  if (!process.stdin.isTTY) {
    stdin = argvPrompt
      ? await Promise.race([
          readStdin(),
          new Promise<string>((resolve) => setTimeout(() => resolve(''), OPTIONAL_STDIN_GRACE_MS)),
        ])
      : await readStdin();
  }
  if (stdin.trim()) chunks.push(`<stdin>\n${stdin.trim()}\n</stdin>`);
  return chunks.join(' ').trim();
}

function normalizeOutputMode(raw: string | undefined): 'text' | 'json' | 'rpc' {
  const mode = (raw ?? 'text').toLowerCase();
  if (mode === 'text' || mode === 'json' || mode === 'rpc') return mode;
  throw new Error('--mode must be text, json, or rpc');
}

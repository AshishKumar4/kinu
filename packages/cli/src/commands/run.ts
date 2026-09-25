import * as readline from 'node:readline';
import { callAgentRpc, createCloudWebhookTrigger, type CloudWebhookTriggerInput } from '../cloud-api';
import { listConfiguredAgentRefs, requireAuthConfig } from '../config';
import { resolveAgentTarget, type AgentTarget } from '../agent-target';
import { createAgentClient, type AgentClientFlags } from '../client-factory';
import type { AgentClient, AgentClientEvent } from '../agent-client';
import { decodeJsonValue, JsonValueSchema, parseJsonObject, projectJsonValue, usageReported, ToolOutcomeSchema, type AgentRpcMethod, type JsonObject, type JsonValue } from '@kinu.run/core';
import * as v from 'valibot';
import type { CliSessionOptions } from '../session';
import { chatCommand } from './chat';
import { ensureLocalDaemonRunning } from './daemon';
import { resolvePromptAttachments } from '../attachments';
import { watchHeadlessConsents, watchTerminalConsents, type ConsentWatcher } from '../consent-watch';
import { DIM, ERR, formatFailure, printFailure, printToolCall, printToolResult } from '../display';
import { normalizeWebhookAuthMode, numberField, oneOfFlag, stringField } from '../options';
import { guideFailure } from '../provider-guidance';
import {
  executeLocalExecutor,
  getLocalAgentState,
  getLocalGepaRun,
  getLocalMctsNode,
  getLocalReleaseBoard,
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
} from '../local-inspection';
import { renderThrownChain } from '@kinu.run/core/obs';
import { installTurnDiagnostics } from '../turn-log';

/** `--no-transcript` arrives as `transcript: false`, not `noTranscript: true`. */
interface TranscriptFlags {
  transcript?: boolean;
  transcriptDir?: string;
}

export async function runCommand(name: string, promptParts: string[], opts: AgentClientFlags & TranscriptFlags & {
  classic?: boolean;
  mode?: string;
}): Promise<void> {
  const outputMode = oneOfFlag(opts.mode, '--mode', ['text', 'json', 'rpc']);
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
      ...transcriptOptions(opts),
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
  transcript?: boolean;
  transcriptDir?: string;
}

/** `kinu exec`: headless for CI. Consents fail closed; exit 0 only when the turn completed without errors or denied consents. */
export async function execCommand(promptParts: string[], opts: ExecOptions): Promise<void> {
  const rawPrompt = await buildPrompt(promptParts);

  if (!rawPrompt) {
    throw new Error('A task prompt is required. Usage: kinu exec "task" [--workspace <name>] [--json]');
  }

  const target = resolveAgentTarget(resolveExecWorkspaceName(opts.workspace));

  const failed = await runOneShot(target, rawPrompt, {
    model: opts.model,
    baseUrl: opts.baseUrl,
    auth: opts.auth,
    noAutoEvolve: opts.autoEvolve === false,
    ...transcriptOptions(opts),
  }, {
    json: opts.json === true,
    headless: true,
  });

  exitOneShot(failed);
}

/**
 * Exit rather than return: the shell keeps handles on background children (servers, VMs), which would hold the process open.
 * Each child runs in its own process group, so it outlives this exit.
 */
function exitOneShot(failed: boolean): never {
  process.exit(failed ? 1 : 0);
}

function resolveExecWorkspaceName(explicit?: string): string {
  if (explicit?.trim()) return explicit.trim();
  const agents = listConfiguredAgentRefs();

  if (agents.length === 1) return agents[0].name;
  throw new Error(agents.length === 0
    ? 'No workspaces configured. Create one with: kinu create <name>, or pass --workspace <name>.'
    : `Multiple workspaces configured. Pass --workspace <name>. Configured: ${agents.map((a) => a.name).join(', ')}.`);
}

async function runOneShot(
  target: AgentTarget,
  rawPrompt: string,
  opts: AgentClientFlags & TranscriptFlags,
  surface: { json: boolean; headless: boolean },
): Promise<boolean> {
  // A one-shot run never starts the evolution pass it cannot finish; the daemon runs it (see AgentOrchestrator's exit contract).
  if (target.mode === 'local') ensureLocalDaemonRunning();
  // Diagnostics go to the turn log: in --json mode stderr is empty on success and holds only the error on failure.
  installTurnDiagnostics();

  const client = await createAgentClient(
    target,
    { model: opts.model, baseUrl: opts.baseUrl, auth: opts.auth, noAutoEvolve: opts.noAutoEvolve, ...transcriptOptions(opts) },
    'one-shot',
  );

  // Resolved after the client exists: it reports the backend's inline cap.
  const prompt = await resolvePromptAttachments(rawPrompt, { limitBytes: client.inlineAttachmentLimitBytes });

  for (const problem of prompt.errors) console.error(`${ERR('error')} ${problem}`);

  let failed = false;
  const render = surface.json ? createJsonEventWriter(client) : renderRunEvent;

  const unsubscribe = client.subscribe((event) => {
    if (event.type === 'error') failed = true;
    render(event);
  });

  function startConsentWatch(): ConsentWatcher | null {
    const consents = client.consents;

    if (!consents) return null;

    if (surface.headless) {
      return watchHeadlessConsents(consents, client.agentName, { json: surface.json, onDenied: () => { failed = true; } });
    }

    if (surface.json) return null;

    return watchTerminalConsents(consents, client.agentName, askLineOnce);
  }

  const consentWatch = startConsentWatch();

  try {
    await client.connect();

    const result = await client.send(
      prompt.files.length > 0 ? { text: prompt.text, files: prompt.files } : prompt.text,
      { cwd: process.cwd() },
    );

    if (result.landed === 'turn' && result.hadError) failed = true;
    // A detached tool's wake turn or the completion gate's confirming turn may follow; drain while the subscription is live.
    await client.settleBackgroundWork?.();
  } catch (err) {
    const alreadyReported = failed;
    failed = true;

    if (!alreadyReported) {
      if (surface.json) process.stdout.write(`${JSON.stringify({ type: 'error', ...guideFailure({ cause: err }) })}\n`);
      else printFailure({ cause: err });
    }
  } finally {
    consentWatch?.stop();
    unsubscribe();
    await client.close();
  }

  return failed;
}

function transcriptOptions(opts: TranscriptFlags): CliSessionOptions {
  return {
    transcriptDir: opts.transcriptDir,
    noTranscript: opts.transcript === false,
  };
}

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

/** Both backends answer `model` through the AgentClient contract. */
async function modelRpcCommand(cmd: JsonObject, client: AgentClient): Promise<JsonValue> {
  const spec = stringField(cmd, 'spec');

  return decodeJsonValue({ value: spec ? await client.setModel(spec) : { spec: await client.getModelSpec() } });
}

async function respondToRpcCommand(
  cmd: JsonObject,
  client: AgentClient,
  output: (input: { value: unknown }) => void,
  run: () => Promise<JsonValue>,
): Promise<void> {
  try {
    const data = await (cmd.type === 'model' ? modelRpcCommand(cmd, client) : run());
    output({ value: { id: cmd.id, type: 'response', command: cmd.type, success: true, data } });
  } catch (err) {
    output({ value: { id: cmd.id, type: 'response', command: cmd.type, success: false, error: renderThrownChain({ cause: err }) } });
  }
}

async function runRpc(
  target: AgentTarget,
  opts: AgentClientFlags & TranscriptFlags,
): Promise<void> {
  const output = (input: { value: unknown }) => process.stdout.write(`${JSON.stringify(decodeJsonValue(input))}\n`);
  const clientOpts = { model: opts.model, baseUrl: opts.baseUrl, auth: opts.auth, ...transcriptOptions(opts) };

  if (target.mode === 'cloud') {
    const auth = requireAuthConfig();
    const client = await createAgentClient(target, clientOpts);
    output({ value: { type: 'session', id: client.cliSession.id, workspace: target.name, backend: 'cloud', cwd: process.cwd() } });
    const unsubscribe = client.subscribe((event) => output({ value: { type: 'event', event } }));
    const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });

    try {
      for await (const line of rl) {
        if (!line.trim()) continue;
        const cmd = parseRpc(line);

        if (!cmd.ok) { output({ value: { type: 'response', success: false, error: cmd.error } }); continue; }

        if (cmd.value.type === 'exit' || cmd.value.type === 'shutdown') break;

        if (cmd.value.type !== 'prompt') {
          await respondToRpcCommand(cmd.value, client, output, () => runCloudRpcCommand(auth.origin, auth.token, target.cloudName, cmd.value));
          continue;
        }

        const message = stringField(cmd.value, 'message') ?? '';

        if (!message) {
          output({ value: { id: cmd.value.id, type: 'response', command: 'prompt', success: false, error: 'message required' } });
          continue;
        }

        output({ value: { type: 'turn_start', id: cmd.value.id } });
        const result = await client.send(message, { cwd: process.cwd() });
        const turn = result.landed === 'turn' ? result : { text: '', steps: 0 };
        output({ value: { type: 'message_end', role: 'assistant', text: turn.text } });
        output({ value: { id: cmd.value.id, type: 'response', command: 'prompt', success: true } });
        output({ value: { type: 'turn_end', steps: turn.steps } });
      }
    } finally {
      unsubscribe();
      await client.close();
    }

    return;
  }

  ensureLocalDaemonRunning();
  const client = await createAgentClient(target, clientOpts);
  client.subscribe((event) => output({ value: { type: 'event', event } }));
  output({ value: { type: 'session', id: client.cliSession.id, workspace: target.name, backend: 'local', cwd: process.cwd() } });
  // Client-owned MCP connects on the first prompt; the daemon owns orphaned-job recovery.
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

      if (!cmd.ok) { output({ value: { type: 'response', success: false, error: cmd.error } }); continue; }

      if (cmd.value.type === 'exit' || cmd.value.type === 'shutdown') break;

      if (cmd.value.type !== 'prompt') {
        await respondToRpcCommand(cmd.value, client, output, () => runLocalRpcCommand(target.localName, cmd.value, client));
        continue;
      }

      const message = stringField(cmd.value, 'message') ?? '';

      if (!message) {
        output({ value: { id: cmd.value.id, type: 'response', command: 'prompt', success: false, error: 'message required' } });
        continue;
      }

      await ensureConnected();
      await client.send(message, { cwd: process.cwd() });
      output({ value: { id: cmd.value.id, type: 'response', command: 'prompt', success: true } });
    }
  } finally {
    try {
      await client.close();
    } catch (error) {
      process.stderr.write(`note: closing the workspace client failed: ${renderThrownChain({ cause: error })}\n`);
    }
  }
}

const commandType = (cmd: JsonObject): string => stringField(cmd, 'type') ?? '';

async function runCloudRpcCommand(origin: string, token: string, name: string, cmd: JsonObject): Promise<JsonValue> {
  const rpc = async (method: AgentRpcMethod, args: JsonValue[] = []): Promise<JsonValue> =>
    callAgentRpc({ origin, token, name, method, schema: JsonValueSchema, args });

  const type = commandType(cmd);

  switch (type) {
    case 'get_state':
    case 'state':
      return rpc('getWorkspaceSnapshot');
    case 'status':
      return rpc('getAgentStatus');
    case 'tools':
      return rpc('getToolDescriptions');
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
      {
        const filter: JsonObject = { limit: numberField(cmd, 'limit') ?? 50 };
        const variant = stringField(cmd, 'variant');
        const since = numberField(cmd, 'since');

        if (variant) filter.variant = variant;

        if (since !== undefined) filter.since = since;

        return rpc('listRecentEvents', [filter]);
      }

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
      return rpc('getReleaseBoard', [numberField(cmd, 'limit') ?? 20]);
    case 'stop':
      return rpc('cancelCurrentWork');
    case 'webhook': {
      const label = stringField(cmd, 'label');

      if (!label) throw new Error('label required');

      const input: CloudWebhookTriggerInput = {
        label,
        auth_mode: normalizeWebhookAuthMode(stringField(cmd, 'authMode') ?? stringField(cmd, 'auth_mode')),
      };

      const secret = stringField(cmd, 'secret');
      const contentType = stringField(cmd, 'contentType');
      const rateLimit = numberField(cmd, 'rateLimit');

      if (secret) input.secret = secret;

      if (contentType) input.accepted_content_type = contentType;

      if (rateLimit) input.rate_limit_per_min = rateLimit;

      return decodeJsonValue({ value: await createCloudWebhookTrigger(origin, token, name, input) });
    }

    default:
      throw new Error('Unsupported command');
  }
}

async function runLocalRpcCommand(name: string, cmd: JsonObject, client: AgentClient): Promise<JsonValue> {
  const type = commandType(cmd);

  switch (type) {
    case 'get_state':
    case 'state':
      return decodeJsonValue({ value: {
        ...getLocalAgentState(name),
        sessionId: client.cliSession.id,
        tools: getLocalToolSurface(name),
        model: await client.getModelSpec(),
      } });
    case 'status':
      return decodeJsonValue({ value: getLocalAgentState(name) });
    case 'tools':
      return decodeJsonValue({ value: await client.describeTools() });
    case 'triggers':
      return decodeJsonValue({ value: listLocalTriggers(name) });
    case 'jobs':
      return decodeJsonValue({ value: await client.listJobs(numberField(cmd, 'limit') ?? 20) });
    case 'memory': {
      const query = stringField(cmd, 'query');

      return decodeJsonValue({ value: query ? searchLocalMemory(name, query, numberField(cmd, 'limit') ?? 10) : { content: readLocalMemory(name) } });
    }

    case 'events':
      return decodeJsonValue({ value: listLocalEvents(name, {
        variant: stringField(cmd, 'variant'),
        since: numberField(cmd, 'since'),
        limit: numberField(cmd, 'limit') ?? 50,
      }) });
    case 'timeline':
      return listLocalTimeline(name, numberField(cmd, 'limit') ?? 100);
    case 'mcts': {
      const nodeId = stringField(cmd, 'nodeId') ?? stringField(cmd, 'id');

      return decodeJsonValue({ value: nodeId ? getLocalMctsNode(name, nodeId) : listLocalMcts(name) });
    }

    case 'heads':
      return decodeJsonValue({ value: listLocalHeads(name, numberField(cmd, 'limit') ?? 20) });
    case 'gepa': {
      const runId = stringField(cmd, 'runId') ?? stringField(cmd, 'id');

      return decodeJsonValue({ value: runId ? getLocalGepaRun(name, runId) : listLocalGepaRuns(name, numberField(cmd, 'limit') ?? 20) });
    }

    case 'executors':
      return decodeJsonValue({ value: listLocalExecutors() });
    case 'exec': {
      const executor = stringField(cmd, 'executor') ?? stringField(cmd, 'executorId');
      const command = stringField(cmd, 'command');

      if (!executor) throw new Error('executor required');

      if (!command) throw new Error('command required');

      return decodeJsonValue({ value: await executeLocalExecutor(name, executor, command) });
    }

    case 'product':
      return decodeJsonValue({ value: getLocalReleaseBoard(name, numberField(cmd, 'limit') ?? 20) });
    case 'stop':
      client.stop();

      return { interrupted: true, cancelledBackgroundJobs: await markLocalBackgroundJobsCancelled(name) };
    default:
      throw new Error('Unsupported command');
  }
}

function renderRunEvent(event: AgentClientEvent): void {
  switch (event.type) {
    case 'text-delta':
      process.stdout.write(event.delta);
      break;
    case 'tool-call':
      printToolCall(event.toolName, event.args);
      break;
    case 'tool-result':
      printToolResult(event.result, event);
      break;
    case 'error':
      console.log(`\n${formatFailure({ cause: event.message })}`);
      break;
    case 'turn-end':
      console.log('');
      break;
    case 'broadcast':
      if (event.event.type === 'model_fallback') console.log(`\n${DIM(event.event.message ?? '')}`);
      break;
    case 'turn-start':
    case 'step-finish':
    case 'evolution':
    case 'background':
    case 'run-event':
      break;
  }
}

function createJsonEventWriter(client: AgentClient): (event: AgentClientEvent) => void {
  let wroteHeader = false;
  const output = (value: JsonValue) => process.stdout.write(`${JSON.stringify(value)}\n`);

  return (event) => {
    if (!wroteHeader) {
      wroteHeader = true;
      output({ type: 'session', id: client.cliSession.id, workspace: client.agentName, backend: client.mode, cwd: process.cwd() });
    }

    for (const value of jsonEvents(event)) output(value);
  };
}

function jsonEvents(event: AgentClientEvent): JsonValue[] {
  switch (event.type) {
    case 'turn-start': {
      const value: JsonObject = { type: 'turn_start', kind: event.kind, text: event.text };

      if (event.event) value.event = event.event;

      return [value];
    }

    case 'text-delta':
      return [{ type: 'message_delta', role: 'assistant', delta: event.delta }];
    case 'tool-call':
      return [{ type: 'tool_call', toolName: event.toolName, toolCallId: event.toolCallId, args: event.args }];
    case 'tool-result':
      return [{ type: 'tool_result', toolName: event.toolName, toolCallId: event.toolCallId, result: event.result, ...v.parse(ToolOutcomeSchema, event) }];
    case 'turn-end': {
      const turnEnd: JsonObject = {
        type: 'turn_end',
        steps: event.turn.steps,
        durationMs: event.turn.durationMs,
        hadError: event.turn.hadError,
      };

      // Unreported fields stay absent rather than 0 (bench/clbench/kinu/events.py depends on it).
      // `projectJsonValue` drops present-and-`undefined` fields, which JsonValueSchema would reject.
      if (event.turn.usage && usageReported(event.turn.usage)) {
        turnEnd.usage = projectJsonValue({ value: event.turn.usage });
      }

      return [
        { type: 'message_end', role: 'assistant', text: event.turn.text },
        turnEnd,
      ];
    }

    case 'step-finish':
      return [];
    case 'error':
      return [{ type: 'error', ...guideFailure({ cause: event.message }) }];
    case 'evolution':
      return [{ type: 'evolution', event: event.event, message: event.message }];
    case 'background':
      return [{ type: 'background', event: event.event, message: event.message }];
    case 'broadcast':
      return [{ type: 'broadcast', event: decodeJsonValue({ value: event.event }) }];
    // Every RunEvent kind under one envelope; the ledger's `turn_start`/`turn_end`/`error` collide with the events above.
    // `projectJsonValue`, not `decodeJsonValue`: SDK-built steps carry present-and-`undefined` fields.
    case 'run-event':
      return [{ type: 'run_event', event: projectJsonValue({ value: event.event }) }];
  }
}

type RpcParseResult = { ok: true; value: JsonObject } | { ok: false; error: string };

const RpcCommandSchema = v.objectWithRest({ type: v.string() }, JsonValueSchema);

function parseRpc(line: string): RpcParseResult {
  try {
    const parsed = v.safeParse(RpcCommandSchema, parseJsonObject(line));

    return parsed.success
      ? { ok: true, value: parsed.output }
      : { ok: false, error: 'Command must be an object with type' };
  } catch (err) {
    return { ok: false, error: renderThrownChain({ cause: err }) };
  }
}

/** Long enough for a real pipe to start delivering, short enough not to stall a harness that inherits an idle stdin. */
const OPTIONAL_STDIN_GRACE_MS = 250;

async function readStdin(): Promise<string> {
  return await new Response(Bun.stdin.stream()).text();
}

/** Any byte within the grace window makes the pipe real: wait for EOF and keep every byte. */
async function readOptionalStdin(): Promise<string> {
  const reader = Bun.stdin.stream().getReader();

  const first = await Promise.race([
    reader.read(),
    new Promise<'idle'>((resolve) => setTimeout(() => resolve('idle'), OPTIONAL_STDIN_GRACE_MS)),
  ]);

  if (first === 'idle') {
    try {
      await reader.cancel();
    } catch (cause) {
      process.stderr.write(`note: releasing idle stdin failed: ${renderThrownChain({ cause })}\n`);
    }

    process.stderr.write(
      `note: stdin was open but idle for ${OPTIONAL_STDIN_GRACE_MS}ms and was ignored; ` +
      'pipe data promptly or close it (< /dev/null)\n',
    );

    return '';
  }

  const decoder = new TextDecoder();
  let text = first.done ? '' : decoder.decode(first.value, { stream: true });

  while (true) {
    const chunk = await reader.read();

    if (chunk.done) break;
    text += decoder.decode(chunk.value, { stream: true });
  }

  return text + decoder.decode();
}

/** With no argv prompt, stdin is the prompt; otherwise it is optional context, since CI runners inherit open idle pipes. */
async function buildPrompt(parts: string[]): Promise<string> {
  const chunks = [...parts];
  const argvPrompt = chunks.join(' ').trim();
  let stdin = '';

  if (!process.stdin.isTTY) {
    stdin = argvPrompt ? await readOptionalStdin() : await readStdin();
  }

  if (stdin.trim()) chunks.push(`<stdin>\n${stdin.trim()}\n</stdin>`);

  return chunks.join(' ').trim();
}

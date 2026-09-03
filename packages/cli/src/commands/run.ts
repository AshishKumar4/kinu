import * as readline from 'node:readline';
import { callAgentRpc, createCloudWebhookTrigger, type CloudWebhookTriggerInput } from '../cloud-api';
import { listConfiguredAgentRefs, requireAuthConfig } from '../config';
import { resolveAgentTarget, type AgentTarget } from '../agent-target';
import { createAgentClient, type AgentClientFlags } from '../client-factory';
import type { AgentClient, AgentClientEvent } from '../agent-client';
import { decodeJsonValue, JsonValueSchema, parseJsonObject, projectJsonValue, usageReported, type JsonObject, type JsonValue } from '@kinu.run/core';
import * as v from 'valibot';
import type { CliSessionOptions } from '../session';
import { chatCommand } from './chat';
import { ensureLocalDaemonRunning } from './daemon';
import { resolvePromptAttachments } from '../attachments';
import { watchHeadlessConsents, watchTerminalConsents } from '../consent-watch';
import { ERR, formatFailure, printFailure, printToolCall, printToolResult } from '../display';
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
import { loadActiveProfile, updateDefaultTier } from '../profiles';

/** Transcript flags as Commander actually delivers them: `--no-transcript`
 *  arrives as `transcript: false` on the shared option key, not as
 *  `noTranscript: true`. */
interface TranscriptFlags {
  transcript?: boolean;
  transcriptDir?: string;
}

export async function runCommand(name: string, promptParts: string[], opts: AgentClientFlags & TranscriptFlags & {
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

/**
 * `kinu exec` — the headless face of the one-shot run machinery. Built for
 * CI: no prompts of any kind (device consents are denied, fail closed, with
 * pre-authorization instructions), `--json` streams line-delimited events,
 * and the exit code is honest — 0 only when the turn completed without
 * errors or denied consents.
 */
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
    ? 'No workspaces configured. Create one with: kinu create <name>, or pass --workspace <name>.'
    : `Multiple workspaces configured. Pass --workspace <name>. Configured: ${agents.map((a) => a.name).join(', ')}.`);
}

/**
 * The single one-shot run path behind `kinu run <name> "prompt"` and
 * `kinu exec`: resolve attachments, stream the turn through the
 * AgentClient seam, watch device consents (interactively or fail-closed),
 * and report whether anything failed.
 */
async function runOneShot(
  target: AgentTarget,
  rawPrompt: string,
  opts: AgentClientFlags & TranscriptFlags,
  surface: { json: boolean; headless: boolean },
): Promise<boolean> {
  // The daemon is this process's deferred-work host: a one-shot run never
  // starts the cadence-heavy evolution pass it cannot finish, so the daemon is
  // what eventually runs it (see AgentOrchestrator's exit contract).
  if (target.mode === 'local') ensureLocalDaemonRunning();
  // Diagnostics belong in the turn log on BOTH surfaces. Text mode: they would
  // land between the reader and the run. --json: stderr is part of the machine
  // contract — empty on success, the rendered error alone on failure — and a
  // routine event (`admission.uncounted` fires on every openai-compat request)
  // would break every consumer that treats stderr output as the failure text.
  installTurnDiagnostics();
  const client = await createAgentClient(
    target,
    { model: opts.model, baseUrl: opts.baseUrl, auth: opts.auth, noAutoEvolve: opts.noAutoEvolve, ...transcriptOptions(opts) },
    'one-shot',
  );

  // Same @path semantics as the chat surfaces: images/PDFs inline as file
  // parts, other files stay path references the agent reads with its tools.
  // Resolved after the client exists — it reports the backend's inline cap.
  const prompt = await resolvePromptAttachments(rawPrompt, { limitBytes: client.inlineAttachmentLimitBytes });
  for (const problem of prompt.errors) console.error(`${ERR('error')} ${problem}`);

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
    // send() resolves when the task turn resolves, but the task turn is not
    // always the last one: a tool that auto-detached ends the turn early and
    // its result arrives as a wake turn, and the one-shot completion gate
    // queues a confirming turn against freshly observed state. This process
    // exits after send(), so drain the rest HERE — while the subscription is
    // still live, so their events stream — instead of losing the second half.
    await client.settleBackgroundWork?.();
  } catch (err) {
    // In-stream failures already surfaced as an error event; only report
    // failures that never reached the stream (connect, ticket, transport).
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
          try {
            const data = await runCloudRpcCommand(auth.origin, auth.token, target.cloudName, cmd.value);
            output({ value: { id: cmd.value.id, type: 'response', command: cmd.value.type, success: true, data } });
          } catch (err) {
            output({ value: { id: cmd.value.id, type: 'response', command: cmd.value.type, success: false, error: renderThrownChain({ cause: err }) } });
          }
          continue;
        }
        const message = String(cmd.value.message ?? '').trim();
        if (!message) {
          output({ value: { id: cmd.value.id, type: 'response', command: 'prompt', success: false, error: 'message required' } });
          continue;
        }
        output({ value: { type: 'turn_start', id: cmd.value.id } });
        const result = await client.send(message, { cwd: process.cwd() });
        output({ value: { type: 'message_end', role: 'assistant', text: result.text } });
        output({ value: { id: cmd.value.id, type: 'response', command: 'prompt', success: true } });
        output({ value: { type: 'turn_end', steps: result.steps } });
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
  // Defer client-owned MCP connection until the first prompt. The daemon
  // already owns orphaned-job recovery.
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
        try {
          const data = await runLocalRpcCommand(target.localName, cmd.value, client);
          output({ value: { id: cmd.value.id, type: 'response', command: cmd.value.type, success: true, data } });
        } catch (err) {
          output({ value: { id: cmd.value.id, type: 'response', command: cmd.value.type, success: false, error: renderThrownChain({ cause: err }) } });
        }
        continue;
      }
      const message = String(cmd.value.message ?? '').trim();
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
      // stdout carries the JSON-lines protocol, so this belongs on stderr.
      process.stderr.write(`note: closing the workspace client failed: ${renderThrownChain({ cause: error })}\n`);
    }
  }
}

/** `model` edits the canonical profile tier, independent of which transport
 * carried the headless command. Per-agent `setModel` is only a bootstrap hint;
 * fresh turn profile resolution overrides it. */
async function runModelProfileCommand(cmd: JsonObject): Promise<JsonValue> {
  const spec = stringField(cmd, 'spec');
  const envelope = spec
    ? await updateDefaultTier({ model: spec })
    : await loadActiveProfile();
  return decodeJsonValue({ value: { spec: envelope.catalog.tiers.default.model } });
}

async function runCloudRpcCommand(origin: string, token: string, name: string, cmd: JsonObject): Promise<JsonValue> {
  const rpc = async (method: string, args: JsonValue[] = []): Promise<JsonValue> =>
    callAgentRpc(origin, token, name, method, JsonValueSchema, args);
  const type = String(cmd.type);
  switch (type) {
    case 'get_state':
    case 'state':
      return rpc('getWorkspaceSnapshot');
    case 'status':
      return rpc('getAgentStatus');
    case 'tools':
      return rpc('getToolDescriptions');
    case 'model':
      return runModelProfileCommand(cmd);
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
        auth_mode: webhookAuthMode(stringField(cmd, 'authMode') ?? stringField(cmd, 'auth_mode')),
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
  const type = String(cmd.type);
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
    case 'model':
      return runModelProfileCommand(cmd);
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

function stringField(cmd: JsonObject, key: string): string | undefined {
  const parsed = v.safeParse(v.pipe(v.string(), v.trim(), v.nonEmpty()), cmd[key]);
  return parsed.success ? parsed.output : undefined;
}

function numberField(cmd: JsonObject, key: string): number | undefined {
  const value = cmd[key];
  const number = v.safeParse(v.pipe(v.number(), v.finite()), value);
  if (number.success) return number.output;
  const string = v.safeParse(v.pipe(v.string(), v.trim(), v.nonEmpty()), value);
  if (!string.success) return undefined;
  const parsed = Number(string.output);
  if (Number.isFinite(parsed)) return parsed;
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
      console.log(`\n${formatFailure({ cause: event.message })}`);
      break;
    case 'turn-end':
      console.log('');
      break;
    case 'turn-start':
    case 'step-finish':
    case 'evolution':
    case 'background':
    case 'broadcast':
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
      return [{ type: 'tool_call', toolName: event.toolName, args: event.args }];
    case 'tool-result':
      return [{ type: 'tool_result', toolName: event.toolName, result: event.result }];
    case 'turn-end': {
      const turnEnd: JsonObject = {
        type: 'turn_end',
        steps: event.turn.steps,
        durationMs: event.turn.durationMs,
        hadError: event.turn.hadError,
      };
      // The turn's usage, field-for-field, and only when the provider reported
      // something: a reader must be able to tell "spent nothing" from "nobody
      // metered this", so an unreported field is an ABSENT key rather than a 0
      // (bench/clbench/kinu/events.py is the reader that depends on it).
      // `projectJsonValue`, not `decodeJsonValue`, for the same reason the
      // run-event arm below uses it: this is an in-process object on its way
      // OUT, so a present-and-`undefined` field must be dropped rather than
      // thrown on — JsonValueSchema rejects `undefined`, which would print a
      // valibot stack mid-run.
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
    // The durable ledger, verbatim and whole: every RunEvent kind travels
    // under one envelope so a consumer reads `event.type` rather than waiting
    // for this switch to learn about the next kind. Enveloped rather than
    // flattened because the ledger's own `turn_start`/`turn_end`/`error` names
    // collide with the presentation events above.
    // `projectJsonValue`, not `decodeJsonValue`: a run-event is an in-process
    // object on its way OUT to the wire, not a value that arrived as JSON. The
    // accumulator builds steps from SDK results, so optional properties are
    // present-and-`undefined` (`toolCallId`, `providerMetadata`), which JSON has
    // no representation for. Validating instead of projecting threw ValiError
    // inside the listener, so `kinu exec --json` printed a valibot stack to
    // stderr mid-run while still exiting 0.
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

/** Grace period for OPTIONAL stdin's FIRST byte — see buildPrompt. Long
 *  enough for a real pipe to start delivering, short enough that a harness
 *  which inherits an idle stdin is not stalled. */
const OPTIONAL_STDIN_GRACE_MS = 250;

async function readStdin(): Promise<string> {
  return await new Response(Bun.stdin.stream()).text();
}

/**
 * Read optional stdin with first-byte semantics: if ANY data arrives within
 * the grace window, the pipe is real — wait for EOF and keep every byte. Only
 * a pipe that stayed silent for the whole window reads as absent. The old
 * whole-read race dropped bytes already received when EOF missed the window
 * (a slow `cat bigfile |` lost its input mid-stream, silently).
 */
async function readOptionalStdin(): Promise<string> {
  const reader = Bun.stdin.stream().getReader();
  const first = await Promise.race([
    reader.read(),
    new Promise<'idle'>((resolve) => setTimeout(() => resolve('idle'), OPTIONAL_STDIN_GRACE_MS)),
  ]);
  if (first === 'idle') {
    // Cancelling ends the idle read; await its release before returning.
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

/**
 * Assemble the turn prompt from argv and, where it makes sense, stdin.
 *
 * When argv carries no prompt, stdin IS the prompt (`cat notes | kinu exec`)
 * and waiting for EOF is correct. When argv already carries one, stdin is
 * supplementary context — and waiting on it hangs forever against a pipe that
 * is open but idle, which is exactly what a harness or CI runner inherits.
 * That hang made every scripted use of `kinu exec` require a `</dev/null`
 * incantation to work at all.
 */
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

function normalizeOutputMode(raw: string | undefined): 'text' | 'json' | 'rpc' {
  const mode = (raw ?? 'text').toLowerCase();
  if (mode === 'text' || mode === 'json' || mode === 'rpc') return mode;
  throw new Error('--mode must be text, json, or rpc');
}

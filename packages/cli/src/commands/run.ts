import { Cause, Effect, Result } from 'effect';
import * as readline from 'node:readline';
import { callAgentRpc, createCloudWebhookTrigger, type CloudWebhookTriggerInput } from '../cloud-api';
import { listConfiguredAgentRefs, requireAuthConfig } from '../config';
import { resolveAgentTarget, type AgentTarget } from '../agent-target';
import { createAgentClient, type AgentClientFlags } from '../client-factory';
import type { AgentClient, AgentClientEvent } from '../agent-client';
import { decodeJsonValue, describeProviderError, JsonValueSchema, parseJsonObject, projectJsonValue, usageReported, ToolOutcomeSchema, type AgentRpcMethod, type JsonObject, type JsonValue } from '@kinu.run/core';
import * as v from 'valibot';
import type { CliSessionOptions } from '../session';
import { chatCommand } from './chat';
import { ensureLocalDaemonRunning } from './daemon';
import { resolvePromptAttachments } from '../attachments';
import { watchHeadlessConsents, watchTerminalConsents, type ConsentWatcher } from '../consent-watch';
import { DIM, ERR, formatFailure, printFailure, printToolCall, printToolResult } from '../display';
import { normalizeWebhookAuthMode, numberField, oneOfFlag, stringField } from '../options';
import {
  executeLocalExecutor,
  getLocalAgentState,
  getLocalGepaRun,
  getLocalMctsNode,
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
import { renderThrownChain, settle } from '@kinu.run/core/obs';
import { installTurnDiagnostics } from '../turn-log';

/** `--no-transcript` arrives as `transcript: false`, not `noTranscript: true`. */
interface TranscriptFlags {
  transcript?: boolean;
  transcriptDir?: string;
}

export function runCommand(name: string, promptParts: string[], opts: AgentClientFlags & TranscriptFlags & {
  classic?: boolean;
  mode?: string;
}): Promise<void> {
  return settle(Effect.gen(function* () {
    const outputMode = oneOfFlag(opts.mode, '--mode', ['text', 'json', 'rpc']);
    const target = resolveAgentTarget(name);

    if (outputMode === 'rpc') {
      yield* runRpc(target, opts);

      return;
    }

    const rawPrompt = yield* buildPrompt(promptParts);

    if (!rawPrompt) {
      yield* Effect.promise(() => chatCommand(target.requestedName, {
        model: opts.model,
        baseUrl: opts.baseUrl,
        auth: opts.auth,
        classic: opts.classic,
        ...transcriptOptions(opts),
      }));

      return;
    }

    const failed = yield* runOneShot(target, rawPrompt, opts, {
      json: outputMode === 'json',
      headless: false,
    });

    return yield* Effect.promise(() => exitOneShot(failed));
  }));
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
export function execCommand(promptParts: string[], opts: ExecOptions): Promise<void> {
  return settle(Effect.gen(function* () {
    const rawPrompt = yield* buildPrompt(promptParts);

    if (!rawPrompt) {
      return yield* Effect.die(new Error('A task prompt is required. Usage: kinu exec "task" [--workspace <name>] [--json]'));
    }

    const target = resolveAgentTarget(yield* resolveExecWorkspaceName(opts.workspace));

    const failed = yield* runOneShot(target, rawPrompt, {
      model: opts.model,
      baseUrl: opts.baseUrl,
      auth: opts.auth,
      noAutoEvolve: opts.autoEvolve === false,
      ...transcriptOptions(opts),
    }, {
      json: opts.json === true,
      headless: true,
    });

    return yield* Effect.promise(async () => exitOneShot(failed));
  }));
}

/**
 * Exit rather than return: a background server or VM would hold the process open; each has its own process group,
 * so it outlives this exit. Output drains first: `process.exit` drops what a pipe hasn't taken.
 */
async function exitOneShot(failed: boolean): Promise<never> {
  await Promise.all([process.stdout, process.stderr].map((stream) => new Promise<void>((drained) => {
    stream.write('', () => drained());
  })));
  process.exit(failed ? 1 : 0);
}

function resolveExecWorkspaceName(explicit?: string): Effect.Effect<string> {
  return Effect.gen(function* () {
    if (explicit?.trim()) return explicit.trim();
    const agents = listConfiguredAgentRefs();

    if (agents.length === 1) return agents[0].name;

    return yield* Effect.die(new Error(agents.length === 0
      ? 'No workspaces configured. Create one with: kinu create <name>, or pass --workspace <name>.'
      : `Multiple workspaces configured. Pass --workspace <name>. Configured: ${agents.map((a) => a.name).join(', ')}.`));
  });
}

function runOneShot(
  target: AgentTarget,
  rawPrompt: string,
  opts: AgentClientFlags & TranscriptFlags,
  surface: { json: boolean; headless: boolean },
): Effect.Effect<boolean> {
  return Effect.gen(function* () {
    // A one-shot run never starts the evolution pass it cannot finish; the daemon runs it (see AgentOrchestrator's exit contract).
    if (target.mode === 'local') ensureLocalDaemonRunning();
    // Diagnostics go to the turn log: in --json mode stderr is empty on success and holds only the error on failure.
    installTurnDiagnostics();

    const client = yield* Effect.promise(() => createAgentClient(
      target,
      { model: opts.model, baseUrl: opts.baseUrl, auth: opts.auth, noAutoEvolve: opts.noAutoEvolve, ...transcriptOptions(opts) },
      'one-shot',
    ));

    // Resolved after the client exists: it reports the backend's inline cap.
    const prompt = yield* Effect.promise(() => resolvePromptAttachments(rawPrompt, { limitBytes: client.inlineAttachmentLimitBytes }));

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

    yield* Effect.ensuring(Effect.catchCause(Effect.gen(function* () {
      yield* Effect.promise(() => client.connect());

      const result = yield* Effect.promise(() => client.send(
        prompt.files.length > 0 ? { text: prompt.text, files: prompt.files } : prompt.text,
        { cwd: process.cwd() },
      ));

      if (result.landed === 'turn' && result.hadError) failed = true;
      // A detached tool's wake turn or the completion gate's confirming turn may follow; drain while the subscription is live.
      yield* Effect.promise(async () => client.settleBackgroundWork?.());
    }), (cause) => Effect.sync(() => {
      const err = Cause.squash(cause);
      const alreadyReported = failed;
      failed = true;

      if (!alreadyReported) {
        if (surface.json) process.stdout.write(`${JSON.stringify({ type: 'error', message: describeProviderError({ cause: err }) })}\n`);
        else printFailure({ cause: err });
      }
    })), Effect.promise(async () => {
      consentWatch?.stop();
      unsubscribe();
      await client.close();
    }));

    return failed;
  });
}

function transcriptOptions(opts: TranscriptFlags): CliSessionOptions {
  return {
    transcriptDir: opts.transcriptDir,
    noTranscript: opts.transcript === false,
  };
}

function askLineOnce(question: string, signal: AbortSignal): Effect.Effect<string | null> {
  return Effect.promise(() => new Promise<string | null>((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    let settled = false;

    const finish = (answer: string | null) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener('abort', onAbort);
      rl.close();
      resolve(answer);
    };

    const onAbort = () => finish(null);
    signal.addEventListener('abort', onAbort, { once: true });
    rl.once('close', () => finish(null));
    rl.question(question, finish);
  }));
}

/** Both backends answer `model` through the AgentClient contract. */
async function modelRpcCommand(cmd: JsonObject, client: AgentClient): Promise<JsonValue> {
  const spec = stringField(cmd, 'spec');

  return decodeJsonValue({ value: spec ? await client.setModel(spec) : { spec: await client.getModelSpec() } });
}

function respondToRpcCommand(
  cmd: JsonObject,
  client: AgentClient,
  output: (input: { value: unknown }) => void,
  run: () => Effect.Effect<JsonValue>,
): Effect.Effect<void> {
  return Effect.catchCause(Effect.gen(function* () {
    const data = yield* (cmd.type === 'model' ? Effect.promise(() => modelRpcCommand(cmd, client)) : run());
    output({ value: { id: cmd.id, type: 'response', command: cmd.type, success: true, data } });
  }), (failed) => Effect.sync(() => {
    output({ value: { id: cmd.id, type: 'response', command: cmd.type, success: false, error: renderThrownChain({ cause: Cause.squash(failed) }) } });
  }));
}

function runRpc(
  target: AgentTarget,
  opts: AgentClientFlags & TranscriptFlags,
): Effect.Effect<void> {
  return Effect.gen(function* () {
    const output = (input: { value: unknown }) => process.stdout.write(`${JSON.stringify(decodeJsonValue(input))}\n`);
    const clientOpts = { model: opts.model, baseUrl: opts.baseUrl, auth: opts.auth, ...transcriptOptions(opts) };

    if (target.mode === 'cloud') {
      const auth = requireAuthConfig();
      const client = yield* Effect.promise(() => createAgentClient(target, clientOpts));
      output({ value: { type: 'session', id: client.cliSession.id, workspace: target.name, backend: 'cloud', cwd: process.cwd() } });
      const unsubscribe = client.subscribe((event) => output({ value: { type: 'event', event } }));
      const lines = readline.createInterface({ input: process.stdin, crlfDelay: Infinity })[Symbol.asyncIterator]();

      yield* Effect.ensuring(Effect.gen(function* () {
        for (;;) {
          const next = yield* Effect.promise(() => lines.next());

          if (next.done === true) break;
          const line = next.value;

          if (!line.trim()) continue;
          const cmd = parseRpc(line);

          if (Result.isFailure(cmd)) { output({ value: { type: 'response', success: false, error: cmd.failure } }); continue; }

          const command = cmd.success;

          if (command.type === 'exit' || command.type === 'shutdown') break;

          if (command.type !== 'prompt') {
            yield* respondToRpcCommand(command, client, output, () => runCloudRpcCommand(auth.origin, auth.token, target.cloudName, command));
            continue;
          }

          const message = stringField(command, 'message') ?? '';

          if (!message) {
            output({ value: { id: command.id, type: 'response', command: 'prompt', success: false, error: 'message required' } });
            continue;
          }

          output({ value: { type: 'turn_start', id: command.id } });
          const result = yield* Effect.promise(() => client.send(message, { cwd: process.cwd() }));
          const turn = result.landed === 'turn' ? result : { text: '', steps: 0 };
          output({ value: { type: 'message_end', role: 'assistant', text: turn.text } });
          output({ value: { id: command.id, type: 'response', command: 'prompt', success: true } });
          output({ value: { type: 'turn_end', steps: turn.steps } });
        }
      }), Effect.promise(async () => {
        // As `for await` does on leaving early, the reader's return closes the interface.
        await lines.return?.();
        unsubscribe();
        await client.close();
      }));

      return;
    }

    ensureLocalDaemonRunning();
    const client = yield* Effect.promise(() => createAgentClient(target, clientOpts));
    client.subscribe((event) => output({ value: { type: 'event', event } }));
    output({ value: { type: 'session', id: client.cliSession.id, workspace: target.name, backend: 'local', cwd: process.cwd() } });
    // Client-owned MCP connects on the first prompt; the daemon owns orphaned-job recovery.
    let connected = false;

    const ensureConnected = Effect.suspend(() => {
      if (connected) return Effect.void;
      connected = true;

      return Effect.promise(() => client.connect());
    });

    yield* Effect.ensuring(Effect.gen(function* () {
      const lines = readline.createInterface({ input: process.stdin, crlfDelay: Infinity })[Symbol.asyncIterator]();

      yield* Effect.ensuring(Effect.gen(function* () {
        for (;;) {
          const next = yield* Effect.promise(() => lines.next());

          if (next.done === true) break;
          const line = next.value;

          if (!line.trim()) continue;
          const cmd = parseRpc(line);

          if (Result.isFailure(cmd)) { output({ value: { type: 'response', success: false, error: cmd.failure } }); continue; }

          const command = cmd.success;

          if (command.type === 'exit' || command.type === 'shutdown') break;

          if (command.type !== 'prompt') {
            yield* respondToRpcCommand(command, client, output, () => runLocalRpcCommand(target.localName, command, client));
            continue;
          }

          const message = stringField(command, 'message') ?? '';

          if (!message) {
            output({ value: { id: command.id, type: 'response', command: 'prompt', success: false, error: 'message required' } });
            continue;
          }

          yield* ensureConnected;
          yield* Effect.promise(() => client.send(message, { cwd: process.cwd() }));
          output({ value: { id: command.id, type: 'response', command: 'prompt', success: true } });
        }
      }), Effect.promise(async () => lines.return?.()));
    }), Effect.catchCause(Effect.promise(() => client.close()), noting('closing the workspace client')));
  });
}

/** A cleanup's failure, written as a stderr note: the command's own answer stands. */
function noting(doing: string): (failed: Cause.Cause<unknown>) => Effect.Effect<void> {
  return (failed) => Effect.sync(() => {
    process.stderr.write(`note: ${doing} failed: ${renderThrownChain({ cause: Cause.squash(failed) })}\n`);
  });
}

const commandType = (cmd: JsonObject): string => stringField(cmd, 'type') ?? '';

function runCloudRpcCommand(origin: string, token: string, name: string, cmd: JsonObject): Effect.Effect<JsonValue> {
  const rpc = (method: AgentRpcMethod, args: JsonValue[] = []): Effect.Effect<JsonValue> =>
    Effect.promise(() => callAgentRpc({ origin, token, name, method, schema: JsonValueSchema, args }));

  return Effect.gen(function* () {
    const type = commandType(cmd);

    switch (type) {
      case 'get_state':
      case 'state':
        return yield* rpc('getWorkspaceSnapshot');
      case 'status':
        return yield* rpc('getAgentStatus');
      case 'tools':
        return yield* rpc('getToolDescriptions');
      case 'triggers':
        return yield* rpc('listTriggers');
      case 'jobs':
        return yield* rpc('listBackgroundJobs', [numberField(cmd, 'limit') ?? 20]);
      case 'memory': {
        const query = stringField(cmd, 'query');

        return query
          ? yield* rpc('searchMemoryHybrid', [query, numberField(cmd, 'limit') ?? 10])
          : { content: yield* rpc('getMemoryContent') };
      }

      case 'events':
        {
          const filter: JsonObject = { limit: numberField(cmd, 'limit') ?? 50 };
          const variant = stringField(cmd, 'variant');
          const since = numberField(cmd, 'since');

          if (variant) filter.variant = variant;

          if (since !== undefined) filter.since = since;

          return yield* rpc('listRecentEvents', [filter]);
        }

      case 'timeline':
        return yield* rpc('getRunTimeline', [{ limit: numberField(cmd, 'limit') ?? 100 }]);
      case 'swarm': {
        const nodeId = stringField(cmd, 'nodeId') ?? stringField(cmd, 'id');

        return nodeId ? yield* rpc('getMctsNodeDetail', [nodeId]) : yield* rpc('getMctsTree');
      }

      case 'heads':
        return yield* rpc('getHeadRuns', [numberField(cmd, 'limit') ?? 20]);
      case 'gepa': {
        const runId = stringField(cmd, 'runId') ?? stringField(cmd, 'id');

        return runId ? yield* rpc('getGepaRun', [runId]) : yield* rpc('getGepaRuns', [numberField(cmd, 'limit') ?? 20]);
      }

      case 'executors':
        return yield* rpc('getExecutors');
      case 'exec': {
        const executor = stringField(cmd, 'executor') ?? stringField(cmd, 'executorId');
        const command = stringField(cmd, 'command');

        if (!executor) return yield* Effect.die(new Error('executor required'));

        if (!command) return yield* Effect.die(new Error('command required'));

        return yield* rpc('executeInExecutor', [executor, command]);
      }

      case 'stop':
        return yield* rpc('cancelCurrentWork');
      case 'webhook': {
        const label = stringField(cmd, 'label');

        if (!label) return yield* Effect.die(new Error('label required'));

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

        return decodeJsonValue({ value: yield* Effect.promise(() => createCloudWebhookTrigger(origin, token, name, input)) });
      }

      default:
        return yield* Effect.die(new Error('Unsupported command'));
    }
  });
}

function runLocalRpcCommand(name: string, cmd: JsonObject, client: AgentClient): Effect.Effect<JsonValue> {
  return Effect.gen(function* () {
    const type = commandType(cmd);

    switch (type) {
      case 'get_state':
      case 'state':
        return decodeJsonValue({ value: {
          ...getLocalAgentState(name),
          sessionId: client.cliSession.id,
          tools: getLocalToolSurface(name),
          model: yield* Effect.promise(() => client.getModelSpec()),
        } });
      case 'status':
        return decodeJsonValue({ value: getLocalAgentState(name) });
      case 'tools':
        return decodeJsonValue({ value: yield* Effect.promise(() => client.describeTools()) });
      case 'triggers':
        return decodeJsonValue({ value: listLocalTriggers(name) });
      case 'jobs':
        return decodeJsonValue({ value: yield* Effect.promise(() => client.listJobs(numberField(cmd, 'limit') ?? 20)) });
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
      case 'swarm': {
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

        if (!executor) return yield* Effect.die(new Error('executor required'));

        if (!command) return yield* Effect.die(new Error('command required'));

        return decodeJsonValue({ value: yield* Effect.promise(() => executeLocalExecutor(name, executor, command)) });
      }

      case 'stop':
        client.stop();

        return { interrupted: true, cancelledBackgroundJobs: yield* Effect.promise(() => markLocalBackgroundJobsCancelled(name)) };
      default:
        return yield* Effect.die(new Error('Unsupported command'));
    }
  });
}

function renderRunEvent(event: AgentClientEvent): void {
  switch (event.type) {
    case 'text-delta':
      process.stdout.write(event.delta);
      break;
    case 'reasoning-delta':
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
    case 'reasoning-delta':
      return [];
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
      return [{ type: 'error', message: describeProviderError({ cause: event.message }) }];
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

type RpcParseResult = Result.Result<JsonObject, string>;

const RpcCommandSchema = v.objectWithRest({ type: v.string() }, JsonValueSchema);

function parseRpc(line: string): RpcParseResult {
  return Result.flatMap(Result.try({ try: () => parseJsonObject(line), catch: (err) => renderThrownChain({ cause: err }) }), (object) => {
    const parsed = v.safeParse(RpcCommandSchema, object);

    return parsed.success ? Result.succeed(parsed.output) : Result.fail('Command must be an object with type');
  });
}

/** Long enough for a real pipe to start delivering, short enough not to stall a harness that inherits an idle stdin. */
const OPTIONAL_STDIN_GRACE_MS = 250;

async function readStdin(): Promise<string> {
  return await new Response(Bun.stdin.stream()).text();
}

/** Any byte within the grace window makes the pipe real: wait for EOF and keep every byte. */
function readOptionalStdin(): Effect.Effect<string> {
  return Effect.gen(function* () {
    const reader = Bun.stdin.stream().getReader();

    const first = yield* Effect.promise(() => Promise.race([
      reader.read(),
      new Promise<'idle'>((resolve) => setTimeout(() => resolve('idle'), OPTIONAL_STDIN_GRACE_MS)),
    ]));

    if (first === 'idle') {
      yield* Effect.catchCause(Effect.promise(() => reader.cancel()), noting('releasing idle stdin'));

      process.stderr.write(
        `note: stdin was open but idle for ${OPTIONAL_STDIN_GRACE_MS}ms and was ignored; ` +
        'pipe data promptly or close it (< /dev/null)\n',
      );

      return '';
    }

    const decoder = new TextDecoder();
    let text = first.done ? '' : decoder.decode(first.value, { stream: true });

    while (true) {
      const chunk = yield* Effect.promise(() => reader.read());

      if (chunk.done) break;
      text += decoder.decode(chunk.value, { stream: true });
    }

    return text + decoder.decode();
  });
}

/** With no argv prompt, stdin is the prompt; otherwise it is optional context, since CI runners inherit open idle pipes. */
function buildPrompt(parts: string[]): Effect.Effect<string> {
  return Effect.gen(function* () {
    const chunks = [...parts];
    const argvPrompt = chunks.join(' ').trim();
    let stdin = '';

    if (!process.stdin.isTTY) {
      stdin = argvPrompt ? yield* readOptionalStdin() : yield* Effect.promise(() => readStdin());
    }

    if (stdin.trim()) chunks.push(`<stdin>\n${stdin.trim()}\n</stdin>`);

    return chunks.join(' ').trim();
  });
}

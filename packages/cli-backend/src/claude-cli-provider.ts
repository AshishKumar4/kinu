// Claude subscription provider (LOCAL ONLY) — drives the user's Claude Code
// subscription through Anthropic's OFFICIAL `claude` binary, never the raw API.
//
// We spawn `claude -p "<prompt>" --output-format stream-json` with tools OFF so
// it behaves as a single-turn chat completion. The binary holds and refreshes
// the subscription OAuth itself — Proteus never reads ~/.claude credentials nor
// calls api.anthropic.com directly. That is what keeps this compliant: the
// official client is the auth boundary.
//
// This lives in cli-backend (the local backend). The cloud server must never
// drive subscription calls, so nothing here is reachable from cf-backend.
import type { LanguageModelV2, LanguageModelV2CallOptions, LanguageModelV2StreamPart, LanguageModelV2Usage } from '@ai-sdk/provider';
import { JsonObjectSchema, usageTotal } from '@proteus/core';
import { diagnostics, ProteusError, tolerate } from '@proteus/core/obs';
import type { JsonObject, ModelProvider, ModelInfo, ProviderDeps, Usage } from '@proteus/core';
import { spawn as nodeSpawn } from 'node:child_process';
import * as v from 'valibot';

export const CLAUDE_CLI_PROVIDER_ID = 'claude';

/** Spec model id → the `claude --model` alias the binary accepts. Aliases
 *  resolve to the latest model in each family, so they don't drift with point
 *  releases the way pinned `claude-opus-4-7` ids do. */
interface ModelAliases { [modelId: string]: string }

export interface ClaudeModelProvider extends Omit<ModelProvider, 'createModel' | 'listModels'> {
  listModels(deps?: ProviderDeps): ModelInfo[];
  createModel(modelId: string, deps?: ProviderDeps): LanguageModelV2;
}

const MODEL_ALIASES: ModelAliases = {
  'claude-opus-4-x': 'opus',
  'claude-sonnet-4-x': 'sonnet',
  'claude-haiku-4-x': 'haiku',
};

export const CLAUDE_CLI_DEFAULT_MODEL = 'claude-sonnet-4-x';

const MODELS: ModelInfo[] = [
  { id: 'claude-opus-4-x', label: 'Claude Opus (subscription)', capabilities: ['tools', 'streaming', 'reasoning', 'vision'], contextWindow: 200_000 },
  { id: 'claude-sonnet-4-x', label: 'Claude Sonnet (subscription)', capabilities: ['tools', 'streaming', 'reasoning', 'vision'], contextWindow: 200_000 },
  { id: 'claude-haiku-4-x', label: 'Claude Haiku (subscription)', capabilities: ['tools', 'streaming', 'vision'], contextWindow: 200_000 },
];

const INSTALL_HINT = 'Install Claude Code: https://docs.claude.com/en/docs/claude-code/setup';
const LOGIN_HINT = 'Run `claude` once to sign in to your Claude subscription, or use an Anthropic API key.';

/** Minimal child handle the provider needs — narrows `node:child_process` to a
 *  spawn seam so tests can inject a fake `claude` without a PATH shim. */
export interface SpawnedClaude {
  stdout: AsyncIterable<Uint8Array | string>;
  stderr: AsyncIterable<Uint8Array | string>;
  stdin: { end(): void } | null;
  kill(signal?: NodeJS.Signals): void;
  /** Resolves with Node's authoritative close outcome. */
  exit: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
}

export type ClaudeSpawn = (args: string[], opts: { signal?: AbortSignal }) => SpawnedClaude;

const defaultSpawn: ClaudeSpawn = (args, opts) => {
  const child = nodeSpawn('claude', args, { stdio: ['pipe', 'pipe', 'pipe'], signal: opts.signal });
  const exit = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
    child.on('close', (code, signal) => resolve({ code, signal: signal ?? null }));
    // `close` follows `error` and carries the authoritative code/signal pair.
    child.on('error', () => {});
  });
  return {
    stdout: child.stdout,
    stderr: child.stderr,
    stdin: child.stdin,
    kill: (signal) => child.kill(signal),
    exit,
  };
};

export interface ClaudeCliProviderOptions {
  /** Spawn seam (tests inject a fake `claude`). Defaults to `node:child_process`. */
  spawn?: ClaudeSpawn;
  /** Availability probe. Defaults to spawning `claude --version` + `auth status`. */
  probe?: () => Promise<ClaudeAvailability>;
}

export interface ClaudeAvailability {
  binary: boolean;
  loggedIn: boolean;
}

/** Probe the local `claude` binary once: is it on PATH, and is a subscription
 *  login present? Shares the exact spawn + `claude auth status` logic the
 *  provider uses, so the providers command and the model resolver never drift.
 *  Tests inject a fake `claude` through the spawn seam. */
export function checkClaudeAvailability(spawn: ClaudeSpawn = defaultSpawn): Promise<ClaudeAvailability> {
  return probeClaude(spawn);
}

export function createClaudeCliProvider(opts: ClaudeCliProviderOptions = {}): ClaudeModelProvider {
  const spawn = opts.spawn ?? defaultSpawn;
  const probe = opts.probe ?? (() => probeClaude(spawn));
  let cached: Promise<ClaudeAvailability> | null = null;
  const availability = () => (cached ??= probe());

  return {
    id: CLAUDE_CLI_PROVIDER_ID,
    label: 'Claude (subscription via Claude Code)',
    defaultModel: CLAUDE_CLI_DEFAULT_MODEL,
    async isAvailable() {
      const a = await availability();
      return a.binary && a.loggedIn;
    },
    async unavailableReason() {
      const a = await availability();
      if (!a.binary) return INSTALL_HINT;
      if (!a.loggedIn) return LOGIN_HINT;
      return undefined;
    },
    listModels: () => MODELS,
    createModel(modelId): LanguageModelV2 {
      return createClaudeCliModel(modelId, spawn);
    },
  };
}

/** Availability = binary on PATH AND a subscription login present. The binary
 *  IS the auth check (`claude auth status` reports `loggedIn`), so we never
 *  inspect credential files. A missing login also surfaces at call time. */
async function probeClaude(spawn: ClaudeSpawn): Promise<ClaudeAvailability> {
  const version = await runToString(spawn, ['--version']);
  if (version.code !== 0) return { binary: false, loggedIn: false };
  // `claude auth status` prints JSON ({ "loggedIn": true, ... }) on stdout; it
  // takes no --output-format flag. A subscription login is firstParty OAuth the
  // binary owns — we read only this status, never the credential itself.
  const status = await runToString(spawn, ['auth', 'status']);
  let loggedIn = false;
  try {
    const parsed = v.parse(v.object({ loggedIn: v.optional(v.boolean()) }), JSON.parse(status.stdout));
    loggedIn = parsed.loggedIn === true;
  } catch {
    loggedIn = false;
  }
  return { binary: true, loggedIn };
}

async function runToString(spawn: ClaudeSpawn, args: string[]): Promise<{ code: number | null; stdout: string }> {
  let child: SpawnedClaude;
  try {
    child = spawn(args, {});
  } catch {
    return { code: null, stdout: '' };
  }
  child.stdin?.end();
  // Drained concurrently with the exit so a chatty binary cannot fill the pipe
  // and deadlock. A missing binary surfaces as a premature-close stream error
  // rather than a synchronous spawn throw, and the failing exit code is the
  // authoritative signal — which is why only a read that fails while the probe
  // itself SUCCEEDED is unexplained, and that one is not ours to absorb.
  const [read, { code }] = await Promise.all([readAllOutcome(child.stdout), child.exit]);
  if ('text' in read) return { code, stdout: read.text };
  if (code === 0) {
    throw new Error(
      `\`claude ${args.join(' ')}\` exited 0 but its output could not be read`,
      { cause: read.error },
    );
  }
  return { code, stdout: '' };
}

async function readAll(stream: SpawnedClaude['stdout']): Promise<string> {
  const decoder = new TextDecoder();
  let out = '';
  for await (const chunk of stream) {
    const text = v.safeParse(v.string(), chunk);
    out += text.success
      ? text.output
      : decoder.decode(v.parse(v.instance(Uint8Array), chunk), { stream: true });
  }
  out += decoder.decode();
  return out;
}

/** `readAll`, with a read failure carried out as a value rather than thrown:
 *  every caller here has an exit outcome that says whether the failure is
 *  already explained, and that decision cannot be made inside a catch. */
async function readAllOutcome(
  stream: SpawnedClaude['stdout'],
): Promise<{ text: string } | { error: unknown }> {
  try {
    return { text: await readAll(stream) };
  } catch (error) {
    return { error };
  }
}

function createClaudeCliModel(specModelId: string, spawn: ClaudeSpawn): LanguageModelV2 {
  const alias = MODEL_ALIASES[specModelId] ?? specModelId;
  const model: LanguageModelV2 = {
    specificationVersion: 'v2',
    provider: CLAUDE_CLI_PROVIDER_ID,
    modelId: specModelId,
    supportedUrls: {},
    async doStream(options) {
      const stream = runClaudeStream(spawn, alias, options);
      return { stream };
    },
    async doGenerate(options) {
      return collectGenerate(runClaudeStream(spawn, alias, options));
    },
  };
  return model;
}

interface ClaudePrompt {
  system?: string;
  prompt: string;
}

/** Build the `claude -p` invocation. System turns map to --system-prompt; the
 *  conversation is flattened into the prompt arg with role labels so multi-turn
 *  context (including prior tool results, surfaced by Proteus's own loop as
 *  assistant/tool text) is carried faithfully. Tools are OFF — this provider is
 *  just the brain; Proteus's execute_tools/run loop wraps it. */
export function buildClaudePrompt(options: LanguageModelV2CallOptions): ClaudePrompt {
  const systemParts: string[] = [];
  const turns: string[] = [];
  for (const message of options.prompt) {
    if (message.role === 'system') {
      systemParts.push(message.content);
      continue;
    }
    const text = messageText(message);
    if (!text) continue;
    if (message.role === 'user') turns.push(text);
    else if (message.role === 'assistant') turns.push(`Assistant: ${text}`);
    else if (message.role === 'tool') turns.push(`Tool results:\n${text}`);
  }
  // A single user turn needs no role labels; multi-turn keeps the final user
  // turn bare (it is the live question) and labels the prior context.
  const prompt = turns.length <= 1
    ? (turns[0] ?? '')
    : `${turns.slice(0, -1).join('\n\n')}\n\n${turns[turns.length - 1]}`;
  return {
    system: systemParts.length ? systemParts.join('\n\n') : undefined,
    prompt,
  };
}

function messageText(message: LanguageModelV2CallOptions['prompt'][number]): string {
  if (message.role === 'system') return message.content;
  const parts: string[] = [];
  for (const part of message.content) {
    if (part.type === 'text') parts.push(part.text);
    else if (part.type === 'reasoning') parts.push(part.text);
    else if (part.type === 'tool-result') {
      const output = part.output;
      if (output.type === 'text' || output.type === 'error-text') parts.push(output.value);
      else parts.push(JSON.stringify(output.value));
    } else if (part.type === 'tool-call') {
      parts.push(`[called ${part.toolName}(${part.input})]`);
    }
  }
  return parts.join('\n').trim();
}

function claudeArgs(alias: string, built: ClaudePrompt): string[] {
  const args = [
    '-p', built.prompt,
    '--output-format', 'stream-json',
    '--verbose',
    '--include-partial-messages',
    '--input-format', 'text',
    '--tools', '',
    '--model', alias,
  ];
  if (built.system) args.push('--system-prompt', built.system);
  return args;
}

type FinishReason = 'stop' | 'length' | 'content-filter' | 'tool-calls' | 'error' | 'other' | 'unknown';

function runClaudeStream(
  spawn: ClaudeSpawn,
  alias: string,
  options: LanguageModelV2CallOptions,
): ReadableStream<LanguageModelV2StreamPart> {
  const built = buildClaudePrompt(options);
  return new ReadableStream<LanguageModelV2StreamPart>({
    async start(controller) {
      let child: SpawnedClaude;
      try {
        child = spawn(claudeArgs(alias, built), { signal: options.abortSignal });
      } catch (error) {
        controller.enqueue({ type: 'stream-start', warnings: [] });
        controller.enqueue({ type: 'error', error: spawnError({ error }) });
        controller.enqueue(finishPart('error', undefined));
        controller.close();
        return;
      }
      child.stdin?.end();

      controller.enqueue({ type: 'stream-start', warnings: [] });
      const textId = 'claude-text';
      let textOpen = false;
      let usage: Usage | undefined;
      let finishReason: FinishReason = 'stop';
      let stderr = '';
      // A stderr that cannot be read becomes part of the exit message below —
      // blanking it silently is how an exit-code error loses its only detail.
      const collectStderr = readAllOutcome(child.stderr).then((read) => {
        stderr = 'text' in read
          ? read.text
          : `<stderr unreadable: ${read.error instanceof Error ? read.error.message : String(read.error)}>`;
      });

      try {
        for await (const event of parseNdjson(child.stdout)) {
          const delta = textDelta(event);
          if (delta !== undefined) {
            if (!textOpen) {
              controller.enqueue({ type: 'text-start', id: textId });
              textOpen = true;
            }
            if (delta) controller.enqueue({ type: 'text-delta', id: textId, delta });
            continue;
          }
          if (isResult(event)) {
            usage = resultUsage(event);
            finishReason = mapFinishReason(event);
            if (event.is_error === true || event.subtype === 'error_max_turns' || event.subtype === 'error_during_execution') {
              if (textOpen) { controller.enqueue({ type: 'text-end', id: textId }); textOpen = false; }
              controller.enqueue({ type: 'error', error: new Error(resultErrorMessage(event)) });
            }
          }
        }
      } catch (error) {
        if (textOpen) { controller.enqueue({ type: 'text-end', id: textId }); textOpen = false; }
        if (!options.abortSignal?.aborted) {
          controller.enqueue({ type: 'error', error: error instanceof Error ? error : new Error(String(error)) });
        }
      }

      if (textOpen) controller.enqueue({ type: 'text-end', id: textId });
      const { code, signal } = await child.exit;
      await collectStderr;

      if (code === null && !options.abortSignal?.aborted) {
        controller.enqueue({ type: 'error', error: new Error(signalExitError(signal, stderr)) });
        finishReason = 'error';
      } else if (code !== 0 && code !== null && !usage) {
        controller.enqueue({ type: 'error', error: new Error(exitError(code, stderr)) });
        finishReason = 'error';
      }

      controller.enqueue(finishPart(finishReason, usage));
      controller.close();
    },
  });
}

/**
 * The turn's usage in the SDK's own dialect.
 *
 * `totalTokens` comes from `usageTotal`, so a result event that carried no
 * usage at all reports NO total rather than a synthesized `0 + 0` — the one
 * number a caller would have read as "this turn was free".
 *
 * `cacheWrite` has no seat on the way out: `LanguageModelV2Usage` models only a
 * cache READ (@ai-sdk/provider dist/index.d.ts:2673-2696), and ai's v2→v3
 * bridge hard-codes `cacheWrite: void 0` with no `raw` at all
 * (node_modules/ai/dist/index.js:828-841). It is not lost, though: it is part
 * of the cache-inclusive `input` total `resultUsage` folds.
 */
function finishPart(reason: FinishReason, reported: Usage | undefined): LanguageModelV2StreamPart {
  const usage = reported ?? {};
  return {
    type: 'finish',
    finishReason: reason,
    usage: {
      inputTokens: usage.input,
      outputTokens: usage.output,
      totalTokens: usageTotal(usage),
      cachedInputTokens: usage.cacheRead,
    },
  };
}

// ─── stream-json parsing ────────────────────────────────────────────────────

type ClaudeEvent = JsonObject;

/** Split the child's stdout into newline-delimited JSON events. */
async function* parseNdjson(stream: SpawnedClaude['stdout']): AsyncGenerator<ClaudeEvent> {
  const decoder = new TextDecoder();
  let buffer = '';
  for await (const chunk of stream) {
    const text = v.safeParse(v.string(), chunk);
    buffer += text.success
      ? text.output
      : decoder.decode(v.parse(v.instance(Uint8Array), chunk), { stream: true });
    let nl: number;
    while ((nl = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      const event = line ? parseEventLine(line) : null;
      if (event) yield event;
    }
  }
  buffer += decoder.decode();
  const tail = buffer.trim();
  const tailEvent = tail ? parseEventLine(tail) : null;
  if (tailEvent) yield tailEvent;
}

/**
 * One stream-json line → the event it carries, or null for a line that is not
 * one at all.
 *
 * Only unparseable TEXT is tolerated: the binary shares stdout with anything
 * else it decides to print, and a stray warning line must not end a turn. A
 * line that IS json but not an event object is a change in Claude Code's output
 * format, which propagates — silently reading every event as `{}` would stream
 * an empty answer with a clean finish reason and no way to tell why.
 */
function parseEventLine(line: string): ClaudeEvent | null {
  const event = tolerate(() => v.parse(JsonObjectSchema, JSON.parse(line)), 'malformed-input');
  if (event !== undefined) return event;
  diagnostics.failure(
    'provider.claude_stream_line_unparsed',
    new ProteusError('bad_input', `claude stream-json line is not json: ${line.slice(0, 200)}`),
  );
  return null;
}

/** Incremental text from a partial `stream_event` (content_block_delta →
 *  text_delta). Returns undefined when the event carries no text. */
function textDelta(event: ClaudeEvent): string | undefined {
  if (event.type !== 'stream_event') return undefined;
  const inner = jsonObject({ value: event.event });
  if (!inner || inner.type !== 'content_block_delta') return undefined;
  const delta = jsonObject({ value: inner.delta });
  if (!delta || delta.type !== 'text_delta') return undefined;
  const text = v.safeParse(v.string(), delta.text);
  return text.success ? text.output : '';
}

function isResult(event: ClaudeEvent): event is ClaudeEvent & { type: 'result' } {
  return event.type === 'result';
}

/**
 * What the binary said it spent, as the one usage type.
 *
 * Anthropic reports the prompt in three DISJOINT parts — plain input, cache
 * reads and cache writes — while `Usage.input` is the cache-INCLUSIVE total, so
 * the three are folded exactly as @ai-sdk/anthropic folds them. Reading only
 * `input_tokens` under-reported every cached prompt, and Claude Code caches
 * aggressively.
 *
 * The fold is absent unless the binary reported at least one part: `?? 0` on
 * all three would turn a result event that mentioned no usage into a measured
 * zero.
 */
function resultUsage(event: ClaudeEvent): Usage {
  const reported = jsonObject({ value: event.usage });
  if (!reported) return {};
  const input = numberOf({ value: reported.input_tokens });
  const output = numberOf({ value: reported.output_tokens });
  const cacheRead = numberOf({ value: reported.cache_read_input_tokens });
  const cacheWrite = numberOf({ value: reported.cache_creation_input_tokens });
  const usage: { -readonly [K in keyof Usage]: number } = {};
  if (input !== undefined || cacheRead !== undefined || cacheWrite !== undefined) {
    usage.input = (input ?? 0) + (cacheRead ?? 0) + (cacheWrite ?? 0);
  }
  if (output !== undefined) usage.output = output;
  if (cacheRead !== undefined) usage.cacheRead = cacheRead;
  if (cacheWrite !== undefined) usage.cacheWrite = cacheWrite;
  return usage;
}

function mapFinishReason(event: ClaudeEvent): FinishReason {
  if (event.is_error === true) return 'error';
  const stop = event.stop_reason;
  if (stop === 'max_tokens') return 'length';
  if (stop === 'tool_use') return 'tool-calls';
  if (stop === 'end_turn' || stop === 'stop_sequence') return 'stop';
  if (event.subtype === 'error_max_turns') return 'length';
  return 'stop';
}

function resultErrorMessage(event: ClaudeEvent): string {
  const apiError = v.safeParse(v.string(), event.api_error_status);
  if (apiError.success && apiError.output) return `Claude CLI error: ${apiError.output}`;
  const result = v.safeParse(v.string(), event.result);
  if (result.success && result.output) return `Claude CLI error: ${result.output}`;
  return 'Claude CLI returned an error.';
}

function numberOf(input: { value: unknown }): number | undefined {
  const parsed = v.safeParse(v.number(), input.value);
  return parsed.success && Number.isFinite(parsed.output) ? parsed.output : undefined;
}

function spawnError(input: { error: unknown }): Error {
  const message = input.error instanceof Error ? input.error.message : String(input.error);
  if (/ENOENT/.test(message)) return new Error(INSTALL_HINT);
  return new Error(`Failed to start Claude Code: ${message}`);
}

function jsonObject(input: { value: unknown }): JsonObject | null {
  const parsed = v.safeParse(JsonObjectSchema, input.value);
  return parsed.success ? parsed.output : null;
}

function exitError(code: number, stderr: string): string {
  const detail = stderr.trim();
  if (/not logged in|please run.*login|authentication/i.test(detail)) return LOGIN_HINT;
  if (/unknown model|invalid model|model .* not/i.test(detail)) {
    return `Claude Code did not accept the model: ${detail || 'unknown model'}.`;
  }
  return `Claude Code exited with code ${code}${detail ? `: ${detail}` : ''}.`;
}

function signalExitError(signal: NodeJS.Signals | null, stderr: string): string {
  const detail = stderr.trim().slice(-4_000);
  return `Claude Code terminated by signal ${signal ?? 'unknown'}${detail ? `: ${detail}` : ''}.`;
}

// ─── doGenerate (wraps doStream) ────────────────────────────────────────────

async function collectGenerate(
  stream: ReadableStream<LanguageModelV2StreamPart>,
): Promise<Awaited<ReturnType<LanguageModelV2['doGenerate']>>> {
  let text = '';
  let finishReason: FinishReason = 'stop';
  let usage: LanguageModelV2Usage = {
    inputTokens: undefined, outputTokens: undefined, totalTokens: undefined,
  };
  let error: unknown;
  const reader = stream.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value.type === 'text-delta') text += value.delta;
    else if (value.type === 'finish') { finishReason = value.finishReason; usage = value.usage; }
    else if (value.type === 'error') error = value.error;
  }
  if (error && !text) throw error instanceof Error ? error : new Error(String(error));
  return {
    content: text ? [{ type: 'text', text }] : [],
    finishReason,
    usage,
    warnings: [],
  };
}

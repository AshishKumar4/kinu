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
import type { LanguageModelV2, LanguageModelV2CallOptions, LanguageModelV2StreamPart } from '@ai-sdk/provider';
import type { LanguageModel } from 'ai';
import type { ModelProvider, ModelInfo } from '@proteus/core';
import { spawn as nodeSpawn } from 'node:child_process';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';

export const CLAUDE_CLI_PROVIDER_ID = 'claude';

/** Spec model id → the `claude --model` alias the binary accepts. Aliases
 *  resolve to the latest model in each family, so they don't drift with point
 *  releases the way pinned `claude-opus-4-7` ids do. */
const MODEL_ALIASES: Record<string, string> = {
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
  stdout: AsyncIterable<Uint8Array> | NodeJS.ReadableStream;
  stderr: AsyncIterable<Uint8Array> | NodeJS.ReadableStream;
  stdin: { end(): void } | null;
  kill(signal?: NodeJS.Signals): void;
  /** Resolves with the process exit code (null when killed by signal). */
  exit: Promise<number | null>;
}

export type ClaudeSpawn = (args: string[], opts: { signal?: AbortSignal }) => SpawnedClaude;

const defaultSpawn: ClaudeSpawn = (args, opts) => {
  const child = nodeSpawn('claude', args, { stdio: ['pipe', 'pipe', 'pipe'], signal: opts.signal }) as ChildProcessWithoutNullStreams;
  const exit = new Promise<number | null>((resolve) => {
    child.on('close', (code) => resolve(code));
    child.on('error', () => resolve(null));
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

export function createClaudeCliProvider(opts: ClaudeCliProviderOptions = {}): ModelProvider {
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
    createModel(modelId): LanguageModel {
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
    const parsed = JSON.parse(status.stdout) as { loggedIn?: unknown };
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
  const stdout = await readAll(child.stdout);
  const code = await child.exit;
  return { code, stdout };
}

async function readAll(stream: SpawnedClaude['stdout']): Promise<string> {
  const decoder = new TextDecoder();
  let out = '';
  for await (const chunk of stream as AsyncIterable<Uint8Array | string>) {
    out += typeof chunk === 'string' ? chunk : decoder.decode(chunk, { stream: true });
  }
  out += decoder.decode();
  return out;
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
        controller.enqueue({ type: 'error', error: spawnError(error) });
        controller.enqueue(finishPart('error', undefined));
        controller.close();
        return;
      }
      child.stdin?.end();

      controller.enqueue({ type: 'stream-start', warnings: [] });
      const textId = 'claude-text';
      let textOpen = false;
      let usage: ClaudeUsage | undefined;
      let finishReason: FinishReason = 'stop';
      let stderr = '';
      const collectStderr = readAll(child.stderr).then((s) => { stderr = s; }).catch(() => {});

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
        controller.enqueue({ type: 'error', error: error instanceof Error ? error : new Error(String(error)) });
      }

      if (textOpen) controller.enqueue({ type: 'text-end', id: textId });
      const code = await child.exit;
      await collectStderr;

      if (code !== 0 && code !== null && !usage) {
        controller.enqueue({ type: 'error', error: new Error(exitError(code, stderr)) });
        finishReason = 'error';
      }

      controller.enqueue(finishPart(finishReason, usage));
      controller.close();
    },
  });
}

function finishPart(reason: FinishReason, usage: ClaudeUsage | undefined): LanguageModelV2StreamPart {
  return {
    type: 'finish',
    finishReason: reason,
    usage: {
      inputTokens: usage?.inputTokens,
      outputTokens: usage?.outputTokens,
      totalTokens: usage ? (usage.inputTokens ?? 0) + (usage.outputTokens ?? 0) : undefined,
      cachedInputTokens: usage?.cachedInputTokens,
    },
  };
}

interface ClaudeUsage {
  inputTokens?: number;
  outputTokens?: number;
  cachedInputTokens?: number;
}

// ─── stream-json parsing ────────────────────────────────────────────────────

type ClaudeEvent = Record<string, unknown>;

/** Split the child's stdout into newline-delimited JSON events. */
async function* parseNdjson(stream: SpawnedClaude['stdout']): AsyncGenerator<ClaudeEvent> {
  const decoder = new TextDecoder();
  let buffer = '';
  for await (const chunk of stream as AsyncIterable<Uint8Array | string>) {
    buffer += typeof chunk === 'string' ? chunk : decoder.decode(chunk, { stream: true });
    let nl: number;
    while ((nl = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (line) yield safeParse(line);
    }
  }
  buffer += decoder.decode();
  const tail = buffer.trim();
  if (tail) yield safeParse(tail);
}

function safeParse(line: string): ClaudeEvent {
  try {
    const value = JSON.parse(line) as unknown;
    return value && typeof value === 'object' ? (value as ClaudeEvent) : {};
  } catch {
    return {};
  }
}

/** Incremental text from a partial `stream_event` (content_block_delta →
 *  text_delta). Returns undefined when the event carries no text. */
function textDelta(event: ClaudeEvent): string | undefined {
  if (event.type !== 'stream_event') return undefined;
  const inner = event.event as ClaudeEvent | undefined;
  if (!inner || inner.type !== 'content_block_delta') return undefined;
  const delta = inner.delta as ClaudeEvent | undefined;
  if (!delta || delta.type !== 'text_delta') return undefined;
  return typeof delta.text === 'string' ? delta.text : '';
}

function isResult(event: ClaudeEvent): event is ClaudeEvent & { type: 'result' } {
  return event.type === 'result';
}

function resultUsage(event: ClaudeEvent): ClaudeUsage {
  const usage = event.usage as ClaudeEvent | undefined;
  if (!usage) return {};
  return {
    inputTokens: numberOf(usage.input_tokens),
    outputTokens: numberOf(usage.output_tokens),
    cachedInputTokens: numberOf(usage.cache_read_input_tokens),
  };
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
  const apiError = event.api_error_status;
  if (typeof apiError === 'string' && apiError) return `Claude CLI error: ${apiError}`;
  const result = event.result;
  if (typeof result === 'string' && result) return `Claude CLI error: ${result}`;
  return 'Claude CLI returned an error.';
}

function numberOf(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function spawnError(error: unknown): Error {
  const message = error instanceof Error ? error.message : String(error);
  if (/ENOENT/.test(message)) return new Error(INSTALL_HINT);
  return new Error(`Failed to start Claude Code: ${message}`);
}

function exitError(code: number, stderr: string): string {
  const detail = stderr.trim();
  if (/not logged in|please run.*login|authentication/i.test(detail)) return LOGIN_HINT;
  if (/unknown model|invalid model|model .* not/i.test(detail)) {
    return `Claude Code did not accept the model: ${detail || 'unknown model'}.`;
  }
  return `Claude Code exited with code ${code}${detail ? `: ${detail}` : ''}.`;
}

// ─── doGenerate (wraps doStream) ────────────────────────────────────────────

async function collectGenerate(
  stream: ReadableStream<LanguageModelV2StreamPart>,
): Promise<Awaited<ReturnType<LanguageModelV2['doGenerate']>>> {
  let text = '';
  let finishReason: FinishReason = 'stop';
  let usage: { inputTokens: number | undefined; outputTokens: number | undefined; totalTokens: number | undefined; cachedInputTokens?: number } = {
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

// Claude subscription provider, local only: drives the official `claude` binary with tools off.
// The binary owns the OAuth; Kinu never reads ~/.claude credentials or calls api.anthropic.com.
// Must stay unreachable from cf-backend.
import type { LanguageModelV2, LanguageModelV2CallOptions, LanguageModelV2FunctionTool, LanguageModelV2StreamPart, LanguageModelV2Usage } from '@ai-sdk/provider';
import { JsonObjectSchema, JsonValueSchema, usageTotal, type JsonValue } from '@kinu.run/core';
import { classify, diagnostics, KinuError, renderThrownChain, tolerate } from '@kinu.run/core/obs';
import type { JsonObject, ModelProvider, ModelInfo, ProviderDeps, Usage } from '@kinu.run/core';
import { spawn as nodeSpawn } from 'node:child_process';
import * as v from 'valibot';
import { readAllOutcome } from '@kinu.run/core';

export const CLAUDE_CLI_PROVIDER_ID = 'claude';

/** Spec model id → `claude --model` family alias, which tracks the latest point release. */
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

const CLAUDE_CLI_DEFAULT_MODEL = 'claude-sonnet-4-x';

const MODELS: ModelInfo[] = [
  { id: 'claude-opus-4-x', label: 'Claude Opus (subscription)', capabilities: ['tools', 'streaming', 'reasoning', 'vision'], contextWindow: 200_000 },
  { id: 'claude-sonnet-4-x', label: 'Claude Sonnet (subscription)', capabilities: ['tools', 'streaming', 'reasoning', 'vision'], contextWindow: 200_000 },
  { id: 'claude-haiku-4-x', label: 'Claude Haiku (subscription)', capabilities: ['tools', 'streaming', 'vision'], contextWindow: 200_000 },
];

const INSTALL_HINT = 'Install Claude Code: https://docs.claude.com/en/docs/claude-code/setup';

const LOGIN_HINT = 'Run `claude` once to sign in to your Claude subscription, or use an Anthropic API key.';

/** Spawn seam so tests can inject a fake `claude` without a PATH shim. */
export interface SpawnedClaude {
  stdout: AsyncIterable<Uint8Array | string>;
  stderr: AsyncIterable<Uint8Array | string>;
  stdin: { end(): void } | null;
  kill(signal?: NodeJS.Signals): void;
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
  spawn?: ClaudeSpawn;
  probe?: () => Promise<ClaudeAvailability>;
}

export interface ClaudeAvailability {
  binary: boolean;
  loggedIn: boolean;
}

/** Probe once whether `claude` is on PATH and logged in, sharing the provider's spawn logic. */
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

/** `claude auth status` is the auth check; credential files are never inspected. */
async function probeClaude(spawn: ClaudeSpawn): Promise<ClaudeAvailability> {
  const version = await runToString(spawn, ['--version']);

  if (version.code !== 0) return { binary: false, loggedIn: false };
  // `auth status` prints JSON on stdout and takes no --output-format flag.
  const status = await runToString(spawn, ['auth', 'status']);
  let loggedIn = false;

  try {
    const parsed = v.parse(v.object({ loggedIn: v.optional(v.boolean()) }), JSON.parse(status.stdout));
    loggedIn = parsed.loggedIn === true;
  } catch (error) {
    if (classify({ cause: error }) !== 'malformed-input') throw error;
    loggedIn = false;
  }

  return { binary: true, loggedIn };
}

async function runToString(spawn: ClaudeSpawn, args: string[]): Promise<{ code: number | null; stdout: string }> {
  let child: SpawnedClaude;

  try {
    child = spawn(args, {});
  } catch (error) {
    diagnostics.event('claude_cli.spawn_failed', { error: renderThrownChain({ cause: error }) });

    return { code: null, stdout: '' };
  }

  child.stdin?.end();
  // Drained concurrently with exit so a chatty binary cannot deadlock the pipe. A missing binary
  // shows as a stream error; only a read failure while the probe succeeded is unexplained.
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

/** Build the `claude -p` invocation: system turns → --system-prompt, the rest flattened with
 *  role labels. The binary's tools stay off; requested tools ride the system prompt as a manifest. */
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

  // The final user turn stays bare; prior turns get role labels.
  const prompt = turns.length <= 1
    ? (turns[0] ?? '')
    : `${turns.slice(0, -1).join('\n\n')}\n\n${turns[turns.length - 1]}`;

  const system = systemParts.length ? systemParts.join('\n\n') : undefined;
  const tools = (options.tools ?? []).filter((t): t is LanguageModelV2FunctionTool => t.type === 'function');

  return {
    system: tools.length > 0
      ? [system, toolProtocol(tools)].filter((part) => part !== undefined).join('\n\n')
      : system,
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
      parts.push(`[called ${part.toolName}(${JSON.stringify(part.input)})]`);
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

// Tool-call protocol: tools ride the prompt in the block form Claude models are trained to emit,
// and the stream parser lifts those blocks back out as tool-call parts.
const OPEN_TAGS = ['<function_calls>', '<antml:function_calls>'] as const;

interface OpenBlock {
  open: string;
  close: string;
  body: string;
}

/** Prompt-side half of the protocol, in the exact shape the parser reads back. */
function toolProtocol(tools: readonly LanguageModelV2FunctionTool[]): string {
  const manifest = tools.map((t) => {
    const head = t.description ? `- ${t.name}: ${t.description}` : `- ${t.name}`;

    return `${head}\n  Parameters (JSON schema): ${JSON.stringify(t.inputSchema)}`;
  });

  return [
    '# Tools',
    '',
    'To use a tool, output exactly this block and then stop:',
    '',
    '<function_calls>',
    '<invoke name="TOOL_NAME">',
    '<parameter name="PARAM_NAME">value</parameter>',
    '</invoke>',
    '</function_calls>',
    '',
    'The result arrives as the next message. Never invent one.',
    'Available tools:',
    ...manifest,
  ].join('\n');
}

interface ParsedToolCall {
  toolCallId: string;
  toolName: string;
  input: string;
}

/** XML-unescape a value; a JSON array/object value becomes that structure. */
function parameterValue(raw: string): JsonValue {
  const decoded = raw
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&quot;', '"')
    .replaceAll('&apos;', "'")
    .replaceAll('&amp;', '&');

  if (/^[[{]/.test(decoded.trim())) {
    const parsed = tolerate(() => v.parse(JsonValueSchema, JSON.parse(decoded)), 'malformed-input');

    if (parsed !== undefined) return parsed;
  }

  return decoded;
}

function parseFunctionCalls(block: string, firstId: number): ParsedToolCall[] {
  const calls: ParsedToolCall[] = [];
  const invokeRe = /<invoke\s+name="([^"]*)"\s*>([\s\S]*?)<\/invoke>/g;

  for (let invoke = invokeRe.exec(block); invoke !== null; invoke = invokeRe.exec(block)) {
    const params: Record<string, JsonValue> = {};
    const paramRe = /<parameter\s+name="([^"]*)"\s*>([\s\S]*?)<\/parameter>/g;

    for (let param = paramRe.exec(invoke[2]); param !== null; param = paramRe.exec(invoke[2])) {
      params[param[1]] = parameterValue(param[2]);
    }

    calls.push({
      toolCallId: `claude-fc-${firstId + calls.length}`,
      toolName: invoke[1],
      input: JSON.stringify(params),
    });
  }

  return calls;
}

/** Longest suffix of `text` that could still grow into a prefix of `tag`. */
function partialTagTail(text: string, tags: readonly string[]): number {
  for (let keep = Math.min(text.length, Math.max(...tags.map((t) => t.length)) - 1); keep > 0; keep--) {
    const tail = text.slice(-keep);

    if (tags.some((t) => t.startsWith(tail))) return keep;
  }

  return 0;
}

interface SplitChunk {
  text: string;
  calls: ParsedToolCall[];
}

/** Splits text into plain text and complete function_calls blocks. Tags can straddle deltas, so
 *  only a suffix that could still become an open tag is held back. */
class ToolCallSplitter {
  private pending = '';
  private block: OpenBlock | null = null;
  private nextId = 1;

  push(delta: string): SplitChunk {
    this.pending += delta;
    const text: string[] = [];
    const calls: ParsedToolCall[] = [];

    for (;;) {
      if (this.block === null) {
        const open = OPEN_TAGS
          .map((tag) => ({ tag, index: this.pending.indexOf(tag) }))
          .filter((hit) => hit.index >= 0)
          .sort((a, b) => a.index - b.index)[0];

        if (!open) {
          const keep = partialTagTail(this.pending, OPEN_TAGS);
          const emit = this.pending.slice(0, this.pending.length - keep);

          if (emit) text.push(emit);
          this.pending = this.pending.slice(this.pending.length - keep);
          break;
        }

        if (open.index > 0) text.push(this.pending.slice(0, open.index));
        this.pending = this.pending.slice(open.index + open.tag.length);
        this.block = {
          open: open.tag,
          close: open.tag === '<function_calls>' ? '</function_calls>' : '</antml:function_calls>',
          body: '',
        };
      } else {
        const close = this.block.close;
        const idx = this.pending.indexOf(close);

        if (idx < 0) {
          const keep = partialTagTail(this.pending, [close]);
          const take = this.pending.slice(0, this.pending.length - keep);

          if (take) this.block.body += take;
          this.pending = this.pending.slice(this.pending.length - keep);
          break;
        }

        this.block.body += this.pending.slice(0, idx);
        this.pending = this.pending.slice(idx + close.length);
        const parsed = parseFunctionCalls(this.block.body, this.nextId);
        this.nextId += parsed.length;
        calls.push(...parsed);
        this.block = null;
      }
    }

    return { text: text.join(''), calls };
  }

  /** An unterminated block streams as the text it visibly is rather than vanishing. */
  end(): SplitChunk {
    const text: string[] = [];
    const calls: ParsedToolCall[] = [];

    if (this.block !== null) {
      const parsed = parseFunctionCalls(this.block.body, this.nextId);

      if (parsed.length > 0) calls.push(...parsed);
      else text.push(this.block.open + this.block.body);
      this.block = null;
    }

    if (this.pending) {
      text.push(this.pending);
      this.pending = '';
    }

    return { text: text.join(''), calls };
  }
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
      const splitter = new ToolCallSplitter();
      let segment = 0;
      let textId = '';
      let textOpen = false;
      let emittedToolCalls = false;
      let usage: Usage | undefined;
      let finishReason: FinishReason = 'stop';
      let stderr = '';

      // Unreadable stderr becomes part of the exit message instead of being blanked.
      const collectStderr = readAllOutcome(child.stderr).then((read) => {
        stderr = 'text' in read
          ? read.text
          : `<stderr unreadable: ${read.error instanceof Error ? read.error.message : String(read.error)}>`;
      });

      const openText = () => {
        if (!textOpen) {
          textId = `claude-text-${segment}`;
          controller.enqueue({ type: 'text-start', id: textId });
          textOpen = true;
        }
      };

      const closeText = () => {
        if (textOpen) {
          controller.enqueue({ type: 'text-end', id: textId });
          textOpen = false;
          segment += 1;
        }
      };

      const emitCalls = (calls: ParsedToolCall[]) => {
        closeText();

        for (const call of calls) {
          controller.enqueue({ type: 'tool-call', toolCallId: call.toolCallId, toolName: call.toolName, input: call.input });
        }

        emittedToolCalls ||= calls.length > 0;
      };

      try {
        for await (const event of parseNdjson(child.stdout)) {
          const delta = textDelta(event);

          if (delta !== undefined) {
            const split = splitter.push(delta);

            if (split.text) {
              openText();
              controller.enqueue({ type: 'text-delta', id: textId, delta: split.text });
            }

            if (split.calls.length > 0) emitCalls(split.calls);
            continue;
          }

          if (isResult(event)) {
            usage = resultUsage(event);
            finishReason = mapFinishReason(event);

            if (event.is_error === true || event.subtype === 'error_max_turns' || event.subtype === 'error_during_execution') {
              closeText();
              controller.enqueue({ type: 'error', error: new Error(resultErrorMessage(event)) });
            }
          }
        }
      } catch (error) {
        closeText();

        if (!options.abortSignal?.aborted) {
          controller.enqueue({ type: 'error', error: error instanceof Error ? error : new Error(String(error)) });
        }
      }

      const tail = splitter.end();

      if (tail.text) {
        openText();
        controller.enqueue({ type: 'text-delta', id: textId, delta: tail.text });
      }

      if (tail.calls.length > 0) emitCalls(tail.calls);
      closeText();
      const { code, signal } = await child.exit;
      await collectStderr;

      if (code === null && !options.abortSignal?.aborted) {
        controller.enqueue({ type: 'error', error: new Error(signalExitError(signal, stderr)) });
        finishReason = 'error';
      } else if (code !== 0 && code !== null && !usage) {
        controller.enqueue({ type: 'error', error: new Error(exitError(code, stderr)) });
        finishReason = 'error';
      }

      if (emittedToolCalls && finishReason === 'stop') finishReason = 'tool-calls';

      controller.enqueue(finishPart(finishReason, usage));
      controller.close();
    },
  });
}

/**
 * Usage in the SDK dialect. No usage reported → no total, never a synthesized 0. `cacheWrite`
 * has no V2 seat but is included in the cache-inclusive `input` total.
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

type ClaudeEvent = JsonObject;

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
 * One stream-json line → its event, or null for non-JSON text (stray warnings must not end a turn).
 * JSON that is not an event object propagates: it signals a Claude Code output-format change.
 */
function parseEventLine(line: string): ClaudeEvent | null {
  const event = tolerate(() => v.parse(JsonObjectSchema, JSON.parse(line)), 'malformed-input');

  if (event !== undefined) return event;
  diagnostics.failure(
    'provider.claude_stream_line_unparsed',
    new KinuError('bad_input', `claude stream-json line is not json: ${line.slice(0, 200)}`),
  );

  return null;
}

/** Incremental text from a `stream_event` text_delta, or undefined. */
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
 * Folds Anthropic's disjoint input, cache-read and cache-write counts into the cache-inclusive
 * `Usage.input`, as @ai-sdk/anthropic does. Absent unless at least one part was reported.
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

/** The doGenerate result shape the v2 spec types only inline. */
interface ClaudeGenerateResult {
  content: Array<
    | { type: 'text'; text: string }
    | { type: 'tool-call'; toolCallId: string; toolName: string; input: string }
  >;
  finishReason: FinishReason;
  usage: LanguageModelV2Usage;
  warnings: [];
}

async function collectGenerate(
  stream: ReadableStream<LanguageModelV2StreamPart>,
): Promise<ClaudeGenerateResult> {
  let text = '';
  const toolCalls: Array<{ type: 'tool-call'; toolCallId: string; toolName: string; input: string }> = [];
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
    else if (value.type === 'tool-call') {
      toolCalls.push({ type: 'tool-call', toolCallId: value.toolCallId, toolName: value.toolName, input: value.input });
    } else if (value.type === 'finish') {
      finishReason = value.finishReason;
      usage = value.usage;
    } else if (value.type === 'error') error = value.error;
  }

  if (error && !text && toolCalls.length === 0) throw error instanceof Error ? error : new Error(renderThrownChain({ cause: error }));

  return {
    content: [
      ...(text ? [{ type: 'text' as const, text }] : []),
      ...toolCalls,
    ],
    finishReason,
    usage,
    warnings: [],
  };
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


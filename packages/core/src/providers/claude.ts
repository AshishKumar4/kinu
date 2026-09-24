// Claude Pro/Max over its OAuth login, sent as Claude Code's CLI per oh-my-pi (THIRD_PARTY_NOTICES.md).
import { createAnthropic } from '@ai-sdk/anthropic';
import { APICallError, type LanguageModel } from 'ai';
import * as v from 'valibot';
import { listAnthropicModels, ANTHROPIC_DEFAULT_MODEL, ANTHROPIC_FAST_MODEL } from './anthropic';
import { asFetchFunction, copyHeaders } from './fetch-shim';
import { OAuthTokenError } from './oauth-token-error';
import { quotaWindowText, withCallAccount } from './quota';
import { withRateLimitRetry } from './rate-limit-retry';
import type { AuthResolution, ModelProvider, ProviderDeps } from './types';
import { accountOf } from '../credentials/accounts';
import { diagnostics, KinuError, tolerate } from '../obs/index';
import { sha256Hex } from '../safety/argument-digest';
import { JsonObjectSchema, JsonValueSchema, parseJsonObject, parseJsonValue } from '../utils/json';
import { xxHash64 } from '../utils/xxhash64';

export const CLAUDE_CRED_KEY = 'claude.oauth';

const CLAUDE_MESSAGES_URL = 'https://api.anthropic.com/v1/messages?beta=true';

/** `bun scripts/check-spoofed-versions.ts --update` bumps it. */
const DEFAULT_CLAUDE_CODE_VERSION = '2.1.281';

export const CLAUDE_CODE_SDK_VERSION = '0.112.1';

const CLAUDE_CODE_IDENTITY = "You are Claude Code, Anthropic's official CLI for Claude.";

const CLAUDE_CODE_MAX_OUTPUT_TOKENS = 64_000;

const THINKING_OUTPUT_BUFFER = 4_000;

const BILLING_PREFIX = 'x-anthropic-billing-header:';

const CCH_PLACEHOLDER = 'cch=00000';

const CCH_SEED = 0x4d659218e32a3268n;

const BILLING_MARKER = `"system":[{"type":"text","text":"${BILLING_PREFIX}`;

const TOOL_PREFIX = '_';

const SERVER_TOOL_NAMES: ReadonlySet<string> = new Set(['web_search', 'code_execution', 'text_editor', 'computer']);

const OAUTH_BETA = 'oauth-2025-04-20';

const UTILITY_BETAS = [
  OAUTH_BETA, 'interleaved-thinking-2025-05-14', 'thinking-token-count-2026-05-13',
  'context-management-2025-06-27', 'prompt-caching-scope-2026-01-05', 'structured-outputs-2025-12-15',
];

const AGENT_BETAS = [
  'claude-code-20250219', OAUTH_BETA, 'interleaved-thinking-2025-05-14', 'thinking-token-count-2026-05-13',
  'context-management-2025-06-27', 'prompt-caching-scope-2026-01-05', 'mid-conversation-system-2026-04-07',
];

const EFFORT_BETA = 'effort-2025-11-24';

const FALLBACK_CREDIT_BETA = 'fallback-credit-2026-06-01';

const MAX_CACHE_BREAKPOINTS = 4;

const STAINLESS_OS = new Map([['darwin', 'MacOS'], ['win32', 'Windows'], ['linux', 'Linux'], ['freebsd', 'FreeBSD']]);

const STAINLESS_ARCH = new Map([['x64', 'x64'], ['amd64', 'x64'], ['arm64', 'arm64'], ['aarch64', 'arm64'], ['ia32', 'x86'], ['x86', 'x86']]);

const HOST = v.parse(v.fallback(v.object({ platform: v.string(), arch: v.string() }), { platform: 'linux', arch: 'x64' }), globalThis.process);

const DEAD_LOGIN = 'Your Claude login is no longer valid. Reconnect Claude in User settings, or run `kinu provider connect claude`.';

const NOT_CONNECTED = 'Claude is not connected. Connect Claude in User settings, or run `kinu provider connect claude`.';

const BlockSchema = v.looseObject({
  type: v.string(),
  text: v.optional(v.string()),
  name: v.optional(v.string()),
  cache_control: v.optional(JsonObjectSchema),
});

type Block = v.InferInput<typeof BlockSchema>;

const MessageSchema = v.looseObject({ role: v.string(), content: v.union([v.string(), v.array(BlockSchema)]) });

type Message = v.InferInput<typeof MessageSchema>;

const ToolSchema = v.looseObject({ name: v.optional(v.string()), strict: v.optional(v.boolean()), cache_control: v.optional(JsonObjectSchema) });

/** Checked in place, so every field keeps its order. */
const SdkBodySchema = v.looseObject({
  max_tokens: v.optional(v.number()),
  system: v.optional(v.union([v.string(), v.array(BlockSchema)])),
  messages: v.array(MessageSchema),
  tools: v.optional(v.array(ToolSchema)),
  tool_choice: v.optional(v.looseObject({ type: v.string(), name: v.optional(v.string()) })),
  thinking: v.optional(v.looseObject({ type: v.string(), budget_tokens: v.optional(v.number()) })),
  output_config: v.optional(v.looseObject({ effort: v.optional(v.string()) })),
  output_format: v.optional(JsonValueSchema),
});

type SdkBody = v.InferInput<typeof SdkBodySchema>;

const ToolUseStartSchema = v.looseObject({
  type: v.literal('content_block_start'),
  content_block: v.looseObject({ type: v.literal('tool_use'), name: v.string() }),
});

const MessageReplySchema = v.looseObject({ content: v.array(BlockSchema) });

interface ClaudeCodeVersion {
  current(): string;
  /** True only when the version rose. */
  adopt(refusalText: string): boolean;
}

function compareVersions(a: string, b: string): number {
  const left = a.split('.').map(Number);
  const right = b.split('.').map(Number);

  for (let index = 0; index < 3; index++) {
    const diff = (left[index] ?? 0) - (right[index] ?? 0);

    if (diff !== 0) return diff;
  }

  return 0;
}

function createClaudeCodeVersion(): ClaudeCodeVersion {
  let version = DEFAULT_CLAUDE_CODE_VERSION;

  return {
    current: () => version,
    adopt(refusalText) {
      const required = /version (\d+\.\d+\.\d+) or newer is required/i.exec(refusalText)?.[1];

      if (!refusalText.includes('claude_code_version_too_old') || required === undefined) return false;

      if (compareVersions(required, version) <= 0) return false;
      diagnostics.event('provider.claude_code_version_adopted', { from: version, to: required });
      version = required;

      return true;
    },
  };
}

interface ClaudeCodeHeaderInput {
  readonly authorization: string;
  readonly version: string;
  readonly betas: readonly string[];
  readonly sessionId: string | undefined;
}

function claudeCodeHeaders(input: ClaudeCodeHeaderInput) {
  return {
    Accept: 'application/json',
    'Content-Type': 'application/json',
    'User-Agent': `claude-cli/${input.version} (external, cli)`,
    ...(input.sessionId !== undefined && { 'X-Claude-Code-Session-Id': input.sessionId }),
    'X-Stainless-Arch': STAINLESS_ARCH.get(HOST.arch) ?? `other::${HOST.arch}`,
    'X-Stainless-Lang': 'js',
    'X-Stainless-OS': STAINLESS_OS.get(HOST.platform) ?? `Other::${HOST.platform}`,
    'X-Stainless-Package-Version': CLAUDE_CODE_SDK_VERSION,
    'X-Stainless-Retry-Count': '0',
    'X-Stainless-Runtime': 'node',
    'X-Stainless-Runtime-Version': 'v26.3.0',
    'X-Stainless-Timeout': '600',
    'anthropic-beta': input.betas.join(','),
    'anthropic-dangerous-direct-browser-access': 'true',
    'anthropic-version': '2023-06-01',
    Authorization: input.authorization,
    'x-app': 'cli',
    Connection: 'keep-alive',
    'Accept-Encoding': 'gzip, deflate, br, zstd',
  };
}

/** The SDK names structured outputs for every tool; only an enforced schema needs it. */
function betasTheBodyNeeds(body: SdkBody, sdkBetas: readonly string[]): string[] {
  const enforced = body.output_format !== undefined || (body.tools ?? []).some((declared) => declared.strict === true);
  const needed = sdkBetas.filter((beta) => enforced || !beta.trim().startsWith('structured-outputs-'));

  return body.output_config?.effort === undefined ? needed : [...needed, EFFORT_BETA];
}

function claudeCodeBetas(body: SdkBody, sdkBetas: readonly string[]): string[] {
  const thinking = (body.thinking?.type ?? 'disabled') !== 'disabled';
  const agent = (body.tools ?? []).length > 0 || thinking;
  const base = agent ? [...AGENT_BETAS, ...(thinking ? [EFFORT_BETA] : []), FALLBACK_CREDIT_BETA] : UTILITY_BETAS;
  const extra = betasTheBodyNeeds(body, sdkBetas);

  return [...new Set([...base, ...extra].map((beta) => beta.trim()).filter((beta) => beta !== ''))];
}

function blocksOf(content: Message['content'] | undefined): Block[] {
  if (content === undefined) return [];

  return Array.isArray(content) ? content : [{ type: 'text', text: content }];
}

function claudeBillingHeader(messages: readonly Message[], version: string): string {
  const first = blocksOf(messages.find((message) => message.role === 'user')?.content);
  const text = first.find((block) => block.type === 'text')?.text ?? '';
  const sample = [4, 7, 20].map((index) => text[index] ?? '0').join('');
  const suffix = sha256Hex(`59cf53e54c78${sample}${version}`, 3);

  return `${BILLING_PREFIX} cc_version=${version}.${suffix}; cc_entrypoint=cli; ${CCH_PLACEHOLDER};`;
}

function wireToolName(name: string): string {
  return SERVER_TOOL_NAMES.has(name.toLowerCase()) ? name : `${TOOL_PREFIX}${name}`;
}

function withWireName<T extends { readonly name?: string | undefined }>(declared: T): T {
  return declared.name === undefined ? declared : { ...declared, name: wireToolName(declared.name) };
}

function localToolName(name: string): string {
  return name.startsWith(TOOL_PREFIX) ? name.slice(TOOL_PREFIX.length) : name;
}

function withWireToolNames(messages: readonly Message[]): Message[] {
  return messages.map((message) => message.role !== 'assistant' || !Array.isArray(message.content)
    ? message
    : { ...message, content: message.content.map((block) => block.type === 'tool_use' ? withWireName(block) : block) });
}

function breakpointsOf(body: SdkBody): { readonly cache_control?: v.InferInput<typeof JsonObjectSchema> | undefined }[] {
  const decorated = [...(body.tools ?? []), ...blocksOf(body.system), ...body.messages.flatMap((message) => blocksOf(message.content))];

  return decorated.filter((block) => block.cache_control !== undefined);
}

/** The identity block's breakpoint displaces the prompt's past four. */
function claudeSystem(body: SdkBody, billing: string): Block[] {
  const decorated = breakpointsOf(body);
  const ttl = decorated[0]?.cache_control ?? { type: 'ephemeral' };
  let overCap = decorated.length + 1 - MAX_CACHE_BREAKPOINTS;

  const prompt = blocksOf(body.system).map((block) => {
    if (overCap <= 0 || block.cache_control === undefined) return block;
    overCap--;
    const { cache_control: _yielded, ...rest } = block;

    return rest;
  });

  return [{ type: 'text', text: billing }, { type: 'text', text: CLAUDE_CODE_IDENTITY, cache_control: ttl }, ...prompt];
}

function outputFits(body: SdkBody) {
  const maxTokens = Math.min(body.max_tokens ?? CLAUDE_CODE_MAX_OUTPUT_TOKENS, CLAUDE_CODE_MAX_OUTPUT_TOKENS);
  const budget = body.thinking?.type === 'enabled' ? (body.thinking.budget_tokens ?? 0) : 0;

  if (budget <= 0) return { max_tokens: maxTokens };
  const raised = Math.min(Math.max(maxTokens, budget + THINKING_OUTPUT_BUFFER), CLAUDE_CODE_MAX_OUTPUT_TOKENS);

  return budget + THINKING_OUTPUT_BUFFER <= raised
    ? { max_tokens: raised }
    : { max_tokens: raised, thinking: { ...body.thinking, budget_tokens: raised - THINKING_OUTPUT_BUFFER } };
}

function claudeCodeBody(body: SdkBody, version: string, sessionId: string) {
  const {
    model, messages, system: _system, tools, metadata: _metadata, max_tokens: _maxTokens, thinking, context_management,
    compaction, output_config, fallbacks, anthropic_beta, stream, temperature, top_p, top_k, stop_sequences, speed,
    tool_choice, ...rest
  } = body;

  const fits = outputFits(body);

  return {
    model,
    messages: withWireToolNames(messages),
    system: claudeSystem(body, claudeBillingHeader(messages, version)),
    tools: (tools ?? []).map(withWireName),
    metadata: { user_id: JSON.stringify({ session_id: sessionId }) },
    max_tokens: fits.max_tokens,
    thinking: fits.thinking ?? thinking,
    context_management, compaction, output_config, fallbacks, anthropic_beta, stream, temperature, top_p, top_k,
    stop_sequences, speed,
    tool_choice: tool_choice?.type === 'tool' ? withWireName(tool_choice) : tool_choice,
    ...rest,
  };
}

type WireBody = ReturnType<typeof claudeCodeBody>;

/** A string, so the rate-limit wrapper can replay it. */
function attested(body: WireBody): string {
  const text = JSON.stringify(body);
  const marker = text.indexOf(BILLING_MARKER);
  const placeholder = marker === -1 ? -1 : text.indexOf(CCH_PLACEHOLDER, marker + BILLING_MARKER.length);

  if (placeholder === -1) throw new KinuError('bad_input', 'a Claude Code body carries its billing block first in system');
  const cch = (xxHash64(new TextEncoder().encode(text), CCH_SEED) & 0xfffffn).toString(16).padStart(5, '0');

  return `${text.slice(0, placeholder)}cch=${cch}${text.slice(placeholder + CCH_PLACEHOLDER.length)}`;
}

function claudeSessionId(affinity: string): string {
  const hex = sha256Hex(`kinu-claude-session:${affinity}`, 32);
  const variant = ((Number.parseInt(hex.charAt(16), 16) & 0x3) | 0x8).toString(16);

  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-${variant}${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

function localToolNameInEvent(line: string): string {
  if (!line.startsWith('data:') || !line.includes('"tool_use"')) return line;
  const event = parseJsonObject(line.slice('data:'.length));

  if (!v.is(ToolUseStartSchema, event)) return line;
  const block = event.content_block;

  return `data: ${JSON.stringify({ ...event, content_block: { ...block, name: localToolName(block.name) } })}`;
}

function streamWithLocalToolNames(body: ReadableStream<Uint8Array>): ReadableStream<Uint8Array> {
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  let pending = '';

  return body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      const lines = (pending + decoder.decode(chunk, { stream: true })).split('\n');

      pending = lines.pop() ?? '';

      if (lines.length > 0) controller.enqueue(encoder.encode(`${lines.map(localToolNameInEvent).join('\n')}\n`));
    },
    flush(controller) {
      const rest = pending + decoder.decode();

      if (rest !== '') controller.enqueue(encoder.encode(localToolNameInEvent(rest)));
    },
  }));
}

async function withLocalToolNames(response: Response): Promise<Response> {
  if (!response.ok || response.body === null) return response;
  const init = { status: response.status, statusText: response.statusText, headers: response.headers };

  if ((response.headers.get('content-type') ?? '').includes('text/event-stream')) {
    return new Response(streamWithLocalToolNames(response.body), init);
  }

  const reply = parseJsonObject(await response.text());

  if (!v.is(MessageReplySchema, reply)) throw new KinuError('io', 'api.anthropic.com answered a message without its content blocks');
  const content = reply.content.map((block) => block.type === 'tool_use' && block.name !== undefined ? { ...block, name: localToolName(block.name) } : block);

  return new Response(JSON.stringify({ ...reply, content }), init);
}

function authorizationOf(auth: AuthResolution): string {
  const entry = Object.entries(auth.headers).find(([name]) => name.toLowerCase() === 'authorization');

  if (entry === undefined) throw new KinuError('bad_input', 'a Claude login resolves to an Authorization header');

  return entry[1];
}

function refusedResponse(message: string): Response {
  return new Response(JSON.stringify({ type: 'error', error: { type: 'authentication_error', message } }), {
    status: 401,
    headers: { 'Content-Type': 'application/json' },
  });
}

interface ClaudeCall {
  readonly deps: ProviderDeps;
  readonly modelId: string;
  readonly version: ClaudeCodeVersion;
  readonly sessionId: string;
  readonly headerSessionId: string | undefined;
}

interface SdkRequest {
  readonly body: SdkBody;
  readonly betas: readonly string[];
  readonly signal: AbortSignal | null;
}

async function resolveLogin(deps: ProviderDeps, forceRefresh: boolean): Promise<AuthResolution | 'revoked' | null> {
  try {
    return await deps.getAuth(CLAUDE_CRED_KEY, forceRefresh ? { forceRefresh } : undefined);
  } catch (cause) {
    if (cause instanceof OAuthTokenError && cause.revoked) return 'revoked';
    throw cause;
  }
}

function deadLogin(call: ClaudeCall, reason: string): Response {
  diagnostics.failure('provider.claude_login_refused', new KinuError('denied', reason), { model: call.modelId });

  return refusedResponse(DEAD_LOGIN);
}

const SPENT_WINDOWS = new Map([['five_hour', { header: '5h', measure: '300m' }], ['seven_day', { header: '7d', measure: '10080m' }]]);

const RefusalSchema = v.looseObject({
  error: v.looseObject({
    message: v.optional(v.string()),
    details: v.optional(v.looseObject({ error_code: v.optional(v.string()) })),
  }),
});

function spentWindowText(response: Response, message: string | undefined): string {
  const window = SPENT_WINDOWS.get(response.headers.get('anthropic-ratelimit-unified-representative-claim') ?? '');
  const reset = Number(response.headers.get('anthropic-ratelimit-unified-reset'));

  if (window === undefined || !Number.isFinite(reset) || reset <= 0) return message ?? 'the plan refused the call';
  const used = Number(response.headers.get(`anthropic-ratelimit-unified-${window.header}-utilization`) ?? '1');

  return quotaWindowText({ measure: window.measure, usedPercent: (Number.isFinite(used) ? used : 1) * 100, resetsAt: reset * 1_000 }, Date.now());
}

/** Waiting inside the turn restores neither a spent window nor spent included usage. */
async function usageLimitReached(call: ClaudeCall, response: Response, paid: string): Promise<APICallError | null> {
  if (response.status !== 429) return null;
  const text = await response.clone().text();
  const refusal = v.safeParse(RefusalSchema, tolerate<unknown>(() => parseJsonValue(text), 'malformed-input'));
  const error = refusal.success ? refusal.output.error : undefined;
  const windowRejected = response.headers.get('anthropic-ratelimit-unified-status') === 'rejected';

  if (!windowRejected && error?.details?.error_code !== 'credits_required') return null;
  const account = accountOf(paid);
  const spent = new KinuError('budget', `api.anthropic.com answered HTTP 429: the subscription's usage for ${account} is spent`);

  diagnostics.failure('provider.claude_usage_limit', spent, { model: call.modelId, account });

  return new APICallError({
    message: `Claude usage limit reached on the account ${account}: ${windowRejected ? spentWindowText(response, error?.message) : error?.message ?? 'usage credits are required'}.`,
    url: CLAUDE_MESSAGES_URL,
    requestBodyValues: undefined,
    statusCode: 429,
    isRetryable: false,
    cause: spent,
  });
}

async function sendClaudeCode(call: ClaudeCall, request: SdkRequest, auth: AuthResolution): Promise<Response> {
  const { body } = request;
  const version = call.version.current();
  const betas = claudeCodeBetas(body, request.betas);
  const headers = claudeCodeHeaders({ authorization: authorizationOf(auth), version, betas, sessionId: call.headerSessionId });
  const paid = auth.credentialKey ?? CLAUDE_CRED_KEY;
  const transport = call.deps.fetch ?? fetch;

  const refusingSpentUsage = asFetchFunction(async (input, init) => {
    const response = await transport(input, init);
    const reached = await usageLimitReached(call, response, paid);

    if (reached !== null) throw reached;

    return response;
  });

  const retrying = withRateLimitRetry(refusingSpentUsage, {
    provider: 'claude',
    modelId: call.modelId,
    lane: paid,
    ...(call.deps.onProviderWait !== undefined && { onWait: call.deps.onProviderWait }),
  });

  const sent = await retrying(CLAUDE_MESSAGES_URL, {
    method: 'POST',
    headers,
    body: attested(claudeCodeBody(body, version, call.sessionId)),
    signal: request.signal,
  });

  return withCallAccount(sent, 'claude', paid);
}

async function sendAtAcceptedVersion(call: ClaudeCall, request: SdkRequest, auth: AuthResolution): Promise<Response> {
  const response = await sendClaudeCode(call, request, auth);

  if (response.ok || response.status === 401) return response;

  return call.version.adopt(await response.clone().text()) ? sendClaudeCode(call, request, auth) : response;
}

async function claudeCall(call: ClaudeCall, init: RequestInit): Promise<Response> {
  const login = await resolveLogin(call.deps, false);

  if (login === 'revoked') return deadLogin(call, 'the Claude login\'s refresh token was revoked');

  if (login === null) {
    diagnostics.failure('credential.claude_absent', new KinuError('missing', 'no Claude login; the call was refused before it left'), { model: call.modelId });

    return refusedResponse(NOT_CONNECTED);
  }

  const text = v.safeParse(v.string(), init.body);
  const body = text.success ? parseJsonObject(text.output) : null;

  if (!v.is(SdkBodySchema, body)) throw new KinuError('bad_input', 'the AI SDK sent a body that is not a Messages request');

  const request: SdkRequest = {
    body,
    betas: (copyHeaders(init.headers).get('anthropic-beta') ?? '').split(','),
    signal: init.signal ?? null,
  };

  const first = await sendAtAcceptedVersion(call, request, login);

  if (first.status !== 401) return withLocalToolNames(first);
  const refreshed = await resolveLogin(call.deps, true);

  if (refreshed === 'revoked' || refreshed === null) return deadLogin(call, 'the Claude login was refused and could not be refreshed');
  const second = await sendAtAcceptedVersion(call, request, refreshed);

  return second.status === 401 ? deadLogin(call, 'api.anthropic.com refused the refreshed Claude login') : withLocalToolNames(second);
}

export function createClaudeProvider(): ModelProvider {
  const version = createClaudeCodeVersion();

  return {
    id: 'claude',
    credentialKey: CLAUDE_CRED_KEY,
    label: 'Claude (Pro/Max subscription)',
    defaultModel: ANTHROPIC_DEFAULT_MODEL,
    fastModel: ANTHROPIC_FAST_MODEL,
    async isAvailable(deps) { return deps.hasCredential(CLAUDE_CRED_KEY); },
    unavailableReason() { return NOT_CONNECTED; },
    listModels: (deps) => listAnthropicModels(deps),
    createModel(modelId, deps): LanguageModel {
      const affinity = deps.sessionAffinity;
      const headerSessionId = affinity === undefined ? undefined : claudeSessionId(affinity);
      const call: ClaudeCall = { deps, modelId, version, sessionId: headerSessionId ?? crypto.randomUUID(), headerSessionId };
      const provider = createAnthropic({ apiKey: 'oauth-placeholder', fetch: asFetchFunction((_input, init) => claudeCall(call, init ?? {})) });

      return provider.languageModel(modelId);
    },
  };
}

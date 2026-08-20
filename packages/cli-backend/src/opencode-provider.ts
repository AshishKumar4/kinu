// OpenCode bridge provider (LOCAL ONLY) — lets Proteus local agents reuse the
// model providers and auth tokens configured in a locally-installed opencode
// CLI. No separate proxy daemon is needed: this provider reads opencode's
// auth.json at request time, resolves the remote config for upstream provider
// routes, and proxies chat-completion requests directly.
//
// Requires: `opencode` binary on PATH and at least one authenticated provider
// (run `opencode auth login <origin>`). The provider auto-detects the opencode
// instance URL from auth.json, so it works with any opencode deployment — not
// just a specific hosted instance.
//
// This lives in cli-backend (the local backend). The cloud server has no
// access to the local opencode installation, so nothing here is reachable from
// cf-backend.

import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import { createOpenAI } from '@ai-sdk/openai';
import {
  asFetchFunction, JsonObjectSchema, withRateLimitRetry,
  type JsonObject, type JsonValue,
} from '@kinu/core';
import type { LanguageModel } from 'ai';
import type { ModelProvider, ModelInfo } from '@kinu/core';
import { diagnostics, ProteusError, renderThrownChain } from '@kinu/core/obs';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { spawn as nodeSpawn } from 'node:child_process';
import * as v from 'valibot';

export const OPENCODE_PROVIDER_ID = 'opencode';
export const OPENCODE_LABEL = 'OpenCode (shared auth)';

const DEFAULT_AUTH_PATH = join(homedir(), '.local', 'share', 'opencode', 'auth.json');
const DEFAULT_OPENCODE_BIN = 'opencode';
const CONFIG_TTL_MS = 60_000;

const INSTALL_HINT = 'Install opencode: https://opencode.ai';
const LOGIN_HINT = 'Run `opencode auth login` to authenticate, then run `proteus setup` again.';

const openCodeAuthSchema = v.record(v.string(), v.object({
  type: v.string(),
  token: v.optional(v.string()),
  key: v.optional(v.string()),
}));
const metadataSchema = v.object({
  remote_config: v.optional(v.object({
    url: v.optional(v.string()),
    headers: v.optional(v.record(v.string(), v.string())),
  })),
});
const remoteConfigSchema = v.object({
  model: v.optional(v.string()),
  provider: v.optional(v.record(v.string(), v.object({
    options: v.optional(v.object({
      baseURL: v.optional(v.string()),
      headers: v.optional(v.record(v.string(), v.string())),
    })),
  }))),
});
const modelMetadataSchema = v.object({
  name: v.optional(v.string()),
  limit: v.optional(v.object({ context: v.optional(v.number()) })),
  capabilities: v.optional(v.object({
    output: v.optional(v.object({ text: v.optional(v.boolean()) })),
    toolcall: v.optional(v.boolean()),
    reasoning: v.optional(v.boolean()),
  })),
  api: v.optional(v.object({ id: v.optional(v.string()), npm: v.optional(v.string()) })),
});

export interface OpenCodeProviderOptions {
  /** Path to opencode's auth.json. Defaults to ~/.local/share/opencode/auth.json. */
  authPath?: string;
  /** opencode binary name or path. Defaults to 'opencode' on PATH. */
  opencodeBin?: string;
  /** Fetch implementation (tests inject). */
  fetch?: typeof fetch;
  /** Spawn seam (tests inject a fake opencode). */
  spawn?: OpenCodeSpawn;
  /** Availability probe (tests inject). */
  probe?: () => Promise<OpenCodeAvailability>;
}

export interface OpenCodeAvailability {
  binary: boolean;
  authenticated: boolean;
  /** Discovered models (empty when not authenticated). */
  models?: OpenCodeModelInfo[];
  /** Default model from the remote config. */
  defaultModel?: string;
}

/** Minimal spawn contract for running `opencode models --verbose`. */
export interface OpenCodeSpawn {
  (args: string[], opts: { signal?: AbortSignal }): SpawnedOpenCode;
}

export interface SpawnedOpenCode {
  stdout: AsyncIterable<Uint8Array | string>;
  stderr: AsyncIterable<Uint8Array | string>;
  stdin: { end(): void } | null;
  kill(signal?: NodeJS.Signals): void;
  exit: Promise<number | null>;
}

export interface OpenCodeModelInfo {
  /** Full model id as opencode reports it, e.g. "openai/gpt-5.6-sol". */
  id: string;
  /** Provider prefix, e.g. "openai" or "cloudflare-workers-ai". */
  provider: string;
  /** Upstream model id to send to the provider's endpoint. */
  upstreamModel: string;
  /** Human-readable label. */
  name: string;
  /** Context window in tokens, if known. */
  contextWindow?: number;
  /** Whether opencode identifies the model as a reasoning model. */
  reasoning?: boolean;
  /** AI SDK package opencode uses for the model's API surface. */
  apiNpm?: string;
}

interface OpenCodeCredential {
  origin: string;
  key: string;
  token: string;
}

interface ProviderRoute {
  baseURL: string;
  headers: Record<string, string>;
}

interface ResolvedConfig {
  defaultModel: string;
  providers: Record<string, ProviderRoute>;
  models: OpenCodeModelInfo[];
}

function spawnOpenCode(binary: string, args: string[], opts: { signal?: AbortSignal }): SpawnedOpenCode {
  const child = nodeSpawn(binary, args, {
    stdio: ['pipe', 'pipe', 'pipe'],
    signal: opts.signal,
  });
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
}

const defaultSpawn: OpenCodeSpawn = (args, opts) => spawnOpenCode(DEFAULT_OPENCODE_BIN, args, opts);

export function createOpenCodeProvider(opts: OpenCodeProviderOptions = {}): ModelProvider {
  const authPath = opts.authPath ?? DEFAULT_AUTH_PATH;
  const opencodeBin = opts.opencodeBin ?? DEFAULT_OPENCODE_BIN;
  const fetchImpl = opts.fetch ?? fetch;
  const spawnFn = opts.spawn ?? ((args, spawnOptions) => spawnOpenCode(opencodeBin, args, spawnOptions));
  const probeFn = opts.probe ?? (() => probeOpenCode(authPath, spawnFn));

  let availabilityCache: Promise<OpenCodeAvailability> | null = null;
  let configCache: { signature: string; loadedAt: number; config: ResolvedConfig } | null = null;
  let modelMetadata = new Map<string, OpenCodeModelInfo>();

  const availability = () => (availabilityCache ??= probeFn());

  function readCredential(): OpenCodeCredential {
    // OAuth entries need a separate provider-native path: select the requested
    // provider's credential, refresh or exchange it, resolve its API base URL,
    // and use that provider's SDK and required headers (including account IDs).
    // They cannot supply the hosted route map consumed by this well-known path.
    if (!existsSync(authPath)) {
      throw new Error(`opencode auth not found at ${authPath}. Run: opencode auth login`);
    }
    const doc = v.parse(openCodeAuthSchema, JSON.parse(readFileSync(authPath, 'utf8')));
    const entries = Object.entries(doc);
    if (entries.length === 0) {
      throw new Error('opencode auth.json is empty. Run: opencode auth login');
    }
    const entry = entries[0];
    if (!entry) throw new Error('opencode auth.json is empty. Run: opencode auth login');
    const [origin, cred] = entry;
    if (cred.type !== 'wellknown' || !cred.token) {
      throw new Error(`opencode is not authenticated with ${origin}. Run: opencode auth login ${origin}`);
    }
    return {
      origin: origin.replace(/\/+$/, ''),
      key: cred.key ?? 'TOKEN',
      token: cred.token,
    };
  }

  function substitute(value: string, cred: OpenCodeCredential): string {
    return value.replaceAll(`{env:${cred.key}}`, cred.token);
  }

  async function loadConfig(force = false): Promise<ResolvedConfig> {
    const cred = readCredential();
    const signature = `${cred.origin}:${cred.token}`;
    if (!force && configCache && configCache.signature === signature && Date.now() - configCache.loadedAt < CONFIG_TTL_MS) {
      return configCache.config;
    }

    // 1. Fetch well-known metadata to discover the remote config URL.
    const metaRes = await fetchImpl(`${cred.origin}/.well-known/opencode`);
    if (!metaRes.ok) throw new Error(`opencode metadata request failed: HTTP ${metaRes.status}`);
    const meta = v.parse(metadataSchema, await metaRes.json());
    const configURL = meta.remote_config?.url;
    if (!configURL) {
      throw new Error('opencode metadata has no remote configuration URL');
    }

    // 2. Fetch the remote config, substituting auth tokens in header values.
    const configHeaders = new Headers();
    for (const [name, value] of Object.entries(meta.remote_config?.headers ?? {})) {
      configHeaders.set(name, substitute(value, cred));
    }
    const configRes = await fetchImpl(configURL, { headers: configHeaders });
    if (!configRes.ok) throw new Error(`opencode configuration request failed: HTTP ${configRes.status}`);
    const config = v.parse(remoteConfigSchema, await configRes.json());

    // 3. Resolve provider routes (baseURL + auth headers).
    const providers: Record<string, ProviderRoute> = {};
    for (const [providerId, provider] of Object.entries(config.provider ?? {})) {
      if (!provider.options?.baseURL) continue;
      const headers: Record<string, string> = {};
      for (const [name, value] of Object.entries(provider.options?.headers ?? {})) {
        headers[name] = substitute(value, cred);
      }
      providers[providerId] = {
        baseURL: provider.options.baseURL.replace(/\/+$/, ''),
        headers,
      };
    }

    // 4. Discover models via `opencode models --verbose`.
    const models = await discoverModels(spawnFn);
    if (models.length === 0) throw new Error('opencode reports no available models');
    modelMetadata = new Map(models.map((model) => [model.id, model]));

    const configuredDefault = config.model ?? '';
    const firstModel = models[0];
    if (!firstModel) throw new Error('opencode reports no available models');
    const defaultModel = models.some((model) => model.id === configuredDefault)
      ? configuredDefault
      : firstModel.id;

    configCache = { signature, loadedAt: Date.now(), config: { defaultModel, providers, models } };
    return configCache.config;
  }

  function invalidateCache() {
    configCache = null;
  }

  return {
    id: OPENCODE_PROVIDER_ID,
    label: OPENCODE_LABEL,
    async isAvailable() {
      const a = await availability();
      return a.binary && a.authenticated;
    },
    async unavailableReason() {
      const a = await availability();
      if (!a.binary) return INSTALL_HINT;
      if (!a.authenticated) return LOGIN_HINT;
      return undefined;
    },
    async listModels(): Promise<ModelInfo[]> {
      const config = await loadConfig();
      return config.models.map((model) => {
        const info: ModelInfo = { id: model.id, label: model.name };
        if (model.contextWindow) info.contextWindow = model.contextWindow;
        return info;
      });
    },
    get defaultModel() {
      return undefined; // resolved lazily via loadConfig in setup
    },
    createModel(modelId: string): LanguageModel {
      const metadata = modelMetadata.get(modelId);
      // The metadata map is cold until loadConfig() runs (a resumed session
      // resolves its stored model before ever listing models), and defaulting
      // an unknown reasoning model to Chat Completions breaks it outright
      // (gpt-5.6: "use /v1/responses"). Metadata is authoritative when present;
      // otherwise fall back to the model family. The map warms itself on the
      // model's FIRST REQUEST — customFetch resolves the config on the way out,
      // where a failure reaches the caller instead of disappearing into a
      // detached warm-up nobody awaited.
      const useResponsesAPI = metadata
        ? metadata.reasoning === true || metadata.apiNpm === '@ai-sdk/openai'
        : isOpenAIReasoningFamily(modelId);
      return createOpenCodeModel(modelId, () => loadConfig(), invalidateCache, fetchImpl, useResponsesAPI);
    },
  };
}

// ─── Model construction ─────────────────────────────────────────────────────

function createOpenCodeModel(
  modelId: string,
  resolveConfig: () => Promise<ResolvedConfig>,
  invalidateCache: () => void,
  fetchImpl: typeof fetch,
  useResponsesAPI: boolean,
): LanguageModel {
  // The modelId is the opencode model id, e.g. "openai/gpt-5.6-sol".
  // We split on the first slash to get the provider prefix and the
  // upstream model id.
  const slash = modelId.indexOf('/');
  if (slash < 0) throw new Error(`Invalid opencode model id: ${modelId}`);
  const providerId = modelId.slice(0, slash);
  const upstreamModel = modelId.slice(slash + 1);

  const placeholder = 'https://opencode.invalid';
  const modelFetch = withRateLimitRetry(fetchImpl);

  const customFetch = asFetchFunction(async (input: RequestInfo | URL, init?: RequestInit) => {
    const config = await resolveConfig();
    const route = config.providers[providerId];
    if (!route) {
      return new Response(
        JSON.stringify({ error: `Provider "${providerId}" is not available in your opencode configuration.` }),
        { status: 503, headers: { 'Content-Type': 'application/json' } },
      );
    }

    // Rewrite the URL from placeholder to the upstream baseURL.
    const stringInput = v.safeParse(v.string(), input);
    const originalUrl = stringInput.success
      ? stringInput.output
      : input instanceof Request ? input.url : input.toString();
    const url = originalUrl.replace(placeholder, route.baseURL);

    // Inject provider auth headers.
    const headers = new Headers(init?.headers);
    for (const [name, value] of Object.entries(route.headers)) {
      headers.set(name, value);
    }
    headers.set('content-type', 'application/json');

    // Remap the model id in the request body.
    let body = init?.body;
    const textBody = v.safeParse(v.string(), body);
    if (textBody.success) {
      // The body is the ai-SDK's own request json. Failing to read it means the
      // model id was never remapped, so the request would reach the provider
      // naming a model it does not have — a 404 three layers from the cause.
      const parsed = v.parse(JsonObjectSchema, JSON.parse(textBody.output));
      parsed.model = upstreamModel;
      if (useResponsesAPI) rewriteOpenCodeResponsesBody(parsed);
      // OpenAI Chat Completions uses max_completion_tokens instead of max_tokens.
      const maxTokens = v.safeParse(v.number(), parsed.max_tokens);
      if (!useResponsesAPI && providerId === 'openai' && maxTokens.success) {
        parsed.max_completion_tokens = maxTokens.output;
        delete parsed.max_tokens;
      }
      body = JSON.stringify(parsed);
    }

    const response = await modelFetch(url, { ...init, headers, body, signal: init?.signal });

    // Invalidate cache on auth failure so the next request re-reads auth.json
    // and re-fetches the remote config (the user may have refreshed tokens).
    if (response.status === 401 || response.status === 403) {
      invalidateCache();
    }

    // Strip encoding headers that may not match after proxying.
    const responseHeaders = new Headers(response.headers);
    responseHeaders.delete('content-encoding');
    responseHeaders.delete('content-length');
    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers: responseHeaders,
    });
  });

  if (useResponsesAPI) {
    return createOpenAI({
      name: OPENCODE_PROVIDER_ID,
      baseURL: placeholder,
      apiKey: 'placeholder',
      fetch: customFetch,
    }).responses(modelId);
  }

  return createOpenAICompatible({
    name: OPENCODE_PROVIDER_ID,
    baseURL: placeholder,
    fetch: customFetch,
  }).chatModel(modelId);
}

/** Cold-map fallback only (metadata wins when loaded): OpenAI's gpt-5.x and
 *  o-series are Responses-API reasoning models; chat-completions rejects them. */
export function isOpenAIReasoningFamily(modelId: string): boolean {
  const upstream = modelId.slice(modelId.indexOf('/') + 1);
  return /^(gpt-[5-9]|o[0-9])/.test(upstream);
}

/** Server-assigned Responses item ids: reasoning, message, function/tool call. */
const SERVER_ITEM_ID = /^(rs_|msg_|fc_|item_)/;

export function rewriteOpenCodeResponsesBody(body: JsonObject): void {
  // The SDK forwards providerOptions.openai.store/include per call, but a
  // ModelProvider does not own turn call options, so enforce ZDR here.
  body.store = false;
  const parsedInclude = v.safeParse(v.array(v.string()), body.include);
  const include = parsedInclude.success ? parsedInclude.output : [];
  body.include = [...new Set([...include, 'reasoning.encrypted_content'])];

  if (!Array.isArray(body.input)) return;
  const input: JsonValue[] = [];
  for (const item of body.input) {
    const parsedItem = v.safeParse(JsonObjectSchema, item);
    if (!parsedItem.success) {
      input.push(item);
      continue;
    }
    const object = parsedItem.output;
    if (
      object.type === 'item_reference'
      && v.safeParse(v.pipe(v.string(), v.regex(SERVER_ITEM_ID)), object.id).success
    ) {
      continue;
    }
    // With store:false the server persists nothing, so ANY server-assigned id
    // in the replayed input (reasoning rs_, assistant message msg_, tool call
    // fc_) 404s on lookup. Pass every item by value: strip the id, keep the
    // payload (encrypted_content, call_id, content) intact.
    const serverId = v.safeParse(v.pipe(v.string(), v.regex(SERVER_ITEM_ID)), object.id);
    if (serverId.success) {
      const byValue: JsonObject = { ...object };
      delete byValue.id;
      input.push(byValue);
      continue;
    }
    input.push(object);
  }
  body.input = input;
}

// ─── Model discovery ─────────────────────────────────────────────────────────

/** Run `opencode models --verbose` and parse the output into model info. */
async function discoverModels(spawnFn: OpenCodeSpawn): Promise<OpenCodeModelInfo[]> {
  const child = spawnFn(['models', '--verbose'], {});
  child.stdin?.end();

  // Drained concurrently with the exit: the verbose listing is far larger than a
  // pipe buffer, so awaiting the exit first would deadlock.
  const [read, exitCode] = await Promise.all([readAllOutcome(child.stdout), child.exit]);
  if (exitCode !== 0) {
    const stderrRead = await readAllOutcome(child.stderr);
    const detail = 'text' in stderrRead
      ? stderrRead.text.trim()
      : `stderr unreadable: ${stderrRead.error instanceof Error ? stderrRead.error.message : String(stderrRead.error)}`;
    throw new Error(`Could not read opencode models: ${detail || `exit ${exitCode}`}`);
  }
  if ('error' in read) {
    throw new Error(
      '`opencode models --verbose` exited 0 but its output could not be read',
      { cause: read.error },
    );
  }
  const stdout = read.text;

  const models: OpenCodeModelInfo[] = [];
  // Entries this cannot read, reported with their denominator below.
  const unreadable: string[] = [];
  // The verbose output alternates: "provider/model-id\n{...json...}" per model.
  const header = /^([^\s/]+\/[^\s]+)\n\{/gm;
  let match: RegExpExecArray | null;
  while ((match = header.exec(stdout)) !== null) {
    const id = match[1];
    const provider = id.slice(0, id.indexOf('/'));
    const start = header.lastIndex - 1;
    const end = jsonObjectEnd(stdout, start);
    if (end < 0) continue;
    try {
      const metadata = v.parse(modelMetadataSchema, JSON.parse(stdout.slice(start, end)));
      // Skip models that can't do text output or tool calls.
      if (metadata?.capabilities?.output?.text === false) continue;
      if (metadata?.capabilities?.toolcall === false) continue;

      const context = metadata?.limit?.context;
      // Use api.id when available; otherwise strip the provider prefix.
      const upstreamModel = metadata.api?.id
        ? metadata.api.id
        : id.slice(provider.length + 1);

      models.push({
        id,
        provider,
        upstreamModel,
        name: metadata.name || id,
        contextWindow: context && context > 0 ? Math.floor(context) : undefined,
        reasoning: metadata.capabilities?.reasoning,
        apiNpm: metadata.api?.npm || undefined,
      });
    } catch (error) {
      unreadable.push(`${id}: ${renderThrownChain({ cause: error })}`);
    }
    header.lastIndex = end;
  }
  // An unreadable entry is opencode's output format having changed, and the
  // symptom — a short or empty model list — reads exactly like a small account.
  if (unreadable.length > 0) {
    diagnostics.failure(
      'model.catalog_entries_unreadable',
      new ProteusError(
        'bad_input',
        `opencode models --verbose: entries could not be read — ${unreadable.join('; ')}`,
      ),
      { unreadable: unreadable.length, readable: models.length },
    );
  }
  return models;
}

/** Find the end of a JSON object starting at `start` (which must be '{'). */
function jsonObjectEnd(text: string, start: number): number {
  let depth = 0;
  let quoted = false;
  let escaped = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') quoted = false;
      continue;
    }
    if (ch === '"') quoted = true;
    else if (ch === '{') depth++;
    else if (ch === '}' && --depth === 0) return i + 1;
  }
  return -1;
}

async function readAll(stream: SpawnedOpenCode['stdout']): Promise<string> {
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
 *  the child's exit code says whether a dead stream is already explained, and
 *  that decision cannot be made inside a catch. */
async function readAllOutcome(
  stream: SpawnedOpenCode['stdout'],
): Promise<{ text: string } | { error: unknown }> {
  try {
    return { text: await readAll(stream) };
  } catch (error) {
    return { error };
  }
}

// ─── Availability probe ──────────────────────────────────────────────────────

export async function probeOpenCode(
  authPath: string,
  spawnFn: OpenCodeSpawn,
): Promise<OpenCodeAvailability> {
  // Check if opencode binary exists. The output is unused — the read is what
  // lets the child exit — but a read that fails while `--version` itself
  // SUCCEEDED is not the missing binary the exit code accounts for.
  const versionChild = spawnFn(['--version'], {});
  versionChild.stdin?.end();
  const [versionRead, versionExit] = await Promise.all([
    readAllOutcome(versionChild.stdout),
    versionChild.exit,
  ]);
  if (versionExit !== 0) return { binary: false, authenticated: false };
  if ('error' in versionRead) {
    throw new Error(
      '`opencode --version` exited 0 but its output could not be read',
      { cause: versionRead.error },
    );
  }

  // Check if auth.json exists and has a valid token.
  if (!existsSync(authPath)) return { binary: true, authenticated: false };
  try {
    const doc = v.parse(openCodeAuthSchema, JSON.parse(readFileSync(authPath, 'utf8')));
    const entries = Object.entries(doc);
    if (entries.length === 0) return { binary: true, authenticated: false };
    const entry = entries[0];
    if (!entry) return { binary: true, authenticated: false };
    const [, cred] = entry;
    if (cred.type !== 'wellknown' || !cred.token) {
      return { binary: true, authenticated: false };
    }
  } catch {
    return { binary: true, authenticated: false };
  }

  return { binary: true, authenticated: true };
}


/** Convenience: probe with the real opencode binary + default auth path.
 *  Mirrors `checkClaudeAvailability` — no args, uses PATH + default config. */
export async function checkOpenCodeAvailability(): Promise<OpenCodeAvailability> {
  return probeOpenCode(DEFAULT_AUTH_PATH, defaultSpawn);
}

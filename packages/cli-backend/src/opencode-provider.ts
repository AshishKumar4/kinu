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
import { asFetchFunction } from '@proteus/core';
import type { LanguageModel } from 'ai';
import type { ModelProvider, ModelInfo } from '@proteus/core';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { spawn as nodeSpawn } from 'node:child_process';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';

export const OPENCODE_PROVIDER_ID = 'opencode';
export const OPENCODE_LABEL = 'OpenCode (shared auth)';

const DEFAULT_AUTH_PATH = join(homedir(), '.local', 'share', 'opencode', 'auth.json');
const DEFAULT_OPENCODE_BIN = 'opencode';
const CONFIG_TTL_MS = 60_000;

const INSTALL_HINT = 'Install opencode: https://opencode.ai';
const LOGIN_HINT = 'Run `opencode auth login` to authenticate, then run `proteus setup` again.';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

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
  stdout: AsyncIterable<Uint8Array> | NodeJS.ReadableStream;
  stderr: AsyncIterable<Uint8Array> | NodeJS.ReadableStream;
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

const defaultSpawn: OpenCodeSpawn = (args, opts) => {
  const child = nodeSpawn('opencode', args, {
    stdio: ['pipe', 'pipe', 'pipe'],
    signal: opts.signal,
  }) as ChildProcessWithoutNullStreams;
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

export function createOpenCodeProvider(opts: OpenCodeProviderOptions = {}): ModelProvider {
  const authPath = opts.authPath ?? DEFAULT_AUTH_PATH;
  const opencodeBin = opts.opencodeBin ?? DEFAULT_OPENCODE_BIN;
  const fetchImpl = opts.fetch ?? fetch;
  const spawnFn = opts.spawn ?? defaultSpawn;
  const probeFn = opts.probe ?? (() => probeOpenCode(authPath, spawnFn, fetchImpl));

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
    const doc = JSON.parse(readFileSync(authPath, 'utf8')) as Record<string, unknown>;
    const entries = Object.entries(doc);
    if (entries.length === 0) {
      throw new Error('opencode auth.json is empty. Run: opencode auth login');
    }
    const [origin, cred] = entries[0] as [string, Record<string, unknown>];
    if (cred?.type !== 'wellknown' || typeof cred.token !== 'string' || !cred.token) {
      throw new Error(`opencode is not authenticated with ${origin}. Run: opencode auth login ${origin}`);
    }
    return {
      origin: origin.replace(/\/+$/, ''),
      key: typeof cred.key === 'string' ? cred.key : 'TOKEN',
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
    const meta = await metaRes.json() as {
      remote_config?: { url?: string; headers?: Record<string, string> };
    };
    const configURL = meta?.remote_config?.url;
    if (typeof configURL !== 'string' || !configURL) {
      throw new Error('opencode metadata has no remote configuration URL');
    }

    // 2. Fetch the remote config, substituting auth tokens in header values.
    const configHeaders = new Headers();
    for (const [name, value] of Object.entries(meta.remote_config?.headers ?? {})) {
      if (typeof value === 'string') configHeaders.set(name, substitute(value, cred));
    }
    const configRes = await fetchImpl(configURL, { headers: configHeaders });
    if (!configRes.ok) throw new Error(`opencode configuration request failed: HTTP ${configRes.status}`);
    const config = await configRes.json() as {
      model?: string;
      provider?: Record<string, {
        options?: {
          baseURL?: string;
          headers?: Record<string, string>;
        };
      }>;
    };

    // 3. Resolve provider routes (baseURL + auth headers).
    const providers: Record<string, ProviderRoute> = {};
    for (const [providerId, provider] of Object.entries(config?.provider ?? {})) {
      if (typeof provider?.options?.baseURL !== 'string') continue;
      const headers: Record<string, string> = {};
      for (const [name, value] of Object.entries(provider.options?.headers ?? {})) {
        if (typeof value === 'string') headers[name] = substitute(value, cred);
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

    const configuredDefault = typeof config.model === 'string' ? config.model : '';
    const defaultModel = models.some((m) => m.id === configuredDefault) ? configuredDefault : models[0].id;

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
      return config.models.map((m) => ({
        id: m.id,
        label: m.name,
        ...(m.contextWindow ? { contextWindow: m.contextWindow } : {}),
      }));
    },
    get defaultModel() {
      return undefined; // resolved lazily via loadConfig in setup
    },
    createModel(modelId: string): LanguageModel {
      const metadata = modelMetadata.get(modelId);
      const useResponsesAPI = metadata?.reasoning === true || metadata?.apiNpm === '@ai-sdk/openai';
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
    const originalUrl = typeof input === 'string' ? input
      : input instanceof URL ? input.toString()
      : (input as Request).url;
    const url = originalUrl.replace(placeholder, route.baseURL);

    // Inject provider auth headers.
    const headers = new Headers(init?.headers);
    for (const [name, value] of Object.entries(route.headers)) {
      headers.set(name, value);
    }
    headers.set('content-type', 'application/json');

    // Remap the model id in the request body.
    let body = init?.body;
    if (typeof body === 'string') {
      try {
        const parsed: unknown = JSON.parse(body);
        if (isRecord(parsed)) {
          parsed.model = upstreamModel;
          if (useResponsesAPI) rewriteOpenCodeResponsesBody(parsed);
          // OpenAI Chat Completions uses max_completion_tokens instead of max_tokens.
          if (!useResponsesAPI && providerId === 'openai' && typeof parsed.max_tokens === 'number') {
            parsed.max_completion_tokens = parsed.max_tokens;
            delete parsed.max_tokens;
          }
          body = JSON.stringify(parsed);
        }
      } catch {
        // Body is not JSON — leave as-is.
      }
    }

    const response = await fetchImpl(url, { ...init, headers, body, signal: init?.signal });

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

export function rewriteOpenCodeResponsesBody(body: Record<string, unknown>): void {
  // The SDK forwards providerOptions.openai.store/include per call, but a
  // ModelProvider does not own turn call options, so enforce ZDR here.
  body.store = false;
  const include = Array.isArray(body.include) ? body.include : [];
  body.include = [...new Set([...include, 'reasoning.encrypted_content'])];

  if (!Array.isArray(body.input)) return;
  const input: unknown[] = [];
  for (const item of body.input) {
    if (!isRecord(item)) {
      input.push(item);
      continue;
    }
    if (
      item.type === 'item_reference'
      && typeof item.id === 'string'
      && (item.id.startsWith('rs_') || item.id.startsWith('msg_'))
    ) {
      continue;
    }
    if (item.type === 'reasoning' && item.encrypted_content == null) {
      const { id: _id, ...reasoning } = item;
      input.push(reasoning);
      continue;
    }
    input.push(item);
  }
  body.input = input;
}

// ─── Model discovery ─────────────────────────────────────────────────────────

/** Run `opencode models --verbose` and parse the output into model info. */
async function discoverModels(spawnFn: OpenCodeSpawn): Promise<OpenCodeModelInfo[]> {
  const child = spawnFn(['models', '--verbose'], {});
  child.stdin?.end();

  const stdout = await readAll(child.stdout).catch(() => '');
  const exitCode = await child.exit;
  if (exitCode !== 0) {
    const stderr = await readAll(child.stderr).catch(() => '');
    throw new Error(`Could not read opencode models: ${stderr.trim() || `exit ${exitCode}`}`);
  }

  const models: OpenCodeModelInfo[] = [];
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
      const metadata = JSON.parse(stdout.slice(start, end)) as {
        name?: string;
        limit?: { context?: number };
        capabilities?: { output?: { text?: boolean }; toolcall?: boolean; reasoning?: boolean };
        api?: { id?: string; npm?: string };
      };
      // Skip models that can't do text output or tool calls.
      if (metadata?.capabilities?.output?.text === false) continue;
      if (metadata?.capabilities?.toolcall === false) continue;

      const context = metadata?.limit?.context;
      // Use api.id when available; otherwise strip the provider prefix.
      const upstreamModel = typeof metadata?.api?.id === 'string' && metadata.api.id
        ? metadata.api.id
        : id.slice(provider.length + 1);

      models.push({
        id,
        provider,
        upstreamModel,
        name: typeof metadata?.name === 'string' && metadata.name ? metadata.name : id,
        contextWindow: typeof context === 'number' && context > 0 ? Math.floor(context) : undefined,
        reasoning: typeof metadata?.capabilities?.reasoning === 'boolean'
          ? metadata.capabilities.reasoning
          : undefined,
        apiNpm: typeof metadata?.api?.npm === 'string' && metadata.api.npm
          ? metadata.api.npm
          : undefined,
      });
    } catch {
      // Skip malformed JSON entries.
    }
    header.lastIndex = end;
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
  for await (const chunk of stream as AsyncIterable<Uint8Array | string>) {
    out += typeof chunk === 'string' ? chunk : decoder.decode(chunk, { stream: true });
  }
  out += decoder.decode();
  return out;
}

// ─── Availability probe ──────────────────────────────────────────────────────

export async function probeOpenCode(
  authPath: string,
  spawnFn: OpenCodeSpawn,
  fetchImpl: typeof fetch,
): Promise<OpenCodeAvailability> {
  // Check if opencode binary exists.
  const versionChild = spawnFn(['--version'], {});
  versionChild.stdin?.end();
  const versionStdout = await readAll(versionChild.stdout).catch(() => '');
  const versionExit = await versionChild.exit;
  if (versionExit !== 0) return { binary: false, authenticated: false };

  // Check if auth.json exists and has a valid token.
  if (!existsSync(authPath)) return { binary: true, authenticated: false };
  try {
    const doc = JSON.parse(readFileSync(authPath, 'utf8')) as Record<string, unknown>;
    const entries = Object.entries(doc);
    if (entries.length === 0) return { binary: true, authenticated: false };
    const [, cred] = entries[0] as [string, Record<string, unknown>];
    if (cred?.type !== 'wellknown' || typeof cred.token !== 'string' || !cred.token) {
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
  return probeOpenCode(DEFAULT_AUTH_PATH, defaultSpawn, fetch);
}

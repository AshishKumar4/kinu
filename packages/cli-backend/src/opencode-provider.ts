// OpenCode bridge provider (local only): reuses a local opencode install's
// providers and auth, reading auth.json at request time and proxying requests.

import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import { createOpenAI } from '@ai-sdk/openai';
import {
  asFetchFunction, JsonObjectSchema, statelessResponses, withRateLimitRetry,
} from '@kinu.run/core';
import { wrapLanguageModel, type LanguageModel } from 'ai';
import type { ModelProvider, ModelInfo } from '@kinu.run/core';
import { diagnostics, KinuError, renderThrownChain } from '@kinu.run/core/obs';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { spawn as nodeSpawn } from 'node:child_process';
import * as v from 'valibot';
import { readAllOutcome } from '@kinu.run/core';

export const OPENCODE_PROVIDER_ID = 'opencode';

const OPENCODE_LABEL = 'OpenCode (shared auth)';

const DEFAULT_AUTH_PATH = join(homedir(), '.local', 'share', 'opencode', 'auth.json');

const DEFAULT_OPENCODE_BIN = 'opencode';

const CONFIG_TTL_MS = 60_000;

const INSTALL_HINT = 'Install opencode: https://opencode.ai';

const LOGIN_HINT = 'Run `opencode auth login` to authenticate, then run `kinu setup` again.';

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
  /** Defaults to ~/.local/share/opencode/auth.json. */
  authPath?: string;
  opencodeBin?: string;
  fetch?: typeof fetch;
  spawn?: OpenCodeSpawn;
  probe?: () => Promise<OpenCodeAvailability>;
}

export interface OpenCodeAvailability {
  binary: boolean;
  authenticated: boolean;
  models?: OpenCodeModelInfo[];
  defaultModel?: string;
}

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
  provider: string;
  /** Upstream model id to send to the provider's endpoint. */
  upstreamModel: string;
  name: string;
  contextWindow?: number;
  reasoning?: boolean;
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
    // OAuth entries need a provider-native path; they cannot supply the hosted
    // route map this well-known path consumes.
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

    const metaRes = await fetchImpl(`${cred.origin}/.well-known/opencode`);

    if (!metaRes.ok) throw new Error(`opencode metadata request failed: HTTP ${metaRes.status}`);
    const meta = v.parse(metadataSchema, await metaRes.json());
    const configURL = meta.remote_config?.url;

    if (!configURL) {
      throw new Error('opencode metadata has no remote configuration URL');
    }

    // Substitute auth tokens in header values.
    const configHeaders = new Headers();

    for (const [name, value] of Object.entries(meta.remote_config?.headers ?? {})) {
      configHeaders.set(name, substitute(value, cred));
    }

    const configRes = await fetchImpl(configURL, { headers: configHeaders });

    if (!configRes.ok) throw new Error(`opencode configuration request failed: HTTP ${configRes.status}`);
    const config = v.parse(remoteConfigSchema, await configRes.json());

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

      // The metadata map is cold until loadConfig() runs (a resumed session), and
      // defaulting a reasoning model to Chat Completions breaks it; fall back to family.
      const reasoning = metadata ? metadata.reasoning === true : isOpenAIReasoningFamily(modelId);
      const useResponsesAPI = reasoning || metadata?.apiNpm === '@ai-sdk/openai';

      return createOpenCodeModel({ modelId, resolveConfig: () => loadConfig(), invalidateCache, fetchImpl, useResponsesAPI, reasoning });
    },
  };
}


interface OpenCodeModelSpec {
  modelId: string;
  resolveConfig: () => Promise<ResolvedConfig>;
  invalidateCache: () => void;
  fetchImpl: typeof fetch;
  useResponsesAPI: boolean;
  reasoning: boolean;
}

function createOpenCodeModel(spec: OpenCodeModelSpec): LanguageModel {
  const { modelId, resolveConfig, invalidateCache, fetchImpl, useResponsesAPI, reasoning } = spec;
  const slash = modelId.indexOf('/');

  if (slash < 0) throw new Error(`Invalid opencode model id: ${modelId}`);
  const providerId = modelId.slice(0, slash);
  const upstreamModel = modelId.slice(slash + 1);

  const placeholder = 'https://opencode.invalid';
  // Own lane per route: opencode.ai serves Zen and Go, and a spent Go window must not cool Zen.
  const modelFetch = withRateLimitRetry(fetchImpl, { provider: providerId, modelId: upstreamModel, lane: providerId });

  const customFetch = asFetchFunction(async (input: RequestInfo | URL, init?: RequestInit) => {
    const config = await resolveConfig();
    const route = config.providers[providerId];

    if (!route) {
      return new Response(
        JSON.stringify({ error: `Provider "${providerId}" is not available in your opencode configuration.` }),
        { status: 503, headers: { 'Content-Type': 'application/json' } },
      );
    }

    const originalUrl = input instanceof Request ? input.url : input.toString();
    const url = originalUrl.replace(placeholder, route.baseURL);

    const headers = new Headers(init?.headers);

    for (const [name, value] of Object.entries(route.headers)) {
      headers.set(name, value);
    }

    headers.set('content-type', 'application/json');

    let body = init?.body;
    const textBody = v.safeParse(v.string(), body);

    if (textBody.success) {
      // An unparsed body leaves the model id unmapped: a 404 far from the cause.
      const parsed = v.parse(JsonObjectSchema, JSON.parse(textBody.output));
      parsed.model = upstreamModel;

      // OpenAI Chat Completions uses max_completion_tokens instead of max_tokens.
      const maxTokens = v.safeParse(v.number(), parsed.max_tokens);

      if (!useResponsesAPI && providerId === 'openai' && maxTokens.success) {
        parsed.max_completion_tokens = maxTokens.output;
        delete parsed.max_tokens;
      }

      body = JSON.stringify(parsed);
    }

    const response = await modelFetch(url, { ...init, headers, body, signal: init?.signal });

    // Drop cache on auth failure so the next request re-reads auth.json.
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
    return wrapLanguageModel({
      model: createOpenAI({ name: OPENCODE_PROVIDER_ID, baseURL: placeholder, apiKey: 'placeholder', fetch: customFetch }).responses(modelId),
      middleware: statelessResponses(reasoning),
    });
  }

  return createOpenAICompatible({
    name: OPENCODE_PROVIDER_ID,
    baseURL: placeholder,
    fetch: customFetch,
  }).chatModel(modelId);
}

/** Cold-map fallback only: OpenAI's gpt-5.x and o-series are Responses-API
 *  reasoning models; chat-completions rejects them. */
function isOpenAIReasoningFamily(modelId: string): boolean {
  const upstream = modelId.slice(modelId.indexOf('/') + 1);

  return /^(gpt-[5-9]|o[0-9])/.test(upstream);
}

async function discoverModels(spawnFn: OpenCodeSpawn): Promise<OpenCodeModelInfo[]> {
  const child = spawnFn(['models', '--verbose'], {});
  child.stdin?.end();

  // The verbose listing exceeds a pipe buffer; awaiting exit first would deadlock.
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

      if (metadata?.capabilities?.output?.text === false) continue;

      if (metadata?.capabilities?.toolcall === false) continue;

      const context = metadata?.limit?.context;

      // Empty strings mean opencode declared the field but left it unset.
      const apiId = metadata.api?.id;
      const apiNpm = metadata.api?.npm;
      const name = metadata.name;

      models.push({
        id,
        provider,
        upstreamModel: apiId === undefined || apiId === '' ? id.slice(provider.length + 1) : apiId,
        name: name === undefined || name === '' ? id : name,
        contextWindow: context && context > 0 ? Math.floor(context) : undefined,
        reasoning: metadata.capabilities?.reasoning,
        apiNpm: apiNpm === '' ? undefined : apiNpm,
      });
    } catch (error) {
      unreadable.push(`${id}: ${renderThrownChain({ cause: error })}`);
    }

    header.lastIndex = end;
  }

  // Unreadable entries mean the output format changed; a short list would look like a small account.
  if (unreadable.length > 0) {
    diagnostics.failure(
      'model.catalog_entries_unreadable',
      new KinuError(
        'bad_input',
        `opencode models --verbose: entries could not be read: ${unreadable.join('; ')}`,
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



async function probeOpenCode(
  authPath: string,
  spawnFn: OpenCodeSpawn,
): Promise<OpenCodeAvailability> {
  // A failed read after a successful `--version` is not a missing binary.
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
  } catch (error) {
    diagnostics.event('opencode.cred_unreadable', { error: renderThrownChain({ cause: error }) });

    return { binary: true, authenticated: false };
  }

  return { binary: true, authenticated: true };
}


/** Probe with the real opencode binary and default auth path. */
export async function checkOpenCodeAvailability(): Promise<OpenCodeAvailability> {
  return probeOpenCode(DEFAULT_AUTH_PATH, defaultSpawn);
}

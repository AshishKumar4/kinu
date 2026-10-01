// One registry and spec spelling for both backends.
import { Effect } from 'effect';
import { KinuError, settleSync } from '../obs/index';
import { createAnthropicProvider } from './anthropic';
import { createModelsDevCatalogSource } from './catalog';
import { createClaudeProvider } from './claude';
import { createOpenAIProvider } from './openai';
import { createOpenAICompatProvider } from './openai-compat';
import { createOpenRouterProvider } from './openrouter';
import { accountDeps, createProviderRegistry, type ProviderRegistry } from './registry';
import { catalogModelInfo } from './util';
import { parseModelSpec, specProvider, type ModelInfo, type ModelProvider, type ProviderDeps } from './types';
import { DEFAULT_WORKERS_AI_MODEL_SPEC, WORKERS_AI_MODEL_ID_PREFIX, workersAiSpec } from './workers-ai';

export interface BackendTransports {
  readonly workersAi: ModelProvider;
  readonly myGateway: ModelProvider;
  readonly aiGateway?: ModelProvider;
  readonly chatgpt?: ModelProvider;
  /** cf only. */
  readonly codex: ModelProvider | undefined;
  /** CLI only. */
  readonly opencode: ModelProvider | undefined;
  readonly compat?: readonly ModelProvider[];
  readonly appTitle?: string;
}

/** Registration order is picker and judge preference. */
export function createModelRegistry(transports: BackendTransports): ProviderRegistry {
  const registry = createProviderRegistry();

  for (const provider of [
    transports.workersAi, transports.myGateway, transports.aiGateway, transports.chatgpt, transports.codex,
    createClaudeProvider(), transports.opencode, createOpenAIProvider(), createAnthropicProvider(),
    createOpenRouterProvider({ appTitle: transports.appTitle }), createOpenAICompatProvider(), ...transports.compat ?? [],
  ]) {
    if (provider !== undefined) registry.register(provider);
  }

  // workers-ai's catalog id.
  registry.registerDynamic(createModelsDevCatalogSource({ exclude: ['cloudflare-workers-ai'] }));

  return registry;
}

/** What an empty name means, null when nothing; `missing` refuses then. */
export interface SpecDefault {
  readonly spec: string | null;
  readonly missing: string;
}

/** A bare id joins the default's provider; a head no provider claims is refused, not read as a model id. */
export function normalizeModelSpec(named: string | null | undefined, registry: ProviderRegistry, fallback: SpecDefault): string {
  const spec = (named ?? '').trim();

  if (spec.startsWith(WORKERS_AI_MODEL_ID_PREFIX)) return workersAiSpec(spec);
  const head = specProvider(spec);

  if (head !== null) {
    return settleSync(registry.canResolve(head)
      ? Effect.succeed(spec)
      : Effect.fail(new KinuError('bad_input', `Unknown provider in model spec ${JSON.stringify(spec)}.`)));
  }

  const provider = fallback.spec === null ? null : specProvider(fallback.spec);

  return settleSync(fallback.spec === null || provider === null
    ? Effect.fail(new KinuError('missing', fallback.missing))
    : Effect.succeed(spec === '' ? fallback.spec : `${provider}/${spec}`));
}

/** A spec's catalog entry, under the account it names or the deps choose; null when unknown. */
export function specModelInfo(registry: ProviderRegistry, deps: ProviderDeps, spec: string): Promise<ModelInfo | null> {
  const { provider, modelId, account } = parseModelSpec(spec);

  return catalogModelInfo(registry.get(provider), accountDeps(deps, provider, account), modelId);
}

/** A servable explicit choice, else Workers AI's default; never the first menu entry, a paid BYO provider. */
export function defaultSpecFor(
  configured: string | null | undefined,
  availableSpecs: readonly string[],
): string | null {
  if (configured && availableSpecs.includes(configured)) return configured;

  return availableSpecs.includes(DEFAULT_WORKERS_AI_MODEL_SPEC)
    ? DEFAULT_WORKERS_AI_MODEL_SPEC
    : null;
}

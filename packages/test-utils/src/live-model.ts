/**
 * Resolves where live suites' model calls go: (1) worker proxy, `KINU_ORIGIN` + `KINU_TOKEN` at
 * `/api/user/ai/v1`, origin checked against the eval-identity allowlist; (2) AI Gateway, `AI_GATEWAY_BASE_URL` +
 * `AI_GATEWAY_AUTH` (or `KINU_BASE_URL`/`KINU_AUTH`). No baked-in default; a half-set environment is `misconfigured`, not a skip.
 */
import {
  addUsage, cloudProxyBaseURL, createChatModel, DEFAULT_WORKERS_AI_MODEL_ID, normalizeUsage,
  RunEventRecorder, USER_AI_PROXY_PATH, usageReported, workspaceSpend, WORKSPACE_RUN_ID,
  type ActorHandle, type LLMProviderConfig, type ModelCallSink, type SqlExecutor, type Usage,
  type WorkspaceSpend,
} from '@kinu.run/core';
import type { LanguageModel, LanguageModelUsage } from 'ai';
import { appendFileSync } from 'node:fs';
import { ambientByName, LIVE_MODEL_ENV } from './ambient-env';
import { EVAL_DEPLOYMENT_ORIGIN, evalTargetVerdict } from './eval-identity';

/** Which of the two resolution paths produced a target. */
export type LiveModelPath = 'worker-proxy' | 'ai-gateway';

export interface LiveModelTarget {
  readonly llm: LLMProviderConfig;
  readonly via: LiveModelPath;
  /** Target and cost basis, printed by every live suite. */
  readonly describe: string;
}

export type LiveModelResolution =
  | { readonly kind: 'ready'; readonly target: LiveModelTarget }
  /** No live-model credentials at all — the legitimate skip. */
  | { readonly kind: 'absent'; readonly reason: string }
  /** Partially configured: never a skip. */
  | { readonly kind: 'misconfigured'; readonly reason: string };

type EnvSource = Record<string, string | undefined>;

function first(env: EnvSource, names: readonly string[]): string | undefined {
  for (const name of names) {
    const value = env[name]?.trim();

    if (value) return value;
  }

  return undefined;
}

/** Bearer-prefix a token unless already prefixed (`KINU_AUTH` has it, `KINU_TOKEN` does not). */
function bearer(token: string): string {
  return token.startsWith('Bearer ') ? token : `Bearer ${token}`;
}

/** Pure over its environment so the resolver is testable without credentials. */
export function resolveLiveModel(env: EnvSource = ambientByName(Object.values(LIVE_MODEL_ENV).flat())): LiveModelResolution {
  const origin = env[LIVE_MODEL_ENV.origin]?.trim();
  const token = env[LIVE_MODEL_ENV.token]?.trim();
  const gatewayURL = first(env, LIVE_MODEL_ENV.gatewayURL);
  const gatewayAuth = first(env, LIVE_MODEL_ENV.gatewayAuth);
  const model = first(env, LIVE_MODEL_ENV.model) ?? DEFAULT_WORKERS_AI_MODEL_ID;

  if (token && !origin) {
    return {
      kind: 'misconfigured',
      reason: `${LIVE_MODEL_ENV.token} is set but ${LIVE_MODEL_ENV.origin} is not. `
        + `A CLI bearer names no target: set the deployment origin (${EVAL_DEPLOYMENT_ORIGIN}).`,
    };
  }

  // Check the origin first: this pair reaches the deployment's whole API (e.g. `/api/cli/workspaces`), not just a model.
  if (origin) {
    const verdict = evalTargetVerdict(origin);

    if (verdict.kind === 'refused') {
      return { kind: 'misconfigured', reason: verdict.reason };
    }
  }

  if (origin && token) {
    return {
      kind: 'ready',
      target: {
        via: 'worker-proxy',
        llm: {
          name: 'workers-ai',
          baseURL: cloudProxyBaseURL(origin),
          headers: { Authorization: bearer(token) },
          model,
        },
        describe: `worker-proxy ${origin} · model ${model} · billed as native Workers AI `
          + "on the token owner's Cloudflare account",
      },
    };
  }

  if (gatewayAuth && !gatewayURL) {
    return {
      kind: 'misconfigured',
      reason: `${LIVE_MODEL_ENV.gatewayAuth[0]} is set but none of `
        + `${LIVE_MODEL_ENV.gatewayURL.join('/')} is. There is no default gateway URL: `
        + 'it embeds an account id and a gateway name, and guessing one sends the '
        + "suite's traffic to somebody else's account.",
    };
  }

  if (gatewayURL && !gatewayAuth) {
    return {
      kind: 'misconfigured',
      reason: `${LIVE_MODEL_ENV.gatewayURL[0]} is set but none of `
        + `${LIVE_MODEL_ENV.gatewayAuth.join('/')} is. An AI Gateway with an empty `
        + 'cf-aig-authorization header answers 401 on every call.',
    };
  }

  if (gatewayURL && gatewayAuth) {
    return {
      kind: 'ready',
      target: {
        via: 'ai-gateway',
        llm: {
          name: 'workers-ai',
          baseURL: gatewayURL,
          headers: { 'cf-aig-authorization': bearer(gatewayAuth) },
          model,
        },
        describe: `ai-gateway ${gatewayURL} · model ${model} · billed per the gateway's `
          + 'upstream provider',
      },
    };
  }

  return {
    kind: 'absent',
    reason: `no live-model target. Set ${LIVE_MODEL_ENV.origin} + ${LIVE_MODEL_ENV.token} `
      + `for the deployed worker proxy (cheapest — native Workers AI), or `
      + `${LIVE_MODEL_ENV.gatewayURL[0]} + ${LIVE_MODEL_ENV.gatewayAuth[0]} for an AI Gateway.`,
  };
}

/** A worker-proxy target decomposed into the pair reaching the deployment API. */
export interface LiveModelSession {
  readonly origin: string;
  readonly token: string;
}

/** Origin and bearer recovered from the resolved target, never re-read from env; throws for AI-gateway targets. */
export function workerSession(llm: LLMProviderConfig): LiveModelSession {
  const origin = llm.baseURL.endsWith(USER_AI_PROXY_PATH)
    ? llm.baseURL.slice(0, -USER_AI_PROXY_PATH.length)
    : llm.baseURL;

  if (origin === llm.baseURL) {
    throw new Error(`${llm.baseURL} is not a worker AI-proxy base URL, so no worker origin can be `
      + 'recovered from it. This target fronts a model and no Kinu deployment, so there is no '
      + 'workspace API to reach.');
  }

  const header = llm.headers['Authorization'];

  if (!header) throw new Error('the resolved worker target carries no Authorization header');

  return { origin, token: header.replace(/^Bearer /, '') };
}

/** The live target for `suite`, or null; throws when half-configured. Prints the target or the env vars that would enable it. */
export function liveModelTarget(suite: string): LiveModelTarget | null {
  // Ambient credentials are not consent to spend: a live run needs `KINU_EVAL_LIVE`, set only by the tier scripts.
  if (process.env['KINU_EVAL_LIVE'] !== '1') {
    console.warn(`[skip] ${suite} — live suites are opt-in: run 'bun run test:live' (KINU_EVAL_LIVE=1)`);

    return null;
  }

  const resolved = resolveLiveModel();

  if (resolved.kind === 'misconfigured') {
    throw new Error(`${suite}: live-model environment refuses this run — ${resolved.reason}`);
  }

  if (resolved.kind === 'absent') {
    console.warn(`[skip] ${suite} — ${resolved.reason}`);

    return null;
  }

  console.warn(`[live] ${suite} — ${resolved.target.describe}`);

  return resolved.target;
}

/** Marker on failures caused by the environment rather than the agent; read by `scripts/skip-ratchet.ts`. */
export const INFRA_FAILURE_MARKER = 'INFRA FAILURE';

/** Run a deployment-dependent step and label its failure as infrastructure, preserving the cause. */
export async function infraBoundary<T>(boundary: string, op: () => Promise<T>): Promise<T> {
  try {
    return await op();
  } catch (err) {
    throw new Error(
      `${INFRA_FAILURE_MARKER} — ${boundary} did not answer: ${String(err)}. `
      + "The environment failed here, so nothing about the agent's behaviour was measured; "
      + 'check the deployment before reading this as a regression.',
      { cause: err },
    );
  }
}

/** Placeholder config for skipped suites (`beforeAll` still runs); the `.invalid` host fails at DNS. */
export const UNCONFIGURED_LLM: LLMProviderConfig = {
  name: 'workers-ai',
  baseURL: 'https://live-model-unconfigured.invalid/v1',
  headers: {},
  model: DEFAULT_WORKERS_AI_MODEL_ID,
};

/** The AI SDK model for a config, via core's `createChatModel` (inherits `withRateLimitRetry`). */
export function liveChatModel(llm: LLMProviderConfig): LanguageModel {
  return createChatModel({
    kind: 'openai-compat',
    name: llm.name,
    baseURL: llm.baseURL,
    headers: llm.headers,
    modelId: llm.model,
  });
}

/**
 * Measured live-run spend. Three feeds, one meter: per call (`recordLiveModelSpend`), per episode from the
 * store (`recordLiveModelEpisode`), adopted from a prior process (`recordAdoptedLiveModelSpend`). Each process
 * appends its total to `KINU_EVAL_SPEND_FILE`. Unreported usage adds nothing to token totals, so they are a floor.
 */
export interface LiveModelSpend {
  readonly calls: number;
  /** Calls the provider returned no usage for. */
  readonly callsWithoutUsage: number;
  /** Accumulated with `addUsage`, so a field no call reported stays absent. */
  readonly usage: Usage;
  /** Driven episodes whose store accounted for no model call, so `calls: 0` is not mistaken for measured. */
  readonly episodesUnmeasured: number;
  /** Episodes declared model-free whose store agreed. */
  readonly episodesWithoutModel: number;
}

/** The env var naming the file a suite process appends its total to. */
export const LIVE_MODEL_SPEND_FILE_ENV = 'KINU_EVAL_SPEND_FILE';

// Plain bindings so `usage` keeps its `Usage` type; `liveModelSpend()` assembles the shape.
let spendCalls = 0;

let spendCallsWithoutUsage = 0;

let spendUsage: Usage = {};

let spendEpisodesUnmeasured = 0;

let spendEpisodesWithoutModel = 0;

/** Record one model call. Pass the AI SDK's `result.usage`. */
export function recordLiveModelSpend(usage?: LanguageModelUsage): void {
  spendCalls += 1;
  const reported = normalizeUsage(usage);

  if (!usageReported(reported)) {
    spendCallsWithoutUsage += 1;

    return;
  }

  spendUsage = addUsage(spendUsage, reported);
}

/** A `ModelCallSink` for driven strategies, writing the production row under {@link WORKSPACE_RUN_ID}, unpriced. */
export function liveModelCallSink(sql: SqlExecutor, actor: ActorHandle): ModelCallSink {
  const events = new RunEventRecorder(sql, actor);

  return (report) => {
    events.emit(WORKSPACE_RUN_ID, {
      type: 'model_call', source: report.source, usage: report.usage,
    });
  };
}

/** Record one driven episode's spend via `workspaceSpend`; turn `step_finish` rows sit outside `ModelCallSink`, so a sink would miss them. */
export function recordLiveModelEpisode(sql: SqlExecutor, actor: ActorHandle): void {
  recordWorkspaceSpend(workspaceSpend({ events: new RunEventRecorder(sql, actor), sql, actor }));
}

/** Record an episode from a `WorkspaceSpend` read elsewhere (cloud: `getActivitySnapshot().spend`); a store with no calls counts as unmeasured. */
export function recordWorkspaceSpend(spend: WorkspaceSpend): void {
  if (spend.total.calls === 0) {
    spendEpisodesUnmeasured += 1;

    return;
  }

  spendCalls += spend.total.calls;
  spendCallsWithoutUsage += spend.total.callsWithoutUsage;
  spendUsage = addUsage(spendUsage, spend.total.usage);
}

/** A driven episode whose spend endpoint failed is missing accounting, not free. */
export function recordUnmeasuredEpisode(): void {
  spendEpisodesUnmeasured += 1;
}

/** Record an episode declared model-free; throws if the store accounted for a call. */
export function recordNoModelEpisode(spend: WorkspaceSpend): void {
  if (spend.total.calls !== 0) {
    throw new Error(`this case declared it drives no model and its store accounted for `
      + `${String(spend.total.calls)} model call(s)`);
  }

  spendEpisodesWithoutModel += 1;
}

/** What a durable case record says a previous process spent; read back, not recomputed. */
export interface AdoptedCaseSpend {
  readonly calls: number;
  readonly usage: Usage;
}

/** Whether a durable record could account for the case it belongs to. */
export type AdoptedSpendVerdict = 'accounted' | 'unaccounted';

/** Record spend a resumed run adopted; records lacking calls or usage count as unmeasured. Once-per-case is `AdoptedSpendMeter`'s job. */
export function recordAdoptedLiveModelSpend(adopted: AdoptedCaseSpend): AdoptedSpendVerdict {
  if (adopted.calls <= 0 || !usageReported(adopted.usage)) {
    spendEpisodesUnmeasured += 1;

    return 'unaccounted';
  }

  spendCalls += adopted.calls;
  spendUsage = addUsage(spendUsage, adopted.usage);

  return 'accounted';
}

export function liveModelSpend(): LiveModelSpend {
  return {
    calls: spendCalls,
    callsWithoutUsage: spendCallsWithoutUsage,
    usage: spendUsage,
    episodesUnmeasured: spendEpisodesUnmeasured,
    episodesWithoutModel: spendEpisodesWithoutModel,
  };
}

/** Reset without publishing; scripted suites call it in teardown since `bun test ./tests/` shares the meter across files. */
export function resetLiveModelSpend(): void {
  spendCalls = 0;
  spendCallsWithoutUsage = 0;
  spendUsage = {};
  spendEpisodesUnmeasured = 0;
  spendEpisodesWithoutModel = 0;
}

/** Print and append this suite's spend, then drain, so `scripts/eval-spend.ts` sums per-suite lines without double counting. */
export function reportLiveModelSpend(suite: string): LiveModelSpend {
  const total = liveModelSpend();
  console.warn(
    `[spend] ${suite} — ${total.calls} model call(s), `
    + `${total.usage.input ?? 'unreported'} in / ${total.usage.output ?? 'unreported'} out tokens`
    + (total.callsWithoutUsage > 0 ? `, ${total.callsWithoutUsage} without reported usage` : '')
    + (total.episodesUnmeasured > 0
      ? `, ${total.episodesUnmeasured} episode(s) UNMEASURED — this suite drove work whose `
        + 'spend it could not account for, so the totals above are not this suite\'s cost'
      : '')
    + (total.episodesWithoutModel > 0
      ? `, ${total.episodesWithoutModel} episode(s) declared no model, and the store agreed`
      : ''),
  );
  const path = process.env[LIVE_MODEL_SPEND_FILE_ENV]?.trim();

  if (path) appendFileSync(path, `${JSON.stringify({ suite, ...total })}\n`);
  resetLiveModelSpend();

  return total;
}

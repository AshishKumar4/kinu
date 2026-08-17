/**
 * Where a live suite's model calls actually go — resolved once, in one place.
 *
 * The four root end-to-end suites each hand-rolled their own `LLM_CONFIG`
 * block: same four env vars, same hardcoded AI Gateway URL carrying one
 * account id, same model literal, four copies. All four then gated on
 * `PROTEUS_AUTH`/`AI_GATEWAY_AUTH` alone, and an AI Gateway token is the one
 * credential the owner does NOT need — the default model is native Workers AI
 * DeepSeek on his own account. So the suites that prove multi-turn tool
 * calling, memory across a reopen, MCTS evolution and cross-session transfer
 * skipped at every commit for want of a credential that was never required.
 *
 * Two ways to reach a real model, in preference order:
 *
 *   1. WORKER PROXY — `PROTEUS_ORIGIN` + `PROTEUS_TOKEN`. A deployed or preview
 *      Proteus worker fronts the owner's Cloudflare credential at
 *      `/api/user/ai/v1` (cf-backend/src/user/ai-proxy.ts), so the test needs a
 *      CLI bearer and no Cloudflare token at all. `proteus tokens create
 *      --scope ai.proxy` mints one. This is the cheap path: native Workers AI.
 *   2. AI GATEWAY — `AI_GATEWAY_BASE_URL` + `AI_GATEWAY_AUTH`. The pre-existing
 *      path, kept because it reaches models the account proxy does not front.
 *
 * `PROTEUS_BASE_URL`/`PROTEUS_AUTH` remain accepted for (2) because that is the
 * pair `.env.example` tells a developer to set for the CLI, and the CLI and
 * these suites share one endpoint.
 *
 * There is no baked-in default for either target. A test harness that silently
 * falls back to a hardcoded account's gateway cannot state which target it
 * measured, and this repo is public.
 *
 * The third outcome is the one that matters: a HALF-set environment is a
 * configuration bug, not a skip. `PROTEUS_TOKEN` with no origin, or an auth
 * token with no base URL, used to resolve to an empty header and a silent skip
 * — a green suite that proved nothing, over a machine whose operator believed
 * it was configured. That returns `misconfigured` and the suites throw.
 */
import {
  createChatModel, DEFAULT_WORKERS_AI_MODEL_ID, type LLMProviderConfig,
} from '@proteus/core';
import type { LanguageModel } from 'ai';
import { appendFileSync } from 'node:fs';

/** Which of the two resolution paths produced a target. */
export type LiveModelPath = 'worker-proxy' | 'ai-gateway';

export interface LiveModelTarget {
  readonly llm: LLMProviderConfig;
  readonly via: LiveModelPath;
  /** The target and its cost basis, for the line every live suite prints. A run
   *  whose output does not say where it went and what it spent is not evidence. */
  readonly describe: string;
}

export type LiveModelResolution =
  | { readonly kind: 'ready'; readonly target: LiveModelTarget }
  /** No live-model credentials at all — the legitimate skip. */
  | { readonly kind: 'absent'; readonly reason: string }
  /** Partially configured. Never a skip: someone meant this to run. */
  | { readonly kind: 'misconfigured'; readonly reason: string };

/** The env vars this resolver reads, so the failure messages and the docs can
 *  name them without a second copy. */
export const LIVE_MODEL_ENV = {
  origin: 'PROTEUS_ORIGIN',
  token: 'PROTEUS_TOKEN',
  gatewayURL: ['AI_GATEWAY_BASE_URL', 'PROTEUS_BASE_URL'],
  gatewayAuth: ['AI_GATEWAY_AUTH', 'PROTEUS_AUTH'],
  model: ['AI_GATEWAY_MODEL', 'PROTEUS_MODEL'],
} as const;

type EnvSource = Record<string, string | undefined>;

function first(env: EnvSource, names: readonly string[]): string | undefined {
  for (const name of names) {
    const value = env[name]?.trim();
    if (value) return value;
  }
  return undefined;
}

/** Bearer-prefix a token unless it already is one — `PROTEUS_AUTH` is
 *  documented with the prefix, `PROTEUS_TOKEN` without it. */
function bearer(token: string): string {
  return token.startsWith('Bearer ') ? token : `Bearer ${token}`;
}

/**
 * Pure over its environment so the resolver itself is testable without any
 * credential — the gate that proves the gate works.
 */
export function resolveLiveModel(env: EnvSource = process.env): LiveModelResolution {
  const origin = env[LIVE_MODEL_ENV.origin]?.trim();
  const token = env[LIVE_MODEL_ENV.token]?.trim();
  const gatewayURL = first(env, LIVE_MODEL_ENV.gatewayURL);
  const gatewayAuth = first(env, LIVE_MODEL_ENV.gatewayAuth);
  const model = first(env, LIVE_MODEL_ENV.model) ?? DEFAULT_WORKERS_AI_MODEL_ID;

  if (token && !origin) {
    return {
      kind: 'misconfigured',
      reason: `${LIVE_MODEL_ENV.token} is set but ${LIVE_MODEL_ENV.origin} is not. `
        + 'A CLI bearer names no target: set the deployed or preview worker origin '
        + '(e.g. https://proteus-staging.<subdomain>.workers.dev).',
    };
  }
  if (origin && token) {
    return {
      kind: 'ready',
      target: {
        via: 'worker-proxy',
        llm: {
          name: 'workers-ai',
          baseURL: userAIProxyBaseURL(origin),
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

/** The worker's signed-in OpenAI-compatible inference proxy. Mirrors
 *  `USER_AI_PROXY_PREFIX` in cf-backend/src/user/ai-proxy.ts. */
function userAIProxyBaseURL(origin: string): string {
  return `${origin.replace(/\/+$/, '')}/api/user/ai/v1`;
}

/**
 * The live target for `suite`, or null when the environment legitimately has
 * none. Throws on a half-configured environment.
 *
 * Prints one line either way: which target and cost basis a run used, or which
 * env vars would make it run. A skip that says nothing is the false green this
 * whole module exists to remove.
 */
export function liveModelTarget(suite: string): LiveModelTarget | null {
  const resolved = resolveLiveModel();
  if (resolved.kind === 'misconfigured') {
    throw new Error(`${suite}: live-model environment is half-configured — ${resolved.reason}`);
  }
  if (resolved.kind === 'absent') {
    console.warn(`[skip] ${suite} — ${resolved.reason}`);
    return null;
  }
  console.warn(`[live] ${suite} — ${resolved.target.describe}`);
  return resolved.target;
}

/**
 * The workspace config a suite builds when there is no live target.
 *
 * `bun test` still runs `beforeAll` for a describe whose every test is skipped,
 * and creating a workspace needs an llm config. An unreachable `.invalid` host
 * is the honest placeholder: if a skipped suite ever does reach the network,
 * the DNS failure names this constant instead of quietly hitting a real
 * endpoint with an empty auth header, which is what the four hand-rolled
 * configs did.
 */
export const UNCONFIGURED_LLM: LLMProviderConfig = {
  name: 'workers-ai',
  baseURL: 'https://live-model-unconfigured.invalid/v1',
  headers: {},
  model: DEFAULT_WORKERS_AI_MODEL_ID,
};

/**
 * The AI SDK model for a suite's resolved config.
 *
 * Takes the config rather than the target so a skipped suite can still build a
 * model from {@link UNCONFIGURED_LLM} without a cast: nothing calls it, and if
 * anything ever does it fails at DNS naming that constant.
 *
 * Goes through core's `createChatModel`, so a live suite inherits
 * `withRateLimitRetry`. The four hand-rolled providers did not, which made a
 * mid-run 429 read as a behavioural failure.
 */
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
 * What a live run actually spent — measured, not estimated.
 *
 * "State the cost per run" cannot be answered by a constant: it depends on how
 * many steps the model chose to take, and these suites let it take up to 500.
 * So every `generateText` call in a live suite feeds its usage here, each suite
 * process appends its own total to `PROTEUS_EVAL_SPEND_FILE`, and the eval tier
 * sums the files into the one number a run reports.
 *
 * A call whose usage the provider did not report still increments `calls`. The
 * gap between `calls` and the token totals is then visible, rather than a token
 * count that silently under-reports.
 */
export interface LiveModelSpend {
  readonly calls: number;
  /** Calls the provider returned no usage for. */
  readonly callsWithoutUsage: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
}

/** The env var naming the file a suite process appends its total to. */
export const LIVE_MODEL_SPEND_FILE_ENV = 'PROTEUS_EVAL_SPEND_FILE';

const spend = { calls: 0, callsWithoutUsage: 0, inputTokens: 0, outputTokens: 0 };

/** Record one model call. Pass the AI SDK's `result.usage`. */
export function recordLiveModelSpend(
  usage?: { inputTokens?: number | undefined; outputTokens?: number | undefined },
): void {
  spend.calls += 1;
  const input = usage?.inputTokens;
  const output = usage?.outputTokens;
  if (input === undefined && output === undefined) {
    spend.callsWithoutUsage += 1;
    return;
  }
  spend.inputTokens += input ?? 0;
  spend.outputTokens += output ?? 0;
}

export function liveModelSpend(): LiveModelSpend {
  return { ...spend };
}

/** One line stating this process's spend, and the same appended to the
 *  aggregate file when the eval tier asked for one. Called from a suite's
 *  teardown so a run that made no calls says exactly that. */
export function reportLiveModelSpend(suite: string): LiveModelSpend {
  const total = liveModelSpend();
  console.warn(
    `[spend] ${suite} — ${total.calls} model call(s), `
    + `${total.inputTokens} in / ${total.outputTokens} out tokens`
    + (total.callsWithoutUsage > 0 ? `, ${total.callsWithoutUsage} without reported usage` : ''),
  );
  const path = process.env[LIVE_MODEL_SPEND_FILE_ENV]?.trim();
  if (path) appendFileSync(path, `${JSON.stringify({ suite, ...total })}\n`);
  return total;
}

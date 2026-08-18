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
  addUsage, cloudProxyBaseURL, createChatModel, DEFAULT_WORKERS_AI_MODEL_ID, normalizeUsage,
  RunEventRecorder, usageReported, workspaceSpend,
  type LLMProviderConfig, type SqlExecutor, type Usage,
} from '@proteus/core';
import type { LanguageModel, LanguageModelUsage } from 'ai';
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

/** A live target the eval tier may borrow when the environment names none. */
export interface LiveModelSession {
  readonly origin: string;
  readonly token: string;
}

/**
 * The signed-in CLI session, promoted to a live target — but ONLY when the
 * environment names none.
 *
 * WHY THIS EXISTS. `resolveLiveModel` reads the environment and nothing else,
 * and nothing ever populated it. So on the one machine that holds a credential —
 * the owner's, signed in with `proteus auth` — `bun run test:eval` printed
 * `target: none`, all six live suites skipped, the ratchet proved the skips were
 * declared, and the tier reported `TOTAL: 0 model call(s)`. A deploy gate
 * (`scripts/deploy.sh`: "Behavioural evals") that has never once called a model
 * is a gate in name only, and `calls: 0` could not distinguish "spent nothing"
 * from "was never wired".
 *
 * WHY IT NEVER OVERRIDES. An explicit `PROTEUS_TOKEN`, or either gateway auth
 * variable, is somebody choosing a target — often a specific gateway model the
 * account proxy does not front. Worker-proxy resolution is tried FIRST in
 * `resolveLiveModel`, so injecting a stored session over a deliberate
 * `AI_GATEWAY_*` pair would silently bill and measure the wrong endpoint. This
 * fills a blank; it never argues.
 *
 * Pure over both inputs, and it takes the session as data rather than importing
 * the CLI's config reader: test-utils sits below the CLI, and the caller that
 * can read a config file is `scripts/eval-credentials.ts`.
 */
export function liveModelFallback(
  session: LiveModelSession | null,
  env: EnvSource = process.env,
): LiveModelSession | null {
  if (!session) return null;
  if (env[LIVE_MODEL_ENV.token]?.trim()) return null;
  if (first(env, LIVE_MODEL_ENV.gatewayAuth)) return null;
  return session;
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
  // Ambient credentials are NOT consent to spend. These suites are named
  // `*.eval.test.ts`, so a root `bun test` collects them, so the COMMIT tier
  // collects them — and on a machine that happens to export PROTEUS_BASE_URL /
  // PROTEUS_AUTH they fired real paid model calls from a git hook (measured:
  // 101s and 81s for two tests) and then failed on a remote model's choices. A
  // developer's exported credential is a fact about their shell, never a
  // request to bill the owner's account during a commit.
  //
  // So a live run requires the eval tier to be DRIVING it. `PROTEUS_EVAL_LIVE`
  // is set by scripts/eval-tier.sh and by nothing else; absent it, the suite
  // skips exactly as it does with no credential at all — and the skip-ratchet
  // gate still requires that skip to be declared, so the suite cannot go quiet.
  if (process.env['PROTEUS_EVAL_LIVE'] !== '1') {
    console.warn(`[skip] ${suite} — live evals are opt-in: run 'bun run test:eval' (PROTEUS_EVAL_LIVE=1)`);
    return null;
  }
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
 * So every live suite feeds this meter, each suite process appends its own total
 * to `PROTEUS_EVAL_SPEND_FILE`, and the eval tier sums the files into the one
 * number a run reports.
 *
 * TWO FEEDS, ONE METER, because there are two kinds of live suite and only two.
 * A suite that calls `generateText` itself holds the SDK result and reports per
 * call (`recordLiveModelSpend`). A suite that drives a `LocalAgentSession` never
 * sees a result, so it reports per episode off the store the session wrote
 * (`recordLiveModelEpisode`). Both write the same counters — a second meter for
 * the second kind is how one tier learns to report a number the other cannot.
 *
 * A ZERO IS NEVER SILENT. `calls: 0` used to mean both "nothing ran" and
 * "nothing was measured", and the behavioural tier printed the second while
 * spending ~584,751 neurons. `episodesUnmeasured` is the difference: a suite that
 * drove work registers it whether or not the spend could be accounted for, so
 * only a suite that genuinely ran nothing reports a clean zero.
 *
 * A call whose usage the provider did not report still increments `calls` and
 * `callsWithoutUsage`, and contributes NOTHING to the token total. That gap is
 * the honest form of the sentence: the totals are a floor over the calls that
 * were actually reported, and `callsWithoutUsage` says how many were not. A
 * partial report is the same rule one field at a time — a provider that returns
 * output tokens and no input tokens adds output only, because the alternative
 * (`+= input ?? 0`) reports an input total that reads as measured.
 */
export interface LiveModelSpend {
  readonly calls: number;
  /** Calls the provider returned no usage for. */
  readonly callsWithoutUsage: number;
  /** Accumulated with `addUsage`, so a field no call reported stays absent. */
  readonly usage: Usage;
  /**
   * Episodes this suite drove whose store accounted for NO model call at all.
   *
   * The difference between "this tier cost nothing" and "this tier was not
   * measured", which `calls: 0` alone cannot express and which cost the owner a
   * behavioural tier reporting `0 model call(s)` over ~584,751 real neurons. A
   * suite that drives episodes registers each one here, so a zero it did not
   * earn arrives labelled instead of clean.
   */
  readonly episodesUnmeasured: number;
}

/** The env var naming the file a suite process appends its total to. */
export const LIVE_MODEL_SPEND_FILE_ENV = 'PROTEUS_EVAL_SPEND_FILE';

// The process's running total. Plain bindings rather than one mutable object, so
// `usage` keeps its `Usage` type through accumulation and `liveModelSpend()` is
// the single place the reported shape is assembled.
let spendCalls = 0;
let spendCallsWithoutUsage = 0;
let spendUsage: Usage = {};
let spendEpisodesUnmeasured = 0;

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

/**
 * The bound on model-call rows read out of one episode's store.
 *
 * An episode is capped at `PROTEUS_MAX_STEPS` model steps (500 by default), and
 * every other producer in a workspace fires at most a few times per step, so
 * this is three orders of magnitude above anything one episode can write. It
 * exists so `workspaceSpend`'s window cannot silently truncate an episode into a
 * floor — a total whose window you cannot see is a total you cannot check — and
 * `complete` below is what proves the window was not the binding constraint.
 */
const EPISODE_SPEND_WINDOW = 100_000;

/**
 * Record what ONE driven episode spent, read off the store its session wrote.
 *
 * WHY THE STORE AND NOT A SINK. A suite that calls `generateText` itself holds
 * the SDK result, so it reports per call through `recordLiveModelSpend` above. A
 * suite that drives a `LocalAgentSession` never sees a result: the session's own
 * turn steps land in the run-event log as `step_finish`, which
 * `events/model-call.ts` deliberately leaves OUTSIDE the `ModelCallSink` so a
 * judge's cold prompt cannot corrupt the turn loop's prefix-cache EMA. So a sink
 * subscription would have collected this workspace's judges and fast tier and
 * omitted the agent's own turns — which are the 13.4M prompt tokens the whole
 * gap was made of. `workspaceSpend` is the one seam that unions both row kinds
 * plus the head journal, so it is what this reads. No second meter, no second
 * definition of what a workspace spent.
 *
 * AN EPISODE ALWAYS COUNTS. A store that accounts for no call at all does not
 * add a silent zero: it increments `episodesUnmeasured`, because an episode that
 * ran and cannot say what it cost is a hole in the measurement and has to read
 * as one.
 */
export function recordLiveModelEpisode(sql: SqlExecutor): void {
  const spend = workspaceSpend({ events: new RunEventRecorder(sql), sql }, {
    windowLimit: EPISODE_SPEND_WINDOW,
  });
  // Unreachable at this window for a step-capped episode, and a throw rather
  // than a shrug because the alternative is publishing a floor as a total —
  // the exact confusion this function exists to remove.
  if (!spend.complete) {
    throw new Error(
      `episode spend truncated at ${String(EPISODE_SPEND_WINDOW)} rows, so its total would be a `
      + 'floor reported as a measurement — raise EPISODE_SPEND_WINDOW',
    );
  }
  if (spend.total.calls === 0) {
    spendEpisodesUnmeasured += 1;
    return;
  }
  spendCalls += spend.total.calls;
  spendCallsWithoutUsage += spend.total.callsWithoutUsage;
  spendUsage = addUsage(spendUsage, spend.total.usage);
}

export function liveModelSpend(): LiveModelSpend {
  return {
    calls: spendCalls,
    callsWithoutUsage: spendCallsWithoutUsage,
    usage: spendUsage,
    episodesUnmeasured: spendEpisodesUnmeasured,
  };
}

/**
 * Reset the meter, without publishing anything.
 *
 * For a suite that drives episodes against a SCRIPTED model. `bun test ./tests/`
 * is one process over every file in the tree, so the meter is shared across
 * files, and a scripted wiring suite that left its fake tokens in it would hand
 * them to whichever live suite reported next — a cost report is the last place a
 * fabricated number belongs. A scripted suite therefore clears what it recorded
 * in its own teardown instead of reporting it.
 */
export function resetLiveModelSpend(): void {
  spendCalls = 0;
  spendCallsWithoutUsage = 0;
  spendUsage = {};
  spendEpisodesUnmeasured = 0;
}

/**
 * One line stating what THIS SUITE spent, and the same appended to the aggregate
 * file when the eval tier asked for one. Called from a suite's teardown, so a run
 * that made no calls says which kind of no it was: nothing driven, or driven and
 * unaccounted.
 *
 * REPORTING DRAINS, and it has to. `bun test ./tests/` runs six reporting suites
 * in ONE process against this one module-level meter, each appending its own line
 * in its own teardown — and `scripts/eval-spend.ts` SUMS those lines. Cumulative
 * reporting therefore made every line after the first a running total of its
 * predecessors, so the tier's published cost was an over-count (the last suite
 * claiming everyone's spend, and the sum counting the first suite once per
 * reporter) while each line looked like a per-suite measurement. Draining makes a
 * line mean "what has been recorded since the last report", which for one report
 * per suite teardown is that suite's own spend — and makes the sum the run's.
 */
export function reportLiveModelSpend(suite: string): LiveModelSpend {
  const total = liveModelSpend();
  console.warn(
    `[spend] ${suite} — ${total.calls} model call(s), `
    + `${total.usage.input ?? 'unreported'} in / ${total.usage.output ?? 'unreported'} out tokens`
    + (total.callsWithoutUsage > 0 ? `, ${total.callsWithoutUsage} without reported usage` : '')
    + (total.episodesUnmeasured > 0
      ? `, ${total.episodesUnmeasured} episode(s) UNMEASURED — this suite drove work whose `
        + 'spend it could not account for, so the totals above are not this suite\'s cost'
      : ''),
  );
  const path = process.env[LIVE_MODEL_SPEND_FILE_ENV]?.trim();
  if (path) appendFileSync(path, `${JSON.stringify({ suite, ...total })}\n`);
  resetLiveModelSpend();
  return total;
}

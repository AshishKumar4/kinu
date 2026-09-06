/**
 * Where a live suite's model calls actually go — resolved once, in one place.
 *
 * The four root end-to-end suites each hand-rolled their own `LLM_CONFIG`
 * block: same four env vars, same hardcoded AI Gateway URL carrying one
 * account id, same model literal, four copies. All four then gated on
 * `KINU_AUTH`/`AI_GATEWAY_AUTH` alone, and an AI Gateway token is the one
 * credential the owner does NOT need — the default model is native Workers AI
 * DeepSeek on his own account. So the suites that prove multi-turn tool
 * calling, memory across a reopen, MCTS evolution and cross-session transfer
 * skipped at every commit for want of a credential that was never required.
 *
 * Two ways to reach a real model, in preference order:
 *
 *   1. WORKER PROXY — `KINU_ORIGIN` + `KINU_TOKEN`. A Kinu deployment
 *      fronts a Cloudflare credential at `/api/user/ai/v1`
 *      (cf-backend/src/user/ai-proxy.ts), so the test needs a CLI bearer and no
 *      Cloudflare token at all. This is the cheap path: native Workers AI. The
 *      pair is filled by `scripts/eval-tier.sh` from the eval-service identity
 *      (`eval-identity.ts`), and the origin is CHECKED against that module's
 *      allowlist here — this pair reaches a deployment's whole API, not just a
 *      model, so pointing it at production would let a suite write real data.
 *   2. AI GATEWAY — `AI_GATEWAY_BASE_URL` + `AI_GATEWAY_AUTH`. The pre-existing
 *      path, kept because it reaches models the account proxy does not front.
 *
 * `KINU_BASE_URL`/`KINU_AUTH` remain accepted for (2) because that is the
 * pair `.env.example` tells a developer to set for the CLI, and the CLI and
 * these suites share one endpoint.
 *
 * There is no baked-in default for either target. A test harness that silently
 * falls back to a hardcoded account's gateway cannot state which target it
 * measured, and this repo is public.
 *
 * The third outcome is the one that matters: an environment that is HALF-SET, or
 * aimed somewhere it may not go, is a configuration bug and not a skip.
 * `KINU_TOKEN` with no origin used to resolve to an empty header and a silent
 * skip — a green suite that proved nothing, over a machine whose operator
 * believed it was configured. Both return `misconfigured` and the suites throw.
 */
import {
  addUsage, cloudProxyBaseURL, createChatModel, DEFAULT_WORKERS_AI_MODEL_ID, normalizeUsage,
  RunEventRecorder, USER_AI_PROXY_PATH, usageReported, workspaceSpend, WORKSPACE_RUN_ID,
  type LLMProviderConfig, type ModelCallSink, type SqlExecutor, type Usage,
  type WorkspaceSpend,
} from '@kinu.run/core';
import type { LanguageModel, LanguageModelUsage } from 'ai';
import { appendFileSync } from 'node:fs';
import { LIVE_MODEL_ENV } from './ambient-env';
import { EVAL_STAGING_ORIGIN, evalTargetVerdict } from './eval-identity';

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

type EnvSource = Record<string, string | undefined>;

function first(env: EnvSource, names: readonly string[]): string | undefined {
  for (const name of names) {
    const value = env[name]?.trim();
    if (value) return value;
  }
  return undefined;
}

/** Bearer-prefix a token unless it already is one — `KINU_AUTH` is
 *  documented with the prefix, `KINU_TOKEN` without it. */
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
        + `A CLI bearer names no target: set the deployment origin (${EVAL_STAGING_ORIGIN}).`,
    };
  }
  // WHERE, before HOW MUCH. This pair reaches a Kinu DEPLOYMENT, not merely
  // a model: the same origin fronts `/api/cli/workspaces`, so a suite resolved
  // against production can create and delete real workspaces there — which is
  // how 23 of the 28 rows on the owner's account got made. One funnel for every
  // live suite, so no suite has to remember the rule.
  if (origin) {
    const verdict = evalTargetVerdict(origin, env);
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

/** A resolved worker-proxy target, decomposed back into the pair that reaches
 *  the deployment's own API. */
export interface LiveModelSession {
  readonly origin: string;
  readonly token: string;
}

/**
 * The worker origin and bearer behind a resolved worker-proxy target.
 *
 * RECOVERED FROM THE TARGET, never re-read from `process.env`, so a caller
 * cannot reach a different deployment than the one `liveModelTarget` announced
 * and the tier's banner printed. That is the whole point of deriving it: two
 * readings of the environment are two answers to "where did this run go", and a
 * measurement may not be vague about that.
 *
 * Lives here beside {@link LiveModelSession} because there are two callers — the
 * live smoke test and the cloud eval target, which creates and deletes a
 * workspace with this pair. It throws rather than returning null: a caller
 * asking for the deployment's own API has already decided it needs one, and an
 * AI-gateway target has no origin to give.
 */
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
  // collects them — and on a machine that happens to export KINU_BASE_URL /
  // KINU_AUTH they fired real paid model calls from a git hook (measured:
  // 101s and 81s for two tests) and then failed on a remote model's choices. A
  // developer's exported credential is a fact about their shell, never a
  // request to bill the owner's account during a commit.
  //
  // So a live run requires the eval tier to be DRIVING it. `KINU_EVAL_LIVE`
  // is set by scripts/eval-tier.sh and by nothing else; absent it, the suite
  // skips exactly as it does with no credential at all — and the skip-ratchet
  // gate still requires that skip to be declared, so the suite cannot go quiet.
  if (process.env['KINU_EVAL_LIVE'] !== '1') {
    console.warn(`[skip] ${suite} — live evals are opt-in: run 'bun run test:eval' (KINU_EVAL_LIVE=1)`);
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

/**
 * The marker a live failure carries when the ENVIRONMENT failed, not the agent.
 *
 * Exported so `scripts/skip-ratchet.ts` can classify a JUnit report without a
 * second copy of the string, and so a reader who greps a log finds the same word
 * the tier's summary counted.
 */
export const INFRA_FAILURE_MARKER = 'INFRA FAILURE';

/**
 * Run one step that depends on the DEPLOYMENT rather than on the model's
 * choices, and label its failure as such.
 *
 * WHY. A live suite has two ways to go red and they need different readers. "The
 * model did not call a tool" is a finding about the agent: someone should look at
 * the prompt, the tool surface, or the model. "The worker cold-started past the
 * timeout" is a finding about the environment: nobody should look at the agent at
 * all. Bun renders both as `(fail)`, so without a label a deploy blocked by a
 * 503 sends a reader hunting a behavioural regression that does not exist — and,
 * worse, an outage during a live run looks exactly like the thing the run was
 * built to detect.
 *
 * The label is placed by the code that KNOWS, at the boundary it wraps, rather
 * than sniffed out of a message afterwards. A classifier over error text would
 * have to guess, and a guess in this position turns an infrastructure excuse into
 * something a real behavioural failure can hide behind.
 *
 * The cause is preserved, always: the status code or socket error is the whole
 * evidence for calling it infrastructure, and a boundary that swallowed it would
 * be asking to be trusted instead.
 */
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
 * to `KINU_EVAL_SPEND_FILE`, and the eval tier sums the files into the one
 * number a run reports.
 *
 * THREE FEEDS, ONE METER, because there are three ways a suite comes to know
 * what a call cost and only three. A suite that calls `generateText` itself
 * holds the SDK result and reports per call (`recordLiveModelSpend`). A suite
 * that drives a `LocalAgentSession` never sees a result, so it reports per
 * episode off the store the session wrote (`recordLiveModelEpisode`). A suite
 * RESUMING an interrupted run reports neither, because the process that made
 * those calls is gone: it adopts what that process wrote down
 * (`recordAdoptedLiveModelSpend`). All three write the same counters — a second
 * meter for any one of them is how a tier learns to report a number the others
 * cannot.
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
   * suite that drives episodes registers each one here, and so does a resumed
   * run that adopts a case whose durable record cannot say what it cost, so a
   * zero neither of them earned arrives labelled instead of clean.
   */
  readonly episodesUnmeasured: number;
  /**
   * Episodes a suite DECLARED drive no model and whose store agreed. A file-plane
   * read or a pty keystroke case spends nothing by design; declared, its zero is
   * a measurement rather than a hole, and a declaration the store contradicts
   * is refused at the record site as the case's own defect.
   */
  readonly episodesWithoutModel: number;
}

/** The env var naming the file a suite process appends its total to. */
export const LIVE_MODEL_SPEND_FILE_ENV = 'KINU_EVAL_SPEND_FILE';

// The process's running total. Plain bindings rather than one mutable object, so
// `usage` keeps its `Usage` type through accumulation and `liveModelSpend()` is
// the single place the reported shape is assembled.
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

/**
 * The sink a DRIVEN STRATEGY reports its model calls to, so
 * {@link recordLiveModelEpisode} can read them.
 *
 * `recordLiveModelSpend` above serves a suite holding an SDK result. A suite that
 * drives a strategy holds none: the rollouts and judge samples are made deeper
 * down and reported to whatever `ModelCallSink` the caller supplied. With no sink
 * they still happen — they are simply never attributed, which is a suite spending
 * real tokens and reporting none.
 *
 * This writes the row PRODUCTION writes, to the log production writes it to
 * (cli-backend/src/local-session.ts:336-353), filed under {@link WORKSPACE_RUN_ID}
 * because a driven strategy belongs to no turn. Unpriced on purpose: a test
 * harness holds no model-catalog session, and an absent `usd` reads as "not priced
 * here" rather than as free.
 *
 * It lives beside the reader instead of in each suite, so the writer and the
 * `workspaceSpend` query that unions it cannot drift apart.
 */
export function liveModelCallSink(sql: SqlExecutor): ModelCallSink {
  const events = new RunEventRecorder(sql);
  return (report) => {
    events.emit(WORKSPACE_RUN_ID, {
      type: 'model_call', source: report.source, usage: report.usage,
    });
  };
}

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
 */
export function recordLiveModelEpisode(sql: SqlExecutor): void {
  recordWorkspaceSpend(workspaceSpend({ events: new RunEventRecorder(sql), sql }));
}

/**
 * Record an episode's spend from a `WorkspaceSpend` somebody else read.
 *
 * THE SAME METER, ONE STEP LOWER. `recordLiveModelEpisode` above reads the store
 * it is handed; a CLOUD episode's store is inside a Durable Object and is
 * reachable only as a read model over RPC. Both arrive at the same
 * `WorkspaceSpend` — the deployed side returns it verbatim from
 * `getActivitySnapshot`, whose `spend` field IS `workspaceSpend({ events, sql })`
 * — so the only thing that was ever backend-specific is who does the reading.
 * This is the accounting half, shared, and it is why the cloud arm cannot grow a
 * second definition of what a workspace spent.
 *
 * IT NO LONGER HAS A WINDOW TO REFUSE. A truncation guard stood here, and it was
 * load-bearing while the total was read over a bounded window: a windowed figure
 * printed where a reader takes an episode's cost is a floor wearing a
 * measurement's clothes. `workspaceSpend` now aggregates over the whole log, so
 * `complete` and `windowLimit` are gone from the read model and the guard has
 * nothing left to check. Deleted rather than kept as a tautology — a check that
 * cannot fire is the shape this repository keeps finding.
 *
 * AN EPISODE ALWAYS COUNTS. A store that accounts for no call at all does not
 * add a silent zero: it increments `episodesUnmeasured`, because an episode that
 * ran and cannot say what it cost is a hole in the measurement and has to read
 * as one.
 */
export function recordWorkspaceSpend(spend: WorkspaceSpend): void {
  if (spend.total.calls === 0) {
    spendEpisodesUnmeasured += 1;
    return;
  }
  spendCalls += spend.total.calls;
  spendCallsWithoutUsage += spend.total.callsWithoutUsage;
  spendUsage = addUsage(spendUsage, spend.total.usage);
}

/** Record an episode its suite declared drives no model. The store must agree:
 *  a call it accounted for means the declaration is wrong, and that is the
 *  case's failure, thrown here rather than folded into anyone's total. */
export function recordNoModelEpisode(spend: WorkspaceSpend): void {
  if (spend.total.calls !== 0) {
    throw new Error(`this case declared it drives no model and its store accounted for `
      + `${String(spend.total.calls)} model call(s)`);
  }
  spendEpisodesWithoutModel += 1;
}

/**
 * What a durable case record says a PREVIOUS process spent on one case.
 *
 * `calls` is the model-step count that process wrote as its own events landed;
 * `usage` is the token total its finished output stored. Both are read back
 * rather than recomputed, because the process that could recompute them is the
 * one that died.
 */
export interface AdoptedCaseSpend {
  readonly calls: number;
  readonly usage: Usage;
}

/** Whether a durable record could account for the case it belongs to. */
export type AdoptedSpendVerdict = 'accounted' | 'unaccounted';

/**
 * Record what a resumed run ADOPTED rather than drove.
 *
 * A run that spans processes publishes ONE record over every case, and the
 * spend beside those cases used to be whatever the LAST process happened to
 * pay. So the total SHRANK on every resume while the observation list it sat
 * next to stayed whole — a per-process figure printed where a reader takes the
 * run's cost, which is the same shape of error as reporting `0 model call(s)`
 * over an episode that spent hundreds of thousands of neurons.
 *
 * EVIDENCE OR A LABEL, never a silent zero. A record that counted no model step,
 * or that stored no token total, cannot say what its case cost: the call count
 * without the tokens reports a measured zero, and the tokens without the call
 * count report usage nothing made. Either way the case joins
 * `episodesUnmeasured` — the same sentence a driven episode gets when its store
 * accounts for nothing, because it is the same fact: the run drove work whose
 * cost it cannot state.
 *
 * ADOPTING TWICE is the caller's hazard, not this function's, which counts
 * whatever it is handed. `AdoptedSpendMeter` in eval-adopted-spend.ts owns the
 * once-per-case rule, because it is what holds the case keys.
 */
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
  spendEpisodesWithoutModel = 0;
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

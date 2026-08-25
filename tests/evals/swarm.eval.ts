/**
 * The live swarm eval: `agents({action:'swarm'})` driven through the real tool
 * surface, against a real model, graded by the CALLER'S OWN VERIFIER.
 *
 * WHY THIS FILE EXISTS. Before it, `action:'swarm'` — the one search rung the
 * product ships — had unit coverage only. Every suite that reaches it does so with
 * a `MockLanguageModelV3` (`packages/core/tests/unit-swarm-*.test.ts`) or through a
 * scripted dispatch record (`cli-backend/tests/local-session.test.ts:267`), and the
 * live tier's tree-search eval drives the MCTS STRATEGY programmatically
 * (`exploration.eval.test.ts`) because `settle:'mcts'` left the model-facing
 * surface. So nothing anywhere put a real model inside a real swarm and asked
 * whether the tree measured anything. That is what this does.
 *
 * WHAT IT PROVES, and every one of these can fail:
 *
 *   1. THE SETTLED API IS THE PATH. The call goes through `tools.agents.execute`,
 *      so `parseAgentsToolInput` runs first — and the credential-free test below
 *      shows that surface REFUSING an unknown field by naming the field it meant,
 *      on the same tool instance the live run uses. A schema that accepted
 *      `budgetUsd` and silently dropped the cap is the defect that parse exists
 *      for, and asserting it on a DIFFERENT tool instance would not prove the live
 *      path has it.
 *   2. A REAL PRESET RESOLVES. `preset:'custom'` seeded `from:'optimise'` — the
 *      real row out of `SWARM_PRESET_POINTS`, with one axis overridden — so the
 *      axes in force are the shipped ones rather than a literal written here.
 *   3. A REGISTERED VERIFY KIND MEASURES. `objective.verify.kind` is `exec-ratio`,
 *      resolved through `strategy/verifier-registry.ts`, and its `spec` is a corpus
 *      task's whole `RatioProblem`. So the number the tree climbs is produced by
 *      running node inside the workspace shell against a metered oracle — no judge,
 *      no rubric, no opinion.
 *   4. THE TREE IS A TREE. `depth: 2` and `branches: 3` with `expand:'aggregate'`,
 *      which is the composition where a LEVEL BARRIER exists and a FAN-IN can
 *      happen: `swarm-run.ts:1815` refuses to count a fan-in over fewer than two
 *      consumable parents, so `fanIn.levels >= 1` is evidence that a level was
 *      really reached and merged rather than a flat wave reported as a search.
 *   5. THE DISCLOSURES AGREE WITH THE AXES. `judgeEnsemble`, `fanIn` and the carry
 *      suppression are each asserted against the CONFIG THE REPORT ITSELF CARRIES,
 *      so the assertion holds for any composition and cannot be satisfied by a
 *      report that simply nulls everything.
 *   6. THE RECORD IS REACHABLE UNDER THE KEY A LATER RUN WOULD USE. The rows are
 *      read back through `recordsFor` — the store's own reader, scoped by objective
 *      identity and floor digest — and a DELIBERATELY WRONG identity is asserted to
 *      find nothing. A store whose rows answer every query is not keyed.
 *
 * EVERY RATIO HAS A NON-ZERO DENOMINATOR GUARD, asserted before the ratio it
 * guards. A suite that passes because it divided by zero is the defect this
 * repository keeps finding, and the improvement claim below — the winner's cost
 * against the measured baseline — is exactly the shape that fails that way.
 *
 * WHY IT IS A `*.eval.ts` AND NOT A `*.eval.test.ts`. Cost accounting, not style.
 * `scripts/eval-tier.sh` gives this arm its OWN spend file so
 * `scripts/eval-spend.ts --expect-live` can assert liveness over THIS suite alone:
 * a `*.eval.test.ts` would be collected by `bun test ./tests/`, its zero would be
 * summed with five other suites' spend, and a swarm eval that quietly stopped
 * calling a model would leave the tier green. `bun test` cannot match this
 * extension (`vitest.evals.config.ts` states why), so the arm is disjoint from the
 * bun suites by construction rather than by an ignore pattern somebody has to keep
 * in step.
 *
 * WHAT ONE RUN COSTS: see docs/TESTING.md, which carries the measurement.
 */
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import * as v from 'valibot';
import type { LanguageModel, ToolSet } from 'ai';

import {
  buildActorTools, execRatioImplementation,
  type AgentRuntime, type Floor, type JsonValue, type LLMProviderConfig,
  type ObjectiveIdentity,
} from '../../packages/core/src/index';
import {
  bestInCell, floorDigestOf, recordsFor, verifierDigestOf,
} from '../../packages/core/src/strategy/records';
import { provisionLocalTarget, type LocalAgentEvalTarget } from './target-local';
import { resolveEvalTarget } from './target';
import {
  EVAL_MODELS, HARD_TASKS, ledgerTotalsFromEvents, liveChatModel,
  recordTargetEpisodeSpend, reportLiveModelSpend, stepBoundEvidence, toolExecute,
  UNCONFIGURED_LLM,
  type EvalTier, type HardTask,
} from '@kinu.run/test-utils';

const SUITE = 'Swarm Evals';

/**
 * Which arm this process is. Flash is the volume arm, pro the small arm that
 * establishes the bound — the owner's split, and the same declaration the three
 * sibling arms make.
 */
const TIER: EvalTier = process.env.KINU_EVAL_TIER === 'pro' ? 'pro' : 'flash';

/**
 * WHERE this run's agent lives, resolved once, and the model it DRIVES.
 *
 * `liveModelTarget` alone stood here, so this suite could only ever measure the
 * in-process runtime — while `eval-tier.sh` exported `KINU_EVAL_BACKEND=cloud`,
 * named every report file `-cloud`, printed a CLOUD banner and ran this arm
 * against the local loop anyway. The cross-target arm below states that it
 * reaches `@cloudflare/think` under `=cloud`; the plan is what makes that true
 * rather than aspirational.
 *
 * ONE id, spread from the tier, read back off the PLAN. The model used to be
 * spread here from a separately resolved target: `resolveLiveModel`'s fallback
 * then decided it — `DEFAULT_WORKERS_AI_MODEL_ID`, the PRO id — so
 * `KINU_EVAL_TIER=flash` billed this arm at pro in silence, the one arm of four
 * whose cost the tier switch did not reach. `KINU_MODEL` is deliberately not
 * honoured: an arm chosen by two knobs is an arm that can be half-changed.
 */
const PLAN = resolveEvalTarget(SUITE, EVAL_MODELS[TIER]);
const LLM_CONFIG: LLMProviderConfig = PLAN?.llm ?? UNCONFIGURED_LLM;

/**
 * Which arms this target can carry.
 *
 * The IN-PROCESS arms call `tools.agents.execute` and read the settled result —
 * the report, the caps, the candidate list — which is the richest thing this
 * suite can assert and is expressible only over a `CLIRuntime`. They are local
 * BY NATURE, not by omission, so on the cloud plan they skip and say so instead
 * of provisioning a local workspace under a cloud banner. With no plan at all
 * (no credential) they still run: the parse assertion below is a property of the
 * shipped tool schema and costs nothing.
 *
 * `liveTest` gates on the plan rather than on a target, because the cross-target
 * arm runs on either.
 */
const IN_PROCESS = PLAN === null || PLAN.backend === 'local';
const liveTest = test.skipIf(PLAN === null);
const inProcessTest = test.skipIf(!IN_PROCESS);
const liveInProcessTest = test.skipIf(PLAN === null || !IN_PROCESS);

const TEST_DIR = join(tmpdir(), 'kinu-eval-swarm-' + String(Date.now()));

/**
 * The instrument, taken from the SHIPPED CORPUS rather than written here.
 *
 * `hard-majority-vote` for two measured reasons, both about making this arm's claim a
 * claim about the SEARCH:
 *
 *   1. THE WIDEST HONEST HEADROOM in the corpus. Its reference counts every token
 *      against every other — n² per instance, two instances — against a target of
 *      about 1.25n per instance, so the gap between the workspace as found and the
 *      best known algorithm is roughly three orders of magnitude on this instance.
 *      "The winner beat the baseline" is then a fact about whether the search
 *      produced anything correct at all, rather than a coin flip on whether the model
 *      found a 5% trick.
 *   2. THE SMALLEST INSTANCE among the wide-headroom entries, and instance size is
 *      what a NODE'S OWN experimentation costs rather than what the verifier costs.
 *      Measured: on the 50,000-token `hard-select-kth` entry a node wrote
 *      `bench_quickselect.mjs` and benchmarked three variants inside the workspace
 *      shell — correct behaviour, and minutes of it per node. At n=1200 the same
 *      instinct costs a second, and this arm has to be affordable at `ci`.
 *
 * From the corpus and not a local fixture because the corpus IS this repository's
 * declaration of a measurable optimisation task — prompt, seed files and
 * `RatioProblem` in one definition, so the prose the nodes read and the numbers the
 * verifier scores against cannot drift. A local copy would be a third one.
 */
const TASK_ID = 'hard-majority-vote';

function corpusTask(id: string): HardTask {
  const found = HARD_TASKS.find((task) => task.id === id);
  if (!found) {
    throw new Error(`the hard-task corpus has no "${id}", so this eval has no instrument: `
      + `it holds ${HARD_TASKS.map((task) => task.id).join(', ')}`);
  }
  return found;
}

const TASK = corpusTask(TASK_ID);

/**
 * The problem as `exec-ratio` takes it, spelled field by field.
 *
 * Spelled out rather than spread: `ExecRatioSpecSchema` is a `strictObject`, so a
 * field the corpus adds later would be REFUSED by the registry rather than ignored
 * — and a refusal naming a field this eval never meant to send is a worse failure
 * than a compile error here. Copied per use because `spec` crosses into the
 * objective's identity digest, and a shared mutable object is the one thing that
 * could make two runs of this eval incomparable.
 */
function problemSpec(): JsonValue {
  const { params, reference, body, targetOps, lowerBoundOps } = TASK.problem;
  return { params: { ...params }, reference, body, targetOps, lowerBoundOps };
}

/**
 * The certificate floor, declared by this caller because a floor is a PROOF and the
 * objective is what carries it.
 *
 * `lowerBoundOps` is the corpus's own bound for this instance and the argument is the
 * one that makes it sound, quoted from where the corpus states it: every token must
 * appear in at least one call, because one never passed to `equals` could hold the
 * majority value — and in the instance with no majority, flipping a single untouched
 * token would CREATE one. A call touches two tokens, so covering n of them needs
 * ceil(n/2) calls per instance, i.e. n for the pair. `bestKnownHonest` is the
 * corpus's measured target — the cost of the best implementation it ships — which is
 * what makes `floorMargin` a number about the room between a bound and reality
 * rather than about two constants.
 *
 * Declared rather than omitted because the floor is what makes the publication seal
 * REACHABLE: a candidate measured below that bound would have bypassed the meter, and
 * the run then seals and says so. No honest candidate can — the token values live in
 * a WeakMap the candidate module cannot reach — which is why the assertions below
 * expect an OPEN publication and treat a seal as a finding rather than as noise.
 */
const FLOOR: Floor = {
  value: TASK.problem.lowerBoundOps,
  kind: 'certificate',
  bestKnownHonest: TASK.problem.targetOps,
  proof: 'Every token must appear in at least one oracle call: one never passed to `equals` '
    + 'could hold the majority value, and in the instance whose most common value occupies '
    + 'exactly half the tokens, flipping a single untouched token would create a majority. A '
    + 'call touches two tokens, so covering n of them needs ceil(n/2) calls per instance — n '
    + 'for the pair this task is scored over.',
};

/**
 * What is measured, declared ONCE and spent three ways.
 *
 * The metric, unit, direction and scale are the four fields of
 * {@link ObjectiveIdentity} — the comparability key — and they are also four fields
 * of the objective the call sends. Naming them here is what stops the call and the
 * key from disagreeing, which would be invisible: a run whose rows are keyed under a
 * different identity than the one this suite reads back would simply find no rows,
 * and "the store wrote nothing" and "I looked in the wrong cell" are the same
 * symptom.
 */
const METRIC = 'oracle_calls';
const UNIT = 'oracle calls';
const DIRECTION = 'minimise';
const SCALE = 'log';
const TARGET_OPS = TASK.problem.targetOps;

/**
 * The objective as it crosses the WIRE, which is snake_case.
 *
 * MEASURED, not anticipated: this eval's first live call handed the tool a camelCase
 * `Floor` and was REFUSED with `Invalid key: Expected "best_known_honest" but
 * received undefined` before a single model call. That is the wire boundary doing
 * exactly its job — `SwarmObjectiveSchema` owns the naming convention and
 * `tools/swarm-input.ts` transforms it into the camelCase type the search reads — and
 * it is why the two spellings meet in ONE named place here rather than inline at the
 * call. `floorDigestOf` and the identity below read the camelCase side; the tool
 * reads this one.
 *
 * `scale:'log'` because algorithmic improvement is multiplicative, which is the
 * reason `ObjectiveScale` has the value at all (`hard-tasks/cost-model.ts`): n² to
 * n^1.5 is real, partial, climbable progress that a linear scale scores as almost
 * nothing.
 */
function objectiveWire(): JsonValue {
  return {
    kind: 'scalar',
    metric: METRIC,
    unit: UNIT,
    direction: DIRECTION,
    scale: SCALE,
    target: TARGET_OPS,
    verify: { kind: 'exec-ratio', spec: problemSpec() },
    floor: {
      value: FLOOR.value,
      kind: FLOOR.kind,
      proof: FLOOR.proof,
      best_known_honest: FLOOR.bestKnownHonest,
    },
  };
}

/**
 * The comparability key, recomputed HERE from what this eval declared.
 *
 * Recomputed and not read off the result, which is the whole point: the store's rows
 * must be findable by a caller holding only the objective — that is what "a later
 * run starts from what this one reached" means — so deriving the key from the result
 * would prove nothing about the key.
 */
const IDENTITY: ObjectiveIdentity = {
  metric: METRIC,
  unit: UNIT,
  direction: DIRECTION,
  scale: SCALE,
  verifierDigest: verifierDigestOf(
    { kind: 'exec-ratio', spec: problemSpec() },
    execRatioImplementation(),
  ),
};

/**
 * The shape of the search, stated here rather than inherited.
 *
 * `depth: 2` is the smallest cap at which a level barrier EXISTS — `regionRefusal`
 * refuses `expand:'aggregate'` below it, and `fanInAtLevel` refuses a vertex past
 * the cap — so this is the cheapest search that can prove anything about the tree.
 * `branches: 3` is `optimise`'s own width and the smallest that survives one
 * unmeasurable sibling: a fan-in needs TWO consumable parents, so at width 2 a
 * single node writing a wrong answer would turn "the level barrier was reached"
 * into a fact about the model's luck. The node budget is `depth × branches` = 6
 * (`swarm-budget.ts`), which is what this arm is billed for.
 */
const DEPTH = 2;
const BRANCHES = 3;
const LABEL = 'live-swarm-eval-verifier-fanin';

/**
 * The wall-clock envelope this run ASKS for, through the only bound the surface has —
 * and the measured statement of how far that bound actually reaches.
 *
 * `runSwarmAction` forwards exactly one thing a caller can use to end a search: the
 * `abortSignal` on the tool-call options (`agents-tool.ts:909-910`).
 * `AGENTS_ACTION_FIELDS.swarm` records that an iteration cap and a wall-clock cap are
 * DELIBERATELY ABSENT until something enforces them, and nothing does. So this signal
 * is the bound, and it is passed rather than omitted.
 *
 * WHAT IT DOES NOT BOUND, measured twice on this eval rather than reasoned about. A
 * node consults the signal BETWEEN steps (`node-agent.ts:487`, `isAborted`), so a node
 * inside ONE long step never observes it:
 *
 *   - against a worker proxy whose upstream Cloudflare login had expired, three
 *     depth-1 heads errored in ~1 s (`Your Cloudflare login is no longer valid …
 *     (upstream: Authentication error)`) and three more sat at `status:'running'`,
 *     `completed_at: NULL`, zero steps, for SIXTY-THREE MINUTES with no store write
 *     and no exit;
 *   - against a healthy credential, three heads made 12 steps in 143 s — reading the
 *     reference, finding the measure harness, writing and running their own benchmark,
 *     which is the behaviour this eval wants — and then one step ran for 26 MINUTES on
 *     the 50,000-token instance, held the runner at 91% CPU, and passed a 20-minute
 *     `AbortSignal.timeout` with no effect at all. The vitest test timeout did not fire
 *     either, which is consistent with a microtask-driven loop starving the timer
 *     phase: neither timer can run while the workspace substrate executes in-process.
 *
 * So the signal is kept, honestly described, and the instrument above is what actually
 * keeps this arm bounded — a small instance means short steps, and a step boundary is
 * the only place a bound of any kind is currently observable.
 *
 * WHAT THIS NUMBER IS, corrected by the measurement it produced. It was written as
 * "20 minutes because the budget is 6 nodes", which reads as a DERIVED bound and is not
 * one: the run it bounded measured three nodes still working at 1,216,358 / 1,310,061 /
 * 1,336,833 ms across 22 / 25 / 26 steps, so this number is smaller than ONE node of the
 * six it claimed to cover. The derived node envelope is `nodeWallClockEnvelopeMs` in
 * `strategy/node-agent.ts` — the node's step cap times the measured turn envelope — and
 * 1_200_000 is under it by more than two orders of magnitude at the shipped step cap.
 *
 * So it is kept and RELABELLED: this is a COST CEILING on one paid arm, not a claim
 * about how long a node needs. A run that reaches it is a run that did not fit in the
 * ceiling, and it says so precisely — `stop:'aborted'`, every candidate carrying
 * `incomplete` with its node's status, step count and clock, and nothing scored. The
 * assertions below refuse that outcome, which is the arm reporting "this did not fit"
 * rather than "the model was bad". Raising the ceiling is a decision about money and
 * belongs to whoever pays for the tier; it is not a fix and is not made here.
 *
 * The vitest timeout below is deliberately larger, so a run that ends inside the ceiling
 * ends through this seam rather than through the runner.
 */
const ENVELOPE_MS = 1_200_000;

/** The fields this eval reads off the tool's JSON result. `v.object` rather than
 *  `strictObject`: a settle report carries more than is asserted here, and a field
 *  added to it must not fail this suite — but every field read below is PARSED
 *  rather than trusted, so a report that stopped carrying one fails loudly instead
 *  of comparing against `undefined`. */
const MeasuredSchema = v.object({
  value: v.number(),
  measured: v.nullable(v.record(v.string(), v.number())),
});

const CandidateSchema = v.object({
  id: v.string(),
  artifact: v.string(),
  measured: v.nullable(MeasuredSchema),
  unmeasurable: v.nullable(v.string()),
  /** Why a node produced no answer at all. Read because without it a candidate with no
   *  measurement reads as the INSTRUMENT's failure, and on the run that produced the
   *  figures above every one of the three was a node this arm's own ceiling stopped. */
  incomplete: v.nullable(v.string()),
  score: v.nullable(v.number()),
});

const SwarmResultSchema = v.object({
  preset: v.string(),
  label: v.nullable(v.string()),
  config: v.object({
    unit: v.object({ kind: v.string() }),
    context: v.string(),
    expand: v.string(),
    score: v.object({ kind: v.string() }),
    advance: v.object({ kind: v.string() }),
    carry: v.object({ kind: v.string() }),
  }),
  caps: v.object({
    depth: v.nullable(v.object({ value: v.number(), origin: v.string() })),
    branches: v.nullable(v.object({ value: v.number(), origin: v.string() })),
  }),
  report: v.object({
    settle: v.string(),
    floorMargin: v.nullable(v.number()),
    baseline: v.nullable(v.number()),
    witnessFound: v.nullable(v.boolean()),
    carrySuppressed: v.nullable(v.object({ carry: v.string() })),
    records: v.nullable(v.object({
      carriedIn: v.number(),
      carriedInBest: v.nullable(v.number()),
      carriedInCells: v.number(),
      written: v.number(),
      notBetter: v.number(),
      tooClose: v.number(),
    })),
    judgeEnsemble: v.nullable(v.object({
      requested: v.number(), realised: v.nullable(v.number()),
    })),
    stop: v.picklist(['settled', 'budget', 'aborted']),
    expansions: v.number(),
    tokens: v.nullable(v.number()),
    durationMs: v.number(),
    fanIn: v.nullable(v.object({
      levels: v.number(),
      order: v.array(v.string()),
      merged: v.number(),
      vertices: v.array(v.string()),
      unusableParents: v.number(),
      prunedParents: v.number(),
    })),
  }),
  publication: v.object({
    state: v.object({ kind: v.string() }),
    caveat: v.nullable(v.string()),
  }),
  best: v.nullable(CandidateSchema),
  candidates: v.array(CandidateSchema),
});

/** A refusal, which is the OTHER shape this surface returns. Read first and
 *  reported verbatim, because a refusal's text names what the call got wrong and a
 *  schema complaint over it would hide that. */
const RefusalSchema = v.object({ reason: v.string(), error: v.string() });

/** What this eval SENDS: a swarm call as it crosses the wire. JSON rather than
 *  `AgentsToolInput`, because one test deliberately sends a field that input does not
 *  declare — which is precisely what reaches `execute` in production, since the AI
 *  SDK validates a call's types against the JSON Schema and never its field names. */
type SwarmCall = Readonly<Record<string, JsonValue>>;

/**
 * The two shapes `agents.swarm` answers with, as ONE parsed value.
 *
 * The tool returns a run report or a refusal and they are different shapes on
 * purpose — a caller branching on `reason` is asking a different question from one
 * reading a report — so the boundary is here, once, and nothing below it handles an
 * unparsed answer.
 */
type SwarmOutcome =
  | { readonly kind: 'refused'; readonly refusal: v.InferOutput<typeof RefusalSchema> }
  | { readonly kind: 'ran'; readonly result: v.InferOutput<typeof SwarmResultSchema> };

describe('Swarm evals — a live measured search through the settled tool surface', () => {
  let target: LocalAgentEvalTarget;
  let rt: AgentRuntime;
  let model: LanguageModel;
  let tools: ToolSet;
  let callSwarm: (args: SwarmCall, signal: AbortSignal) => Promise<SwarmOutcome>;

  beforeAll(async () => {
    console.warn(`[swarm] ${PLAN?.describe ?? 'no live target — credential-free arms only'}`);
    if (!IN_PROCESS) {
      // NOT provisioned, and that is the fix rather than an omission. The arms
      // below this block drive the INNER API, so on the cloud plan they cannot
      // run at all — and opening a local workspace here would be a local
      // measurement standing under a cloud banner, which is the one error the
      // target seam exists to remove. The cross-target arm provisions its own.
      console.warn(`[swarm/cloud] the in-process arms are SKIPPED: they call `
        + 'tools.agents.execute and read the settled result over a CLIRuntime, which a '
        + 'deployed workspace does not hand out. Run them with KINU_EVAL_BACKEND unset. '
        + 'The cross-target arm below runs here and is what reaches @cloudflare/think.');
      return;
    }

    // PROVISIONED THROUGH THE SEAM. Birth, `initWorkspaceSchema`, `openWorkspaceCLI`
    // with `hostRoot: null`, the executor-surface and sandbox guards and
    // `installPreTurnProfile` were all spelled out here, and identically in three
    // sibling suites — so a step learned in one place had to be remembered in four.
    // `provisionLocalTarget` is that sequence, once. Nothing about what this suite
    // measures changes; the setup simply stopped being a fourth copy.
    target = await provisionLocalTarget({
      dir: TEST_DIR,
      workspace: 'swarm-eval',
      purpose: 'An optimisation engineer who beats a measured baseline and proves it by running it.',
      llm: LLM_CONFIG,
      model: liveChatModel(LLM_CONFIG),
      evolution: false,
    });
    rt = target.runtime;

    // THE VERIFIER PROBE, and this is the assertion that changed rather than moved.
    // What stood here was `requireVerifierShell`, which asserts a shell EXISTS. The
    // production incident was a shell that existed and could not run the only
    // registered verifier kind: `exec-ratio` writes a `.mjs` harness and runs `node`
    // on it, and the deployed Nimbus shim rejects esbuild-wasm's `wasmModule` option
    // outside a browser, so every `score:'verify'` search there is dead on arrival.
    // The old check passed throughout. This one RUNS the instrument's own shape and
    // refuses on the verdict, which is the fact this eval's ground truth depends on.
    const probe = await target.probe();
    if (probe.verifier.kind !== 'runs') {
      throw new Error(`swarm-eval cannot measure anything on this target: ${probe.verifier.reason}`);
    }

    // The corpus task's own files, through the OPENED runtime's filesystem: the
    // reference the nodes read and the stub the instrument measures. Sequential
    // because two writes to one VFS are not independent.
    for (const file of TASK.seed) await rt.storage.vfs.writeFile(file.path, file.content);

    model = liveChatModel(LLM_CONFIG);
    tools = buildActorTools({
      rt,
      agents: {
        mode: 'build',
        // The exploration substrate, which is what puts `swarm` in the action enum.
        fork: { rt, model },
      },
    });
    const entry = tools.agents;
    if (!entry) throw new Error('the agents tool was not built, so there is no swarm rung to drive');
    const execute = toolExecute<SwarmCall, JsonValue>(entry);
    // THE BOUNDARY, and the only one: the tool's answer is parsed into the union above
    // here, so no assertion below ever reads an unparsed field. A refusal is recognised
    // first because it is the shape that says what a call got wrong.
    //
    // `abortSignal` is the ONLY wall-clock bound this surface has — see ENVELOPE_MS for
    // the hour of silence that made it a parameter rather than an option — so it is
    // required rather than optional: a caller that forgot it would be a caller with no
    // bound at all.
    callSwarm = async (args, signal) => {
      const raw = await execute(args, {
        toolCallId: 'swarm-eval', messages: [], abortSignal: signal,
      });
      const refused = v.safeParse(RefusalSchema, raw);
      if (refused.success) return { kind: 'refused', refusal: refused.output };
      return { kind: 'ran', result: v.parse(SwarmResultSchema, raw) };
    };
  });

  afterAll(async () => {
    // NOT recorded here. Each measured arm records its own episode the moment its
    // call returns, however it returned — see the ordering note at the first one.
    // Recording again in teardown would double every figure this arm publishes,
    // and a per-arm liveness gate reading a doubled total is worse than one
    // reading none.
    reportLiveModelSpend(SUITE);
    // Teardown owns the store and the directory of the IN-PROCESS target only.
    // The cross-target arm owns its own target's teardown in its own `finally`,
    // because on the cloud plan that call deletes a workspace on the account and
    // a run that threw must not leave a row behind waiting for this hook.
    await target?.teardown();
  });

  inProcessTest('the settled surface is the path: swarm is offered, and an unknown field is refused by name', async () => {
    // CREDENTIAL-FREE, and the precondition every live assertion rests on. Both
    // halves are about the SAME tool instance the live run drives:
    //
    //   - the action is offered at all. Without it, "the swarm did not run" and "the
    //     swarm could not be called" are indistinguishable;
    //   - a field the input does not declare is REFUSED, naming the field it meant.
    //     The AI SDK validates a tool call's TYPES against the JSON Schema and never
    //     its field NAMES, so `execute`'s own parse is the only thing between a
    //     camelCase cap and a search that runs uncapped — which is exactly what
    //     `budgetUsd` did before that parse was strict. Nothing is spent: every field
    //     name is validated before any field is read.
    expect(Object.keys(tools)).toContain('agents');

    const outcome = await callSwarm({
      action: 'swarm', preset: 'custom', from: 'optimise', label: LABEL,
      task: TASK.prompt, objective: objectiveWire(), depth: DEPTH, branches: BRANCHES,
      // The mis-spelling, which is the subject of the assertion.
      budgetUsd: 5,
      // Never aborts: this call is refused by the parse before any field is read, so
      // there is nothing to bound and a timer here would outlive the test.
    }, new AbortController().signal);
    if (outcome.kind !== 'refused') {
      throw new Error('the tool ACCEPTED a field its input does not declare, so a camelCase cap '
        + 'reaches the dispatcher and is read by nothing at all');
    }
    expect(outcome.refusal.reason).toBe('bad_input');
    expect(outcome.refusal.error).toContain('unknown field "budgetUsd" — did you mean "budget_usd"?');
  });

  inProcessTest('the arm drives the tier it declared', () => {
    // CREDENTIAL-FREE, and the reason it exists: this arm read no tier at all,
    // so `resolveLiveModel`'s fallback chose the model and `KINU_EVAL_TIER=flash`
    // was billed at pro in silence. A default that a knob does not reach is not
    // a default, it is a second source of truth.
    //
    // Read off the DRIVEN MODEL rather than off the config it was built from, so
    // this also covers the other half of the same defect: a config carrying one
    // id while the run drives another is what the behaviour arm's own note
    // records. Parsed, because `LanguageModel` is an object or a bare id string
    // and only the object states which model it is — a string here would mean
    // the suite cannot say what it drives, which is the finding rather than a
    // branch to take. Both branches of the arm are asserted, so a run with no
    // target cannot pass this vacuously.
    const driven = v.parse(v.object({ modelId: v.string() }), model);
    expect(driven.modelId).toBe(LLM_CONFIG.model);
    expect(LLM_CONFIG.model).toBe(PLAN === null ? UNCONFIGURED_LLM.model : EVAL_MODELS[TIER]);
  });

  liveInProcessTest('MEASURED: a live swarm crowns a winner that beats its own measured baseline', async () => {
    const startedAt = Date.now();
    const outcome = await callSwarm({
      action: 'swarm',
      // A COMPOSITION, not a bare preset, and the label is what records it as one.
      // `from:'optimise'` resolves the real row — unit:answer, context:fork,
      // score:verify, advance:uct, carry:elites — and `expand:'aggregate'` is the one
      // axis overridden, because that is the value under which a level barrier fans
      // in. A named preset takes no `config` at all (it is a tested path and cannot
      // be refused), which is why this call is `custom`.
      preset: 'custom',
      from: 'optimise',
      label: LABEL,
      config: { expand: 'aggregate' },
      task: TASK.prompt,
      objective: objectiveWire(),
      depth: DEPTH,
      branches: BRANCHES,
    }, AbortSignal.timeout(ENVELOPE_MS));
    const wallSeconds = (Date.now() - startedAt) / 1000;

    // SPEND FIRST, BEFORE ANY PATH THAT CAN THROW. This line used to sit below
    // the refusal check and the destructuring, so a swarm that ran and then
    // refused reported ZERO model calls — and this arm's whole reason for being
    // its own arm is that its zero has to be its own failure.
    //
    // Measured 2026-08-24 against staging: three nodes ran (7, 14 and 9 model
    // steps; 9, 14 and 12 tool calls), one died on an upstream 500 after
    // 711,990 ms, one was cut by the envelope at 1,199,641 ms, the call came
    // back a refusal, the throw below fired, and the arm published
    // `0 model call(s), unreported in / unreported out tokens`. The tier's
    // per-arm liveness gate then correctly called the arm UNPROVEN — for a
    // reason that was this ordering rather than an absent model, which is the
    // worst kind of true alarm: it accuses the target and indicts nothing.
    //
    // `recordLiveModelEpisode` reads the store, so it is meaningful the moment
    // the call returns however it returned, and it can be called on a workspace
    // that spent nothing — an episode that reached no model increments
    // `episodesUnmeasured` instead of adding a silent zero. So there is no exit
    // path on which recording early is wrong, and one on which recording late
    // loses the whole arm's cost.
    // Through the SEAM rather than the store: `recordTargetEpisodeSpend` reads
    // `workspaceSpend` on a local target and the deployment's own copy of the same
    // read model on a cloud one, so this line keeps its meaning on either arm and
    // there is still exactly one definition of what a workspace spent.
    await recordTargetEpisodeSpend(target);

    // A REFUSAL IS REPORTED VERBATIM. The two shapes are different on purpose, and a
    // refusal's one sentence names what the call got wrong — which is worth more than
    // any assertion that could be made about it here.
    if (outcome.kind !== 'ran') {
      throw new Error(`the swarm refused instead of running (${outcome.refusal.reason}): `
        + outcome.refusal.error);
    }
    const { result } = outcome;
    const { report, config, caps, best, candidates } = result;

    // WHAT THIS RUN FOUND. The ARM comes first, read off the config the run
    // actually drove: this suite publishes no run record — no `publishRunRecord`,
    // unlike the three vitest-evals arms — so this line is where the tier and the
    // model id are disclosed, and a cost read without them is a cost that cannot
    // be compared with yesterday's.
    console.log(`    arm ${TIER}, model ${LLM_CONFIG.model}`);
    console.log(`    wall ${wallSeconds.toFixed(1)}s, engine ${(report.durationMs / 1000).toFixed(1)}s, `
      + `${String(report.tokens ?? 'unreported')} tokens, ${String(report.expansions)} expansions, `
      + `stop=${report.stop}`);
    console.log(`    baseline ${String(report.baseline ?? 'none')} ${UNIT}, `
      + `winner ${String(best?.measured?.value ?? 'none')} (score ${String(best?.score ?? 'none')})`);
    for (const candidate of candidates) {
      // THREE OUTCOMES, not two. A candidate with no measurement is either a node that
      // never finished or an answer the instrument declined; printing both as
      // "unmeasurable" is what sent the last reading of this arm to the verifier for a
      // cause that was the ceiling above.
      const outcome = candidate.incomplete !== null
        ? `did not finish — ${candidate.incomplete}`
        : candidate.measured === null
          ? `unmeasurable — ${String(candidate.unmeasurable)}`
          : `${String(candidate.measured.value)} calls, score ${String(candidate.score)}`;
      console.log(`      ${candidate.id}: ${outcome}`);
    }
    console.log(`    fanIn ${JSON.stringify(report.fanIn)}`);
    console.log(`    records ${JSON.stringify(report.records)}`);

    // ── The run happened at all ────────────────────────────────────────────────
    // Denominators first, before any claim that divides by one of them. Each of the
    // three below is a different way for a run to have produced nothing to measure.
    expect(report.stop).not.toBe('aborted');
    expect(candidates.length).toBeGreaterThan(0);
    expect(report.expansions).toBe(candidates.length);

    // ── The shape in force is the shape asked for ──────────────────────────────
    // Read off the RESULT rather than assumed, because the caps are what the record
    // digests and a cap accepted and ignored is the defect the axis table is written
    // against.
    expect(result.preset).toBe('custom');
    expect(result.label).toBe(LABEL);
    expect(caps.depth?.value).toBe(DEPTH);
    expect(caps.branches?.value).toBe(BRANCHES);
    expect(config.expand).toBe('aggregate');
    expect(config.score.kind).toBe('verify');
    expect(config.carry.kind).toBe('elites');
    expect(report.settle).toBe('best');

    // ── The tree really is a tree ──────────────────────────────────────────────
    // The winner's own row is what says which run these nodes belong to, and the
    // depth is read from the rows the engine WROTE rather than from the cap it was
    // given: a `depth` that produces no second level is an axis in the docstring and
    // a no-op in the engine.
    if (!best) throw new Error('no winner was crowned, so there is nothing to trace to a tree');
    const rootRows = rt.storage.sql<{ root_id: string }>`
      SELECT root_id FROM search_nodes WHERE id = ${best.id}`;
    const rootId = rootRows[0]?.root_id;
    if (rootId === undefined) {
      throw new Error(`the winner ${best.id} has no row in search_nodes, so the run left no tree`);
    }
    const depthRows = rt.storage.sql<{ deepest: number | null }>`
      SELECT MAX(depth) AS deepest FROM search_nodes WHERE root_id = ${rootId}`;
    expect(depthRows[0]?.deepest ?? 0).toBeGreaterThanOrEqual(2);

    // ── The winner beats the measured baseline ─────────────────────────────────
    // *Measured baseline*: measured on the workspace as found, before any candidate
    // exists, never supplied by this caller. The guards are what stop the ratio below
    // from being the division-by-zero pass this repository keeps finding — a null
    // baseline, a zero baseline or an unmeasurable winner each make "improvement"
    // arithmetic over nothing.
    expect(report.baseline).not.toBeNull();
    const baseline = report.baseline ?? 0;
    expect(baseline).toBeGreaterThan(0);
    expect(best.measured).not.toBeNull();
    const winner = best.measured?.value ?? 0;
    expect(winner).toBeGreaterThan(0);
    expect(best.unmeasurable).toBeNull();

    const ratio = winner / baseline;
    console.log(`    winner/baseline = ${ratio.toFixed(4)} (minimise, so < 1 is an improvement)`);
    // The claim, in the objective's own direction. `minimise`, so the winner must
    // have spent strictly FEWER oracle calls than the reference did on the very same
    // instance in the same process — which is what the instrument reports beside
    // every measurement.
    expect(ratio).toBeLessThan(1);
    // And the normalised score the tree climbed agrees with the raw comparison. They
    // are two different numbers (*Raw units*), so an improvement that scored zero
    // would mean the reward the search selected on is not the metric the caller
    // declared.
    expect(best.score).not.toBeNull();
    expect(best.score ?? 0).toBeGreaterThan(0);
    // The baseline is the INSTRUMENT'S own and not a number this suite computed: the
    // measurement carries `refOps` beside `candOps`, and the report's baseline is
    // that key.
    expect(best.measured?.measured?.refOps).toBe(baseline);

    // ── The floor was declared, measured against, and not breached ─────────────
    // *Floor margin* C3: computed and surfaced at declaration, never thresholded. A
    // BREACH seals the objective and suppresses the carry, and it would be a finding
    // rather than a flake — no honest candidate can beat a certificate bound — so
    // these assertions state the open case and a seal goes red carrying its caveat.
    expect(report.floorMargin).not.toBeNull();
    expect(report.floorMargin ?? -1).toBeGreaterThan(0);
    expect(result.publication.state.kind).toBe('open');
    expect(result.publication.caveat).toBeNull();
    expect(winner).toBeGreaterThanOrEqual(FLOOR.value);

    // ── The three disclosures, against the axes the report itself carries ──────
    // Stated as EQUIVALENCES over `config` rather than as expected literals, so each
    // is about the report's internal consistency and cannot be satisfied by a report
    // that nulls everything: a judged run must carry an ensemble, an aggregating run
    // must carry a fan-in, and a suppressed carry must have a seal behind it.
    expect(report.judgeEnsemble !== null).toBe(config.score.kind === 'judge');
    expect(report.fanIn !== null).toBe(config.expand === 'aggregate');
    expect(report.carrySuppressed !== null).toBe(result.publication.state.kind !== 'open');
    // A witness verdict is a claim about a witness hunt, and this objective is not
    // one — null is the only honest value.
    expect(report.witnessFound).toBeNull();

    // ── The fan-in happened, and its account is self-consistent ────────────────
    const fanIn = report.fanIn;
    if (!fanIn) throw new Error('expand:"aggregate" reported no fan-in, so the DAG did not run');
    const candidateIds = new Set(candidates.map((candidate) => candidate.id));
    // A LEVEL WAS REALLY CONSUMED. The engine refuses to count a fan-in over fewer
    // than two consumable parents — a fan-in over one is `sample` under another name
    // — so this is what separates a real level barrier from a flat wave.
    expect(fanIn.levels).toBeGreaterThanOrEqual(1);
    // Every member offered was a graded candidate of this run: a member needs a score
    // to be offered at all, and a score means it was measured.
    expect(fanIn.order.every((id) => candidateIds.has(id))).toBe(true);
    // The merge order is an ORDER: no member appears twice, and no more merges landed
    // than were attempted. `order.length` against `merged` is what a reader compares,
    // which is why there is no "dependents refused" counter to compare instead.
    expect(new Set(fanIn.order).size).toBe(fanIn.order.length);
    expect(fanIn.order.length).toBeGreaterThanOrEqual(fanIn.merged);
    expect(fanIn.merged).toBeGreaterThanOrEqual(1);
    // A vertex is graded like any other candidate, so one that exists is in the
    // candidate list. Empty is legitimate — parents that agreed have nothing to
    // aggregate about, and burning a graded node on two identical answers would
    // decide nothing — so emptiness is not what is asserted here.
    expect(fanIn.vertices.every((id) => candidateIds.has(id))).toBe(true);
    // Parents a fan-in could not consume are COUNTED, never dropped in silence, and
    // they cannot exceed the nodes this run made.
    expect(fanIn.unusableParents + fanIn.prunedParents).toBeLessThanOrEqual(candidates.length);

    // ── The records store: written, and reachable under the key ────────────────
    // `carry:'elites'` IS the store, so a run under it that wrote nothing carried
    // nothing. The READ half is asserted too: a fresh workspace is the first run of
    // this objective, so the honest carry-in is zero — reported rather than absent,
    // which is what makes a later run's non-zero mean something.
    const records = report.records;
    if (!records) throw new Error('a measured run reported no records report, so it had no identity');
    expect(records.carriedIn).toBe(0);
    expect(records.carriedInBest).toBeNull();
    expect(records.carriedInCells).toBe(0);
    expect(records.written).toBeGreaterThan(0);

    // Read back through the STORE'S OWN READER, scoped by the identity and the floor
    // — the key a later run holds. Recomputed from the objective this suite declared,
    // so this proves the rows are findable by a caller that never saw the result.
    const rows = recordsFor(rt.storage.sql, { identity: IDENTITY, floor: FLOOR });
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.length).toBeLessThanOrEqual(records.written);
    // Best FIRST in the objective's own direction, so the store's incumbent is the
    // winner this run crowned.
    expect(rows[0]?.value).toBe(winner);
    expect(bestInCell(rt.storage.sql, { identity: IDENTITY, floor: FLOOR, descriptor: null })?.value)
      .toBe(winner);
    // Every row belongs to THIS run's tree, and carries the provenance a leaderboard
    // reader needs without resolving a digest.
    for (const row of rows) {
      expect(row.rootId).toBe(rootId);
      expect(row.preset).toBe('custom');
      expect(row.label).toBe(LABEL);
      expect(row.depth).toBe(DEPTH);
      expect(row.branches).toBe(BRANCHES);
      expect(row.floorDigest).toBe(floorDigestOf(FLOOR));
      expect(row.floorValue).toBe(FLOOR.value);
      // NULL means this objective has no descriptor partition — not "the unnamed
      // cell". `advance:'uct'` keeps no archive, and a `key` here would have been
      // refused.
      expect(row.descriptor).toBeNull();
    }

    // THE ROWS ARE KEYED, and this is what proves it rather than the reads above: a
    // deliberately different metric is a different objective identity and must find
    // nothing, and the same rows under a different floor must find nothing either —
    // the comparable set is the identity AND the floor it was published under, never
    // one without the other.
    expect(recordsFor(rt.storage.sql, {
      identity: { ...IDENTITY, metric: 'wall_ms' }, floor: FLOOR,
    })).toEqual([]);
    expect(recordsFor(rt.storage.sql, { identity: IDENTITY, floor: null })).toEqual([]);

    // ── The run reported what it spent ─────────────────────────────────────────
    // Last, because it is the weakest claim and the easiest to fake: an absent total
    // is not a free run, and a swarm whose token count is null is a search nobody can
    // bill.
    expect(report.tokens).not.toBeNull();
    expect(report.tokens ?? 0).toBeGreaterThan(0);
    expect(report.durationMs).toBeGreaterThan(0);
    // 25 minutes: five above the 20-minute abort envelope, so the run ends through the
    // seam under test and a red says `stop:'aborted'` rather than `test timed out`.
  }, 1_500_000);

  /**
   * THE CROSS-TARGET ARM: a real user turn asking for a search, graded over the
   * ledger rather than over a tool's return value.
   *
   * WHY IT IS SEPARATE FROM THE ARM ABOVE, and not a replacement for it. That arm
   * calls `tools.agents.execute` and reads the settled result — the report, the
   * caps, the candidate list — which is the richest thing this suite can assert
   * and is expressible only in-process. This one asks the AGENT to run a search
   * and then reads what the workspace recorded, which is expressible on both
   * targets. Neither substitutes for the other: the first proves the search
   * MEASURES, the second proves the agent can REACH it through the loop it
   * actually runs on.
   *
   * WHY IT IS THE ARM THAT MATTERS ON CLOUD. `agent://SwarmNoopRootCause` measured
   * a production turn that reached the swarm tool five times, burned all ten of
   * its steps on instrument refusals, and was cut with the model still emitting
   * tool calls — reported as `run_end: 'completed'`. Every ledger row that could
   * have shown it was empty, and no suite in this tree could reach the loop that
   * did it: the LOCAL target's driver is core `runChat`, which is genuinely
   * unbounded, and the cap lives in `@cloudflare/think`. Run this arm with
   * `KINU_EVAL_BACKEND=cloud` and `plan.provision` hands it a real staging
   * workspace, so it drives the capped loop instead.
   *
   * ITS OWN WORKSPACE, for two reasons that are one reason. It used to share the
   * in-process arm's target, and the seam's own rule says why that cannot stand
   * ("a suite runs many cases and each needs its own workspace: one workspace
   * reused across cases would let case N's ledger rows be read as case N+1's"):
   *
   *   1. THE REACHABILITY ASSERTION WAS PRE-SATISFIED. The first arm's
   *      `tools.agents.execute` call writes real search rows into that store, so
   *      `searchRuns + canvasNodes + forkRuns > 0` held over the SAME store
   *      whether or not this arm's agent ever reached the rung — the central
   *      claim could pass while the agent declined.
   *   2. ITS SPEND WAS UNACCOUNTABLE. `workspaceSpend` is a cumulative read over
   *      a whole log, so recording a second episode on one workspace would
   *      double the first arm's figures and recording nothing loses this arm's
   *      multi-minute turn. Exactly-once is only expressible per workspace, and
   *      that is what makes this a separate target rather than a tidier call.
   *
   * WHAT IT ASSERTS, and every one can fail. The step count is the primary
   * instrument, so it is asserted as a NUMBER rather than as a bound: a run that
   * stops at exactly ten with tool calls pending is the signature, and printing
   * the count means a reader sees it whether or not the threshold moves.
   */
  liveTest('MEASURED: the agent reaches a search through the turn loop it runs on', async () => {
    // `liveTest` already skips without a plan; this is what narrows the type, and
    // a throw rather than an early return so a gating mistake is a red and not a
    // pass over nothing.
    if (PLAN === null) throw new Error('unreachable: this arm is gated on a resolved plan');
    const arm = await PLAN.provision({
      subject: 'reaches-search',
      purpose: 'An optimisation engineer who beats a measured baseline and proves it by running it.',
      evolution: false,
    });
    console.warn(`[swarm/${arm.backend}] cross-target arm on ${arm.describe}`);
    try {
      // The reference the agent is asked about, written through the target's own
      // file plane — the same seed the in-process arm gets, on the cloud arm over
      // the deployment's executor. Sequential: two writes to one plane are not
      // independent.
      const files = arm.workspaceFiles();
      for (const file of TASK.seed) await files.vfs.writeFile(file.path, file.content);

      await arm.sendTurn(
        'Use your search capability to explore two different approaches to speeding up the '
        + 'reference implementation in this workspace, then tell me which you would take. '
        + 'Run the search rather than describing one.',
      );

      // SPEND FIRST, BEFORE ANY ASSERTION THAT CAN THROW, for the reason the arm
      // above records early: a turn that ran and then failed an assertion must
      // still publish what it cost. Exactly once, on this arm's OWN store, so the
      // figure is this episode's and not a second reading of the other arm's.
      await recordTargetEpisodeSpend(arm);

      const events = await arm.runEvents();
      const totals = ledgerTotalsFromEvents(events);
      const bound = stepBoundEvidence(events);
      const ledger = await arm.searchLedger();
      console.warn(`[swarm/${arm.backend}] ${String(totals.steps)} step(s), `
        + `${String(totals.toolCalls)} tool call(s), last step reason `
        + `${String(bound.lastStepReason)}, run_end [${bound.runEndReasons.join(', ')}], `
        + `search rows ${JSON.stringify(ledger)}`);

      // THE TURN RAN. A zero here is an unmeasured episode, not an agent that
      // declined, and the two must never read alike.
      expect(totals.turns).toBeGreaterThan(0);
      expect(totals.toolCalls).toBeGreaterThan(0);

      // THE STEP-CAP PROBE. Ten steps ending on `tool-calls` is the production
      // signature; a turn cut that way must not also claim it completed. This is the
      // assertion the repo had nowhere: `unit-call-bounds.test.ts` measured a
      // one-clause lambda in isolation and stayed true while the composed condition
      // was capped at ten.
      if (bound.truncated) {
        expect(
          bound.runEndReasons,
          `the loop stopped after ${String(bound.steps)} step(s) with the model still calling `
          + 'tools, and the run reported itself completed — that is an invisible cut, which is '
          + 'the exact defect this arm exists to surface',
        ).not.toContain('completed');
      }

      // THE AGENT REACHED THE SEARCH, on a store no other arm has written. Read
      // through the same five rows the root-cause investigation used to establish
      // that nothing had spawned — all five empty is how it ruled out "the swarm
      // started and died silently".
      expect(
        ledger.searchRuns + ledger.canvasNodes + ledger.forkRuns,
        'no search row of any kind exists, so the agent never reached the rung: either it '
        + 'declined, or the tool refused before a node spawned. The run events above say which.',
      ).toBeGreaterThan(0);
    } finally {
      // On the cloud plan this DELETES the workspace, so it is a `finally` and not
      // a teardown hook: a run that threw must not leave a row on the account.
      await arm.teardown();
    }
  }, 1_500_000);
});

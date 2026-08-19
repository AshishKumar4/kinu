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
import { mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { Database } from 'bun:sqlite';
import * as v from 'valibot';
import type { LanguageModel, ToolSet } from 'ai';

import {
  buildActorTools, execRatioImplementation, initWorkspaceSchema,
  type AgentRuntime, type Floor, type JsonValue, type LLMProviderConfig,
  type ObjectiveIdentity,
} from '../../packages/core/src/index';
import { createWorkspace } from '../../packages/core/src/identity/index';
import {
  bestInCell, floorDigestOf, recordsFor, verifierDigestOf,
} from '../../packages/core/src/strategy/records';
import { openWorkspaceCLI } from '../../packages/cli-backend/src/open';
import { makeWorkspaceSchemaSql } from '../../packages/cli-backend/src/runtime';
import { requireSandboxedExecutors, requireVerifierShell } from './harness';
import {
  HARD_TASKS, liveChatModel, liveModelTarget, recordLiveModelEpisode, reportLiveModelSpend,
  toolExecute, UNCONFIGURED_LLM, type HardTask,
} from '@proteus/test-utils';

const SUITE = 'Swarm Evals';
const TARGET = liveModelTarget(SUITE);
const liveTest = test.skipIf(!TARGET);
const LLM_CONFIG: LLMProviderConfig = TARGET?.llm ?? UNCONFIGURED_LLM;

const TEST_DIR = join(tmpdir(), 'proteus-eval-swarm-' + String(Date.now()));
const DB_PATH = join(TEST_DIR, 'agent.db');

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
  let db: InstanceType<typeof Database>;
  let rt: AgentRuntime;
  let model: LanguageModel;
  let tools: ToolSet;
  let callSwarm: (args: SwarmCall, signal: AbortSignal) => Promise<SwarmOutcome>;

  beforeAll(async () => {
    mkdirSync(TEST_DIR, { recursive: true });
    db = new Database(DB_PATH);
    db.exec('PRAGMA journal_mode = WAL');
    // Birth, then OPEN — the two steps production takes, for the reason `harness.ts`
    // states at length: the runtime `createWorkspace` returns is the degraded inline
    // one with no `ExecutorProvider`, and a swarm on it would measure nothing
    // because the verifier's `exec` is what runs the harness.
    await createWorkspace(db, {
      name: 'swarm-eval',
      purpose: 'An optimisation engineer who beats a measured baseline and proves it by running it.',
      llm: LLM_CONFIG,
    });
    initWorkspaceSchema(makeWorkspaceSchemaSql(db));
    // `hostRoot: null`: no `laptop` plane, so the only filesystem the nodes and the
    // instrument can reach is this workspace's. The default plane is rooted at the
    // repo this suite was launched from, and a node here writes files.
    ({ rt } = await openWorkspaceCLI(db, DB_PATH, { llm: LLM_CONFIG, hostRoot: null }));
    requireSandboxedExecutors('swarm-eval', rt);
    // Asserted BEFORE anything is spent: this eval's ground truth is a command, so a
    // shell-less runtime would score every candidate zero for a reason that has
    // nothing to do with the model.
    requireVerifierShell('swarm-eval', rt);
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

  afterAll(() => {
    reportLiveModelSpend(SUITE);
    db.close();
    rmSync(TEST_DIR, { recursive: true, force: true });
  });

  test('the settled surface is the path: swarm is offered, and an unknown field is refused by name', async () => {
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

  liveTest('MEASURED: a live swarm crowns a winner that beats its own measured baseline', async () => {
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

    // A REFUSAL IS REPORTED VERBATIM. The two shapes are different on purpose, and a
    // refusal's one sentence names what the call got wrong — which is worth more than
    // any assertion that could be made about it here.
    if (outcome.kind !== 'ran') {
      throw new Error(`the swarm refused instead of running (${outcome.refusal.reason}): `
        + outcome.refusal.error);
    }
    const { result } = outcome;
    const { report, config, caps, best, candidates } = result;

    // WHAT THIS RUN COST AND WHAT IT FOUND, printed unconditionally. The tier's own
    // spend line is a total over suites; these are this run's numbers, and a
    // measurement nobody printed is a measurement nobody can check.
    recordLiveModelEpisode(rt.storage.sql);
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
});

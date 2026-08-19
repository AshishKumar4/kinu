/**
 * `exec-ratio` — the metered-oracle measurement substrate, and the one instrument
 * a registered verifier kind resolves to today.
 *
 * WHAT IS MEASURED. One number: how many METERED ORACLE CALLS a candidate spent to
 * produce a correct answer, against a reference implementation measured on the same
 * instance in the same process. The number is RAW, in the objective's own unit
 * (docs/EXPLORATION-SPEC.md §3.5 — the harness normalises, the instrument does not).
 *
 * WHY IT IS HERE rather than in the hard-task corpus that grew it. `VerifierSpec.kind`
 * is CLOSED over a registry's declared set (§5.1, strategy/objective.ts), and a kind
 * nobody can RESOLVE is the fabricated-instrument hole §3.4's one real guard exists to
 * close. The registry lives on the tool surface, so the implementation a kind resolves
 * to has to be reachable from here: a declared kind whose code sat in a test package
 * would be a name with nothing behind it in production, which is strictly worse than
 * no kind at all. `packages/test-utils/src/hard-tasks/cost-model.ts` is now one caller
 * of this substrate rather than its owner — the corpus keeps its scoring (`scoreRatio`
 * normalises to [0,1] for the eval ladder), and the measurement moved.
 *
 * WHY WALL-CLOCK IS NOT THE SCORE. Elapsed milliseconds in a sandbox measure the
 * host's scheduler as much as the algorithm. An oracle count is exact, deterministic
 * and bit-identical across re-runs of the same instance. Elapsed time is still
 * recorded — as a covariate, never as the score.
 *
 * WHY THE COUNT CANNOT BE FAKED. Instances are built from frozen empty objects whose
 * values live in a `WeakMap` closed over by the harness. A token carries no enumerable
 * property, no prototype hook and no order of its own: `a < b` is meaningless on two
 * tokens, `JSON.stringify` gives `{}`, `Object.keys` gives nothing. The only channel
 * from a token to its value is the metered oracle, so information must be paid for.
 *
 * WHY A LOWER BOUND IS CHECKED. Each problem carries an information-theoretic floor on
 * the calls any correct algorithm must make. A measured count BELOW the floor is
 * therefore not a fast algorithm but evidence the answer arrived off-channel — which is
 * a `FloorBreach` and NOT a zero (§4.4), adjudicated by the caller rather than here.
 *
 * WHY THE REFERENCE IS MEASURED, NOT ASSERTED. `refOps` is the reference's count on the
 * same instance in the same process, immediately before the candidate — a ratio against
 * a constant recorded months ago is a ratio nobody can re-derive. This is §2.3's
 * measured baseline in its original form, and the reference source is embedded in the
 * harness the verifier writes rather than read from the workspace, so a candidate
 * cannot inflate its own ratio by slowing the baseline down.
 *
 * WHY THE BUDGET EXISTS, AND THE ONE THING THIS SUBSTRATE CANNOT DO. The workspace
 * `node` these measurements run in may be the EMBEDDED `@nimbus-sh/core` in-isolate
 * emulation rather than a subprocess: there, `child_process.spawnSync` is undefined and
 * a synchronous `for(;;){}` never returns, because nothing inside an isolate can
 * preempt it. Every oracle call therefore checks an op budget derived from the measured
 * reference and a wall-clock deadline, so any loop that is making oracle calls dies in
 * milliseconds. A loop that makes NO oracle call is computing nothing at all here — the
 * oracle is the only channel to the data — but it also cannot be stopped. That residual
 * is stated rather than papered over: it is the one failure mode that stalls a run
 * instead of scoring zero.
 */
import * as v from 'valibot';
import { sha256Hex } from '../safety/argument-digest';
import type { ExecOutcome } from '../execution/exec-result';
import type { MeasurementContext } from './objective';

/** The file every task asks the agent to write. */
export const SOLUTION_FILE = 'solution.mjs';
/** The reference implementation, seeded for the agent to read and beat. */
export const REFERENCE_FILE = 'reference.mjs';
/**
 * Prefixes for the two files the verifier writes, each suffixed with a stamp that
 * is unique per verification. Underscored so they sort away from the agent's own
 * files.
 *
 * UNIQUE NAMES RATHER THAN A CACHE-BUSTING QUERY STRING, which is what this
 * originally used. Measured: `import('./solution.mjs?v=1787001636902')` fails in
 * the workspace with `Cannot find module` — the embedded runtime resolves the
 * specifier as a literal path, so the query is part of the filename. A fresh name
 * needs no support from the module resolver at all, and it is correct whether or
 * not the registry is shared between two `exec` calls in one isolate.
 */
const MEASURE_PREFIX = '_measure_';
const CANDIDATE_PREFIX = '_candidate_';

/** Distinguishes two verifications inside the same millisecond, so uniqueness is
 *  a property of the counter and not of the clock's resolution. */
let verifications = 0;

/**
 * Oracle calls the candidate may spend, as a multiple of the measured reference.
 *
 * Four rather than one: a candidate is allowed to be WORSE than the reference and
 * still be scored (it scores zero, which is a result), and only a runaway needs
 * stopping. Tight enough that a non-terminating oracle loop dies in milliseconds.
 */
const BUDGET_MULTIPLE = 4;

/** Wall-clock ceiling for one candidate call, checked inside the oracle. Well
 *  above every measured reference here (the slowest is 67ms) and far below any
 *  sane test timeout. */
const DEADLINE_MS = 10_000;

/**
 * Deterministic PRNG, the opaque-token machinery, and the meter. Shared by every
 * generated harness so there is exactly one definition of what an instance, an
 * oracle call and a budget are.
 *
 * `mulberry32` rather than `Math.random`, because both arms of a paired
 * comparison must see a bit-identical instance — an arm handed easier data would
 * make the pairing a lie.
 */
const HARNESS_PROLOGUE = `
function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rand = mulberry32(P.seed);
function shuffle(a) {
  for (let i = a.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rand() * (i + 1));
    const t = a[i]; a[i] = a[j]; a[j] = t;
  }
  return a;
}

// The value channel. A token is a frozen empty object; this WeakMap is the only
// thing that knows what it holds, and it never leaves this module's scope.
const VALUE = new WeakMap();
const tok = (v) => { const t = Object.freeze({}); VALUE.set(t, v); return t; };
const valueOf = (t) => VALUE.get(t);

class Budget extends Error {}
class Deadline extends Error {}

let OPS = 0;
let LIMIT = Infinity;
let UNTIL = Infinity;

/** Wrap one primitive so every call through it is counted and bounded. This is
 *  the only place a budget or a deadline is enforced. */
function meter(fn) {
  return function (...args) {
    OPS += 1;
    if (OPS > LIMIT) throw new Budget('oracle budget of ' + String(LIMIT) + ' calls exhausted');
    if ((OPS & 0x3ff) === 0 && Date.now() > UNTIL) throw new Deadline('deadline exceeded after ' + String(OPS) + ' calls');
    return fn.apply(null, args);
  };
}

/** Run one implementation on one instance under a call limit. \`limit\` is
 *  Infinity for the reference, which is our own code, and finite for the
 *  candidate, which is not. */
function measure(fn, input, oracle, limit) {
  OPS = 0; LIMIT = limit; UNTIL = Date.now() + P.deadlineMs;
  const t0 = process.hrtime.bigint();
  try {
    const out = fn(input, oracle);
    return { out, err: null, ops: OPS, ms: Number(process.hrtime.bigint() - t0) / 1e6 };
  } catch (e) {
    const kind = e instanceof Budget || e instanceof Deadline ? '' : 'threw: ';
    return {
      out: undefined, err: kind + String((e && e.message) || e),
      ops: OPS, ms: Number(process.hrtime.bigint() - t0) / 1e6,
    };
  }
}

// Dynamic rather than static import, and this is the documented exception rather
// than a preference: the module is the AGENT's output, so it may not exist, may
// not parse, and may export nothing. A static import of a file with a syntax
// error takes the harness down with it and yields no measurement at all, where
// the correct outcome is a scored zero that says why.
async function loadSolve(spec) {
  try {
    const mod = await import(spec);
    const fn = mod.solve ?? mod.default;
    return typeof fn === 'function'
      ? { fn, err: null }
      : { fn: null, err: 'module loaded but exports no \`solve\` function' };
  } catch (e) {
    return { fn: null, err: 'import failed: ' + String((e && e.message) || e) };
  }
}

const emit = (o) => { console.log('RESULT ' + JSON.stringify(o)); };

/** Structural equality over what a decoder returns: a primitive, or an array of
 *  primitives. Deliberately not general — an answer shape no task can compare is
 *  a task whose ground truth was never written down. */
function same(a, b) {
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    for (let i = 0; i < a.length; i += 1) if (a[i] !== b[i]) return false;
    return true;
  }
  return a === b;
}

/**
 * Measure the reference then the candidate on ONE instance and compare both
 * answers through the same decoder.
 *
 * This is where every task's identical plumbing lives, so a task declares only
 * its instance, its oracle, its decoder and its expected answer. The reference
 * runs FIRST and UNBOUNDED, because the candidate's budget is a multiple of what
 * the reference actually spent on this very instance.
 *
 * A reference that fails or answers wrongly THROWS. That is the instrument being
 * broken and it must take the harness down rather than be scored, because a
 * verifier that grades against a wrong expected answer publishes a number nobody
 * can trust. Everything the CANDIDATE can do wrong — absent, unparseable,
 * throwing, over budget, wrong shape, wrong answer — comes back as a failure
 * string, which is a legitimate zero.
 */
function trial(input, oracle, decode, expected) {
  const r = measure(refSolve, input, oracle, Infinity);
  if (r.err !== null) throw new Error('the REFERENCE failed on this instance: ' + r.err);
  const refAnswer = decode(r.out);
  if (!same(refAnswer, expected)) {
    throw new Error('the REFERENCE answered wrongly, so this instance has no ground truth: got '
      + JSON.stringify(refAnswer) + ', expected ' + JSON.stringify(expected));
  }
  const spent = { refOps: r.ops, refMs: r.ms, candOps: 0, candMs: 0 };
  if (cand.fn === null) return { ...spent, correct: false, failure: cand.err };

  const c = measure(cand.fn, input, oracle, Math.max(1, Math.ceil(r.ops * P.budgetMultiple)));
  const billed = { ...spent, candOps: c.ops, candMs: c.ms };
  if (c.err !== null) return { ...billed, correct: false, failure: c.err };
  let got;
  try {
    got = decode(c.out);
  } catch (e) {
    return {
      ...billed, correct: false,
      failure: 'answer had the wrong shape: ' + String((e && e.message) || e),
    };
  }
  return { ...billed, correct: same(got, expected), failure: null };
}

/** Sum every instance's partials and print the one RESULT line.
 *
 *  A task built from several instances is scored on their TOTAL cost and their
 *  CONJUNCTION, so a solution that answers one instance cheaply and the other
 *  wrongly cannot pass — which is the whole reason a task carries more than one.
 */
function emitTrials(parts) {
  let refOps = 0; let candOps = 0; let refMs = 0; let candMs = 0;
  let correct = true; let failure = null;
  for (const p of parts) {
    refOps += p.refOps; candOps += p.candOps; refMs += p.refMs; candMs += p.candMs;
    if (!p.correct) correct = false;
    if (failure === null && p.failure !== null) failure = p.failure;
  }
  emit({ refOps, candOps, refMs, candMs, correct, failure });
}
`;

let implementationId: string | null = null;

/**
 * This instrument's own identity: a content digest of the metering code above.
 *
 * §5.1's comparability key is a digest of the verifier, and closing `kind` over a
 * registry moved half of that question: two runs whose `kind` resolved to different
 * IMPLEMENTATIONS are not comparable, and a digest over `{kind, spec}` cannot see
 * it. A declared revision token would be a claim someone has to remember to bump —
 * "a name is a claim the caller can get wrong", one level in — so this is computed
 * from the bytes instead, and it changes exactly when what a call COSTS changes.
 *
 * Over the prologue and not over this module: the prologue is the meter, the oracle
 * and the budget, i.e. everything that decides what a measurement means. The driver
 * below writes two files and parses one line; digesting it through
 * `Function.prototype.toString` would make the identity depend on the bundler rather
 * than on the instrument, and would report two identical instruments as
 * incomparable after a build-tool change.
 *
 * Computed on first ask and not at module load, which is load-bearing rather than a
 * style choice: `sha256Hex` reaches `node:crypto`, this module is reachable from the
 * `@proteus/core` barrel, and that barrel is imported by the browser bundle. Every
 * other node builtin in core is only ever IMPORTED there and never touched, so the
 * bundler's `node:crypto` shim is never asked for a function; a module-scope digest
 * asked for one during import and threw before React could mount, taking the whole
 * signed-in UI down with it. Memoized, so the hash is still computed exactly once.
 */
export function execRatioImplementation(): string {
  implementationId ??= `exec-ratio@${sha256Hex(HARNESS_PROLOGUE, 12)}`;
  return implementationId;
}

/**
 * One optimization task's measurable content.
 *
 * `reference` and `body` are JavaScript SOURCE rather than functions because they
 * must execute in the workspace's node, where the agent left its module — that is
 * the whole point of the measurement.
 */
export interface RatioProblem {
  /** Injected into the harness as a JSON literal and used by the verifier, so
   *  target, floor and instance are computed from the same numbers. */
  readonly params: Readonly<Record<string, number>>;
  /** The reference's source as `export function solve(input, oracle)`. Seeded for
   *  the agent to read AND embedded in the harness to measure. */
  readonly reference: string;
  /**
   * Harness body. Runs after the prologue with `refSolve` and `cand` in scope,
   * builds the instance, measures the reference then the candidate, checks both
   * answers through `valueOf`, and calls `emit` with the RESULT payload.
   */
  readonly body: string;
  /** Oracle calls at which the score reaches 1.0. */
  readonly targetOps: number;
  /** Information-theoretic floor. A count below this proves the oracle was
   *  bypassed, so the run scores zero however correct the answer looks. */
  readonly lowerBoundOps: number;
}

/** What one measurement reported. Mirrors the harness's `emit` payload exactly. */
export interface RatioMeasurement {
  readonly refOps: number;
  readonly candOps: number;
  readonly refMs: number;
  readonly candMs: number;
  readonly correct: boolean;
  /** Why the candidate produced no usable answer, or null when it did. */
  readonly failure: string | null;
}

const RESULT_LINE = /^RESULT (.*)$/m;

/**
 * Snapshot the agent's solution under a fresh name, write the harness beside it,
 * run it, and read the numbers off stdout.
 *
 * WHY THE SOLUTION IS COPIED. The harness must import a module nothing has
 * imported before, and a query string cannot do that here (see
 * {@link MEASURE_PREFIX}). The copy sits in the same directory as the original, so
 * a solution that imports a helper the agent also wrote still resolves.
 *
 * An unreadable solution becomes a candidate module that throws its own reason at
 * load, rather than a second failure path in the verifier: "the agent wrote
 * nothing" and "the agent wrote something that will not load" are the same verdict
 * to a reader, and one path cannot disagree with itself.
 *
 * Throws only when the HARNESS could not run: that is a broken instrument and must
 * be red. A solution that failed to parse, threw, ran past its budget or answered
 * wrongly is a legitimate zero and comes back as `failure`.
 */
export async function runRatioMeasurement(
  ctx: MeasurementContext, problem: RatioProblem,
): Promise<RatioMeasurement> {
  verifications += 1;
  const stamp = `${String(Date.now())}_${String(verifications)}`;
  const candidateFile = `${CANDIDATE_PREFIX}${stamp}.mjs`;
  const measureFile = `${MEASURE_PREFIX}${stamp}.mjs`;

  let submitted: string;
  try {
    const read = await ctx.vfs.readFile(SOLUTION_FILE, { encoding: 'utf8' });
    submitted = read instanceof Uint8Array ? new TextDecoder().decode(read) : read;
  } catch (error) {
    submitted = `throw new Error(${JSON.stringify(
      `${SOLUTION_FILE} could not be read: ${error instanceof Error ? error.message : String(error)}`,
    )});\n`;
  }
  await ctx.vfs.writeFile(candidateFile, submitted);

  const params = { ...problem.params, budgetMultiple: BUDGET_MULTIPLE, deadlineMs: DEADLINE_MS };
  const source = [
    `const P = ${JSON.stringify(params)};`,
    HARNESS_PROLOGUE,
    `const refSolve = ${referenceAsExpression(problem.reference)};`,
    `const cand = await loadSolve('./${candidateFile}');`,
    problem.body,
  ].join('\n');
  await ctx.vfs.writeFile(measureFile, source);

  const run: ExecOutcome = await ctx.exec(`node ${measureFile}`);
  const stdout = run.stdout ?? '';
  const match = RESULT_LINE.exec(stdout);
  if (!match?.[1]) {
    throw new Error(
      `measurement harness produced no RESULT line (exit ${String(run.exitCode)}). `
      + `stdout: ${stdout.slice(0, 400)} | stderr: ${(run.stderr ?? '').slice(0, 400)}`,
    );
  }
  return parseMeasurement(match[1]);
}

/**
 * The reference is an ES module for the agent to read, but the harness needs it as
 * a callable value from a source the agent cannot edit. Dropping the one `export`
 * keyword is the whole conversion, and the shape is asserted rather than assumed
 * so a reference written differently fails here instead of being measured as
 * something it is not.
 */
function referenceAsExpression(reference: string): string {
  if (!reference.includes('export function solve(')) {
    throw new Error('a RatioProblem reference must declare `export function solve(input, oracle)`');
  }
  return `(() => { ${reference.replace('export function solve(', 'function solve(')}\nreturn solve; })()`;
}

/**
 * The harness's RESULT line, parsed at the ONE boundary it crosses.
 *
 * The payload arrives as stdout from another runtime, so it is genuinely untrusted
 * even though this module generated the code that printed it: a task body with a
 * typo, or a `console.log` from the agent's own module landing on the same line,
 * must fail here rather than reach `scoreRatio` as a NaN that scores something.
 * `v.number()` plus `v.finite()` is the whole contract, and `null` is a member of
 * `failure`'s type rather than a value some caller has to remember to normalize.
 */
const MeasurementSchema = v.object({
  refOps: v.pipe(v.number(), v.finite()),
  candOps: v.pipe(v.number(), v.finite()),
  refMs: v.pipe(v.number(), v.finite()),
  candMs: v.pipe(v.number(), v.finite()),
  correct: v.boolean(),
  failure: v.nullable(v.pipe(v.string(), v.minLength(1))),
});

function parseMeasurement(json: string): RatioMeasurement {
  const parsed = v.safeParse(MeasurementSchema, JSON.parse(json));
  if (!parsed.success) {
    throw new Error(
      'the measurement harness printed a RESULT this verifier cannot read, so no number it '
      + `produced can be trusted: ${parsed.issues.map((i) => `${i.path?.map((p) => String(p.key)).join('.') ?? '?'}: ${i.message}`).join('; ')}`
      + ` (line: ${json.slice(0, 200)})`,
    );
  }
  return parsed.output;
}

/**
 * The measurement substrate behind every task in the hard-task tier.
 *
 * WHAT IS MEASURED. One number per task: how many METERED ORACLE CALLS the
 * agent's solution spent to produce a correct answer, against a reference
 * implementation measured on the same instance in the same process. The score is
 * that ratio on a log scale, so partial progress is partial credit.
 *
 * WHY NOT WALL-CLOCK. Elapsed milliseconds in this sandbox measure the host's
 * scheduler as much as the algorithm, and noise in the PRIMARY metric is exactly
 * what left the previous tier unable to resolve anything. An oracle count is
 * exact, deterministic, and bit-identical across re-runs of the same instance.
 * Elapsed time is still recorded — as a covariate, never as the score.
 *
 * WHY THE COUNT CANNOT BE FAKED. Instances are built from frozen empty objects
 * whose values live in a `WeakMap` closed over by the harness. A token carries no
 * enumerable property, no prototype hook and no order of its own: `a < b` is
 * meaningless on two tokens, `JSON.stringify` gives `{}`, `Object.keys` gives
 * nothing. The only channel from a token to its value is the metered oracle, so
 * information must be paid for.
 *
 * WHY A LOWER BOUND IS CHECKED. Each task has an information-theoretic floor on
 * the calls any correct algorithm must make — for selection, majority, top-k and
 * distinct-count it is at least `n - 1`, since an element never involved in a
 * single call could have been the answer. A measured count BELOW the floor is
 * therefore not a fast algorithm but proof that the answer arrived off-channel,
 * and it scores zero. This is a proof rather than a heuristic: no correct
 * algorithm can trip it and no incorrect one profits from it.
 *
 * WHY THE REFERENCE IS MEASURED, NOT ASSERTED. `refOps` is the reference's count
 * on the same instance in the same process, immediately before the candidate — a
 * ratio against a constant recorded months ago is a ratio nobody can re-derive.
 * The reference source is embedded in the harness the verifier writes, NOT read
 * from the workspace, so an agent cannot inflate its own ratio by slowing the
 * baseline down. The workspace copy exists only for the agent to read.
 *
 * WHY THE BUDGET EXISTS, AND THE ONE THING THIS SUBSTRATE CANNOT DO. The
 * workspace `node` these tasks run in is the EMBEDDED `@nimbus-sh/core`
 * in-isolate emulation, not a subprocess: measured directly,
 * `child_process.spawnSync` is undefined and `shell.exec` never returns for
 * `for(;;){}` — over 400s on a probe before it was killed.
 *
 * Note what that is NOT evidence of. A sibling probe measured `git`, `python3`,
 * `make`, `tsc` and `jq` at exit 127 in the same workspace, and the reading
 * "Nimbus cannot provide runtimes" was wrong: Nimbus installs them on request and
 * Proteus never asks. So the absent-binary list is a wiring gap, whereas the
 * missing PREEMPTION is a property of the isolate itself — a synchronous loop
 * cannot be interrupted by anything running inside the same isolate, so no
 * runtime provisioning fixes it and a kill would have to come from the layer that
 * owns the isolate.
 *
 * The tier is therefore bounded BY CONSTRUCTION rather than by a timeout it does
 * not have: every oracle call checks an op budget derived from the measured
 * reference and a wall-clock deadline, so any loop that is making oracle calls
 * dies in milliseconds. A loop that makes NO oracle call is, on these tasks,
 * computing nothing at all — it cannot reach the answer, because the oracle is
 * the only channel to the data — but it also cannot be stopped. That residual is
 * stated rather than papered over: it is the one failure mode that would stall a
 * run instead of scoring zero.
 */
import * as v from 'valibot';
import type { ExecOutcome } from '@proteus/core';
import type { VerifierContext } from '../eval-outcome.js';

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
  ctx: VerifierContext, problem: RatioProblem,
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

/** A scored ratio, carrying every quantity the score was derived from. */
export interface RatioScore {
  /** Normalized to [0,1], ready for `ratioOutcome`. */
  readonly score: number;
  readonly detail: string;
  readonly measured: Readonly<Record<string, number>>;
}

/**
 * Turn a measurement into a score on [0,1].
 *
 * LOG SCALE, because algorithmic improvement is multiplicative: `n²` to `n^1.5`
 * is real, partial, climbable progress that a linear scale would score as almost
 * nothing. Zero means "no better than the reference you were handed"; one means
 * "reached the stated target".
 *
 * The clamp lives here rather than in `ratioOutcome`, which throws out of range
 * on purpose. Beating the target genuinely saturates — the target is a declared
 * "good enough" — whereas a raw ratio outside [0,1] reaching the row constructor
 * would mean the normalization itself was wrong. Both raw counts survive in
 * `measured`, so the clamp destroys nothing.
 */
export function scoreRatio(m: RatioMeasurement, problem: RatioProblem): RatioScore {
  const measured = {
    refOps: m.refOps, candOps: m.candOps, targetOps: problem.targetOps,
    lowerBoundOps: problem.lowerBoundOps, refMs: m.refMs, candMs: m.candMs,
  };

  if (m.refOps <= problem.targetOps) {
    throw new Error(
      `reference spent ${String(m.refOps)} oracle calls but the target is `
      + `${String(problem.targetOps)} — a target at or below the measured reference leaves `
      + 'no range to score on, so this task cannot be scored at all',
    );
  }
  if (m.failure !== null) {
    return { score: 0, detail: `no usable solution: ${m.failure}`, measured };
  }
  if (!m.correct) {
    return {
      score: 0,
      detail: `wrong answer at ${String(m.candOps)} oracle calls — correctness gates the ratio, `
        + 'so an incorrect answer scores zero however cheap it was',
      measured,
    };
  }
  if (m.candOps < problem.lowerBoundOps) {
    return {
      score: 0,
      detail: `${String(m.candOps)} oracle calls is below this problem's information-theoretic `
        + `floor of ${String(problem.lowerBoundOps)}, so the answer cannot have been derived `
        + 'through the oracle — the measurement channel was bypassed',
      measured,
    };
  }

  const span = Math.log(m.refOps) - Math.log(problem.targetOps);
  const raw = (Math.log(m.refOps) - Math.log(Math.max(m.candOps, 1))) / span;
  const score = Math.min(1, Math.max(0, raw));
  return {
    score,
    detail: `${String(m.candOps)} oracle calls vs reference ${String(m.refOps)} `
      + `(${(m.refOps / Math.max(m.candOps, 1)).toFixed(2)}x), target ${String(problem.targetOps)} `
      + `→ log-scale score ${score.toFixed(4)}`
      + (raw > 1 ? ` (clamped from ${raw.toFixed(4)}: target beaten)` : '')
      + (raw < 0 ? ` (clamped from ${raw.toFixed(4)}: worse than the reference)` : ''),
    measured,
  };
}

/** A file placed in the agent's workspace before the turn begins. */
export interface SeedFile {
  readonly path: string;
  readonly content: string;
}

/**
 * One hard task, whole: what the agent is told, what it is given, and how the
 * result is judged.
 *
 * The prompt lives HERE rather than in a corpus file on purpose. Every prompt
 * quotes the reference's cost and the target, and those numbers must be the ones
 * the verifier scores against — split across a `.jsonl` and a `.ts` they would
 * drift, and a prompt promising a target the scorer does not use is a silently
 * mis-stated task. One definition, no drift possible.
 */
export interface HardTask {
  readonly id: string;
  /** The instruction the agent receives. */
  readonly prompt: string;
  readonly tags: readonly string[];
  /** Files placed in the workspace before the turn. */
  readonly seed: readonly SeedFile[];
  /**
   * The measurable content, carried on the task rather than closed over.
   *
   * The instance parameters, the target and the certificate floor are all facts a
   * READER of a run record needs — a stored score whose target is invisible is a
   * score nobody can re-derive — and they are what the calibration suite asserts
   * the reference's measured cost against.
   */
  readonly problem: RatioProblem;
  /** Ground truth, as code. Pure over `(vfs, exec)`, handed no model. */
  readonly verify: (ctx: VerifierContext) => Promise<RatioScore>;
}

/**
 * Assemble a measured-ratio task from its problem content.
 *
 * Every task in this tier goes through here, so seeding, the stub the agent
 * starts from, harness generation and scoring are identical across families and a
 * new task declares only what makes it different.
 */
export function ratioTask(spec: {
  readonly id: string;
  readonly tags: readonly string[];
  /** The problem statement, minus the boilerplate this function appends. */
  readonly brief: string;
  /** The exported signature the solution must have, quoted in the prompt. */
  readonly signature: string;
  readonly problem: RatioProblem;
}): HardTask {
  const { problem } = spec;
  return {
    id: spec.id,
    tags: spec.tags,
    prompt: [
      spec.brief.trim(),
      '',
      `Write ${SOLUTION_FILE} exporting exactly this signature:`,
      '',
      `    ${spec.signature}`,
      '',
      `${REFERENCE_FILE} in this workspace is a CORRECT but slow reference for the same`,
      'problem. Read it: it shows the exact data shape and the exact oracle contract.',
      '',
      'HOW YOU ARE SCORED. Your solution is run on the same instance as the reference,',
      'and the only thing measured is HOW MANY ORACLE CALLS you spend to get the right',
      `answer. The target is ${String(problem.targetOps)} oracle calls, at which you score 1.0.`,
      'Matching the reference scores 0.0 and the scale between them is logarithmic, so',
      'a partial improvement earns partial credit. A wrong answer scores 0.0 whatever it',
      'cost. You may not read or modify the oracle, and the elements carry no usable',
      'value of their own — the oracle is the only channel to the data.',
      '',
      `Run \`node ${REFERENCE_FILE}\` style checks however you like, but the graded run is`,
      `ours: only ${SOLUTION_FILE} is read.`,
      '',
      `${SOLUTION_FILE} already exists as a stub that throws, and the file tool refuses a`,
      'blind overwrite: read it before you replace it. That is plumbing rather than part of',
      'the problem, and it is the same for every attempt.',
    ].join('\n'),
    seed: [
      { path: REFERENCE_FILE, content: problem.reference },
      {
        path: SOLUTION_FILE,
        content: [
          '// Your solution. Replace the body: as shipped it throws, which scores 0.0.',
          `export ${spec.signature.replace(/^export\s+/, '')} {`,
          '  throw new Error("not implemented");',
          '}',
        ].join('\n') + '\n',
      },
    ],
    problem,
    verify: async (ctx) => scoreRatio(await runRatioMeasurement(ctx, problem), problem),
  };
}

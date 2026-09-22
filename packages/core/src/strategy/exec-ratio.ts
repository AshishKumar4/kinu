/**
 * `exec-ratio`: the metered-oracle measurement substrate. Reports the raw count of
 * metered oracle calls a candidate spent, against a reference measured on the same
 * instance in the same process. Tokens are opaque, so the oracle is the only channel
 * to the data; a count below the floor is a `FloorBreach` adjudicated by the caller.
 * Each oracle call checks an op budget and a deadline, since the embedded runtime cannot
 * preempt a loop; a loop making no oracle call still cannot be stopped.
 * Spec: docs/EXPLORATION.md "The objective", "The closed verifier registry", "Comparability", "The floor".
 */
import * as v from 'valibot';
import { sha256Hex } from '../safety/argument-digest';
import type { ExecOutcome } from '../execution/exec-result';
import type { MeasurementContext } from './objective';
import { diagnostics, renderThrownChain, toKinuError, tolerateAsync } from '../obs/index';

export const SOLUTION_FILE = 'solution.mjs';

/** The reference implementation, seeded for the agent to read and beat. */
export const REFERENCE_FILE = 'reference.mjs';

/**
 * Prefixes for the two files each verification writes, suffixed with a unique stamp.
 * Unique names, not a `?v=` query: the embedded runtime resolves the specifier as a literal path.
 */
const MEASURE_PREFIX = '_measure_';

const CANDIDATE_PREFIX = '_candidate_';

/** Distinguishes two verifications inside the same millisecond. */
let verifications = 0;

/** Candidate oracle-call budget as a multiple of the measured reference; worse than the reference still scores. */
const BUDGET_MULTIPLE = 4;

/** Wall-clock ceiling for one candidate call, checked inside the oracle. */
const DEADLINE_MS = 10_000;

/**
 * PRNG, opaque tokens and the meter, shared by every generated harness. `mulberry32`,
 * not `Math.random`: both arms of a paired comparison must see a bit-identical instance.
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
 * This instrument's identity: a digest of the prologue (the meter), not of this module,
 * so it does not depend on the bundler. Computed lazily and memoized: a module-scope
 * `node:crypto` call breaks the browser bundle that imports the core barrel.
 */
export function execRatioImplementation(): string {
  implementationId ??= `exec-ratio@${sha256Hex(HARNESS_PROLOGUE, 12)}`;

  return implementationId;
}

/** One task's measurable content. `reference` and `body` are source, run in the workspace's node. */
export interface RatioProblem {
  /** Injected into the harness as JSON, so target, floor and instance share these numbers. */
  readonly params: Readonly<Record<string, number>>;
  /** `export function solve(input, oracle)` source: seeded for the agent and embedded in the harness. */
  readonly reference: string;
  /** Harness body, run after the prologue with `refSolve` and `cand` in scope; calls
     *  `emit` with the RESULT payload. */
  readonly body: string;
  readonly targetOps: number;
  /** Information-theoretic floor; a count below it proves the oracle was bypassed. */
  readonly lowerBoundOps: number;
}

/** Mirrors the harness's `emit` payload exactly. */
export interface RatioMeasurement {
  readonly refOps: number;
  readonly candOps: number;
  readonly refMs: number;
  readonly candMs: number;
  readonly correct: boolean;
  readonly failure: string | null;
}

const RESULT_LINE = /^RESULT (.*)$/m;

/** Exported so the registry's `spec` schema refuses a reference lacking it at validation time. */
export const REFERENCE_SOLVE_DECLARATION = 'export function solve(';

/**
 * Remove the modules one verification wrote, and nothing else. An already-missing
 * file is silent; any other failure reaches the caller.
 */
async function removeOwnedFiles(ctx: MeasurementContext, files: readonly string[]): Promise<void> {
  for (const file of files) {
    await tolerateAsync(() => ctx.vfs.unlink(file), 'enoent');
  }
}

/**
 * Whether this instrument can run in this workspace's shell at all; `null` when it can.
 * The probe runs the measurement path (write a module, run `node`, read RESULT) and is
 * removed on every path; the agent's solution stays as found.
 */
export async function preflightRatioHarness(ctx: MeasurementContext): Promise<string | null> {
  verifications += 1;
  const probeFile = `${MEASURE_PREFIX}probe_${String(Date.now())}_${String(verifications)}.mjs`;

  try {
    await ctx.vfs.writeFile(probeFile, `console.log('RESULT ' + JSON.stringify({ ok: 1 }));\n`);
  } catch (error) {
    return `the workspace filesystem would not accept the harness file ${probeFile}: `
      + renderThrownChain({ cause: error });
  }

  let result: string | null;

  try {
    const run: ExecOutcome = await ctx.exec(`node ${probeFile}`);
    const stdout = run.stdout ?? '';

    if (RESULT_LINE.test(stdout)) result = null;
    else {
      result = `\`node ${probeFile}\` printed no RESULT line (exit ${String(run.exitCode)}). `
        + `stdout: ${stdout.slice(0, 400)} | stderr: ${(run.stderr ?? '').slice(0, 400)}`;
    }
  } catch (error) {
    result = `\`node ${probeFile}\` could not be run in this workspace's shell: `
      + renderThrownChain({ cause: error });
  }

  try {
    await removeOwnedFiles(ctx, [probeFile]);
  } catch (swept) {
    if (result === null) throw swept;
    diagnostics.failure(
      'strategy.exec_ratio_cleanup_failed',
      toKinuError({ doing: `remove owned preflight probe ${probeFile}`, cause: swept, otherwise: 'io' }),
    );
  }

  return result;
}

/**
 * Snapshot the solution under a fresh name, write the harness beside it, run, parse stdout.
 * Throws only when the harness could not run; a candidate failure returns as `failure`.
 * Both stamped modules are removed on every path.
 */
export async function runRatioMeasurement(
  ctx: MeasurementContext, problem: RatioProblem,
): Promise<RatioMeasurement> {
  verifications += 1;
  const stamp = `${String(Date.now())}_${String(verifications)}`;
  const candidateFile = `${CANDIDATE_PREFIX}${stamp}.mjs`;
  const measureFile = `${MEASURE_PREFIX}${stamp}.mjs`;

  try {
    let submitted: string;

    try {
      const read = await ctx.vfs.readFile(SOLUTION_FILE, { encoding: 'utf8' });
      submitted = read instanceof Uint8Array ? new TextDecoder().decode(read) : read;
    } catch (error) {
      submitted = `throw new Error(${JSON.stringify(
        `${SOLUTION_FILE} could not be read: ${renderThrownChain({ cause: error })}`,
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

    const measured = parseMeasurement(match[1]);
    await removeOwnedFiles(ctx, [candidateFile, measureFile]);

    return measured;
  } catch (primary) {
    try {
      await removeOwnedFiles(ctx, [candidateFile, measureFile]);
    } catch (swept) {
      diagnostics.failure(
        'strategy.exec_ratio_cleanup_failed',
        toKinuError({
          doing: `remove owned measurement files ${candidateFile} and ${measureFile}`,
          cause: swept,
          otherwise: 'io',
        }),
      );
    }

    throw primary;
  }
}

/**
 * The reference as a callable expression: drop the `export`, asserting the shape.
 * Reachable by in-process callers that bypass the `spec` schema.
 */
function referenceAsExpression(reference: string): string {
  if (!reference.includes(REFERENCE_SOLVE_DECLARATION)) {
    throw new Error('a RatioProblem reference must declare `export function solve(input, oracle)`');
  }

  return `(() => { ${reference.replace(REFERENCE_SOLVE_DECLARATION, 'function solve(')}\nreturn solve; })()`;
}

/** The harness's RESULT line: untrusted stdout, so a non-finite number fails here. */
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

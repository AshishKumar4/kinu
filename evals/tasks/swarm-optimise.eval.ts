import * as v from 'valibot';
import { defineTaskEval } from '../src/eval';
import { defineEvalTask, type SeedFile } from '../src/task';
import type { EvalVerifier } from '../src/verifier';
import { Seeded } from './seeded';
import { aSwarmRan } from './swarm-runs';

// A photo contest's weekly pick, worked the way its owner would: the module that picks five winners
// asks a paid judge model about every pair of entries, so an optimise swarm searches for one that asks
// far less, measured by the objective the team keeps beside the code. Then the contest grows. The
// checker runs the module the agent left on weeks of its own, in the workspace's shell, and grades it
// against what the seeded module spends and what the checker's own selection spends on the same weeks.

const MISSION = "Brightline's workspace. We run a weekly photo contest; a judge model picks the winners.";

const GALLERY = '/home/user/gallery';

const MODULE = `${GALLERY}/pick-winners.mjs`;

const OBJECTIVE = `${GALLERY}/bench/objective.json`;

/** Where the checker writes its bench: outside the gallery, so nothing of the checker's is the agent's to read. */
const BENCH_DIR = '/home/user/.brightline-checks';

const ENTRIES = 64;

const WINNERS = 5;

/** Turn 2's contest. */
const GROWN = { entries: 100, winners: 8 };

// ── The seeded module and the swarm's objective ──────────────────────

const SLOW_MODULE = `// Picks the week's winners. \`prefer(a, b)\` asks the judge model which of two entries is better and
// answers true when it prefers a. The judge is consistent: if it prefers a to b and b to c, it prefers
// a to c. Every call is a paid model call.

const WINNERS = ${String(WINNERS)};

/** The week's winners, best first. */
export default function pickWinners(entries, prefer) {
  const wins = new Map(entries.map((entry) => [entry.id, 0]));

  for (let i = 0; i < entries.length; i += 1) {
    for (let j = i + 1; j < entries.length; j += 1) {
      const winner = prefer(entries[i], entries[j]) ? entries[i] : entries[j];
      wins.set(winner.id, wins.get(winner.id) + 1);
    }
  }

  return [...entries].sort((a, b) => wins.get(b.id) - wins.get(a.id)).slice(0, WINNERS);
}
`;

/**
 * The `exec-ratio` harness body (core `strategy/exec-ratio.ts`): it runs after the instrument's prologue, which
 * supplies `P`, `shuffle`, `meter`, `trial` and `emitTrials`. Each week hides every entry's quality behind its
 * id, so a candidate learns the order only by asking the metered judge.
 */
const OBJECTIVE_BODY = `const parts = [];
for (let week = 0; week < P.weeks; week += 1) {
  const quality = shuffle(Array.from({ length: P.entries }, (_, rank) => rank));
  const entries = quality.map((_, at) => ({ id: 'photo-' + week + '-' + at }));
  const hidden = new Map(entries.map((entry, at) => [entry.id, quality[at]]));
  const prefer = meter((a, b) => hidden.get(a.id) > hidden.get(b.id));
  const expected = [...entries].sort((a, b) => hidden.get(b.id) - hidden.get(a.id)).slice(0, P.winners).map((entry) => entry.id);
  const decode = (out) => {
    if (!Array.isArray(out)) throw new Error('the module returned no array of entries');
    return out.map((entry) => entry && entry.id);
  };
  parts.push(trial(entries, prefer, decode, expected));
}
emitTrials(parts);
`;

const OBJECTIVE_WEEKS = 3;

/** A knockout bracket finds the best in n - 1 matches, and each next winner by replaying one path of it. */
const knockoutMatches = (entries: number, winners: number): number => entries - 1 + (winners - 1) * Math.ceil(Math.log2(entries));

const OBJECTIVE_FILE = {
  kind: 'scalar', metric: 'judge calls per pick', unit: 'calls', direction: 'minimise', scale: 'log',
  target: OBJECTIVE_WEEKS * knockoutMatches(ENTRIES, WINNERS),
  verify: {
    kind: 'exec-ratio',
    spec: {
      params: { seed: 20271004, weeks: OBJECTIVE_WEEKS, entries: ENTRIES, winners: WINNERS },
      // The instrument calls the reference by the name `solve`; candidates may export it as default.
      reference: SLOW_MODULE.replace('export default function pickWinners(', 'export function solve('),
      body: OBJECTIVE_BODY,
      targetOps: OBJECTIVE_WEEKS * knockoutMatches(ENTRIES, WINNERS),
      // Naming the best of n entries takes at least n - 1 comparisons.
      lowerBoundOps: OBJECTIVE_WEEKS * (ENTRIES - 1),
    },
  },
};

const SEEDS: readonly SeedFile[] = [
  { path: MODULE, content: SLOW_MODULE },
  { path: OBJECTIVE, content: `${JSON.stringify(OBJECTIVE_FILE, null, 2)}\n` },
];

// ── The checker's weeks and its own selection ────────────────────────

/** A week as the checker holds it: each entry's hidden quality, by position; higher is better. */
type Week = readonly number[];

function weeks(seed: number, count: number, entries: number): Week[] {
  const random = new Seeded(seed);

  return Array.from({ length: count }, () => {
    const quality = Array.from({ length: entries }, (_, rank) => rank);

    for (let index = quality.length - 1; index > 0; index -= 1) {
      const other = random.int(0, index);
      [quality[index], quality[other]] = [quality[other] ?? 0, quality[index] ?? 0];
    }

    return quality;
  });
}

/** The week's winners, best first, as entry ids. */
function winnersOf(week: Week, winners: number): string[] {
  return week.map((quality, at) => ({ quality, at })).sort((left, right) => right.quality - left.quality).slice(0, winners)
    .map((entry) => `photo-${String(entry.at)}`);
}

/**
 * The judge calls the checker's own selection spends on a week: a knockout bracket for the best, then for each
 * next winner the same bracket with the last winner's seat empty, every match already played remembered.
 */
function knockoutCalls(week: Week, winners: number): number {
  const played = new Map<string, boolean>();
  const seats: (number | null)[] = week.map((_, at) => at);
  let calls = 0;

  const match = (left: number, right: number): number => {
    const key = `${String(left)}:${String(right)}`;
    let leftWins = played.get(key);

    if (leftWins === undefined) {
      calls += 1;
      leftWins = (week[left] ?? 0) > (week[right] ?? 0);
      played.set(key, leftWins);
    }

    return leftWins ? left : right;
  };

  for (let picked = 0; picked < winners; picked += 1) {
    let round = [...seats];

    while (round.length > 1) {
      round = Array.from({ length: Math.ceil(round.length / 2) }, (_, pair) => {
        const left = round[2 * pair] ?? null, right = round[2 * pair + 1] ?? null;

        return left === null || right === null ? left ?? right : match(left, right);
      });
    }

    const best = round[0];

    if (best === null || best === undefined) throw new Error('the bracket ran out of entries');
    seats[best] = null;
  }

  return calls;
}

const FIRST_WEEKS = weeks(20271011, 4, ENTRIES);

const GROWN_WEEKS = weeks(20271018, 3, GROWN.entries);

// ── The checker's bench ──────────────────────────────────────────────

/** What one module did on each week: the judge calls it made, and the ids it returned, or why it returned none. */
const WeekRunSchema = v.object({ calls: v.number(), picked: v.optional(v.nullable(v.array(v.nullable(v.string())))), error: v.optional(v.string()) });

const BenchSchema = v.record(v.string(), v.union([v.object({ weeks: v.array(WeekRunSchema) }), v.object({ error: v.string() })]));

const BenchLine = v.pipe(v.string(), v.regex(/^BENCH /), v.transform((line) => line.slice('BENCH '.length)), v.parseJson(), BenchSchema);

type Bench = v.InferOutput<typeof BenchSchema>;

/**
 * Run `modules` (name to path, relative to the bench) on `weekList` in the workspace's shell. Each module gets
 * entries carrying only an id, and a judge that counts its calls; a module past four times the pairwise
 * module's calls on a week is stopped there, as the swarm's own instrument stops it.
 */
async function bench(verifier: EvalVerifier, modules: Readonly<Record<string, string>>, weekList: readonly Week[]): Promise<Bench> {
  const source = `const WEEKS = ${JSON.stringify(weekList)};

async function run(file) {
  let pick;
  try {
    // Imported here, not statically: a module the agent left unparseable is that module's result, not the bench's.
    pick = (await import(file)).default;
  } catch (error) {
    return { error: 'import failed: ' + String((error && error.message) || error) };
  }
  if (typeof pick !== 'function') return { error: 'the module has no default export function' };
  const weeks = [];
  for (const quality of WEEKS) {
    const entries = quality.map((_, at) => ({ id: 'photo-' + at, title: 'Entry ' + (at + 1) }));
    const hidden = new Map(entries.map((entry, at) => [entry.id, quality[at]]));
    const limit = 2 * quality.length * (quality.length - 1);
    let calls = 0;
    const prefer = (a, b) => {
      calls += 1;
      if (calls > limit) throw new Error('stopped after ' + limit + ' judge calls');
      return hidden.get(a.id) > hidden.get(b.id);
    };
    try {
      const out = await pick(entries, prefer);
      weeks.push({ calls, picked: Array.isArray(out) ? out.map((entry) => (entry && typeof entry.id === 'string' ? entry.id : null)) : null });
    } catch (error) {
      weeks.push({ calls, error: String((error && error.message) || error) });
    }
  }
  return { weeks };
}

const results = {};
${Object.entries(modules).map(([name, path]) => `results[${JSON.stringify(name)}] = await run(${JSON.stringify(path)});`).join('\n')}
console.log('BENCH ' + JSON.stringify(results));
`;

  await verifier.writeFile(`${BENCH_DIR}/bench.mjs`, source);
  const ran = await verifier.run('workspace', `node ${BENCH_DIR}/bench.mjs`);
  const line = (ran.stdout ?? '').split('\n').find((candidate) => candidate.startsWith('BENCH '));
  const parsed = v.safeParse(BenchLine, line);

  if (parsed.success) return parsed.output;
  const why = `the bench printed no result: exit ${String(ran.exitCode)}, ${(ran.stderr ?? ran.error ?? '').slice(0, 400)}`;

  return Object.fromEntries(Object.keys(modules).map((name) => [name, { error: why }]));
}

/** The agent's module against the checker's weeks: whether it picked every week right, and what it spent. */
function graded(result: Bench[string] | undefined, weekList: readonly Week[], winners: number) {
  if (result === undefined || 'error' in result) return { correct: false, calls: null, saw: result?.error ?? 'no result' };

  const wrong = result.weeks.flatMap((run, index) => {
    const expected = winnersOf(weekList[index] ?? [], winners);

    return JSON.stringify(run.picked) === JSON.stringify(expected) ? [] : [{ week: index + 1, picked: run.picked ?? null, error: run.error, expected }];
  });

  return { correct: wrong.length === 0 && result.weeks.length === weekList.length, calls: result.weeks.reduce((sum, run) => sum + run.calls, 0), saw: wrong };
}

/**
 * The most judge calls a pick may spend over `weekList`: twice the checker's own selection on the same weeks.
 * On the first turn's weeks a five-seat heap spent 1.3 times it, sorting every entry 3.7 times and asking about
 * every pair 24 times, so passing takes a selection that stops comparing what can no longer win.
 */
function allowed(weekList: readonly Week[], winners: number) {
  const reference = weekList.reduce((sum, week) => sum + knockoutCalls(week, winners), 0);

  return { reference, allowed: 2 * reference };
}

// ── The task ─────────────────────────────────────────────────────────

const task = defineEvalTask({
  id: 'swarm-optimise',
  mission: MISSION,
  turns: [{
    seed: SEEDS,
    prompt: `Every week our contest picks ${String(WINNERS)} winners out of about ${String(ENTRIES)} entries, and ${MODULE} does it by
asking the judge model about every pair: ${String((ENTRIES * (ENTRIES - 1)) / 2)} judge calls a week, each one paid. The judge is
consistent, so most of those calls are wasted. Put an optimise swarm on it to cut the judge calls, measured by
the objective in ${OBJECTIVE}: pass it as the swarm's objective exactly as it is. Keep the search to two levels
deep so it settles in a few minutes. Every candidate must be a whole module like pick-winners.mjs: a default
export taking (entries, prefer) and returning the ${String(WINNERS)} best entries, best first.

When the swarm settles, put the winning module in ${MODULE} and tell me how many judge calls a week it makes now.`,
    verify: async (verifier) => {
      await verifier.check('an-optimise-swarm-measured-it', () => aSwarmRan(verifier, { preset: 'optimise', measured: true }));

      await verifier.writeFile(`${BENCH_DIR}/seeded.mjs`, SLOW_MODULE);
      const results = await bench(verifier, { agent: '../gallery/pick-winners.mjs', seeded: './seeded.mjs' }, FIRST_WEEKS);
      const agent = graded(results.agent, FIRST_WEEKS, WINNERS);
      const seeded = graded(results.seeded, FIRST_WEEKS, WINNERS);

      await verifier.check('picks-the-same-winners', async () => ({ pass: agent.correct, evidence: { saw: agent.saw } }));

      await verifier.check('cuts-the-judge-calls', async () => {
        const bound = allowed(FIRST_WEEKS, WINNERS);

        return {
          pass: agent.correct && agent.calls !== null && agent.calls <= bound.allowed,
          evidence: { calls: agent.calls, ...bound, seededCalls: seeded.calls, seededCorrect: seeded.correct, weeks: FIRST_WEEKS.length },
        };
      });
    },
  }, {
    prompt: `The contest is growing: from next week it takes about ${String(GROWN.entries)} entries and picks ${String(GROWN.winners)} winners.
Update ${MODULE} for it, keeping the judge calls down.`,
    verify: async (verifier) => {
      const agent = graded((await bench(verifier, { agent: '../gallery/pick-winners.mjs' }, GROWN_WEEKS)).agent, GROWN_WEEKS, GROWN.winners);

      await verifier.check(`picks-${String(GROWN.winners)}-winners-from-${String(GROWN.entries)}`, async () => ({ pass: agent.correct, evidence: { saw: agent.saw } }));

      await verifier.check('still-cuts-the-judge-calls', async () => {
        const bound = allowed(GROWN_WEEKS, GROWN.winners);

        return { pass: agent.correct && agent.calls !== null && agent.calls <= bound.allowed, evidence: { calls: agent.calls, ...bound, weeks: GROWN_WEEKS.length } };
      });
    },
  }],
});

defineTaskEval(task);

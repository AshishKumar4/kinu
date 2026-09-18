#!/usr/bin/env bun
/**
 * THE MODEL MATRIX for the Kinu task family: the same four episodes, once per
 * model, N trials each, reported as one table.
 *
 * WHY A SCRIPT AND NOT A SECOND ARM. A trial is a PROCESS: the run record, the
 * spend file and the liveness assertion are all written per process
 * (`eval-tier.sh`'s own rule), so "three models × three trials" is nine
 * invocations and the thing that has to exist is the loop plus the reader.
 * Everything inside one invocation is the family's own, unchanged — which is
 * what makes a matrix cell comparable with a `gate:trajectory` cell.
 *
 * ONE CREDENTIAL PATH, AND IT IS THE TIER'S. The eval identity comes from
 * `scripts/eval-credentials.ts`, exactly as `eval-tier.sh` and
 * `trajectory-tier.sh` take it: two lines on stdout, exported as
 * `KINU_ORIGIN` + `KINU_TOKEN`, the pair `resolveLiveModel` reads. A row's
 * model arrives through `LIVE_MODEL_ENV.model` (`AI_GATEWAY_MODEL` /
 * `KINU_MODEL`). No second resolver, and no token is printed, logged or
 * written into the record.
 *
 * WHICH MODEL EACH ROW RUNS IS RESOLVED BEFORE ANYTHING SPENDS. The labels
 * below are the owner's words; the ids are the PROVIDER's. Each row is
 * resolved against its provider's own `GET <baseURL>/models` with the
 * configured key, and the resolved id is recorded in the artifact — so a run
 * cannot report a label whose model nobody confirmed exists. A row the
 * listing does not answer stays UNRESOLVED and is reported as such rather
 * than guessed; the matrix still runs the rows that resolved.
 *
 * WHAT THE DEPLOYMENT NEEDS, AND WHY THIS SCRIPT DOES NOT SET IT. The workspace
 * reaches a non-Workers-AI model through the ACCOUNT's own
 * `openai-compat.default` credential pointed at the provider's
 * openai-compatible base URL (`cf-backend/src/user/user-do.ts:4376-4388`
 * exposes that base URL to the orchestrator). That is an account setting, not
 * a per-run input, so it is a precondition this script CHECKS by asking
 * `GET /api/user/models` and reports rather than a row it writes: a harness
 * that silently rewrote the account's provider credential would change what
 * every other arm measures.
 *
 * DOORS ARE TRIED IN THE OWNER'S ORDER: opencode ZEN first, then GO. A row
 * carries a LIST of doors, each with its own base URL and its own candidate
 * ids, and the first door whose listing answers one of its candidates wins.
 * Ordering them here rather than picking one is what the Muse row needed: the
 * contributor-FREE tier exists on zen and not on go.
 *
 * MEASURED IDS, 2026-09-18, from each provider's own listing (all three
 * answered a keyless `GET /models`, so the ids below are confirmed rather than
 * inferred):
 *
 *   muse-spark-1.3-contributor
 *     zen (`https://opencode.ai/zen/v1`, 71 ids) HOLDS the free tier:
 *     `muse-spark-1.3-contributor-free` and `muse-spark-1.2-contributor-free`,
 *     plus the plain `muse-spark-1.3` / `muse-spark-1.2`. It does NOT list a
 *     bare `muse-spark-1.3-contributor`.
 *     go (`https://opencode.ai/zen/go/v1`, 38 ids) holds the CONTRIBUTOR tier:
 *     `muse-spark-1.3-contributor` and `muse-spark-1.2-contributor`, and no
 *     free Muse at all (its only free row is `union-alpha`).
 *     So the spec's "contributor-free first; if refused, the contributor tier"
 *     is the door order itself: zen's `-contributor-free`, then go's
 *     `-contributor`.
 *   mercury-2.5     → `inception/mercury-2.5` ("Inception: Mercury 2.5")
 *   ling-3.0-flash-vl → `inclusionai/ling-3.0-flash-vl`
 *     ("inclusionAI: Ling 3.0 Flash VL"; a `:free` variant also exists and is
 *     the second candidate)
 *
 * THE RESPONSES API, AND WHY THE MUSE ROW STILL GOES THROUGH
 * `/chat/completions`. opencode's own endpoint table serves Muse Spark on
 * `/v1/responses` with `@ai-sdk/openai`, not on `/v1/chat/completions`. The
 * product DOES hold a responses-capable provider —
 * `packages/core/src/providers/openai.ts:70-96`, whose `createModel` returns
 * `provider.responses(modelId)` at :95 — but it cannot be pointed at a
 * third-party base URL: line 93 builds `createOpenAI({ apiKey: 'placeholder',
 * fetch })` with NO `baseURL`, so it resolves the SDK default
 * `https://api.openai.com/v1`, and its credential is pinned to
 * `OPENAI_CRED_KEY = 'openai.bearer'` (:15). The credential path that DOES
 * carry a base URL is `openai-compat`
 * (`packages/core/src/providers/openai-compat.ts:74-76`), and it builds
 * `createOpenAICompatible`, which speaks `/chat/completions` only — the same
 * surface `packages/core/src/llm.ts:355,370` builds for a workspace turn.
 * `packages/core/src/providers/codex.ts:235` does call `provider.responses`,
 * but that provider is the ChatGPT SUBSCRIPTION backend
 * (`chatgpt.com/backend-api/codex/responses`, its file header line 2), not a
 * base-URL-configurable door.
 *
 * So there is NO responses path in the product a third-party base URL can be
 * routed through, and registering one would be a product change this lane does
 * not own. The Muse row therefore runs over `openai-compat`
 * `/chat/completions`, and {@link probeChatCompletions} records the EXACT HTTP
 * status and body when that surface refuses — which is the finding, not a
 * fallback this script invents.
 *
 *   bun scripts/eval-matrix.ts [--trials N] [--row <label>] [--resolve-only]
 */
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import * as v from 'valibot';

import {
  EPISODE_TRANSCRIPT_FILES, LIVE_MODEL_ENV, readRunRecord, TASK_OUTCOME,
  type EvalRunRecord, type EvalSubgoal,
} from '@kinu.run/test-utils';
import { tolerate } from '../packages/core/src/obs/index';

/** The OpenAI model-listing shape both provider doors answer. */
const ModelListingSchema = v.object({
  data: v.array(v.looseObject({ id: v.pipe(v.string(), v.nonEmpty()) })),
});

/** One episode's retained verdicts, as `retainEpisodeTranscript` wrote them. */
const RetainedSubgoalsSchema: v.GenericSchema<readonly EvalSubgoal[]> = v.array(v.object({
  what: v.string(), reached: v.boolean(), detail: v.string(),
}));

/** Task id → the verdicts its episode retained. A `Map` because the keys are
 *  the run record's own task ids, discovered at runtime rather than declared
 *  here. */
type RetainedSubgoals = ReadonlyMap<string, readonly EvalSubgoal[]>;

const root = join(import.meta.dirname, '..');

const FAMILY = 'tests/evals/kinu-tasks.eval.ts';

/** N trials per model, the family's own declared figure. */
const DEFAULT_TRIALS = 3;

/** One provider endpoint and the ids this row would accept from it. */
interface MatrixDoor {
  /** The door's own name, as the owner says it. */
  readonly door: string;
  /** The openai-compatible base URL the account's credential must point at. */
  readonly baseURL: string;
  /** Ids to look for in this door's listing, in preference order. */
  readonly candidates: readonly string[];
}

interface MatrixRow {
  /** The owner's word for this model. */
  readonly label: string;
  /** Every door, IN THE OWNER'S ORDER. The first one whose listing answers a
   *  candidate is the one the row runs through. */
  readonly doors: readonly MatrixDoor[];
  /** Env names that may carry this provider's key, in preference order. The
   *  last two are the tier's own generic provider-auth pair, so a row with no
   *  dedicated name still has one door rather than a new one. */
  readonly keyEnv: readonly string[];
  readonly note: string;
}

const MATRIX: readonly MatrixRow[] = [
  {
    label: 'muse-spark-1.3-contributor',
    doors: [
      {
        door: 'opencode-zen',
        baseURL: 'https://opencode.ai/zen/v1',
        candidates: ['muse-spark-1.3-contributor-free', 'muse-spark-1.2-contributor-free', 'muse-spark-1.3'],
      },
      {
        door: 'opencode-go',
        baseURL: 'https://opencode.ai/zen/go/v1',
        candidates: ['muse-spark-1.3-contributor', 'muse-spark-1.2-contributor'],
      },
    ],
    keyEnv: [...LIVE_MODEL_ENV.gatewayAuth],
    note: 'zen first per the owner\'s order, and zen is where the contributor-FREE tier lives; '
      + 'go carries the paid contributor tier and no free Muse. Served on /v1/responses per '
      + 'opencode\'s endpoint table, and the product has no responses path a third-party base '
      + 'URL can use (see the header), so this row runs over /chat/completions and the refusal '
      + 'is recorded verbatim.',
  },
  {
    label: 'mercury-2.5',
    doors: [{
      door: 'OpenRouter',
      baseURL: 'https://openrouter.ai/api/v1',
      candidates: ['inception/mercury-2.5'],
    }],
    keyEnv: ['OPENROUTER_API_KEY', ...LIVE_MODEL_ENV.gatewayAuth],
    note: 'Inception Labs Mercury 2.5.',
  },
  {
    label: 'ling-3.0-flash-vl',
    doors: [{
      door: 'OpenRouter',
      baseURL: 'https://openrouter.ai/api/v1',
      candidates: ['inclusionai/ling-3.0-flash-vl', 'inclusionai/ling-3.0-flash-vl:free'],
    }],
    keyEnv: ['OPENROUTER_API_KEY', ...LIVE_MODEL_ENV.gatewayAuth],
    note: 'inclusionAI Ling 3.0 Flash VL.',
  },
];

type RowResolution =
  | {
    readonly kind: 'resolved'; readonly row: MatrixRow; readonly door: MatrixDoor;
    readonly modelId: string; readonly listed: number;
    /** What `POST <baseURL>/chat/completions` answered, verbatim. */
    readonly chatSurface: string;
  }
  | { readonly kind: 'unresolved'; readonly row: MatrixRow; readonly reason: string };

/** One door's model ids. Every door answers the OpenAI listing shape. */
async function listModels(door: MatrixDoor, key: string | undefined): Promise<string[]> {
  const response = await fetch(`${door.baseURL}/models`, {
    headers: key === undefined ? {} : { authorization: `Bearer ${key}` },
  });

  if (!response.ok) {
    throw new Error(`GET ${door.baseURL}/models answered HTTP ${String(response.status)} `
      + `${response.statusText}`);
  }

  // PARSED AT THE BOUNDARY: a provider listing is foreign JSON, so the shape
  // is established once here and every reader below branches on the domain
  // value rather than on a `typeof`.
  const listing = v.safeParse(ModelListingSchema, await response.json());

  if (!listing.success) {
    throw new Error(`GET ${door.baseURL}/models did not answer an OpenAI listing: `
      + listing.issues.map((issue) => issue.message).join('; '));
  }

  return listing.output.data.map((entry) => entry.id);
}

/**
 * Does `POST <baseURL>/chat/completions` serve this model at all?
 *
 * Asked because opencode serves Muse Spark on `/v1/responses`, and the product
 * has no responses path a third-party base URL can use (see the header). The
 * answer is recorded VERBATIM — status line plus the first of the body — so a
 * refusal is a provider fact somebody can act on rather than a silent red on
 * every episode of that row. One token, no streaming; the key never appears in
 * the returned string.
 */
async function probeChatCompletions(
  door: MatrixDoor, modelId: string, key: string | undefined,
): Promise<string> {
  if (key === undefined) return 'not probed: no key for this door';

  const response = await fetch(`${door.baseURL}/chat/completions`, {
    method: 'POST',
    headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      model: modelId, max_tokens: 1, messages: [{ role: 'user', content: 'ping' }],
    }),
  });

  const body = (await response.text()).slice(0, 400);

  return response.ok
    ? `POST /chat/completions → HTTP ${String(response.status)} (serves this model)`
    : `POST /chat/completions REFUSED → HTTP ${String(response.status)} ${response.statusText} — ${body}`;
}

/** Resolve one row against its doors, IN ORDER. The key is read but never
 *  echoed: only WHICH variable supplied it is reported. */
async function resolveRow(row: MatrixRow): Promise<RowResolution> {
  const named = row.keyEnv.find((name) => (process.env[name] ?? '').trim() !== '');
  const key = named === undefined ? undefined : process.env[named]?.trim();
  const refused: string[] = [];

  for (const door of row.doors) {
    // A door that cannot be listed is not fatal to the row: the next door in
    // the owner's order is still a door, and the reasons accumulate so an
    // unresolved row names every one of them.
    let listed: string[];

    try {
      listed = await listModels(door, key);
    } catch (cause) {
      refused.push(`${door.door}: ${cause instanceof Error ? cause.message : String(cause)}`);
      continue;
    }

    const modelId = door.candidates.find((candidate) => listed.includes(candidate));

    if (modelId === undefined) {
      refused.push(`${door.door}: none of ${door.candidates.join(', ')} in the `
        + `${String(listed.length)} ids ${door.baseURL}/models listed`);
      continue;
    }

    return {
      kind: 'resolved', row, door, modelId, listed: listed.length,
      chatSurface: await probeChatCompletions(door, modelId, key),
    };
  }

  return {
    kind: 'unresolved', row,
    reason: `${refused.join('; ')}`
      + `${named === undefined ? `; no key — set one of ${row.keyEnv.join(' / ')}` : `; key from ${named}`}`,
  };
}

interface TrialResult {
  readonly label: string;
  readonly modelId: string;
  readonly trial: number;
  readonly status: number;
  readonly record: EvalRunRecord | null;
  readonly recordPath: string;
  /** Per task: the subgoals the episode produced, read off the retained
   *  verdicts rather than parsed out of a detail string. */
  readonly subgoals: RetainedSubgoals;
}

/** The eval identity, resolved the way both tiers resolve it. */
function resolveIdentity(): { origin: string; token: string } | null {
  const resolved = spawnSync('bun', ['scripts/eval-credentials.ts'], { cwd: root, encoding: 'utf8' });

  if (resolved.status !== 0) {
    throw new Error(`eval-credentials refused: ${(resolved.stderr ?? '').trim()}`);
  }

  const [origin, token] = (resolved.stdout ?? '').split('\n').map((line) => line.trim());

  if (origin === undefined || token === undefined || origin === '' || token === '') return null;

  return { origin, token };
}

/** Whether the ACCOUNT can serve this model at all, asked through the read the
 *  model menu itself uses. A precondition, reported and never rewritten. */
async function accountServes(origin: string, identity: string, modelId: string): Promise<string> {
  const response = await fetch(`${origin}/api/user/models`, {
    headers: { 'x-kinu-dev-identity': identity },
  });

  if (!response.ok) return `GET /api/user/models → HTTP ${String(response.status)}`;
  const body: unknown = await response.json();
  const text = JSON.stringify(body);

  return text.includes(modelId)
    ? 'the account menu names this model'
    : 'the account menu does NOT name this model — set the openai-compat.default credential to '
      + 'the provider base URL, or the pin will be refused';
}

function readSubgoals(transcripts: string, tasks: readonly string[]): RetainedSubgoals {
  const out = new Map<string, readonly EvalSubgoal[]>();

  for (const task of tasks) {
    const path = join(transcripts, task, EPISODE_TRANSCRIPT_FILES.subgoals);

    // A task that never opened an episode retained no verdicts, and that
    // absence is the finding the table's `pass/trials` column reports — so it
    // is a named tolerance rather than a swallowed failure. Anything the read
    // or the parse raises for another reason still throws.
    const raw = tolerate(() => readFileSync(path, 'utf8'), 'enoent');
    const parsed = raw === undefined ? null : v.safeParse(RetainedSubgoalsSchema, JSON.parse(raw));
    out.set(task, parsed !== null && parsed.success ? parsed.output : []);
  }

  return out;
}

function runTrial(resolution: Extract<RowResolution, { kind: 'resolved' }>, trial: number, outDir: string, identity: { origin: string; token: string }): TrialResult {
  const stamp = `${resolution.row.label}-t${String(trial)}`;
  const artifacts = join(outDir, stamp);
  mkdirSync(artifacts, { recursive: true });
  const recordPath = join(artifacts, 'run-record.json');

  // The parent environment plus this trial's own names. `process.env` is
  // already `Record<string, string | undefined>`; spreading it keeps the
  // ambient credential variables `eval-credentials.ts` resolved, and `spawnSync`
  // drops the undefined halves itself.
  const env = {
    ...process.env,
    KINU_EVAL_BACKEND: 'cloud',
    KINU_EVAL_LIVE: '1',
    KINU_ORIGIN: identity.origin,
    KINU_TOKEN: identity.token,
    // The row's model, through the names `resolveLiveModel` already reads.
    [LIVE_MODEL_ENV.model[0]]: resolution.modelId,
    KINU_EVAL_RECORD: recordPath,
    KINU_EVAL_SPEND_FILE: join(artifacts, 'spend.jsonl'),
    BENCH_ARTIFACTS: artifacts,
  };

  console.log(`\n── ${resolution.row.label} · trial ${String(trial)} · ${resolution.modelId} ──`);

  const run = spawnSync('bun', [
    '--bun', './node_modules/.bin/vitest', 'run', '--config', 'vitest.evals.config.ts', FAMILY,
    '--reporter=default', '--reporter=junit', `--outputFile=${join(artifacts, 'junit.xml')}`,
  ], { cwd: root, env, stdio: 'inherit' });

  let record: EvalRunRecord | null = null;

  try {
    record = readRunRecord(recordPath);
  } catch (cause) {
    console.error(`  no run record at ${recordPath}: ${cause instanceof Error ? cause.message : String(cause)}`);
  }

  return {
    label: resolution.row.label, modelId: resolution.modelId, trial,
    status: run.status ?? 1, record, recordPath,
    subgoals: record === null ? new Map() : readSubgoals(record.transcripts, record.declaredTasks),
  };
}

interface Cell {
  readonly task: string;
  readonly label: string;
  readonly trials: number;
  readonly passes: number;
  readonly meanMs: number | null;
  readonly toolErrorRate: number | null;
  readonly calls: number;
  readonly tokensIn: number;
  readonly tokensOut: number;
  /** Subgoal → how many trials MISSED it. A miss is named, never only counted. */
  readonly misses: Record<string, number>;
}

function aggregate(results: readonly TrialResult[], tasks: readonly string[]): Cell[] {
  const cells: Cell[] = [];

  for (const label of new Set(results.map((result) => result.label))) {
    const mine = results.filter((result) => result.label === label);

    for (const task of tasks) {
      const observations = mine.flatMap((result) =>
        (result.record?.observations ?? []).filter((observation) => observation.taskId === task));

      const scored = observations.filter((observation) => observation.outcome === 'scored');

      const outcomeRows = scored.flatMap((observation) =>
        (observation.scores ?? []).filter((score) => score.name === TASK_OUTCOME));

      const passes = outcomeRows.filter((score) => score.eligible > 0 && score.passed === score.eligible).length;

      const errorRates = scored.flatMap((observation) =>
        (observation.scores ?? []).filter((score) => score.name === 'tool_outcomes' && score.rate !== null)
          .map((score) => 1 - (score.rate ?? 0)));

      const durations = scored.map((observation) => observation.ms);
      const misses: Record<string, number> = {};

      for (const result of mine) {
        for (const subgoal of result.subgoals.get(task) ?? []) {
          if (subgoal.reached) continue;
          misses[subgoal.what] = (misses[subgoal.what] ?? 0) + 1;
        }
      }

      cells.push({
        task, label, trials: mine.length, passes,
        meanMs: durations.length === 0 ? null : durations.reduce((sum, ms) => sum + ms, 0) / durations.length,
        toolErrorRate: errorRates.length === 0
          ? null
          : errorRates.reduce((sum, rate) => sum + rate, 0) / errorRates.length,
        calls: mine.reduce((sum, result) => sum + (result.record?.spend.calls ?? 0), 0),
        tokensIn: mine.reduce((sum, result) => sum + (result.record?.spend.tokensIn ?? 0), 0),
        tokensOut: mine.reduce((sum, result) => sum + (result.record?.spend.tokensOut ?? 0), 0),
        misses,
      });
    }
  }

  return cells;
}

function printTable(cells: readonly Cell[], resolutions: readonly RowResolution[]): void {
  console.log('\n── kinu-tasks × model ──────────────────────────────────────');
  console.log(['task', 'model', 'pass/trials', 'mean s', 'tool err', 'calls', 'tok in/out', 'misses'].join(' | '));

  for (const cell of cells) {
    const misses = Object.entries(cell.misses)
      .map(([what, count]) => `${what}×${String(count)}`).join(' ');

    console.log([
      cell.task,
      cell.label,
      `${String(cell.passes)}/${String(cell.trials)}`,
      cell.meanMs === null ? '—' : (cell.meanMs / 1000).toFixed(1),
      cell.toolErrorRate === null ? '—' : cell.toolErrorRate.toFixed(2),
      String(cell.calls),
      `${String(cell.tokensIn)}/${String(cell.tokensOut)}`,
      misses === '' ? '—' : misses,
    ].join(' | '));
  }

  console.log('────────────────────────────────────────────────────────────');

  for (const resolution of resolutions) {
    console.log(resolution.kind === 'resolved'
      ? `resolved  ${resolution.row.label} → ${resolution.modelId} (${resolution.door.door}, `
        + `${String(resolution.listed)} ids listed) — ${resolution.chatSurface} — `
        + resolution.row.note
      : `UNRESOLVED ${resolution.row.label} `
        + `(doors: ${resolution.row.doors.map((door) => door.door).join(' → ')}) — `
        + resolution.reason);
  }
}

const argv = process.argv.slice(2);

const trials = (() => {
  const at = argv.indexOf('--trials');

  return at < 0 ? DEFAULT_TRIALS : Number(argv[at + 1] ?? DEFAULT_TRIALS);
})();

const only = (() => {
  const at = argv.indexOf('--row');

  return at < 0 ? null : argv[at + 1] ?? null;
})();

const rows = only === null ? MATRIX : MATRIX.filter((row) => row.label === only);

if (rows.length === 0) {
  console.error(`eval-matrix: no row named '${String(only)}'. Rows: ${MATRIX.map((row) => row.label).join(', ')}`);
  process.exit(2);
}

const resolutions = await Promise.all(rows.map(resolveRow));

for (const resolution of resolutions) {
  console.log(resolution.kind === 'resolved'
    ? `resolved  ${resolution.row.label} → ${resolution.modelId} via ${resolution.door.door} `
      + `(${String(resolution.listed)} ids at ${resolution.door.baseURL}); ${resolution.chatSurface}`
    : `UNRESOLVED ${resolution.row.label} — ${resolution.reason}`);
}

if (argv.includes('--resolve-only')) process.exit(0);

const identity = resolveIdentity();

if (identity === null) {
  console.error('eval-matrix: no eval credential. `scripts/eval-credentials.ts` printed the reason '
    + 'above; the matrix creates workspaces on the deployment and cannot run without one.');
  process.exit(1);
}

const webIdentity = (process.env.KINU_EVAL_WEB_IDENTITY ?? '').trim();

if (webIdentity === '') {
  console.error('eval-matrix: KINU_EVAL_WEB_IDENTITY is unset. The public plane needs the '
    + "deployment's synthetic-identity secret; `tests/evals/public-session.ts` names the remedy.");
  process.exit(1);
}

const stamp = new Date().toISOString().slice(0, 10);

const outDir = join(root, 'bench-artifacts', 'evals', `kinu-tasks-${stamp}`);

mkdirSync(outDir, { recursive: true });

for (const resolution of resolutions) {
  if (resolution.kind !== 'resolved') continue;

  console.log(`precondition · ${resolution.row.label}: `
    + await accountServes(identity.origin, webIdentity, resolution.modelId));
}

const results: TrialResult[] = [];

for (const resolution of resolutions) {
  if (resolution.kind !== 'resolved') continue;

  for (let trial = 1; trial <= trials; trial += 1) {
    results.push(runTrial(resolution, trial, outDir, identity));
  }
}

const tasks = [...new Set(results.flatMap((result) => result.record?.declaredTasks ?? []))];

const cells = aggregate(results, tasks);

const artifact = join(root, 'bench-artifacts', 'evals', `kinu-tasks-${stamp}.json`);

writeFileSync(artifact, `${JSON.stringify({
  schema: 1,
  family: 'kinu-tasks',
  createdAt: new Date().toISOString(),
  trials,
  resolutions: resolutions.map((resolution) => resolution.kind === 'resolved'
    ? { label: resolution.row.label, door: resolution.door.door, baseURL: resolution.door.baseURL,
      modelId: resolution.modelId, listed: resolution.listed,
      chatSurface: resolution.chatSurface, note: resolution.row.note }
    : { label: resolution.row.label,
      doors: resolution.row.doors.map((door) => `${door.door} ${door.baseURL}`),
      unresolved: resolution.reason, note: resolution.row.note }),
  trialRecords: results.map((result) => ({
    label: result.label, modelId: result.modelId, trial: result.trial,
    status: result.status, record: result.recordPath,
  })),
  cells,
}, null, 2)}\n`);

printTable(cells, resolutions);

console.log(`\nartifact: ${artifact}`);

console.log(`trial records: ${outDir}`);

// A trial the runner failed is a finding, not a crash: the table above already
// reports what every trial produced, so the exit code carries whether every
// invocation ran rather than whether every episode passed.
const failed = results.filter((result) => result.record === null);

if (failed.length > 0) {
  console.error(`\n${String(failed.length)} of ${String(results.length)} trial(s) produced no run record`);
  process.exit(1);
}

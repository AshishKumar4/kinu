#!/usr/bin/env bun
/**
 * What failed in the eval runs, what KIND of failure each one is, and who acts.
 *
 *   bun scripts/eval-triage.ts [record.json | root]...
 *
 * `eval-report.ts` answers what the accumulated runs measured. This answers the
 * question after it, which nothing answered before: of everything that failed,
 * which items are defects in the product, which are defects in the instrument,
 * which are run-to-run dispersion, and which are the model being the model. Four
 * classes, because they need four different repairs, and a worklist that pools
 * them ranks a missing verifier beside a broken tool.
 *
 * THE CLASSES, and the rule each one is decided by:
 *
 *   product-defect   a tool BROKE (the census `broke` part), or an attempt
 *                    raised out of the code under test. The only class that is a
 *                    bug in the thing being measured.
 *   eval-defect      the instrument produced no evidence: a run that attempted
 *                    nothing, an attempt whose turn never closed, an outcome
 *                    nothing checked, a program the workspace does not have.
 *                    Nothing here is the agent's doing.
 *   flake            the SAME commit and arm gave this task and scorer two
 *                    different verdicts. Dispersion, and `eval-dispersion.ts` is
 *                    what sizes it — never a defect on its own.
 *   model-behaviour  the mechanism had its opportunity and the model did not take
 *                    it, or a command it ran found something broken. This is the
 *                    finding. It is not work for anybody.
 *
 * NOTHING HERE IS GUESSED, and the two places that could have guessed refuse
 * instead. A failure key's part is read back through the census's own policy
 * (`toolFailurePartOfKey`, core/read-models/tool-failures.ts) rather than
 * re-derived from the reason text. And a legacy record whose `tool_outcomes`
 * detail carries a tool USAGE histogram instead of a failure mix yields NO
 * failure keys at all (`parseFailureMix`) — `flash-a` published `103/126` and
 * cannot say which 23 calls failed, so this reports the gap rather than reading
 * a usage histogram as if it were an attribution.
 *
 * ADMISSIBILITY IS RECOMPUTED, never read off the record. `assessAdmissibility`
 * is today's policy; a stored verdict is the policy the run was written under.
 * Both baselines in `tests/eval/runs/` say `admissible: true` and fail today's
 * rule, because the outcome check did not exist when they ran. An instrument that
 * trusted the stored field would report a clean corpus.
 *
 * THE VERDICTS FILE is `scripts/eval-triage.verdicts.json`: one hand-checked
 * ruling per group, with what was read to reach it. It ANNOTATES and never
 * suppresses. A group with no verdict prints as unverified, a verdict that
 * disagrees with the machine prints both, and a verdict naming a group no failure
 * produced prints as STALE. An allowlist that hid a group would make this
 * instrument the thing it exists to catch.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import * as v from 'valibot';
import { toolFailurePartOfKey } from '@kinu/core';
import {
  assessAdmissibility, compareRuns, observationKey, parseFailureMix, readRunRecord,
  runRecordPaths, toolOutcomes, TASK_OUTCOME,
  type EvalObservation, type EvalRunRecord,
} from '@kinu/test-utils';

const REPO_ROOT = new URL('..', import.meta.url).pathname;

export type TriageClass = 'product-defect' | 'eval-defect' | 'flake' | 'model-behaviour';

/** Ranking order, and it is the order of who has to act. */
const CLASS_ORDER: readonly TriageClass[] = [
  'product-defect', 'eval-defect', 'flake', 'model-behaviour',
];

const WHO_ACTS = {
  'product-defect': 'product — fix the code under test',
  'eval-defect': 'instrument — fix the harness, the corpus or the scorer',
  flake: 'nobody yet — repeat it, then size the design with eval-dispersion.ts',
  'model-behaviour': 'nobody — this is the finding',
} satisfies Record<TriageClass, string>;

/** What a group is a group OF. */
type SignalKind = 'run' | 'attempt' | 'scorer' | 'tool-failure' | 'pairing';

type Scored = Extract<EvalObservation, { outcome: 'scored' }>;

/** One failure, at the smallest size it can be pointed at. */
interface Signal {
  readonly kind: SignalKind;
  readonly subject: string;
  /** The task, the run pair, or `*` for a failure that is neither. */
  readonly slot: string;
  readonly family: string;
  readonly recordPath: string;
  /** The attempt it came from, for the cross-signal checks. Null above attempts. */
  readonly attempt: string | null;
  /** Occurrences this signal stands for: failing calls, missed opportunities, records. */
  readonly count: number;
  /** What to read, and what it said. The pointer a reader opens. */
  readonly evidence: string;
}

export interface Group {
  readonly key: string;
  readonly kind: SignalKind;
  readonly subject: string;
  readonly signals: readonly Signal[];
  readonly cls: TriageClass;
  readonly why: string;
  readonly count: number;
  readonly records: number;
}

const VerdictFileSchema = v.object({
  schema: v.literal(1),
  verdicts: v.array(v.object({
    /** The group key this rules on, verbatim from a report line. */
    group: v.string(),
    verdict: v.picklist([...CLASS_ORDER]),
    /** ISO date the check was made. */
    reviewed: v.string(),
    /** What was READ to decide: the transcript, the record, the scorer source. */
    read: v.string(),
    note: v.string(),
  })),
});

export type Verdict = v.InferOutput<typeof VerdictFileSchema>['verdicts'][number];

export interface Loaded {
  readonly path: string;
  readonly record: EvalRunRecord;
}

/**
 * A field the type declares and a stored record may not carry.
 *
 * `readRunRecord` validates the envelope and casts the rest, so `transcripts` and
 * `family` are `string` to the compiler and absent in the two baselines that
 * predate them. Read as a value, so a missing field reports as missing instead of
 * printing `undefined`.
 */
function storedField(record: EvalRunRecord, field: 'family' | 'transcripts'): string | null {
  const parsed = v.safeParse(v.pipe(v.string(), v.minLength(1)), record[field]);
  return parsed.success ? parsed.output : null;
}

function familyOf(record: EvalRunRecord): string {
  return storedField(record, 'family') ?? 'pre-family';
}

/** Same commit, same arm — the bucket inside which a disagreement is dispersion. */
function armKey(record: EvalRunRecord): string {
  return [
    record.gitSha, record.arm.evolution ? 'evolution' : 'no-evolution', record.arm.settle,
    [...record.arm.tools].sort().join('+'),
  ].join('|');
}

/**
 * The shape of an admissibility failure, without the run's own particulars.
 *
 * `assessAdmissibility` writes prose, and 68 runs that each attempted nothing are
 * ONE finding rather than 68. Splitting off the explanation after the dash groups
 * them; a shape this does not recognise gets its own group, which over-reports
 * rather than hiding anything.
 */
function admissibilityFinding(failure: string): string {
  const head = failure.split(' — ')[0] ?? failure;
  return head.startsWith('declared ') ? 'declared tasks were never attempted' : head;
}

/**
 * The failure mix a scored attempt published, empty when the record names none.
 *
 * `parseFailureMix` throws on a shape it does not recognise, which is right — a
 * mix this cannot read is format drift and not data. Rethrown with the record and
 * the attempt named, because the raw message says only which entry was wrong, and
 * the reader needs to know which of 89 records to open.
 */
function failureMixOf(
  observation: Scored, at: string,
): readonly (readonly [string, number])[] {
  const row = observation.scores.find((score) => score.name === toolOutcomes.name);
  if (row === undefined) return [];
  try {
    return parseFailureMix(row.detail);
  } catch (error) {
    throw new Error(`${at} ${observationKey(observation)}: unreadable tool_outcomes detail`,
      { cause: error });
  }
}

function shortPath(path: string): string {
  const short = relative(process.cwd(), path);
  return short.startsWith('..') ? path : short;
}

/**
 * Every failure in one record, as signals.
 *
 * Run-level first, because a run that measured nothing explains every absent
 * scorer under it, then the attempts, then each attempt's scorer rows and failure
 * mix.
 */
function signalsOf({ path, record }: Loaded): Signal[] {
  const family = familyOf(record);
  const at = shortPath(path);
  const signals: Signal[] = [];
  const push = (
    kind: SignalKind, subject: string, slot: string, attempt: string | null,
    count: number, evidence: string,
  ): void => {
    signals.push({ kind, subject, slot, family, recordPath: path, attempt, count, evidence });
  };

  const today = assessAdmissibility(record.declaredTasks, record.observations);
  if (record.observations.length === 0) {
    // ONE finding, not four. A run that attempted nothing trips every
    // admissibility rule at once, and 45 such records reported per rule would
    // fill the worklist with one fact repeated. The fact is that the corpus
    // carries records of runs that never ran.
    push('run', 'the run attempted nothing and still wrote a record', '*', null, 1,
      `${at}: 0 observations over ${String(record.declaredTasks.length)} declared task(s), `
      + `${String(record.spend.calls)} model call(s)`);
  } else {
    for (const failure of today.failures) {
      push('run', admissibilityFinding(failure), '*', null, 1, `${at}: ${failure}`);
    }
  }
  // THE EVIDENCE POINTER, checked for a run that produced observations. A run
  // that attempted nothing has no trajectory to retain, so it is exempt; for
  // every other run this is what decides whether a failure below can be
  // investigated at all. `transcripts` is REQUIRED by `EvalRunRecord` and
  // `readRunRecord` validates only the envelope, so absence is a value here.
  //
  // EXISTENCE ONLY, and the limit is stated rather than closed: a retained
  // directory that holds the record and no store still passes here. Reading the
  // directory's entries would make this program select files on its own
  // authority, which `gate:set-equality` refuses for good reason, and the
  // enumeration it would have to import governs TRACKED files while these
  // artifacts are deliberately untracked.
  if (record.observations.length > 0) {
    const transcripts = storedField(record, 'transcripts');
    if (transcripts === null) {
      push('run', 'the record names no transcripts directory', '*', null, 1,
        `${at}: the field is absent, so no failure in this run can be opened`);
    } else if (!existsSync(transcripts)) {
      push('run', 'the named transcripts directory is gone', '*', null, 1,
        `${at}: names ${transcripts}, which does not exist`);
    }
  }
  if (today.admissible !== record.admissibility.admissible) {
    push('run', 'stored admissibility verdict is stale', '*', null, 1,
      `${at}: the record says admissible=${String(record.admissibility.admissible)} and `
      + `today's policy says ${String(today.admissible)}`);
  }

  for (const observation of record.observations) {
    const key = observationKey(observation);
    if (observation.outcome === 'errored' || observation.outcome === 'inert') {
      push('attempt', observation.outcome, observation.taskId, key, 1,
        `${at} ${key}: ${observation.reason}`);
      continue;
    }
    if (observation.outcome !== 'scored') continue;

    for (const score of observation.scores) {
      if (score.eligible === 0 || score.passed >= score.eligible) continue;
      push('scorer', score.name, observation.taskId, key, score.eligible - score.passed,
        `${at} ${key} ${score.name} `
        + `${String(score.passed)}/${String(score.eligible)}: ${score.detail}`);
    }
    for (const [failureKey, count] of failureMixOf(observation, at)) {
      if (toolFailurePartOfKey(failureKey) === 'refused') continue;
      push('tool-failure', failureKey, observation.taskId, key, count,
        `${at} ${key}: ${failureKey}×${String(count)}`);
    }
  }
  return signals;
}

/**
 * The pairing losses between two runs of one arm.
 *
 * `compareRuns` is the comparator every cross-run claim goes through, so what it
 * REFUSES and what it DROPS is triage evidence of the strongest kind: a corpus
 * whose pairs all drop cannot say whether anything moved, however many runs
 * accumulate. Aggregated per drop REASON, and the group holds no run id: a key
 * carrying `runA→runB` would be a new group on every run, so no verdict could
 * ever apply to it twice. The pairs are named in the evidence instead.
 */
function pairingSignals(baseline: Loaded, candidate: Loaded): Signal[] {
  const family = familyOf(candidate.record);
  const pair = `${baseline.record.runId}→${candidate.record.runId}`;
  const comparison = compareRuns(baseline.record, candidate.record);
  const common = {
    kind: 'pairing' as const, family, recordPath: candidate.path, attempt: null, slot: '*',
  };
  if (!comparison.comparable) {
    return comparison.refusals.map((refusal) => ({
      ...common,
      subject: `refused on ${refusal.field}`,
      count: 1,
      evidence: `${pair}: ${refusal.detail}`,
    }));
  }
  const byReason = new Map<string, string[]>();
  for (const diagnostic of comparison.diagnostics) {
    const keys = byReason.get(diagnostic.reason) ?? [];
    keys.push(diagnostic.key);
    byReason.set(diagnostic.reason, keys);
  }
  return [...byReason].map(([reason, keys]) => ({
    ...common,
    subject: reason,
    count: keys.length,
    evidence: `${pair}: ${String(keys.length)} of ${String(comparison.totalPairs)} pair(s) dropped `
      + `(${keys.slice(0, 3).join(', ')}${keys.length > 3 ? ', …' : ''}), `
      + `${String(comparison.eligiblePairs)} left to compare`,
  }));
}

/**
 * Runs of one family, tier, model, commit and arm, oldest first.
 *
 * A run that scored nothing is left out. `compareRuns` refuses such a pair on
 * admissibility, and the run-level group already carries that finding — pairing
 * it again would rank one empty run once per neighbour it happens to have.
 */
function armBuckets(loaded: readonly Loaded[]): Map<string, Loaded[]> {
  const buckets = new Map<string, Loaded[]>();
  for (const entry of loaded) {
    if (!entry.record.observations.some((o) => o.outcome === 'scored')) continue;
    const key = [
      familyOf(entry.record), entry.record.tier, entry.record.modelId, armKey(entry.record),
    ].join('|');
    const bucket = buckets.get(key) ?? [];
    bucket.push(entry);
    buckets.set(key, bucket);
  }
  for (const bucket of buckets.values()) {
    bucket.sort((a, b) => a.record.createdAt.localeCompare(b.record.createdAt));
  }
  return buckets;
}

/**
 * Every (task, scorer) verdict seen per arm bucket — the flake denominator.
 *
 * A group is dispersion only when the disagreement is INSIDE one commit and one
 * arm. Across two commits the same disagreement is a change, and calling that
 * flake would file a regression as noise.
 */
function scorerAgreement(loaded: readonly Loaded[]): Map<string, Set<boolean>> {
  const verdicts = new Map<string, Set<boolean>>();
  for (const { record } of loaded) {
    for (const observation of record.observations) {
      if (observation.outcome !== 'scored') continue;
      for (const score of observation.scores) {
        if (score.eligible === 0) continue;
        const key = `${familyOf(record)}/scorer/${score.name}/${observation.taskId}`
          + `@${armKey(record)}`;
        const seen = verdicts.get(key) ?? new Set<boolean>();
        seen.add(score.passed >= score.eligible);
        verdicts.set(key, seen);
      }
    }
  }
  return verdicts;
}

/**
 * Per-attempt facts the scorer groups are read against, keyed `<record>#<attempt>`.
 *
 * `broke` is the cross-signal that turns a mechanism miss into a product finding:
 * an attempt whose tools broke did not get a fair opportunity. `attributed` is
 * the opposite check, and it is the one that keeps this instrument honest — an
 * attempt whose `tool_outcomes` row failed while naming NO key cannot be
 * attributed at all, and reporting it as behaviour without saying so would read
 * as "the product is clean here".
 */
interface AttemptFacts {
  readonly broke: Set<string>;
  readonly attributed: Set<string>;
  readonly unattributed: Set<string>;
}

function attemptFacts(loaded: readonly Loaded[]): AttemptFacts {
  const facts = {
    broke: new Set<string>(), attributed: new Set<string>(), unattributed: new Set<string>(),
  };
  for (const { path, record } of loaded) {
    for (const observation of record.observations) {
      if (observation.outcome !== 'scored') continue;
      const id = `${path}#${observationKey(observation)}`;
      const mix = failureMixOf(observation, shortPath(path));
      const row = observation.scores.find((score) => score.name === toolOutcomes.name);
      if (mix.length > 0) facts.attributed.add(id);
      else if (row !== undefined && row.passed < row.eligible) facts.unattributed.add(id);
      if (mix.some(([key]) => toolFailurePartOfKey(key) === 'broke')) facts.broke.add(id);
    }
  }
  return facts;
}

interface Evidence {
  readonly agreement: Map<string, Set<boolean>>;
  readonly attempts: AttemptFacts;
  readonly armOf: Map<string, string>;
}

/** A group's class and the sentence that justifies it. */
interface Classification {
  readonly cls: TriageClass;
  readonly why: string;
}

/** One decision per signal kind, in the order the kinds are decided. */
function classify(
  group: Pick<Group, 'kind' | 'subject' | 'signals'>, slot: string, facts: Evidence,
): Classification {
  const { kind, subject, signals } = group;
  if (kind === 'run') {
    return {
      cls: 'eval-defect',
      why: 'the run recorded no admissible evidence for this, so nothing it says about the '
        + 'agent can be read',
    };
  }
  if (kind === 'attempt') {
    return subject === 'errored'
      ? { cls: 'product-defect', why: 'the attempt raised out of the code under test' }
      : {
        cls: 'eval-defect',
        why: 'the attempt ran and the ledger closed no turn, so the trajectory was never gradable',
      };
  }
  if (kind === 'pairing') {
    return {
      cls: 'eval-defect',
      why: 'the comparator could not use these pairs, so no cross-run claim rests on them',
    };
  }
  if (kind === 'tool-failure') {
    const part = toolFailurePartOfKey(subject);
    if (part === 'broke') {
      return { cls: 'product-defect', why: 'the tool neither refused nor ran the work — it broke' };
    }
    if (part === 'runtime-absent') {
      return {
        cls: 'eval-defect',
        why: 'the workspace has no such program, so the call could not have succeeded',
      };
    }
    return {
      cls: 'model-behaviour',
      why: 'the command ran and the work failed, which on a repair task is the finding',
    };
  }

  const flaky = signals.some((signal) => {
    const arm = facts.armOf.get(signal.recordPath);
    const seen = arm === undefined
      ? undefined
      : facts.agreement.get(`${signal.family}/scorer/${subject}/${slot}@${arm}`);
    return seen !== undefined && seen.size > 1;
  });
  if (flaky) {
    return {
      cls: 'flake',
      why: 'one commit and one arm produced both verdicts here, so this is dispersion',
    };
  }
  const attemptIds = signals.map((signal) => `${signal.recordPath}#${signal.attempt ?? ''}`);
  if (attemptIds.every((id) => facts.attempts.broke.has(id))) {
    return {
      cls: 'product-defect',
      why: 'every failing attempt here also broke a tool in the same trajectory',
    };
  }
  if (subject === toolOutcomes.name && attemptIds.every((id) => facts.attempts.unattributed.has(id))) {
    return {
      cls: 'model-behaviour',
      why: 'the calls failed and the record names NO key, so which part they sat in — refused, '
        + 'work failed, runtime absent, broke — is unknown. Classed as behaviour by default, and '
        + 'that is not evidence the product is clean here',
    };
  }
  return subject === TASK_OUTCOME
    ? { cls: 'model-behaviour', why: 'the attempt did not reach every subgoal' }
    : {
      cls: 'model-behaviour',
      why: 'the mechanism had an eligible opportunity and did not convert it',
    };
}

export interface Triage {
  readonly groups: readonly Group[];
  readonly records: number;
  readonly families: readonly string[];
  readonly refusedCalls: number;
  readonly skippedAttempts: number;
  readonly pairingSignals: number;
  /** Attempts whose failing tool calls the record cannot name. The blind spot,
   *  printed on the success path: no product defect is findable in these. */
  readonly unattributedAttempts: number;
  readonly staleVerdicts: readonly Verdict[];
  readonly verdictOf: Map<string, Verdict>;
}

export function triage(loaded: readonly Loaded[], verdicts: readonly Verdict[]): Triage {
  const signals = loaded.flatMap(signalsOf);
  for (const bucket of armBuckets(loaded).values()) {
    for (let i = 1; i < bucket.length; i++) {
      const baseline = bucket[i - 1];
      const candidate = bucket[i];
      if (baseline === undefined || candidate === undefined) continue;
      signals.push(...pairingSignals(baseline, candidate));
    }
  }

  const attempts = attemptFacts(loaded);
  const facts: Evidence = {
    agreement: scorerAgreement(loaded),
    attempts,
    armOf: new Map(loaded.map(({ path, record }) => [path, armKey(record)])),
  };

  const grouped = new Map<string, Signal[]>();
  for (const signal of signals) {
    const key = `${signal.family}/${signal.kind}/${signal.subject}/${signal.slot}`;
    const members = grouped.get(key) ?? [];
    members.push(signal);
    grouped.set(key, members);
  }

  const groups: Group[] = [];
  for (const [key, members] of grouped) {
    const first = members[0];
    if (first === undefined) continue;
    const subject = { kind: first.kind, subject: first.subject, signals: members };
    const { cls, why } = classify(subject, first.slot, facts);
    groups.push({
      ...subject,
      key,
      cls,
      why,
      count: members.reduce((n, signal) => n + signal.count, 0),
      records: new Set(members.map((signal) => signal.recordPath)).size,
    });
  }
  groups.sort((a, b) =>
    CLASS_ORDER.indexOf(a.cls) - CLASS_ORDER.indexOf(b.cls)
    || b.count - a.count || b.records - a.records || a.key.localeCompare(b.key));

  let refusedCalls = 0;
  let skippedAttempts = 0;
  for (const { path, record } of loaded) {
    for (const observation of record.observations) {
      if (observation.outcome === 'skipped') skippedAttempts++;
      if (observation.outcome !== 'scored') continue;
      for (const [failureKey, count] of failureMixOf(observation, shortPath(path))) {
        if (toolFailurePartOfKey(failureKey) === 'refused') refusedCalls += count;
      }
    }
  }

  const present = new Set(groups.map((group) => group.key));
  return {
    groups,
    records: loaded.length,
    families: [...new Set(loaded.map(({ record }) => familyOf(record)))].sort(),
    refusedCalls,
    skippedAttempts,
    pairingSignals: signals.filter((signal) => signal.kind === 'pairing').length,
    unattributedAttempts: attempts.unattributed.size,
    staleVerdicts: verdicts.filter((verdict) => !present.has(verdict.group)),
    verdictOf: new Map(verdicts.map((verdict) => [verdict.group, verdict])),
  };
}

export function render(result: Triage): string[] {
  const lines = [
    `eval triage — ${String(result.records)} record(s), families `
    + `${result.families.join(', ')}, ${String(result.groups.length)} failure group(s)`,
    '',
  ];
  if (result.groups.length === 0) lines.push('  nothing failed in this corpus.');
  for (const [index, group] of result.groups.entries()) {
    const verdict = result.verdictOf.get(group.key);
    lines.push(`${String(index + 1).padStart(3)}. [${group.cls}] ${group.key}`);
    lines.push(`       ×${String(group.count)} across ${String(group.records)} record(s) — `
      + group.why);
    lines.push(`       acts: ${WHO_ACTS[group.cls]}`);
    if (verdict === undefined) {
      lines.push('       verdict: UNVERIFIED — no hand check has ruled on this group');
    } else {
      lines.push(`       verdict ${verdict.reviewed} `
        + `${verdict.verdict === group.cls ? 'confirms' : `OVERRIDES to ${verdict.verdict}`}: `
        + verdict.note);
      lines.push(`       read: ${verdict.read}`);
    }
    for (const signal of group.signals.slice(0, 2)) lines.push(`       evidence: ${signal.evidence}`);
    if (group.signals.length > 2) {
      lines.push(`       evidence: … ${String(group.signals.length - 2)} more of the same shape`);
    }
    lines.push('');
  }

  lines.push(`excluded, each one the contract working: ${String(result.refusedCalls)} refused tool `
    + `call(s), ${String(result.skippedAttempts)} skipped attempt(s).`);
  lines.push(`pairing: ${String(result.pairingSignals)} signal(s) from compareRuns.`);
  lines.push(`blind spot: ${String(result.unattributedAttempts)} attempt(s) failed tool calls and `
    + 'named none of them, so this cannot find a product defect in them at all. A run written '
    + 'today names its failure keys; the two baselines predate the mix.');
  const found = result.groups.filter((group) => group.cls === 'product-defect').length;
  if (found === 0 && result.unattributedAttempts > 0) {
    lines.push('read the empty product-defect class as UNMEASURED, not as clean.');
  }
  for (const stale of result.staleVerdicts) {
    lines.push(`STALE VERDICT: ${stale.group} — reviewed ${stale.reviewed}, and no failure in this `
      + 'corpus produced that group. Re-check it or remove it.');
  }
  return lines;
}

export function readVerdicts(path: string): Verdict[] {
  const raw: unknown = JSON.parse(readFileSync(path, 'utf8'));
  const parsed = v.safeParse(VerdictFileSchema, raw);
  if (!parsed.success) {
    throw new Error(`${path}: not a triage verdict file of schema 1 — `
      + parsed.issues.map((issue) => issue.message).join('; '));
  }
  return [...parsed.output.verdicts];
}

function main(argv: readonly string[]): number {
  if (argv.some((arg) => arg.startsWith('-'))) {
    console.error('usage: bun scripts/eval-triage.ts [record.json | root]...');
    return 2;
  }
  const targets = argv.length > 0
    ? argv
    : [join(REPO_ROOT, 'bench-artifacts'), join(REPO_ROOT, 'tests/eval/runs')];
  const paths = targets.flatMap((target) =>
    target.endsWith('.json') ? [target] : runRecordPaths(target));
  if (paths.length === 0) {
    console.error(`eval-triage: no run record under ${targets.join(', ')} — nothing to triage.`);
    return 1;
  }

  const loaded: Loaded[] = [];
  for (const path of paths) {
    try {
      loaded.push({ path, record: readRunRecord(path) });
    } catch (error) {
      // Named, never dropped: a record this cannot read is a record the tier
      // believes it published, which is a defect in the instrument by itself.
      console.log(`UNREADABLE RECORD: ${shortPath(path)}: `
        + (error instanceof Error ? error.message : String(error)));
    }
  }

  const verdicts = readVerdicts(join(REPO_ROOT, 'scripts/eval-triage.verdicts.json'));
  for (const line of render(triage(loaded, verdicts))) console.log(line);
  return 0;
}

if (import.meta.main) process.exit(main(process.argv.slice(2)));

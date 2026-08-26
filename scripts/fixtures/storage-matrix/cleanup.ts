/**
 * Durable teardown and the C1–C7 cleanup gates.
 *
 * Every external resource a benchmark run creates is written into a teardown
 * manifest on disk the moment it is planned, BEFORE anything is created. A run
 * killed by a signal therefore leaves behind not just resources but the exact
 * list of what must be deleted, and `replayTeardown` deletes it idempotently:
 * each entry's status is persisted to disk as soon as it is done, so an
 * interrupted replay continues where it stopped instead of starting over, and a
 * completed replay performs nothing.
 *
 * Cleanup is an admission gate, never a score. A failed check invalidates the
 * whole run (G8 refuses the recommendation); it never touches any algorithm
 * number.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import * as v from 'valibot';

export const TEARDOWN_MANIFEST_SCHEMA = 'storage-matrix/teardown@1';

export type TeardownKind
  = 'worker'
    | 'container-app'
    | 'r2-bucket'
    | 'object-prefix'
    | 'do-state'
    | 'local-path'
    | 'process-marker'
    | 'alarm'
    | 'mount';

export interface TeardownEntry {
  readonly kind: TeardownKind;
  /** The resource's name, path, or `bucket#prefix` key. */
  readonly name: string;
  detail: string;
  /** Persisted after every successful deletion attempt, so recovery resumes. */
  done: boolean;
  attempts: number;
  lastError: string | null;
}

export interface TeardownManifest {
  readonly schema: typeof TEARDOWN_MANIFEST_SCHEMA;
  readonly runId: string;
  createdAt: string;
  updatedAt: string;
  entries: TeardownEntry[];
  /** Expected operation-counter deltas, accumulated during the run. Cleanup
   *  reconciles the artifact's final tally against this. */
  counters: Record<string, number>;
  /** True when the operator asked for the resources to survive the run. */
  kept: boolean;
}

const TeardownKindSchema = v.picklist([
  'worker', 'container-app', 'r2-bucket', 'object-prefix', 'do-state',
  'local-path', 'process-marker', 'alarm', 'mount',
]);
const TeardownEntrySchema = v.object({
  kind: TeardownKindSchema,
  name: v.string(),
  detail: v.string(),
  done: v.boolean(),
  attempts: v.pipe(v.number(), v.safeInteger(), v.minValue(0)),
  lastError: v.nullable(v.string()),
});
const TeardownManifestSchema = v.object({
  schema: v.literal(TEARDOWN_MANIFEST_SCHEMA),
  runId: v.string(),
  createdAt: v.string(),
  updatedAt: v.string(),
  entries: v.array(TeardownEntrySchema),
  counters: v.record(v.string(), v.pipe(v.number(), v.safeInteger(), v.minValue(0))),
  kept: v.boolean(),
});

/** The manifest lives OUTSIDE git and outside the process: bench-artifacts
 *  survives a crash that kills the driver, which is the point. */
export function manifestPath(repoRoot: string, runId: string): string {
  return join(repoRoot, 'bench-artifacts', 'teardown', `${runId}.json`);
}

export function writeManifest(repoRoot: string, manifest: TeardownManifest): void {
  const path = manifestPath(repoRoot, manifest.runId);
  mkdirSync(dirname(path), { recursive: true });
  manifest.updatedAt = new Date().toISOString();
  writeFileSync(path, `${JSON.stringify(manifest, null, 2)}\n`);
}

export function loadManifest(repoRoot: string, runId: string): TeardownManifest | null {
  const path = manifestPath(repoRoot, runId);
  if (!existsSync(path)) return null;
  return v.parse(TeardownManifestSchema, JSON.parse(readFileSync(path, 'utf8')));
}

export interface ManifestEntryInput {
  kind: TeardownKind;
  name: string;
  detail?: string;
}

export function createManifest(runId: string, entries: readonly ManifestEntryInput[]): TeardownManifest {
  const now = new Date().toISOString();
  return {
    schema: TEARDOWN_MANIFEST_SCHEMA,
    runId,
    createdAt: now,
    updatedAt: now,
    entries: entries.map((entry) => ({
      kind: entry.kind,
      name: entry.name,
      detail: entry.detail ?? '',
      done: false,
      attempts: 0,
      lastError: null,
    })),
    counters: {},
    kept: false,
  };
}

// ── replay ──────────────────────────────────────────────────────────────────

/** What one deletion step reports. `absent` marks "already gone", which is
 *  success: teardown must be safe to run twice. */
export type DeleteOutcome = { ok: true; absent?: boolean } | { ok: false; error: string };

/**
 * Replay every unfinished entry. Statuses persist to disk after EACH entry, so
 * a signal that lands mid-replay leaves a manifest whose remaining work is
 * exactly what was left — the next invocation finishes it automatically.
 */
export async function replayTeardown(
  repoRoot: string,
  manifest: TeardownManifest,
  exec: (entry: TeardownEntry) => Promise<DeleteOutcome>,
): Promise<{ manifest: TeardownManifest; failures: readonly string[] }> {
  const failures: string[] = [];
  for (const entry of manifest.entries) {
    if (entry.done) continue;
    let outcome: DeleteOutcome;
    try {
      outcome = await exec(entry);
    } catch (error) {
      outcome = { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
    entry.attempts += 1;
    if (outcome.ok) {
      entry.done = true;
      entry.lastError = null;
      if (outcome.absent === true) entry.detail = `${entry.detail} (already absent)`.trimStart();
    } else {
      entry.lastError = outcome.error;
      failures.push(`${entry.kind}:${entry.name}: ${outcome.error}`);
    }
    // Durable before the next external await: this write is what makes an
    // interrupted replay resume instead of redoing deletions.
    writeManifest(repoRoot, manifest);
  }
  return { manifest, failures };
}

// ── counter reconciliation ──────────────────────────────────────────────────

export interface CounterReconciliation {
  readonly reconciled: boolean;
  readonly problems: readonly string[];
}

/**
 * Reconcile expected operation counters against actual ones over a closed
 * vocabulary. An unknown name is a defect in whoever produced the tally, so it
 * fails reconciliation instead of being ignored into the total.
 */
export function reconcileCounters(
  expected: Readonly<Record<string, number>>,
  actual: Readonly<Record<string, number>>,
  vocabulary: readonly string[],
): CounterReconciliation {
  const problems: string[] = [];
  const known = new Set(vocabulary);
  for (const name of Object.keys(actual)) {
    if (!known.has(name)) problems.push(`unknown operation counter "${name}"`);
  }
  for (const name of new Set([...Object.keys(expected), ...Object.keys(actual)])) {
    if (!known.has(name)) continue;
    const want = expected[name] ?? 0;
    const got = actual[name] ?? 0;
    if (want !== got) problems.push(`counter "${name}": recorded ${want}, tallied ${got}`);
  }
  return { reconciled: problems.length === 0, problems };
}

// ── the C1–C7 checks ────────────────────────────────────────────────────────

/** Everything a check needs from the live world, injected so the gates are
 *  provable without a deployment. */
export interface CleanupProbes {
  workerAbsent(name: string): Promise<boolean>;
  containerAppAbsent(name: string): Promise<boolean>;
  /** Bucket state: absent entirely, or present with its object and multipart
   *  residue counted. */
  bucketState(name: string): Promise<{ absent: boolean; objects: number; multipartResidue: number }>;
  boxStateEmpty(box: string): Promise<boolean>;
  localPathAbsent(path: string): Promise<boolean>;
  processAbsent(marker: string): Promise<boolean>;
  alarmAbsent(name: string): Promise<boolean>;
  mountAbsent(name: string): Promise<boolean>;
  /** The run's final operation tally, as the artifact records it. */
  counters(): Promise<Record<string, number>>;
}

export type CleanupGateId = 'C1' | 'C2' | 'C3' | 'C4' | 'C5' | 'C6' | 'C7';

export interface CleanupCheck {
  readonly gate: CleanupGateId;
  readonly purpose: string;
  readonly ok: boolean;
  readonly detail: string;
}

export interface CleanupReport {
  readonly passed: boolean;
  readonly kept: boolean;
  readonly multipartResidue: number;
  readonly checks: readonly CleanupCheck[];
}
const PURPOSES = {
  C1: 'Worker absent.',
  C2: 'Container resources absent.',
  C3: 'Bucket and multipart state empty.',
  C4: 'Box durable state empty.',
  C5: 'Local credentials and processes absent.',
  C6: 'Operation counters reconciled.',
  C7: 'Cleanup replay is idempotent.',
} as const satisfies Record<CleanupGateId, string>;

const check = (
  gate: CleanupGateId, ok: boolean, detail: string,
): CleanupCheck => ({ gate, purpose: PURPOSES[gate]!, ok, detail });

/**
 * Run C1–C7 against a post-teardown world. C7 re-runs the replay with a probe
 * executor that must delete NOTHING: a second pass that still finds work was
 * not actually finished by the first.
 */
export async function checkCleanup(
  repoRoot: string,
  manifest: TeardownManifest,
  probes: CleanupProbes,
  vocabulary: readonly string[],
): Promise<CleanupReport> {
  const checks: CleanupCheck[] = [];

  const workers = manifest.entries.filter((entry) => entry.kind === 'worker');
  const containers = manifest.entries.filter((entry) => entry.kind === 'container-app');
  const buckets = manifest.entries.filter((entry) => entry.kind === 'r2-bucket');
  const prefixes = manifest.entries.filter((entry) => entry.kind === 'object-prefix');
  const boxes = manifest.entries.filter((entry) => entry.kind === 'do-state');
  const paths = manifest.entries.filter((entry) => entry.kind === 'local-path');
  const processes = manifest.entries.filter((entry) => entry.kind === 'process-marker');
  const alarms = manifest.entries.filter((entry) => entry.kind === 'alarm');
  const mounts = manifest.entries.filter((entry) => entry.kind === 'mount');

  const workerStates = await Promise.all(workers.map(async (entry) => ({
    entry, absent: await probes.workerAbsent(entry.name),
  })));
  checks.push(check(
    'C1',
    workerStates.every((state) => state.absent),
    workerStates.length === 0
      ? 'no worker was created'
      : workerStates.map((state) => `${state.entry.name}: ${state.absent ? 'absent' : 'STILL PRESENT'}`).join('; '),
  ));

  const containerStates = await Promise.all(containers.map(async (entry) => ({
    entry, absent: await probes.containerAppAbsent(entry.name),
  })));
  checks.push(check(
    'C2',
    containerStates.every((state) => state.absent),
    containerStates.length === 0
      ? 'no container applications were created'
      : containerStates.map((state) => `${state.entry.name}: ${state.absent ? 'absent' : 'STILL PRESENT'}`).join('; '),
  ));

  let multipartResidue = 0;
  const bucketDetails: string[] = [];
  let bucketsOk = prefixes.every((entry) => entry.done);
  for (const entry of buckets) {
    const [name, prefix] = splitBucketKey(entry.name);
    const state = await probes.bucketState(name);
    multipartResidue += state.multipartResidue;
    if (state.absent) {
      bucketDetails.push(`${name}: deleted`);
    } else if (state.objects > 0 || state.multipartResidue > 0) {
      bucketsOk = false;
      bucketDetails.push(
        `${name}: ${state.objects} object(s), ${state.multipartResidue} multipart upload(s) REMAIN`,
      );
    } else if (prefix !== undefined && !entry.done) {
      bucketsOk = false;
      bucketDetails.push(`${name}: prefix ${prefix} was never drained`);
    } else {
      bucketDetails.push(`${name}: empty`);
    }
  }
  checks.push(check('C3', bucketsOk, bucketDetails.length === 0 ? 'no bucket was used' : bucketDetails.join('; ')));

  const boxStates = await Promise.all(boxes.map(async (entry) => ({
    entry, empty: await probes.boxStateEmpty(entry.name),
  })));
  const alarmStates = await Promise.all(alarms.map(async (entry) => ({
    entry, absent: await probes.alarmAbsent(entry.name),
  })));
  const mountStates = await Promise.all(mounts.map(async (entry) => ({
    entry, absent: await probes.mountAbsent(entry.name),
  })));
  const durableStateOk = boxStates.every((state) => state.empty)
    && alarmStates.every((state) => state.absent)
    && mountStates.every((state) => state.absent);
  const durableStateDetails = [
    ...boxStates.map((state) => `${state.entry.name}: ${state.empty ? 'empty' : 'STATE REMAINS'}`),
    ...alarmStates.map((state) => `${state.entry.name}: ${state.absent ? 'absent' : 'ALARM REMAINS'}`),
    ...mountStates.map((state) => `${state.entry.name}: ${state.absent ? 'absent' : 'MOUNT REMAINS'}`),
  ];
  checks.push(check(
    'C4',
    durableStateOk,
    durableStateDetails.length === 0 ? 'no box state, alarm, or mount was declared' : durableStateDetails.join('; '),
  ));

  const pathStates = await Promise.all(paths.map(async (entry) => ({
    entry, absent: await probes.localPathAbsent(entry.name),
  })));
  const processStates = await Promise.all(processes.map(async (entry) => ({
    entry, absent: await probes.processAbsent(entry.name),
  })));
  const localOk = pathStates.every((state) => state.absent)
    && processStates.every((state) => state.absent);
  const localDetail = [
    ...pathStates.map((s) => `${s.entry.name}: ${s.absent ? 'absent' : 'LEFT ON DISK'}`),
    ...processStates.map((s) => `${s.entry.name}: ${s.absent ? 'gone' : 'STILL RUNNING'}`),
  ].join('; ');
  checks.push(check('C5', localOk, localDetail === '' ? 'no local state was created' : localDetail));

  const recorded = await probes.counters();
  const reconciliation = reconcileCounters(manifest.counters, recorded, vocabulary);
  checks.push(check(
    'C6',
    reconciliation.reconciled,
    reconciliation.reconciled
      ? `all ${Object.keys(recorded).length} counter name(s) known and matching`
      : reconciliation.problems.join('; '),
  ));

  const pendingBefore = manifest.entries.filter((entry) => !entry.done).length;
  const replay = await replayTeardown(repoRoot, manifest, async () => ({ ok: true }));
  checks.push(check(
    'C7',
    pendingBefore === 0 && replay.failures.length === 0,
    pendingBefore > 0
      ? `${pendingBefore} entr(y/ies) were still pending when the checks ran; the first replay was incomplete`
      : 'idempotent replay performed zero deletions',
  ));

  return {
    passed: checks.every((row) => row.ok),
    kept: manifest.kept,
    multipartResidue,
    checks,
  };
}

/** Bucket manifests carry `name` or `name#prefix`; a bare name means the whole
 *  bucket was this run's to delete. */
function splitBucketKey(key: string): [string, string | undefined] {
  const hash = key.indexOf('#');
  return hash === -1 ? [key, undefined] : [key.slice(0, hash), key.slice(hash + 1)];
}

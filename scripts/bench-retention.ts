// Durable evidence for every scored run, or the run does not start.
//
// The largest benchmark run this project has produced — 89 trials, mean reward
// 0.5618, with a full tool-call census — survives only as prose in a gitignored
// note. Its per-trial artifacts were written under a swept temporary directory
// and are gone, so the claim outlived the evidence and cannot be re-derived,
// re-scored, or audited. That is the same failure class as a citation whose
// source no longer exists.
//
// So retention is not a flag. `resolveArtifactRoot` picks a durable location,
// `assertDurableArtifactRoot` refuses the ones a sweeper owns, and
// `openRunRetention` proves the location is writable by writing to it before the
// first attempt runs. There is deliberately no way to turn this off: a scored
// run that writes nowhere durable fails at argument parsing.
import { appendFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join, resolve, sep } from 'node:path';
import * as v from 'valibot';
import { AttemptOutcomeSchema, parseJsonValue } from '../packages/core/src/index.js';
import type { AttemptBudget, AttemptOutcome, JsonValue } from '../packages/core/src/index.js';

/** Repo-relative default. `.gitignore` already carries `/bench-artifacts/`. */
export const ARTIFACT_DIRNAME = 'bench-artifacts';

/** Roots whose contents a sweeper, a reboot, or a tmpfs may remove. `/tmp` on
 *  this machine is a 31 GB tmpfs that reached 100% inodes during a test run and
 *  is swept by the test preload; nothing that is evidence may live there. */
const SWEPT_ROOTS = ['/tmp', '/var/tmp', '/dev/shm'] as const;

/**
 * Refuse an artifact root that cannot hold evidence.
 *
 * `runRoot` is checked too, and it is the subtle one: the run root is a
 * throwaway that `createAttemptSandbox` deletes per attempt, so artifacts
 * written under it are destroyed by the very run that produced them.
 */
export function assertDurableArtifactRoot(root: string, runRoot: string): void {
  if (!isAbsolute(root)) {
    throw new Error(`bench artifact root must be absolute, got ${root} — evidence needs one unambiguous home`);
  }
  const resolved = resolve(root);
  for (const swept of [...SWEPT_ROOTS, tmpdir()]) {
    const parent = resolve(swept);
    if (resolved === parent || resolved.startsWith(parent + sep)) {
      throw new Error(
        `bench artifact root ${resolved} is under ${swept}, which is swept — `
        + 'a scored run must write its per-trial evidence somewhere durable. '
        + `Point --artifacts (or BENCH_ARTIFACTS) at a real directory, or leave it unset for <repo>/${ARTIFACT_DIRNAME}.`,
      );
    }
  }
  const throwaway = resolve(runRoot);
  if (resolved === throwaway || resolved.startsWith(throwaway + sep)) {
    throw new Error(
      `bench artifact root ${resolved} is inside the run root ${throwaway}, whose attempt sandboxes are deleted as the run proceeds`,
    );
  }
}

/** `--artifacts` beats `BENCH_ARTIFACTS` beats `<repo>/bench-artifacts`. An
 *  explicitly empty value is an error rather than an opt-out: there is no
 *  opt-out. */
export function resolveArtifactRoot(opts: {
  flag: string | undefined;
  env: { BENCH_ARTIFACTS?: string | undefined };
  repoRoot: string;
  runRoot: string;
}): string {
  const flag = opts.flag?.trim();
  const fromEnv = opts.env.BENCH_ARTIFACTS?.trim();
  if (opts.flag !== undefined && !flag) {
    throw new Error('--artifacts needs a directory path; retention cannot be switched off');
  }
  if (opts.env.BENCH_ARTIFACTS !== undefined && !fromEnv) {
    throw new Error('BENCH_ARTIFACTS is set to an empty value; retention cannot be switched off');
  }
  const root = resolve(flag || fromEnv || join(opts.repoRoot, ARTIFACT_DIRNAME));
  assertDurableArtifactRoot(root, opts.runRoot);
  return root;
}

/** What a number needs in order to be re-derivable a year from now. Every field
 *  is required: an optional provenance field is a field that will be missing
 *  exactly when someone needs it. */
export interface RunProvenance {
  /** `validate` | `pilot` | `compare` | `gain`. */
  command: string;
  runId: string;
  commit: string;
  /** Whether the measured tree had uncommitted changes. A dirty run is still
   *  evidence; a dirty run reported as its commit is not. */
  dirty: boolean;
  family: string;
  corpus: string;
  manifestHash: string;
  seed: number;
  repeats: number;
  budget: AttemptBudget;
  /** Solver ids, in the order the command names them. */
  variants: readonly string[];
  /** Whether the run's distinctive mechanism was live. Both prior
   *  Terminal-Bench runs were made with evolution off and read as if it were
   *  on, so the arm is recorded as data rather than assumed. */
  evolving: boolean;
  /** Model id and endpoint identity for a model-backed run, `null` for the
   *  deterministic controls, which make no calls. */
  model: string | null;
  providerHash: string | null;
  taskIds: readonly string[];
}

export interface PerTaskOutcome {
  taskId: string;
  byVariant: Record<string, { attempts: number; passed: number }>;
}

export interface RunRetention {
  /** This run's directory, under the artifact root. */
  readonly dir: string;
  /** Append one attempt's full outcome. Synchronous and immediate on purpose:
   *  a run that dies at attempt 60 keeps the first 59. */
  recordAttempt(outcome: AttemptOutcome): void;
  /** Seal the run: per-task rollup plus the report, next to the trials. Absent
   *  `completedAt` in `run.json` is how a crashed run identifies itself. */
  finish(report: JsonValue): void;
}

const RUN_FILE = 'run.json';
const ATTEMPTS_FILE = 'attempts.jsonl';
const PROBE_FILE = '.writable-probe';

interface GitIdentity { commit: string; dirty: boolean }

/** Attribute the run to a commit. A scored run whose source state is unknown is
 *  a rumour, so this throws rather than recording a null. */
export function readGitIdentity(repoRoot: string): GitIdentity {
  const git = (args: readonly string[]): string => {
    const out = Bun.spawnSync(['git', ...args], { cwd: repoRoot, stdout: 'pipe', stderr: 'pipe' });
    if (out.exitCode !== 0) {
      throw new Error(`git ${args.join(' ')} failed in ${repoRoot}: ${out.stderr.toString().trim()}`);
    }
    return out.stdout.toString();
  };
  return {
    commit: git(['rev-parse', 'HEAD']).trim(),
    dirty: git(['status', '--porcelain']).trim().length > 0,
  };
}

/**
 * Open a run's retention directory, having proven it writable.
 *
 * The probe is the point. A path that merely looks durable but is read-only, or
 * on a full filesystem, would otherwise be discovered after the tokens were
 * spent — which is exactly how the R3 evidence was lost.
 */
export function openRunRetention(opts: {
  artifactRoot: string;
  repoRoot: string;
  provenance: Omit<RunProvenance, 'commit' | 'dirty'>;
}): RunRetention {
  const dir = join(opts.artifactRoot, `${opts.provenance.command}-${opts.provenance.runId}`);
  const probe = join(dir, PROBE_FILE);
  try {
    mkdirSync(dir, { recursive: true });
    writeFileSync(probe, opts.provenance.runId);
    if (readFileSync(probe, 'utf8') !== opts.provenance.runId) {
      throw new Error('probe read back different bytes');
    }
    rmSync(probe);
  } catch (error) {
    throw new Error(
      `bench artifact root ${opts.artifactRoot} is not writable, so this scored run would leave no evidence`,
      { cause: error },
    );
  }

  const git = readGitIdentity(opts.repoRoot);
  const provenance: RunProvenance = { ...opts.provenance, commit: git.commit, dirty: git.dirty };
  const startedAt = new Date().toISOString();
  const runFile = join(dir, RUN_FILE);
  writeFileSync(runFile, `${JSON.stringify({ startedAt, completedAt: null, ...provenance }, null, 2)}\n`);

  const attemptsFile = join(dir, ATTEMPTS_FILE);
  writeFileSync(attemptsFile, '');
  const perTask = new Map<string, PerTaskOutcome>();

  return {
    dir,
    recordAttempt(outcome) {
      appendFileSync(attemptsFile, `${JSON.stringify(outcome)}\n`);
      const entry = perTask.get(outcome.taskId) ?? { taskId: outcome.taskId, byVariant: {} };
      const tally = entry.byVariant[outcome.variantId] ?? { attempts: 0, passed: 0 };
      tally.attempts += 1;
      if (outcome.passed) tally.passed += 1;
      entry.byVariant[outcome.variantId] = tally;
      perTask.set(outcome.taskId, entry);
    },
    finish(report) {
      writeFileSync(runFile, `${JSON.stringify({
        startedAt,
        completedAt: new Date().toISOString(),
        ...provenance,
        perTask: [...perTask.values()],
        report,
      }, null, 2)}\n`);
    },
  };
}

/** Read a run's trials back. Parsed, not asserted: a retained trial is evidence,
 *  and evidence that no longer matches the contract must say so. */
export function readRetainedAttempts(dir: string): AttemptOutcome[] {
  return readFileSync(join(dir, ATTEMPTS_FILE), 'utf8')
    .split('\n')
    .filter((line) => line.trim())
    .map((line) => v.parse(AttemptOutcomeSchema, parseJsonValue(line)));
}

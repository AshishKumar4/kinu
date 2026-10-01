/**
 * CI proves a clean revision once, and the deploy takes that proof (L23). A row verdict is its command and exit
 * status, not a cache entry: the local ladder cache is checkout-specific and stays so. CI runs uncached and uploads
 * each part's verdicts even on red. Their union must contain every planned row exactly once; absence is never green.
 * Only this repository's push of the exact full SHA is eligible, never a PR's merge commit or another revision.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import * as v from 'valibot';

const Sha = v.pipe(v.string(), v.regex(/^[0-9a-f]{40}$/u));

const RowSchema = v.object({
  run: v.string(), exitCode: v.number(), seconds: v.number(), output: v.optional(v.string(), ''),
  timings: v.optional(v.record(v.string(), v.number())),
});

export type CIVerdict = v.InferOutput<typeof RowSchema>;

export const VerdictFileSchema = v.object({ sha: Sha, part: v.string(), rows: v.array(RowSchema) });

export type CIVerdictFile = v.InferOutput<typeof VerdictFileSchema>;

const HostedCostsSchema = v.object({ version: v.literal(1), sha: Sha, runUrl: v.string(), seconds: v.record(v.string(), v.number()), files: v.record(v.string(), v.number()) });

export type HostedCosts = v.InferOutput<typeof HostedCostsSchema>;

/** The hosted run, never this workstation, determines CI placement. These are scheduling observations, not verdicts. */
export function readHostedCosts(): HostedCosts {
  return v.parse(HostedCostsSchema, JSON.parse(readFileSync(new URL('./ci-cost.json', import.meta.url), 'utf8')));
}

/** Bun's first-party --timings/--update-timings report, measured per file rather than inferred from its console. */
export function readFileTimings(path: string): Record<string, number> | undefined {
  if (!existsSync(path)) return undefined;

  return v.parse(v.object({ version: v.literal(1), files: v.record(v.string(), v.number()) }), JSON.parse(readFileSync(path, 'utf8'))).files;
}

/** Each split suite still measures its declared files exactly once. A green exit does not excuse an omitted file. */
export function checkFileCoverage(file: CIVerdictFile, split: readonly { readonly run: string; readonly files: readonly string[] }[]): void {
  for (const unit of split) {
    const measured = Object.keys(file.rows.find((row) => row.run === unit.run)?.timings ?? {});

    if (measured.length !== unit.files.length || unit.files.some((name) => !measured.includes(name))) {
      throw new Error('CI file coverage differs for ' + unit.run);
    }
  }
}

/** Keep the next plan grounded in a complete hosted artifact, including red resource measurements. */
export function writeHostedCosts(file: CIVerdictFile, runUrl: string, labels: ReadonlyMap<string, string>): HostedCosts {
  const seconds: Record<string, number> = {};
  const files: Record<string, number> = {};

  for (const row of file.rows) {
    const label = labels.get(row.run);

    if (label === undefined) throw new Error('no current ladder row names hosted measurement ' + row.run);
    seconds[label] = row.seconds;
    Object.assign(files, row.timings);
  }

  const costs: HostedCosts = { version: 1, sha: file.sha, runUrl, seconds, files };

  writeFileSync(new URL('./ci-cost.json', import.meta.url), JSON.stringify(costs, null, 2) + '\n');

  return costs;
}

const RunSchema = v.looseObject({
  id: v.number(), run_attempt: v.number(), head_sha: Sha, event: v.string(), status: v.string(), html_url: v.string(),
  conclusion: v.optional(v.nullable(v.string()), null),
});


export type CIRunInput = v.InferInput<typeof RunSchema>;

export type CIRun = v.InferOutput<typeof RunSchema>;

/** Completion alone is not a pass: canceled, pending and failed runs never verify a revision. */
export function requireCIGreen(run: CIRun): void {
  if (run.status !== 'completed' || run.conclusion !== 'success') {
    throw new Error('CI is ' + run.status + '/' + String(run.conclusion) + ': ' + run.html_url);
  }
}

/** The artifact of a single part, or the collected result: attempts cannot mix old red/green jobs on a rerun. */
export function verdictArtifact(sha: string, attempt: number, part: string): string {
  return `ladder-verdicts-${sha}-${String(attempt)}-${part}`;
}

/** Every row in `expected` appears exactly once, and no other command can supply its proof. */
export function checkCoverage(file: CIVerdictFile, sha: string, expected: readonly string[]): void {
  if (file.sha !== sha) throw new Error(`CI proved ${file.sha}, not the deployed revision ${sha}`);
  const seen = new Set<string>();

  for (const row of file.rows) {
    if (!expected.includes(row.run)) throw new Error(`CI names a row outside this plan: ${row.run}`);

    if (seen.has(row.run)) throw new Error(`CI proves a row twice: ${row.run}`);
    seen.add(row.run);
  }

  const missing = expected.filter((run) => !seen.has(run));

  if (missing.length > 0) throw new Error(`CI has no verdict for ${String(missing.length)} row(s), first ${missing[0] ?? ''}; missing is not green`);
}

export function readVerdicts(path: string): CIVerdictFile {
  return v.parse(VerdictFileSchema, JSON.parse(readFileSync(path, 'utf8')));
}

export function writeVerdicts(path: string, file: CIVerdictFile): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(file)}\n`);
}

/** Parts are taken from the ladder's plan, never a directory scan or a workflow-maintained suite list. */
export interface CIPart {
  readonly name: string;
  readonly runs: readonly string[];
}

/** Collects each part under the directory actions/download-artifact wrote, refusing a gap, duplicate or wrong SHA. */
export function collectVerdicts(input: { readonly directory: string; readonly sha: string; readonly attempt: number; readonly parts: readonly CIPart[] }): CIVerdictFile {
  const rows: CIVerdict[] = [];

  for (const part of input.parts) {
    const file = readVerdicts(join(input.directory, verdictArtifact(input.sha, input.attempt, part.name), 'verdicts.json'));

    if (file.part !== part.name) throw new Error(`CI part ${part.name} was replaced by ${file.part}`);
    checkCoverage(file, input.sha, part.runs);
    rows.push(...file.rows);
  }

  const collected = { sha: input.sha, part: 'all', rows };

  checkCoverage(collected, input.sha, input.parts.flatMap((part) => part.runs));

  return collected;
}

/** A push of this exact revision, not a PR run which executes untrusted merge code. */
export function pushRun(input: CIRunInput, sha: string): CIRun {
  const run = v.parse(RunSchema, input);

  if (run.event !== 'push' || run.head_sha !== sha) throw new Error(`CI run ${String(run.id)} is ${run.event} on ${run.head_sha}, not a push of ${sha}`);

  return run;
}

function gh(root: string, args: readonly string[]): string {
  const answer = Bun.spawnSync(['gh', ...args], { cwd: root, stdout: 'pipe', stderr: 'pipe' });

  if (answer.exitCode !== 0) throw new Error(`gh ${args.slice(0, 2).join(' ')} failed: ${answer.stderr.toString().trim()}`);

  return answer.stdout.toString();
}

/** Only ci.yml's push runs are queried. No run means nothing gets deployed: push the revision first. */
export function findPushCI(root: string, sha: string): CIRun {
  const listed = gh(root, ['api', `repos/{owner}/{repo}/actions/workflows/ci.yml/runs?event=push&head_sha=${sha}&per_page=100`]);
  const runs = v.parse(v.looseObject({ workflow_runs: v.array(RunSchema) }), JSON.parse(listed)).workflow_runs;
  const matching = runs.filter((run) => run.event === 'push' && run.head_sha === sha);
  const [newest] = matching.sort((left, right) => right.id - left.id);

  if (newest === undefined) throw new Error(`no push-CI run exists for ${sha}; push the branch holding that revision, then deploy it`);

  return pushRun(newest, sha);
}

/** Waits on Actions' own run completion, including a red run: reds belong in the deploy report, never a retry. */
export function awaitCI(root: string, run: CIRun): CIRun {
  let current = pushRun(JSON.parse(gh(root, ['api', 'repos/{owner}/{repo}/actions/runs/' + String(run.id)])), run.head_sha);

  if (current.run_attempt !== run.run_attempt) throw new Error('CI restarted; this deploy no longer has its verdict');

  if (current.status !== 'completed') {
    // A red run is a completed run too. Its verdict is recorded below, not retried locally.
    Bun.spawnSync(['gh', 'run', 'watch', String(run.id), '--interval', '10'], { cwd: root, stdout: 'inherit', stderr: 'inherit' });
    current = pushRun(JSON.parse(gh(root, ['api', 'repos/{owner}/{repo}/actions/runs/' + String(run.id)])), run.head_sha);
  }

  if (current.status !== 'completed' || current.run_attempt !== run.run_attempt) throw new Error('CI has no completed verdict for this attempt');

  return current;
}

/** Downloads an immutable artifact from the selected run, not an arbitrary file or another run for the branch. */
export function downloadVerdicts(root: string, run: CIRun, part: string, directory: string): CIVerdictFile {
  const name = verdictArtifact(run.head_sha, run.run_attempt, part);
  const listed = gh(root, ['api', `repos/{owner}/{repo}/actions/runs/${String(run.id)}/artifacts?per_page=100`]);
  const artifacts = v.parse(v.looseObject({ artifacts: v.array(v.looseObject({ name: v.string(), expired: v.boolean() })) }), JSON.parse(listed)).artifacts;

  if (!artifacts.some((artifact) => artifact.name === name && !artifact.expired)) {
    throw new Error(`CI ${run.html_url} has no ${part} verdict artifact for ${run.head_sha}; missing is not green`);
  }

  mkdirSync(directory, { recursive: true });
  gh(root, ['run', 'download', String(run.id), '--name', name, '--dir', directory]);
  const file = readVerdicts(join(directory, 'verdicts.json'));

  if (file.sha !== run.head_sha || file.part !== part) throw new Error(`CI artifact ${name} names another revision or part`);

  return file;
}

/** The upload scan holds the upload, but none of the source shards needs to finish before the build. It is its own
 *  cheap matrix part. Wait for that job, not for the whole CI run; a canceled or missing job produces no proof. */
export async function awaitUploadCI(root: string, run: CIRun): Promise<void> {
  const Jobs = v.looseObject({ jobs: v.array(v.looseObject({ name: v.string(), status: v.string() })) });

  for (;;) {
    const state = pushRun(JSON.parse(gh(root, ['api', `repos/{owner}/{repo}/actions/runs/${String(run.id)}`])), run.head_sha);

    if (state.run_attempt !== run.run_attempt) throw new Error(`CI ${run.html_url} restarted before its upload verdict`);
    const read = gh(root, ['api', `repos/{owner}/{repo}/actions/runs/${String(run.id)}/attempts/${String(run.run_attempt)}/jobs?per_page=100`]);
    const job = v.parse(Jobs, JSON.parse(read)).jobs.find((entry) => entry.name === 'Ladder (upload)');

    if (job?.status === 'completed' || state.status === 'completed') return;
    // Waiting for this real job's completion, not adding a row timeout. Actions owns the job's bound.
    await Bun.sleep(1_000);
  }
}

export function readCIRun(path: string, sha: string): CIRun {
  return pushRun(JSON.parse(readFileSync(path, 'utf8')), sha);
}

export function writeCIRun(path: string, run: CIRun): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(run)}\n`);
}

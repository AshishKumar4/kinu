/**
 * CI proves a clean revision once, on armada, and the push and the deploy take that proof (L25). A row verdict is its
 * command and exit status; a row whose input closure, toolchain and runner image are unchanged reuses the green proof
 * its container's store holds (`ladder-cache.ts`), and names the revision that proved it. armada grades every planned
 * row exactly once, with a timing for each file a split suite declares, before it stores a commit's verdict; absence is
 * never green.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import * as v from 'valibot';

const Sha = v.pipe(v.string(), v.regex(/^[0-9a-f]{40}$/u));

const RowSchema = v.object({
  run: v.string(), exitCode: v.number(), seconds: v.number(), output: v.optional(v.string(), ''),
  timings: v.optional(v.record(v.string(), v.number())),
  /** The revision whose run this unchanged row reuses. */
  cached: v.optional(v.string()),
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

/** What the container runner measured (cf-ci's `{timings}`): each green row's seconds by its command, each file's. */
const RunnerTimingsSchema = v.object({ rows: v.record(v.string(), v.number()), files: v.record(v.string(), v.number()) });

export type RunnerTimings = v.InferOutput<typeof RunnerTimingsSchema>;

export function parseRunnerTimings(text: string): RunnerTimings {
  return v.parse(RunnerTimingsSchema, JSON.parse(text));
}

/** The hosted costs with the runner's measurements over them: a row (named by `labels` from its command) or a file
 *  the runner timed takes its time. */
export function withRunnerCosts(hosted: HostedCosts, measured: RunnerTimings, labels: ReadonlyMap<string, string>): HostedCosts {
  const seconds = { ...hosted.seconds };

  for (const [run, taken] of Object.entries(measured.rows)) {
    const label = labels.get(run);

    if (label !== undefined) seconds[label] = taken;
  }

  return { ...hosted, seconds, files: { ...hosted.files, ...measured.files } };
}

/** Bun's first-party --timings/--update-timings report, measured per file rather than inferred from its console. */
export function readFileTimings(path: string): Record<string, number> | undefined {
  if (!existsSync(path)) return undefined;

  return v.parse(v.object({ version: v.literal(1), files: v.record(v.string(), v.number()) }), JSON.parse(readFileSync(path, 'utf8'))).files;
}

export function readVerdicts(path: string): CIVerdictFile {
  return v.parse(VerdictFileSchema, JSON.parse(readFileSync(path, 'utf8')));
}

export function writeVerdicts(path: string, file: CIVerdictFile): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(file)}\n`);
}

/** The verdict `armada run` stored for `sha`, read through Kinu's pinned armada, or null when it stored none. */
export function armadaVerdict(root: string, sha: string): CIVerdictFile | null {
  const answer = Bun.spawnSync([join(root, 'node_modules', '.bin', 'armada'), 'verdict', sha, '--json'], { cwd: root, stdout: 'pipe', stderr: 'pipe' });
  const said = answer.stdout.toString().trim();

  // `null` is armada's word for no verdict; anything else it exits 2 with is an error.
  if (answer.exitCode === 2 && said === 'null') return null;

  if (answer.exitCode !== 0 && answer.exitCode !== 1) throw new Error(`armada verdict ${sha} exited ${String(answer.exitCode)}: ${answer.stderr.toString().trim()}`);

  return v.parse(VerdictFileSchema, JSON.parse(said));
}

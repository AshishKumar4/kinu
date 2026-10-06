#!/usr/bin/env bun
/**
 * The CI tier of one commit on Cloudflare Containers (`scripts/ci-runner/`, the `kinu-ci-runner` Worker).
 *
 *   bun scripts/ci-remote.ts <commit|worktree> [--target=<seconds per part>] [--label=<text>]
 *   bun scripts/ci-remote.ts --prune [--keep=<environments>]
 *
 * A worktree must be committed: the commit is what is proved. Its one-commit pack goes to R2 once per SHA (nothing is
 * pushed to GitHub), the runner plans the tier with the commit's own ladder and runs every CI part in its own
 * container, and this grades the part verdict files with `scripts/ci-verdicts.ts`, the code GitHub's collect job runs.
 * Every red row is printed with its output's tail. Exits 0 when every planned row ran once and passed, 1 when a row
 * was red, 2 when the run could not grade the commit. Interrupting it cancels the run. The report goes to
 * `~/.local/state/kinu/ci-runs/`. The release gate stays GitHub CI (docs/DEPLOYMENT.md).
 */
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import * as v from 'valibot';
import { checkFileCoverage, collectVerdicts, verdictArtifact, VerdictFileSchema, type CIVerdictFile } from './ci-verdicts';
import { installInput, PlanSchema, RunStatusSchema, type Manifest, type PieceRow, type Plan, type RunStatus } from './ci-runner/contract';
import { snapshotRegistry } from '../packages/devbox/src/snapshot-registry';
import { restApiToken } from './cloudflare-rest';

const ACCOUNT = 'f44999d1ddda7012e9a87729eba250f1';

const CONFIG = join(homedir(), '.config', 'kinu');

const REPORTS = join(homedir(), '.local', 'state', 'kinu', 'ci-runs');

const POLL_MS = 3_000;

/** Lines of a red row's output printed here; the whole output is in the report. */
const TAIL_LINES = 60;

const option = (name: string): string | undefined => process.argv.find((argument) => argument.startsWith(`--${name}=`))?.slice(name.length + 3);

function git(cwd: string, args: readonly string[], stdin?: Uint8Array): Buffer {
  const ran = Bun.spawnSync(['git', ...args], { cwd, stdin: stdin ?? 'ignore', stdout: 'pipe', stderr: 'pipe' });

  if (ran.exitCode !== 0) throw new Error(`git ${args.join(' ')}: ${ran.stderr.toString().trim()}`);

  return ran.stdout;
}

interface Commit {
  readonly sha: string;
  /** A repository holding it, to pack it from. */
  readonly repo: string;
}

/** The commit a target names, refusing a worktree whose changes no commit holds. */
function resolveCommit(target: string): Commit {
  if (existsSync(target) && statSync(target).isDirectory()) {
    const dirty = git(target, ['status', '--porcelain']).toString().trim();

    if (dirty !== '') throw new Error(`${target} has uncommitted changes; the runner proves a commit, so commit them first:\n${dirty}`);

    return { sha: git(target, ['rev-parse', 'HEAD']).toString().trim(), repo: target };
  }

  return { sha: git(process.cwd(), ['rev-parse', '--verify', `${target}^{commit}`]).toString().trim(), repo: process.cwd() };
}

function manifestOf(repo: string, sha: string): Manifest {
  return git(repo, ['ls-tree', '-r', '--full-tree', sha]).toString().split('\n').flatMap((line) => {
    const [meta = '', path = ''] = line.split('\t');
    const id = meta.split(' ')[2] ?? '';

    return installInput(path) ? [{ path, id }] : [];
  });
}

/** The commit's whole history (`root`), or what it adds to the environment's commit, whose history the snapshot holds. */
function packOf(repo: string, sha: string, base: string): Blob {
  const objects = git(repo, ['rev-list', '--objects', sha, ...base === 'root' ? [] : ['--not', base]]);

  return new Blob([new Uint8Array(git(repo, ['-c', 'pack.threads=4', 'pack-objects', '--stdout', '-q'], objects))]);
}

interface Connection {
  readonly url: string;
  readonly token: string;
}

function connection(): Connection {
  const read = (name: string, variable: string): string => {
    const file = join(CONFIG, name);
    const value = process.env[variable] ?? (existsSync(file) ? readFileSync(file, 'utf8').trim() : '');

    if (value === '') throw new Error(`no ${name}: deploy the runner with \`bun scripts/ci-runner-deploy.ts\`, or set ${variable}`);

    return value;
  };

  return { url: read('ci-url', 'KINU_CI_URL').replace(/\/$/u, ''), token: read('ci-token', 'KINU_CI_TOKEN') };
}

async function call(path: string, init: RequestInit = {}): Promise<Response> {
  const { url, token } = connection();
  const headers = new Headers(init.headers);

  headers.set('authorization', `Bearer ${token}`);
  const response = await fetch(url + path, { ...init, headers });

  if (!response.ok && response.status !== 404) throw new Error(`${init.method ?? 'GET'} ${path}: ${String(response.status)} ${await response.text()}`);

  return response;
}

const seconds = (ms: number): string => `${(ms / 1000).toFixed(1)} s`;

const clock = (ms: number): string => `${String(Math.floor(ms / 60_000))}:${String(Math.floor(ms / 1000) % 60).padStart(2, '0')}`;

/** One line per change a reader acts on: a phase, a part provisioned, a part finished or broken. */
function narrate(status: RunStatus, seen: Map<string, string>): void {
  const say = (key: string, value: string, line: string) => {
    if (seen.get(key) === value) return;
    seen.set(key, value);
    console.log(`${clock(Date.now() - status.spec.createdAt)}  ${line}`);
  };

  say('phase', status.phase, status.phase === 'preparing' ? `preparing environment ${status.spec.key.slice(0, 12)}` : status.phase);

  for (const piece of [status.plan, ...status.parts].filter((each): each is PieceRow => each !== null)) {
    const times = piece.result?.times;

    if (piece.state === 'running') say(piece.name, `${String(piece.attempt)}running`, `${piece.name.padEnd(10)} running${piece.attempt > 0 ? ` (attempt ${String(piece.attempt + 1)})` : ''}`);

    if (piece.state === 'done' && times !== undefined) {
      const took = (piece.result?.finishedAt ?? 0) - times.requested;

      say(piece.name, 'done', `${piece.name.padEnd(10)} ${piece.result?.exitCode === 0 ? 'green' : 'RED'} in ${clock(took)}, container answered in ${seconds(times.answered - times.requested)}`);
    }

    if (piece.state === 'infra-failed' || piece.state === 'stopped') say(piece.name, piece.state, `${piece.name.padEnd(10)} ${piece.state}: ${piece.errors.join(' | ')}`);
  }
}

async function follow(runId: string): Promise<RunStatus> {
  const seen = new Map<string, string>();

  for (;;) {
    const status = v.parse(RunStatusSchema, await (await call(`/runs/${runId}`)).json());

    narrate(status, seen);

    if (status.phase === 'done') return status;
    await Bun.sleep(POLL_MS);
  }
}

/** Each part's verdict file, laid out as GitHub's artifacts are, then collected and checked as GitHub's are. */
async function grade(runId: string, sha: string, plan: Plan): Promise<CIVerdictFile> {
  const directory = join(REPORTS, runId, 'parts');

  for (const part of plan.parts) {
    const response = await call(`/runs/${runId}/parts/${part.name}/output`);

    if (response.status === 404) throw new Error(`part ${part.name} has no verdict file`);
    const into = join(directory, verdictArtifact(sha, 1, part.name));

    mkdirSync(into, { recursive: true });
    writeFileSync(join(into, 'verdicts.json'), JSON.stringify(v.parse(VerdictFileSchema, await response.json())));
  }

  const file = collectVerdicts({ directory, sha, attempt: 1, parts: plan.parts });

  checkFileCoverage(file, plan.split);

  return file;
}

function printReds(file: CIVerdictFile, plan: Plan): void {
  for (const row of file.rows.filter((each) => each.exitCode !== 0)) {
    console.log(`\nRED  ${plan.labels[row.run] ?? row.run}  (exit ${String(row.exitCode)}, ${seconds(row.seconds * 1000)})\n  ${row.run}`);
    console.log((row.output ?? '').split('\n').slice(-TAIL_LINES).map((line) => `  | ${line}`).join('\n'));
  }
}

/** Where the parts' time went: how long each container took to answer, and how long each part ran. */
function spread(status: RunStatus): string {
  const done = status.parts.flatMap((piece) => piece.result === null ? [] : [piece.result]);
  const answered = done.map((result) => result.times.answered - result.times.requested).sort((left, right) => left - right);
  const ran = done.map((result) => result.finishedAt - result.times.launched).sort((left, right) => left - right);
  const at = (sorted: number[], quantile: number) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * quantile))] ?? 0;

  return `${String(done.length)} parts; container answered in ${seconds(at(answered, 0))} to ${seconds(at(answered, 1))} (median ${seconds(at(answered, 0.5))}); `
    + `parts ran ${clock(at(ran, 0))} to ${clock(at(ran, 1))} (median ${clock(at(ran, 0.5))})`;
}

async function prove(target: string): Promise<number> {
  const { sha, repo } = resolveCommit(target);

  const manifest = manifestOf(repo, sha);
  const json = { 'content-type': 'application/json' };
  const resolved = await call('/environments/resolve', { method: 'POST', headers: json, body: JSON.stringify({ manifest }) });
  const { key, base } = v.parse(v.object({ key: v.string(), base: v.string() }), await resolved.json());

  console.log(`commit ${sha}, environment ${key.slice(0, 12)}${base === 'root' ? ' (to prepare)' : ''}`);

  if ((await call(`/packs/${sha}/${base}`, { method: 'HEAD' })).status === 404) {
    const pack = packOf(repo, sha, base);

    await call(`/packs/${sha}/${base}`, { method: 'PUT', body: pack });
    console.log(`uploaded its pack, ${(pack.size / 1e6).toFixed(1)} MB`);
  }

  const started = await call('/runs', {
    method: 'POST', headers: json,
    body: JSON.stringify({ sha, base, manifest, target: Number(option('target') ?? '300'), label: option('label') ?? '' }),
  });

  const { runId } = v.parse(v.object({ runId: v.string() }), await started.json());

  console.log(`run ${runId}`);
  process.on('SIGINT', () => {
    const cancelled = () => process.exit(2);

    void call(`/runs/${runId}/cancel`, { method: 'POST' }).then(cancelled, cancelled);
  });

  const status = await follow(runId);
  const report = join(REPORTS, `${runId}.json`);

  mkdirSync(REPORTS, { recursive: true });
  writeFileSync(report, JSON.stringify({ status }, null, 2));

  for (const problem of status.problems) console.log(`problem: ${problem}`);

  if (status.plan?.state !== 'done') return 2;
  const plan = v.parse(PlanSchema, await (await call(`/runs/${runId}/parts/plan/output`)).json());
  let file: CIVerdictFile;

  try {
    file = await grade(runId, sha, plan);
  } catch (cause) {
    console.log(`\nNOT GRADED: ${cause instanceof Error ? cause.message : String(cause)}`);

    return 2;
  }

  writeFileSync(report, JSON.stringify({ status, verdicts: file }, null, 2));
  await call(`/verdicts/${sha}`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(file) });
  const green = file.rows.filter((row) => row.exitCode === 0 && row.cached === undefined);

  await call('/timings', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      sha, runId,
      seconds: Object.fromEntries(green.map((row) => [plan.labels[row.run] ?? row.run, row.seconds])),
      files: Object.assign({}, ...green.map((row) => row.timings ?? {})),
    }),
  });
  printReds(file, plan);
  const reds = file.rows.filter((row) => row.exitCode !== 0).length;

  console.log(`\n${reds === 0 ? 'PASS' : 'FAIL'}: ${String(file.rows.length - reds)} of ${String(file.rows.length)} rows green, wall ${clock((status.finishedAt ?? Date.now()) - status.spec.createdAt)}`);
  console.log(spread(status));
  console.log(`report: ${report}`);

  return reds === 0 ? 0 : 1;
}

const EntrySchema = v.object({ key: v.string(), entry: v.looseObject({ state: v.string(), lastUsed: v.optional(v.number()), generation: v.optional(v.object({ snapshot: v.object({ id: v.string() }) })) }) });

/** Deletes the snapshots of all but the `keep` most recently used environments; the next run that needs one prepares it again. */
async function prune(keep: number): Promise<number> {
  const token = restApiToken();

  if (token === '') throw new Error('pruning deletes registry tags: export KINU_CLOUDFLARE_API_TOKEN');
  const listed = v.parse(v.array(EntrySchema), await (await call('/environments')).json());
  const ready = listed.filter((each) => each.entry.state === 'ready').sort((left, right) => (right.entry.lastUsed ?? 0) - (left.entry.lastUsed ?? 0));
  const registry = snapshotRegistry({ account: ACCOUNT, token, fetch: async (input, init) => await fetch(input, init) });

  for (const { key, entry } of ready.slice(keep)) {
    const id = entry.generation?.snapshot.id;
    const deleted = id === undefined ? { kind: 'absent' as const } : await registry.delete(id);

    if (deleted.kind === 'refused') throw new Error(`the snapshot of ${key} was not deleted: ${deleted.reason}`);
    await call(`/environments/${key}`, { method: 'DELETE' });
    console.log(`pruned ${key.slice(0, 12)} (${deleted.kind})`);
  }

  return 0;
}

async function main(): Promise<number> {
  if (process.argv.includes('--prune')) return await prune(Number(option('keep') ?? '3'));
  const target = process.argv.slice(2).find((argument) => !argument.startsWith('--'));

  if (target === undefined) throw new Error('usage: bun scripts/ci-remote.ts <commit|worktree> [--target=<seconds>] [--label=<text>]');

  return await prove(target);
}

try {
  process.exit(await main());
} catch (cause) {
  console.error(`ci-remote: ${cause instanceof Error ? cause.message : String(cause)}`);
  process.exit(2);
}

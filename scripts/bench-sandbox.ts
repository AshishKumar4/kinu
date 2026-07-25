// The hermetic half of the bench harness: one throwaway copy of this repo per
// attempt, the defect applied, the solver let loose, the checks restored, the
// number computed by a process exit code.
//
// Three guarantees live here, and each is enforced rather than documented:
//   - Nothing writes outside the run root (assertScratchRoot).
//   - The solver never sees the task corpus (it is excluded from the copy), so
//     it cannot read the defect patch or any held-out task.
//   - The solver never scores itself (guarded paths are restored from the
//     pristine tree between the attempt and the checks).
import { cpSync, existsSync, mkdirSync, readdirSync, rmSync, statSync, symlinkSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { homedir } from 'node:os';
import { join, relative, resolve, sep } from 'node:path';
import { attemptPassed } from '../packages/core/src/index.js';
import type { AttemptBudget, BenchCheck, BenchTask, CheckOutcome } from '../packages/core/src/index.js';

/** Top-level entries never copied into a sandbox. `tests/bench` is the seal's
 *  outermost ring: an agent that cannot read the corpus cannot read the
 *  held-out tasks, look up its own defect patch, or tune against either. */
const SANDBOX_EXCLUDES = ['.git', 'node_modules', join('tests', 'bench')] as const;

const OUTPUT_TAIL_BYTES = 4000;

/** Refuse to operate anywhere that could touch real state. The harness promises
 *  a throwaway home; this is the promise, in code. */
export function assertScratchRoot(runRoot: string, repoRoot: string): void {
  const root = resolve(runRoot);
  if (!root.startsWith(sep)) throw new Error(`bench run root must be absolute: ${runRoot}`);
  const home = resolve(homedir());
  if (root === home || root.startsWith(home + sep)) {
    throw new Error(`bench run root ${root} is inside the real home — every run must use a throwaway root outside it`);
  }
  const repo = resolve(repoRoot);
  if (root === repo || root.startsWith(repo + sep)) {
    throw new Error(`bench run root ${root} is inside the repo — sandboxes must not be created in the tree under test`);
  }
}

export interface AttemptSandbox {
  /** The repo copy the solver edits and the checks run against. */
  dir: string;
  /** This attempt's PROTEUS_HOME. Never the real one. */
  proteusHome: string;
  dispose(): void;
}

export interface CreateSandboxOptions {
  repoRoot: string;
  runRoot: string;
  attemptId: string;
  /** Applied forward to seed the defect. */
  defect: string;
}

export function createAttemptSandbox(opts: CreateSandboxOptions): AttemptSandbox {
  assertScratchRoot(opts.runRoot, opts.repoRoot);
  const base = join(opts.runRoot, 'attempts', opts.attemptId);
  rmSync(base, { recursive: true, force: true });
  const dir = join(base, 'repo');
  const proteusHome = join(base, 'home');
  mkdirSync(proteusHome, { recursive: true });

  const repo = resolve(opts.repoRoot);
  const excluded = new Set(SANDBOX_EXCLUDES.map((e) => join(repo, e)));
  cpSync(repo, dir, { recursive: true, dereference: false, filter: (src) => !excluded.has(src) });

  // Third-party deps are shared read-only; the workspace links inside
  // packages/*/node_modules are relative, so they resolve into THIS copy and
  // cross-package imports see the solver's edits.
  const nodeModules = join(repo, 'node_modules');
  if (existsSync(nodeModules)) symlinkSync(nodeModules, join(dir, 'node_modules'), 'dir');

  applyPatch(dir, opts.defect, { reverse: false });

  return { dir, proteusHome, dispose: () => rmSync(base, { recursive: true, force: true }) };
}

export function applyPatch(dir: string, patch: string, opts: { reverse: boolean }): void {
  const args = ['apply', '--whitespace=nowarn', ...(opts.reverse ? ['-R'] : []), '-'];
  const res = Bun.spawnSync(['git', ...args], { cwd: dir, stdin: Buffer.from(patch), stdout: 'pipe', stderr: 'pipe' });
  if (res.exitCode !== 0) {
    throw new Error(`git apply${opts.reverse ? ' -R' : ''} failed in ${dir}: ${res.stderr.toString().trim()}`);
  }
}

/** Put the measuring apparatus back the way it shipped. Without this a solver
 *  can raise the number by editing the check, which is the oldest way to make
 *  a benchmark meaningless. */
export function restoreGuarded(dir: string, repoRoot: string, guarded: readonly string[]): void {
  for (const entry of guarded) {
    if (entry.includes('*')) {
      const [rootPart, pattern] = splitGlob(entry);
      const pristineFiles = new Set(walkMatching(join(repoRoot, rootPart), pattern));
      const sandboxFiles = new Set(walkMatching(join(dir, rootPart), pattern));
      for (const rel of pristineFiles) {
        cpSync(join(repoRoot, rootPart, rel), join(dir, rootPart, rel), { dereference: false });
      }
      for (const rel of sandboxFiles) {
        if (!pristineFiles.has(rel)) rmSync(join(dir, rootPart, rel), { force: true });
      }
      continue;
    }
    const from = join(repoRoot, entry);
    const to = join(dir, entry);
    if (!existsSync(from)) throw new Error(`guarded path ${entry} does not exist in the pristine tree`);
    rmSync(to, { recursive: true, force: true });
    cpSync(from, to, { recursive: true, dereference: false });
  }
}

/** 'a/b/ **\/ *.test.ts' → ['a/b', '*.test.ts']. Only a trailing filename glob
 *  under a fixed root is supported; anything richer would be a pattern language
 *  nobody asked for. */
function splitGlob(entry: string): [string, string] {
  const idx = entry.indexOf('**/');
  if (idx < 0) throw new Error(`unsupported guarded pattern: ${entry}`);
  const root = entry.slice(0, idx).replace(/\/$/, '');
  const pattern = entry.slice(idx + 3);
  if (pattern.includes('/') || !pattern.startsWith('*')) throw new Error(`unsupported guarded pattern: ${entry}`);
  return [root, pattern];
}

function walkMatching(root: string, pattern: string): string[] {
  const suffix = pattern.slice(1);
  const out: string[] = [];
  const visit = (abs: string): void => {
    let entries;
    try {
      entries = readdirSync(abs, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const child = join(abs, e.name);
      if (e.isDirectory()) visit(child);
      else if (e.isFile() && e.name.endsWith(suffix)) out.push(relative(root, child));
    }
  };
  if (existsSync(root) && statSync(root).isDirectory()) visit(root);
  return out;
}

/** The environment a check runs in. PROTEUS_* is stripped so a stray variable
 *  from the operator's shell cannot reach into a scored run, and HOME points at
 *  the attempt so nothing lands in the real one. */
export function sandboxEnv(proteusHome: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, val] of Object.entries(process.env)) {
    if (val === undefined) continue;
    if (k.startsWith('PROTEUS_') || k === 'HOME') continue;
    env[k] = val;
  }
  env.HOME = proteusHome;
  env.PROTEUS_HOME = proteusHome;
  env.CI = '1';
  return env;
}

function runCheck(check: BenchCheck, dir: string, proteusHome: string): Promise<CheckOutcome> {
  const [cmd, ...args] = check.command;
  const started = Date.now();
  return new Promise((resolveOutcome) => {
    execFile(
      cmd!, args,
      {
        cwd: check.cwd ? join(dir, check.cwd) : dir,
        env: sandboxEnv(proteusHome),
        timeout: check.timeoutMs ?? 180_000,
        maxBuffer: 32 * 1024 * 1024,
      },
      (err, stdout, stderr) => {
        const combined = `${stdout}${stderr}`;
        const killed = Boolean(err && (err as NodeJS.ErrnoException).code === undefined && (err as { killed?: boolean }).killed);
        const exitCode = killed ? null : ((err as { code?: number } | null)?.code ?? 0);
        resolveOutcome({
          id: check.id,
          passed: exitCode === 0,
          exitCode,
          durationMs: Date.now() - started,
          output: combined.length > OUTPUT_TAIL_BYTES ? combined.slice(-OUTPUT_TAIL_BYTES) : combined,
        });
      },
    );
  });
}

/** Run a task's checks in order, stopping at the first failure — an attempt that
 *  already failed cannot be rescued by a later check, and the checks are the
 *  expensive part. Scoring time is deliberately NOT charged to the solver's
 *  budget: the variant is being measured, not the scorer. */
export async function scoreSandbox(
  task: BenchTask,
  sandbox: AttemptSandbox,
  repoRoot: string,
): Promise<{ checks: CheckOutcome[]; passed: boolean }> {
  restoreGuarded(sandbox.dir, repoRoot, task.guarded);
  const checks: CheckOutcome[] = [];
  for (const check of task.checks) {
    const outcome = await runCheck(check, sandbox.dir, sandbox.proteusHome);
    checks.push(outcome);
    if (!outcome.passed) break;
  }
  const passed = checks.length === task.checks.length && attemptPassed(checks);
  return { checks, passed };
}

/** Wall-clock half of the budget. Token accounting is the solver's job — only
 *  it knows what it spent — and is reported alongside. */
export function budgetSignal(budget: AttemptBudget): { signal: AbortSignal; done: () => void; timedOut: () => boolean } {
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, budget.wallClockMs);
  return { signal: controller.signal, done: () => clearTimeout(timer), timedOut: () => timedOut };
}

export function ensureRunRoot(runRoot: string, repoRoot: string): string {
  assertScratchRoot(runRoot, repoRoot);
  mkdirSync(runRoot, { recursive: true });
  return resolve(runRoot);
}

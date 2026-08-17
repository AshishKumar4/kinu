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
import { cpSync, existsSync, mkdirSync, readdirSync, readlinkSync, rmSync, statSync, symlinkSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { homedir } from 'node:os';
import { basename, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { attemptPassed } from '../packages/core/src/index.js';
import type { AttemptBudget, BenchCheck, BenchTask, CheckOutcome } from '../packages/core/src/index.js';
import { tolerate } from '../packages/core/src/obs/index.js';
import { ARTIFACT_DIRNAME } from './bench-retention.js';

/** Paths never copied into a sandbox. `tests/bench` is the seal's outermost
 *  ring: an agent that cannot read the corpus cannot read the held-out tasks,
 *  look up its own defect patch, or tune against either. `bench-artifacts` is
 *  the SECOND ring, and it is the one retention created: a retained run holds
 *  per-trial outcomes and check output for sealed tasks, so copying it in would
 *  hand a solver the held-out answers by a different route. `.claude` holds
 *  agent worktrees — checkouts of this same repo, each with its own
 *  node_modules, and none of them are the source under test. */
const SANDBOX_EXCLUDES = [
  '.git', 'node_modules', '.claude', ARTIFACT_DIRNAME, join('tests', 'bench'),
] as const;

/** Nested checkouts, excluded wherever they appear. Each carries its OWN
 *  node_modules, and copying those turns a ~500MB sandbox into a multi-gigabyte
 *  one — which is how this suite exhausted tmpfs and failed as ENOSPC rather
 *  than as a real result. Note this cannot be a blanket `node_modules` rule:
 *  packages/<pkg>/node_modules holds the relative workspace links that let a
 *  solver's cross-package edits be seen, so those must be copied. */
const SANDBOX_EXCLUDED_NAMES = new Set(['.git']);

/** Workspace scope whose links must be re-pointed into the sandbox copy. */
const WORKSPACE_SCOPE = '@proteus';
const NESTED_CHECKOUT_DIRS = ['.claude', 'external'] as const;

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
  /** Puts the task's starting state into the fresh copy: the defect family
   *  applies its patch, the long-horizon family materializes its corpus. One
   *  callback rather than one option per family — the sandbox owns isolation,
   *  not what a task is made of. */
  prepare: (dir: string) => void;
}

/**
 * Give the sandbox a node_modules whose third-party deps are shared read-only
 * but whose workspace packages resolve into THIS copy.
 *
 * Symlinking the whole directory would be cheaper and is what this used to do,
 * but bun hoists the workspace links to the root, so `@proteus/core` ->
 * `../../packages/core` then resolved relative to the REAL repo's node_modules
 * — every workspace import inside a sandbox read pristine code, and a solver's
 * cross-package edits were graded as if they had never been made.
 */
function linkNodeModules(repo: string, dir: string): void {
  const nodeModules = join(repo, 'node_modules');
  if (!existsSync(nodeModules)) return;

  const target = join(dir, 'node_modules');
  mkdirSync(target, { recursive: true });
  for (const entry of readdirSync(nodeModules)) {
    if (entry === WORKSPACE_SCOPE) continue;
    symlinkSync(join(nodeModules, entry), join(target, entry));
  }

  const scope = join(nodeModules, WORKSPACE_SCOPE);
  if (!existsSync(scope)) return;
  const scopeDir = join(target, WORKSPACE_SCOPE);
  mkdirSync(scopeDir, { recursive: true });
  for (const pkg of readdirSync(scope)) {
    // Reuse bun's own relative target so it resolves inside the sandbox. An
    // absolute one would point back at the real repo, which is the whole bug.
    const linked = readlinkSync(join(scope, pkg));
    const relativeTarget = isAbsolute(linked)
      ? join('..', '..', relative(repo, linked))
      : linked;
    symlinkSync(relativeTarget, join(scopeDir, pkg));
  }
}

export function createAttemptSandbox(opts: CreateSandboxOptions): AttemptSandbox {
  assertScratchRoot(opts.runRoot, opts.repoRoot);
  const base = join(opts.runRoot, 'attempts', opts.attemptId);
  rmSync(base, { recursive: true, force: true });
  const dir = join(base, 'repo');
  const proteusHome = join(base, 'home');
  mkdirSync(proteusHome, { recursive: true });

  const repo = resolve(opts.repoRoot);
  const excluded = new Set([
    ...SANDBOX_EXCLUDES.map((e) => join(repo, e)),
    ...NESTED_CHECKOUT_DIRS.map((e) => join(repo, e)),
  ]);
  cpSync(repo, dir, {
    recursive: true,
    dereference: false,
    // Without this, cpSync REWRITES every relative symlink to an absolute path
    // into the source tree — so packages/*/node_modules/@proteus/* would point
    // back at the pristine repo and a solver's cross-package edits would be
    // invisible to any test that imports through a workspace specifier.
    verbatimSymlinks: true,
    filter: (src) => !excluded.has(src) && !SANDBOX_EXCLUDED_NAMES.has(basename(src)),
  });

  linkNodeModules(repo, dir);

  opts.prepare(dir);

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
    // A directory removed between the parent listing and this read is fine; a permissions failure
    // is not, because it would silently shrink the set of files the guard claims to have scanned.
    const entries = tolerate(() => readdirSync(abs, { withFileTypes: true }), 'enoent');
    if (entries === undefined) return;
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
export function sandboxEnv(proteusHome: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
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
  if (!cmd) throw new Error(`bench check ${check.id} has no command`);
  const started = Date.now();
  return new Promise((resolveOutcome) => {
    execFile(
      cmd, args,
      {
        cwd: check.cwd ? join(dir, check.cwd) : dir,
        env: sandboxEnv(proteusHome),
        timeout: check.timeoutMs ?? 180_000,
        maxBuffer: 32 * 1024 * 1024,
      },
      (err, stdout, stderr) => {
        const combined = `${stdout}${stderr}`;
        const killed = err?.killed ?? false;
        const exitCode = killed
          ? null
          : err === null
            ? 0
            : Number.isSafeInteger(err.code)
              ? Number(err.code)
              : 1;
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
export interface BudgetSignal {
  signal: AbortSignal;
  done: () => void;
  timedOut: () => boolean;
}

export function budgetSignal(budget: AttemptBudget): BudgetSignal {
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

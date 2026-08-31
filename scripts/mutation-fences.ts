/**
 * The mutation-fence gate — a concurrency fence is only proven when its
 * removal turns its owning test RED, and that proof is re-made here on every
 * run rather than left in a commit message.
 *
 * A fence is a guard whose two readings both compile: `this.#owns(gen)` around
 * a stale write, a `spawnedBefore` bound on a sweep, a terminal/resumable split
 * in a classifier. Strip one and nothing typechecks differently — the suite
 * stays green until the interleaving it guarded actually happens, which is a
 * production event and not a test run. Three such fences shipped unfenced in
 * one week (KINU-030's boot-id stamp overwrote its successor's durable id; an
 * unbounded sweep retired a resume's own live heads; a facet classified
 * `resumable` when its ledger row said `errored`), and every one of them had
 * a test that would have caught the unfenced shape — AFTER the fix landed. A
 * red proof that exists only in a commit body is a claim nobody re-runs.
 *
 * So this gate applies each declared mutation MECHANICALLY, in an isolated
 * copy, and requires the owning test to FAIL against the mutant. Green with a
 * mutation applied is the one finding that matters, because it names a fence
 * whose proof has rotted: the test no longer guards what the commit said it
 * guarded, and the next refactor removes the fence with nothing to notice.
 *
 * THE DECLARATION IS ONE LIST. Each fence names its file, a snippet that must
 * sit in that file EXACTLY ONCE (a stale fixture direction is a gate failure,
 * not a pass), the mutation to apply, and the owning test that must go red. A
 * fence whose snippet has moved fails the gate naming the fence — that is the
 * `test:mutation` harness's own rule, re-stated: a mutation whose edit
 * silently missed proves nothing.
 *
 * HOW THE COPY IS MADE. `git worktree add --detach` at the current HEAD under
 * owned scratch, sparsely checked out to the packages the fences and owners
 * live in, because a fence may sit in any package and its owning test may
 * import half the tree: a single-file copy would not resolve. `node_modules`
 * is symlinked to this checkout's, which is the setup-worktree invariant
 * (third-party modules are shared and identical; `@kinu.run/*` resolves
 * through the WORKTREE's own packages). The copy is removed in a `finally`,
 * and the gate NEVER mutates the working tree — the rule `test:mutation`
 * states, kept here for the same reason.
 *
 * THE MEASURED SET versus THE GOVERNED SET, stated rather than implied:
 * MEASURED — every declared fence's file, read once for the exactly-once
 * check, plus the owning suite, run twice. GOVERNED — exactly the fences in
 * FENCES. They are equal because `mutation-fences.test.ts` asserts every
 * declared fence sits in a tracked file, sits there exactly once, and that the
 * gate fails when any direction of the proof is broken.
 *
 * WHAT IT DOES NOT CATCH, printed on the green path: a fence nobody declared.
 * The list is hand-written and nothing enumerates the guards a module
 * contains, so a new fence arrives unproven until somebody adds it here. It
 * also proves only that ONE named test goes red, never that the mutation is
 * the worst reading available. And the owning command runs under `bun test`,
 * so a fence whose owner needs workerd to express its interleaving is outside
 * this gate — that is `bun run test:workerd`'s territory.
 */

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { trackedFiles, workspaceScope } from './sources';

const root = fileURLToPath(new URL('..', import.meta.url));

/**
 * One concurrency fence, and the proof that it is load-bearing.
 *
 * `snippet` must occur exactly once in `file` — the guarded lines the
 * mutation replaces. `mutation` is what replaces it. `owner` is the test whose
 * failure proves the fence: run against the pristine tree it must PASS, run
 * against the mutant it must FAIL.
 */
export interface Fence {
  /** A name the failure output can carry: `module#symbol`. */
  readonly name: string;
  /** Repository-relative path of the file holding the fence. */
  readonly file: string;
  /** The guarded lines, verbatim. Must sit in `file` exactly once. */
  readonly snippet: string;
  /** What replaces `snippet` when the fence is stripped. */
  readonly mutation: string;
  /** The owning suite, and the `--grep` pattern that narrows it. */
  readonly owner: {
    readonly suite: string;
    readonly grep: string;
  };
  /** Why the fence exists, for the failure output when it has rotted. */
  readonly why: string;
}

/**
 * THE DECLARED FENCES. Three today, one per subsystem the tier was built to
 * hammer, each named with the defect its absence shipped.
 *
 * Adding a fence: name `file`, quote the guarded lines as `snippet`, write the
 * strip as `mutation`, and name the test that defends it. The gate itself
 * proves the snippet still sits in the file and that the owner really goes
 * red — both directions are exercised on every run, and
 * `scripts/mutation-fences.test.ts` proves the gate can fail.
 */
export const FENCES: readonly Fence[] = [
  {
    name: 'core/heads/journal#markInterrupted:spawnedBefore-bound',
    file: 'packages/core/src/heads/journal.ts',
    // The first sweep's bound. Nulling `before` strips it: `unfinishedRuns`
    // then reads every open row and the SQL guard `(${before} IS NULL OR …)`
    // is always true, so a head this activation spawned is inside the sweep
    // whichever order the two run in. The owning test seeds a head spawned
    // AFTER the reconciling activation and requires it to survive beside it.
    snippet: `    const before = scope?.spawnedBefore ?? null;
    const runs = this.unfinishedRuns(null, null, before);
    if (runs.length === 0) return [];`,
    mutation: `    const before = null as number | null;
    const runs = this.unfinishedRuns(null, null, before);
    if (runs.length === 0) return [];`,
    owner: {
      suite: 'packages/core/tests/integration-cancelled-fork-visibility.test.ts',
      grep: 'a head the resume spawned in THIS activation survives the sweep beside it',
    },
    why: 'an unbounded sweep retires a resume\'s own live heads: the agent is told, over '
      + 'the one signal seam, that work still running was abandoned',
  },
  {
    name: 'core/heads/journal#abandonRunning:spawnedBefore-bound',
    file: 'packages/core/src/heads/journal.ts',
    // The terminal sweep carries the same bound, and it is the one that
    // destroys work: without it a run this activation re-entered is settled
    // `aborted` with the interrupted-run reason while its executor is still
    // driving it. Same strip shape as the first sweep, applied to the
    // retirement's own read.
    snippet: `    const before = scope?.spawnedBefore ?? null;
    const spared = new Set(scope?.exceptRoots ?? []);`,
    mutation: `    const before = null as number | null;
    const spared = new Set(scope?.exceptRoots ?? []);`,
    owner: {
      suite: 'packages/core/tests/integration-cancelled-fork-visibility.test.ts',
      grep: 'a head the resume spawned in THIS activation survives the sweep beside it',
    },
    why: 'an unbounded retirement settles a live run as `aborted` and tells the agent '
      + 'work still running was abandoned — the exact defect the bound exists to close',
  },
  {
    name: 'devbox#stampBootId:generation-fence',
    file: 'packages/devbox/src/devbox.ts',
    // The stamp's whole ownership fence: the lost-race early return that
    // rewrites the container file to the durable row's id, and the row write
    // that only a live owner may make. Stripping it — writing row and file
    // unconditionally — is exactly the spurious-replacement loop the fix
    // closed: a stale attempt parked in the exec overwrites the successor's
    // identity and the next heartbeat re-drives a healthy box.
    snippet: `    if (!this.#owns(generation)) {
      const settled = await this.ctx.storage.get<string>(BOOT_ID_KEY);
      if (settled !== undefined && settled !== bootId) {
        bootId = settled;
        await this.#rawExec(\`printf %s \${bootId} > \${BOOT_ID_PATH}\`);
      }
      return bootId;
    }
    await this.ctx.storage.put(BOOT_ID_KEY, bootId);`,
    mutation: `    await this.ctx.storage.put(BOOT_ID_KEY, bootId);`,
    owner: {
      suite: 'packages/devbox/tests/stale-stamp-fence.test.ts',
      grep: 'a stamp parked on the stale attempt never regresses the newer boot id',
    },
    why: 'a stale stamp overwrites the successor\'s durable boot id, and the heartbeat\'s '
      + 'replacement detector then reads a mismatch on a healthy container and drives a '
      + 'spurious replacement',
  },
  {
    name: 'cf/orchestrator#explorationFacetLedgerStatus:terminal-classification',
    file: 'packages/cf-backend/src/orchestrator.ts',
    // The terminal/resumable split over the head journal. The pre-fix leak was
    // the INVERSE reading — `errored` and `budget_exceeded` classified
    // `resumable`, so a head that threw kept its facet forever, and because a
    // facet id is never reused that storage is abandoned inside the root DO
    // for the life of the workspace. Reverting the split to the shipped
    // two-of-four shape is the mutation, and the owning test pins it through
    // real journal rows under real facet ids.
    snippet: `    if (headStatusUnsettled(head.status)) return 'resumable';
    return storedHeadReportStatus(head.status) === null ? 'unknown' : 'terminal';`,
    mutation: `    if (headStatusUnsettled(head.status) || head.status === 'errored'
      || head.status === 'budget_exceeded') return 'resumable';
    return storedHeadReportStatus(head.status) === null ? 'unknown' : 'terminal';`,
    owner: {
      suite: 'packages/cf-backend/tests/unit-facet-reconciliation.test.ts',
      grep: 'every terminal head loses its facet; only the executing ones keep theirs',
    },
    why: 'a misclassified facet is either deleted while its run is still resumable '
      + '(data loss) or retained forever after its head settled terminally (a leak '
      + 'into the root DO\'s 65,536-facet lifetime quota)',
  },
] as const;

/** One fence's proof, or the finding that explains the gap. */
export interface FenceResult {
  readonly fence: string;
  /** The pristine owner's exit code. Must be 0. */
  readonly pristineExit: number | null;
  /** The mutant owner's exit code. Must be non-zero. */
  readonly mutantExit: number | null;
  /** The mutant owner's failing output, when it ran. */
  readonly output: string;
}

/** Where the isolated copy lives for the duration of one run. */
function scratchRoot(): string {
  return join(tmpdir(), `kinu-scratch-mutation-fences-${process.pid}`);
}

/** One owning-suite run: what the process did, and what it said while doing it.
 *  `exit` is null when the run never settled — a timeout or a signal, which is
 *  a finding rather than a red. */
export interface SuiteRun {
  readonly exit: number | null;
  readonly output: string;
}

/** Run the owning suite in `cwd` and hand back its exit code and output. */
function runSuite(suite: string, grep: string, cwd: string): SuiteRun {
  const result = spawnSync('bun', ['test', suite, '--grep', grep], {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, KINU_HOME: join(cwd, '.kinu-test-home') },
    timeout: 300_000,
  });
  return {
    exit: result.status,
    output: `${result.stdout ?? ''}${result.stderr ?? ''}`.trim(),
  };
}

/** Whether `fence.snippet` sits in `fence.file` exactly once. */
export function snippetSitsExactlyOnce(fence: Fence): boolean {
  return readFileSync(join(root, fence.file), 'utf8').split(fence.snippet).length - 1 === 1;
}

/**
 * What one run of this gate establishes.
 *
 * `stale` and `untracked` are DECLARATION faults — the fixture moved, or names
 * a path the enumeration does not carry — and they short-circuit the proof,
 * because mutating a snippet that is not there proves nothing. `copyError` is
 * the BLOCKED verdict: the isolated copy could not be built, so no fence was
 * measured and the gate must not read green.
 */
export interface FenceProof {
  readonly results: readonly FenceResult[];
  readonly stale: readonly string[];
  readonly untracked: readonly string[];
  readonly copyError: string | null;
}

/**
 * Prove every declared fence, against an isolated worktree of the CURRENT
 * HEAD. Never the working tree: a mutation that landed there would expose
 * every concurrent reader, and a crash could leave the source stripped.
 */
export function proveFences(fences: readonly Fence[] = FENCES): FenceProof {
  const tracked = new Set(trackedFiles());

  // The declaration must name tracked files. An untracked fence file or owner
  // is one this gate would read through the working tree while the proof ran
  // against HEAD — the set it measures would not be the set it governs.
  const untracked = fences
    .filter((fence) => !tracked.has(fence.file) || !tracked.has(fence.owner.suite))
    .map((fence) => fence.name);

  // The exactly-once check reads THIS checkout, which is the right tree for
  // it: a snippet that has moved here has moved everywhere.
  const stale = fences.filter((fence) => !snippetSitsExactlyOnce(fence)).map((fence) => fence.name);
  if (untracked.length > 0 || stale.length > 0) {
    return { results: [], stale, untracked, copyError: null };
  }

  const copy = scratchRoot();
  rmSync(copy, { recursive: true, force: true });
  const detached = spawnSync(
    'git',
    ['worktree', 'add', '--detach', '--no-checkout', copy, 'HEAD'],
    { cwd: root, encoding: 'utf8' },
  );
  if (detached.status !== 0) {
    return {
      results: [],
      stale: [],
      untracked: [],
      copyError: `git worktree add --detach failed: ${(detached.stderr ?? '').trim()}`,
    };
  }
  try {
    // Sparse: the whole `packages/` tree plus what a `bun test` invocation
    // itself reads. The owning suites resolve `@kinu.run/*` through the
    // worktree's own packages, and a package not in the cone is a suite that
    // fails to load — measured with `packages/test-utils` omitted: the
    // preload could not find `scratch.ts` and every fence "failed".
    const sparse = spawnSync(
      'git',
      ['sparse-checkout', 'set', '--no-cone', ...SPARSE_CONE],
      { cwd: copy, encoding: 'utf8' },
    );
    if (sparse.status !== 0) {
      return {
        results: [],
        stale: [],
        untracked: [],
        copyError: `git sparse-checkout set failed: ${(sparse.stderr ?? '').trim()}`,
      };
    }
    const checkout = spawnSync('git', ['checkout', 'HEAD'], { cwd: copy, encoding: 'utf8' });
    if (checkout.status !== 0) {
      return {
        results: [],
        stale: [],
        untracked: [],
        copyError: `git checkout in the isolated worktree failed: ${(checkout.stderr ?? '').trim()}`,
      };
    }
    const mirrorError = mirrorNodeModules(copy);
    if (mirrorError !== null) {
      return { results: [], stale: [], untracked: [], copyError: mirrorError };
    }
    const results: FenceResult[] = [];
    for (const fence of fences) {
      const pristine = runSuite(fence.owner.suite, fence.owner.grep, copy);

      // Apply the mutation, run the owner, restore — with the restore in a
      // `finally`, so a crashed owner leaves no mutant behind for the NEXT
      // fence's baseline to read as a red pristine.
      const at = join(copy, fence.file);
      const source = readFileSync(at, 'utf8');
      let mutated: SuiteRun;
      if (source.split(fence.snippet).length - 1 !== 1) {
        mutated = {
          exit: null,
          output: 'the snippet no longer sits exactly once in the isolated copy — '
            + 'the fixture has moved between HEAD and this working tree',
        };
      } else {
        // Temp file + rename, so a crash mid-write cannot leave a half-mutated
        // source for the owner to read.
        const staged = `${at}.mutant`;
        writeFileSync(staged, source.replace(fence.snippet, fence.mutation));
        renameSync(staged, at);
        try {
          mutated = runSuite(fence.owner.suite, fence.owner.grep, copy);
        } finally {
          spawnSync('git', ['checkout', '--', fence.file], { cwd: copy, encoding: 'utf8' });
        }
      }
      results.push({
        fence: fence.name,
        pristineExit: pristine.exit,
        mutantExit: mutated.exit,
        output: mutated.output,
      });
    }
    return { results, stale: [], untracked: [], copyError: null };
  } finally {
    spawnSync('git', ['worktree', 'remove', '--force', copy], { cwd: root, encoding: 'utf8' });
    rmSync(copy, { recursive: true, force: true });
  }
}

/** What the isolated copy checks out: every package, and what `bun test`
 *  itself reads. The owning suites resolve `@kinu.run/*` through the
 *  worktree's own packages, so a package missing from the cone is a suite
 *  that fails to load — measured with `packages/test-utils` omitted: the
 *  preload could not find `scratch.ts` and every fence read as failed. */
const SPARSE_CONE = [
  'packages/**',
  'package.json',
  'bunfig.toml',
  'scripts/**',
] as const;

/**
 * Give the isolated copy a node_modules the suites can run against.
 *
 * THE SETUP-WORKTREE INVARIANT, re-stated here because this gate cannot
 * shell out to that script: link every THIRD-PARTY entry (they are shared
 * and identical across worktrees) but rebuild the workspace scope against
 * THIS copy's own packages. One wholesale symlink is the exact defect
 * `tests/workspace-resolution.test.ts` exists to catch, and it caught it:
 * `@kinu.run/test-utils` resolved to the donor's packages and every
 * workspace-resolution suite in the copy went red. The donor is THIS
 * checkout's node_modules, whose third-party entries are the ones the
 * working tree's own suites already run against.
 *
 * Returns null on success, or the reason the mirror could not be built —
 * which is a BLOCKED gate, never a green one.
 */
function mirrorNodeModules(copy: string): string | null {
  const donor = join(root, 'node_modules');
  if (!existsSync(donor)) {
    return `no node_modules at ${donor} to mirror into the isolated copy`;
  }
  // The scope and the package list come from the ONE enumeration, never from a
  // walk of the copy: `workspaceScope()` reads the manifests git lists, so a
  // renamed scope or a new package moves both sides at once.
  const scope = workspaceScope();
  const packages = trackedFiles()
    .filter((file) => /^packages\/[^/]+\/package\.json$/.test(file))
    .map((file) => file.split('/')[1] ?? '')
    .filter((name) => name.length > 0);
  if (packages.length === 0) {
    return 'the enumeration lists no packages/*/package.json to rebuild the scope from';
  }
  const target = join(copy, 'node_modules');
  mkdirSync(target, { recursive: true });
  for (const entry of readdirSync(donor, { withFileTypes: true })) {
    // The workspace scope is rebuilt below, never linked: its entries are
    // relative to the donor, which is precisely how they end up back there.
    if (entry.name === scope) continue;
    rmSync(join(target, entry.name), { recursive: true, force: true });
    symlinkSync(join(donor, entry.name), join(target, entry.name), 'dir');
  }
  const scopeDir = join(target, scope);
  mkdirSync(scopeDir, { recursive: true });
  for (const directory of packages) {
    const manifest = readFileSync(join(copy, 'packages', directory, 'package.json'), 'utf8');
    const name = /"name"\s*:\s*"([^"]+)"/.exec(manifest)?.[1];
    if (name === undefined || !name.startsWith(`${scope}/`)) continue;
    const short = name.slice(scope.length + 1);
    rmSync(join(scopeDir, short), { recursive: true, force: true });
    // RELATIVE, and resolved from inside the copy: an absolute link to the
    // donor's packages is the wholesale-borrow defect this whole function
    // exists to avoid.
    symlinkSync(`../../packages/${directory}`, join(scopeDir, short), 'dir');
  }
  return null;
}

/* ── The verdict ──────────────────────────────────────────────────────── */

if (import.meta.main) {
  const { results, stale, untracked, copyError } = proveFences();

  if (copyError !== null) {
    console.error(`mutation-fences: BLOCKED — ${copyError}`);
    console.error('  This is NOT a pass. No fence was proved.');
    process.exit(1);
  }

  if (FENCES.length <= 0) {
    console.error(
      'mutation-fences: measured nothing — a gate that scans no fences cannot fail.',
    );
    process.exit(1);
  }

  const findings: string[] = [];
  for (const name of untracked) {
    findings.push(`  ${name}\n    must:      name a tracked file and a tracked owning suite\n`
      + '    found:     one of the two is not in the enumeration\n'
      + '    silently: the gate would read the working tree while the proof ran elsewhere\n'
      + '    fix:      point the fence at a tracked path');
  }
  for (const name of stale) {
    findings.push(`  ${name}\n    must:      its snippet sit in its file exactly once\n`
      + '    found:     the snippet moved or duplicated\n'
      + '    silently: the mutation would apply to the wrong site, or to none, and the\n'
      + '               gate would read green over a proof nobody made\n'
      + '    fix:      re-quote the guarded lines from the file as it stands');
  }
  for (const result of results) {
    if (result.pristineExit !== 0) {
      findings.push(`  ${result.fence}\n    must:      its owning test pass on the pristine tree\n`
        + `    found:     exit ${String(result.pristineExit)}\n`
        + '    silently: a red baseline makes every later comparison meaningless — the\n'
        + '               owner is broken independently of the fence\n'
        + '    fix:      repair the owning suite first');
    }
    if (result.mutantExit === 0) {
      findings.push(`  ${result.fence}\n    must:      its owning test FAIL once the fence is stripped\n`
        + '    found:     the mutant passed — the proof has rotted\n'
        + '    silently: the fence reads load-bearing while no test guards it; the next\n'
        + '               refactor removes it and nothing notices\n'
        + '    fix:      restore the owning test\'s red direction, or re-quote the snippet');
    }
    if (result.mutantExit === null) {
      findings.push(`  ${result.fence}\n    must:      its owning test FAIL once the fence is stripped\n`
        + `    found:     the mutant run never settled: ${result.output.slice(0, 400)}\n`
        + '    silently: a hung or unrunnable owner is indistinguishable from a pass\n'
        + '    fix:      run the owning suite by hand in an isolated worktree');
    }
  }

  if (findings.length > 0) {
    console.error(`mutation-fences: ${String(findings.length)} finding(s)\n`);
    for (const finding of findings) console.error(finding);
    process.exit(1);
  }

  console.log(
    `mutation-fences: ok — ${String(FENCES.length)} fence(s) proved: each owning test `
    + 'green on the pristine tree, red on its mutant',
  );
  console.log(
    '\nBlind spots, printed on the green path because a limitation visible only in red\n'
    + 'output is invisible exactly when the tree is clean:\n'
    + '  - a fence nobody declared. The list is hand-written; nothing enumerates the\n'
    + '    guards a module contains, so a new fence arrives unproven until it is added\n'
    + `    here. ${String(FENCES.length)} are declared; the tree holds more.\n`
    + '  - the worst reading. Each mutation is ONE named strip, not an exhaustive\n'
    + '    search over the ways a fence can be defeated.\n'
    + '  - fences whose interleaving needs workerd. The owning commands run under\n'
    + '    `bun test`; `bun run test:workerd` owns that half.\n'
    + '  - the ISOLATED COPY at HEAD, not your working tree. A fence in uncommitted\n'
    + '    work is invisible until it lands — commit before trusting this green.\n'
    + '  - one test per fence. That a suite OTHER than the owner also catches the\n'
    + '    mutation is unmeasured, in both directions.',
  );
}

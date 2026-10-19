// Shadow-git checkpoint engine, the one both the CLI and the device daemon run.
// It imports no value: the host hands it the filesystem, paths, the platform's dirs, hashing and git, so the copy
// runs in the daemon's dependency-free JavaScript unchanged. One set of rules:
//   - no wall clock on git: it ends on its own, and a bounded buffer keeps this process's heap;
//   - one operation at a time, in arrival order: git keeps one index per store, and a restore rewrites the tree a
//     snapshot reads;
//   - one snapshot per agent, directory and turn, taken before the mutation it precedes, never blocking it;
//   - a workdir climbs from the entry itself (`lstat`: moving a link changes the directory holding it), never
//     through the shared temp directory, the home folder, or a directory `covers` refuses.

import type {
  CheckpointAvailability, CheckpointTurnMeta, FileCheckpointEntry, FileRestoreChange, FileRestorePlan, FileRestoreResult,
} from './types';
import {
  CHECKPOINT_EXCLUDES, CHECKPOINT_REF_PREFIX, CHECKPOINT_WORKDIR_MARKER, CHECKPOINTS_UNAVAILABLE_NO_GIT,
  checkpointReason, checkpointRefTimestampMs, checkpointSubject, parseCheckpointSubject, stagingOutcome,
} from './format';

/** What marks a project directory, the snapshot unit a file write climbs to. */
export const PROJECT_MARKERS = ['.git', 'package.json', 'pyproject.toml', 'Cargo.toml', 'go.mod', 'Makefile', '.hg'];

const SHA_RE = /^[0-9a-f]{4,64}$/i;

/** git's output this process keeps in memory, at most. */
const GIT_OUTPUT_BYTES = 32 * 1024 * 1024;

/** Paths one restore's `git clean` names: well under any system's argument vector at a path's usual length. */
const RESTORE_DELETE_BATCH = 500;

/** A git run: `code` null when git never finished (a signal, an overfull buffer); `missing` when it could not start. */
interface CheckpointGitRun {
  readonly code: number | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly missing: boolean;
}

/** The node modules the engine reads through, as both hosts hand them over. */
/**
 * `C`: how the host confines the git that touches a work tree, its own and opaque here. A device's daemon runs it in the
 * frame's sandbox, so a directory of the tree a command swapped for a link out of its roots leads nowhere (L111 #3);
 * null runs it as the host's own process, as the CLI always does.
 */
export interface CheckpointHost<C> {
  readonly fs: {
    existsSync(path: string): boolean;
    statSync(path: string): { isDirectory(): boolean };
    lstatSync(path: string): { isDirectory(): boolean };
    realpathSync(path: string): string;
    readdirSync(path: string): string[];
    readFileSync(path: string, encoding: 'utf8'): string;
    writeFileSync(path: string, text: string): void;
    mkdirSync(path: string, options: { recursive: true }): void;
  };
  readonly path: {
    resolve(...paths: string[]): string;
    join(...paths: string[]): string;
    dirname(path: string): string;
    parse(path: string): { root: string };
  };
  readonly homedir: string;
  readonly tmpdir: string;
  readonly devNull: string;
  /** The process environment the git child inherits, less every `GIT_*` name. */
  readonly env: Readonly<Record<string, string | undefined>>;
  sha256(text: string): string;
  /** Runs `bin` to its exit with no deadline; `maxBuffer` bounds what it may print. A work tree's run is `confine`d. */
  run(bin: string, args: readonly string[], options: { cwd: string; env: GitEnvironment; maxBuffer: number; confine: C | null }): Promise<CheckpointGitRun>;
  now(): number;
  /** Told of a snapshot that failed: it never blocks the mutation it preceded, so this is where it is seen. */
  log(message: string): void;
}

export interface CheckpointEngineOptions {
  /** Shadow store root: `<home>/checkpoints`. */
  readonly base: string;
  /** Checkpoints kept per working directory. */
  readonly keep: number;
  readonly gitBin: string;
}

/** A snapshot a mutation asks for. `turn` null is out of any turn: the turn key is `no-turn`. */
interface CheckpointRequest<C> {
  readonly agent: string;
  readonly dir: string;
  readonly turn: CheckpointTurnMeta | null;
  readonly reason: string;
  readonly confine: C | null;
}

/** What a request got: the checkpoint id (null when the directory is no work tree), or why none was taken. */
export type CheckpointOutcome = { readonly id: string | null } | { readonly skipped: string };

export interface CheckpointEngine<C> {
  status(): Promise<CheckpointAvailability>;
  /** One snapshot per agent, directory and turn, in store order: null when this turn's already covers it. Never throws. */
  ensure(request: CheckpointRequest<C>): Promise<CheckpointOutcome | null>;
  /** `apply` after the snapshot `request` asks for, in store order, handed that snapshot's outcome. */
  mutate<A>(request: CheckpointRequest<C> | null, apply: (outcome: CheckpointOutcome | null) => A | Promise<A>): Promise<A>;
  /** Newest first; `turnId` filters before `limit` cuts, since retention is per directory and the limit is global. */
  list(agent: string, query: { readonly limit?: number; readonly turnId?: string | null }): Promise<FileCheckpointEntry[]>;
  plan(agent: string, dir: string, id: string, confine: C | null): Promise<FileRestorePlan>;
  /** Takes a pre-restore safety snapshot first. */
  restore(agent: string, dir: string, id: string, confine: C | null): Promise<FileRestoreResult>;
  /** The project directory holding `path`, climbing only through directories `covers` admits. */
  workdirForPath(path: string, covers?: (dir: string) => boolean): string;
}

function failed(message: string): Error {
  return new Error(message);
}

/** The environment a git child runs under. */
interface GitEnvironment { [name: string]: string }

/** Where one git runs: its directory and environment, and the host's confinement for a work tree's (null for none). */
interface GitPlace<C> {
  readonly cwd: string;
  readonly env: GitEnvironment;
  readonly confine: C | null;
}

/** A failure and each cause under it, outermost first: the frame naming the real fault is often a cause deeper. */
function causeText(failure: Error): string {
  const links = [failure.message];

  for (let at = failure.cause; at instanceof Error; at = at.cause) links.push(at.message);

  return links.join(': ');
}

/** A `diff-tree --name-status` letter in restore direction (current to checkpoint). */
function restoreKindOf(status: string): FileRestoreChange['kind'] {
  if (status === 'A') return 'create';

  return status === 'D' ? 'delete' : 'modify';
}

export function createCheckpointEngine<C>(host: CheckpointHost<C>, options: CheckpointEngineOptions): CheckpointEngine<C> {
  const { fs: disk, path: paths } = host;
  const keep = Math.max(1, options.keep);
  const unsnapshottable = new Set([host.tmpdir, '/tmp', '/var/tmp'].map((dir) => paths.resolve(dir)));
  let gitAvailable: boolean | null = null;
  let refSeq = 0;
  /** `${agent}|${dir}` → the turn whose snapshot was taken. A failed one is never recorded, so the next mutation retries. */
  const turnDone = new Map<string, string>();

  const isolatedEnv = (): GitEnvironment => {
    const env: GitEnvironment = {};

    for (const [name, value] of Object.entries(host.env)) {
      if (value !== undefined && !name.startsWith('GIT_')) env[name] = value;
    }

    env.GIT_CONFIG_GLOBAL = host.devNull;
    env.GIT_CONFIG_SYSTEM = host.devNull;
    env.GIT_CONFIG_NOSYSTEM = '1';
    env.GIT_AUTHOR_NAME = 'Kinu Checkpoint';
    env.GIT_AUTHOR_EMAIL = 'checkpoints@kinu.local';
    env.GIT_COMMITTER_NAME = 'Kinu Checkpoint';
    env.GIT_COMMITTER_EMAIL = 'checkpoints@kinu.local';
    // `stagingOutcome` parses git's own English diagnostics.
    env.LC_ALL = 'C';

    return env;
  };

  const storeEnv = (gitDir: string, workdir: string): GitEnvironment => ({ ...isolatedEnv(), GIT_DIR: gitDir, GIT_WORK_TREE: workdir });

  /** A store's own objects, refs and index, with no work tree: run in the store, which no command reaches. */
  const storeOnly = (gitDir: string): GitPlace<C> => ({ cwd: gitDir, env: { ...isolatedEnv(), GIT_DIR: gitDir }, confine: null });

  /** A work tree with its store: run in the tree, `confine`d. */
  const inTree = (gitDir: string, workdir: string, confine: C | null): GitPlace<C> => ({ cwd: workdir, env: storeEnv(gitDir, workdir), confine });

  /** Neither a store nor a work tree: the host's own, as `--version` and a store's init are. */
  const outside = (cwd: string): GitPlace<C> => ({ cwd, env: isolatedEnv(), confine: null });

  /** A missing cwd fails the spawn the way a missing binary does; it is checked so it never reads as "no git". */
  const runGit = async (args: readonly string[], { cwd, env, confine }: GitPlace<C>): Promise<CheckpointGitRun> => {
    if (!disk.existsSync(cwd)) return { code: 1, stdout: '', stderr: `working directory not found: ${cwd}`, missing: false };
    const run = await host.run(options.gitBin, args, { cwd, env, maxBuffer: GIT_OUTPUT_BYTES, confine });

    if (run.missing) {
      gitAvailable = false;
      throw failed(CHECKPOINTS_UNAVAILABLE_NO_GIT);
    }

    gitAvailable = true;

    return run;
  };

  /** git's stdout, or its stderr thrown. */
  const git = async (args: readonly string[], at: GitPlace<C>, doing: string): Promise<string> => {
    const run = await runGit(args, at);

    const said = run.stderr.trim();

    if (run.code !== 0) throw failed(`${doing}: ${said === '' ? `git exited ${String(run.code)}` : said}`);

    return run.stdout;
  };

  const probeGit = async (): Promise<boolean> => {
    if (gitAvailable !== null) return gitAvailable;

    try {
      await runGit(['--version'], outside(host.homedir));
    } catch (error) {
      // A rejection that did not record a missing git is not one.
      if (gitAvailable !== false) throw error;
    }

    return gitAvailable ?? false;
  };

  const sanitizeAgent = (agent: string): string => (agent === '' ? 'agent' : agent).replace(/[^A-Za-z0-9_-]/g, '_');
  const storeDirFor = (agent: string, dir: string): string => paths.join(options.base, sanitizeAgent(agent), host.sha256(paths.resolve(dir)).slice(0, 16));

  const initStore = async (gitDir: string, workdir: string): Promise<void> => {
    if (disk.existsSync(paths.join(gitDir, 'HEAD'))) return;
    disk.mkdirSync(gitDir, { recursive: true });
    await git(['init', '--bare', '--quiet', gitDir], outside(paths.dirname(gitDir)), 'checkpoint store init failed');
    disk.mkdirSync(paths.join(gitDir, 'info'), { recursive: true });
    disk.writeFileSync(paths.join(gitDir, 'info', 'exclude'), CHECKPOINT_EXCLUDES.join('\n') + '\n');
    disk.writeFileSync(paths.join(gitDir, CHECKPOINT_WORKDIR_MARKER), paths.resolve(workdir) + '\n');
  };

  /** Why `dir` is no work tree to snapshot, or null when it is one. */
  const snapshotSkipped = (dir: string): string | null => {
    const abs = paths.resolve(dir);

    if (abs === paths.parse(abs).root || abs === paths.resolve(host.homedir)) return 'it is the filesystem root or the owner\'s home folder itself';

    // `workdirForPath` resolves a bare `/tmp/x.js` to `/tmp`, which holds every process's scratch.
    if (unsnapshottable.has(abs)) return 'it is a temp directory every process shares';

    if (!disk.existsSync(abs)) return 'it does not exist';

    return disk.statSync(abs).isDirectory() ? null : 'it is not a directory';
  };

  const storeRefs = async (gitDir: string): Promise<Array<{ ref: string; id: string; subject: string }>> => {
    const run = await runGit(['for-each-ref', '--sort=-refname', '--format=%(refname)|%(objectname)|%(subject)', CHECKPOINT_REF_PREFIX], storeOnly(gitDir));

    if (run.code !== 0) return [];

    return run.stdout.split('\n').filter(Boolean).map((line) => {
      const [ref = '', id = '', ...rest] = line.split('|');

      return { ref, id, subject: rest.join('|') };
    });
  };

  /** `--ignore-errors`, so an unreadable path costs only that path; the skipped paths are named in the reason. The add
   *  reads the work tree, `confine`d; the tree is written in the store. */
  const stageCurrent = async (gitDir: string, workdir: string, confine: C | null): Promise<{ tree: string; unreadable: string[] }> => {
    const add = await runGit(['add', '-A', '--ignore-errors'], inTree(gitDir, workdir, confine));
    const staged = stagingOutcome(add.code, add.stderr);

    if ('failure' in staged) throw failed(staged.failure);

    return { tree: (await git(['write-tree'], storeOnly(gitDir), 'checkpoint write-tree failed')).trim(), unreadable: staged.unreadable };
  };

  /** The new checkpoint's id, or the newest one's when nothing changed; null when `dir` is no work tree. */
  const snapshot = async ({ agent, dir, turn, reason, confine }: CheckpointRequest<C>): Promise<string | null> => {
    if (snapshotSkipped(dir) !== null) return null;
    const abs = paths.resolve(dir);
    const gitDir = storeDirFor(agent, abs);

    await initStore(gitDir, abs);
    const staged = await stageCurrent(gitDir, abs, confine);
    const store = storeOnly(gitDir);
    const refs = await storeRefs(gitDir);
    const latest = refs[0];

    if (latest !== undefined && (await runGit(['rev-parse', `${latest.id}^{tree}`], store)).stdout.trim() === staged.tree) return latest.id;

    const subject = checkpointSubject(turn, checkpointReason(reason, staged.unreadable));
    const sha = (await git(['commit-tree', staged.tree, '-m', subject], store, 'checkpoint commit failed')).trim();
    const refName = `${CHECKPOINT_REF_PREFIX}/${String(host.now()).padStart(13, '0')}-${(refSeq++).toString(36).padStart(3, '0')}`;

    await git(['update-ref', refName, sha], store, 'checkpoint ref update failed');

    if (refs.length + 1 > keep) {
      for (const stale of (await storeRefs(gitDir)).slice(keep)) await runGit(['update-ref', '-d', stale.ref], store);
      await runGit(['prune', '--expire=now'], store);
    }

    return sha;
  };

  const requireCheckpoint = async (agent: string, dir: string, id: string): Promise<{ gitDir: string; abs: string }> => {
    if (!SHA_RE.test(id)) throw failed(`invalid checkpoint id: ${id}`);
    const abs = paths.resolve(dir);
    const gitDir = storeDirFor(agent, abs);

    if (!disk.existsSync(paths.join(gitDir, 'HEAD'))) throw failed(`no checkpoints exist for ${abs}`);

    if ((await runGit(['rev-parse', '--verify', `${id}^{commit}`], storeOnly(gitDir))).code !== 0) throw failed(`checkpoint not found: ${id}`);

    return { gitDir, abs };
  };

  /** The current tree against the checkpoint's, in restore direction; an unreadable path is in neither. */
  const diffToCheckpoint = async (gitDir: string, abs: string, id: string, confine: C | null): Promise<FileRestoreChange[]> => {
    const current = await stageCurrent(gitDir, abs, confine);
    const out = await git(['diff-tree', '-r', '--name-status', current.tree, `${id}^{tree}`], storeOnly(gitDir), 'checkpoint diff failed');

    return out.split('\n').flatMap((line): FileRestoreChange[] => {
      const tab = line.indexOf('\t');

      if (tab < 0) return [];
      const status = line.slice(0, tab);

      return [{ path: line.slice(tab + 1), kind: restoreKindOf(status) }];
    });
  };

  const listEntries = async (agent: string, query: { readonly limit?: number; readonly turnId?: string | null }): Promise<FileCheckpointEntry[]> => {
    if (!(await probeGit())) return [];
    const agentBase = paths.join(options.base, sanitizeAgent(agent));

    // No store directory means this agent has taken no checkpoints.
    if (!disk.existsSync(agentBase)) return [];
    const entries: FileCheckpointEntry[] = [];

    for (const name of disk.readdirSync(agentBase)) {
      const gitDir = paths.join(agentBase, name);
      const marker = paths.join(gitDir, CHECKPOINT_WORKDIR_MARKER);

      if (!disk.existsSync(paths.join(gitDir, 'HEAD')) || !disk.existsSync(marker)) continue;
      const workdir = disk.readFileSync(marker, 'utf8').trim();

      for (const ref of await storeRefs(gitDir)) {
        const meta = parseCheckpointSubject(ref.subject);

        if (typeof query.turnId === 'string' && meta.turnId !== query.turnId) continue;
        entries.push({ id: ref.id, dir: workdir, at: checkpointRefTimestampMs(ref.ref), ...meta });
      }
    }

    entries.sort((a, b) => b.at - a.at);

    return entries.slice(0, Math.max(1, query.limit ?? 50));
  };

  const restoreTo = async (agent: string, dir: string, id: string, confine: C | null): Promise<FileRestoreResult> => {
    if (!(await probeGit())) throw failed(CHECKPOINTS_UNAVAILABLE_NO_GIT);
    const { gitDir, abs } = await requireCheckpoint(agent, dir, id);

    if (!disk.existsSync(abs)) throw failed(`working directory no longer exists: ${abs}`);
    const files = await diffToCheckpoint(gitDir, abs, id, confine);
    // Out of any turn, so the restore is undoable without joining the armed turn's group.
    const preRestoreId = await snapshot({ agent, dir: abs, turn: null, reason: 'pre-restore', confine });
    const tree = inTree(gitDir, abs, confine);

    await git(['read-tree', id], storeOnly(gitDir), 'checkpoint read-tree failed');
    // Files created since the checkpoint are untracked in its index: git removes them in the work tree, as it checks
    // the checkpoint's tree out, both `confine`d, never by a path this process opens itself. Literal pathspecs, a
    // batch at a time, so no name reads as a pattern and no list outgrows an argument vector.
    const deleted = files.filter((change) => change.kind === 'delete').map((change) => change.path);

    for (let at = 0; at < deleted.length; at += RESTORE_DELETE_BATCH) {
      await git(['--literal-pathspecs', 'clean', '-f', '-q', '--', ...deleted.slice(at, at + RESTORE_DELETE_BATCH)], tree, 'checkpoint restore failed');
    }

    await git(['checkout-index', '-a', '-f'], tree, 'checkpoint restore failed');

    return { dir: abs, id, files, preRestoreId };
  };

  const ensureNow = async (request: CheckpointRequest<C>): Promise<CheckpointOutcome | null> => {
    try {
      if (!(await probeGit())) return { skipped: 'this machine has no git to take one with' };
      const abs = paths.resolve(request.dir);
      const skipped = snapshotSkipped(abs);

      if (skipped !== null) return { skipped };
      const key = `${sanitizeAgent(request.agent)}|${abs}`;
      const turnKey = request.turn?.turnId ?? 'no-turn';

      if (turnDone.get(key) === turnKey) return null;
      const id = await snapshot({ ...request, dir: abs });

      turnDone.set(key, turnKey);

      return { id };
    } catch (error) {
      const skipped = `the snapshot failed: ${error instanceof Error ? causeText(error) : 'it threw something that is not an Error'}`;

      host.log(`checkpoint ${skipped} (the mutation it preceded runs)`);

      return { skipped };
    }
  };

  let queue: Promise<unknown> = Promise.resolve();

  const inOrder = <A>(operation: () => Promise<A>): Promise<A> => {
    const run = queue.then(operation);

    queue = Promise.allSettled([run]);

    return run;
  };

  return {
    status: () => inOrder(async (): Promise<CheckpointAvailability> => ((await probeGit())
      ? { available: true }
      : { available: false, reason: CHECKPOINTS_UNAVAILABLE_NO_GIT })),
    ensure: (request) => inOrder(() => ensureNow(request)),
    mutate: (request, apply) => inOrder(async () => apply(request === null ? null : await ensureNow(request))),
    list: (agent, query) => inOrder(() => listEntries(agent, query)),
    plan: (agent, dir, id, confine) => inOrder(async (): Promise<FileRestorePlan> => {
      if (!(await probeGit())) throw failed(CHECKPOINTS_UNAVAILABLE_NO_GIT);
      const { gitDir, abs } = await requireCheckpoint(agent, dir, id);

      return { dir: abs, id, files: await diffToCheckpoint(gitDir, abs, id, confine) };
    }),
    restore: (agent, dir, id, confine) => inOrder(() => restoreTo(agent, dir, id, confine)),
    workdirForPath(target, covers = () => true) {
      const abs = paths.resolve(target);
      // The entry itself, never what a link points at: moving or removing a link changes the directory holding it.
      const candidate = disk.existsSync(abs) && disk.lstatSync(abs).isDirectory() ? abs : paths.dirname(abs);
      const home = paths.resolve(host.homedir);
      // Stop at the temp directory, resolved and real (scripts/preflight.ts refuses a marker above it): a marker there
      // claimed every write beneath it, 24,483 ms for one device write (2026-09-02).
      const temp = paths.resolve(host.tmpdir);
      const realTemp = disk.existsSync(temp) ? disk.realpathSync(temp) : temp;
      let probe = candidate;

      while (probe !== paths.dirname(probe) && probe !== home && covers(probe)) {
        const real = disk.existsSync(probe) ? disk.realpathSync(probe) : probe;

        if (probe === temp || real === realTemp) break;

        if (PROJECT_MARKERS.some((marker) => disk.existsSync(paths.join(probe, marker)))) return probe;
        probe = paths.dirname(probe);
      }

      return candidate;
    },
  };
}

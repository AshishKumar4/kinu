/**
 * Change-set read model: the workspace's own plane against a baseline, a Nimbus snapshot of the store taken at each
 * review (the one before it kept for Undo); other executors by read-only git diff. A read with no baseline captures
 * the first, as creation does; otherwise a read never moves it.
 */

import type { CredentialedVfs, SnapshotInfo, SqliteVFS } from '@nimbus-sh/core/vfs/sqlite-vfs.js';
import { Cause, Effect } from 'effect';
import type { VfsCred } from '@nimbus-sh/core/vfs/vfs.js';
import type { AgentRuntime } from '../types/agent-runtime';
import { PLATFORM_CATALOG } from '../platform-catalog';
import { diffLines, fileDiff, parseGitDiff, type FileDiff, type FileStatus, type Omitted } from '../vfs/diff';
import { nanoid } from '../utils/nanoid';
import * as v from 'valibot';
import { CommandResultSchema } from '../execution/exec-result';
import { attempt, diagnostics, KinuError, renderThrownChain, settle, tolerate, type ErrorCode } from '../obs/index';
import { shellQuote } from '../utils/shell';
import { SHARED_ROOTS, UPLOADS_ROOT, WORKSPACE_ROOT } from '../vfs/workspace-path';

/**
 * A side past this is listed as large, without a body (a write's preview too). Nimbus's diff does not say whether it
 * was the content or only the metadata that moved, so a large file whose mode alone changed is listed too (ASK:
 * `VfsDiffEntry` names a content change). It was one SQLite row (2 MB) until the row rose to 8 MiB (2026-10-21), and
 * stays: what it bounds is the minimal line diff the request computes of two sides and the page that shows it, which
 * the row did not change.
 */
const DIFF_BODY_MAX_BYTES = 2 * 1000 * 1000;

export function bodyMaxBytes(): number {
  return DIFF_BODY_MAX_BYTES;
}

/** Quarter of the facet RPC ceiling: the reply is UTF-16 in the isolate plus per-line overhead. Read on call: the browser
 *  reaches this module, and a module-scope catalog read ships the whole catalog to it.
 *  Files past it are listed with +/- counts and no body. */
function maxChangesetBodyChars(): number {
  return PLATFORM_CATALOG['do.facet.rpc_bytes'].limit.value / 4;
}

/** Installed dependency trees: installs, not work, and costly to walk. Hidden ones fall under {@link reviewed}. */
const DEPENDENCY_TREES: ReadonlySet<string> = new Set(['__pycache__', 'node_modules', 'venv']);

/** Hidden files and folders, and dependency trees, are never reviewed (owner, 2026-09-25). */
function reviewed(name: string): boolean {
  return !name.startsWith('.') && !DEPENDENCY_TREES.has(name);
}

/**
 * Under the store's root the change-set reviews every agent's home and the shared roots, and nothing else (owner,
 * 2026-09-25), but the person's own uploads: Changes is the agents' work (owner, 2026-10-25). An upload an agent edits
 * in place is not listed either: the change-set knows what moved since the review, not who moved it, and an upload saved
 * after the review reads exactly as an agent's write there.
 */
const REVIEWED_UNDER_ROOT = ['home', ...SHARED_ROOTS.filter((root) => root !== UPLOADS_ROOT).map((root) => root.slice(1))];

/** Where the change-set names a path relative to the working directory, as the shell starting there does. */
const WORKING_DIRECTORY = `${WORKSPACE_ROOT.slice(1)}/`;

/** The dependency trees the scan never enters, as find names them. */
const PRUNED_FOLDERS = [...DEPENDENCY_TREES].map((name) => `-name ${shellQuote(name)}`).join(' -o ');

/** Opens each record of the git view, at a line start. */
const MARK = '\u0001';

const HeadCommitSchema = v.pipe(v.string(), v.hexadecimal(), v.minLength(40), v.maxLength(64));

export interface WorkspaceDiffResult {
  files: FileDiff[];
  /** When the baseline these changes are measured against was captured. */
  trackedSince: number;
  baseline: string;
}

export interface ExecutorDiffResult {
  files: FileDiff[];
  mode: 'git' | 'vfs-baseline';
  trackedSince?: number;
  baseline?: string;
  /** The git view's repositories, as the folders their files are listed under. */
  repositories?: string[];
  notGitRepo?: boolean;
  error?: string;
}

/** What the change-set asks of the workspace store, Nimbus's SqliteVFS: its snapshots, and reads as one principal. */
type WorkspaceBaselineStore = Pick<SqliteVFS, 'snapshot' | 'snapshots' | 'dropSnapshotAsync' | 'diff' | 'at' | 'as'>;

/** The store, and the principal the change-set reads it as: a file that principal may not read is absent. */
export interface WorkspaceBaselines {
  readonly store: WorkspaceBaselineStore;
  readonly cred: VfsCred;
}

/** The baseline read model serves one actor's reviews. */
type WorkspaceBaselineRuntime = Pick<AgentRuntime, 'actor'>;

/** This actor's reviews are the snapshots named `diffs:<actor id>:<id>`. */
function reviewPrefix(rt: WorkspaceBaselineRuntime): string {
  return `diffs:${rt.actor.actorId}:`;
}

/** This actor's reviews, oldest first: the last is the baseline, the one before it Undo's target. */
function reviews(rt: WorkspaceBaselineRuntime, store: WorkspaceBaselineStore): SnapshotInfo[] {
  rt.actor.assertCurrent();
  const prefix = reviewPrefix(rt);

  return store.snapshots().filter((snapshot) => snapshot.name.startsWith(prefix));
}

/**
 * The change-set's name for a store path: under the working directory relative to it, any other reviewed path
 * absolute. Null for a path it never reviews: outside the homes and the slates, hidden, or in a dependency tree.
 */
function reviewedPath(path: string): string | null {
  const names = path.split('/');

  if (!REVIEWED_UNDER_ROOT.includes(names[0] ?? '') || !names.every(reviewed)) return null;

  if (!path.includes('/')) return null;

  return path.startsWith(WORKING_DIRECTORY) ? path.slice(WORKING_DIRECTORY.length) : `/${path}`;
}

/** One side of a changed path: its bytes' text, null for a binary file or one past {@link bodyMaxBytes}. */
interface Side {
  readonly bytes: Uint8Array | null;
  readonly text: string | null;
  readonly size: number;
}

/** A link's contents are its target text, told apart from a file holding the same text, so a swap is a change. */
const LINK_TAG = new TextEncoder().encode('symlink\0');

/** What a side of a path is before its bytes are read. */
type Present = NonNullable<ReturnType<CredentialedVfs['statIfPresent']>>;

/** Gone between its stat and its read, as unreadable: neither is in the snapshot. */
function unlessGone<A>(read: () => A): A | undefined {
  return tolerate(() => tolerate(read, 'enoent'), 'eacces');
}

/**
 * `path` as `files` holds it, a symbolic link not followed. Undefined for a directory, and when it is not there or this
 * principal may not read it: a snapshot of a file that is gone does not contain it.
 */
function presentIn(files: CredentialedVfs, path: string): Present | undefined {
  return unlessGone(() => {
    const stat = files.statIfPresent(path, false);

    return stat === null || stat.type === 'directory' ? undefined : stat;
  });
}

/** A present side's bytes, a link's its target text. */
function sideOf(files: CredentialedVfs, path: string, { type, size }: Present): Side | undefined {
  return unlessGone((): Side => {
    if (type === 'symlink') {
      const target = files.readlink(path);
      const text = new TextEncoder().encode(target);

      return { bytes: new Uint8Array([...LINK_TAG, ...text]), text: target, size: text.byteLength };
    }

    if (size > bodyMaxBytes()) return { bytes: null, text: null, size };
    const bytes = files.readFile(path);

    return { bytes, text: bytes.includes(0) ? null : new TextDecoder().decode(bytes), size };
  });
}

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  return a.byteLength === b.byteLength && a.every((byte, i) => byte === b[i]);
}

/** Why a side of this size has no text: past {@link bodyMaxBytes}, or binary. */
function unread(size: number): Omitted {
  return size > bodyMaxBytes() ? 'large' : 'binary';
}

/** A file's two texts, null where a side could not be read, and the reason to give if one could not. */
interface Sides {
  readonly before: string | null;
  readonly after: string | null;
  readonly omitted: Omitted;
}

/** O(1) review publication. */
async function capture(rt: WorkspaceBaselineRuntime, store: WorkspaceBaselineStore): Promise<SnapshotInfo> {
  rt.actor.assertCurrent();

  return store.snapshot(`${reviewPrefix(rt)}${nanoid()}`);
}

/**
 * A path the change-set lists: how it moved since the review, and its sides, read only as asked. A path both sides hold
 * was read to compare, and is listed only if its bytes differ.
 */
interface Moved {
  readonly path: string;
  readonly status: FileStatus;
  readonly was: () => Side | undefined;
  readonly is: () => Side | undefined;
}

/**
 * Each reviewed path that moved since the baseline, in path order: only the paths the store wrote since the review are
 * examined, and a side's bytes are read only to compare two it holds.
 */
function* movedSince(store: WorkspaceBaselineStore, baseline: string, then: CredentialedVfs, now: CredentialedVfs): Generator<Moved> {
  for (let after: string | undefined, more = true; more;) {
    const page = store.diff(baseline, null, after === undefined ? {} : { after });

    for (const entry of page.entries) {
      const path = reviewedPath(entry.path);

      if (path === null) continue;
      // A side that is a directory is no file: a file replaced by a folder reads as removed.
      const was = entry.change === 'added' ? undefined : presentIn(then, entry.path);
      const is = entry.change === 'removed' ? undefined : presentIn(now, entry.path);

      if (was !== undefined && is !== undefined) {
        const compared = compare(sideOf(then, entry.path, was), sideOf(now, entry.path, is));

        if (compared !== null) yield { path, ...compared };
      } else if (is !== undefined) {
        yield { path, status: 'added', was: () => undefined, is: () => sideOf(now, entry.path, is) };
      } else if (was !== undefined) {
        yield { path, status: 'removed', was: () => sideOf(then, entry.path, was), is: () => undefined };
      }
    }

    more = page.next !== null;
    after = page.next ?? undefined;
  }
}

/** Two sides a path held, as read: null when it is as it was, or both were gone by the read. */
function compare(before: Side | undefined, after: Side | undefined): Omit<Moved, 'path'> | null {
  const sides = { was: () => before, is: () => after };

  if (before === undefined) return after === undefined ? null : { status: 'added', ...sides };

  if (after === undefined) return { status: 'removed', ...sides };

  const same = before.bytes !== null && after.bytes !== null && sameBytes(before.bytes, after.bytes);

  return same ? null : { status: 'changed', ...sides };
}

/** The baseline the change-set reads against, and both trees: without one, tracking starts now, as at creation. */
async function againstBaseline(rt: WorkspaceBaselineRuntime, { store, cred }: WorkspaceBaselines) {
  const baseline = reviews(rt, store).at(-1) ?? await capture(rt, store);

  return { baseline, moved: () => movedSince(store, baseline.name, store.at(baseline.name, cred), store.as(cred)) };
}

/** Cumulative change-set since the baseline. */
export async function getWorkspaceDiff(rt: WorkspaceBaselineRuntime, baselines: WorkspaceBaselines): Promise<WorkspaceDiffResult> {
  const { baseline, moved } = await againstBaseline(rt, baselines);
  const files: FileDiff[] = [];
  let bodyChars = 0;

  const admit = (path: string, status: FileStatus, { before, after, omitted }: Sides): void => {
    if (before === null || after === null) {
      files.push({ path, status, added: 0, removed: 0, lines: [], omitted });

      return;
    }

    const d = diffLines(before, after);

    if (bodyChars >= maxChangesetBodyChars()) {
      files.push(fileDiff(path, status, { lines: [], added: d.added, removed: d.removed, truncated: true }));

      return;
    }

    for (const l of d.lines) bodyChars += l.text.length;
    files.push(fileDiff(path, status, d));
  };

  // A side the walk saw and this read did not was gone between the two.
  for (const { path, status, was, is } of moved()) {
    const before = was();
    const after = is();

    if (status === 'added' && after !== undefined) {
      admit(path, status, { before: '', after: after.text, omitted: unread(after.size) });
    } else if (status === 'removed' && before !== undefined) {
      admit(path, status, { before: before.text, after: '', omitted: unread(before.size) });
    } else if (status === 'changed' && before !== undefined && after !== undefined) {
      admit(path, status, { before: before.text, after: after.text, omitted: unread(Math.max(before.size, after.size)) });
    }
  }

  files.sort((a, b) => a.path.localeCompare(b.path));

  // The review's own id: notes name the snapshot they were written on by its first characters.
  return { files, trackedSince: baseline.createdAt, baseline: baseline.name.slice(reviewPrefix(rt).length) };
}

/**
 * How many files the change-set lists, read by the same walk with no side read but two the store holds: what a page
 * shows before it shows the listing. Over 1,500 cloned files the listing read 531-640 ms and 13 MB, the count 17-41 ms
 * (gcp-vm, 2026-10-27, three rounds each); on production the first change-set read after the workspace's object woke ran
 * 1.5 s of its CPU (05:18Z), and every call it was asked meanwhile waited on it.
 */
export async function countWorkspaceChanges(rt: WorkspaceBaselineRuntime, baselines: WorkspaceBaselines): Promise<number> {
  const { moved } = await againstBaseline(rt, baselines);
  let count = 0;

  for (const _ of moved()) count += 1;

  return count;
}

export interface WorkspaceReviewResult {
  readonly ok: true;
  readonly capturedAt: number;
  readonly cleanupFailures: readonly { snapshot: string; code: ErrorCode }[];
}

/** Published reviews report cleanup failures; the next review retries them. */
export function resetWorkspaceBaseline(
  rt: WorkspaceBaselineRuntime, baselines: WorkspaceBaselines,
): Promise<WorkspaceReviewResult> {
  return settle(Effect.gen(function* () {
    const taken = yield* Effect.promise(() => capture(rt, baselines.store));

    // Older reviews pin the store's history for nothing.
    const cleanup = yield* Effect.forEach(reviews(rt, baselines.store).slice(0, -2), (stale) => attempt(
      { doing: 'collecting an unreferenced workspace review snapshot', otherwise: 'io' },
      () => baselines.store.dropSnapshotAsync(stale.name),
    ).pipe(Effect.match({
      onSuccess: () => null,
      onFailure: (failure) => {
        diagnostics.failure('workspace.review_cleanup_failed', failure, { snapshot: stale.name });

        return { snapshot: stale.name, code: failure.code };
      },
    })));

    const result: WorkspaceReviewResult = {
      ok: true, capturedAt: taken.createdAt, cleanupFailures: cleanup.filter((failed) => failed !== null),
    };

    return result;
  }));
}

/** Undoes the last Mark reviewed: the review it replaced is the baseline again. */
export async function restoreWorkspaceBaseline(
  rt: WorkspaceBaselineRuntime, baselines: WorkspaceBaselines,
): Promise<{ ok: true; capturedAt: number } | { ok: false; error: string }> {
  const retained = reviews(rt, baselines.store);
  const [replaced, latest] = retained.slice(-2);

  if (replaced === undefined || latest === undefined) return { ok: false, error: 'There is no earlier review to go back to.' };

  // Prune leftovers first, or Undo could expose another obsolete review.
  for (const stale of retained.slice(0, -2)) await baselines.store.dropSnapshotAsync(stale.name);

  await baselines.store.dropSnapshotAsync(latest.name);

  return { ok: true, capturedAt: replaced.createdAt };
}

/** One changed file of a repository: $1 the repository, $2 `tracked` or `untracked`, $3 the path from git's -z list. */
const GIT_FILE_SCRIPT = [
  // xargs runs once on empty input; `/` is the list's own failure; `dir/` is a nested repository, its own section.
  'case "${3-}" in "") exit 0;; /) exit 1;; */) exit 0;; esac',
  `printf '\\001F%s\\000\\n' "$3"`,
  'if [ "$2" = tracked ]; then exec git -C "$1" --no-pager diff --no-ext-diff --no-renames HEAD -- ":(literal)$3"; fi',
  'git -C "$1" --no-pager diff --no-index --no-ext-diff --no-renames -- /dev/null "$3" || test "$?" -eq 1',
].join('\n');

/** One repository's section: $1 the folder git runs in, $2 its label (empty for the one enclosing the working directory). */
const GIT_REPOSITORY_SCRIPT = [
  'head=$(git -C "$1" rev-parse --verify --quiet HEAD 2>/dev/null) || head=',
  `printf '\\001R%s\\000%s\\000\\n' "$2" "$head"`,
  `scope='--cached --others'`,
  'if [ -n "$head" ]; then',
  `  { git -C "$1" diff --name-only -z --no-renames HEAD -- || printf '/\\000'; } | xargs -0 -n 1 sh -c "$KINU_GIT_FILE" sh "$1" tracked || printf '\\n\\001X\\n'`,
  '  scope=--others',
  'fi',
  `{ git -C "$1" ls-files $scope --exclude-standard -z || printf '/\\000'; } | xargs -0 -n 1 sh -c "$KINU_GIT_FILE" sh "$1" untracked || printf '\\n\\001X\\n'`,
].join('\n');

/** The repositories find hands over, `./.git` excepted: the enclosing section already holds it. */
const GIT_SCAN_SCRIPT = 'exec 2>&3; for dotgit; do [ "$dotgit" = ./.git ] || sh -c "$KINU_GIT_REPO" sh "${dotgit%/.git}" "${dotgit%/.git}"; done';

/**
 * One exec, in POSIX sh, that shows the repository enclosing the working directory, as VS Code does, and every one
 * below it however deep (owner, 2026-09-25: every repository inside the working directories), skipping hidden folders
 * and the dependency trees the store's own review skips ({@link DEPENDENCY_TREES}): tracked, staged and untracked
 * changes since HEAD, .gitignore honoured. Every path travels NUL-delimited, from `find -exec` and git's
 * `-z` lists into records the parser reads by NUL, so no name is split or quoted. `git diff --no-index` reads
 * untracked files without writing the index.
 */
function gitViewScript(): string {
  return [
    `export KINU_GIT_FILE=${shellQuote(GIT_FILE_SCRIPT)} KINU_GIT_REPO=${shellQuote(GIT_REPOSITORY_SCRIPT)}`,
    'if [ "$(git rev-parse --is-inside-work-tree 2>/dev/null)" = true ]; then',
    `  printf '\\001N'; git rev-parse --show-toplevel; printf '\\000'; git rev-parse --show-prefix; printf '\\000\\n'`,
    '  cdup=$(git rev-parse --show-cdup)',
    `  sh -c "$KINU_GIT_REPO" sh "\${cdup:-.}" ''`,
    'fi',
    // find's own complaints (an unreadable folder) are dropped; the sections' stderr goes out on fd 3.
    `find . \\( ${PRUNED_FOLDERS} -o \\( -name '.?*' ! -name .git \\) \\) -prune -o -name .git -prune -exec sh -c ${shellQuote(GIT_SCAN_SCRIPT)} sh {} + 3>&2 2>/dev/null`,
    `printf '\\001E\\n'`,
  ].join('\n');
}

/** A record's tag and its NUL-ended field count: N the enclosing repository's top and the working directory's
 *  prefix in it, R a repository's label and HEAD, F one file's path, X a failed git command, E the end. */
const RECORD_FIELDS = new Map([['N', 2], ['R', 2], ['F', 1], ['X', 0], ['E', 0]]);

interface GitRecord {
  readonly tag: string;
  readonly fields: string[];
  readonly body: string;
}

interface GitRecords {
  readonly records: GitRecord[];
  readonly stderr: string;
}

/**
 * The records, each at a line start. A patch line never starts with the mark: its lines are prefixed, and git
 * quotes a control character in a header path. What follows the end record is stderr.
 */
function gitRecords(output: string): Effect.Effect<GitRecords, KinuError> {
  return Effect.gen(function* () {
    const records: GitRecord[] = [];
    let at = output.startsWith(MARK) ? 0 : output.indexOf(`\n${MARK}`) + 1;

    while (at > 0 || (at === 0 && output.startsWith(MARK))) {
      const tag = output.charAt(at + 1);
      const count = RECORD_FIELDS.get(tag);

      if (count === undefined) return yield* new KinuError('io', `Unexpected git view record ${JSON.stringify(tag)}`);
      const fields: string[] = [];
      let next = at + 2;

      for (let i = 0; i < count; i++) {
        const end = output.indexOf('\0', next);

        if (end === -1) return yield* new KinuError('io', `Truncated git view record ${tag}`);
        fields.push(output.slice(next, end));
        next = end + 1;
      }

      if (output.charAt(next) !== '\n') return yield* new KinuError('io', `Malformed git view record ${tag}`);
      next++;

      if (tag === 'E') return { records, stderr: output.slice(next) };
      const following = output.indexOf(`\n${MARK}`, next - 1);
      const bodyEnd = following === -1 ? output.length : following + 1;
      records.push({ tag, fields, body: output.slice(next, bodyEnd) });
      at = following === -1 ? -1 : bodyEnd;
    }

    return yield* new KinuError('io', `The git view ended early: ${output.slice(-2000)}`);
  });
}

interface GitView {
  readonly files: FileDiff[];
  readonly repositories: string[];
  readonly heads: string[];
}

/** One line git printed, without its newline. */
function printedLine(field: string): string {
  return field.endsWith('\n') ? field.slice(0, -1) : field;
}

/**
 * The records read back: each repository's files under its folder. Inside a repository the list is framed at its
 * top, under the top's name, so the enclosing repository and the ones below the working directory share one tree.
 */
function gitView(output: string): Effect.Effect<GitView, KinuError> {
  return Effect.gen(function* () {
    const { records, stderr } = yield* gitRecords(output);

    if (records.some((record) => record.tag === 'X')) return yield* new KinuError('io', `A git command failed: ${stderr.trim()}`);
    const enclosing = records.find((record) => record.tag === 'N');
    const top = enclosing === undefined ? '' : printedLine(enclosing.fields[0] ?? '');
    const base = top.slice(top.lastIndexOf('/') + 1);
    const prefix = enclosing === undefined ? '' : printedLine(enclosing.fields[1] ?? '');

    const folderOf = (label: string): string => {
      if (label === '') return base;
      const relative = `${prefix}${label.replace(/^\.\//, '')}`;

      return base === '' ? relative : `${base}/${relative}`;
    };

    const sections: { label: string; head: string; files: FileDiff[] }[] = [];

    for (const record of records) {
      const [first = '', second = ''] = record.fields;

      if (record.tag === 'R') sections.push({ label: first, head: second, files: [] });
      else if (record.tag === 'F') for (const file of parseGitDiff(record.body)) sections.at(-1)?.files.push({ ...file, path: first });
    }

    // find hands repositories over in directory order; the list reads in code-unit order, so the enclosing one ('') first.
    sections.sort((a, b) => (a.label < b.label ? -1 : Number(a.label > b.label)));
    const view: GitView = { files: [], repositories: [], heads: [] };

    for (const section of sections) {
      if (section.head !== '' && !v.safeParse(HeadCommitSchema, section.head).success) {
        return yield* new KinuError('io', `Unexpected git HEAD in ${section.label || top}: ${section.head}`);
      }

      const folder = folderOf(section.label);
      view.repositories.push(folder);
      view.heads.push(`${folder}@${section.head}`);

      for (const file of section.files) view.files.push({ ...file, path: folder === '' ? file.path : `${folder}/${file.path}` });
    }

    return view;
  });
}

function getGitDiff(rt: AgentRuntime, executorId: string): Effect.Effect<ExecutorDiffResult> {
  // The scan is the product's own fixed read, not an agent's command, so the owner is never asked to approve it (#121).
  const provider = rt.executionRouter?.ungatedProvider(executorId);

  if (!provider) return Effect.succeed({ files: [], mode: 'git', error: `Executor "${executorId}" not found` });
  const execTool = provider.tools.exec;

  if (!execTool) return Effect.succeed({ files: [], mode: 'git', error: `Executor "${executorId}" has no exec tool` });

  return Effect.catchCause(Effect.gen(function* () {
    const result = v.parse(CommandResultSchema, yield* Effect.promise(async () => execTool.execute(gitViewScript())));

    if (!v.is(v.string(), result)) return yield* new KinuError(result.reason, result.error);
    const view = yield* gitView(result);

    if (view.repositories.length === 0) return { files: [], mode: 'git', notGitRepo: true } satisfies ExecutorDiffResult;

    return { files: view.files, mode: 'git', baseline: view.heads.join(' '), repositories: view.repositories } satisfies ExecutorDiffResult;
  }), (failed) => Effect.succeed({ files: [], mode: 'git', error: renderThrownChain({ cause: Cause.squash(failed) }) } satisfies ExecutorDiffResult));
}

/** Whether a write at `path`, absolute as the workspace's file events name it, can move the change-set. */
function reviewsPath(path: string): boolean {
  const names = path.split('/').filter((name) => name !== '');
  const [top] = names;

  return top !== undefined && REVIEWED_UNDER_ROOT.includes(top) && names.every(reviewed);
}

/** The frame a workspace sends its pages when its change-set moved: Changes reads again, shown or not. */
export const CHANGES_MOVED_EVENT = 'changes_moved';

/** One read of the change-set, held for the generation it read: every read waits on the one walk running. */
class HeldRead<A> {
  private held: { readonly generation: number; readonly result: A } | null = null;
  private walk: Promise<void> | null = null;

  /** The read as of `generation` or later; `walked` once a walk settles, at the generation it read. */
  async read(generation: () => number, load: () => Promise<A>, walked: (at: number) => void): Promise<A> {
    const wanted = generation();

    for (;;) {
      if (this.held !== null && this.held.generation >= wanted) return this.held.result;
      this.walk ??= this.walkAt(generation(), load, walked);
      await this.walk;
    }
  }

  private async walkAt(generation: number, load: () => Promise<A>, walked: (at: number) => void): Promise<void> {
    try {
      this.held = { generation, result: await load() };
    } finally {
      this.walk = null;
      walked(generation);
    }
  }
}

/**
 * The workspace's change-set, read again only after something it reviews moved: a file event on a reviewed path, or
 * a baseline that Mark reviewed or Undo moved. A poll while nothing moved walks nothing. Its listing and its count are
 * each one read, the count's walk reading no side the listing reads ({@link countWorkspaceChanges}).
 */
export class ChangeSetCache {
  private generation = 0;
  private readonly listing = new HeldRead<WorkspaceDiffResult>();
  private readonly count = new HeldRead<number>();
  /** A frame went out and no walk has finished since: each finished walk earns at most one more. */
  private announced = false;

  /** `announce` tells the workspace's pages that the change-set moved. */
  constructor(private readonly announce: () => void) {}

  /** Paths a write touched, as the workspace's file events name them. */
  touched(paths: readonly string[]): void {
    if (paths.some(reviewsPath)) this.move();
  }

  /** After Mark reviewed or Undo has moved the baseline. */
  moved(): void {
    this.move();
  }

  /** The change-set as of this call or later, from the walk running if it started after the last move. */
  read(load: () => Promise<WorkspaceDiffResult>): Promise<WorkspaceDiffResult> {
    return this.listing.read(() => this.generation, load, this.walked);
  }

  /** How many files it lists, as {@link read}. */
  readCount(load: () => Promise<number>): Promise<number> {
    return this.count.read(() => this.generation, load, this.walked);
  }

  private readonly walked = (at: number): void => {
    this.announced = false;

    if (this.generation !== at) this.tell();
  };

  private move(): void {
    this.generation += 1;
    this.tell();
  }

  private tell(): void {
    if (this.announced) return;
    this.announced = true;
    this.announce();
  }
}

/** How many files a source's change-set lists, and why it could not be read: what a page shows before it shows the
 *  listing, so the listing's bodies never cross the socket for a count (17.5 MB for a cloned repository on
 *  production, 2026-10-26, held behind every other reply on the socket for 5.5 s). */
export interface ExecutorChangeCount {
  readonly files: number;
  readonly error?: string;
}

/** The listing's count, its bodies left here: the workspace's from its own walk ({@link countWorkspaceChanges}), a machine's
 *  from its git view. */
export async function getExecutorChangeCount(
  rt: AgentRuntime, executorId: string, workspaceCount: () => Promise<number>,
): Promise<ExecutorChangeCount> {
  if (executorId === 'workspace') return { files: await workspaceCount() };

  return settle(Effect.map(getGitDiff(rt, executorId), (diff) => ({ files: diff.files.length, ...(diff.error !== undefined && { error: diff.error }) })));
}

/** An executor's change-set: the workspace's own, read by `workspace`, and any other executor's by git. */
export async function getExecutorDiff(
  rt: AgentRuntime, executorId: string, workspace: () => Promise<WorkspaceDiffResult>,
): Promise<ExecutorDiffResult> {
  if (executorId === 'workspace') {
    const r = await workspace();

    return { files: r.files, mode: 'vfs-baseline', trackedSince: r.trackedSince, baseline: r.baseline } satisfies ExecutorDiffResult;
  }

  return settle(getGitDiff(rt, executorId));
}

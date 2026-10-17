import { CRED_SESSION_USER } from '@nimbus-sh/core/runtime/os-contracts.js';
import { Effect } from 'effect';
import * as v from 'valibot';
import { KinuError } from '../obs/error';
import { inItsWords, settleSync } from '../obs/effect';
import { sha256Hex } from '../safety/argument-digest';
import { compareCodeUnits } from '../utils/text';
import type { WorkspaceSession } from '../vfs/nimbus-workspace';
import type { SlateEditMark, SlateLiveShareStore } from './live-shares';
import { SlateFileChangeSchema, type SlateFileChange } from './rpc';

interface FileBefore {
  readonly text: string | null;
  readonly sha256: string | null;
}

export interface SlateFileBatch {
  readonly paths: readonly string[];
  readonly wrote: Readonly<Record<string, string | null>>;
  readonly before: Readonly<Record<string, FileBefore>>;
  readonly markBefore: SlateEditMark | null;
  /** Every source entry after this batch, so its rollback cannot erase provenance for a disjoint later edit. */
  readonly tree: string | null;
}

type Files = ReturnType<WorkspaceSession['vfs']['as']>;

function atomic<Result>(session: Pick<WorkspaceSession, 'vfs'>, body: () => Result): Effect.Effect<Result, KinuError> {
  return inItsWords('io', Effect.sync(() => session.vfs.withTransaction(body)));
}

/** Never follow an authored link: checking every component and writing happen in one synchronous transaction. */
function checkedFile(files: Files, root: string, path: string): Effect.Effect<FileBefore, KinuError> {
  return Effect.gen(function* () {
    if (!files.exists(root)) return yield* new KinuError('missing', `No slate directory ${root}`);

    if (files.lstat(root).type !== 'directory') return yield* new KinuError('bad_input', `${root} must be a real directory, not a symlink`);
    const parts = path.split('/');
    let at = root;

    for (const part of parts.slice(0, -1)) {
      at += `/${part}`;

      if (files.exists(at) && files.lstat(at).type !== 'directory') {
        return yield* new KinuError('bad_input', `${path}: ${at} must be a real directory, not a symlink or file`);
      }
    }

    at += `/${parts[parts.length - 1]}`;

    if (!files.exists(at)) return { text: null, sha256: null };

    if (files.lstat(at).type !== 'file') return yield* new KinuError('bad_input', `${path} must be a regular file, not a symlink or directory`);
    const bytes = files.readFileUncached(at);

    if (bytes.includes(0)) return yield* new KinuError('bad_input', `${path} is not a text file: an editor changes text`);

    return { text: new TextDecoder().decode(bytes), sha256: sha256Hex(bytes) };
  });
}

function put(files: Files, at: string, text: string | null): void {
  if (text === null) {
    if (files.exists(at)) files.unlink(at);

    return;
  }

  files.mkdir(at.slice(0, at.lastIndexOf('/')), { recursive: true });
  files.writeFile(at, text);
}

interface TreeEntry {
  readonly path: string;
  readonly kind: 'directory' | 'file' | 'symlink';
  readonly mode: number;
  readonly uid: number;
  readonly gid: number;
  readonly content: string | null;
}

/** Hash names, kinds, permissions and content without ever following an authored link. */
function treeFingerprint(files: Files, root: string): Effect.Effect<string, KinuError> {
  return Effect.gen(function* () {
    const entries: TreeEntry[] = [];
    const pending = [root];

    for (let at = pending.pop(); at !== undefined; at = pending.pop()) {
      const stat = files.lstat(at);

      if (at === root && stat.type !== 'directory') return yield* new KinuError('bad_input', 'The slate tree must be a real directory');
      let content: string | null = null;

      if (stat.type === 'directory') {
        for (const child of files.readdir(at)) pending.push(`${at}/${child.name}`);
      } else if (stat.type === 'file') {
        content = files.contentKey(at);
      } else if (stat.type === 'symlink') {
        content = files.readlink(at);
      } else {
        return yield* new KinuError('bad_input', `A slate tree contains an unsupported entry: ${at}`);
      }

      entries.push({ path: at.slice(root.length), kind: stat.type, mode: stat.mode, uid: stat.uid, gid: stat.gid, content });
    }

    return sha256Hex(JSON.stringify(entries.sort((left, right) => compareCodeUnits(left.path, right.path))));
  });
}

/** The only editor writer: source, expected UTF-8 digests and provenance commit together, or none does. */
export function writeSlateBatch(input: {
  readonly session: Pick<WorkspaceSession, 'vfs'>;
  readonly root: string;
  readonly files: SlateFileChange;
  readonly marks: SlateLiveShareStore;
  readonly slate: string;
  readonly editor: string;
  readonly revision: string | null;
}): SlateFileBatch {
  const change = Effect.gen(function* () {
    const parsed = v.safeParse(SlateFileChangeSchema, input.files);

    if (!parsed.success) return yield* new KinuError('bad_input', parsed.issues[0].message);
    const files = input.session.vfs.as(CRED_SESSION_USER);
    const proposed = Object.keys(parsed.output).sort();
    const observed: Record<string, FileBefore> = {};
    const wrote: Record<string, string | null> = {};
    const conflicts: string[] = [];

    for (const path of proposed) {
      observed[path] = yield* checkedFile(files, input.root, path);

      if (observed[path].sha256 !== parsed.output[path].base) conflicts.push(path);
    }

    if (conflicts.length > 0) return yield* new KinuError('bad_input', `File conflict: ${conflicts.join(', ')} changed since you read them; read them again`);
    const markBefore = input.marks.editMark(input.slate);

    const paths = proposed.filter((path) => {
      const { text } = parsed.output[path];

      return observed[path].sha256 !== (text === null ? null : sha256Hex(text));
    });

    const before = Object.fromEntries(paths.map((path) => [path, observed[path]]));

    if (paths.length === 0) return { paths, wrote, before, markBefore, tree: null };

    for (const path of paths) {
      const { text } = parsed.output[path];
      put(files, `${input.root}/${path}`, text);
      wrote[path] = text === null ? null : sha256Hex(text);
    }

    const tree = yield* treeFingerprint(files, input.root);
    input.marks.markEdit(input.slate, input.editor, input.revision);

    return { paths, wrote, before, markBefore, tree };
  });

  return settleSync(atomic(input.session, () => settleSync(change)));
}

/** Restore only bytes this batch still owns; a later save is kept and its path is reported as a conflict. */
export function rollbackSlateBatch(input: {
  readonly session: Pick<WorkspaceSession, 'vfs'>;
  readonly root: string;
  readonly slate: string;
  readonly marks: SlateLiveShareStore;
  readonly batch: SlateFileBatch;
}): { readonly restored: readonly string[]; readonly conflicts: readonly string[] } {
  const restore = Effect.gen(function* () {
    if (input.batch.paths.length === 0) return { restored: [], conflicts: [] };
    const files = input.session.vfs.as(CRED_SESSION_USER);
    const restored: string[] = [];
    const conflicts: string[] = [];
    const observed = yield* Effect.result(Effect.catchDefect(treeFingerprint(files, input.root), (cause) => Effect.fail(new KinuError('io', 'The slate tree could not be fingerprinted', { cause }))));
    const unchanged = observed._tag === 'Success' && observed.success === input.batch.tree;

    for (const path of input.batch.paths) {
      const current = yield* Effect.result(checkedFile(files, input.root, path));

      if (current._tag === 'Failure' || current.success.sha256 !== input.batch.wrote[path]) {
        conflicts.push(path);
        continue;
      }

      put(files, `${input.root}/${path}`, input.batch.before[path].text);
      restored.push(path);
    }

    if (conflicts.length === 0 && unchanged) input.marks.restoreEditMark(input.slate, input.batch.markBefore);

    return { restored, conflicts };
  });

  return settleSync(atomic(input.session, () => settleSync(restore)));
}

import { ContentRef } from '@agent-core/core';
import type { SlateId } from '@agent-core/core/slates';
import * as v from 'valibot';
import type { SqlExec } from '../types/primitives';
import { workspacePath } from '../vfs/workspace-path';
import { SlateDirectoryName } from './rpc';
import type { WorkspaceSlateContentStore } from './content';
import { KinuError } from '../obs/error';
import { tolerate } from '../obs/index';
import { compareCodeUnits } from '../utils/text';
import { unmovedSince } from '../vfs/unmoved';

export { SlateDirectoryName };

const TreePath = v.pipe(v.string(), v.check((path) => path.split('/').every((part) => part !== '' && part !== '.' && part !== '..')));

const TreeEntry = v.variant('kind', [
  v.object({ path: TreePath, kind: v.literal('directory'), mode: v.number() }),
  v.object({ path: TreePath, kind: v.literal('file'), mode: v.number(), content: v.string() }),
  v.object({ path: TreePath, kind: v.literal('symlink'), target: v.string() }),
]);

const Tree = v.object({ mode: v.number(), entries: v.array(TreeEntry) });

type TreeEntry = v.InferOutput<typeof TreeEntry>;

export function slateDirectory(id: SlateId): string {
  const name = v.safeParse(SlateDirectoryName, id.value);

  if (!name.success) throw new KinuError('bad_input', 'Slate id must be one directory name', { cause: new v.ValiError(name.issues) });

  return workspacePath('slates/' + name.output);
}

export function forgetSlateFiles(sql: SqlExec, id: SlateId): void {
  sql.exec('DELETE FROM slate_file_manifest WHERE slate_id = ?', id.value);
}

interface FileStat { type: string; mode: number; size: number; mtime: number; ino: number }

const R_OK = 0o4;

interface ManifestRow { size: number; mtimeMs: number; ino: number; content: string; recordedAt: number }

const ManifestRowSchema = v.object({
  path: v.string(), size: v.number(), mtime_ms: v.number(), ino: v.number(), content: v.string(), recorded_at: v.number(),
});

function unmoved(row: ManifestRow, stat: FileStat): boolean {
  return row.ino === stat.ino && unmovedSince(row, row.recordedAt, { size: stat.size, mtimeMs: stat.mtime });
}

class SlateManifest {
  readonly at = Date.now();
  readonly known: Map<string, ManifestRow>;

  constructor(private readonly sql: SqlExec, private readonly slate: string) {
    const rows = sql.exec(
      'SELECT path, size, mtime_ms, ino, content, recorded_at FROM slate_file_manifest WHERE slate_id = ?', slate,
    ).toArray();

    this.known = new Map(rows.map((raw) => {
      const row = v.parse(ManifestRowSchema, raw);

      return [row.path, { size: row.size, mtimeMs: row.mtime_ms, ino: row.ino, content: row.content, recordedAt: row.recorded_at }];
    }));
  }

  record(path: string, stat: FileStat, content: string): void {
    this.sql.exec(
      `INSERT INTO slate_file_manifest (slate_id, path, size, mtime_ms, ino, content, recorded_at) VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (slate_id, path) DO UPDATE SET size = excluded.size, mtime_ms = excluded.mtime_ms, ino = excluded.ino,
         content = excluded.content, recorded_at = excluded.recorded_at`,
      this.slate, path, stat.size, stat.mtime, stat.ino, content, this.at,
    );
  }

  forget(path: string): void {
    this.sql.exec('DELETE FROM slate_file_manifest WHERE slate_id = ? AND path = ?', this.slate, path);
  }
}

/** Synchronous because source and metadata share one host transaction. */
export interface SlateFileTree {
  exists(path: string): boolean;
  access(path: string, mode: number): void;
  stat(path: string): { mode: number };
  lstat(path: string): FileStat;
  readdir(path: string): { name: string; type: string }[];
  readlink(path: string): string;
  readFileUncached(path: string): Uint8Array;
  mkdir(path: string, options?: { recursive?: boolean; mode?: number }): void;
  writeFile(path: string, content: Uint8Array, options?: { mode?: number }): void;
  symlink(target: string, path: string): void;
  chmod(path: string, mode: number): void;
  utimes(path: string, atimeMs: number | null, mtimeMs: number | null): void;
  unlink(path: string): void;
  removeRecursive(path: string): number;
}

export class SlateFiles {
  constructor(
    private readonly vfs: SlateFileTree,
    private readonly content: WorkspaceSlateContentStore,
    private readonly sql: SqlExec,
    /** Owns the outermost shared VFS/metadata transaction; never nest or await. */
    readonly transaction: <Result>(body: () => Result) => Result,
  ) {}

  capture(id: SlateId): ContentRef {
    const root = slateDirectory(id);
    const manifest = new SlateManifest(this.sql, id.value);
    const known = new Map(manifest.known);
    const entries: TreeEntry[] = [];

    const walk = (directory: string, relative: string): void => {
      // Never locale order: the walk order is part of the content-addressed ref.
      for (const entry of this.vfs.readdir(directory).sort((left, right) => compareCodeUnits(left.name, right.name))) {
        const absolute = `${directory}/${entry.name}`;
        const path = relative === '' ? entry.name : `${relative}/${entry.name}`;
        const stat = this.vfs.lstat(absolute);

        if (stat.type === 'symlink') {
          entries.push({ path, kind: 'symlink', target: this.vfs.readlink(absolute) });
        } else if (stat.type === 'directory') {
          entries.push({ path, kind: 'directory', mode: stat.mode & 0o7777 });
          walk(absolute, path);
        } else if (stat.type === 'file') {
          const row = known.get(path);
          known.delete(path);
          const content = row !== undefined && unmoved(row, stat) ? this.readable(absolute, row) : this.retain(manifest, path, absolute, stat);
          entries.push({ path, kind: 'file', mode: stat.mode & 0o7777, content });
        } else {
          throw new Error(`Slate source cannot retain ${stat.type}: ${path}`);
        }
      }
    };

    walk(root, '');

    for (const path of known.keys()) manifest.forget(path);

    return this.content.retain(new TextEncoder().encode(JSON.stringify({ mode: this.vfs.stat(root).mode & 0o7777, entries }))).ref;
  }

  readTree(source: ContentRef) {
    return v.parse(Tree, JSON.parse(new TextDecoder().decode(this.content.read(source))));
  }

  restore(id: SlateId, source: ContentRef): void {
    const root = slateDirectory(id);
    const tree = this.readTree(source);
    const manifest = new SlateManifest(this.sql, id.value);
    const target = new Map(tree.entries.map((entry) => [entry.path, entry]));
    // Before the rows' time: a rewrite in that millisecond still moves the mtime.
    const written = manifest.at - 1;
    const present = this.lstatOrNull(root);
    const fresh = present?.type !== 'directory';

    if (present !== null && fresh) this.vfs.unlink(root);

    if (fresh) {
      this.vfs.mkdir(root, { recursive: true, mode: tree.mode | 0o700 });
    } else {
      this.makeDirectoriesWritable(root);
      this.prune(root, '', target);
    }

    for (const entry of tree.entries) {
      const path = `${root}/${entry.path}`;
      const current = fresh ? null : this.lstatOrNull(path);

      if (entry.kind === 'directory') {
        if (current === null) this.vfs.mkdir(path, { mode: entry.mode | 0o700 });
      } else if (entry.kind === 'symlink') {
        if (current !== null && this.vfs.readlink(path) === entry.target) continue;

        if (current !== null) this.vfs.unlink(path);
        this.vfs.symlink(entry.target, path);
      } else {
        const row = manifest.known.get(entry.path);

        if (current !== null && row?.content === entry.content && unmoved(row, current) && (current.mode & 0o7777) === entry.mode) continue;

        // A rewrite keeps the mode.
        if (current !== null) this.vfs.unlink(path);
        this.vfs.writeFile(path, this.content.read(new ContentRef(entry.content)), { mode: entry.mode });
        this.vfs.utimes(path, written, written);
        manifest.record(entry.path, this.vfs.lstat(path), entry.content);
      }
    }

    for (let index = tree.entries.length - 1; index >= 0; index -= 1) {
      const entry = tree.entries[index];

      if (entry.kind === 'directory') this.vfs.chmod(`${root}/${entry.path}`, entry.mode);
    }

    this.vfs.chmod(root, tree.mode);

    for (const path of manifest.known.keys()) {
      if (target.get(path)?.kind !== 'file') manifest.forget(path);
    }
  }

  private prune(directory: string, relative: string, target: ReadonlyMap<string, TreeEntry>): void {
    for (const entry of this.vfs.readdir(directory)) {
      const path = relative === '' ? entry.name : `${relative}/${entry.name}`;
      const absolute = `${directory}/${entry.name}`;

      if (target.get(path)?.kind === entry.type) {
        if (entry.type === 'directory') this.prune(absolute, path, target);
      } else if (entry.type === 'directory') {
        this.vfs.removeRecursive(absolute);
      } else {
        this.vfs.unlink(absolute);
      }
    }
  }

  private lstatOrNull(path: string): FileStat | null {
    return tolerate(() => this.vfs.lstat(path), 'enoent') ?? null;
  }

  /** The read's permission check, without the read. */
  private readable(absolute: string, row: ManifestRow): string {
    this.vfs.access(absolute, R_OK);

    return row.content;
  }

  private retain(manifest: SlateManifest, path: string, absolute: string, stat: FileStat): string {
    const content = this.content.retain(this.vfs.readFileUncached(absolute)).ref.value;
    manifest.record(path, stat, content);

    return content;
  }

  private makeDirectoriesWritable(path: string): void {
    const stat = this.vfs.lstat(path);

    if (stat.type !== 'directory') return;

    if ((stat.mode & 0o700) !== 0o700) this.vfs.chmod(path, stat.mode | 0o700);

    for (const entry of this.vfs.readdir(path)) {
      if (entry.type === 'directory') this.makeDirectoriesWritable(`${path}/${entry.name}`);
    }
  }
}

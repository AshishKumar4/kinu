import { ContentRef } from '@agent-core/core';
import { MediaHint } from '@agent-core/core/content';
import type { SlateId } from '@agent-core/core/slates';
import type { CredentialedVfs } from '@nimbus-sh/core/vfs/sqlite-vfs.js';
import * as v from 'valibot';
import { workspacePath } from '../vfs/workspace-path';
import type { SqliteSlateContentStore } from './content';
import { nanoid } from '../utils/nanoid';
import { KinuError } from '../obs/error';

export const SlateDirectoryName = v.pipe(v.string(), v.minLength(1),
  v.check((name) => !name.includes('/') && !name.includes('\0') && name !== '.' && name !== '..', 'Slate id must be one directory name'));

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

export class SlateFiles {
  constructor(private readonly vfs: CredentialedVfs, private readonly content: SqliteSlateContentStore) {}

  capture(id: SlateId): ContentRef {
    const root = slateDirectory(id);
    const entries: TreeEntry[] = [];
    const walk = (directory: string, relative: string): void => {
      for (const entry of this.vfs.readdir(directory).sort((left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : 0)) {
        const absolute = `${directory}/${entry.name}`;
        const path = relative === '' ? entry.name : `${relative}/${entry.name}`;
        const stat = this.vfs.lstat(absolute);
        if (stat.type === 'symlink') {
          entries.push({ path, kind: 'symlink', target: this.vfs.readlink(absolute) });
        } else if (stat.type === 'directory') {
          entries.push({ path, kind: 'directory', mode: stat.mode & 0o7777 });
          walk(absolute, path);
        } else if (stat.type === 'file') {
          entries.push({ path, kind: 'file', mode: stat.mode & 0o7777, content: this.content.retain(this.vfs.readFileUncached(absolute)).ref.value });
        } else {
          throw new Error(`Slate source cannot retain ${stat.type}: ${path}`);
        }
      }
    };
    walk(root, '');
    return this.content.retain(new TextEncoder().encode(JSON.stringify({ mode: this.vfs.stat(root).mode & 0o7777, entries })), new MediaHint('application/json')).ref;
  }

  readTree(source: ContentRef) {
    return v.parse(Tree, JSON.parse(new TextDecoder().decode(this.content.read(source))));
  }

  materialize(source: ContentRef): string {
    const root = workspacePath(`.slate-sources/${nanoid()}`);
    this.writeTree(root, source);
    return root;
  }

  restore(id: SlateId, source: ContentRef): void {
    this.writeTree(slateDirectory(id), source);
  }

  private writeTree(root: string, source: ContentRef): void {
    const tree = this.readTree(source);
    if (this.vfs.exists(root)) {
      this.makeDirectoriesWritable(root);
      this.vfs.removeRecursive(root);
    }
    this.vfs.mkdir(root, { recursive: true, mode: tree.mode | 0o700 });
    for (const entry of tree.entries) {
      const path = `${root}/${entry.path}`;
      if (entry.kind === 'directory') this.vfs.mkdir(path, { mode: entry.mode | 0o700 });
      else if (entry.kind === 'symlink') this.vfs.symlink(entry.target, path);
      else this.vfs.writeFile(path, this.content.read(new ContentRef(entry.content)), { mode: entry.mode });
    }
    for (let index = tree.entries.length - 1; index >= 0; index -= 1) {
      const entry = tree.entries[index];
      if (entry.kind === 'directory') this.vfs.chmod(`${root}/${entry.path}`, entry.mode);
    }
    this.vfs.chmod(root, tree.mode);
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

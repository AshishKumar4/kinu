/** Emulates the chunked delta's generated shell against a `ContainerDisk` with real bytes;
 *  answers only `# devbox-<name>-v1` commands; `delta-shell-parity.test.ts` pins it to a real shell. */

import { createHash } from 'node:crypto';

import { DELTA_MANIFEST_NAME, DELTA_BLOCK_BYTES, DeltaManifestSchema, readDeltaIndex } from '../../src/chunked-delta';
import * as v from 'valibot';
import type { ContainerDisk } from './strategy-machine';
import {
  contentSize,
  type LiveInode,
  type LiveTree,
  type NodeEntry,
  type NodeKind,
  type PosixMetadata,
} from './tree-model';

export type ShellReply = { stdout: string; stderr: string; exitCode: number };

interface DdCommand {
  /** The file read, or null for `/dev/zero`. */
  readonly source: string | null;
  readonly path: string;
  readonly blockBytes: number;
  /** `skip=`: read block `block` of the source. `seek=`: write it in the target. */
  readonly skip: boolean;
  readonly block: number;
}

/** A path naming this directory is a stage or a sidecar, and its root is a tree. */
const DELTA_DIR = DELTA_MANIFEST_NAME.slice(0, DELTA_MANIFEST_NAME.indexOf('/'));

const ROOT_METADATA: PosixMetadata = { uid: 0, gid: 0, atimeNs: '0', mtimeNs: '0', ctimeNs: '0', xattrs: {} };

/** A single-quoted shell word, as `shellPath` writes one. */
const Q = String.raw`'((?:[^']|'\\'')*)'`;

const unquote = (word: string): string => word.replaceAll(`'\\''`, `'`);

const OP = {
  probe: new RegExp(String.raw`^out=\$\(set -o pipefail; find ${Q} (.*?)-mindepth 1 -printf '[^']*' 2>/dev/null \| devbox-block-lower --probe-opaque ${Q} \| base64 \| tr -d '\\n'\); rc=\$\?; printf '%s %s' "\$rc" "\$out"$`),
  prune: new RegExp(String.raw`-path ${Q} -prune -o`, 'g'),
  whiteout: new RegExp(String.raw`^stat -c '%t,%T' ${Q} 2>/dev/null \|\| printf 'x\\n'$`),
  basestat: new RegExp(String.raw`^stat -c '%F %s' ${Q} 2>/dev/null \|\| printf 'ABSENT\\n'$`),
  haveSplit: /^command -v split >\/dev\/null 2>&1 \|\| \{ printf 'NOSPLIT\\n'; false; \};$/,
  mkdir: /^mkdir -p (.+)$/,
  split: new RegExp(String.raw`^split -b (\d+) -a 4 ${Q} ${Q} \|\| false$`),
  say: /^printf '([A-Z]+ \d+)\\n'$/,
  sha256sum: new RegExp(String.raw`^find ${Q} -type f -exec sha256sum \{\} \+ \|\| false$`),
  rmrf: new RegExp(String.raw`^rm -rf ${Q}$`),
  ifBase: new RegExp(String.raw`^if test -s ${Q}; then (.*); else printf 'BEMPTY (\d+)\\n'; fi$`),
  chown: new RegExp(String.raw`^chown (\d+):(\d+) ${Q}$`),
  chmod: new RegExp(String.raw`^chmod ([0-7]+) ${Q}$`),
  ln: new RegExp(String.raw`^ln ${Q} ${Q}$`),
  cpa: new RegExp(String.raw`^cp -a ${Q} ${Q}$`),
  cpOrEmpty: new RegExp(String.raw`^cp ${Q} ${Q} 2>/dev/null \|\| : > ${Q}$`),
  dd: new RegExp(String.raw`^dd if=(?:${Q}|(/dev/zero)) of=${Q} bs=(\d+) (skip|seek)=(\d+) count=1( conv=notrunc)? 2>/dev/null$`),
  truncate: new RegExp(String.raw`^truncate -s (\d+) ${Q}$`),
  manifest: new RegExp(String.raw`^printf %s ${Q} \| base64 -d > ${Q}$`),
  cat: new RegExp(String.raw`^cat ${Q} 2>/dev/null$`),
  base64: new RegExp(String.raw`^base64 ${Q}$`),
  mknod: new RegExp(String.raw`^: > ${Q}$`),
};

/** A line no operation matches throws: a silent `ok` would let the product pass on a step
 *  nobody emulated. */
export function deltaCommand(command: string, disk: ContainerDisk): ShellReply | undefined {
  if (!command.startsWith('# devbox-')) return undefined;

  if (command.startsWith('# devbox-block-lower-v2')) return composeBlockMount(command, disk);
  const shell = new DeltaShell(disk);

  return shell.run(command.split('\n'));
}

/** This in-memory filesystem oracle composes eagerly, as its squashfs model
 * unpacks eagerly. Real IO bounds are measured by block-lower.test.ts. */
function composeBlockMount(command: string, disk: ContainerDisk): ShellReply {
  const args = new Map([...command.matchAll(new RegExp(String.raw`--([a-z-]+) ${Q}`, 'g'))].map(match => [match[1], match[2]]));

  const get = (key: string): string => {
    const value = args.get(key);

    if (value === undefined) throw new Error(`block lower lacks ${key}`);

    return unquote(value);
  };

  const delta = get('delta');
  const base = get('base');
  const mount = get('mount');
  const bytes = disk.readFile(`${delta}/${DELTA_MANIFEST_NAME}`);

  if (bytes === undefined) throw new Error('missing block manifest');
  const manifest = v.parse(DeltaManifestSchema, JSON.parse(new TextDecoder().decode(bytes)));
  const tree = disk.tree(mount);
  tree.plant(manifest.dirs.map((dir, ino) => ({ path: dir.p, ino: ino + 1, kind: 'dir', mode: dir.mode, metadata: { ...ROOT_METADATA, uid: dir.uid, gid: dir.gid } })));

  for (const file of manifest.files) {
    if (file.kind !== 'chunked') continue;
    const output = new Uint8Array(file.s);
    const fromBase = disk.readFile(`${base}/${file.p}`);

    if (fromBase !== undefined) output.set(fromBase.subarray(0, file.s));
    const index = disk.readFile(`${delta}/.devbox-delta/${file.over.index}`);

    if (index === undefined) throw new Error('missing block index');

    for (const override of readDeltaIndex(file.over, file.s, index)) {
      if (override.src === 'hole') output.fill(0, override.o, Math.min(file.s, override.o + DELTA_BLOCK_BYTES));
      else {
        const chunk = disk.readFile(`${delta}/.devbox-delta/chunks/${override.d}`);

        if (chunk === undefined || createHash('sha256').update(chunk).digest('hex') !== override.d) throw new Error('corrupt block chunk');
        output.set(chunk, override.o);
      }
    }

    tree.writeFile(file.p, output, { ...ROOT_METADATA, uid: file.uid, gid: file.gid });
    const node = tree.node(file.p);

    if (node === undefined) throw new Error('composed inode missing');
    node.mode = file.mode;
  }

  // Models D11: the platform reports plain `fuse`, measured on cloud and Docker;
  // the generation-bearing source, not a synthetic subtype, identifies the mount.
  disk.mount(mount, { source: `devbox-block:${get('generation')}`, fstype: 'fuse', options: 'ro' });

  return { stdout: '', stderr: '', exitCode: 0 };
}

/** `%T@`: seconds and a ten-digit fraction, as GNU find prints a time. */
function findTime(ns: string): string {
  const value = BigInt(ns);

  return `${value / 1_000_000_000n}.${String(value % 1_000_000_000n).padStart(9, '0')}0`;
}

/** `split -a 4`'s suffix for block `index`: `aaaa`, `aaab`, and on. */
function splitSuffix(index: number): string {
  let out = '';
  let rest = index;

  for (let at = 0; at < 4; at += 1) {
    out = String.fromCharCode(97 + (rest % 26)) + out;
    rest = Math.floor(rest / 26);
  }

  return out;
}

function patternChar(char: string): string {
  if (char === '*') return '.*';

  if (char === '?') return '.';

  return char.replace(/[.+^${}()|[\]\\]/g, '\\$&');
}

function pathPattern(pattern: string): RegExp {
  return new RegExp(`^${pattern.split('').map(patternChar).join('')}$`);
}

/** `find -printf '%y'`, plus `o` for a directory carrying an opaque marker. */
function findType(kind: NodeKind, opaque: boolean): string {
  if (kind === 'file') return 'f';

  if (kind === 'symlink') return 'l';

  return opaque ? 'o' : 'd';
}

/** `%s`: a file's logical length, a directory's fixed 4096, a symlink's target
 *  length. An absent content or target is the empty one, as `plant` reads it. */
function entrySize(entry: NodeEntry): number {
  if (entry.kind === 'dir') return 4096;

  if (entry.kind === 'symlink') return (entry.target ?? '').length;

  return entry.content === undefined ? 0 : contentSize(entry.content);
}

function nodeSize(node: LiveInode): number {
  return node.content === undefined ? 0 : contentSize(node.content);
}

function bytesOf(node: LiveInode): Uint8Array {
  const content = node.content;

  if (content === undefined) return new Uint8Array(0);

  if (content.kind === 'dense') return content.bytes;
  const out = new Uint8Array(content.size);

  for (const run of content.runs) out.set(run.bytes.subarray(0, Math.max(0, content.size - run.offset)), run.offset);

  return out;
}

function entryOf(node: LiveInode, path: string): NodeEntry {
  const base = { path, mode: node.mode, ino: 1, metadata: node.metadata };

  if (node.kind === 'symlink') return { ...base, kind: 'symlink', target: node.target };

  if (node.kind === 'file') return { ...base, kind: 'file', content: node.content };

  return { ...base, kind: 'dir' };
}

class DeltaShell {
  readonly #out: string[] = [];
  /** `split` output, by path: views over the source, charged to the disk as
   *  the real pieces would be and refunded by the `rm -rf` that follows. */
  readonly #pieces = new Map<string, Uint8Array>();
  #strict = false;

  constructor(private readonly disk: ContainerDisk) {}

  run(lines: readonly string[]): ShellReply {
    let status = 0;
    const stderr: string[] = [];

    for (const line of lines) {
      try {
        status = this.#line(line);
      } catch (error) {
        // A full disk is the operation's own failure, as `cp` reports one;
        // anything else is the container's, and the shell is gone with it.
        if (!(error instanceof Error) || error.name !== 'DiskFull') throw error;
        stderr.push(`${line.split(' ')[0]}: ${error.message}\n`);
        status = 1;
      }

      if (status !== 0 && this.#strict) break;
    }

    return { stdout: this.#out.join(''), stderr: stderr.join(''), exitCode: status };
  }

  #line(line: string): number {
    if (line === '' || line.startsWith('#')) return 0;

    // `opsBatchCommand` scopes `set -e` to a subshell (D18); this double treats the parens only as
    // the batch boundary. Real subshell semantics are pinned by `tests/ops-batch-session.test.ts`.
    if (line === '(' || line === ')') return 0;

    if (line === 'set -e') {
      this.#strict = true;

      return 0;
    }

    let m: RegExpExecArray | null;

    if ((m = OP.probe.exec(line)) !== null) return this.#probe(unquote(m[1]), m[2]);

    if ((m = OP.whiteout.exec(line)) !== null) return this.#whiteout(unquote(m[1]));

    if ((m = OP.basestat.exec(line)) !== null) return this.#basestat(unquote(m[1]));

    if (OP.haveSplit.test(line)) return 0;

    if ((m = OP.mkdir.exec(line)) !== null) return this.#mkdir(m[1]);

    if ((m = OP.split.exec(line)) !== null) return this.#split(Number(m[1]), unquote(m[2]), unquote(m[3]));

    if ((m = OP.say.exec(line)) !== null) return this.#say(`${m[1]}\n`);

    if ((m = OP.sha256sum.exec(line)) !== null) return this.#sha256sum(unquote(m[1]));

    if ((m = OP.rmrf.exec(line)) !== null) return this.#rmrf(unquote(m[1]));

    if ((m = OP.ifBase.exec(line)) !== null) return this.#ifBase(unquote(m[1]), m[2], Number(m[3]));

    if ((m = OP.chown.exec(line)) !== null) return this.#chown(Number(m[1]), Number(m[2]), unquote(m[3]));

    if ((m = OP.chmod.exec(line)) !== null) return this.#chmod(Number.parseInt(m[1], 8), unquote(m[2]));

    if ((m = OP.ln.exec(line)) !== null) return this.#ln(unquote(m[1]), unquote(m[2]));

    if ((m = OP.cpa.exec(line)) !== null) return this.#cpa(unquote(m[1]), unquote(m[2]));

    if ((m = OP.cpOrEmpty.exec(line)) !== null) return this.#cpOrEmpty(unquote(m[1]), unquote(m[2]));

    if ((m = OP.dd.exec(line)) !== null) {
      return this.#dd({
        source: m[2] === undefined ? unquote(m[1]) : null,
        path: unquote(m[3]),
        blockBytes: Number(m[4]),
        skip: m[5] === 'skip',
        block: Number(m[6]),
      });
    }

    if ((m = OP.truncate.exec(line)) !== null) return this.#truncate(Number(m[1]), unquote(m[2]));

    if ((m = OP.manifest.exec(line)) !== null) return this.#manifest(unquote(m[1]), unquote(m[2]));

    if ((m = OP.cat.exec(line)) !== null) return this.#cat(unquote(m[1]));

    if ((m = OP.mknod.exec(line)) !== null) {
      const path = m[1];

      if (path === undefined) throw new Error('whiteout lacks a path');
      const owned = this.#dest(unquote(path));

      if (owned.relative.split('/').at(-1) === '.wh..wh..opq') {
        owned.tree.writeFile(owned.relative, new Uint8Array(0), ROOT_METADATA);

        return 0;
      }

      const prefix = unquote(path).slice(0, -owned.relative.length - 1);
      const whiteouts = this.disk.whiteouts.get(prefix) ?? new Set<string>();
      const slash = owned.relative.lastIndexOf('/');
      whiteouts.add(owned.relative.slice(0, slash + 1) + owned.relative.slice(slash + 5));
      this.disk.whiteouts.set(prefix, whiteouts);

      return 0;
    }

    if ((m = OP.base64.exec(line)) !== null) {
      const path = m[1];

      if (path === undefined) throw new Error('base64 needs a path');
      const node = this.disk.node(unquote(path));

      return node?.kind === 'file' ? this.#say(Buffer.from(bytesOf(node)).toString('base64')) : 1;
    }

    throw new Error(`the delta shell emulates no such operation: ${line.slice(0, 120)}`);
  }

  #say(text: string): number {
    this.#out.push(text);

    return 0;
  }

  #dest(path: string): { readonly tree: LiveTree; readonly relative: string } {
    const held = this.disk.writable(path);

    if (held !== undefined) return held;
    const at = `${path}/`.indexOf(`/${DELTA_DIR}/`);

    if (at <= 0) throw new Error(`no tree serves ${path}`);
    this.disk.tree(path.slice(0, at));
    const made = this.disk.writable(path);

    if (made === undefined) throw new Error(`the tree made for ${path} does not serve it`);

    return made;
  }

  #probe(upper: string, prunes: string): number {
    const pruned = [...prunes.matchAll(OP.prune)].map((m) => pathPattern(unquote(m[1])));
    const tree = this.disk.trees.get(upper);

    if (tree === undefined) return this.#say('1 ');
    const rows = tree.snapshot();

    const opaque = new Set(rows.filter(row => row.path.split('/').at(-1) === '.wh..wh..opq')
      .map(row => row.path.slice(0, Math.max(0, row.path.lastIndexOf('/')))));

    /** `%n`: names per inode counted over these rows, so a row is never below one. */
    const names = new Map<number, number>();

    for (const row of rows) names.set(row.ino, (names.get(row.ino) ?? 0) + 1);
    const fields: string[] = [];

    if (opaque.has('')) fields.push('o', '0', '2', '755', '0', '0', '4096', '0', '0', '', '');

    const excluded = (path: string): boolean => pruned.some((pattern) => {
      const parts = path.split('/');

      for (let depth = 1; depth <= parts.length; depth += 1) {
        if (pattern.test(`${upper}/${parts.slice(0, depth).join('/')}`)) return true;
      }

      return false;
    });

    for (const row of rows) {
      if (excluded(row.path)) continue;
      const meta = row.metadata;

      if (meta === undefined) throw new Error(`find: ${row.path} carries no metadata to print`);
      const isOpaque = opaque.has(row.path) || ['trusted.overlay.opaque', 'user.overlay.opaque', 'user.fuseoverlayfs.opaque'].some(key => meta.xattrs[key] === 'y');

      const nlink = row.kind === 'dir'
        ? 2 + rows.filter((child) => child.kind === 'dir' && child.path.startsWith(`${row.path}/`) && !child.path.slice(row.path.length + 1).includes('/')).length
        : names.get(row.ino) ?? 1;

      fields.push(findType(row.kind, isOpaque), String(row.ino), String(nlink), row.mode.toString(8),
        String(meta.uid), String(meta.gid), String(entrySize(row)),
        findTime(meta.mtimeNs), findTime(meta.ctimeNs), row.target ?? '', row.path);
    }

    // The upper's whiteouts, as fuse-overlayfs keeps them: 0/0 character
    // devices, mode 0, one name each, listed after the tree's own names.
    let ino = rows.reduce((highest, row) => Math.max(highest, row.ino), 0);

    for (const path of [...(this.#whiteoutsOf(upper) ?? [])].sort()) {
      if (tree.has(path) || excluded(path)) continue;
      ino += 1;
      fields.push('c', String(ino), '1', '0', '0', '0', '0', '0.0000000000', '0.0000000000', '', path);
    }

    const payload = fields.length === 0 ? '' : Buffer.from(`${fields.join('\0')}\0`, 'utf8').toString('base64');

    return this.#say(`0 ${payload}`);
  }

  #whiteoutsOf(upper: string): ReadonlySet<string> | undefined {
    for (const [point, overlay] of this.disk.overlays) {
      if (overlay.upper === upper) return this.disk.whiteouts.get(point);
    }

    return undefined;
  }

  #whiteout(path: string): number {
    for (const [point, overlay] of this.disk.overlays) {
      const prefix = `${overlay.upper}/`;

      if (path.startsWith(prefix) && this.disk.whiteouts.get(point)?.has(path.slice(prefix.length)) === true) return this.#say('0,0\n');
    }

    return this.disk.node(path) === undefined ? this.#say('x\n') : this.#say('0,0\n');
  }

  #basestat(path: string): number {
    const node = this.disk.node(path);

    if (node === undefined) return this.#say('ABSENT\n');

    if (node.kind === 'dir') return this.#say('directory 4096\n');

    if (node.kind === 'symlink') return this.#say(`symbolic link ${(node.target ?? '').length}\n`);
    const size = nodeSize(node);

    return this.#say(`${size === 0 ? 'regular empty file' : 'regular file'} ${size}\n`);
  }

  #split(blockBytes: number, source: string, prefix: string): number {
    const node = this.disk.node(source);

    if (node === undefined || node.kind !== 'file') return 1;
    const bytes = bytesOf(node);
    // A full disk throws `DiskFull`, which `shell` reports as this line's exit.
    this.disk.charge(bytes.byteLength, prefix);

    for (let block = 0; block * blockBytes < bytes.byteLength; block += 1) {
      this.#pieces.set(`${prefix}${splitSuffix(block)}`, bytes.subarray(block * blockBytes, (block + 1) * blockBytes));
    }

    return 0;
  }

  #sha256sum(dir: string): number {
    const pieces = [...this.#pieces].filter(([name]) => name.startsWith(dir)).sort(([a], [b]) => (a < b ? -1 : 1));

    if (pieces.length === 0) return 1;

    for (const [name, bytes] of pieces) this.#out.push(`${createHash('sha256').update(bytes).digest('hex')}  ${name}\n`);

    return 0;
  }

  #ifBase(base: string, then: string, index: number): number {
    const node = this.disk.node(base);

    if (node === undefined || node.kind !== 'file' || nodeSize(node) === 0) return this.#say(`BEMPTY ${index}\n`);
    let status = 0;

    for (const statement of then.split('; ')) status = this.#line(statement);

    return status;
  }

  #mkdir(words: string): number {
    for (const m of words.matchAll(new RegExp(Q, 'g'))) {
      const path = unquote(m[1]);

      if (`${path}/`.includes(`/${DELTA_DIR}/`) || this.disk.writable(path) !== undefined) {
        const { tree, relative } = this.#dest(path);
        tree.mkdirp(relative);
      } else {
        this.disk.mkdirp(path);
      }
    }

    return 0;
  }

  #rmrf(path: string): number {
    let refund = 0;

    for (const [name, bytes] of this.#pieces) {
      if (!name.startsWith(`${path}/`)) continue;
      refund += bytes.byteLength;
      this.#pieces.delete(name);
    }

    this.disk.charge(-refund, path);
    this.disk.rmrf(path);

    return 0;
  }

  #chown(uid: number, gid: number, path: string): number {
    const { tree, relative } = this.#dest(path);
    const node = tree.node(relative);

    if (node === undefined) return 1;
    node.metadata = { ...node.metadata, uid, gid };

    return 0;
  }

  #chmod(mode: number, path: string): number {
    const { tree, relative } = this.#dest(path);
    const node = tree.node(relative);

    if (node === undefined) return 1;
    node.mode = mode;

    return 0;
  }

  #ln(existing: string, path: string): number {
    const from = this.#dest(existing);
    const to = this.#dest(path);

    if (from.tree !== to.tree) return 1;

    if (!from.tree.has(from.relative)) {
      // Through the merged view, a lower's file is copied up before it is
      // linked, as fuse-overlayfs does.
      const below = this.disk.node(existing);

      if (below === undefined) return 1;
      from.tree.plant([entryOf(below, from.relative)]);
    }

    from.tree.link(from.relative, to.relative);

    return 0;
  }

  #cpa(source: string, path: string): number {
    const node = this.disk.node(source);

    if (node === undefined) return 1;
    const { tree, relative } = this.#dest(path);
    tree.plant([entryOf(node, relative)]);

    return 0;
  }

  #cpOrEmpty(source: string, path: string): number {
    const node = this.disk.node(source);
    const { tree, relative } = this.#dest(path);

    if (node === undefined || node.kind !== 'file') {
      tree.writeFile(relative, new Uint8Array(0), ROOT_METADATA);

      return 0;
    }

    tree.plant([{ path: relative, kind: 'file', mode: 0o644, ino: 1, metadata: ROOT_METADATA, content: node.content }]);

    return 0;
  }

  #dd({ source, path, blockBytes, skip, block }: DdCommand): number {
    let bytes: Uint8Array;

    if (source === null) {
      bytes = new Uint8Array(blockBytes);
    } else {
      const node = this.disk.node(source);

      if (node === undefined || node.kind !== 'file') return 1;
      const held = bytesOf(node);
      bytes = skip ? held.subarray(block * blockBytes, (block + 1) * blockBytes) : held.subarray(0, blockBytes);
    }

    const { tree, relative } = this.#dest(path);

    if (skip) {
      tree.writeFile(relative, bytes, ROOT_METADATA);

      return 0;
    }

    if (!tree.has(relative)) tree.writeFile(relative, new Uint8Array(0), ROOT_METADATA);
    tree.pwrite(relative, block * blockBytes, bytes);

    return 0;
  }

  #truncate(size: number, path: string): number {
    const { tree, relative } = this.#dest(path);

    if (!tree.has(relative)) tree.writeFile(relative, new Uint8Array(0), ROOT_METADATA);
    tree.truncate(relative, size);

    return 0;
  }

  #manifest(encoded: string, path: string): number {
    const { tree, relative } = this.#dest(path);
    tree.writeFile(relative, Buffer.from(encoded, 'base64'), ROOT_METADATA);

    return 0;
  }

  #cat(path: string): number {
    const node = this.disk.node(path);

    if (node === undefined || node.kind !== 'file') return 1;

    return this.#say(new TextDecoder().decode(bytesOf(node)));
  }
}

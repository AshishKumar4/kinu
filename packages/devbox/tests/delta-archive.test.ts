// A delta's archive as `deltaTarCommand` cuts it, run on this host: what the overlay above the layers below will read.
import { afterAll, expect, test } from 'bun:test';
import * as v from 'valibot';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { deltaTarCommand } from '../src/disk-delta';
import { DEVBOX_SCRATCH_PREFIX } from './support/scratch';
import { runToExit } from '../../test-utils/src/spawn';

const root = mkdtempSync(join(tmpdir(), `${DEVBOX_SCRATCH_PREFIX}delta-`));

afterAll(() => { rmSync(root, { recursive: true, force: true }); });

const Entries = v.array(v.tuple([v.string(), v.string(), v.number()]));

const LIST = 'import json, sys, tarfile; print(json.dumps([[m.name, m.type.decode(), m.mode] for m in tarfile.open(fileobj=sys.stdin.buffer, mode="r|")]))';

/** The delta of `changed` and `deleted` over the tree `build` leaves: each entry's name, tar type and mode. `below`, the
 *  block digests held for the boundary, by the path they are of. */
async function cut(
  name: string, build: (tree: string) => void,
  { changed, deleted, below }: { readonly changed: readonly string[]; readonly deleted: readonly string[]; readonly below?: Readonly<Record<string, Buffer>> },
): Promise<v.InferOutput<typeof Entries>> {
  const at = join(root, name);
  const tree = join(at, 'tree');
  const blocks = join(at, 'blocks');

  mkdirSync(tree, { recursive: true });
  build(tree);
  writeFileSync(join(at, 'changes.changed'), changed.map((path) => `${path}\0`).join(''));
  writeFileSync(join(at, 'changes.deleted'), deleted.map((path) => `${path}\0`).join(''));

  if (below !== undefined) {
    mkdirSync(blocks);
    writeFileSync(join(blocks, 'paths'), Object.keys(below).map((path) => `${path}\0`).join(''));

    for (const [path, digests] of Object.entries(below)) writeFileSync(join(blocks, sha256(path)), digests);
  }

  const command = deltaTarCommand({ dir: tree, changes: join(at, 'changes'), below: below === undefined ? null : blocks, next: join(at, 'next'), listing: join(at, 'listing') });
  const ran = await runToExit(['bash', '-o', 'pipefail', '-c', `${command} | python3 -c '${LIST}'`]);

  expect(ran.stderr).toBe('');

  return v.parse(Entries, JSON.parse(ran.stdout));
}

const sha256 = (text: string | Buffer) => createHash('sha256').update(text).digest('hex');

/** What a delta's archive holds at `name`, read back from a second cut of the same tree. */
const READ = 'import sys, tarfile; t = tarfile.open(fileobj=sys.stdin.buffer, mode="r|")\nfor m in t:\n    if m.name == sys.argv[1]: sys.stdout.buffer.write(t.extractfile(m).read())';

const named = (entries: readonly [string, string, number][], under: string) => entries.filter(([name]) => name === under || name.startsWith(`${under}/`));

// A directory replaced by a file hides everything the layers below held under it: the file is the whole answer, and a
// whiteout under it would make the archive hold the same path as a file and as a directory.
test('a directory that became a file is one file, with nothing whited out under it', async () => {
  const entries = await cut('dir-to-file', (tree) => { writeFileSync(join(tree, 'a'), 'now a file\n'); }, { changed: ['a'], deleted: ['a/b'] });

  expect(named(entries, 'tree/a').map(([name, type]) => [name, type])).toEqual([['tree/a', '0']]);
});

// A layer carries the paths it answers for, and leaves the same list on this disk, so a later merge can be cut from it.
test('a delta holds the list of the paths it answers for, and leaves it on this disk', async () => {
  const entries = await cut('listed', (tree) => { writeFileSync(join(tree, 'kept'), 'kept\n'); }, { changed: ['kept'], deleted: ['gone'] });

  expect(entries.some(([name]) => name === '.devbox-delta/paths')).toBe(true);
  expect(readFileSync(join(root, 'listed', 'listing'), 'utf8')).toBe('kept\0gone\0');
});

// A whiteout's directory is written once, as it is: a second, made-up entry for it would replace its mode.
test('a deletion inside a kept directory leaves the directory as it is, once', async () => {
  const entries = await cut('kept-dir', (tree) => { mkdirSync(join(tree, 'private'), { mode: 0o700 }); }, { changed: ['private'], deleted: ['private/old'] });

  expect(named(entries, 'tree/private')).toEqual([['tree/private', '5', 0o700], ['tree/private/.wh.old', '0', 0o644]]);
});

// m1966b: a recovery reads a record only when its path is asked for. A large file changed in place is a record found by
// its path's SHA-256, and each directory above it names what leads to it; no manifest lists them all.
test('a large file changed in place is a record found by its path, its directories naming the way to it', async () => {
  const block = (byte: string) => Buffer.alloc(16_384, byte);
  // 1 MiB, the least a delta sends as changed blocks (disk-delta.ts `BIG`): 64 blocks, the second rewritten.
  const before = Buffer.concat(Array.from({ length: 64 }, () => createHash('sha256').update(block('A')).digest()));
  const build = (tree: string) => { mkdirSync(join(tree, 'src/deep'), { recursive: true }); writeFileSync(join(tree, 'src/deep/db.bin'), Buffer.concat(Array.from({ length: 64 }, (_, at) => block(at === 1 ? 'B' : 'A')))); };

  const entries = await cut('record', build, { changed: ['src/deep/db.bin'], deleted: [], below: { 'src/deep/db.bin': before } });
  const at = (path: string) => `${sha256(path).slice(0, 2)}/${sha256(path)}`;
  const held = (name: string) => entries.some(([entry]) => entry === name);

  expect({
    manifest: held('.devbox-delta/manifest.json'),
    record: held(`.devbox-delta/records/${at('src/deep/db.bin')}`),
    dirs: ['', 'src', 'src/deep'].map((dir) => held(`.devbox-delta/dirs/${at(dir)}`)),
    whole: held('tree/src/deep/db.bin'),
  }).toEqual({ manifest: false, record: true, dirs: [true, true, true], whole: false });

  const read = async (name: string) => {
    const command = deltaTarCommand({ dir: join(root, 'record/tree'), changes: join(root, 'record/changes'), below: join(root, 'record/blocks'), next: join(root, 'record/again'), listing: join(root, 'record/listing-again') });

    return (await runToExit(['bash', '-o', 'pipefail', '-c', `${command} | python3 -c '${READ}' '${name}'`])).stdout;
  };

  expect(JSON.parse(await read(`.devbox-delta/records/${at('src/deep/db.bin')}`))).toMatchObject({ p: 'src/deep/db.bin', s: 1_048_576, over: { count: 1 } });
  expect(await read(`.devbox-delta/dirs/${at('src')}`)).toBe('deep\0');
});

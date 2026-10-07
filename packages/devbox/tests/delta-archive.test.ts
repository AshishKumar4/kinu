// A delta's archive as `deltaTarCommand` cuts it, run on this host: what the overlay above the layers below will read.
import { afterAll, expect, test } from 'bun:test';
import * as v from 'valibot';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { deltaTarCommand } from '../src/disk-delta';
import { DEVBOX_SCRATCH_PREFIX } from './support/scratch';

const root = mkdtempSync(join(tmpdir(), `${DEVBOX_SCRATCH_PREFIX}delta-`));

afterAll(() => { rmSync(root, { recursive: true, force: true }); });

const Entries = v.array(v.tuple([v.string(), v.string(), v.number()]));

const LIST = 'import json, sys, tarfile; print(json.dumps([[m.name, m.type.decode(), m.mode] for m in tarfile.open(fileobj=sys.stdin.buffer, mode="r|")]))';

/** The delta of `changed` and `deleted` over the tree `build` leaves: each entry's name, tar type and mode. */
function cut(name: string, build: (tree: string) => void, changed: readonly string[], deleted: readonly string[]): v.InferOutput<typeof Entries> {
  const at = join(root, name);
  const tree = join(at, 'tree');

  mkdirSync(tree, { recursive: true });
  build(tree);
  writeFileSync(join(at, 'changes.changed'), changed.map((path) => `${path}\0`).join(''));
  writeFileSync(join(at, 'changes.deleted'), deleted.map((path) => `${path}\0`).join(''));
  const command = deltaTarCommand({ dir: tree, changes: join(at, 'changes'), below: null, next: join(at, 'next'), listing: join(at, 'listing') });
  const ran = spawnSync('bash', ['-o', 'pipefail', '-c', `${command} | python3 -c '${LIST}'`], { encoding: 'utf8' });

  expect(ran.stderr).toBe('');

  return v.parse(Entries, JSON.parse(ran.stdout));
}

const named = (entries: readonly [string, string, number][], under: string) => entries.filter(([name]) => name === under || name.startsWith(`${under}/`));

// A directory replaced by a file hides everything the layers below held under it: the file is the whole answer, and a
// whiteout under it would make the archive hold the same path as a file and as a directory.
test('a directory that became a file is one file, with nothing whited out under it', () => {
  const entries = cut('dir-to-file', (tree) => { writeFileSync(join(tree, 'a'), 'now a file\n'); }, ['a'], ['a/b']);

  expect(named(entries, 'tree/a').map(([name, type]) => [name, type])).toEqual([['tree/a', '0']]);
});

// A layer carries the paths it answers for, and leaves the same list on this disk, so a later merge can be cut from it.
test('a delta holds the list of the paths it answers for, and leaves it on this disk', () => {
  const entries = cut('listed', (tree) => { writeFileSync(join(tree, 'kept'), 'kept\n'); }, ['kept'], ['gone']);

  expect(entries.some(([name]) => name === '.devbox-delta/paths')).toBe(true);
  expect(readFileSync(join(root, 'listed', 'listing'), 'utf8')).toBe('kept\0gone\0');
});

// A whiteout's directory is written once, as it is: a second, made-up entry for it would replace its mode.
test('a deletion inside a kept directory leaves the directory as it is, once', () => {
  const entries = cut('kept-dir', (tree) => { mkdirSync(join(tree, 'private'), { mode: 0o700 }); }, ['private'], ['private/old']);

  expect(named(entries, 'tree/private')).toEqual([['tree/private', '5', 0o700], ['tree/private/.wh.old', '0', 0o644]]);
});

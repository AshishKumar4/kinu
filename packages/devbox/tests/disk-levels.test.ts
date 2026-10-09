// Which layers a save takes in (D77), and the changes a merged layer is cut from, run on this host.
import { afterAll, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { levelsAfter, mergeListsCommand } from '../src/disk-delta';
import { DEVBOX_SCRATCH_PREFIX } from './support/scratch';
import { runToExit } from '../../test-utils/src/spawn';

const root = mkdtempSync(join(tmpdir(), `${DEVBOX_SCRATCH_PREFIX}levels-`));

afterAll(() => { rmSync(root, { recursive: true, force: true }); });

interface Level { readonly key: string; readonly saves: number }

/** The chain `levels` holds after one more save, as `levelsAfter` cuts it. */
function saved(levels: readonly Level[], key: string, mounted: ReadonlySet<string> = new Set()): Level[] {
  const { keep, saves } = levelsAfter(levels, mounted);

  return [...levels.slice(0, keep), { key, saves }];
}

test('n saves since the base are held in at most floor(log2 n) + 1 deltas, every save in exactly one', () => {
  let levels: Level[] = [];

  for (let n = 1; n <= 1024; n++) {
    levels = saved(levels, `d${String(n)}`);

    expect(levels.length).toBeLessThanOrEqual(Math.floor(Math.log2(n)) + 1);
    expect(levels.reduce((sum, level) => sum + level.saves, 0)).toBe(n);
  }

  expect(levels.map((level) => level.saves)).toEqual([1024]);
});

test('a layer a recovery has mounted is never taken in; the layers above it count on their own', () => {
  const recovered = [{ key: 'a', saves: 4 }, { key: 'b', saves: 2 }, { key: 'c', saves: 1 }];
  const mounted = new Set(recovered.map((level) => level.key));
  let levels = saved(recovered, 'd', mounted);

  expect(levels.map((level) => level.saves)).toEqual([4, 2, 1, 1]);
  levels = saved(levels, 'e', mounted);
  expect(levels.map((level) => level.saves)).toEqual([4, 2, 1, 2]);
  expect(saved(levels, 'f').map((level) => level.saves)).toEqual([4, 2, 1, 2, 1]);
  expect(saved(saved(levels, 'f'), 'g').map((level) => level.saves)).toEqual([11]);
});

test('a chain from before the counter, a save a layer, is taken in whole at its next save', () => {
  expect(saved([{ key: 'a', saves: 1 }, { key: 'b', saves: 1 }, { key: 'c', saves: 1 }], 'd')).toEqual([{ key: 'd', saves: 4 }]);
});

const nul = (paths: readonly string[]) => paths.map((path) => `${path}\0`).join('');

const paths = (file: string) => readFileSync(file, 'utf8').split('\0').filter((path) => path !== '');

// A merged layer answers for every path any of its layers or this save touched: what is here now is written as it is,
// and what is gone is whited out, whichever layer last touched it.
test('a merged layer\'s changes are every path its layers or this save touched, split by what is here now', async () => {
  const changes = join(root, 'changes');
  const inventory = join(root, 'inventory');

  writeFileSync(`${changes}.changed`, nul(['src/now']));
  writeFileSync(`${changes}.deleted`, nul(['tmp']));
  writeFileSync(join(root, 'older'), nul(['src/old', 'tmp', 'tmp/x', 'back']));
  writeFileSync(join(root, 'newer'), nul(['back', 'gone/file']));
  writeFileSync(inventory, nul(['back\tf\t2\t1.0\t644\t', 'src\td\t0\t1.0\t755\t', 'src/now\tf\t3\t1.0\t644\t', 'src/old\tf\t1\t1.0\t644\t']));
  const ran = await runToExit(['bash', '-c', mergeListsCommand(changes, inventory, [join(root, 'older'), join(root, 'newer')])]);

  expect(ran.stderr).toBe('');
  expect([paths(`${changes}.changed`), paths(`${changes}.deleted`)]).toEqual([['back', 'src/now', 'src/old'], ['gone/file', 'tmp', 'tmp/x']]);
});

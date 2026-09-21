/**
 * The vendored Mossaic closure is bytes from another repository that Kinu never
 * edits and cannot re-fetch at build time, so `upstream.json` is the only thing
 * standing between "the SDK upstream published" and "whatever is on this disk".
 * That makes it a real external integrity boundary, and these are the failures
 * it exists to catch.
 *
 * The SET check is not theoretical. Measured 2026-09-20: a build that resolved
 * the wrong TypeScript selected the `tsgo` declaration generator, which emits
 * to a path derived from `--rootDir`; every vendored file outside `sdk/` landed
 * OUTSIDE the temporary out-dir and tsgo wrote 81 `.d.ts` files straight into
 * `shared/` and `worker/core/`. Every pinned digest still matched — none of
 * those files was pinned — so a digest-only loop would have called the tree
 * clean while the next build compiled generated declarations as if upstream
 * had shipped them.
 */
import { expect, test } from 'bun:test';
import { copyFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import * as v from 'valibot';
import { scratchDir } from '@kinu.run/test-utils';
import { MOSSAIC_MANIFEST, MOSSAIC_ROOT } from './sources';
import { verifyPinnedSource } from './mossaic-sdk';

const REPO_ROOT = join(import.meta.dir, '..');

const ManifestPaths = v.object({ vendored: v.record(v.string(), v.string()) });

const pinned = (): readonly string[] =>
  Object.keys(v.parse(ManifestPaths, JSON.parse(readFileSync(join(REPO_ROOT, MOSSAIC_MANIFEST), 'utf8'))).vendored);

/** The whole closure copied into scratch, so a case under test is the ONE
 *  difference from a clean tree rather than 102 incidental absences. */
function checkoutCopy() {
  const root = scratchDir('mossaic-closure');
  const files: string[] = [];

  mkdirSync(join(root, MOSSAIC_ROOT), { recursive: true });
  copyFileSync(join(REPO_ROOT, MOSSAIC_MANIFEST), join(root, MOSSAIC_MANIFEST));

  for (const file of pinned()) {
    const path = join(root, MOSSAIC_ROOT, file);

    mkdirSync(dirname(path), { recursive: true });
    copyFileSync(join(REPO_ROOT, MOSSAIC_ROOT, file), path);
    files.push(`${MOSSAIC_ROOT}/${file}`);
  }

  return { root, files };
}

test('the vendored closure matches the pinned upstream commit', () => {
  const verdict = verifyPinnedSource();

  expect(verdict.drift).toEqual([]);
  expect(verdict.commit).toBe('1bf170e07a07acc9cc62c5529dd10cfc2f829e72');
  expect(verdict.checked).toBe(pinned().length);

  // The three roots the SDK build needs: its own source, the `@shared` alias
  // target, and the worker objects that `index.ts` re-exports as the DO classes.
  for (const root of ['sdk/src/index.ts', 'shared/vfs-types.ts', 'worker/core/objects/user/index.ts']) {
    expect(pinned()).toContain(root);
  }
});

test('an edited upstream byte is named with both digests', () => {
  const { root, files } = checkoutCopy();
  const edited = 'shared/aimd.ts';
  const path = join(root, MOSSAIC_ROOT, edited);

  writeFileSync(path, `${readFileSync(path, 'utf8')}\n// local edit\n`);

  const { drift } = verifyPinnedSource(root, files);

  expect(drift.map(({ file }) => file)).toEqual([edited]);
  expect(drift[0]?.detail).toMatch(/^sha256 [0-9a-f]{64}, pinned [0-9a-f]{64}$/u);
});

test('a generated file the manifest never pinned is drift, not a clean tree', () => {
  const { root, files } = checkoutCopy();
  const generated = 'shared/aimd.d.ts';

  writeFileSync(join(root, MOSSAIC_ROOT, generated), 'export declare class AIMDController {}\n');

  const { drift } = verifyPinnedSource(root, [...files, `${MOSSAIC_ROOT}/${generated}`]);

  expect(drift).toEqual([
    { file: generated, detail: `present in the tree, absent from ${MOSSAIC_MANIFEST}` },
  ]);
});

test('a pinned path missing from the tree is drift', () => {
  const { root, files } = checkoutCopy();
  const dropped = 'worker/core/objects/shard/shard-do.ts';

  rmSync(join(root, MOSSAIC_ROOT, dropped));

  const { drift } = verifyPinnedSource(root, files.filter((file) => file !== `${MOSSAIC_ROOT}/${dropped}`));

  expect(drift).toEqual([
    { file: dropped, detail: `pinned in ${MOSSAIC_MANIFEST}, absent from the tree` },
  ]);
});

import { expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import * as v from 'valibot';
import { isVendoredSource, trackedFiles } from '../../scripts/sources';

const root = import.meta.dirname;
const Manifest = v.object({
  repository: v.string(),
  commit: v.pipe(v.string(), v.regex(/^[0-9a-f]{40}$/u)),
  vendored: v.record(v.string(), v.pipe(v.string(), v.regex(/^[0-9a-f]{64}$/u))),
});

test('every agent-core runtime file matches the pinned upstream bytes', () => {
  const manifest = v.parse(Manifest, JSON.parse(readFileSync(join(root, 'upstream.json'), 'utf8')));
  const files = trackedFiles().filter(isVendoredSource).map((file) => file.slice('packages/agent-core/'.length)).sort();
  expect(files).toEqual(Object.keys(manifest.vendored).sort());
  expect(files.some((file) => file.endsWith('.js'))).toBe(true);
  expect(files.some((file) => file.endsWith('.d.ts'))).toBe(true);
  for (const file of files) {
    const digest = createHash('sha256').update(readFileSync(join(root, file))).digest('hex');
    expect(digest, `${file} diverged from upstream ${manifest.commit}`).toBe(manifest.vendored[file]);
  }
});

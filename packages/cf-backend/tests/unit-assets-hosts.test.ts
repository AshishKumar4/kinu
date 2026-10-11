/**
 * `vite dev` admits the hosts src/assets-hosts.ts names and refuses every other. Nimbus fetches its staged assets under
 * a host it does not export, so this pins the name the module gives it to the one Nimbus's runtime fetches under: an
 * upgrade that moves it fails here, not as a TS slate that cannot build under dev.
 */
import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { ASSETS_HOSTS } from '../src/assets-hosts';

test("Nimbus fetches its staged assets under the host vite dev admits for it", () => {
  const worker = dirname(createRequire(import.meta.url).resolve('@nimbus-sh/worker/package.json'));
  const staged = readFileSync(join(worker, 'dist/runtime/staged-source.js'), 'utf8');

  expect([...staged.matchAll(/ASSETS\.fetch\(new Request\(`https:\/\/([^/$`]+)/g)].map((match) => match[1])).toEqual([ASSETS_HOSTS.nimbus]);
});

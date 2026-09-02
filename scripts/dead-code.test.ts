/**
 * The dependency census, proven RED IN BOTH DIRECTIONS and proven equal to the
 * tool it replaced.
 *
 * A census that only ever reports what it reports today is a snapshot. Three
 * obligations make it a gate: it must find a declaration nothing imports, it
 * must stop finding one the moment something does, and its ANSWER must be
 * reproducible by a second implementation — otherwise "16 unused declarations"
 * is a claim about one regex sweep and nobody can check it.
 *
 * knip 6.32.2's own `dependencies` pass is that second implementation, and the
 * join below is deliberately not an equality. It is a DIFFERENCE with a reason
 * required on each side, because both tools were wrong about this tree in
 * opposite ways and the wrongness is the interesting part:
 *
 *   - knip alone reported `vitest-evals`, which `tests/evals-artifact-contract.
 *     test.ts` imports. knip's root `entry` is `scripts/*.ts!` — top level only
 *     — so the eval suites are outside its entry globs and their imports do not
 *     count. Adopting knip's answer would have deleted a live declaration.
 *   - knip alone SPARED four this census reports on nothing but its own
 *     reading: `oxlint-tsgolint`, `typescript`, `just-bash` and
 *     `@rolldown/plugin-babel` — all four peer-required by a package declared
 *     in the same manifest, which is what {@link peerRequirers} exists to see.
 *     They are equal again once that rule runs, and this suite pins the rule.
 */

import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import * as v from 'valibot';

import {
  DEPENDENCY_REASONS, dependencyKeyOf, dependencyReason, manifestCommands, readInstalled,
  referencesPackage, servedBy, typedRuntime, unusedDependencies,
} from './dead-code';
import { isManifest, readRepositoryFile, trackedFiles } from './sources';

const root = new URL('..', import.meta.url).pathname;
const read = (file: string): string => readRepositoryFile(root, file);

const NOTHING = { specifiers: ['left-pad'], commands: ['left-pad'] };
const forms = (name: string, commands: readonly string[] = []) => ({
  specifiers: [name], commands: [name, ...commands],
});

/* ── What counts as a reference, form by form ──────────────────────────── */

describe('the reference forms', () => {
  test('a TypeScript import counts, in every spelling', () => {
    for (const line of [
      `import { x } from 'clsx';`,
      `import clsx from "clsx";`,
      `const x = require('clsx');`,
      `const x = await import('clsx');`,
      `import type { X } from 'clsx/types';`,
    ]) {
      expect(referencesPackage('packages/x/src/a.ts', line, forms('clsx'))).toBe(true);
    }
  });

  test('prose about a package is not a use of it', () => {
    const comment = '/** `workers-ai-provider` is installed but NOT used for chat inference. */';
    expect(referencesPackage('packages/core/src/usage.ts', comment, forms('workers-ai-provider')))
      .toBe(false);
  });

  test('an import that names the installed path counts', () => {
    const line = `import { rpc } from '../../../node_modules/@nimbus-sh/worker/dist/session/rpc.js';`;
    expect(referencesPackage('packages/cf-backend/tests/a.test.ts', line, forms('@nimbus-sh/worker')))
      .toBe(true);
  });

  test('a `node:` specifier references `node`, which is what @types/node types', () => {
    const line = `import { readFileSync } from 'node:fs';`;
    expect(referencesPackage('scripts/a.ts', line, { specifiers: ['@types/node', 'node'], commands: [] }))
      .toBe(true);
  });

  test('a stylesheet at-rule counts and a bare mention does not', () => {
    expect(referencesPackage('src/index.css', '@import "@cloudflare/kumo/styles/tailwind";',
      forms('@cloudflare/kumo'))).toBe(true);
    expect(referencesPackage('src/index.css', '/* kumo lives here */', forms('@cloudflare/kumo')))
      .toBe(false);
  });

  test('a config file counts a quoted value, and a shell line counts a command word', () => {
    expect(referencesPackage('a.jsonc', '{ "plugins": ["oxlint-tsgolint"] }',
      forms('oxlint-tsgolint'))).toBe(true);
    expect(referencesPackage('a.sh', 'bunx puppeteer browsers install chrome', forms('puppeteer')))
      .toBe(true);
    expect(referencesPackage('a.sh', 'tsc --noEmit -p tsconfig.json', forms('typescript', ['tsc'])))
      .toBe(true);
    expect(referencesPackage('a.sh', 'echo typescripts', forms('typescript', ['tsc']))).toBe(false);
  });

  test('a document references nothing: a README naming a package is not a use', () => {
    expect(referencesPackage('docs/X.md', 'We use `clsx` for class names.', forms('clsx')))
      .toBe(false);
    expect(referencesPackage('docs/X.md', 'import x from "clsx"', forms('clsx'))).toBe(false);
  });

  test('an unrelated package is never a reference', () => {
    expect(referencesPackage('a.ts', `import x from 'left-padding';`, NOTHING)).toBe(false);
  });
});

describe('the type companion', () => {
  test('@types/foo types foo, and @types/foo__bar types @foo/bar', () => {
    expect(typedRuntime('@types/minimist')).toBe('minimist');
    expect(typedRuntime('@types/babel__core')).toBe('@babel/core');
    expect(typedRuntime('minimist')).toBeUndefined();
  });
});

describe('which files a manifest serves', () => {
  test('the root manifest serves the whole tree, a package manifest its own directory', () => {
    expect(servedBy('package.json')('packages/core/src/a.ts')).toBe(true);
    const devbox = servedBy('packages/devbox/package.json');
    expect(devbox('packages/devbox/src/a.ts')).toBe(true);
    expect(devbox('packages/cf-backend/src/a.ts')).toBe(false);
  });

  test('a manifest is read for its commands, never for its declarations', () => {
    const commands = manifestCommands(JSON.stringify({
      dependencies: { clsx: '^2' }, devDependencies: { oxlint: '1' },
      scripts: { lint: 'oxlint .' },
    }));
    expect(commands).not.toContain('clsx');
    expect(commands).toContain('oxlint .');
  });
});

/* ── The census, red in both directions ────────────────────────────────── */

const MANIFEST = 'packages/probe/package.json';
const probe = (
  declarations: Record<string, string>,
  files: Record<string, string>,
  peers: Record<string, readonly string[]> = {},
) => unusedDependencies(
  [MANIFEST],
  [MANIFEST, ...Object.keys(files)],
  (file) => (file === MANIFEST ? JSON.stringify({ dependencies: declarations }) : files[file] ?? ''),
  () => [],
  (name) => peers[name] ?? [],
);

describe('the census', () => {
  test('a declaration nothing imports is reported', () => {
    const found = probe({ 'left-pad': '^1' }, { 'packages/probe/src/a.ts': 'export const x = 1;' });
    expect(found.map(dependencyKeyOf)).toEqual([`${MANIFEST}#left-pad (unused-dependency)`]);
  });

  test('and is not reported once one file imports it', () => {
    const found = probe({ 'left-pad': '^1' },
      { 'packages/probe/src/a.ts': `import pad from 'left-pad';` });
    expect(found).toEqual([]);
  });

  test('an import in ANOTHER package does not save a workspace declaration', () => {
    const found = probe({ 'left-pad': '^1' },
      { 'packages/other/src/a.ts': `import pad from 'left-pad';` });
    expect(found.map((d) => d.name)).toEqual(['left-pad']);
  });

  test('a peer contract this manifest opted into is a reference', () => {
    const files = { 'packages/probe/src/a.ts': `import { Agent } from 'agents';` };
    expect(probe({ 'left-pad': '^1', agents: '^1' }, files, { 'left-pad': ['agents'] }))
      .toEqual([]);
    // …and a peer requirer this manifest did NOT declare excuses nothing: that
    // is `fdir` peer-requiring `picomatch` while `packages/agent-utils` pulled
    // neither.
    expect(probe({ 'left-pad': '^1', agents: '^1' }, files, { 'left-pad': ['fdir'] })
      .map((d) => d.name)).toEqual(['left-pad']);
  });

  test('a census that reads no manifest reports nothing, which is why the gate counts them', () => {
    expect(unusedDependencies([], [], () => '{}', () => [], () => [])).toEqual([]);
  });
});

/* ── The tree as it stands ─────────────────────────────────────────────── */

const tracked = trackedFiles();
const manifests = tracked.filter(isManifest);
const installed = readInstalled(read('bun.lock'));
const live = unusedDependencies(
  manifests, tracked, read,
  (name) => installed.binaries.get(name) ?? [],
  (name) => installed.peerRequirers.get(name) ?? [],
);

describe('this repository', () => {
  test('every manifest is read and every declaration examined', () => {
    expect(manifests.length).toBeGreaterThanOrEqual(10);
    expect(manifests).toContain('package.json');
    expect(manifests).toContain('packages/cf-backend/package.json');
  });

  test('the deleted declarations stay deleted', () => {
    const declared = new Set(manifests.flatMap((manifest) => {
      const parsed = v.parse(
        v.object({
          dependencies: v.optional(v.record(v.string(), v.string()), {}),
          devDependencies: v.optional(v.record(v.string(), v.string()), {}),
        }),
        JSON.parse(read(manifest)),
      );
      return [...Object.keys(parsed.dependencies), ...Object.keys(parsed.devDependencies)]
        .map((name) => `${manifest}#${name}`);
    }));
    for (const gone of [
      'package.json#workers-ai-provider', 'package.json#puppeteer-core',
      'packages/agent-utils/package.json#minimist',
      'packages/agent-utils/package.json#picomatch',
      'packages/agent-utils/package.json#shell-quote',
      'packages/agent-utils/package.json#@types/minimist',
      'packages/agent-utils/package.json#@types/picomatch',
      'packages/agent-utils/package.json#@types/shell-quote',
      'packages/cf-backend/package.json#clsx',
      'packages/cf-backend/package.json#tailwind-merge',
      'packages/cf-backend/package.json#workers-ai-provider',
      'packages/cf-backend/package.json#@babel/plugin-proposal-decorators',
      'packages/test-utils/package.json#@kinu.run/agent-utils',
    ]) {
      expect(declared.has(gone)).toBe(false);
    }
  });

  test('every remaining finding carries its reason', () => {
    for (const found of live) {
      expect(dependencyReason(dependencyKeyOf(found))).toBeDefined();
    }
    // And no reason outlives its row.
    const keys = new Set(live.map(dependencyKeyOf));
    for (const key of Object.keys(DEPENDENCY_REASONS)) expect(keys.has(key)).toBe(true);
  });

  test('binary names come from the resolved graph, not from a table here', () => {
    expect(installed.binaries.get('typescript') ?? []).toContain('tsc');
    expect(installed.binaries.get('oxlint-tsgolint') ?? []).toContain('tsgolint');
    expect(installed.binaries.get('no-such-package-anywhere')).toBeUndefined();
    // A workspace link is a one-element lock row with no metadata at all.
    expect(installed.binaries.get('@kinu.run/core')).toBeUndefined();
  });

  test('the peer scan sees the contracts that keep four declarations alive', () => {
    expect(installed.peerRequirers.get('just-bash') ?? []).toContain('agents');
    expect(installed.peerRequirers.get('oxlint-tsgolint') ?? []).toContain('oxlint');
    expect(installed.peerRequirers.get('@rolldown/plugin-babel') ?? [])
      .toContain('@vitejs/plugin-react');
    expect((installed.peerRequirers.get('typescript') ?? []).length).toBeGreaterThan(0);
  });
});

/* ── The second implementation ─────────────────────────────────────────── */

/** knip's own dependency findings, `manifest#name` keyed. */
function knipDependencies(): Set<string> {
  const run = spawnSync(
    `${root}node_modules/.bin/knip`,
    ['--no-progress', '--include', 'dependencies', '--reporter', 'json'],
    { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 },
  );
  const Report = v.object({
    issues: v.optional(v.array(v.object({
      file: v.string(),
      dependencies: v.optional(v.array(v.object({ name: v.string() })), []),
      devDependencies: v.optional(v.array(v.object({ name: v.string() })), []),
    })), []),
  });
  const parsed = v.parse(Report, JSON.parse(run.stdout));
  const found = new Set<string>();
  for (const issue of parsed.issues) {
    for (const entry of [...issue.dependencies, ...issue.devDependencies]) {
      found.add(`${issue.file}#${entry.name}`);
    }
  }
  return found;
}

describe('measured against knip', () => {
  // knip's own pass over this tree takes 8.7 s wall on a loaded box (measured
  // 2026-09-02 under the push tier's parallel suites); bun's default per-test
  // bound is 5 s, and a bound below the tool's own duration made this test
  // red under load and green alone. The ceiling below is a bound on a finite
  // run, not a wait on a condition.
  test('the two agree on this tree, and the one difference is knip\'s entry-glob gap', () => {
    const knip = knipDependencies();
    const census = new Set(live.map((d) => `${d.manifest}#${d.name}`));
    expect(knip.size).toBeGreaterThan(0);

    const onlyKnip = [...knip].filter((key) => !census.has(key)).sort();
    const onlyCensus = [...census].filter((key) => !knip.has(key)).sort();

    // `tests/evals-artifact-contract.test.ts:62` imports it; knip's root entry
    // globs stop at `scripts/*.ts!`, so it cannot see that import.
    expect(onlyKnip).toEqual(['package.json#vitest-evals']);
    expect(onlyCensus).toEqual([]);
  }, 60_000);
});

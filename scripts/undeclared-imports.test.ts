/**
 * The undeclared-import census, proven RED IN BOTH DIRECTIONS.
 *
 * A census that only ever reports what it reports today is a snapshot. Three
 * obligations make it a gate: it must report an import no manifest of the
 * importing package declares, it must go quiet the moment that manifest
 * declares it, and it must NOT report the many bare-looking specifiers that
 * never reach `node_modules` at all — a gate whose first run is mostly noise
 * trains people to ignore it.
 *
 * The shape at the centre of this file is 8af794001: a package whose own
 * manifest declared nothing while thirty-two of its test files imported a
 * workspace package. It is reproduced here as a two-manifest tree, because the
 * one thing that must never happen is a rule that reads "the root declares it"
 * as a defence — that is the precise statement of the defect.
 */

import { describe, expect, test } from 'bun:test';

import {
  aliasPrefixes, census, isPackageSpecifier, keyOf, type OwningPackage, ownerOf, packageOf,
  readPackages, workspaceGlobMatches,
} from './undeclared-imports';

/** The 8af794001 tree: a workspace root that pins the third-party world and
 *  claims `packages/*`, and one member declaring nothing at all. */
const WORKSPACE = new Map([
  ['package.json', JSON.stringify({
    name: 'kinu',
    workspaces: ['packages/*'],
    dependencies: { valibot: '1.1.0' },
    devDependencies: { vitest: '4.0.0' },
  })],
  ['packages/cli-backend/package.json', JSON.stringify({ name: '@kinu.run/cli-backend' })],
  ['packages/test-utils/package.json', JSON.stringify({ name: '@kinu.run/test-utils' })],
]);

const packagesOf = (
  manifests: ReadonlyMap<string, string> = WORKSPACE,
  tsconfigs: ReadonlyMap<string, string> = new Map(),
): OwningPackage[] => readPackages(manifests, (directory) => tsconfigs.get(`${directory}tsconfig.json`));

const edgesIn = (
  sources: ReadonlyMap<string, string>,
  manifests: ReadonlyMap<string, string> = WORKSPACE,
  tsconfigs: ReadonlyMap<string, string> = new Map(),
): string[] => census(packagesOf(manifests, tsconfigs), sources).edges.map(keyOf);

/* ── The defect, both directions ───────────────────────────────────────── */

describe('an import its own manifest never declares', () => {
  test('is reported, and the root pin that resolves it is not a defence', () => {
    const sources = new Map([
      ['packages/cli-backend/tests/workspace-resolution.test.ts',
        `import { build } from '@kinu.run/test-utils';\nimport * as v from 'valibot';\n`],
    ]);

    // `valibot` resolves here only because the ROOT declares it and the linker
    // is hoisted — which is the finding, not the exemption.
    expect(edgesIn(sources)).toEqual([
      'packages/cli-backend/package.json imports @kinu.run/test-utils',
      'packages/cli-backend/package.json imports valibot',
    ]);
  });

  test('goes quiet once that manifest declares it, in any of the four fields', () => {
    const sources = new Map([
      ['packages/cli-backend/src/a.ts', `import * as v from 'valibot';\n`],
    ]);

    for (const field of [
      'dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies',
    ]) {
      const declared = new Map(WORKSPACE);
      declared.set('packages/cli-backend/package.json', JSON.stringify({
        name: '@kinu.run/cli-backend',
        [field]: { valibot: '1.1.0' },
      }));
      expect(edgesIn(sources, declared)).toEqual([]);
    }
  });

  test('a sibling package declaring it does not declare it here', () => {
    const declared = new Map(WORKSPACE);
    declared.set('packages/test-utils/package.json', JSON.stringify({
      name: '@kinu.run/test-utils',
      dependencies: { valibot: '1.1.0' },
    }));
    const sources = new Map([['packages/cli-backend/src/a.ts', `import * as v from 'valibot';\n`]]);
    expect(edgesIn(sources, declared)).toEqual(['packages/cli-backend/package.json imports valibot']);
  });

  test('every importing file lands on the one edge, so a moved file is not a new one', () => {
    const sources = new Map([
      ['packages/cli-backend/src/a.ts', `import * as v from 'valibot';\n`],
      ['packages/cli-backend/src/b.ts', `import * as v from 'valibot';\n`],
      ['packages/cli-backend/tests/c.test.ts', `export { x } from 'valibot';\n`],
    ]);

    const found = census(packagesOf(), sources).edges;
    expect(found).toHaveLength(1);
    expect(found[0]?.importers).toEqual([
      'packages/cli-backend/src/a.ts',
      'packages/cli-backend/src/b.ts',
      'packages/cli-backend/tests/c.test.ts',
    ]);
  });
});

/* ── What the workspace root alone may claim ───────────────────────────── */

describe('the workspace scope', () => {
  test('a root-served file may import a member the root `workspaces` globs claim', () => {
    const sources = new Map([
      ['scripts/probe.ts', `import { build } from '@kinu.run/test-utils';\n`],
      ['tests/evals/harness.ts', `import { x } from '@kinu.run/cli-backend';\n`],
    ]);

    expect(edgesIn(sources)).toEqual([]);
  });

  test('a MEMBER importing another member still needs its own declaration', () => {
    const sources = new Map([
      ['packages/cli-backend/src/a.ts', `import { build } from '@kinu.run/test-utils';\n`],
    ]);

    expect(edgesIn(sources))
      .toEqual(['packages/cli-backend/package.json imports @kinu.run/test-utils']);
  });

  test('a package may always import itself', () => {
    const sources = new Map([
      ['packages/cli-backend/src/a.ts', `import { x } from '@kinu.run/cli-backend/env';\n`],
    ]);

    expect(edgesIn(sources)).toEqual([]);
  });

  test('a glob claims one path segment, and a directory it does not reach stays unclaimed', () => {
    expect(workspaceGlobMatches('packages/*', 'packages/core')).toBe(true);
    expect(workspaceGlobMatches('packages/*', 'packages/core/nested')).toBe(false);
    expect(workspaceGlobMatches('packages/*', 'tools/oxlint')).toBe(false);
    expect(workspaceGlobMatches('packages/**', 'packages/core/nested')).toBe(true);
  });
});

/* ── What is not a package at all ──────────────────────────────────────── */

describe('specifiers that never reach node_modules', () => {
  test('builtins, schemes, relative paths and private subpaths are not packages', () => {
    for (const specifier of [
      'node:fs', 'node:fs/promises', 'fs', 'fs/promises', 'bun:test', 'bun:sqlite',
      'cloudflare:workers', './local', '../up', '/abs', '#internal',
    ]) {
      expect(isPackageSpecifier(specifier)).toBe(false);
    }
  });

  test('a bare name and a scoped name are', () => {
    for (const specifier of ['valibot', '@kinu.run/core', 'ai/mcp-stdio', '@ai-sdk/openai/edge']) {
      expect(isPackageSpecifier(specifier)).toBe(true);
    }
  });

  test('a subpath is judged by the package it resolves to', () => {
    expect(packageOf('ai/mcp-stdio')).toBe('ai');
    expect(packageOf('@ai-sdk/openai/edge')).toBe('@ai-sdk/openai');
    expect(packageOf('valibot')).toBe('valibot');
  });

  test('a tsconfig path alias is the package\'s own source, not a dependency', () => {
    const tsconfigs = new Map([['packages/cli-backend/tsconfig.json', `{
      // A comment, because tsconfig is JSONC and one of these took eight tests down.
      "compilerOptions": { "paths": { "@/*": ["./src/*"] } }
    }`]]);

    const sources = new Map([
      ['packages/cli-backend/src/a.ts', `import { x } from '@/lib';\nimport { y } from '@scope/real';\n`],
    ]);

    expect(edgesIn(sources, WORKSPACE, tsconfigs))
      .toEqual(['packages/cli-backend/package.json imports @scope/real']);
  });

  test('the alias prefix is everything before the pattern\'s star', () => {
    expect(aliasPrefixes('{"compilerOptions":{"paths":{"@/*":["./src/*"],"~lib/*":["./lib/*"]}}}'))
      .toEqual(['~lib/', '@/']);
  });
});

/* ── Which manifest answers for a file ─────────────────────────────────── */

describe('the manifest that owns a file', () => {
  test('is the nearest one above it, never a further one that could also resolve it', () => {
    const packages = packagesOf();
    expect(ownerOf('packages/cli-backend/src/a.ts', packages)?.manifest)
      .toBe('packages/cli-backend/package.json');
    expect(ownerOf('scripts/probe.ts', packages)?.manifest).toBe('package.json');
  });
});

/* ── The census cannot report a clean tree over nothing ────────────────── */

describe('the denominator', () => {
  test('counts every specifier seen and every package specifier judged', () => {
    const sources = new Map([
      ['packages/cli-backend/src/a.ts',
        `import { readFileSync } from 'node:fs';\nimport './local';\nimport * as v from 'valibot';\n`],
    ]);

    const found = census(packagesOf(), sources);
    expect(found.specifiers).toBe(3);
    expect(found.examined).toBe(1);
  });
});

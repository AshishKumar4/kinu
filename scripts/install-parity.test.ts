// The installed tree against the lock that names it. Red is a planted stale package in a workspace's own
// node_modules, the state the primary checkout's cf-backend held wrangler 4.123.0 in on 2026-09-26.
import { describe, expect, test } from 'bun:test';
import { mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { scratchDir } from '@kinu.run/test-utils';
import { installDrift } from './install-parity';
import { bindPinnedCompiler } from './mossaic-sdk';
import { MOSSAIC_SDK } from './sources';

const LOCK = `{
  "lockfileVersion": 1,
  "workspaces": {
    "": { "name": "fixture", "devDependencies": { "tool": "2.0.0", "native-elsewhere": "1.0.0" } },
    "packages/app": { "name": "@fx/app", "dependencies": { "dep": "^3" } },
    "${MOSSAIC_SDK}": { "name": "@mossaic/sdk" },
  },
  "packages": {
    "@fx/app": ["@fx/app@workspace:packages/app"],
    "@mossaic/sdk": ["@mossaic/sdk@workspace:${MOSSAIC_SDK}"],
    "tool": ["tool@2.0.0", "", {}, "sha512-a"],
    "dep": ["dep@4.0.0", "", {}, "sha512-b"],
    "lib": ["lib@1.0.0", "", { "dependencies": { "dep": "^3" } }, "sha512-c"],
    "lib/dep": ["dep@3.0.0", "", {}, "sha512-d"],
    "@fx/app/dep": ["dep@3.0.0", "", {}, "sha512-d"],
    "native-elsewhere": ["native-elsewhere@1.0.0", "", { "os": "none" }, "sha512-e"],
    "rolldown-plugin-dts": ["rolldown-plugin-dts@0.27.14", "", {}, "sha512-f"],
    "vendored": ["vendored@1.0.0", "", {}, "sha512-i"],
    "typescript": ["typescript@7.0.2", "", {}, "sha512-g"],
    "@mossaic/sdk/typescript": ["typescript@6.0.3", "", {}, "sha512-h"],
  },
}
`;

function install(root: string, path: string, version: string): void {
  mkdirSync(join(root, path), { recursive: true });
  writeFileSync(join(root, path, 'package.json'), JSON.stringify({ version }));
}

/** A checkout whose installed tree is exactly the one LOCK names on a machine `native-elsewhere` does not fit. */
function checkout(name: string): string {
  const root = scratchDir(name);

  writeFileSync(join(root, 'bun.lock'), LOCK);
  install(root, 'packages/app', '0.0.0');
  install(root, MOSSAIC_SDK, '0.0.0');
  install(root, 'node_modules/tool', '2.0.0');
  install(root, 'node_modules/dep', '4.0.0');
  install(root, 'node_modules/lib', '1.0.0');
  install(root, 'packages/app/node_modules/dep', '3.0.0');
  // bun links a nested copy to an identical one elsewhere; each place is still its own install.
  mkdirSync(join(root, 'node_modules/lib/node_modules'), { recursive: true });
  symlinkSync(join(root, 'packages/app/node_modules/dep'), join(root, 'node_modules/lib/node_modules/dep'), 'dir');
  mkdirSync(join(root, 'node_modules/@fx'), { recursive: true });
  symlinkSync(join(root, 'packages/app'), join(root, 'node_modules/@fx/app'), 'dir');
  install(root, 'node_modules/rolldown-plugin-dts', '0.27.14');
  install(root, 'node_modules/vendored', '1.0.0');
  install(root, 'node_modules/typescript', '7.0.2');
  install(root, `${MOSSAIC_SDK}/node_modules/typescript`, '6.0.3');
  mkdirSync(join(root, 'node_modules/.bin'), { recursive: true });

  return root;
}

describe('the installed tree is the one bun.lock names', () => {
  test('a tree the lock describes has no drift: nested versions, linked copies, a skipped platform package', () => {
    expect(installDrift(checkout('install-parity-clean'))).toEqual([]);
  });

  test.each([
    ['a stale package in a workspace\'s node_modules, shadowing the root\'s,', 'packages/app/node_modules/tool', '1.0.0', 'where bun.lock installs nothing'],
    ['a package at another version than the lock names at its path', 'node_modules/tool', '2.1.0', 'where bun.lock names 2.0.0'],
  ])('%s is drift', (_case, path, version, where) => {
    const root = checkout(`install-parity-${version}`);

    install(root, path, version);

    expect(installDrift(root)).toEqual([`${join(root, path)} holds ${version} ${where}`]);
  });

  test('a link into the repository that is not a workspace is a package, held to the lock', () => {
    const root = checkout('install-parity-vendor');

    install(root, 'vendor/vendored', '9.9.9');
    rmSync(join(root, 'node_modules/vendored'), { recursive: true });
    symlinkSync(join(root, 'vendor/vendored'), join(root, 'node_modules/vendored'), 'dir');

    expect(installDrift(root)).toEqual([`${join(root, 'node_modules/vendored')} holds 9.9.9 where bun.lock names 1.0.0`]);
  });

  test('a scope linked to a checkout that removed it is drift, named, and never a crash', () => {
    // A linked worktree after its donor dropped a package bun.lock no longer names: the scope's link dangles.
    const root = checkout('install-parity-scope');

    symlinkSync(join(root, 'donor/node_modules/@gone'), join(root, 'node_modules/@gone'), 'dir');

    expect(installDrift(root)).toEqual([`${join(root, 'node_modules/@gone')} holds no readable package where bun.lock installs nothing`]);
  });

  test('a nested package the lock places, missing under its installed parent, is drift', () => {
    const root = checkout('install-parity-missing');

    rmSync(join(root, 'node_modules/lib/node_modules/dep'));

    expect(installDrift(root)).toEqual(['lib/dep@3.0.0 is missing: bun.lock places it under lib, which resolves another copy without it']);
  });

  // 2026-10-01: a deploy worktree installed before chess.js joined the lock ran every gate without it, and the old
  // check, reading only what is installed, called the tree clean.
  test('a package a workspace declares, absent from the tree, is drift; one the lock skips on this platform is not', () => {
    const root = checkout('install-parity-undeclared');

    rmSync(join(root, 'node_modules/tool'), { recursive: true });

    expect(installDrift(root)).toEqual(['tool is missing: fixture declares it and bun.lock installs it']);
  });

  test('the SDK build\'s compiler link is part of the tree while it reaches the pinned compiler', () => {
    const root = checkout('install-parity-compiler');
    const link = join(root, 'node_modules/rolldown-plugin-dts/node_modules/typescript');

    bindPinnedCompiler(root);

    expect(installDrift(root)).toEqual([]);

    rmSync(link);
    mkdirSync(dirname(link), { recursive: true });
    symlinkSync(join(root, 'node_modules/typescript'), link, 'dir');

    expect(installDrift(root)).toEqual([`${join(root, 'node_modules/rolldown-plugin-dts/node_modules/typescript')} holds 7.0.2 where bun.lock installs nothing`]);
  });
});

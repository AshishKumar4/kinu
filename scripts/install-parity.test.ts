// The installed tree against the lock that names it. Red is a planted stale package in a workspace's own
// node_modules, the state the primary checkout's cf-backend held wrangler 4.123.0 in on 2026-09-26.
import { describe, expect, test } from 'bun:test';
import { chmodSync, copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { childEnv, scratchDir } from '@kinu.run/test-utils';
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
  test.each(['2.0.0', '1.0.0'])('worktree setup borrows only a donor installed at the matching lock’s version: %s', (version) => {
    const donor = checkout('install-parity-donor');
    const tree = scratchDir('install-parity-worktree');
    const bin = scratchDir('install-parity-bootstrap');
    const log = join(bin, 'install.log');

    install(donor, 'node_modules/tool', version);
    mkdirSync(join(donor, '.git'));
    mkdirSync(join(donor, 'scripts'));
    mkdirSync(join(donor, 'patches'));
    writeFileSync(join(donor, 'package.json'), JSON.stringify({ workspaces: ['packages/*', MOSSAIC_SDK] }));
    writeFileSync(join(donor, 'packages/app/package.json'), JSON.stringify({ name: '@fx/app', version: '0.0.0' }));
    writeFileSync(join(donor, MOSSAIC_SDK, 'package.json'), JSON.stringify({ name: '@mossaic/sdk', version: '0.0.0' }));
    writeFileSync(join(donor, 'scripts/install-parity.ts'), `import { installDrift } from ${JSON.stringify(join(import.meta.dir, 'install-parity.ts'))}; process.exit(installDrift(${JSON.stringify(donor)}).length === 0 ? 0 : 1);`);

    for (const file of ['package.json', 'bun.lock', 'packages/app/package.json', `${MOSSAIC_SDK}/package.json`]) {
      mkdirSync(dirname(join(tree, file)), { recursive: true });
      copyFileSync(join(donor, file), join(tree, file));
    }

    mkdirSync(join(tree, 'scripts'));
    mkdirSync(join(tree, 'patches'));
    copyFileSync(join(import.meta.dir, 'setup-worktree.sh'), join(tree, 'scripts/setup-worktree.sh'));
    copyFileSync(join(import.meta.dir, 'repo-runtime.sh'), join(tree, 'scripts/repo-runtime.sh'));
    symlinkSync(join(donor, 'node_modules'), join(tree, 'node_modules'), 'dir');

    const bootstrap = `#!/usr/bin/bash
if [ "$1" = install ]; then
  printf '%s\\n' "$PWD" >> "$KINU_WORKTREE_INSTALL_LOG"
  mkdir -p node_modules/tool node_modules/.bin
  printf '%s' '{"version":"2.0.0"}' > node_modules/tool/package.json
  cp "$KINU_WORKTREE_BOOTSTRAP" node_modules/.bin/bun
  exit 0
fi
case "\${1##*/}" in mossaic-sdk.ts|ladder.ts) exit 0 ;; esac
exec ${JSON.stringify(resolve(import.meta.dir, '../node_modules/.bin/bun'))} "$@"
`;

    writeFileSync(join(bin, 'bun'), bootstrap);
    chmodSync(join(bin, 'bun'), 0o755);
    copyFileSync(join(bin, 'bun'), join(donor, 'node_modules/.bin/bun'));
    chmodSync(join(donor, 'node_modules/.bin/bun'), 0o755);
    writeFileSync(join(bin, 'git'), `#!/usr/bin/bash
case "$*" in
  'rev-parse --show-toplevel') printf '%s\\n' "$KINU_WORKTREE_ROOT" ;;
  'rev-parse --git-common-dir') printf '%s/.git\\n' "$KINU_WORKTREE_DONOR" ;;
  *) exit 87 ;;
esac
`);
    chmodSync(join(bin, 'git'), 0o755);

    const run = Bun.spawnSync(['bash', 'scripts/setup-worktree.sh'], { cwd: tree, env: childEnv({
      PATH: `${bin}:/usr/bin:/bin`, KINU_WORKTREE_ROOT: tree, KINU_WORKTREE_DONOR: donor,
      KINU_WORKTREE_INSTALL_LOG: log, KINU_WORKTREE_BOOTSTRAP: join(bin, 'bun'),
    }), stdout: 'pipe', stderr: 'pipe' });

    expect(run.exitCode, run.stderr.toString()).toBe(0);
    expect(readFileSync(join(donor, 'node_modules/tool/package.json'), 'utf8')).toBe(JSON.stringify({ version }));

    const installed = version === '1.0.0';

    expect(lstatSync(join(tree, 'node_modules/tool')).isSymbolicLink()).toBe(!installed);
    expect(readFileSync(join(tree, 'node_modules/tool/package.json'), 'utf8')).toBe('{"version":"2.0.0"}');
    expect(existsSync(log)).toBe(installed);

    if (installed) expect(readFileSync(log, 'utf8').trim()).toBe(tree);
  });

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

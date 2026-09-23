/**
 * The linked-install guard refuses BEFORE bun writes anything.
 *
 * Measured through this tree's real wiring — its `bunfig.toml`, the scanner
 * bundle that file names, and the root `preinstall` — copied into a throwaway
 * checkout whose `node_modules` links into a throwaway primary, the layout
 * `setup-worktree.sh` makes. The checkout asks for a version the primary does
 * not hold, so an install that proceeds writes: under the root `preinstall`
 * guard bun 1.4.0 saved the lockfile and wrote the new version through the
 * linked scope directory into the primary before the refusal ran.
 */
import { describe, expect, test } from 'bun:test';
import {
  copyFileSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, readlinkSync, rmSync, symlinkSync, writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import * as v from 'valibot';
import { childEnv, scratchDir } from '@kinu.run/test-utils';

const REPO = join(import.meta.dir, '..');

/** What an install reads of this tree before it resolves anything: the config
 *  naming the scanner, the scanner, and the program the root `preinstall` runs. */
const WIRING = ['bunfig.toml', 'scripts/security-scanner.bundle.js', 'scripts/refuse-linked-install.ts'];

const RootScripts = v.object({ scripts: v.optional(v.record(v.string(), v.string()), {}) });

interface Layout {
  readonly primary: string;
  readonly checkout: string;
}

function write(path: string, text: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
}

/** A primary holding `@s/dep` and `plain` at 1.0.0, and a checkout asking for
 *  both at 2.0.0 with this tree's wiring. `node_modules` is what `modules` says:
 *  links into the primary, as `setup-worktree.sh` mirrors them, or absent. */
function layout(modules: 'linked' | 'absent'): Layout {
  const root = scratchDir('linked-install');
  const primary = join(root, 'primary');
  const checkout = join(root, 'checkout');
  const preinstall = v.parse(RootScripts, JSON.parse(readFileSync(join(REPO, 'package.json'), 'utf8'))).scripts.preinstall;

  for (const [name, at] of [['@s/dep', 'dep'], ['plain', 'plain']] as const) {
    write(join(primary, 'node_modules', name, 'package.json'), JSON.stringify({ name, version: '1.0.0' }));
    write(join(root, `${at}-v2`, 'package.json'), JSON.stringify({ name, version: '2.0.0' }));
  }

  write(join(checkout, 'package.json'), JSON.stringify({
    name: 'checkout',
    private: true,
    scripts: preinstall === undefined ? {} : { preinstall },
    dependencies: { '@s/dep': 'file:../dep-v2', plain: 'file:../plain-v2' },
  }));

  for (const file of WIRING) {
    mkdirSync(dirname(join(checkout, file)), { recursive: true });
    copyFileSync(join(REPO, file), join(checkout, file));
  }

  if (modules === 'linked') linkInto(checkout);

  return { primary, checkout };
}

/** Replace the checkout's `node_modules` with one link per primary entry, as
 *  `setup-worktree.sh` mirrors a worktree's. */
function linkInto(checkout: string): void {
  rmSync(join(checkout, 'node_modules'), { recursive: true, force: true });
  mkdirSync(join(checkout, 'node_modules'));

  for (const entry of ['@s', 'plain']) symlinkSync(join('..', '..', 'primary', 'node_modules', entry), join(checkout, 'node_modules', entry));
}

/** Every path under `dir` with what it is: a link's target, a file's bytes. */
function snapshot(dir: string) {
  const seen = new Map<string, string>();

  const walk = (at: string): void => {
    for (const name of readdirSync(at)) {
      const path = join(at, name);
      const stat = lstatSync(path);

      if (stat.isSymbolicLink()) seen.set(path, `-> ${readlinkSync(path)}`);
      else if (stat.isDirectory()) walk(path);
      else seen.set(path, readFileSync(path, 'utf8'));
    }
  };

  walk(dir);

  return seen;
}

function bun(checkout: string, ...args: string[]) {
  const proc = Bun.spawnSync([process.execPath, ...args], {
    cwd: checkout,
    env: childEnv({ BUN_INSTALL_CACHE_DIR: join(dirname(checkout), 'cache') }),
    stdout: 'pipe',
    stderr: 'pipe',
  });

  return { exitCode: proc.exitCode, output: `${proc.stdout.toString()}${proc.stderr.toString()}` };
}

describe('bun install over node_modules linked into another checkout', () => {
  test('is refused before the lockfile or any module is written, here or through the links', () => {
    const { primary, checkout } = layout('linked');
    const primaryBefore = snapshot(primary);
    const modulesBefore = snapshot(join(checkout, 'node_modules'));

    const install = bun(checkout, 'install');

    expect(install.exitCode, install.output).not.toBe(0);
    expect(install.output).toContain('refuse-linked-install');
    expect(snapshot(primary)).toEqual(primaryBefore);
    expect(snapshot(join(checkout, 'node_modules'))).toEqual(modulesBefore);
    expect(existsSync(join(checkout, 'bun.lock'))).toBe(false);
  });

  test('bun pm scan, which writes nothing, still scans', () => {
    // A scan reads the lockfile, which only an install writes.
    const { checkout } = layout('absent');
    expect(bun(checkout, 'install').exitCode).toBe(0);
    linkInto(checkout);

    const scan = bun(checkout, 'pm', 'scan');
    expect(scan.exitCode, scan.output).toBe(0);
    expect(scan.output).not.toContain('refuse-linked-install');
  });
});

describe('bun install where nothing links out', () => {
  test('installs: with no node_modules, and again over the real one it made', () => {
    const { checkout } = layout('absent');
    const first = bun(checkout, 'install');
    expect(first.exitCode, first.output).toBe(0);
    expect(JSON.parse(readFileSync(join(checkout, 'node_modules', '@s', 'dep', 'package.json'), 'utf8'))).toMatchObject({ version: '2.0.0' });

    const again = bun(checkout, 'install');
    expect(again.exitCode, again.output).toBe(0);
  });

  test('installs over a link that resolves inside the checkout, the shape of a workspace package', () => {
    const { checkout } = layout('absent');
    write(join(checkout, 'packages', 'local', 'package.json'), JSON.stringify({ name: 'local', version: '1.0.0' }));
    mkdirSync(join(checkout, 'node_modules'));
    symlinkSync(join('..', 'packages', 'local'), join(checkout, 'node_modules', 'local'));

    const install = bun(checkout, 'install');
    expect(install.exitCode, install.output).toBe(0);
  });
});

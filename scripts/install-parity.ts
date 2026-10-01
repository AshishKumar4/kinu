#!/usr/bin/env bun
/**
 * THE INSTALLED TREE IS THE ONE `bun.lock` NAMES. Every gate here runs on `node_modules`, and the ladder's cache
 * keys stand `bun.lock` and `patches/` in for it (`ladder-closure.ts`), so a tree that drifted from the lock makes
 * every verdict, fresh or cached, one about packages nobody resolved.
 *
 * THE INCIDENT. On 2026-09-26 the primary checkout's `packages/cf-backend/node_modules/wrangler` was 4.123.0, left by
 * an install in August that no later install pruned, while `bun.lock` resolves wrangler 4.129.0 at the root and
 * nothing for cf-backend. Every deploy's `npx wrangler` from packages/cf-backend ran a version the lock does not
 * name, and every linked worktree inherited it. `gate:patch-parity` checks the bytes of patched packages, not
 * versions, and nothing else looked.
 *
 * THE RULE. A key of the lock's `packages` is an install path: `wrangler` is `node_modules/wrangler`,
 * `@cloudflare/vite-plugin/wrangler` is the `node_modules` nested in `@cloudflare/vite-plugin`, and a key that
 * starts with a workspace's name is that workspace's own `node_modules` (`@mossaic/sdk/typescript`). So each
 * package directory under the root's, each workspace's and each package's nested `node_modules` must be a key of
 * the lock at the version the lock names. A package where the lock installs nothing is drift even when it is newer:
 * resolution walks up from the nearest `node_modules`, so a nested one SHADOWS the one the lock placed above it,
 * and a top-level one answers an import nothing declares. The other direction is drift where it changes an
 * answer: a nested package the lock places under an installed parent, missing, lets that parent resolve the
 * hoisted copy instead. A missing top-level package fails its import aloud, and the lock also lists the subtrees
 * of platform packages bun skips, whose parents are not installed.
 *
 * NOT READ: the bytes of an installed package (`gate:patch-parity` owns the patched ones), `.bin` links, and a
 * workspace link's target.
 */

import { existsSync, readFileSync, readdirSync, realpathSync, statSync } from 'node:fs';
import { join } from 'node:path';
import * as v from 'valibot';
import { tolerate } from '@kinu.run/core/obs';
import { finding } from './gate-ratchet';
import { parseJsonc } from './jsonc';
import { PINNED_COMPILER_LINK } from './mossaic-sdk';

/** One `bun.lock` package row: `[name@version, registry, metadata, integrity]`; a workspace link is `[name@workspace:path]`. */
const LockRow = v.pipe(v.array(v.unknown()), v.minLength(1));

/** A platform field, one name or several, read as the list it means. */
const PlatformField = v.optional(v.pipe(v.union([v.string(), v.array(v.string())]), v.transform((value) => [value].flat())));

const LockMeta = v.looseObject({ os: PlatformField, cpu: PlatformField });

const Declared = v.optional(v.record(v.string(), v.string()), {});

const LockSchema = v.looseObject({
  workspaces: v.record(v.string(), v.looseObject({ name: v.optional(v.string()), dependencies: Declared, devDependencies: Declared })),
  packages: v.record(v.string(), LockRow),
});

const PackageVersion = v.looseObject({ version: v.optional(v.string()) });

/** What the lock installs on this machine: each install key's version, each workspace's name by its path, and each
 *  package a workspace declares, by the keys that may hold it (its own nested one, then the hoisted one). */
export interface LockedTree {
  readonly versions: ReadonlyMap<string, string>;
  readonly workspaces: ReadonlyMap<string, string>;
  readonly declared: readonly { readonly by: string; readonly keys: readonly string[] }[];
}

/** Whether a lock row's `os` or `cpu` admits `value`: absent admits all, `none` admits nothing, `!x` excludes. */
function admits(listed: readonly string[] | undefined, value: string): boolean {
  if (listed === undefined) return true;
  const excluded = listed.filter((entry) => entry.startsWith('!')).map((entry) => entry.slice(1));
  const included = listed.filter((entry) => !entry.startsWith('!'));

  if (excluded.includes(value)) return false;

  return included.length === 0 || included.includes(value);
}

/** The lock, read as the tree it installs on `platform`. */
export function lockedTree(lockText: string, platform: { readonly os: string; readonly cpu: string }): LockedTree {
  const lock = parseJsonc(lockText, LockSchema, 'bun.lock');
  const versions = new Map<string, string>();

  for (const [key, row] of Object.entries(lock.packages)) {
    const spec = v.parse(v.string(), row[0]);
    const version = spec.slice(spec.lastIndexOf('@') + 1);

    // A workspace link is the workspace itself, which has no version to hold.
    if (version.startsWith('workspace:')) continue;
    const meta = v.safeParse(LockMeta, row[2]);

    if (meta.success && !(admits(meta.output.os, platform.os) && admits(meta.output.cpu, platform.cpu))) continue;
    versions.set(key, version);
  }

  const workspaces = new Map(Object.entries(lock.workspaces)
    .flatMap(([path, entry]) => (path === '' || entry.name === undefined ? [] : [[path, entry.name] as const])));

  // A declared package bun must install; one the lock leaves out on this platform is not declared here.
  const declared = Object.entries(lock.workspaces).flatMap(([path, entry]) => {
    const by = entry.name ?? (path === '' ? 'the root' : path);

    return Object.keys({ ...entry.dependencies, ...entry.devDependencies })
      .map((dep) => ({ by, keys: [...(path === '' || entry.name === undefined ? [] : [`${entry.name}/${dep}`]), dep] }))
      .filter((wanted) => wanted.keys.some((key) => versions.has(key) || [...workspaces.values()].includes(key)));
  });

  return { versions, workspaces, declared };
}

/** One package directory found under a `node_modules`: its install key, where it is, and the version it holds. */
export interface InstalledPackage {
  readonly key: string;
  readonly path: string;
  /** The directory it resolves to; undefined for a dangling link. */
  readonly real: string | undefined;
  /** Undefined when the entry holds no readable `package.json`: a dangling link or a leftover directory. */
  readonly version: string | undefined;
}

/** Every package under `modules` and the `node_modules` nested in each, keyed from `prefix`. Dot entries (`.bin`,
 *  `.cache`, `.vite`) are the tools' own and hold no package. A workspace is walked from its own path, so its link
 *  is passed over, and only a link that IS one: a key naming the workspace whose directory it reaches (`workspaces`,
 *  by real directory). Any other link is a package, whatever it reaches. Each install location is its own key even
 *  where two share a directory: bun links a nested copy to an identical one elsewhere (`rolldown-plugin-dts/typescript`
 *  is `@mossaic/sdk`'s). `ancestors` stops a link cycle. */
function packagesUnder(
  modules: string, prefix: string, workspaces: ReadonlyMap<string, string>, ancestors: ReadonlySet<string>,
): InstalledPackage[] {
  if (!existsSync(modules)) return [];
  const found: InstalledPackage[] = [];

  const entries = readdirSync(modules).filter((name) => !name.startsWith('.')).flatMap((name) => {
    if (!name.startsWith('@')) return [name];
    // A scope linked to a donor checkout that has since removed it lists nothing: it is an entry of its own, which
    // the report names and `setup-worktree.sh` prunes.
    const scoped = tolerate(() => readdirSync(join(modules, name)), 'enoent');

    return scoped === undefined ? [name] : scoped.map((inner) => `${name}/${inner}`);
  });

  for (const name of entries) {
    const path = join(modules, name);
    const real = tolerate(() => realpathSync(path), 'enoent');

    if (real !== undefined && workspaces.get(real) === `${prefix}${name}`) continue;

    if (real === undefined || !statSync(real).isDirectory()) {
      found.push({ key: `${prefix}${name}`, path, real, version: undefined });
      continue;
    }

    if (ancestors.has(real)) continue;
    const manifest = tolerate(() => readFileSync(join(real, 'package.json'), 'utf8'), 'enoent');

    found.push({
      key: `${prefix}${name}`,
      path,
      real,
      version: manifest === undefined ? undefined : v.parse(PackageVersion, JSON.parse(manifest)).version,
    });
    found.push(...packagesUnder(join(real, 'node_modules'), `${prefix}${name}/`, workspaces, new Set([...ancestors, real])));
  }

  return found;
}

/** Every package installed in the checkout at `root`: its root `node_modules` and each workspace's. */
export function installedTree(root: string, workspaces: ReadonlyMap<string, string>): InstalledPackage[] {
  const linked = new Map([...workspaces].flatMap(([path, name]) => {
    const real = tolerate(() => realpathSync(join(root, path)), 'enoent');

    return real === undefined ? [] : [[real, name] as const];
  }));

  return [
    ...packagesUnder(join(root, 'node_modules'), '', linked, new Set()),
    ...[...workspaces].flatMap(([path, name]) => packagesUnder(join(root, path, 'node_modules'), `${name}/`, linked, new Set())),
  ];
}

/** The install key a key is nested in: `a/@s/b` is in `a`, and a top-level key is in `''`. */
export function parentKey(key: string): string {
  const words = key.split('/');
  const last = words.at(-2)?.startsWith('@') === true ? 2 : 1;

  return words.slice(0, -last).join('/');
}

/** Where the installed tree and the lock part: each difference, as one line naming the path and both versions. */
export function drift(locked: LockedTree, installed: readonly InstalledPackage[]): string[] {
  const lines: string[] = [];
  const present = new Set([...installed.map((entry) => entry.key), ...locked.workspaces.values()]);
  const unlocked = new Set(installed.filter((entry) => !locked.versions.has(entry.key)).map((entry) => entry.key));
  const compiler = installed.find((entry) => entry.key === PINNED_COMPILER_LINK.target)?.real;

  for (const entry of installed) {
    const wanted = locked.versions.get(entry.key);

    // The one entry an install adds on purpose (`scripts/mossaic-sdk.ts`), while it reaches the SDK's compiler.
    if (entry.key === PINNED_COMPILER_LINK.key && entry.real !== undefined && entry.real === compiler) continue;

    // A package nested in one the lock does not install goes with it, so the line names the top of the subtree.
    if (wanted === undefined && unlocked.has(parentKey(entry.key))) continue;

    if (wanted === undefined) {
      lines.push(`${entry.path} holds ${entry.version ?? 'no readable package'} where bun.lock installs nothing`);
    } else if (entry.version !== wanted) {
      lines.push(`${entry.path} holds ${entry.version ?? 'no readable package'} where bun.lock names ${wanted}`);
    }
  }

  // bun never removes what is installed; a package added to the lock since the last install is simply absent.
  for (const { by, keys } of locked.declared) {
    if (!keys.some((key) => present.has(key))) lines.push(`${keys.at(-1) ?? ''} is missing: ${by} declares it and bun.lock installs it`);
  }

  for (const [key, wanted] of locked.versions) {
    const parent = parentKey(key);

    if (parent !== '' && present.has(parent) && !present.has(key)) {
      lines.push(`${key}@${wanted} is missing: bun.lock places it under ${parent}, which resolves another copy without it`);
    }
  }

  return lines;
}

/** The drift of the checkout at `root` from its own `bun.lock`, on this machine. */
export function installDrift(root: string): string[] {
  const locked = lockedTree(readFileSync(join(root, 'bun.lock'), 'utf8'), { os: process.platform, cpu: process.arch });

  return drift(locked, installedTree(root, locked.workspaces));
}

/** The refusal a drifted tree gets, from the ladder and from this program alike. */
export function driftFinding(lines: readonly string[]): string {
  return finding({
    at: 'node_modules',
    invariant: 'the installed tree is the one bun.lock names: every gate runs on it, and the ladder\'s cache stands '
      + 'bun.lock in for it',
    found: `${String(lines.length)} difference(s):\n      ${lines.join('\n      ')}`,
    silently: 'a gate passes, a verdict is cached and a deploy ships on packages the lock does not name; a stale '
      + 'package nested in a workspace shadows the one the lock placed above it',
    fix: 'in a checkout with its own install, remove every node_modules tree and run `bun install --frozen-lockfile` '
      + '(bun does not prune what the lock no longer names); in a linked worktree, `bash scripts/setup-worktree.sh` '
      + 'once the checkout it links is right',
  });
}

function main(): number {
  const root = new URL('..', import.meta.url).pathname;
  const lines = installDrift(root);

  if (lines.length === 0) {
    console.log('install-parity: ok — every installed package is the version bun.lock names at the path it names');

    return 0;
  }

  console.error(driftFinding(lines));

  return 1;
}

if (import.meta.main) process.exit(main());

/**
 * The ladder's content-addressed cache: a green gate is skipped only on a
 * proof that nothing it can read has changed.
 *
 * The proof is a sha256 over the gate's input closure (`ladder-closure.ts`):
 * the command, the checkout it runs in, every closure file's working-tree
 * bytes, the value of every environment name the gate is given, and the
 * toolchain (bun, node, typescript, oxlint, wrangler, vitest, the platform).
 * A recorded entry lives outside the tree at `~/.cache/kinu-ladder/<sha256>`
 * and names the gate, the revision it was proved on, its wall seconds, the
 * closure size and the tool versions. Nothing expires by time: an entry is
 * either the hash of the tree you have or it is not consulted.
 *
 * The environment is an input the runner CONTROLS rather than one it
 * trusts: a derived gate runs with exactly the names its key hashes
 * ({@link gateEnvironment}), so a name the walker never saw, however the gate
 * reads it, reads as unset on every run and cannot make two runs under one
 * key differ.
 *
 * What never records: a red result; a gate whose closure is uncomputable or
 * live; a gate whose closure hashed differently after the run than before it
 * (an edit landed mid-run, so the verdict is about a tree nobody can name).
 *
 * The store is a plain directory of JSON files so a hit is inspectable by
 * hand and a wrong entry is deletable by hand. The key is never a per-gate
 * allowlist and never a timestamp: `ladder-cache.test.ts` proves each of
 * those directions red.
 */

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import * as v from 'valibot';
import { CHILD_ENV_NAMES } from '../packages/test-utils/src/ambient-env';
import { deriveClosure } from './ladder-closure';
import type { Closure, Derived, Inputs, Repo } from './ladder-closure';

const ToolVersionsSchema = v.object({
  bun: v.string(),
  node: v.string(),
  typescript: v.string(),
  oxlint: v.string(),
  wrangler: v.string(),
  vitest: v.string(),
  platform: v.string(),
});

export type ToolVersions = v.InferOutput<typeof ToolVersionsSchema>;

const PackageVersion = v.object({ version: v.string() });

/** The toolchain a gate's verdict stands on. Package versions are read from
 *  the installed manifests under `root` rather than spawned, so the key costs
 *  no process; the runtimes are the ones running this program. A package that
 *  is not installed is recorded as `absent`, which is a version too. */
export function toolVersions(root: string): ToolVersions {
  const installed = (name: string): string => {
    const manifest = join(root, 'node_modules', name, 'package.json');

    if (!existsSync(manifest)) return 'absent';

    return v.parse(PackageVersion, JSON.parse(readFileSync(manifest, 'utf8'))).version;
  };

  return {
    bun: Bun.version,
    node: process.versions.node,
    typescript: installed('typescript'),
    oxlint: installed('oxlint'),
    wrangler: installed('wrangler'),
    vitest: installed('vitest'),
    platform: `${process.platform}-${process.arch}`,
  };
}

/** One recorded green run. */
const EntrySchema = v.object({
  run: v.string(),
  revision: v.string(),
  seconds: v.number(),
  recordedAt: v.string(),
  closureSize: v.number(),
  tools: ToolVersionsSchema,
});

export type Entry = v.InferOutput<typeof EntrySchema>;

export interface Store {
  readonly directory: string;
  lookup(key: string): Entry | undefined;
  record(key: string, entry: Entry): void;
}

/** The default store location: `$XDG_CACHE_HOME/kinu-ladder` or
 *  `~/.cache/kinu-ladder`. Outside the tree, so no gate can read it as corpus
 *  and no checkout carries another's proofs. */
export function defaultStoreDirectory(base = process.env.XDG_CACHE_HOME): string {

  return join(base === undefined || base.length === 0 ? join(homedir(), '.cache') : base, 'kinu-ladder');
}

export function storeAt(directory: string): Store {
  return {
    directory,
    lookup(key) {
      const path = join(directory, key);

      if (!existsSync(path)) return undefined;

      return v.parse(EntrySchema, JSON.parse(readFileSync(path, 'utf8')));
    },
    record(key, entry) {
      mkdirSync(directory, { recursive: true });
      // Written whole then renamed: a concurrent reader sees a complete
      // entry or none, never a truncated one.
      const temporary = join(directory, `.${key}.${String(process.pid)}`);
      writeFileSync(temporary, `${JSON.stringify(entry, null, 2)}\n`);
      renameSync(temporary, join(directory, key));
    },
  };
}

/** A reader for one environment name. The key takes a READER rather than the
 *  environment, for the reason every resolver in `packages/test-utils` does:
 *  the closure walker can bound a read by name and cannot bound an object
 *  handed over whole, and this module is in the closure of every gate that
 *  imports the ladder. */
export type EnvReader = (name: string) => string | undefined;

export const ambientEnv: EnvReader = (name) => process.env[name];

/** The names every derived gate is given beside its closure's own: what any
 *  process needs from its surroundings (`CHILD_ENV_NAMES`: the path, home,
 *  temp, user, shell, locale, zone and terminal), and `CI`, which bun test
 *  and vitest read to decide whether a missing snapshot fails the run. */
export const GATE_BASE_ENV: readonly string[] = [...CHILD_ENV_NAMES, 'CI'];

/** Every environment name a derived gate is given and keyed on, sorted. */
export function gateEnvNames(closure: Derived): readonly string[] {
  return [...new Set([...GATE_BASE_ENV, ...closure.env])].sort();
}

/** The whole environment a derived gate runs under: {@link gateEnvNames}
 *  with their current values, an unset name left out. Nothing else reaches
 *  the gate, so every value it can see is a key input. */
export function gateEnvironment(closure: Derived, env: EnvReader = ambientEnv) {
  return Object.fromEntries(gateEnvNames(closure).flatMap((name) => {
    const value = env(name);

    return value === undefined ? [] : [[name, value] as const];
  }));
}

/** Everything one key is taken over. */
export interface KeyPreimage {
  readonly run: string;
  readonly closure: Derived;
  readonly tools: ToolVersions;
  readonly repo: Repo;
  readonly env?: EnvReader;
}

/** The key: sha256 over the run, the checkout's root, the closure's bytes,
 *  the environment the gate is given and the toolchain. The root is a key
 *  input because the gate runs in it: an absolute path lands in socket
 *  names, temp paths and messages, and a checkout's untracked state is not
 *  another checkout's, so a proof recorded in one checkout is never another's.
 *  Environment VALUES enter the preimage only, so a secret named on a row
 *  never lands in the store. */
export function keyFor(preimage: KeyPreimage): string {
  const { run, closure, tools, repo, env = ambientEnv } = preimage;
  const hash = createHash('sha256');
  hash.update(`run\0${run}\0`);
  hash.update(`root\0${repo.root}\0`);
  hash.update(`tools\0${JSON.stringify(tools)}\0`);

  for (const file of closure.files) {
    hash.update(`file\0${file}\0`);
    hash.update(repo.read(file));
    hash.update('\0');
  }

  for (const name of gateEnvNames(closure)) hash.update(`env\0${name}\0${env(name) ?? '\u0001unset'}\0`);

  return hash.digest('hex');
}

/** A gate's cache decision before it runs. */
export type Plan =
  | { readonly kind: 'hit'; readonly key: string; readonly entry: Entry; readonly closure: Derived }
  | { readonly kind: 'miss'; readonly key: string; readonly closure: Derived }
  | { readonly kind: 'uncacheable'; readonly closure: Exclude<Closure, Derived> };

/** One gate row against one tree: the command, the inputs its row declares,
 *  the tree those inputs resolve against, the toolchain its verdict stands on,
 *  and the store holding the proofs. */
export interface GateCacheRequest {
  readonly run: string;
  readonly inputs: Inputs;
  readonly repo: Repo;
  readonly tools: ToolVersions;
  readonly store: Store;
}

export function planGate(gate: GateCacheRequest): Plan {
  const closure = deriveClosure(gate.run, gate.inputs, gate.repo);

  if (closure.kind !== 'derived') return { kind: 'uncacheable', closure };
  const key = keyFor({ run: gate.run, closure, tools: gate.tools, repo: gate.repo });
  const entry = gate.store.lookup(key);

  if (entry === undefined) return { kind: 'miss', key, closure };

  return { kind: 'hit', key, entry, closure };
}

/** Record a green run. The closure is re-derived and re-hashed AFTER the run:
 *  an edit that landed while the gate ran changes the key, and the verdict is
 *  then about a tree nobody can name, so nothing is recorded and the reason is
 *  returned. */
export function recordGreen(
  plan: Extract<Plan, { kind: 'miss' }>,
  gate: GateCacheRequest,
  result: { readonly seconds: number; readonly revision: string },
): string | undefined {
  const after = deriveClosure(gate.run, gate.inputs, gate.repo);

  if (after.kind !== 'derived') return `closure became ${after.kind} during the run`;
  const key = keyFor({ run: gate.run, closure: after, tools: gate.tools, repo: gate.repo });

  if (key !== plan.key) return 'the closure changed while the gate ran; its verdict names no tree';

  gate.store.record(key, {
    run: gate.run,
    revision: result.revision,
    seconds: Math.round(result.seconds * 100) / 100,
    recordedAt: new Date().toISOString(),
    closureSize: after.files.length,
    tools: gate.tools,
  });

  return undefined;
}

/** What the cache cannot see, printed on the green path of every cached tier. */
export const CACHE_BLIND_SPOTS: readonly string[] = [
  'node_modules — TRUSTED TO MATCH bun.lock AND patches/. The key hashes the lock and the '
  + 'patches, never the installed tree; `bun run gate:patch-parity` is the gate for that equality.',
  'A READ BY PATH — DECLARED, NOT SEEN. A file in a graph that opens the tree by path is '
  + 'cacheable only with a `reads` list on its row, and the list is a claim; `--audit-closure` '
  + 'runs the gate under strace and names every tree file opened outside the closure.',
  'THE ENVIRONMENT IS CLOSED, NOT SEEN. A derived gate runs with the base names, the names its '
  + 'graph reads literally and the names its row declares, and with nothing else, so a read '
  + 'the walker missed sees an unset name on every run rather than a value the key never held. '
  + 'A gate that needs another name fails for want of it; the fix is the name on its row.',
  'OUTSIDE THE TREE — NOT AN INPUT. $HOME state, /etc, the binaries PATH finds (git, python, '
  + 'the browser puppeteer downloaded), the clock and the network are not hashed; a gate that '
  + 'reads them is declared `live` and never cached, and a gate that reads them without saying '
  + 'so is a hole this cache cannot close.',
  'THE VERDICT IS HASHED BEFORE AND AFTER THE RUN, NOT DURING IT. A file edited and restored '
  + 'inside the run\'s window hashes identical at both ends and the run is recorded.',
];

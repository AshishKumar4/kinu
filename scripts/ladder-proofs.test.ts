/**
 * Proofs carried across containers are sound: a fresh container takes a proof only for the closure it was recorded
 * under, only with its HMAC intact, and an unreachable bucket is a run. Each direction asserts the miss as well as the
 * hit, over a throwaway repository and an in-memory bucket.
 */
import { describe, expect, test } from 'bun:test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { git, initRepo, scratchDir } from '@kinu.run/test-utils';
import { claims } from './ladder';
import { planGate, recordGreen, storeAt, toolVersions, type Plan, type Store } from './ladder-cache';
import type { Inputs } from './ladder-closure';
import { repoAt } from './ladder-closure';
import { fromEnvironment, PROOF_SECRET_NAMES, remoteProofs, type ProofBucket } from './ladder-proofs';

const DERIVED: Inputs = { kind: 'derived', reads: [], env: [] };

const RUN = 'bun scripts/green.ts';

const SECRET = 'the bucket secret';

/** The bucket as a map, which `failing` makes refuse every read. */
function memoryBucket(): ProofBucket & { readonly objects: Map<string, string>; failing: boolean } {
  const objects = new Map<string, string>();

  return {
    objects,
    failing: false,
    async read(key) {
      if (this.failing) throw new Error('the bucket did not answer');

      return objects.get(key) ?? null;
    },
    async write(key, text) {
      objects.set(key, text);
    },
  };
}

/** A committed repository whose one gate reads `scripts/green.ts`. */
function repository(): string {
  const root = scratchDir('ladder-proofs');

  initRepo(root);

  for (const [file, text] of Object.entries({
    'package.json': JSON.stringify({ name: 'fixture' }),
    'bun.lock': '{}',
    'scripts/green.ts': 'export const green = 1;\n',
    '.gitignore': 'node_modules/\n',
  })) {
    mkdirSync(join(root, dirname(file)), { recursive: true });
    writeFileSync(join(root, file), text);
  }

  git(root, 'add', '-A');
  git(root, 'commit', '-qm', 'fixture');

  return root;
}

/** A container as the ladder sees it: its own store, and the plan its gate gets there. */
interface Container {
  readonly store: Store;
  plan(): Plan;
}

/** A container: its own empty store over the repository. */
function container(root: string): Container {
  const store = storeAt(join(scratchDir('ladder-proofs-store'), 'kinu-ladder'));
  const tools = toolVersions(root, 'v24.0.0');

  return { store, plan: () => planGate({ run: RUN, inputs: DERIVED, repo: repoAt(root, (run, files) => claims(run, files)), tools, store }) };
}

/** Records a green run of the gate in `box`, as the ladder does after it exits 0, and uploads it. */
async function provedIn(root: string, box: Container, bucket: ProofBucket, revision: string): Promise<string> {
  const plan = box.plan();

  if (plan.kind !== 'miss') throw new Error(`expected a miss to record, found ${plan.kind}`);
  const tools = toolVersions(root, 'v24.0.0');
  const refused = recordGreen(plan, { run: RUN, inputs: DERIVED, repo: repoAt(root, (run, files) => claims(run, files)), tools, store: box.store }, { seconds: 2, revision });

  if (refused !== undefined) throw new Error(`the green run was not recorded: ${refused}`);
  expect(await remoteProofs(bucket, SECRET).push([plan.key], box.store)).toEqual([]);

  return plan.key;
}

describe('a proof carried to a fresh container', () => {
  test('an unchanged closure carries the proof, and a changed one runs', async () => {
    const root = repository();
    const bucket = memoryBucket();
    const key = await provedIn(root, container(root), bucket, 'rev-a');

    const second = container(root);
    const before = second.plan();

    expect(before.kind).toBe('miss');
    expect(await remoteProofs(bucket, SECRET).pull(key, second.store)).toEqual({ kind: 'pulled' });
    const after = second.plan();

    expect(after.kind === 'hit' ? after.entry.revision : after.kind).toBe('rev-a');

    // One byte of the gate's closure changes: a new key, which the bucket holds no proof for.
    writeFileSync(join(root, 'scripts/green.ts'), 'export const green = 2;\n');
    git(root, 'commit', '-qam', 'change the gate');
    const third = container(root);
    const changed = third.plan();

    expect(changed.kind).toBe('miss');
    expect(changed.kind === 'miss' ? changed.key : key).not.toBe(key);
    expect(await remoteProofs(bucket, SECRET).pull(changed.kind === 'miss' ? changed.key : key, third.store)).toEqual({ kind: 'absent' });
    expect(third.plan().kind).toBe('miss');
  });

  test('an entry edited in the bucket, or moved to another key, or signed with another secret, is not a proof', async () => {
    const root = repository();
    const bucket = memoryBucket();
    const key = await provedIn(root, container(root), bucket, 'rev-a');
    const stored = bucket.objects.get(key) ?? '';

    bucket.objects.set(key, stored.replace('"rev-a"', '"rev-b"'));
    expect(await remoteProofs(bucket, SECRET).pull(key, container(root).store)).toEqual({ kind: 'unverified' });

    bucket.objects.set(key, stored);
    bucket.objects.set('f'.repeat(64), stored);
    expect(await remoteProofs(bucket, SECRET).pull('f'.repeat(64), container(root).store)).toEqual({ kind: 'unverified' });
    expect(await remoteProofs(bucket, 'another secret').pull(key, container(root).store)).toEqual({ kind: 'unverified' });

    bucket.objects.set(key, 'not json');
    const box = container(root);

    expect(await remoteProofs(bucket, SECRET).pull(key, box.store)).toEqual({ kind: 'unverified' });
    expect(box.plan().kind).toBe('miss');
  });

  test('a bucket that does not answer is a run, never a pass', async () => {
    const root = repository();
    const bucket = memoryBucket();
    const key = await provedIn(root, container(root), bucket, 'rev-a');
    const box = container(root);

    bucket.failing = true;
    expect(await remoteProofs(bucket, SECRET).pull(key, box.store)).toEqual({ kind: 'unreachable', why: 'the bucket did not answer' });
    expect(box.plan().kind).toBe('miss');
  });

  test('a red run records nothing, so nothing is uploaded', async () => {
    const root = repository();
    const bucket = memoryBucket();
    const box = container(root);
    const plan = box.plan();

    if (plan.kind !== 'miss') throw new Error(`expected a miss, found ${plan.kind}`);
    // The ladder records only a green run; a red one leaves the store without the key.
    expect(await remoteProofs(bucket, SECRET).push([plan.key], box.store)).toEqual([]);
    expect(bucket.objects.size).toBe(0);
  });
});

describe('the bucket credentials', () => {
  test('are deleted from the environment before any gate can inherit them, whether or not both are set', () => {
    const full: NodeJS.ProcessEnv = { R2_ACCESS_KEY_ID: 'id', R2_SECRET_ACCESS_KEY: 'secret', PATH: '/bin' };
    const half: NodeJS.ProcessEnv = { R2_ACCESS_KEY_ID: 'id', PATH: '/bin' };

    expect(fromEnvironment(full)).toBeDefined();
    expect(fromEnvironment(half)).toBeUndefined();
    expect([full, half].map((env) => PROOF_SECRET_NAMES.filter((name) => name in env))).toEqual([[], []]);
    expect(full['PATH']).toBe('/bin');
  });
});

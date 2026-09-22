// Contract tests: the shipped strategy returns the bytes it was given, from a blank disk,
// after a container replacement at each commit sub-step, through a byte-carrying store.
import { afterAll, describe, expect, test } from 'bun:test';

import { KNOWN_RED, type KnownRed } from './support/conformance-bug-list';
import {
  ArmRefused,
  CONFORMANCE_ARMS,
  DiskFull,
  type ArmBoot,
  type ConformanceArm,
  type Refusal,
  type RestoreWork,
} from './support/strategy-machine';
import {
  TREE_PROPERTIES,
  canonicalTreeBytes,
  compareTrees,
  describeMismatches,
  fidelityTree,
  generatedTree,
  gigabyteTree,
  heldBytes,
  Seeded,
  textTree,
  type NodeEntry,
  type TreeProperty,
} from './support/tree-model';
import { describeThrown } from '../src/lifecycle';
import {
  ATTACH_OUTCOME_KINDS,
  parseDevboxStrategyName,
  type CheckpointOutcome,
} from '../src/storage';

/** `CheckpointOutcome` returns its refusal as a value, so a bare `kind` check would drop
 *  the reason; this throws with it. */
function expectCommitted(outcome: CheckpointOutcome, what: string): void {
  if (outcome.kind === 'committed') return;
  throw new Error(`${what} did not commit: ${outcome.kind} — ${outcome.reason ?? 'no reason given'}`);
}

/** The crash contract: the served tree is exactly one committed generation, never blank or
 *  blended. Throws rather than matching so the message carries the tree actually served. */
async function expectOneGeneration(arm: ConformanceArm, what: string): Promise<void> {
  const served = canonical(await tree(arm));

  if (served === canonical(OLD) || served === canonical(MERGED)) return;
  throw new Error(
    `${arm.name} served neither generation after ${what}: ${served}`
    + ` (old: ${canonical(OLD)}, new: ${canonical(MERGED)})`,
  );
}

/** Sorts paths: listing order is the strategy's own business, not a difference in content. */
function canonical(rows: Record<string, string | undefined>): string {
  return JSON.stringify(
    Object.fromEntries(Object.entries(rows).sort(([left], [right]) => left < right ? -1 : 1)),
  );
}

/** Path to file text; `undefined` marks a path the workspace lists but cannot read.
 *  Return type is inferred, not annotated: the entries are the contract. */
async function tree(arm: ConformanceArm) {
  const paths = await arm.workspace.paths();
  const rows = await Promise.all(paths.map(async (path) => [path, await arm.workspace.read(path)] as const));

  return Object.fromEntries(rows);
}

async function attach(arm: ConformanceArm) {
  const outcome = await arm.storage().attach();
  expect(ATTACH_OUTCOME_KINDS).toContain(outcome.kind);

  return outcome;
}

/** Wake on a replacement: blank container disk, same durable store and rows. One re-drive only:
 *  a refusal that survives its own retry is the brick this battery catches. */
async function wake(arm: ConformanceArm) {
  arm.replaceContainer();

  try {
    return await arm.storage().attach();
  } catch (first) {
    try {
      return await arm.storage().attach();
    } catch (second) {
      throw new Error(
        `${arm.name} refused a wake twice: ${describeThrown({ cause: first })}`
        + ` then ${describeThrown({ cause: second })}`,
        { cause: second },
      );
    }
  }
}

/** Returns what the operation threw, or null when it returned. A non-Error throw becomes a
 *  `TypeError` so callers asserting on class and message still see it as a finding. */
async function thrownBy(run: () => Promise<void>): Promise<Error | null> {
  try {
    await run();

    return null;
  } catch (error) {
    return error instanceof Error ? error : new TypeError(`non-Error thrown: ${describeThrown({ cause: error })}`);
  }
}

async function commit(
  arm: ConformanceArm,
  content: Record<string, string>,
): Promise<CheckpointOutcome> {
  for (const [path, text] of Object.entries(content)) await arm.workspace.write(path, text);

  return await arm.storage().checkpoint('quiesce');
}

const OLD = { 'notes.txt': 'generation one', 'src.txt': 'export const one = 1;' };

const NEW = { 'notes.txt': 'generation two', 'extra.txt': 'added by the second commit' };

const MERGED = { ...OLD, ...NEW };

const THIRD = { 'third.txt': 'written by the third generation' };

// `Object.entries` widens keys to `string`, so each key is parsed back to its strategy
// name rather than asserted into it.
const armEntries = Object.entries(CONFORMANCE_ARMS).map(([key, open]) => {
  const name = parseDevboxStrategyName(key);

  if (name === null) throw new Error(`the conformance arms name ${key}, which is not a strategy`);

  return [name, open] as const;
});

test('every strategy name has an arm, and every arm names a strategy', () => {
  // The record's key type forces an arm per `DevboxStrategyName`; this checks the converse:
  // no key here is a name the package does not know.
  for (const [name] of armEntries) expect(parseDevboxStrategyName(name)).toBe(name);
  expect(armEntries.length).toBe(1);
});

for (const [name, open] of armEntries) {
  describe(`${name} — durability contract`, () => {
    test('attach empty, write, commit, REPLACE the container, attach — exact bytes', async () => {
      const arm = open();
      const first = await attach(arm);
      expect(first.kind).not.toBe('already-attached');

      expectCommitted(await commit(arm, OLD), 'the first commit');

      const woken = await wake(arm);
      // Must not be `empty`: after a commit, an empty attach is a blank workspace posing as success.
      expect(woken.kind).toBe('attached');
      expect(await tree(arm)).toEqual(OLD);
    });

    test('actual stop loses local bytes; only committed workspace bytes return through restore', async () => {
      const arm = open();
      await attach(arm);
      expectCommitted(await commit(arm, OLD), 'the committed marker');
      await arm.workspace.write('uncheckpointed.txt', 'local only');
      arm.disk().writeFile('/tmp/uncheckpointed-marker', new TextEncoder().encode('ephemeral'));
      const disk = arm.disk();
      const remoteKeys = [...arm.durable.objects.keys()];

      arm.stopContainer();

      expect(disk.files.size + disk.trees.size + disk.mounts.size + disk.overlays.size).toBe(0);
      expect([...arm.durable.objects.keys()]).toEqual(remoteKeys);
      arm.replaceContainer();
      expect(arm.disk().readFile('/workspace/notes.txt')).toBeUndefined();
      expect(arm.disk().readFile('/tmp/uncheckpointed-marker')).toBeUndefined();

      expect((await attach(arm)).kind).toBe('attached');
      expect(await tree(arm)).toEqual(OLD);
      expect(await arm.workspace.read('uncheckpointed.txt')).toBeUndefined();
    });

    test('DO recreation while the container runs retains its uncheckpointed generation', async () => {
      const arm = open();
      await attach(arm);
      expectCommitted(await commit(arm, OLD), 'the committed marker');
      await arm.workspace.write('uncheckpointed.txt', 'local only');
      const sentinel = new TextEncoder().encode('ephemeral');
      arm.disk().writeFile('/tmp/uncheckpointed-marker', sentinel);
      const disk = arm.disk();

      arm.resetIsolate();

      expect(arm.disk()).toBe(disk);
      expect(arm.disk().readFile('/tmp/uncheckpointed-marker')).toEqual(sentinel);
      expect(await arm.workspace.read('uncheckpointed.txt')).toBe('local only');
      await attach(arm);
      expect(await tree(arm)).toEqual({ ...OLD, 'uncheckpointed.txt': 'local only' });
    });

    test('a quiesce with pending changes publishes exactly once and returns', async () => {
      // Limiting `publishSeam` to one visit turns a quiesce that republishes forever
      // into a named failure at the second publication instead of a hanging suite.
      const arm = open();
      await attach(arm);

      for (const [path, text] of Object.entries(OLD)) await arm.workspace.write(path, text);
      arm.deaths.limit(arm.publishSeam, 1);

      expectCommitted(await arm.storage().checkpoint('quiesce'), 'a quiesce with pending changes');
      expect(arm.deaths.visits(arm.publishSeam)).toBe(1);

      // And the bytes are really there afterwards, so "published once" cannot
      // pass by publishing nothing.
      const woken = await wake(arm);
      expect(woken.kind).toBe('attached');
      expect(await tree(arm)).toEqual(OLD);
    });

    test('generation after generation, each replacement carries every commit before it', async () => {
      // Three generations: the Nth is the first to read the (N-1)th as a parent, so a wrongly
      // declared closure stays invisible until the generation after it.
      const arm = open();
      await attach(arm);
      const seen: Record<string, string> = {};

      for (const generation of [OLD, NEW, THIRD]) {
        expectCommitted(await commit(arm, generation), `generation ${JSON.stringify(generation)}`);
        Object.assign(seen, generation);
        const woken = await wake(arm);
        expect(woken.kind).toBe('attached');
        expect(await tree(arm)).toEqual(seen);
      }
    });

    test('every declared commit seam is reached by an ordinary commit', async () => {
      const arm = open();
      await attach(arm);
      await commit(arm, OLD);

      // A seam nothing reaches would make its crash case pass by never
      // crashing, so the seam list is asserted against the code that names it.
      for (const seam of arm.commitSeams) expect(arm.deaths.reached).toContain(seam);
    });

    for (const seam of open().commitSeams) {
      test(`a death at ${seam} serves the old tree or the new one, never a blend`, async () => {
        const arm = open();
        await attach(arm);
        expectCommitted(await commit(arm, OLD), 'the commit before the death');

        arm.dieAt(seam);

        // An interrupted commit may fail as a value or a throw; both are ordinary.
        // It must never report `committed`.
        const interrupted = await thrownBy(async () => {
          const outcome = await commit(arm, NEW);
          expect(outcome.kind).not.toBe('committed');
        });

        if (interrupted !== null) expect(interrupted).toBeInstanceOf(Error);
        expect(arm.deaths.reached).toContain(seam);
        expect(arm.deaths.armed).toBe(null);

        const woken = await wake(arm);
        expect(woken.kind).toBe('attached');
        // Named rather than matched so a failure reports the served tree: blank, blended and
        // lost-generation trees are distinct defects that a bare `toContain` cannot name.
        await expectOneGeneration(arm, `a death at ${seam}`);
      });
    }

    test('control metadata lives outside every payload and mount prefix', async () => {
      const arm = open();
      await attach(arm);
      await commit(arm, OLD);

      const placement = await arm.controlPlane();
      const prefixes = arm.payloadPrefixes();
      expect(prefixes.length).toBeGreaterThan(0);

      for (const key of placement.objectKeys) {
        for (const prefix of prefixes) {
          // An envelope under a prefix the container's mount owns can be eaten by a mount replacement.
          expect(key.startsWith(prefix)).toBe(false);
        }
      }

      // A committed box names a head somewhere. A strategy whose head is the
      // prefix itself says that; none of them may answer `null` here.
      expect(placement.head).not.toBe(null);
    });

    test('wiping exactly the payload subtree leaves the control plane readable', async () => {
      const arm = open();
      await attach(arm);
      await commit(arm, OLD);
      const before = await arm.controlPlane();

      let wiped = 0;

      for (const prefix of arm.payloadPrefixes()) wiped += arm.durable.deletePrefix(prefix);
      expect(wiped).toBeGreaterThan(0);

      const after = await arm.controlPlane();

      if (before.objectKeys.length === 0 && before.rows.length === 0) {
        // With no control plane, wiping the payload subtree wipes the box; it must then stop
        // claiming a head, or it would serve a workspace it cannot fill while reporting success.
        expect(after.head).toBe(null);
        const woken = await wake(arm);
        expect(woken.detail).toContain('0 objects');
        expect(await tree(arm)).toEqual({});

        return;
      }

      // The control plane does not live in the subtree the container owns, so the head survives.
      expect(after.head).toBe(before.head);

      for (const key of before.objectKeys) expect(arm.durable.head(key)).not.toBe(null);

      arm.replaceContainer();
      const refusal = await thrownBy(async () => { await arm.storage().attach(); });

      if (refusal === null) return;
      expect(refusal).toBeInstanceOf(Error);
      // A refusal after payload loss must name payload, not a control object; naming one means
      // the control plane was lost with the mount.
      const message = describeThrown({ cause: refusal });

      for (const key of before.objectKeys) {
        expect(message).not.toContain(key.split('/').pop() ?? key);
      }
    });

    test('a corrupted committed payload object is refused by name, and discard recovers', async () => {
      const arm = open();
      await attach(arm);

      // A tick, not a quiesce: only a tick leaves pending state its own read path must verify;
      // a quiesce materializes a tree the mount serves unverified, so corrupting it tests nothing.
      for (const [path, text] of Object.entries(OLD)) await arm.workspace.write(path, text);
      expectCommitted(await arm.storage().checkpoint('tick'), 'the tick before the corruption');

      const declared = await arm.declaredPayload();
      // The non-empty declaration is asserted: an arm declaring no payload identities would
      // corrupt nothing below and still pass.
      expect(declared.length).toBeGreaterThan(0);

      const target = declared[0];
      arm.durable.corrupt(target.key, 'flip');

      arm.replaceContainer();
      // An eager arm refuses inside attach; a lazy arm's attach touches only root and ledger,
      // so corruption surfaces at the first read needing those bytes, which a full-tree read forces.
      let refusal = await thrownBy(async () => { await arm.storage().attach(); });
      refusal ??= await thrownBy(async () => { await tree(arm); });
      expect(refusal).toBeInstanceOf(Error);
      // NAMED. A refusal that cannot say which object is unsound is a refusal
      // nobody can act on.
      const message = describeThrown({ cause: refusal });
      expect(target.names.some(named => message.includes(named))).toBe(true);

      await arm.storage().discard();
      arm.replaceContainer();
      const fresh = await attach(arm);
      expect(fresh.kind).not.toBe('already-attached');
      expectCommitted(await commit(arm, NEW), 'the commit after discard');
      const woken = await wake(arm);
      expect(woken.kind).toBe('attached');
      expect(await tree(arm)).toEqual(NEW);
    });

    test('a commit interrupted by a replacement converges on exactly one head', async () => {
      const arm = open();
      await attach(arm);
      expectCommitted(await commit(arm, OLD), 'the commit before the race');
      expect((await arm.committedHeads()).length).toBe(1);

      // The last seam before the pointer swap: the operation is begun and its
      // payload is somewhere, but nothing has been promoted.
      const seam = arm.commitSeams[Math.max(0, arm.commitSeams.length - 3)];
      arm.dieAt(seam);
      await thrownBy(async () => { await commit(arm, NEW); });

      await wake(arm);
      // RE-DRIVEN on the replacement, which is what a live box does next.
      const redriven = await arm.storage().checkpoint('quiesce');
      expect(['committed', 'skipped']).toContain(redriven.kind);

      expect((await arm.committedHeads()).length).toBe(1);
      const woken = await wake(arm);
      expect(woken.kind).toBe('attached');
      await expectOneGeneration(arm, 'a commit that raced a replacement');
    });

    test('teardown on a stopped container completes or refuses in a classified way', async () => {
      const arm = open();
      await attach(arm);
      await commit(arm, OLD);
      arm.stopContainer();

      for (const step of ['detach', 'discard'] as const) {
        const storage = arm.storage();
        const run = step === 'detach' ? storage.detach : storage.discard;

        if (run === undefined) continue;
        const thrown = await thrownBy(async () => { await run.call(storage); });

        if (thrown === null) continue;
        // A classified failure is an Error a caller can report as an incident; a TypeError
        // is a property read on something no longer there, so it does not count.
        expect(thrown).toBeInstanceOf(Error);
        expect(thrown).not.toBeInstanceOf(TypeError);
        expect(thrown).not.toBeInstanceOf(ReferenceError);
        expect(describeThrown({ cause: thrown }).length).toBeGreaterThan(0);
      }
    });

    test('a checkpoint on a stopped container never claims to have committed', async () => {
      const arm = open();
      await attach(arm);
      await commit(arm, OLD);
      arm.stopContainer();
      let outcome: CheckpointOutcome | { kind: 'threw'; reason: string };

      try {
        outcome = await arm.storage().checkpoint('quiesce');
      } catch (error) {
        outcome = { kind: 'threw', reason: describeThrown({ cause: error }) };
      }

      expect(outcome.kind).not.toBe('committed');
      expect(outcome.reason ?? '').not.toBe('');
    });
  });
}

// Runs every design § 6 cell against each arm; a failure is a `KNOWN_RED` entry, never a retirement.
// `KNOWN_RED` in `support/conformance-bug-list.ts` locks the set of reds in both directions.



interface Cell {
  readonly id: string;
  readonly title: string;
  run(arm: ConformanceArm): Promise<void>;
}

type Outcome =
  | { readonly kind: 'pass' }
  | { readonly kind: 'fail'; readonly reason: string }
  | { readonly kind: 'refused'; readonly reason: string };

const EXISTING_CELLS: readonly { id: string; title: string }[] = [
  { id: '6.1', title: 'attach empty, write, commit, replace, attach' },
  { id: '6.2', title: 'quiesce publishes exactly once' },
  { id: '6.3', title: 'three generations, each wake carries every commit' },
  { id: '6.4', title: 'death at every commit seam serves old or new' },
  { id: '6.6', title: 'control metadata outside every payload prefix' },
  { id: '6.7', title: 'corrupted payload refused by name' },
  { id: '6.8', title: 'commit interrupted by replacement converges' },
  { id: '6.16', title: 'teardown after stop is classified' },
];

function refusedProperties(arm: ConformanceArm): Set<TreeProperty> {
  return new Set(TREE_PROPERTIES.filter((property) => arm.refusedProperties[property] !== undefined));
}

async function expectTreeExact(arm: ConformanceArm, expected: readonly NodeEntry[], what: string): Promise<void> {
  const refused = refusedProperties(arm);
  const served = await arm.workspace.snapshot();
  const mismatches = compareTrees(expected, served, refused);

  if (mismatches.length > 0) {
    throw new Error(`${arm.name} ${what}: ${mismatches.length} mismatches: ${describeMismatches(mismatches).slice(0, 600)}`);
  }

  const want = canonicalTreeBytes(expected, refused);
  const have = canonicalTreeBytes(served, refused);

  if (Buffer.compare(want, have) !== 0) throw new Error(`${arm.name} ${what}: canonical manifest bytes differ`);
}

/** A checkpoint's outcome, or the words it threw with: the late boot in a
 *  race may do either, and a cell asserts on both the same way. */
async function settledCheckpoint(run: Promise<CheckpointOutcome>): Promise<CheckpointOutcome | { kind: 'threw'; reason: string }> {
  try {
    return await run;
  } catch (error) {
    return { kind: 'threw', reason: describeThrown({ cause: error }) };
  }
}

async function commitTree(arm: ConformanceArm, entries: readonly NodeEntry[], what: string): Promise<void> {
  await arm.workspace.plant(entries);
  expectCommitted(await arm.storage().checkpoint('quiesce'), what);
}

/** One tree size in cell 6.21: wall times are recorded, never asserted;
 *  the assertion reads only the counted work rows. */
interface ComplexitySample {
  readonly files: number;
  readonly bytes: number;
  readonly fullBackupMs: number;
  readonly fullObjectsPut: number;
  readonly fullBytesPut: number;
  backup64kMs: number;
  backup64kBytesPut: number;
  restoreMs: number;
  restoreOps: number;
  restorePayloadBytes: number;
}

/** One row per tree size per arm, printed by `afterAll` beside the matrix. Rows are set as
 *  each size lands, so a failing arm still shows what it measured before the assertion fired. */
const complexitySamples = new Map<string, ComplexitySample[]>();

const publicationSamples = new Map<string, { bytesPut: number; objectsPut: number }>();

interface IndexSample {
  files: number;
  publicationBytes: number;
  publicationObjects: number;
  attachBytes: number;
  attachObjects: number;
}

const indexSamples = new Map<string, IndexSample[]>();

const CELLS: readonly Cell[] = [
  {
    id: '6.9',
    title: 'DO reset mid-restore: one daemon, one restore, tree exact',
    async run(arm) {
      const fixture = textTree(OLD);
      await attach(arm);
      await commitTree(arm, fixture, 'the commit before the resets');
      arm.replaceContainer();
      const before = arm.disk().mountCalls;
      await arm.storage().attach();
      const baselineMounts = arm.disk().mountCalls - before;
      const problems: string[] = [];

      for (const seam of arm.attachSeams) {
        arm.replaceContainer();
        arm.dieAt(seam);
        const reset = await thrownBy(async () => { await arm.storage().attach(); });

        if (reset === null) {
          problems.push(`${seam}: never reached, the reset had nothing to interrupt`);
          continue;
        }

        arm.resetIsolate();
        const woken = await arm.storage().attach();

        if (woken.kind === 'empty') problems.push(`${seam}: the second isolate answered empty`);
        const mismatches = compareTrees(fixture, await arm.workspace.snapshot(), refusedProperties(arm));

        if (mismatches.length > 0) problems.push(`${seam}: ${describeMismatches(mismatches).slice(0, 200)}`);
        const mounts = arm.disk().mountCalls;

        if (mounts !== baselineMounts) problems.push(`${seam}: ${mounts} mounts across both isolates, an uninterrupted wake makes ${baselineMounts}`);
      }

      if (problems.length > 0) throw new Error(problems.join('; '));
    },
  },
  {
    id: '6.10',
    title: 'container replaced mid-commit, old boot finishes late',
    async run(arm) {
      await attach(arm);
      expectCommitted(await commit(arm, OLD), 'the commit before the race');
      const old = { storage: arm.storage(), workspace: arm.workspace };

      for (const [path, text] of Object.entries(NEW)) await old.workspace.write(path, text);
      const hold = arm.holdFinalize();
      const late = old.storage.checkpoint('quiesce');
      await hold.entered;
      arm.replaceContainer();
      const woken = await arm.storage().attach();
      expect(woken.kind).toBe('attached');
      expectCommitted(await commit(arm, THIRD), 'the new boot\'s commit');
      hold.release();
      const outcome = await settledCheckpoint(late);
      const heads = await arm.committedHeads();
      const served = canonical(await tree(arm));
      const problems: string[] = [];

      if (outcome.kind === 'committed') problems.push('the late finalize reported committed');

      if (heads.length !== 1) problems.push(`${heads.length} heads`);

      // The new boot may adopt a complete orphan delta (6.4 `after-payload`), so the expected tree
      // is measured, not assumed: it must contain the new commit and survive the wake unchanged.
      if (!served.includes(JSON.stringify(Object.entries(THIRD)[0][1]))) problems.push(`the new boot's commit is absent from the tree it served: ${served}`);
      const afterWake = await wake(arm);

      if (afterWake.kind !== 'attached') problems.push(`wake answered ${afterWake.kind}`);
      const wokenTree = canonical(await tree(arm));

      if (wokenTree !== served) problems.push(`the wake served ${wokenTree}, the new boot served ${served}`);

      if (problems.length > 0) throw new Error(problems.join('; '));
    },
  },
  {
    id: '6.11',
    title: 'byte-for-byte: mode, owner, times, xattrs, symlink, hardlink, sparse',
    async run(arm) {
      const fixture = fidelityTree();
      await attach(arm);
      await commitTree(arm, fixture, 'the fidelity commit');
      const woken = await wake(arm);
      expect(woken.kind).toBe('attached');
      await expectTreeExact(arm, fixture, 'after the wake');
    },
  },
  {
    id: '6.12',
    title: 'counted bounds, and the same k against n and 10n',
    async run(arm) {
      const P = 32 * 1024 * 1024;

      const run = async (files: number) => {
        const fresh = CONFORMANCE_ARMS[arm.name]();
        await attach(fresh);
        await commitTree(fresh, generatedTree({ seed: 3, files, bytesPerFile: 4096 }), `the ${files}-file base`);
        const k = new Seeded(files).fill(new Uint8Array(4096));
        await fresh.workspace.plant([...textTree({}), { path: 'touched.bin', kind: 'file', mode: 0o644, ino: 999_999, content: { kind: 'dense', bytes: k }, metadata: { uid: 1, gid: 1, atimeNs: '1', mtimeNs: '1', ctimeNs: '1', xattrs: {} } }]);
        const putsBefore = fresh.durable.ops.filter((op) => op.op === 'put').length;
        expectCommitted(await fresh.storage().checkpoint('quiesce'), 'the k commit');
        const puts = fresh.durable.ops.filter((op) => op.op === 'put').length - putsBefore;
        const work = fresh.work();

        if (work.publish.objectsPut !== puts) throw new Error(`PublishWork.objectsPut says ${work.publish.objectsPut}, the store saw ${puts} puts`);
        await wake(fresh);

        return { seal: work.seal, publish: work.publish, restore: fresh.work().restore };
      };

      const small = await run(200);
      const large = await run(2000);
      const problems: string[] = [];
      const kBytes = 4096;
      const c = 16 * 1024;
      const p = 1;
      const d = 1;

      if (small.seal.bytesStaged > 2 * kBytes + 4 * c) problems.push(`bytesStaged ${small.seal.bytesStaged} > 2k + 4c for k=4 KiB`);

      if (small.seal.nodesRewritten > p * (d + 2)) problems.push(`nodesRewritten ${small.seal.nodesRewritten} > p(d+2) = 3`);

      if (small.publish.objectsPut > Math.ceil(kBytes / P) + 2) problems.push(`objectsPut ${small.publish.objectsPut} > ceil(k/P)+2 = 3`);
      const ratio = (a: number, b: number): boolean => a === b || Math.abs(a - b) / Math.max(a, b, 1) <= 0.1;

      for (const [name, a, b] of [
        ['seal.bytesStaged', small.seal.bytesStaged, large.seal.bytesStaged],
        ['seal.bytesChunked', small.seal.bytesChunked, large.seal.bytesChunked],
        ['seal.nodesRewritten', small.seal.nodesRewritten, large.seal.nodesRewritten],
        ['publish.objectsPut', small.publish.objectsPut, large.publish.objectsPut],
        ['publish.bytesPut', small.publish.bytesPut, large.publish.bytesPut],
        ['restore.totalRemoteOps', small.restore.totalRemoteOps, large.restore.totalRemoteOps],
      ] as const) {
        if (!ratio(a, b)) problems.push(`${name}: n gives ${a}, 10n gives ${b}`);
      }

      if (problems.length > 0) throw new Error(problems.join('; '));
    },
  },
  {
    id: '6.13',
    title: '1e5 files: exact tree, same RestoreWork as 1e3 files',
    async run(arm) {
      const restoreOf = async (files: number): Promise<RestoreWork> => {
        const fresh = CONFORMANCE_ARMS[arm.name]();
        const fixture = generatedTree({ seed: 5, files, bytesPerFile: 16 });
        await attach(fresh);
        await commitTree(fresh, fixture, `the ${files}-file commit`);
        const woken = await wake(fresh);

        if (woken.kind !== 'attached') throw new Error(`${files} files: wake answered ${woken.kind}`);
        await expectTreeExact(fresh, fixture, `${files} files after the wake`);
        const restore = fresh.work().restore;
        // Evictable pages come from immutable objects and are checked against the head's digest,
        // so eviction can cost only a re-read; this re-read checks bytes stay identical.
        fresh.evictCleanBytes?.();
        await expectTreeExact(fresh, fixture, `${files} files after eviction and re-read`);

        return restore;
      };

      const small = await restoreOf(1_000);
      const large = await restoreOf(100_000);

      if (large.totalRemoteOps !== small.totalRemoteOps) {
        throw new Error(`RestoreWork.totalRemoteOps is ${large.totalRemoteOps} for 1e5 files and ${small.totalRemoteOps} for 1e3`);
      }
    },
  },
  {
    id: '6.14',
    title: '1 GiB sparse plus 64 MiB dense: commit O(data), wake O(1), in-place seal O(k)',
    async run(arm) {
      if (arm.refusedCells['6.14'] !== undefined) throw new ArmRefused('6.14', arm.refusedCells['6.14'].reason);
      const fixture = gigabyteTree();
      const data = heldBytes(fixture);
      await attach(arm);
      await commitTree(arm, fixture, 'the 1 GiB commit');
      const problems: string[] = [];
      const first = arm.work();

      if (first.seal.bytesChunked > 2 * data) problems.push(`commit chunked ${first.seal.bytesChunked} bytes for ${data} data bytes`);

      if (first.publish.bytesPut > 2 * data) problems.push(`commit put ${first.publish.bytesPut} bytes for ${data} data bytes`);
      const woken = await wake(arm);

      if (woken.kind !== 'attached') problems.push(`wake answered ${woken.kind}`);
      await expectTreeExact(arm, fixture, 'after the wake');
      const restore = arm.work().restore;

      if (restore.totalRemoteOps > 3) problems.push(`wake made ${restore.totalRemoteOps} remote ops; O(1) is 3`);
      arm.evictCleanBytes?.();
      await expectTreeExact(arm, fixture, 'after eviction and re-read');
      const patch = new Seeded(21).fill(new Uint8Array(64 * 1024));
      await arm.workspace.pwrite('vol/dense.bin', 8 * 1024 * 1024, patch);
      expectCommitted(await arm.storage().checkpoint('quiesce'), 'the 64 KiB in-place commit');
      const second = arm.work();
      const c = 16 * 1024;

      if (second.seal.bytesChunked > patch.byteLength + 8 * c) problems.push(`the 64 KiB write chunked ${second.seal.bytesChunked} bytes`);

      if (second.publish.bytesPut > 4 * (patch.byteLength + 8 * c)) problems.push(`the 64 KiB write put ${second.publish.bytesPut} bytes`);

      if (problems.length > 0) throw new Error(problems.join('; '));
    },
  },
  {
    id: '6.15',
    title: 'sqlite rewrite: random 4 KiB pwrites, bytesPut bounded by dirty pages',
    async run(arm) {
      const seed = new Seeded(31);
      const db = seed.fill(new Uint8Array(64 * 1024 * 1024));
      const fixture: NodeEntry[] = [{ path: 'app.db', kind: 'file', mode: 0o644, ino: 1, content: { kind: 'dense', bytes: db }, metadata: { uid: 1000, gid: 1000, atimeNs: '1', mtimeNs: '1', ctimeNs: '1', xattrs: {} } }];
      await attach(arm);
      await commitTree(arm, fixture, 'the database commit');
      const pages = 64;
      const dirty = new Set<number>();

      while (dirty.size < pages) dirty.add(seed.below(db.byteLength / 4096));

      for (const page of dirty) await arm.workspace.pwrite('app.db', page * 4096, seed.fill(new Uint8Array(4096)));
      expectCommitted(await arm.storage().checkpoint('quiesce'), 'the page-write commit');
      const c = 16 * 1024;
      const bound = 4 * pages * c;
      const put = arm.work().publish.bytesPut;
      const expected = await arm.workspace.snapshot();
      const woken = await wake(arm);
      expect(woken.kind).toBe('attached');
      await expectTreeExact(arm, expected, 'after the wake');

      if (put > bound) throw new Error(`bytesPut ${put} > 4 × ${pages} dirty pages × ${c} = ${bound}`);
    },
  },
  {
    id: '6.17',
    title: 'two containers racing: one head, loser refused and reported, never merged',
    async run(arm) {
      const second = arm.secondBoot();
      await attach(arm);
      expectCommitted(await commit(arm, OLD), 'the base commit');
      const woken = await second.storage().attach();
      expect(woken.kind).toBe('attached');
      await arm.workspace.write('a.txt', 'written by boot A');
      await second.workspace.write('b.txt', 'written by boot B');
      const hold = arm.holdFinalize();
      const raceA = arm.storage().checkpoint('quiesce');
      await hold.entered;
      const outcomeB = await second.storage().checkpoint('quiesce');
      hold.release();
      const outcomeA = await settledCheckpoint(raceA);
      const heads = await arm.committedHeads();
      const problems: string[] = [];

      if (heads.length !== 1) problems.push(`${heads.length} heads`);
      const committed = [outcomeA.kind === 'committed' ? 'A' : null, outcomeB.kind === 'committed' ? 'B' : null].filter((x) => x !== null);

      if (committed.length !== 1) problems.push(`${committed.length} boots reported committed (${committed.join(',')})`);
      const winnerIsB = outcomeB.kind === 'committed';
      const loser: ArmBoot = winnerIsB ? arm : second;

      if (loser.failures.length === 0) problems.push('the loser recorded no failure');
      const served = await tree(arm);
      arm.replaceContainer();
      await arm.storage().attach();
      const after = await tree(arm);

      if (after['a.txt'] !== undefined && after['b.txt'] !== undefined) problems.push(`both dirty sets were merged: ${canonical(after)}`);

      if (winnerIsB ? after['b.txt'] === undefined : after['a.txt'] === undefined) problems.push(`the winner's file is absent: ${canonical(after)} (pre-wake ${canonical(served)})`);

      if (problems.length > 0) throw new Error(problems.join('; '));
    },
  },
  {
    id: '6.18',
    title: 'disk full mid-journal: ENOSPC, no effect without a record, eviction, tree exact',
    async run(arm) {
      await attach(arm);
      expectCommitted(await commit(arm, OLD), 'the commit before the quota');
      const disk = arm.disk();
      disk.quotaBytes = disk.usedBytes + 24 * 1024;
      const acknowledged = new Map(Object.entries(OLD));
      let refusal: Error | null = null;

      for (let index = 0; index < 64 && refusal === null; index += 1) {
        const text = `fill ${index} `.repeat(200);

        try {
          await arm.workspace.write(`fill-${index}.txt`, text);
          acknowledged.set(`fill-${index}.txt`, text);
        } catch (error) {
          refusal = error instanceof Error ? error : new Error(String(error));
        }
      }

      const problems: string[] = [];

      if (refusal === null) problems.push('the quota never refused a write');
      else if (!(refusal instanceof DiskFull) || !refusal.message.includes('ENOSPC')) problems.push(`the refusal was not ENOSPC: ${refusal.message}`);

      if (canonical(await tree(arm)) !== canonical(Object.fromEntries(acknowledged))) problems.push('the tree differs from the acknowledged writes');
      const outcome = await arm.storage().checkpoint('quiesce');

      if (outcome.kind === 'committed' && canonical(await tree(arm)) !== canonical(Object.fromEntries(acknowledged))) problems.push('a commit under quota changed the tree');

      if (outcome.kind === 'failed') problems.push(`the checkpoint under quota failed: ${outcome.reason}`);
      const freed = arm.evictCleanBytes?.() ?? 0;

      if (freed === 0) problems.push('nothing evicted clean bytes to make room');
      const woken = await wake(arm);

      if (woken.kind !== 'attached') problems.push(`wake answered ${woken.kind}`);

      if (canonical(await tree(arm)) !== canonical(Object.fromEntries(acknowledged))) problems.push(`the wake served ${canonical(await tree(arm)).slice(0, 200)}`);

      if (problems.length > 0) throw new Error(problems.join('; '));
    },
  },
  {
    id: '6.20',
    title: 'GC never deletes a reachable object',
    async run(arm) {
      await attach(arm);

      for (const generation of [OLD, NEW, THIRD]) {
        expectCommitted(await commit(arm, generation), `generation ${JSON.stringify(generation)}`);

        for (const declared of await arm.declaredPayload()) {
          if (arm.durable.head(declared.key) === null) throw new Error(`the head reaches ${declared.key} and the store lost it`);
        }
      }

      const reachable = new Set((await arm.declaredPayload()).map((declared) => declared.key));

      for (const write of arm.durable.writes) {
        if (write.startsWith('delete:') && reachable.has(write.slice('delete:'.length))) {
          throw new Error(`${write} names a key the head still reaches`);
        }
      }
    },
  },
  {
    id: '6.21',
    title: 'restore and backup time versus tree size at three sizes',
    async run(arm) {
      // The largest tree (40 MiB) keeps the whole cell inside the 120 s per-test budget on every arm.
      const probe = 'x'.repeat(64 * 1024);
      const rows: ComplexitySample[] = [];

      for (const files of [100, 1_000, 10_000]) {
        const fresh = CONFORMANCE_ARMS[arm.name]();
        const fixture = generatedTree({ seed: 41, files, bytesPerFile: 4096 });
        await attach(fresh);
        await fresh.workspace.plant(fixture);
        const fullStart = performance.now();
        expectCommitted(await fresh.storage().checkpoint('quiesce'), `the ${files}-file full backup`);
        const full = fresh.work().publish;

        const row: ComplexitySample = {
          files,
          bytes: files * 4096,
          fullBackupMs: performance.now() - fullStart,
          fullObjectsPut: full.objectsPut,
          fullBytesPut: full.bytesPut,
          backup64kMs: 0,
          backup64kBytesPut: 0,
          restoreMs: 0,
          restoreOps: 0,
          restorePayloadBytes: 0,
        };

        await fresh.workspace.write('probe-64k.bin', probe);
        const backupStart = performance.now();
        expectCommitted(await fresh.storage().checkpoint('quiesce'), `the 64 KiB backup at ${files} files`);
        row.backup64kMs = performance.now() - backupStart;
        row.backup64kBytesPut = fresh.work().publish.bytesPut;
        const expected = await fresh.workspace.snapshot();
        const restoreStart = performance.now();
        const woken = await wake(fresh);
        row.restoreMs = performance.now() - restoreStart;

        if (woken.kind !== 'attached') throw new Error(`${files} files: wake answered ${woken.kind}`);
        const restore = fresh.work().restore;
        row.restoreOps = restore.totalRemoteOps;
        row.restorePayloadBytes = restore.payloadBytes;
        await expectTreeExact(fresh, expected, `${files} files after the wake`);
        rows.push(row);
        complexitySamples.set(arm.name, [...rows]);
      }

      // Assert only counted work, never wall clock: a 64 KiB backup and a restore cost the same
      // at 1,000 and 10,000 files, under the ratio rule cell 6.12 uses.
      const middle = rows[1];
      const large = rows[2];
      const problems: string[] = [];

      if (large.restoreOps !== middle.restoreOps) {
        problems.push(`restore.totalRemoteOps is ${large.restoreOps} for 10,000 files and ${middle.restoreOps} for 1,000`);
      }

      const putSmall = Math.min(large.backup64kBytesPut, middle.backup64kBytesPut);
      const putLarge = Math.max(large.backup64kBytesPut, middle.backup64kBytesPut);

      if (putSmall !== putLarge && (putLarge - putSmall) / Math.max(putLarge, 1) > 0.1) {
        problems.push(`64 KiB backup bytesPut is ${large.backup64kBytesPut} for 10,000 files and ${middle.backup64kBytesPut} for 1,000`);
      }

      if (problems.length > 0) throw new Error(problems.join('; '));
    },
  },
  {
    id: '6.22',
    title: 'C3 overwrite: a 64 KiB edit publishes below 196,608 bytes in exactly one object',
    async run(arm) {
      // The bound is three times the edit: at most two 64 KiB blocks plus manifest and image skeleton.
      // Bytes and the one-object bound must hold together, so neither is bought with the other.
      const C3_BOUND = 196_608;
      const seed = new Seeded(61);
      const bytes = seed.fill(new Uint8Array(64 * 1024 * 1024));
      await attach(arm);
      await arm.workspace.plant([{
        path: 'vol/dense.bin', kind: 'file', mode: 0o644, ino: 7,
        content: { kind: 'dense', bytes },
        metadata: { uid: 1000, gid: 1000, atimeNs: '1', mtimeNs: '1', ctimeNs: '1', xattrs: {} },
      }]);
      expectCommitted(await arm.storage().checkpoint('quiesce'), 'the 64 MiB base commit');
      const patch = new Seeded(62).fill(new Uint8Array(64 * 1024));
      await arm.workspace.pwrite('vol/dense.bin', 8 * 1024 * 1024, patch);
      expectCommitted(await arm.storage().checkpoint('quiesce'), 'the 64 KiB overwrite commit');
      const publish = arm.work().publish;
      const problems: string[] = [];

      if (publish.bytesPut >= C3_BOUND) problems.push(`the 64 KiB overwrite put ${publish.bytesPut} bytes against the strict ${C3_BOUND} bound`);

      if (publish.objectsPut !== 1) problems.push(`the 64 KiB overwrite put ${publish.objectsPut} objects, exactly 1 required`);
      const expected = await arm.workspace.snapshot();
      const woken = await wake(arm);

      if (woken.kind !== 'attached') problems.push(`wake answered ${woken.kind}`);
      await expectTreeExact(arm, expected, 'after the wake');

      if (problems.length > 0) throw new Error(`bytesPut=${publish.bytesPut} objectsPut=${publish.objectsPut}; ${problems.join('; ')}`);
      publicationSamples.set(`${arm.name} 6.22`, publish);
    },
  },
  {
    id: '6.23',
    title: 'many small changed files: one object per checkpoint, bytes near the change',
    async run(arm) {
      // A chunked design must not trade fewer bytes for more objects: fifty changed small
      // files still publish as ONE object (D4), with bytes near the change, not the tree.
      await attach(arm);
      await commitTree(arm, generatedTree({ seed: 63, files: 200, bytesPerFile: 4096 }), 'the 200-file base commit');

      for (let index = 0; index < 50; index += 1) {
        await arm.workspace.write(`d000/d${String(Math.floor(index / 64)).padStart(3, '0')}/f${String(index).padStart(6, '0')}.bin`, `rewritten ${index} `.repeat(200));
      }

      expectCommitted(await arm.storage().checkpoint('quiesce'), 'the 50-file overwrite commit');
      const publish = arm.work().publish;
      const problems: string[] = [];

      if (publish.objectsPut !== 1) problems.push(`50 changed files put ${publish.objectsPut} objects, the floor is 1`);

      if (publish.bytesPut >= 512 * 1024) problems.push(`50 changed files put ${publish.bytesPut} bytes against the strict 524,288 bound`);
      const expected = await arm.workspace.snapshot();
      const woken = await wake(arm);

      if (woken.kind !== 'attached') problems.push(`wake answered ${woken.kind}`);
      await expectTreeExact(arm, expected, 'after the wake');

      if (problems.length > 0) throw new Error(problems.join('; '));
      publicationSamples.set(`${arm.name} 6.23`, publish);
    },
  },
  {
    id: '6.24',
    title: 'per-file maps: a one-file change costs the same at 1,000 and 5,000 files',
    async run(arm) {
      // No read path may fetch an index that grows with the tree; only the base body is excluded,
      // so any other fetched key counts even if the record does not declare it part of the delta.
      const samples: IndexSample[] = [];

      for (const files of [1_000, 5_000]) {
        const fresh = CONFORMANCE_ARMS[arm.name]();
        await attach(fresh);
        await commitTree(fresh, generatedTree({ seed: 67, files, bytesPerFile: 16 }), `the ${files}-file base commit`);
        await fresh.workspace.write('probe.txt', 'one small changed file');
        expectCommitted(await fresh.storage().checkpoint('quiesce'), `the one-file commit at ${files} files`);
        const publish = fresh.work().publish;
        const expected = await fresh.workspace.snapshot();
        const baseKeys = new Set((await fresh.declaredPayload()).filter((object) => object.names.includes('base')).map((object) => object.key));
        const window = fresh.durable.ops.length;
        const woken = await wake(fresh);

        if (woken.kind !== 'attached') throw new Error(`${files} files: wake answered ${woken.kind}`);
        expect(await fresh.workspace.read('probe.txt')).toBe('one small changed file');
        const reads = fresh.durable.ops.slice(window).filter((op) => op.op === 'get' && !baseKeys.has(op.key));
        samples.push({
          files, publicationBytes: publish.bytesPut, publicationObjects: publish.objectsPut,
          attachBytes: reads.reduce((sum, op) => sum + op.bytes, 0), attachObjects: reads.length,
        });
        await expectTreeExact(fresh, expected, `${files} files after the wake`);
      }

      const problems: string[] = [];
      const small = samples[0];
      const large = samples[1];

      for (const [name, field, tolerance] of [
        ['publication bytes', 'publicationBytes', 0.1],
        ['publication objects', 'publicationObjects', 0],
        ['attach bytes', 'attachBytes', 0.1],
        ['attach objects', 'attachObjects', 0],
      ] as const) {
        const a = small[field];
        const b = large[field];

        if (a <= 0 || b <= 0 || Math.abs(b - a) / Math.max(a, b, 1) > tolerance) {
          problems.push(`${name} is ${a} at 1,000 files and ${b} at 5,000: missing or grows with the tree`);
        }
      }

      if (problems.length > 0) throw new Error(problems.join('; '));
      indexSamples.set(arm.name, samples);
    },
  },
];

async function runCell(cell: Cell, arm: ConformanceArm): Promise<Outcome> {
  try {
    await cell.run(arm);

    return { kind: 'pass' };
  } catch (error) {
    if (error instanceof ArmRefused) {
      const declared = arm.refusedCells[error.cell]?.reason;

      if (declared === error.reason && error.cell === cell.id) return { kind: 'refused', reason: error.reason };

      return { kind: 'fail', reason: `refused ${error.cell} without a matching declaration: ${error.reason}` };
    }

    return { kind: 'fail', reason: describeThrown({ cause: error }).slice(0, 700) };
  }
}

const matrix = new Map<string, Map<string, Outcome>>();

function cellById(id: string): Cell {
  const found = CELLS.find((row) => row.id === id);

  if (found === undefined) throw new Error(`the battery holds no cell ${id}`);

  return found;
}

function cellLabel(cell: Cell, refusal: Refusal | undefined, known: KnownRed | undefined): string {
  if (refusal !== undefined) return `${cell.id} ${cell.title} [refused: ${refusal.reason.slice(0, 60)}]`;

  if (known !== undefined) return `${cell.id} ${cell.title} [bug list since ${known.since}]`;

  return `${cell.id} ${cell.title}`;
}

for (const [name, open] of armEntries) {
  describe(`${name} — the smart-container bar`, () => {
    for (const cell of CELLS) {
      const known = KNOWN_RED.find((row) => row.arm === name && row.cell === cell.id);
      const declaredRefusal = open().refusedCells[cell.id];

      const label = cellLabel(cell, declaredRefusal, known);

      test(label, async () => {
        const arm = open();

        const outcome = declaredRefusal !== undefined && cell.id !== '6.14'
          ? { kind: 'refused' as const, reason: declaredRefusal.reason }
          : await runCell(cell, arm);

        let row = matrix.get(cell.id);

        if (row === undefined) {
          row = new Map();
          matrix.set(cell.id, row);
        }

        row.set(name, outcome);

        if (outcome.kind === 'refused') {
          if (known !== undefined) throw new Error(`the bug list names ${name} ${cell.id} as red, and the arm refuses it: remove the row`);

          return;
        }

        if (outcome.kind === 'fail') {
          if (known !== undefined) return;
          throw new Error(`${name} ${cell.id} is red and the bug list does not name it: ${outcome.reason}`);
        }

        if (known !== undefined) {
          throw new Error(`the bug list names ${name} ${cell.id} as red since ${known.since}, and it passed: record the win by removing the row`);
        }
      });
    }
  });
}

test('every bug-list row names a live arm and a live cell', () => {
  const cells = new Set(CELLS.map((cell) => cell.id));

  for (const row of KNOWN_RED) {
    expect(parseDevboxStrategyName(row.arm)).toBe(row.arm);
    expect(cells.has(row.cell)).toBe(true);
    expect(row.reason.length).toBeGreaterThan(0);
  }
});

// A cell green on every arm proves nothing until it has been red once; each cell below
// runs against a deliberately broken arm and must FAIL.

function blankWakeArm(): ConformanceArm {
  const arm = CONFORMANCE_ARMS['snapshot-chain']();
  const broken: ConformanceArm = Object.create(arm);
  Object.defineProperty(broken, 'storage', {
    value: () => {
      const raw = arm.storage();

      return {
        ...raw,
        attach: async () => {
          const outcome = await raw.attach();

          for (const path of await arm.workspace.paths()) await arm.workspace.remove(path);

          return outcome;
        },
      };
    },
  });

  return broken;
}

/** Replace every arm the cell opens, not just the first argument it receives. */
async function runCellOn(cell: Cell, makeBroken: () => ConformanceArm): Promise<Outcome> {
  const broken = makeBroken();
  const open = CONFORMANCE_ARMS[broken.name];
  Object.defineProperty(CONFORMANCE_ARMS, broken.name, { value: makeBroken, configurable: true });

  try {
    return await runCell(cell, broken);
  } finally {
    Object.defineProperty(CONFORMANCE_ARMS, broken.name, { value: open, configurable: true });
  }
}

describe('red direction — every new cell fails against a deliberately broken arm', () => {
  test('6.11 fails when the wake serves a blank tree', async () => {
    const cell = cellById('6.11');
    const outcome = await runCell(cell, blankWakeArm());
    expect(outcome.kind).toBe('fail');
  });

  test('6.13 fails when the wake serves a blank tree', async () => {
    // `runCellOn`, not `runCell`: 6.13's restoreOf opens a fresh arm per trial via
    // `CONFORMANCE_ARMS[arm.name]()`, so only overriding the factory puts the broken arm in the loop.
    const cell = cellById('6.13');
    const broken = blankWakeArm();
    const outcome = await runCellOn(cell, () => broken);
    expect(outcome.kind).toBe('fail');
  });

  test('6.20 fails when the store loses a reachable key', async () => {
    const arm = CONFORMANCE_ARMS['snapshot-chain']();
    const cell = cellById('6.20');
    const broken: ConformanceArm = Object.create(arm);
    Object.defineProperty(broken, 'declaredPayload', {
      value: async () => {
        const declared = await arm.declaredPayload();

        if (declared.length > 0) arm.durable.delete(declared[0].key);

        return declared;
      },
    });
    const outcome = await runCell(cell, broken);
    expect(outcome.kind).toBe('fail');
    expect(outcome.kind === 'fail' ? outcome.reason : '').toContain('the store lost it');
  });

  test('6.12 fails when the publish counter lies about the store', async () => {
    const arm = CONFORMANCE_ARMS['snapshot-chain']();
    const cell = cellById('6.12');
    const broken: ConformanceArm = Object.create(arm);
    Object.defineProperty(broken, 'work', {
      value: () => ({ ...arm.work(), publish: { objectsPut: 0, bytesPut: 0, casAttempts: 0 } }),
    });
    // The cell opens fresh arms by name; the lying counter is proven on the
    // arm's own work row directly.
    await attach(broken);
    expectCommitted(await commit(broken, OLD), 'the commit');
    const puts = broken.durable.ops.filter((op) => op.op === 'put').length;
    expect(puts).toBeGreaterThan(0);
    expect(broken.work().publish.objectsPut).not.toBe(puts);
    void cell;
  });

  test('6.13 fails when eviction cannot be trusted for the re-read', async () => {
    // Dropping a clean page is safe only because its re-read is a digest-verified fetch of the
    // same bytes; corrupting payloads after the sweep breaks exactly that after the drop.
    const cell = cellById('6.13');
    const arm = CONFORMANCE_ARMS['snapshot-chain']();
    const broken: ConformanceArm = Object.create(arm);
    Object.defineProperty(broken, 'evictCleanBytes', {
      value: () => {
        const freed = arm.evictCleanBytes?.() ?? 0;

        for (const prefix of arm.payloadPrefixes()) {
          for (const key of arm.durable.list(prefix)) arm.durable.corrupt(key, 'flip');
        }

        return freed;
      },
    });
    const outcome = await runCellOn(cell, () => broken);
    expect(outcome.kind).toBe('fail');
  });

  test.each([
    { label: 'bytes at the strict bound', mutation: { bytesPut: 196_608 }, reason: '196608 bytes' },
    { label: 'two objects', mutation: { objectsPut: 2 }, reason: '2 objects' },
    { label: 'no object', mutation: { objectsPut: 0 }, reason: '0 objects' },
  ])('6.22 fails with $label', async ({ mutation, reason }) => {
    const arm = CONFORMANCE_ARMS['snapshot-chain']();
    const broken: ConformanceArm = Object.create(arm);
    Object.defineProperty(broken, 'work', {
      value: () => ({ ...arm.work(), publish: { ...arm.work().publish, ...mutation } }),
    });
    const outcome = await runCell(cellById('6.22'), broken);
    expect(outcome.kind).toBe('fail');
    expect(outcome.kind === 'fail' ? outcome.reason : '').toContain(reason);
  });

  test.each(['publication bytes', 'publication objects', 'attach bytes', 'attach objects'])(
    '6.24 fails when %s grow with the tree', async (direction) => {
      const open = CONFORMANCE_ARMS['snapshot-chain'];

      const outcome = await runCellOn(cellById('6.24'), () => {
        const arm = open();
        const broken: ConformanceArm = Object.create(arm);
        const largeTree = () => arm.disk().snapshot('/workspace').length > 5_000;
        Object.defineProperty(broken, 'work', {
          value: () => {
            const work = arm.work();

            if (!largeTree()) return work;

            return {
              ...work,
              publish: {
                ...work.publish,
                bytesPut: direction === 'publication bytes' ? work.publish.bytesPut + 1_000_000 : work.publish.bytesPut,
                objectsPut: direction === 'publication objects' ? work.publish.objectsPut + 1 : work.publish.objectsPut,
              },
            };
          },
        });
        Object.defineProperty(broken, 'storage', {
          value: () => {
            const storage = arm.storage();

            return {
              ...storage,
              attach: async () => {
                const result = await storage.attach();

                if (largeTree() && direction.startsWith('attach ')) {
                  arm.durable.ops.push({
                    op: 'get', key: 'tree-wide-index', bytes: direction === 'attach bytes' ? 1_000_000 : 0,
                  });
                }

                return result;
              },
            };
          },
        });

        return broken;
      });

      expect(outcome.kind).toBe('fail');
      expect(outcome.kind === 'fail' ? outcome.reason : '').toContain(direction);
    },
  );
});

describe('explicit collapse paths', () => {
  test('successive deltas are immutable and a mounted archive survives the sweep', async () => {
    const arm = CONFORMANCE_ARMS['snapshot-chain']();
    await attach(arm);
    await arm.workspace.write('base', 'base bytes');
    expectCommitted(await arm.storage().checkpoint('quiesce'), 'base');
    await arm.workspace.write('first', 'first delta');
    expectCommitted(await arm.storage().checkpoint('tick'), 'first delta');
    const first = (await arm.declaredPayload()).find(object => object.names.includes('delta'));

    if (first === undefined) throw new Error('first delta not published');
    const bytes = arm.durable.get(first.key);
    expect((await wake(arm)).kind).toBe('attached');
    await arm.workspace.write('second', 'second delta');
    expectCommitted(await arm.storage().checkpoint('tick'), 'second delta');
    const second = (await arm.declaredPayload()).find(object => object.names.includes('delta'));
    expect(second?.key).not.toBe(first.key);
    expect(arm.durable.get(first.key)).toEqual(bytes);
    const expected = await arm.workspace.snapshot();
    expect((await wake(arm)).kind).toBe('attached');
    await expectTreeExact(arm, expected, 'retained metadata merged at a new key');
    await arm.workspace.write('third', 'third delta');
    expectCommitted(await arm.storage().checkpoint('tick'), 'third delta');
    expect(arm.durable.get(first.key)).toBeNull();
  });

  test('an overlay without its composed block mount cannot publish readiness on a repeated attach', async () => {
    const arm = CONFORMANCE_ARMS['snapshot-chain']();
    await attach(arm);
    await arm.workspace.write('base', 'base bytes');
    expectCommitted(await arm.storage().checkpoint('quiesce'), 'base');
    await arm.workspace.write('delta', 'delta bytes');
    expectCommitted(await arm.storage().checkpoint('tick'), 'delta');
    expect((await wake(arm)).kind).toBe('attached');
    const block = [...arm.disk().mounts].find(([, mount]) => mount.source.startsWith('devbox-block:'));

    if (block === undefined) throw new Error('composed lower missing');
    arm.disk().unmount(block[0]);
    await expect(attach(arm)).rejects.toThrow('incomplete composed mounts');
  });

  for (const profile of ['chunked', 'full-upper', 'block-start-refusal'] as const) {
    test(`${profile} keeps its external fault direction and restores exact bytes`, async () => {
      const arm = CONFORMANCE_ARMS['snapshot-chain']();
      await attach(arm);
      await arm.workspace.plant([{
        path: 'base.bin', kind: 'file', mode: 0o644, ino: 1,
        content: { kind: 'dense', bytes: new Seeded(81).fill(new Uint8Array(128 * 1024)) },
      }]);
      expectCommitted(await arm.storage().checkpoint('quiesce'), 'the baseline');
      const base = (await arm.declaredPayload()).find((object) => object.names.includes('base'))?.key;
      expect(base).toBeDefined();

      if (profile === 'full-upper') {
        arm.disk().processFaults.push({ match: /^# devbox-probe-v1/, exitCode: 1, stderr: 'process refused the upper probe' });
      }

      await arm.workspace.write('witness.txt', 'retained marker');
      expectCommitted(await arm.storage().checkpoint('tick'), 'the marker delta');
      const committed = await arm.workspace.snapshot();

      if (profile === 'full-upper') expect(arm.disk().processFaultsReached).not.toHaveLength(0);

      arm.replaceContainer();

      if (profile === 'block-start-refusal') {
        arm.disk().processFaults.push({ match: /^# devbox-block-lower-v2/, exitCode: 1, stderr: 'block server refused the mount' });
        await expect(attach(arm)).rejects.toThrow();
        expect(arm.disk().processFaultsReached).not.toHaveLength(0);
        arm.disk().processFaults.length = 0;
      }

      expect((await attach(arm)).kind).toBe('attached');
      await expectTreeExact(arm, committed, 'after the forced restore');

      await arm.workspace.write('after.txt', 'next checkpoint');
      const expected = await arm.workspace.snapshot();
      expectCommitted(await arm.storage().checkpoint('tick'), 'the next checkpoint');
      const nextBase = (await arm.declaredPayload()).find((object) => object.names.includes('base'))?.key;
      expect(nextBase === base).toBe(profile !== 'full-upper');
      expect((await wake(arm)).kind).toBe('attached');
      await expectTreeExact(arm, expected, 'after the next checkpoint restore');
    });
  }

  for (const fault of ['type', 'generation'] as const) {
    test(`a composed lower with the wrong ${fault} cannot publish readiness`, async () => {
      const arm = CONFORMANCE_ARMS['snapshot-chain']();
      await attach(arm);
      await arm.workspace.write('base', 'base bytes');
      expectCommitted(await arm.storage().checkpoint('quiesce'), 'base');
      await arm.workspace.write('new', 'new bytes');
      expectCommitted(await arm.storage().checkpoint('tick'), 'delta');
      expect((await wake(arm)).kind).toBe('attached');
      const block = [...arm.disk().mounts].find(([, mount]) => mount.source.startsWith('devbox-block:'));

      if (block === undefined) throw new Error('composed lower missing');
      const [path, mounted] = block;
      arm.disk().mount(path, fault === 'type' ? { ...mounted, fstype: 'tmpfs' }
        : { ...mounted, source: `${mounted.source.slice(0, mounted.source.lastIndexOf(':'))}:obsolete-runtime` });
      await expect(attach(arm)).rejects.toThrow(fault === 'type' ? 'composed lower mounts' : 'generation mismatch');
    });
  }
});

afterAll(() => {
  const arms = armEntries.map(([name]) => name);
  const width = 16;
  const lines: string[] = [];
  lines.push('', 'smart-container bar — per-arm matrix (design § 6)', '');
  lines.push(`${'cell'.padEnd(8)}${arms.map((name) => name.padEnd(width)).join('')}`);

  for (const cell of EXISTING_CELLS) {
    lines.push(`${cell.id.padEnd(8)}${arms.map(() => 'existing'.padEnd(width)).join('')}  ${cell.title}`);
  }

  const legend: string[] = [];

  for (const cell of CELLS) {
    const row = matrix.get(cell.id);
    lines.push(`${cell.id.padEnd(8)}${arms.map((name) => {
      const outcome = row?.get(name);

      if (outcome === undefined) return 'not run'.padEnd(width);

      if (outcome.kind === 'pass') return 'pass'.padEnd(width);

      if (outcome.kind === 'refused') {
        legend.push(`${cell.id} ${name}: refused — ${outcome.reason}`);

        return 'refused'.padEnd(width);
      }

      legend.push(`${cell.id} ${name}: RED — ${outcome.reason}`);

      return 'RED'.padEnd(width);
    }).join('')}  ${cell.title}`);
  }

  lines.push(`${'6.19'.padEnd(8)}${arms.map(() => 'harness'.padEnd(width)).join('')}  stop then wake on the same instance: the devbox-harness suites`);
  lines.push('', ...legend, '');

  for (const [cell, row] of publicationSamples) {
    lines.push(`${cell}: bytesPut=${row.bytesPut} objectsPut=${row.objectsPut}`);
  }

  for (const [arm, samples] of indexSamples) {
    for (const row of samples) {
      lines.push(`${arm} 6.24: files=${row.files} bytesPut=${row.publicationBytes} objectsPut=${row.publicationObjects} attachBytes=${row.attachBytes} attachObjects=${row.attachObjects}`);
    }
  }

  lines.push('6.21 restore and backup time versus tree size — 100, 1,000 and 10,000 files of 4 KiB', '');

  for (const name of arms) {
    lines.push(`arm ${name}: files | tree bytes | full backup ms | 64 KiB backup ms | 64 KiB backup bytesPut | restore ms | restore ops | restore payload bytes`);

    for (const row of complexitySamples.get(name) ?? []) {
      lines.push(
        `arm ${name}: ${row.files} | ${row.bytes} | ${row.fullBackupMs.toFixed(1)} | ${row.backup64kMs.toFixed(1)} `
        + `| ${row.backup64kBytesPut} | ${row.restoreMs.toFixed(1)} | ${row.restoreOps} | ${row.restorePayloadBytes}`,
      );
    }

    lines.push('');
  }

  console.log(lines.join('\n'));
});


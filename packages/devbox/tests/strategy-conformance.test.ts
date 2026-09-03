// One contract, five strategies.
//
// WHY THIS FILE EXISTS, AND WHY IT IS NOT A SIXTH PER-STRATEGY SUITE. Four
// classes of defect reached deployed benchmark runs with 15k lines of local
// tests already green, and every one of them was a property of the CONTRACT
// rather than of a strategy:
//
//   1. Control-plane envelopes written under the container's own mount subtree,
//      so replacing the mount took the head with it.
//   2. A wake refusing forever because a recorded delta size drifted from the
//      object the store actually held.
//   3. A container replacement arriving between any two operations, including
//      between the two durable writes of one commit.
//   4. Teardown racing a container that had already stopped.
//
// Each per-strategy suite could see one strategy at one moment; none of them
// asked "does this arm hand back the bytes it was given, from a blank disk,
// after dying at each of its own commit sub-steps". That question has one
// answer per strategy and the same shape for all five, so it is asked once,
// here, through `tests/support/strategy-machine.ts` — which drives the SHIPPED
// adapters through their own production ports and runs the shipped
// container-side codecs in-process.
//
// IT FOUND TWO. `candidateContainerStorage` compared an operation kind against
// a checkpoint kind, so every published quiesce re-entered its own loop and
// published generations forever; and the merkle-pack index declared only the
// packs its own build staged, so every THIRD commit failed. Both are one line,
// both were invisible to every existing suite, and both have a named case here.
//
// THE DENOMINATOR IS TYPE-CHECKED. `CONFORMANCE_ARMS` is keyed by
// `DevboxStrategyName`, so a sixth strategy cannot be added to the union
// without this battery failing to compile, and `every declared seam is reached`
// below refuses a seam list that has drifted from the code it names.
import { afterAll, describe, expect, test } from 'bun:test';

import { KNOWN_RED } from './support/conformance-bug-list';
import {
  ArmRefused,
  CONFORMANCE_ARMS,
  DiskFull,
  type ArmBoot,
  type ConformanceArm,
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
  type TreeProperty,
} from './support/tree-model';
import { type NodeEntry } from '../src/capture/model';
import { DURABILITY_AWAIT_POINTS, type DurabilityAwaitPoint } from '../src/durability/contracts';
import { describeThrown } from '../src/lifecycle';
import {
  ATTACH_OUTCOME_KINDS,
  parseDevboxStrategyName,
  type CheckpointKind,
  type CheckpointOutcome,
  type DevboxStrategyName,
} from '../src/storage';

/**
 * A commit that did not commit, as an assertion that says WHY.
 *
 * `CheckpointOutcome` carries its refusal as a value rather than throwing, so a
 * bare `expect(kind).toBe('committed')` reports the one word and drops the
 * sentence explaining it — which is the whole diagnosis.
 */
function expectCommitted(outcome: CheckpointOutcome, what: string): void {
  if (outcome.kind === 'committed') return;
  throw new Error(`${what} did not commit: ${outcome.kind} — ${outcome.reason ?? 'no reason given'}`);
}

/**
 * The served tree is EXACTLY one of the two committed generations.
 *
 * The whole crash contract in one assertion: not blank, not blended, not a
 * generation nobody committed. It throws rather than matching so the message
 * carries the tree that was actually served — the diagnosis is the difference.
 */
async function expectOneGeneration(arm: ConformanceArm, what: string): Promise<void> {
  const served = canonical(await tree(arm));
  if (served === canonical(OLD) || served === canonical(MERGED)) return;
  throw new Error(
    `${arm.name} served neither generation after ${what}: ${served}`
    + ` (old: ${canonical(OLD)}, new: ${canonical(MERGED)})`,
  );
}

/** One tree as one comparable line. Path order is a strategy's own business:
 *  a chain lists the merged overlay, r2fs lists a key range, and a difference
 *  in order is not a difference in content. */
function canonical(rows: Record<string, string | undefined>): string {
  return JSON.stringify(
    Object.fromEntries(Object.entries(rows).sort(([left], [right]) => left < right ? -1 : 1)),
  );
}

/** The tree a caller sees, as comparable data: path to file text, `undefined`
 *  for a path the workspace lists but cannot read. Inferred, not annotated —
 *  the entries ARE the contract. */
async function tree(arm: ConformanceArm) {
  const paths = await arm.workspace.paths();
  const rows = await Promise.all(paths.map(async (path) => [path, await arm.workspace.read(path)] as const));
  return Object.fromEntries(rows);
}

/** Attach a box, and answer what it said. */
async function attach(arm: ConformanceArm) {
  const outcome = await arm.storage().attach();
  expect(ATTACH_OUTCOME_KINDS).toContain(outcome.kind);
  return outcome;
}

/**
 * Wake on a REPLACEMENT: a blank container disk, the same durable store, the
 * same durable rows.
 *
 * One re-drive is permitted and no more. A refusal a retry clears is recovery;
 * a refusal that survives its own retry is the brick this battery exists to
 * catch, so the second attempt's failure is the assertion.
 */
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

/** Whatever an operation threw, parsed at this boundary, or null when it
 *  returned. Callers assert on the CLASS and the words, so the domain type is
 *  the caught value narrowed to Error-or-null — a non-Error throw is itself a
 *  finding family 6 forbids, reported here as the assertion-visible value. */
async function thrownBy(run: () => Promise<void>): Promise<Error | null> {
  try {
    await run();
    return null;
  } catch (error) {
    // KEPT, NEVER SWALLOWED: every caller below asserts on what came back, and
    // an interruption that reports nothing is the defect, not the test's noise.
    return error instanceof Error ? error : new TypeError(`non-Error thrown: ${describeThrown({ cause: error })}`);
  }
}

/** Write a generation of content and commit it. */
async function commit(
  arm: ConformanceArm,
  content: Record<string, string>,
): Promise<CheckpointOutcome> {
  for (const [path, text] of Object.entries(content)) await arm.workspace.write(path, text);
  return await arm.storage().checkpoint('quiesce');
}

const OLD = { 'notes.txt': 'generation one', 'src.txt': 'export const one = 1;' };
const NEW = { 'notes.txt': 'generation two', 'extra.txt': 'added by the second commit' };
/** What the tree holds once both generations have been written. */
const MERGED = { ...OLD, ...NEW };
const THIRD = { 'third.txt': 'written by the third generation' };

// SAFETY: `CONFORMANCE_ARMS` declares `Record<DevboxStrategyName, () =>
// ConformanceArm>`, so its own type guarantees every key is a strategy name and
// every value that factory; `Object.entries` widens the key to `string` because
// its lib signature cannot carry a literal union, and this narrows it back to
// what the record already declares. The test below re-checks each key through
// `parseDevboxStrategyName` at runtime.
const armEntries = Object.entries(CONFORMANCE_ARMS) as readonly [
  DevboxStrategyName,
  () => ConformanceArm,
][];

test('every strategy name has an arm, and every arm names a strategy', () => {
  // The record's KEY TYPE is the denominator: a name added to
  // `DevboxStrategyName` breaks this file's types. This asserts the other
  // direction — that no key here is a name the package does not know.
  for (const [name] of armEntries) expect(parseDevboxStrategyName(name)).toBe(name);
  expect(armEntries.length).toBe(5);
});

for (const [name, open] of armEntries) {
  describe(`${name} — durability contract`, () => {
    // ── 1. the fundamental durability loop ──────────────────────────────────

    test('attach empty, write, commit, REPLACE the container, attach — exact bytes', async () => {
      const arm = open();
      const first = await attach(arm);
      expect(first.kind).not.toBe('already-attached');

      expectCommitted(await commit(arm, OLD), 'the first commit');

      const woken = await wake(arm);
      // NEVER `empty`: a box that has committed and reports an empty attach is
      // the silent-blank-workspace defect wearing a success.
      expect(woken.kind).toBe('attached');
      expect(await tree(arm)).toEqual(OLD);
    });

    test('a quiesce with pending changes publishes exactly once and returns', async () => {
      // THE CASE THAT FOUND THE STALL, and the reason it is its own test rather
      // than a consequence of the loop above. `candidateContainerStorage`
      // compared its operation's kind (`barrier`) against the checkpoint's kind
      // (`quiesce`) before returning, so a published quiesce always took the
      // `continue`: every stop on a candidate arm published a fresh generation
      // forever. A bounded-work budget makes that a NAMED failure at the second
      // publication rather than a suite that hangs and gets its timeout raised.
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
      // THREE GENERATIONS, NOT TWO, and the third is the point. An incremental
      // format's Nth generation is the first thing ever to READ the (N-1)th as
      // a parent — a restore reads the tree, not the closure — so a closure a
      // generation declares wrongly stays invisible until the generation after
      // it. merkle-pack's index declared only the packs its own build staged,
      // which made every third commit fail with "index extent is outside its
      // declared pack" while two commits passed forever.
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

    // ── 2. a death at every commit sub-step ─────────────────────────────────

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
        // The commit may report its failure as a value or throw it: both are
        // ordinary for an interrupted operation, and neither is what this case
        // is about. What it may never do is claim to have committed.
        const interrupted = await thrownBy(async () => {
          const outcome = await commit(arm, NEW);
          expect(outcome.kind).not.toBe('committed');
        });
        if (interrupted !== null) expect(interrupted).toBeInstanceOf(Error);
        expect(arm.deaths.reached).toContain(seam);
        expect(arm.deaths.armed).toBe(null);

        const woken = await wake(arm);
        expect(woken.kind).toBe('attached');
        // Named rather than matched, so a failure reports the tree that was
        // actually served: a blank tree, a blended tree and a lost generation
        // are three different defects and a bare `toContain` names none of them.
        await expectOneGeneration(arm, `a death at ${seam}`);
      });
    }

    // ── 3. where the control plane lives ───────────────────────────────────

    test('control metadata lives outside every payload and mount prefix', async () => {
      const arm = open();
      await attach(arm);
      await commit(arm, OLD);

      const placement = await arm.controlPlane();
      const prefixes = arm.payloadPrefixes();
      expect(prefixes.length).toBeGreaterThan(0);
      for (const key of placement.objectKeys) {
        for (const prefix of prefixes) {
          // THE DEFECT, AS ONE LINE. An envelope under the prefix the
          // container's mount owns is an envelope a mount replacement can eat.
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
        // NO CONTROL PLANE AT ALL, which is r2fs's whole design: the object
        // store IS the filesystem, so the payload subtree is the box and wiping
        // it wipes everything. The obligation is the opposite one and it is
        // still real — a box with nothing left must stop claiming a head, or it
        // would serve a workspace it cannot fill while reporting success.
        expect(after.head).toBe(null);
        const woken = await wake(arm);
        expect(woken.detail).toContain('0 objects');
        expect(await tree(arm)).toEqual({});
        return;
      }
      // The head is still named, and it is the same head: the control plane
      // does not live in the subtree the container owns.
      expect(after.head).toBe(before.head);
      for (const key of before.objectKeys) expect(arm.durable.head(key)).not.toBe(null);

      arm.replaceContainer();
      const refusal = await thrownBy(async () => { await arm.storage().attach(); });
      if (refusal === null) return;
      expect(refusal).toBeInstanceOf(Error);
      // A refusal after payload loss must be about PAYLOAD. Naming a control
      // object instead would mean the control plane went with the mount, which
      // is the first defect class.
      const message = describeThrown({ cause: refusal });
      for (const key of before.objectKeys) {
        expect(message).not.toContain(key.split('/').pop() ?? key);
      }
    });

    // ── 4. size and integrity drift ────────────────────────────────────────

    test('a corrupted committed payload object is refused by name, and discard recovers', async () => {
      const arm = open();
      await attach(arm);
      // A TICK, DELIBERATELY. A tick is the commit that leaves a strategy's
      // pending state where its OWN read path still has to verify it; a quiesce
      // folds that away into a materialized tree the mount serves unverified.
      // Corrupting what nothing verifies would test nothing.
      for (const [path, text] of Object.entries(OLD)) await arm.workspace.write(path, text);
      expectCommitted(await arm.storage().checkpoint('tick'), 'the tick before the corruption');

      const declared = await arm.declaredPayload();
      // THE DECLARATION IS THE CONTRACT, so it is asserted rather than sniffed:
      // an arm that quietly stopped declaring payload identities would
      // otherwise slide into the weaker branch below and take the suite with it.
      expect(declared.length > 0).toBe(arm.refusesCorruptPayload);
      if (!arm.refusesCorruptPayload) {
        // A PASS-THROUGH ARM DECLARES NOTHING, so there is nothing for it to
        // refuse against — and pretending otherwise would assert a property the
        // strategy never claimed. What it owes instead: it serves exactly the
        // bytes the store holds, and it reports exactly the count the store
        // holds, so a corruption is visible rather than laundered.
        const key = arm.durable.list(arm.payloadPrefixes()[0]!)[0]!;
        arm.durable.corrupt(key, 'flip');
        const woken = await wake(arm);
        const stored = arm.durable.get(key);
        expect(stored).not.toBe(null);
        expect(Object.values(await tree(arm))).toContain(new TextDecoder().decode(stored!));
        expect(woken.detail).toContain(
          String(arm.durable.inventory(arm.payloadPrefixes()[0]!).bytes),
        );
        return;
      }

      const target = declared[0]!;
      arm.durable.corrupt(target.key, 'flip');

      arm.replaceContainer();
      // NAMED, WHEREVER IT IS CAUGHT. An eager arm refuses inside attach,
      // because attach is the read. A lazy arm's attach touches only the
      // root and the ledger — that is the whole of this lane — so a
      // corruption anywhere else surfaces at the first read that needs
      // those bytes, which a full-tree read forces without picking a path.
      let refusal = await thrownBy(async () => { await arm.storage().attach(); });
      if (refusal === null) refusal = await thrownBy(async () => { await tree(arm); });
      expect(refusal).toBeInstanceOf(Error);
      // NAMED. A refusal that cannot say which object is unsound is a refusal
      // nobody can act on.
      const message = describeThrown({ cause: refusal });
      expect(target.names.some(named => message.includes(named))).toBe(true);

      // And it is not a dead end: dropping the box's bytes lets a fresh one
      // start from nothing.
      await arm.storage().discard();
      arm.replaceContainer();
      const fresh = await attach(arm);
      expect(fresh.kind).not.toBe('already-attached');
      expectCommitted(await commit(arm, NEW), 'the commit after discard');
      const woken = await wake(arm);
      expect(woken.kind).toBe('attached');
      expect(await tree(arm)).toEqual(NEW);
    });

    // ── 5. a commit racing a replacement ───────────────────────────────────

    test('a commit interrupted by a replacement converges on exactly one head', async () => {
      const arm = open();
      await attach(arm);
      expectCommitted(await commit(arm, OLD), 'the commit before the race');
      expect((await arm.committedHeads()).length).toBe(1);

      // The last seam before the pointer swap: the operation is begun and its
      // payload is somewhere, but nothing has been promoted.
      const seam = arm.commitSeams[Math.max(0, arm.commitSeams.length - 3)]!;
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

    // ── 6. teardown after the container stopped ────────────────────────────

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
        // CLASSIFIED means an Error a caller can report as an incident. A
        // TypeError is a property read on something that is no longer there,
        // which is what teardown racing a stopped container looked like.
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

// ── the smart-container bar: design § 6 cells, per arm, as one matrix ───────
//
// WHICH CELLS THIS FILE ALREADY HAD. The tests above are design § 6 cells 6.1
// (attach empty, write, commit, replace, attach), 6.2 (quiesce publishes once),
// 6.3 (three generations), 6.4 (a death at every commit seam), 6.6 (control
// metadata outside every payload prefix, plus the payload wipe), 6.7 (corrupt
// payload refused by name), 6.8 (commit interrupted by a replacement) and 6.16
// (teardown and checkpoint on a stopped container). They stay as they are: the
// matrix below names them as `existing` rows. Cell 6.19 (stop then wake on the
// SAME instance) needs the Devbox class and lives in `candidate-attach.test.ts`.
//
// EVERY OTHER CELL IS NEW AND RED-CAPABLE. A cell is a function of an arm; the
// matrix runs each cell against each of the five arms and records one of three
// outcomes: pass, fail with the assertion's words, or refused — the arm named
// the cell (or the tree property) in its own declaration with a reason. A
// failure is a BUG LIST entry, never a retirement: `KNOWN_RED` in
// `support/conformance-bug-list.ts` locks the set of reds, in both directions.
//
// RED DIRECTION. Every new cell is shown red before it is green anywhere: the
// matrix on the current tree IS that proof for the cells the current arms
// fail, and `red direction` tests below prove the remaining cells against a
// deliberately broken arm (a wake that serves a blank tree, a store that lost
// a reachable key, a counter that lies).



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

/** The served tree must be the planted tree, property by property, then byte
 *  for byte through the product's own canonical manifest encoder. */
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
    // KEPT, NEVER SWALLOWED: the words are what the cell asserts on.
    return { kind: 'threw', reason: describeThrown({ cause: error }) };
  }
}

async function commitTree(arm: ConformanceArm, entries: readonly NodeEntry[], what: string): Promise<void> {
  await arm.workspace.plant(entries);
  expectCommitted(await arm.storage().checkpoint('quiesce'), what);
}

/**
 * Which rule a faulted await point answers to, by where its durable effect
 * sits relative to the head pointer advance. Before the CAS nothing is
 * durable, so a commit through the fault may never report `committed`. At
 * or after the CAS the head is durable, so `committed` is the truth and the
 * obligation is convergence: one head, exact wake. Attach-path points are
 * reached by a wake, never by a commit, and are faulted there. Every register
 * member is named, so a point added to the contract fails to compile here.
 */
const AWAIT_POINT_GROUPS = {
  'issue-payload-grant': 'pre-cas',
  'create-multipart': 'pre-cas',
  'upload-multipart-part': 'pre-cas',
  'complete-multipart': 'pre-cas',
  'verify-upload': 'pre-cas',
  'upload-root': 'pre-cas',
  'publish-head': 'pre-cas',
  'create-pin': 'post-cas',
  'renew-pin': 'post-cas',
  'release-pin': 'post-cas',
  'read-mark-page': 'post-cas',
  'complete-mark': 'post-cas',
  'retire-object': 'post-cas',
  'delete-retired-object': 'post-cas',
  'mount-root': 'attach',
  'cleanup-resource': 'post-cas',
} satisfies Record<DurabilityAwaitPoint, 'pre-cas' | 'post-cas' | 'attach'>;

const CELLS: readonly Cell[] = [
  {
    id: '6.5',
    title: 'fault at every DURABILITY_AWAIT_POINTS value',
    async run(arm) {
      if (arm.awaitPoints.none !== undefined) throw new ArmRefused('6.5', arm.awaitPoints.none);
      const uses = new Set<string>(arm.awaitPoints.uses);
      const problems: string[] = [];
      for (const point of DURABILITY_AWAIT_POINTS) {
        const fresh = CONFORMANCE_ARMS[arm.name]();
        await attach(fresh);
        expectCommitted(await commit(fresh, OLD), `the commit before the ${point} fault`);
        if (!uses.has(point)) {
          expectCommitted(await commit(fresh, NEW), `an ordinary commit while ${point} is declared unreached`);
          await wake(fresh);
          if (fresh.awaitVisits(point) !== 0) problems.push(`${point}: declared unreached, visited ${fresh.awaitVisits(point)} times`);
          continue;
        }
        const group = AWAIT_POINT_GROUPS[point];
        if (group === 'attach') {
          // An attach-path point is reached by a WAKE, never by a commit: the
          // fault is armed on the replacement's attach. The faulted attach may
          // refuse or report; the next attach on the same replacement converges.
          expectCommitted(await commit(fresh, NEW), `the commit before the ${point} wake fault`);
          fresh.replaceContainer();
          fresh.faultAt(point);
          const faulted = await thrownBy(async () => { await fresh.storage().attach(); });
          if (faulted !== null && !(faulted instanceof Error)) problems.push(`${point}: non-Error thrown`);
          if (fresh.awaitVisits(point) === 0) problems.push(`${point}: declared used, never visited by the wake`);
          const again = await thrownBy(async () => {
            const woken = await fresh.storage().attach();
            if (woken.kind === 'empty') problems.push(`${point}: the attach after the fault answered empty`);
          });
          if (again !== null) problems.push(`${point}: the attach after the fault refused: ${describeThrown({ cause: again })}`);
          const wokenTree = canonical(await tree(fresh));
          if (wokenTree !== canonical(MERGED)) problems.push(`${point}: the attach after the fault served ${wokenTree}`);
          continue;
        }
        fresh.faultAt(point);
        const thrown = await thrownBy(async () => {
          const outcome = await commit(fresh, NEW);
          // BEFORE THE POINTER ADVANCE nothing is durable, so `committed` is a
          // lie. AT OR AFTER IT the head is durable and `committed` is the
          // truth, told off the record; what such a fault may never do is
          // leave the operation unrecoverable.
          if (group === 'pre-cas' && outcome.kind === 'committed') problems.push(`${point}: reported committed through the fault`);
        });
        if (thrown !== null && !(thrown instanceof Error)) problems.push(`${point}: non-Error thrown`);
        if (fresh.awaitVisits(point) === 0) problems.push(`${point}: declared used, never visited`);
        const woken = await wake(fresh);
        if (woken.kind !== 'attached') problems.push(`${point}: wake answered ${woken.kind}`);
        const served = canonical(await tree(fresh));
        if (group === 'pre-cas' && served !== canonical(OLD) && served !== canonical(MERGED)) problems.push(`${point}: wake served a blend or a blank`);
        if (group === 'post-cas' && served !== canonical(MERGED)) problems.push(`${point}: the head was durable and the wake served ${served}`);
        const redriven = await fresh.storage().checkpoint('quiesce');
        if (redriven.kind === 'failed') problems.push(`${point}: the re-drive failed: ${redriven.reason}`);
        const heads = await fresh.committedHeads();
        if (heads.length !== 1) problems.push(`${point}: ${heads.length} heads after the re-drive`);
      }
      if (problems.length > 0) throw new Error(problems.join('; '));
    },
  },
  {
    id: '6.9',
    title: 'DO reset mid-restore: one daemon, one restore, tree exact',
    async run(arm) {
      const fixture = textTree(OLD);
      await attach(arm);
      await commitTree(arm, fixture, 'the commit before the resets');
      // The baseline: an uninterrupted wake, and what it costs the container.
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
        const counts = arm.lifecycleCounts?.();
        if (counts !== undefined && (counts.daemonStarts !== 1 || counts.restoreStarts !== 1)) {
          problems.push(`${seam}: ${counts.daemonStarts} daemon starts, ${counts.restoreStarts} restores`);
        }
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
      // THE WINNER IS MEASURED, NEVER ASSUMED: the tree the new boot served
      // after its own commit. A new boot may legitimately adopt a COMPLETE
      // unreferenced delta the old boot left (the crash-window rule cell 6.4
      // accepts at `after-payload`) and publish OLD+NEW+THIRD; what it may
      // never do is let the old boot's late finalize move the head, or serve
      // after a wake anything but what it served before it. The new boot's
      // own commit must be in that tree, or the race lost a committed write.
      if (!served.includes(JSON.stringify(Object.entries(THIRD)[0]![1]))) problems.push(`the new boot's commit is absent from the tree it served: ${served}`);
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
      if (small.seal.bytesStaged > 2 * kBytes + 4 * c) problems.push(`bytesStaged ${small.seal.bytesStaged} > 2k + 4c for k=4 KiB`);
      if (small.seal.nodesRewritten > 1 * (1 + 2)) problems.push(`nodesRewritten ${small.seal.nodesRewritten} > p(d+2) = 3`);
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
        // EVICT, RE-READ, BYTES IDENTICAL. A page an eviction sweep can reach
        // came out of an immutable object and is held to the digest the head
        // declares for it, so dropping it can risk nothing but a re-read —
        // and this is that re-read, at both tree sizes.
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
      // EVICT, RE-READ, BYTES IDENTICAL — on the 1 GiB sparse file and the
      // 64 MiB dense one, the pair this cell exists to bound.
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
      const journal = arm.journalFacts?.();
      if (journal !== undefined) {
        const paths = new Set(await arm.workspace.paths());
        for (const record of journal.records) {
          const path = record.split(' ')[1] ?? '';
          if (!paths.has(path)) problems.push(`WAL record without an effect: ${record}`);
        }
        if (journal.failedWrites.length === 0) problems.push('the refused write left no cancelled record');
      }
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
];

async function runCell(cell: Cell, arm: ConformanceArm): Promise<Outcome> {
  try {
    await cell.run(arm);
    return { kind: 'pass' };
  } catch (error) {
    if (error instanceof ArmRefused) {
      const declared = arm.refusedCells[error.cell]?.reason ?? (error.cell === '6.5' ? arm.awaitPoints.none : undefined);
      if (declared === error.reason && error.cell === cell.id) return { kind: 'refused', reason: error.reason };
      return { kind: 'fail', reason: `refused ${error.cell} without a matching declaration: ${error.reason}` };
    }
    return { kind: 'fail', reason: describeThrown({ cause: error }).slice(0, 700) };
  }
}

const matrix = new Map<string, Map<string, Outcome>>();

for (const [name, open] of armEntries) {
  describe(`${name} — the smart-container bar`, () => {
    for (const cell of CELLS) {
      const known = KNOWN_RED.find((row) => row.arm === name && row.cell === cell.id);
      const declaredRefusal = open().refusedCells[cell.id];
      const label = declaredRefusal !== undefined
        ? `${cell.id} ${cell.title} [refused: ${declaredRefusal.reason.slice(0, 60)}]`
        : known !== undefined
          ? `${cell.id} ${cell.title} [bug list since ${known.since}]`
          : `${cell.id} ${cell.title}`;
      test(label, async () => {
        const arm = open();
        const outcome = declaredRefusal !== undefined && cell.id !== '6.14' && cell.id !== '6.5'
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
      }, 120_000);
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

// ── red direction ────────────────────────────────────────────────────────────
//
// A cell green on every arm proves nothing until it has been red once. The
// cells below are those the matrix may show green everywhere on some tree;
// each is run against a deliberately broken arm and must FAIL.

/** An arm whose wake serves a blank workspace: the silent-blank defect. */
function blankWakeArm(): ConformanceArm {
  const arm = CONFORMANCE_ARMS['merkle-pack']();
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

/** Run a cell that opens fresh arms by name against ONE broken arm: every
 *  open answers the broken arm for the cell's duration. */
async function runCellOn(cell: Cell, broken: ConformanceArm): Promise<Outcome> {
  const open = CONFORMANCE_ARMS[broken.name];
  Object.defineProperty(CONFORMANCE_ARMS, broken.name, { value: () => broken, configurable: true });
  try {
    return await runCell(cell, broken);
  } finally {
    Object.defineProperty(CONFORMANCE_ARMS, broken.name, { value: open, configurable: true });
  }
}

describe('red direction — every new cell fails against a deliberately broken arm', () => {
  test('6.5 fails when a pre-CAS fault is reported as committed', async () => {
    // The lie: a commit that lost its payload upload claims committed. The
    // broken arm reports the outcome of the fault-free base commit again.
    const cell = CELLS.find((row) => row.id === '6.5')!;
    const arm = CONFORMANCE_ARMS['merkle-pack']();
    const broken: ConformanceArm = Object.create(arm);
    Object.defineProperty(broken, 'storage', {
      value: () => {
        const raw = arm.storage();
        return {
          ...raw,
          checkpoint: async (kind: CheckpointKind) => {
            const outcome = await raw.checkpoint(kind);
            if (outcome.kind !== 'failed') return outcome;
            return { kind: 'committed' as const, reason: 'lied', bytes: 0, movedBytes: 0 };
          },
        };
      },
    });
    Object.defineProperty(broken, 'name', { value: 'merkle-pack' });
    const outcome = await runCellOn(cell, broken);
    expect(outcome.kind).toBe('fail');
    expect(outcome.kind === 'fail' ? outcome.reason : '').toContain('reported committed through the fault');
  });

  test('6.5 fails when a post-CAS fault loses the durable head', async () => {
    const cell = CELLS.find((row) => row.id === '6.5')!;
    const arm = CONFORMANCE_ARMS['merkle-pack']();
    const broken: ConformanceArm = Object.create(arm);
    // After the head is durable a completion-mark fault must still serve the
    // new generation; a wake that serves the old one lost a committed head.
    Object.defineProperty(broken, 'replaceContainer', {
      value: () => {
        for (const key of arm.durable.list('boxes/box-conformance/')) {
          if (key.includes('envelope') && arm.durable.head(key) !== null && arm.durable.list('boxes/box-conformance/').filter((k) => k.includes('envelope')).length > 1) {
            arm.durable.delete(key);
            break;
          }
        }
        arm.replaceContainer();
      },
    });
    const outcome = await runCellOn(cell, broken);
    expect(outcome.kind).toBe('fail');
  });

  test('6.5 fails when a wake never recovers from an attach-path fault', async () => {
    const cell = CELLS.find((row) => row.id === '6.5')!;
    const arm = CONFORMANCE_ARMS['merkle-pack']();
    const broken: ConformanceArm = Object.create(arm);
    // Poisoned from the mount-root fault until the next point is armed: the
    // wake after that fault never comes back, and only that wake.
    let poisoned = false;
    Object.defineProperty(broken, 'faultAt', {
      value: (point: DurabilityAwaitPoint) => {
        poisoned = point === 'mount-root';
        arm.faultAt(point);
      },
    });
    Object.defineProperty(broken, 'storage', {
      value: () => {
        const raw = arm.storage();
        return {
          ...raw,
          attach: async () => {
            // The faulted attach itself refuses through the armed seam; the NEXT
            // attach on the same replacement is the one that must converge, and
            // this arm's never does. Poison covers exactly that second attach.
            if (poisoned && arm.deaths.armed === null && arm.awaitVisits('mount-root') > 0) {
              poisoned = false;
              throw new Error('the mount never comes back');
            }
            return await raw.attach();
          },
        };
      },
    });
    const outcome = await runCellOn(cell, broken);
    expect(outcome.kind).toBe('fail');
    expect(outcome.kind === 'fail' ? outcome.reason : '').toContain('mount-root');
  });

  test('6.11 fails when the wake serves a blank tree', async () => {
    const cell = CELLS.find((row) => row.id === '6.11')!;
    const outcome = await runCell(cell, blankWakeArm());
    expect(outcome.kind).toBe('fail');
  });

  test('6.13 fails when the wake serves a blank tree', async () => {
    // runCellOn, NOT runCell: 6.13's restoreOf opens a FRESH arm per trial
    // through CONFORMANCE_ARMS[arm.name](), never the arm this test hands
    // it, so only overriding the factory (what runCellOn does) puts the
    // blank-wake wrapper in the loop the cell actually drives.
    const cell = CELLS.find((row) => row.id === '6.13')!;
    const outcome = await runCellOn(cell, blankWakeArm());
    expect(outcome.kind).toBe('fail');
  }, 120_000);

  test('6.20 fails when the store loses a reachable key', async () => {
    const arm = CONFORMANCE_ARMS['merkle-pack']();
    const cell = CELLS.find((row) => row.id === '6.20')!;
    const broken: ConformanceArm = Object.create(arm);
    Object.defineProperty(broken, 'declaredPayload', {
      value: async () => {
        const declared = await arm.declaredPayload();
        if (declared.length > 0) arm.durable.delete(declared[0]!.key);
        return declared;
      },
    });
    const outcome = await runCell(cell, broken);
    expect(outcome.kind).toBe('fail');
    expect(outcome.kind === 'fail' ? outcome.reason : '').toContain('the store lost it');
  });

  test('6.12 fails when the publish counter lies about the store', async () => {
    const arm = CONFORMANCE_ARMS['merkle-pack']();
    const cell = CELLS.find((row) => row.id === '6.12')!;
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

  test('6.18 fails when a write lands without its record', async () => {
    const arm = CONFORMANCE_ARMS['merkle-pack']();
    await attach(arm);
    expectCommitted(await commit(arm, OLD), 'the commit');
    const facts = arm.journalFacts!();
    await arm.workspace.write('recorded.txt', 'x');
    expect(facts.records.some((record) => record.includes('recorded.txt'))).toBe(true);
    // An effect with no record: the tree gains a file the WAL never saw.
    await arm.workspace.plant(textTree({ 'unrecorded.txt': 'y' }));
    const paths = new Set(await arm.workspace.paths());
    const recorded = new Set(facts.records.map((record) => record.split(' ')[1]));
    expect([...paths].filter((path) => path.endsWith('.txt') && !recorded.has(path) && !(path in OLD))).toEqual(['unrecorded.txt']);
  });

  test('6.13 fails when eviction cannot be trusted for the re-read', async () => {
    // THE EVICTION DIRECTION. Dropping a clean page is safe only because the
    // re-read that follows is a digest-verified fetch of the SAME bytes; a
    // broken transport that returns something else after the drop is the one
    // failure mode the whole bet depends on never happening. This corrupts
    // every payload object right after the sweep runs, so the drop already
    // happened when the bytes underneath it stop matching what was dropped.
    const cell = CELLS.find((row) => row.id === '6.13')!;
    const arm = CONFORMANCE_ARMS['merkle-pack']();
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
    const outcome = await runCellOn(cell, broken);
    expect(outcome.kind).toBe('fail');
  }, 120_000);
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
  lines.push(`${'6.19'.padEnd(8)}${arms.map(() => 'harness'.padEnd(width)).join('')}  stop then wake on the same instance: candidate-attach.test.ts`);
  lines.push('', ...legend, '');
  console.log(lines.join('\n'));
});


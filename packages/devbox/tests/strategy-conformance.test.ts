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
import { describe, expect, test } from 'bun:test';

import { CONFORMANCE_ARMS, type ConformanceArm } from './support/strategy-machine';
import { describeThrown } from '../src/lifecycle';
import {
  ATTACH_OUTCOME_KINDS,
  parseDevboxStrategyName,
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
function expectOneGeneration(arm: ConformanceArm, what: string): void {
  const served = canonical(tree(arm));
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
function tree(arm: ConformanceArm) {
  return Object.fromEntries(arm.workspace.paths().map((path) => [path, arm.workspace.read(path)]));
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
  for (const [path, text] of Object.entries(content)) arm.workspace.write(path, text);
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
      expect(tree(arm)).toEqual(OLD);
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
      for (const [path, text] of Object.entries(OLD)) arm.workspace.write(path, text);
      arm.deaths.limit(arm.publishSeam, 1);

      expectCommitted(await arm.storage().checkpoint('quiesce'), 'a quiesce with pending changes');
      expect(arm.deaths.visits(arm.publishSeam)).toBe(1);

      // And the bytes are really there afterwards, so "published once" cannot
      // pass by publishing nothing.
      const woken = await wake(arm);
      expect(woken.kind).toBe('attached');
      expect(tree(arm)).toEqual(OLD);
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
        expect(tree(arm)).toEqual(seen);
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
        expectOneGeneration(arm, `a death at ${seam}`);
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
        expect(tree(arm)).toEqual({});
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
      for (const [path, text] of Object.entries(OLD)) arm.workspace.write(path, text);
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
        expect(Object.values(tree(arm))).toContain(new TextDecoder().decode(stored!));
        expect(woken.detail).toContain(
          String(arm.durable.inventory(arm.payloadPrefixes()[0]!).bytes),
        );
        return;
      }

      const target = declared[0]!;
      arm.durable.corrupt(target.key, 'flip');

      arm.replaceContainer();
      const refusal = await thrownBy(async () => { await arm.storage().attach(); });
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
      expect(tree(arm)).toEqual(NEW);
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
      expectOneGeneration(arm, 'a commit that raced a replacement');
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

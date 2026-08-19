// The two merge-back guards, PROVEN by deleting them.
//
// Both defend a SILENT failure, and a test that would still pass with the check gone is
// not defending anything. So each check here is removed mechanically and the suite
// asserts that behaviour changes — the difference between a guard and a comment.
//
// WHY A MUTANT COPY AND NOT THE REAL FILE. Editing `src/strategy/merge-back.ts` in place
// would open a window in which any other test file loading that module gets the mutant,
// and a crash mid-run would leave the source deleted-check. Each mutation is therefore
// written to its own throwaway module beside this file, imported once, and removed. The
// real source is never touched, so there is no window and nothing to restore.
//
// EVERY MUTATION ASSERTS IT LANDED. `mutate` requires each snippet to occur EXACTLY once
// and throws otherwise, because a mutation test whose edit silently missed is a test
// that proves the guard is load-bearing by never removing it. That check is the reason
// this file can be believed.
//
// Specified by docs/EXPLORATION.md — "Merge-back", including *Dependency order*.
import { afterAll, describe, expect, test } from 'bun:test';
import { rmSync, writeFileSync } from 'node:fs';
import { MAX_TX_BLOB_BYTES } from '@nimbus-sh/core/constants.js';
import { createRecordingLogger } from '../src/obs/index';
import * as pristine from '../src/strategy/merge-back';
import type {
  MemberApply, MemberFileChange, MergeMember, MergePolicy, MergeBackReport,
} from '../src/strategy/merge-back';

type MergeBackModule = typeof pristine;

const SOURCE = new URL('../src/strategy/merge-back.ts', import.meta.url).pathname;
const written: string[] = [];

afterAll(() => {
  for (const path of written) rmSync(path, { force: true });
});

/**
 * A copy of merge-back with `edits` applied, loaded as its own module.
 *
 * Lands beside this file so the source's own relative imports resolve after one
 * mechanical rewrite of their depth, and under a name the test glob cannot match so the
 * runner never treats a mutant as a suite.
 */
async function mutate(
  label: string, edits: readonly (readonly [find: string, replace: string])[],
): Promise<MergeBackModule> {
  let source = await Bun.file(SOURCE).text();
  for (const [find, replace] of edits) {
    const occurrences = source.split(find).length - 1;
    if (occurrences !== 1) {
      throw new Error(
        `mutation "${label}" expected exactly one occurrence of ${JSON.stringify(find)} in `
        + `merge-back.ts and found ${String(occurrences)}. The snippet has moved, so this `
        + 'mutation would have proven nothing — update the snippet rather than the assertion.',
      );
    }
    source = source.replace(find, replace);
  }
  // The mutant sits one directory shallower than the original, so `../x` becomes
  // `../src/x` and a sibling `./x` becomes `../src/strategy/x`. Bare specifiers are
  // untouched. A wrong rewrite throws at import rather than passing quietly.
  const rewritten = source
    .replaceAll("from '../", "from '../src/")
    .replaceAll("from './", "from '../src/strategy/");
  const path = new URL(`./merge-back.mutant-${label}.ts`, import.meta.url).pathname;
  writeFileSync(path, rewritten);
  written.push(path);
  // SAFETY: the mutant is `merge-back.ts`'s own text with `edits` applied, and every edit
  // is required above to have matched exactly once — so its export shape is the pristine
  // module's by construction. A dynamic specifier carries no static type, and a wrong
  // rewrite of the import depths throws here rather than producing a wrong shape.
  return await (import(path) as Promise<MergeBackModule>);
}

/* ── Fixtures, shared with the behavioural suite's shape ──────────────────── */

interface Origin {
  readonly at: Map<string, string>;
  readonly readOrigin: (path: string) => Promise<string | null>;
  readonly transactions: (readonly MemberFileChange[])[];
}

/**
 * An origin whose write TEARS above the bound, the way the substrate does.
 *
 * `writeBatch` is one `transactionSync` and refuses to split; the hosted
 * `writeBatchStream` is *"committed-prefix"* and publishes the waves that fit before
 * failing. This models the second, because that is the failure the pre-flight exists to
 * prevent: over the bound, the files that fit LAND and the rest do not, leaving a
 * workspace that is neither the old state nor the new one.
 */
function tearingOrigin(initial: Record<string, string> = {}): Origin & { applyMember: MemberApply } {
  const at = new Map(Object.entries(initial));
  const transactions: (readonly MemberFileChange[])[] = [];
  return {
    at,
    transactions,
    readOrigin: async (path) => at.get(path) ?? null,
    applyMember: async (files) => {
      transactions.push(files);
      let spent = 0;
      for (const file of files) {
        const bytes = file.after === null ? 0 : new TextEncoder().encode(file.after).length;
        if (spent + bytes > MAX_TX_BLOB_BYTES) {
          throw new Error(
            `E2BIG: transaction exceeded ${String(MAX_TX_BLOB_BYTES)} bytes after committing `
            + `${String(transactions.length)} wave(s)`,
          );
        }
        spent += bytes;
        if (file.after === null) at.delete(file.path);
        else at.set(file.path, file.after);
      }
    },
  };
}

async function memberOf(
  origin: Origin,
  nodeId: string,
  files: readonly MemberFileChange[],
  module: MergeBackModule = pristine,
  deps: readonly string[] = [],
): Promise<MergeMember> {
  const diff = {
    nodeId,
    files: [...files].sort((a, b) => a.path.localeCompare(b.path)),
    provenance: 'private-home' as const,
  };
  return {
    nodeId,
    diff,
    verdict: {
      memberDigest: module.memberDigestOf(diff),
      baseDigest: await module.baseDigestOf(diff, origin.readOrigin),
      clean: true,
    },
    scope: null,
    deps,
    score: 1,
  };
}

function runWith(
  module: MergeBackModule,
  origin: Origin & { applyMember: MemberApply },
  policy: MergePolicy,
  members: readonly MergeMember[],
): Promise<MergeBackReport> {
  return module.mergeBack({ policy, members }, {
    log: createRecordingLogger(),
    preset: 'mutation',
    readOrigin: origin.readOrigin,
    applyMember: origin.applyMember,
  });
}

/* ── Red-proof 1: the size refusal ────────────────────────────────────────── */

// Two files, each comfortably inside the bound on its own and jointly over it. That is
// the shape a committed prefix needs: the first lands, the second cannot.
function oversizedPair(): readonly MemberFileChange[] {
  const half = 'x'.repeat(Math.floor(MAX_TX_BLOB_BYTES * 0.75));
  return [
    { path: 'first.bin', base: null, after: half },
    { path: 'second.bin', base: null, after: half },
  ];
}

describe('the size refusal is load-bearing', () => {
  test('GREEN: with the pre-flight, an oversized member is refused and nothing is written', async () => {
    const origin = tearingOrigin({});
    const member = await memberOf(origin, 'n1', oversizedPair());

    const report = await runWith(pristine, origin, 'apply-winner', [member]);

    const [outcome] = report.outcomes;
    if (outcome?.kind !== 'refused') throw new Error('expected a refusal');
    expect(outcome.refusal.cause).toBe('oversized');
    expect(outcome.refusal.error).toContain('blobBytes');
    // The substrate was never reached, so there was nothing to tear.
    expect(origin.transactions).toHaveLength(0);
    expect(origin.at.size).toBe(0);
  });

  test('RED: delete the pre-flight and the same member TEARS the origin', async () => {
    const mutant = await mutate('no-size-check', [[
      'const exceeded = memberApplyBound(plan);',
      'const exceeded = null;',
    ]]);
    const origin = tearingOrigin({});
    const member = await memberOf(origin, 'n1', oversizedPair(), mutant);

    const report = await runWith(mutant, origin, 'apply-winner', [member]);

    // The apply was attempted, which is the whole difference.
    expect(origin.transactions).toHaveLength(1);
    // AND THE WORKSPACE IS TORN: a strict subset of the member's files landed. Not the
    // old state, not the new one — the outcome "one host transaction per member" exists
    // to make impossible.
    expect(origin.at.has('first.bin')).toBe(true);
    expect(origin.at.has('second.bin')).toBe(false);
    // It is reported as a substrate failure, which is a refusal AFTER the damage rather
    // than instead of it. A caller reading only the outcome kind cannot tell the two
    // apart, which is exactly why the pre-flight and not the error path is the guard.
    expect(report.outcomes[0]?.kind).toBe('refused');
  });

  test('RED: the mutant no longer names the bound, so a caller cannot act on it', async () => {
    const mutant = await mutate('no-size-check-message', [[
      'const exceeded = memberApplyBound(plan);',
      'const exceeded = null;',
    ]]);
    const origin = tearingOrigin({});
    const member = await memberOf(origin, 'n1', oversizedPair(), mutant);

    const report = await runWith(mutant, origin, 'apply-winner', [member]);

    const [outcome] = report.outcomes;
    if (outcome?.kind !== 'refused') throw new Error('expected a refusal');
    expect(outcome.refusal.cause).not.toBe('oversized');
    expect(outcome.refusal.error).not.toContain('blobBytes');
  });
});

/* ── Red-proof 2: the (memberDigest, baseDigest) comparison ───────────────── */

const STALE_COMPARISON = 'if (member.verdict.baseDigest !== baseDigest) {';

/** A settle where member two's base is moved by member one landing first — the rebase,
 *  and the only situation in which a verdict can go stale without anyone editing a
 *  diff. Same content on the shared path, so this is agreement and not a conflict. */
async function rebasePair(origin: Origin, module: MergeBackModule) {
  return [
    await memberOf(origin, 'n1', [{ path: 'shared.ts', base: 'V0\n', after: 'V1\n' }], module),
    await memberOf(origin, 'n2', [{ path: 'shared.ts', base: 'V0\n', after: 'V1\n' }], module),
  ];
}

describe('the stale-verdict refusal is load-bearing', () => {
  test('GREEN: a rebased member with a moved base is refused', async () => {
    const origin = tearingOrigin({ 'shared.ts': 'V0\n' });
    const members = await rebasePair(origin, pristine);

    const report = await runWith(pristine, origin, 'sequential-rebase', members);

    expect(report.stoppedAt).toBe('n2');
    const [, outcome] = report.outcomes;
    if (outcome?.kind !== 'refused') throw new Error('expected a refusal');
    expect(outcome.refusal.cause).toBe('verdict-stale');
  });

  // THE ACCEPTANCE MUTATION: delete the baseDigest comparison. The stale branch then
  // never runs, no re-verification is demanded, and the member applies on a verdict
  // describing a base that no longer holds.
  test('RED: delete the baseDigest comparison and the stale verdict applies', async () => {
    const mutant = await mutate('no-base-digest-check', [[STALE_COMPARISON, 'if (false) {']]);
    const origin = tearingOrigin({ 'shared.ts': 'V0\n' });
    const members = await rebasePair(origin, mutant);

    const report = await runWith(mutant, origin, 'sequential-rebase', members);

    // Both applied, and nothing was re-verified. Under the real check this settle stops
    // at n2; the assertion in the GREEN test above is what turns red.
    expect(report.outcomes.map((o) => o.kind)).toEqual(['applied', 'applied']);
    expect(report.stoppedAt).toBeNull();
    expect(report.outcomes.filter((o) => o.kind === 'refused')).toHaveLength(0);
  });

  // The mutation the pair-binding exists to rule out, and the reason the member digest
  // alone is not the check: a diff is immutable, so this comparison can never fire. It
  // is a check in shape and a no-op in effect, and it is indistinguishable from the real
  // one by any test that does not move the base.
  test('RED: binding the member digest ALONE is vacuous and admits the same stale verdict', async () => {
    const mutant = await mutate('member-digest-only', [[
      STALE_COMPARISON,
      'if (member.verdict.memberDigest !== memberDigestOf(member.diff)) {',
    ]]);
    const origin = tearingOrigin({ 'shared.ts': 'V0\n' });
    const members = await rebasePair(origin, mutant);

    const report = await runWith(mutant, origin, 'sequential-rebase', members);

    expect(report.outcomes.map((o) => o.kind)).toEqual(['applied', 'applied']);
    expect(report.stoppedAt).toBeNull();
  });

  // A re-verification bound to some OTHER base is the second half of rule 4. Without
  // this comparison a registry could answer a different question and be believed.
  test('RED: drop the re-verification base check and a mismatched verdict is believed', async () => {
    const mutant = await mutate('no-reverify-base-check', [[
      'if (fresh.baseDigest !== baseDigest) {',
      'if (false) {',
    ]]);
    const origin = tearingOrigin({ 'shared.ts': 'V0\n' });
    const members = await rebasePair(origin, mutant);

    const report = await mutant.mergeBack(
      { policy: 'sequential-rebase', members },
      {
        log: createRecordingLogger(),
        preset: 'mutation',
        readOrigin: origin.readOrigin,
        applyMember: origin.applyMember,
        reverify: async ({ member }) => ({
          memberDigest: mutant.memberDigestOf(member.diff),
          baseDigest: 'a base nobody asked about',
          clean: true,
        }),
      },
    );

    expect(report.outcomes.map((o) => o.kind)).toEqual(['applied', 'applied']);
  });
});

/* ── Red-proof 3: the derived order (*Dependency order*) ──────────────────── */

const DERIVED_ORDER = 'dependencyOrder(members, settled)';

// A fan-in and one of its parents, with the DEPENDENT offered first — which is the order a
// level hands over, since a vertex is created after the parents it consumed and is
// therefore held after them. Different paths, so nothing here is a conflict: the only
// thing that decides whether both land is the order.
async function vertexBeforeParent(origin: Origin, module: MergeBackModule) {
  return [
    await memberOf(
      origin, 'vertex', [{ path: 'c.ts', base: 'C0\n', after: 'C1\n' }], module, ['parent'],
    ),
    await memberOf(origin, 'parent', [{ path: 'a.ts', base: 'A0\n', after: 'A1\n' }], module),
  ];
}

describe('the derived dependency order is load-bearing', () => {
  test('GREEN: the order comes off the edges, so both members land', async () => {
    const origin = tearingOrigin({ 'a.ts': 'A0\n', 'c.ts': 'C0\n' });
    const members = await vertexBeforeParent(origin, pristine);

    const report = await runWith(pristine, origin, 'sequential-rebase', members);

    expect(report.order).toEqual(['parent', 'vertex']);
    expect(report.outcomes.map((o) => o.kind)).toEqual(['applied', 'applied']);
    expect(origin.at.get('c.ts')).toBe('C1\n');
  });

  // THE ACCEPTANCE MUTATION: apply the members in the order they were offered. Rule 1 then
  // refuses the dependent, the merge stops at the first member, and a DAG whose vertices
  // are created after the parents they consumed can never land anything — which is what
  // makes the derivation the mechanism rather than a tidy-up.
  test('RED: apply them as offered and the dependent refuses for want of its dependency', async () => {
    const mutant = await mutate('offered-order', [[
      DERIVED_ORDER, "({ kind: 'ordered' as const, members })",
    ]]);
    const origin = tearingOrigin({ 'a.ts': 'A0\n', 'c.ts': 'C0\n' });
    const members = await vertexBeforeParent(origin, mutant);

    const report = await runWith(mutant, origin, 'sequential-rebase', members);

    expect(report.order).toEqual(['vertex', 'parent']);
    const [outcome] = report.outcomes;
    if (outcome?.kind !== 'refused') throw new Error('expected a refusal');
    expect(outcome.refusal.cause).toBe('dependency-unsettled');
    expect(report.stoppedAt).toBe('vertex');
    // Nothing landed at all: the parent was never reached either.
    expect(origin.at.get('c.ts')).toBe('C0\n');
    expect(origin.at.get('a.ts')).toBe('A0\n');
  });
});

/* ── The mutation harness itself ──────────────────────────────────────────── */

describe('the harness cannot prove a guard it did not remove', () => {
  test('a snippet that is not present exactly once throws instead of passing', async () => {
    await expect(mutate('bogus', [['a snippet merge-back.ts does not contain', '']]))
      .rejects.toThrow('found 0');
  });

  test('the pristine module still holds every snippet this file mutates', async () => {
    const source = await Bun.file(SOURCE).text();
    expect(source.split(STALE_COMPARISON).length - 1).toBe(1);
    expect(source.split('const exceeded = memberApplyBound(plan);').length - 1).toBe(1);
    expect(source.split('if (fresh.baseDigest !== baseDigest) {').length - 1).toBe(1);
    expect(source.split(DERIVED_ORDER).length - 1).toBe(1);
  });
});

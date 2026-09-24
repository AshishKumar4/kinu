// Red-proofs for the merge-back guards: each check is removed mechanically from an owned
// scratch copy and the suite asserts behaviour changes. `mutate` requires each snippet to
// occur exactly once, so a mutation that silently missed throws.
// Specified by docs/EXPLORATION.md — "Merge-back", including *Dependency order*.
import { describe, expect, test } from 'bun:test';
import { symlinkSync, writeFileSync, realpathSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { scratchDir } from '@kinu.run/test-utils';
import { MAX_TX_BLOB_BYTES } from '@nimbus-sh/core/constants.js';
import { createRecordingLogger } from '../src/obs/index';
import * as pristine from '../src/strategy/merge-back';
import type {
  MemberApply, MemberFileChange, MergeMember, MergePolicy, MergeBackReport,
} from '../src/strategy/merge-back';

type MergeBackModule = typeof pristine;

const SOURCE = new URL('../src/strategy/merge-back.ts', import.meta.url).pathname;

const SOURCE_DIR = dirname(SOURCE);

// Canonical: the loader resolves relative imports from the real path, and on macOS
// `tmpdir()` is a symlink one level shallower than its target.
const MUTANTS = realpathSync(scratchDir('mutation-merge-back'));

symlinkSync(resolve(SOURCE_DIR, '../../../../node_modules'), join(MUTANTS, 'node_modules'), 'dir');

/** A copy of merge-back with `edits` applied, imports re-pointed to pristine source. */
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

  const rewritten = source.replaceAll(
    /from '(\.[^']*)'/g,
    (_whole: string, specifier: string) => {
      const target = `${resolve(SOURCE_DIR, specifier)}.ts`;
      const path = relative(MUTANTS, target);

      return `from '${path.startsWith('.') ? path : `./${path}`}'`;
    },
  );

  const path = join(MUTANTS, `merge-back.mutant-${label}.ts`);
  writeFileSync(path, rewritten);

  // SAFETY: every edit matched exactly once, so the export shape is the pristine module's;
  // a wrong import-depth rewrite throws here.
  return await import(path);
}

interface Origin {
  readonly at: Map<string, string>;
  readonly readOrigin: (path: string) => Promise<string | null>;
  readonly transactions: (readonly MemberFileChange[])[];
}

/**
 * Tears above the bound like the hosted committed-prefix `writeBatchStream`: files that fit
 * land and the rest do not.
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

interface MergeMemberSeed {
  origin: Origin;
  nodeId: string;
  files: readonly MemberFileChange[];
  module?: MergeBackModule;
  deps?: readonly string[];
}

async function memberOf(
  { origin, nodeId, files, module = pristine, deps = [] }: MergeMemberSeed,
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

// Each file fits alone, jointly over the bound: a committed prefix lands the first only.
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
    const member = await memberOf({ origin, nodeId: 'n1', files: oversizedPair() });

    const report = await runWith(pristine, origin, 'apply-winner', [member]);

    const [outcome] = report.outcomes;

    if (outcome?.kind !== 'refused') throw new Error('expected a refusal');
    expect(outcome.refusal.cause).toBe('oversized');
    expect(outcome.refusal.error).toContain('blobBytes');
    expect(origin.transactions).toHaveLength(0);
    expect(origin.at.size).toBe(0);
  });

  test('RED: delete the pre-flight and the same member TEARS the origin', async () => {
    const mutant = await mutate('no-size-check', [[
      'const exceeded = memberApplyBound(plan);',
      'const exceeded = null;',
    ]]);

    const origin = tearingOrigin({});
    const member = await memberOf({ origin, nodeId: 'n1', files: oversizedPair(), module: mutant });

    const report = await runWith(mutant, origin, 'apply-winner', [member]);

    expect(origin.transactions).toHaveLength(1);
    // Torn: a strict subset of the member's files landed.
    expect(origin.at.has('first.bin')).toBe(true);
    expect(origin.at.has('second.bin')).toBe(false);
    // Reported as a substrate failure after the damage; only the pre-flight prevents it.
    expect(report.outcomes[0]?.kind).toBe('refused');
  });

  test('RED: the mutant names no bound, so a caller cannot act on it', async () => {
    const mutant = await mutate('no-size-check-message', [[
      'const exceeded = memberApplyBound(plan);',
      'const exceeded = null;',
    ]]);

    const origin = tearingOrigin({});
    const member = await memberOf({ origin, nodeId: 'n1', files: oversizedPair(), module: mutant });

    const report = await runWith(mutant, origin, 'apply-winner', [member]);

    const [outcome] = report.outcomes;

    if (outcome?.kind !== 'refused') throw new Error('expected a refusal');
    expect(outcome.refusal.cause).not.toBe('oversized');
    expect(outcome.refusal.error).not.toContain('blobBytes');
  });
});

const STALE_COMPARISON = 'if (member.verdict.baseDigest !== baseDigest) {';

/** Member one landing moves member two's base; same content, so agreement, not a conflict. */
async function rebasePair(origin: Origin, module: MergeBackModule) {
  return [
    await memberOf({ origin, nodeId: 'n1', files: [{ path: 'shared.ts', base: 'V0\n', after: 'V1\n' }], module }),
    await memberOf({ origin, nodeId: 'n2', files: [{ path: 'shared.ts', base: 'V0\n', after: 'V1\n' }], module }),
  ];
}

describe('the stale-verdict refusal is load-bearing', () => {
  test('GREEN: a rebased member with a moved base is refused', async () => {
    const origin = tearingOrigin({ 'shared.ts': 'V0\n' });
    const members = await rebasePair(origin, pristine);

    const report = await runWith(pristine, origin, 'sequential-rebase', members);

    expect(report.stoppedAt).toBeNull();
    const [, outcome] = report.outcomes;

    if (outcome?.kind !== 'refused') throw new Error('expected a refusal');
    expect(outcome.refusal.cause).toBe('verdict-stale');
  });

  // Mutation: delete the baseDigest comparison, so a stale verdict applies.
  test('RED: delete the baseDigest comparison and the stale verdict applies', async () => {
    const mutant = await mutate('no-base-digest-check', [[STALE_COMPARISON, 'if (false) {']]);
    const origin = tearingOrigin({ 'shared.ts': 'V0\n' });
    const members = await rebasePair(origin, mutant);

    const report = await runWith(mutant, origin, 'sequential-rebase', members);

    // The green test's stop at n2 is what turns red.
    expect(report.outcomes.map((o) => o.kind)).toEqual(['applied', 'applied']);
    expect(report.stoppedAt).toBeNull();
    expect(report.outcomes.filter((o) => o.kind === 'refused')).toHaveLength(0);
  });

  // A diff is immutable, so a member-digest-only check can never fire.
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

  // Rule 4's second half: a re-verification bound to another base must not be believed.
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

const DERIVED_ORDER = 'dependencyOrder(members, settled)';

// A fan-in with its dependent offered first, as a level hands it over. Different paths:
// only the order decides whether both land.
async function vertexBeforeParent(origin: Origin, module: MergeBackModule) {
  return [
    await memberOf({
      origin, nodeId: 'vertex', files: [{ path: 'c.ts', base: 'C0\n', after: 'C1\n' }], module, deps: ['parent'],
    }),
    await memberOf({ origin, nodeId: 'parent', files: [{ path: 'a.ts', base: 'A0\n', after: 'A1\n' }], module }),
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

  // Mutation: apply in offered order, so rule 1 refuses the dependent vertex.
  test('RED: apply them as offered and the dependent refuses for want of its dependency', async () => {
    const mutant = await mutate('offered-order', [[
      DERIVED_ORDER, "({ kind: 'ordered' as const, members })",
    ]]);

    const origin = tearingOrigin({ 'a.ts': 'A0\n', 'c.ts': 'C0\n' });
    const members = await vertexBeforeParent(origin, mutant);

    const report = await runWith(mutant, origin, 'sequential-rebase', members);

    expect(report.order).toEqual(['vertex', 'parent']);
    const [outcome, landed] = report.outcomes;

    if (outcome?.kind !== 'refused') throw new Error('expected a refusal');
    expect(outcome.refusal.cause).toBe('dependency-unsettled');
    // The parent still lands, but the vertex's work does not.
    expect(landed?.kind).toBe('applied');
    expect(report.stoppedAt).toBeNull();
    expect(origin.at.get('c.ts')).toBe('C0\n');
    expect(origin.at.get('a.ts')).toBe('A1\n');
  });
});

describe('the harness cannot prove a guard it did not remove', () => {
  test('a snippet that is not present exactly once throws instead of passing', async () => {
    await expect(mutate('bogus', [['a snippet merge-back.ts does not contain', '']]))
      .rejects.toThrow('found 0');
  });
});

import { describe, expect, test } from 'bun:test';

import {
  PLATFORM_FACT_IDS,
  injectableFaults,
  platformFact,
  platformFactEntries,
  type PlatformFact,
} from '../packages/core/src/platform-catalog';

import { auditSchema } from './platform-catalog';

/** A real entry with one field spoiled — the fixture is the shipped record, so a
 *  test cannot pass against a shape the catalog does not actually use. */
const entry = (over: Partial<PlatformFact>): PlatformFact => ({
  ...platformFact('do.sqlite.row_bytes'),
  ...over,
});

const reasons = (over: Partial<PlatformFact>): string[] =>
  auditSchema([{ id: 'probe', fact: entry(over) }]).problems.map((p) => p.reason);

describe('an entry without evidence is the artefact being replaced', () => {
  test('the real entry is clean', () => {
    expect(reasons({})).toEqual([]);
  });

  test('an empty provenance fails', () => {
    expect(reasons({ provenance: '   ' })).toContain('no provenance');
  });

  test('a documented entry whose provenance is not the publishing URL fails', () => {
    expect(reasons({ evidence: 'documented', provenance: 'somebody told me' }))
      .toEqual(['documented, so its provenance must be the URL that publishes it']);
  });

  test('a measured entry whose provenance is a doc link fails — a doc proves nothing was measured', () => {
    expect(reasons({ evidence: 'proven-by-probe', provenance: 'https://developers.cloudflare.com/' }))
      .toContain('labelled proven-by-probe but its provenance is a URL — a doc link proves nothing was measured');
  });

  test('an unresolvable anchor fails exactly like a missing one', () => {
    // A write-up plus a numbered section is followable and accepted; `§1.x` is a
    // wildcard nobody can open, so it is rejected exactly like a bare filename.
    // Both carry an observable, because switching to a probed label also engages
    // the rule that a watched failure must record its wording.
    const probed = (provenance: string): Partial<PlatformFact> => ({
      evidence: 'proven-by-probe',
      provenance,
      observable: [{ context: 'the write', message: 'SQLITE_TOOBIG' }],
    });

    expect(reasons(probed('~/Nimbus/scratchpad/report.md §1.x')))
      .toEqual(['provenance "~/Nimbus/scratchpad/report.md §1.x" names nothing a reader can open']);
    expect(reasons(probed('~/Nimbus/scratchpad/report.md §4'))).toEqual([]);
    expect(reasons(probed('~/Nimbus/scratchpad/report.md'))).toHaveLength(1);
    expect(reasons(probed('~/Nimbus/scratchpad/results.json#lastGoodMB'))).toEqual([]);
    // A sibling's published probe is followable; an unpublished one is not.
    expect(reasons(probed('local://observability-contract.md'))).toEqual([]);
    expect(reasons(probed('a probe somebody ran once'))).toHaveLength(1);
  });

  test('a non-ISO date fails', () => {
    expect(reasons({ date: 'July 2026' })).toContain('date "July 2026" is not an ISO calendar date');
  });

  test('an entry with no trigger fails — nothing can fire it, so nothing can test it', () => {
    expect(reasons({ trigger: '' }))
      .toContain('no trigger — nothing can fire it, so nothing can test it');
  });

  test('a threshold that does not say what it bounds fails', () => {
    expect(reasons({ bounds: null })).toContain('has a threshold but does not say what it bounds');
  });

  test('having WATCHED a failure and not recorded its wording fails', () => {
    expect(reasons({ evidence: 'proven-by-probe', provenance: 'probe.md:12', observable: [] }))
      .toContain('proven-by-probe with a first-party signal but no verbatim observable');
  });

  test('the same emptiness on an entry that never claimed to see it is a GAP, not a failure', () => {
    const audit = auditSchema([{ id: 'probe', fact: entry({ observable: [] }) }]);
    expect(audit.problems).toEqual([]);
    expect(audit.gaps.map((g) => g.missing)).toContain('the verbatim string this surfaces as');
  });

  test('conflictsWith naming a non-entry fails', () => {
    expect(reasons({ conflictsWith: ['do.sqlite.row_bytes', 'do.made.up'] }))
      .toContain('conflictsWith names "do.made.up", which is not a catalog id');
  });

  test('a declared breach path that names nothing fails', () => {
    expect(reasons({ knownBreachPath: '' }))
      .toContain('declares a known breach path and names nothing');
  });

  test('a WELL-FORMED citation to a repo file that does not exist fails', () => {
    // The defect, exactly. Both lost documents were cited in perfect form from
    // live code — an internal research note from a Nimbus production constant,
    // and the removed stability audit from a shipped 25 s heartbeat in this repo.
    // Form was never the problem. Nothing checked RESOLUTION, in two repos, for
    // months.
    expect(reasons({ evidence: 'proven-by-source', provenance: 'packages/core/src/gone.ts:12' }))
      .toContain('provenance cites `packages/core/src/gone.ts`, which is not in this repo');
    expect(reasons({ evidence: 'proven-by-source', provenance: 'packages/core/src/prompt.ts:12' }))
      .toEqual([]);
  });

  test('a deleted file cited WITH the commit that still holds it is followable', () => {
    // Strictly better evidence than a live path, because a pinned blob cannot
    // drift. The sha is the entire difference between recoverable and dangling.
    const withSha = 'git 947c2560:docs/STABILITY-AUDIT.md:47-55';
    expect(reasons({ evidence: 'proven-by-source', provenance: withSha })).toEqual([]);
    expect(reasons({ evidence: 'proven-by-source', provenance: 'docs/STABILITY-AUDIT.md:47-55' }))
      .toContain('provenance cites `docs/STABILITY-AUDIT.md`, which is not in this repo');
  });

  test('a path in ANOTHER repo is not claimed as ours', () => {
    // `~/Nimbus/packages/worker/src/constants.ts` contains a substring that looks
    // repo-local. Claiming it would make every Nimbus citation red, which is how
    // a gate becomes a gate nobody runs.
    expect(reasons({
      evidence: 'proven-by-source',
      provenance: '~/Nimbus/packages/worker/src/constants.ts:70',
    })).toEqual([]);
  });

  test('a stale citation inside notes or a breach path fails too', () => {
    // Prose rots faster than a provenance field, and a breach path names the
    // file somebody is meant to go and fix.
    expect(reasons({ notes: 'see packages/core/src/vanished.ts:9 for the mechanism' }))
      .toContain('notes cites `packages/core/src/vanished.ts`, which is not in this repo');
    expect(reasons({ knownBreachPath: 'packages/core/src/vanished.ts:9 leaks' }))
      .toContain('knownBreachPath cites `packages/core/src/vanished.ts`, which is not in this repo');
  });
});

describe('the fault set a simulator may inject', () => {
  test('is exactly the first-hand evidence, and nothing documented or inferred', () => {
    const injectable = injectableFaults();
    expect(injectable.length).toBeGreaterThan(0);

    for (const id of injectable) {
      expect(['proven-by-probe', 'proven-by-source', 'observed-in-production'])
        .toContain(platformFact(id).evidence);
    }

    for (const id of PLATFORM_FACT_IDS) {
      if (injectable.includes(id)) continue;
      expect(['documented', 'inferred', 'speculative']).toContain(platformFact(id).evidence);
    }
  });

  test('a fault with no first-party signal must be injected silently, so it declares no observable', () => {
    // Not a style rule: a simulator that throws where production goes quiet is
    // easier than production. `do.isolate.reset_silent` is the case that matters
    // — at roughly 200 MiB retained the object simply vanishes.
    const silent = injectableFaults().filter((id) => !platformFact(id).firstPartySignal);
    expect(silent.length).toBeGreaterThan(0);
    expect(silent).toContain('do.isolate.reset_silent');

    for (const id of silent) expect(platformFact(id).observable).toEqual([]);
  });
});

describe('against the real tree', () => {
  const schema = auditSchema(platformFactEntries());

  test('the catalog is populated, evidenced, and not folklore', () => {
    expect(schema.inspected).toBeGreaterThan(0);
    expect(schema.problems).toEqual([]);
    expect(schema.byEvidence.get('documented') ?? 0).toBeGreaterThan(0);
    expect(injectableFaults().length).toBeGreaterThan(0);
  });

  test('the workspace prompt reports the catalog memory limit', async () => {
    const { createTestRuntime } = await import('../packages/test-utils/src/index');
    const { buildSystemPromptSync } = await import('../packages/core/src/prompt');
    const { rt } = createTestRuntime();

    const rendered = buildSystemPromptSync(rt, {
      backend: 'cf',
      executors: [{ name: 'workspace', status: 'ready' }],
    });

    const limit = platformFact('worker.isolate.memory').limit;

    if (limit === null) throw new Error('Workspace memory fact has no limit');
    const reported = rendered.match(/([0-9.]+) MB/);
    expect(Number(reported?.[1])).toBe(limit.value / (1000 * 1000));
  });
});

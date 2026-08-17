import { describe, expect, test } from 'bun:test';

import {
  PLATFORM_FACT_IDS,
  injectableFaults,
  platformFact,
  platformFactEntries,
  type PlatformFact,
} from '../packages/core/src/platform-catalog.ts';
import { readFileSync } from 'node:fs';

import { PROSE_EXEMPT_FILES, auditSchema, auditSources, findProseMentions } from './platform-catalog.ts';
import { readSources } from './sources.ts';

/**
 * The fixture is not invented. This is the shape that produced the whole
 * exercise, transcribed from `~/Nimbus/packages/worker/src/constants.ts:135-146`:
 * a load-bearing production ceiling justified by a document that was never
 * committed and is now gone.
 */
const DANGLING = `
// The supervisor isolate's 128 MiB workerd cap is a HARD platform ceiling
// (per a gitignored internal research note (§6, invariant I1)).
export const SUPERVISOR_HEAP_CEILING_BYTES = 64 * 1024 * 1024;
`;

/** The same sentence, sourced. Nothing else about it changes — which is the
 *  point: the gate asks for a name, not a rewrite. */
const CITED = `
// The supervisor isolate's 128 MiB workerd cap is a HARD platform ceiling
// (\`worker.isolate.memory\`, and note \`do.isolate.oom_catchable\` measured the
// real wall far higher).
export const SUPERVISOR_HEAP_CEILING_BYTES = 64 * 1024 * 1024;
`;

/** A real entry with one field spoiled — the fixture is the shipped record, so a
 *  test cannot pass against a shape the catalog does not actually use. */
const entry = (over: Partial<PlatformFact>): PlatformFact => ({
  ...platformFact('do.sqlite.row_bytes'),
  ...over,
});

const reasons = (over: Partial<PlatformFact>): string[] =>
  auditSchema([{ id: 'probe', fact: entry(over) }]).problems.map((p) => p.reason);

describe('a platform sentence must name the entry it comes from', () => {
  test('the dangling-citation shape is reported', () => {
    const found = findProseMentions('constants.ts', DANGLING);
    expect(found).toHaveLength(1);
    expect(found[0]?.quantity).toBe('128 MiB');
    expect(found[0]?.vocabulary).toBe('workerd');
    expect(found[0]?.citedId).toBeNull();
  });

  test('naming the entry clears it', () => {
    const found = findProseMentions('constants.ts', CITED);
    expect(found).toHaveLength(1);
    expect(found[0]?.citedId).toBe('worker.isolate.memory');
  });

  test('a number with no unit is not a claim — a timeout constant must not be a finding', () => {
    const timeout = `
// Deadline for a CONTROL round-trip into a Durable Object.
const DEFAULT_RPC_TIMEOUT_MS = 30_000;
`;
    expect(findProseMentions('device-tunnel.ts', timeout)).toEqual([]);
  });

  test('a quantity with no platform vocabulary near it is not a claim', () => {
    const policy = `
// A container reporting the HOST's cores forks 32 compilers into 2GB.
const MAX_JOBS = 8;
`;
    expect(findProseMentions('registry.ts', policy)).toEqual([]);
  });
});

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
    // and `docs/STABILITY-AUDIT.md` from a shipped 25 s heartbeat in this repo.
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
  const sources = readSources();
  const schema = auditSchema(platformFactEntries());
  const audit = auditSources(sources);

  test('the catalog is populated, evidenced, and not folklore', () => {
    expect(schema.inspected).toBeGreaterThan(0);
    expect(schema.problems).toEqual([]);
    expect(schema.byEvidence.get('documented') ?? 0).toBeGreaterThan(0);
    expect(injectableFaults().length).toBeGreaterThan(0);
  });

  test('the scan has a non-zero denominator and the matcher demonstrably fires', () => {
    // Three gates in this repo have reported green over nothing. A clean result
    // means nothing unless the matcher is proven to still match something.
    expect(sources.size).toBeGreaterThan(0);
    expect(audit.mentions.length).toBeGreaterThan(0);
    expect(audit.mentions.filter((m) => m.citedId !== null).length).toBeGreaterThan(0);
  });

  test('every platform sentence in the tree names its entry', () => {
    expect(audit.mentions.filter((m) => m.citedId === null)).toEqual([]);
  });

  test('the exemption list is exactly one file, pinned by equality', () => {
    // Not a style assertion. An unpinned ignore list is how a gate dies: adding a
    // path is the cheapest way to make a cleanup pass go green, and nobody
    // reviews an addition to a list nothing checks. The catalog is exempt because
    // it states every platform number it owns; a SECOND name here would mean some
    // other file is allowed to state a platform number uncited, which is the
    // entire thing being prevented.
    expect(PROSE_EXEMPT_FILES).toEqual(['packages/core/src/platform-catalog.ts']);
  });

  test('the exempt file would otherwise be the largest violator, so the matcher still bites there', () => {
    // Proves the exemption is a path exclusion and not a dead matcher: run the
    // scanner directly over the catalog's own text and it finds plenty.
    const catalog = readFileSync('packages/core/src/platform-catalog.ts', 'utf8');
    expect(findProseMentions('packages/core/src/platform-catalog.ts', catalog).length)
      .toBeGreaterThan(0);
  });

  test('the catalog is load-bearing: production code imports it', () => {
    expect(audit.importers.length).toBeGreaterThan(0);
    expect(audit.citedIds.length).toBeGreaterThan(0);
  });

  test('the prompt no longer types the platform number as prose', () => {
    // Source-level, and deliberately free of the core module graph: eight
    // streams are editing `packages/core` concurrently, and a sibling's
    // half-written import would otherwise report THIS invariant as broken.
    const source = sources.get('packages/core/src/prompt.ts');
    expect(source).toContain('PLATFORM_CATALOG');
    expect(source).not.toContain('~128 MB of memory');
  });

  test('the number the model is told about the workspace is RENDERED from the catalog', async () => {
    // Source text alone only proves the import exists. This renders the real
    // prompt and reads the sentence back: it used to type "~128 MB" as prose,
    // and byte-identical output is what proves the derivation REPLACED the
    // literal rather than sitting beside it.
    //
    // Dynamic because `createTestRuntime` reaches package internals that must
    // resolve after this file's own module graph, exactly as the core suites do.
    // That also means this test loads all of `packages/core`, so it fails while
    // any sibling is mid-write — which is why the invariant above stands alone.
    const { createTestRuntime } = await import('../packages/test-utils/src/index.ts');
    const { buildSystemPromptSync } = await import('../packages/core/src/prompt.ts');
    const { rt } = createTestRuntime();
    const rendered = buildSystemPromptSync(rt, {
      backend: 'cf',
      executors: [{ name: 'workspace', status: 'ready' }],
    });
    const mb = platformFact('worker.isolate.memory').limit?.value ?? 0;
    expect(mb).toBeGreaterThan(0);
    expect(rendered).toContain(`~${String(mb / (1000 * 1000))} MB of memory is what bounds any one command`);
  });
});

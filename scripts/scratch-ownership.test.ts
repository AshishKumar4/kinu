/**
 * The scratch-ownership gate's own decision logic.
 *
 * Every case is a shape that actually leaked on 2026-08-17, and every one is
 * proven RED here against the historical source and green against the fix — a
 * gate whose rules are only ever exercised by a clean tree cannot tell you
 * whether it still works. The three false positives at the bottom are equally
 * load-bearing: this gate reads source text, and the first version of it fired
 * on prose describing the defect and on `/tmp/` paths belonging to the SANDBOX's
 * filesystem rather than to this box.
 */

import { describe, test, expect } from 'bun:test';
import { auditScratchOwnership, readScannableSources } from './scratch-ownership';
import { SCRATCH_PREFIXES } from '@kinu/test-utils';

/** One file, as the gate reads its corpus. */
function audit(path: string, source: string) {
  return auditScratchOwnership(new Map([[path, source]]));
}

describe('the shapes that leaked', () => {
  test('a temp path composed from a uniquifier is refused, whichever uniquifier', () => {
    // The three found in one evening: Date.now() in opencode-provider's
    // makeAuthFile (16 dirs per run), performance.now() in four `dbPath` sites,
    // and crypto.randomUUID() in core's step-persistence (8 .sqlite FILES per
    // run, which is why the rule keys on interpolation and not on a list).
    for (const unique of ['Date.now()', 'performance.now()', 'crypto.randomUUID()', 'process.pid']) {
      const found = audit('packages/x/tests/a.test.ts', [
        "import { mkdirSync } from 'node:fs';",
        `const dir = \`/tmp/proteus-test-\${${unique}}\`;`,
        'mkdirSync(dir, { recursive: true });',
      ].join('\n'));
      expect(found.problems.map((p) => p.rule)).toEqual(['unowned-unique']);
    }
  });

  test('a mkdtemp prefix outside the catalogue is refused', () => {
    // preflight counts and reclaims BY PREFIX, so an unlisted one is
    // simultaneously uncollected and invisible — measured at ~30% of our own
    // garbage unseen (6,102 of 8,643).
    const found = audit('packages/x/tests/a.test.ts', [
      "import { mkdtempSync } from 'node:fs';",
      "import { tmpdir } from 'node:os';",
      "import { join } from 'node:path';",
      "const dir = mkdtempSync(join(tmpdir(), 'totally-new-thing-'));",
      'afterAll(() => { rmSync(dir, { recursive: true, force: true }); });',
    ].join('\n'));
    expect(found.problems.map((p) => p.rule)).toEqual(['catalogued']);
  });

  test('a suite that mints and never releases is refused', () => {
    const found = audit('packages/x/tests/a.test.ts', [
      "import { mkdtempSync } from 'node:fs';",
      "import { tmpdir } from 'node:os';",
      "import { join } from 'node:path';",
      "const dir = mkdtempSync(join(tmpdir(), 'proteus-thing-'));",
    ].join('\n'));
    expect(found.problems.map((p) => p.rule)).toEqual(['released']);
  });

  test('the eager mkdirSync that produced 5,489 directories is refused', () => {
    // `createBranchSpawner` did this at construction and `createCLIRuntime`
    // builds one per call, so a directory was written per runtime whether MCTS
    // branched or not: 107 per cli-backend suite run.
    const found = audit('packages/x/tests/a.test.ts', [
      "import { mkdirSync } from 'node:fs';",
      "import { tmpdir } from 'node:os';",
      "mkdirSync(`${tmpdir()}/branches`, { recursive: true });",
    ].join('\n'));
    expect(found.problems.map((p) => p.rule)).toEqual(['released']);
  });
});

describe('the fixes are accepted', () => {
  test('minting through the helper needs no per-suite hook', () => {
    // The preload registers ONE `bun:test` afterAll for the whole invocation,
    // which is the only release mechanism measured to run under this runner —
    // `process.on("exit")` never fires under `bun test`.
    const found = audit('packages/x/tests/a.test.ts', [
      "import { scratchDir } from '@kinu/test-utils';",
      "const dir = scratchDir('a-suite');",
    ].join('\n'));
    expect(found.problems).toEqual([]);
  });

  test("a suite's own throw-surviving cleanup is accepted and left alone", () => {
    const found = audit('packages/x/tests/a.test.ts', [
      "import { mkdtempSync, rmSync } from 'node:fs';",
      "import { tmpdir } from 'node:os';",
      "import { join } from 'node:path';",
      "const dir = mkdtempSync(join(tmpdir(), 'proteus-thing-'));",
      'afterAll(() => { rmSync(dir, { recursive: true, force: true }); });',
    ].join('\n'));
    expect(found.problems).toEqual([]);
  });
});

describe('what it must NOT fire on', () => {
  test('prose that quotes the defect', () => {
    // This gate documents the shapes it rejects, and so does the helper. A gate
    // that fires on its own explanation gets the explanation deleted.
    const found = audit('packages/x/tests/a.test.ts', [
      '/**',
      ' * Hand-rolling this as `/tmp/proteus-test-${performance.now()}.db` is what',
      ' * put 5,489 directories in /tmp.',
      ' */',
      "import { scratchDir } from '@kinu/test-utils';",
      "const dir = scratchDir('a-suite');",
    ].join('\n'));
    expect(found.problems).toEqual([]);
  });

  test("a /tmp/ path on the SANDBOX's filesystem, not this box's", () => {
    // core/release/engine.ts writes `/tmp/${changeId}.gitauth` through
    // `exec.writeFile` INSIDE the sandbox and removes it there; sandbox.ts
    // mentions `/tmp/srv-${p}.log` in an error message telling the model what to
    // run in there. Neither is a directory on this machine.
    const src = audit('packages/core/src/release/engine.ts', [
      'const authFile = `/tmp/${changeId}.gitauth`;',
      'await exec.writeFile(authFile, header);',
    ].join('\n'));
    expect(src.problems).toEqual([]);

    // And the suite that asserts on such a path writes nothing here: its only
    // database is `:memory:`, which is the one `new Database` that touches no
    // disk.
    const suite = audit('packages/core/tests/unit-release-engine.test.ts', [
      "import { Database } from 'bun:sqlite';",
      "const db = new Database(':memory:');",
      'expect(s.sandbox.files.get(`/tmp/${s.changeId}.patch`)).toBe(PATCH);',
    ].join('\n'));
    expect(suite.problems).toEqual([]);
  });

  test('a non-suite program that mints scratch for an operator to read', () => {
    // `scripts/nimbus-runtime-probe.ts` hands a directory to a human. Its
    // lifetime is not the run's, so the release rule does not reach it — the
    // catalogue rule still does.
    const found = audit('scripts/nimbus-runtime-probe.ts', [
      "import { mkdtempSync } from 'node:fs';",
      "import { tmpdir } from 'node:os';",
      "import { join } from 'node:path';",
      "const db = join(mkdtempSync(join(tmpdir(), 'nimbus-probe-')), 'probe.db');",
    ].join('\n'));
    expect(found.problems).toEqual([]);
  });
});

describe('the tree it governs', () => {
  test('the whole repository is clean, over a corpus this gate did not choose', () => {
    // The corpus comes from `scripts/sources.ts` (`trackedFiles()`), not a glob
    // this gate wrote: a gate that selects its own population reports green over
    // whatever it happened to look at.
    const audited = auditScratchOwnership(readScannableSources());
    expect(audited.problems).toEqual([]);
    expect(audited.files).toBeGreaterThan(1_000);
    expect(audited.mintingFiles).toBeGreaterThan(20);
  });

  test('every prefix the tree mints is one preflight can see', () => {
    const audited = auditScratchOwnership(readScannableSources());
    // The sibling above floors `files` and `mintingFiles`; this claim quantifies
    // over `prefixes`, which nothing floored. An extractor that stopped finding
    // mkdtemp prefixes would report an empty set, and "every prefix the tree
    // mints is one preflight can see" would be true of nothing — the gate's whole
    // subject silently gone while it printed ok.
    expect(audited.prefixes.length).toBeGreaterThan(20);
    for (const prefix of audited.prefixes) {
      expect(SCRATCH_PREFIXES.some((known) => prefix.startsWith(known))).toBe(true);
    }
  });
});

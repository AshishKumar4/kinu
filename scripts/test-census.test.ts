// The census's own gate: every classifier proven RED on the shape it names and
// GREEN on the corrected form of that shape, plus the ratchet proven red in both
// of its directions.
//
// A census is a measurement, and a measurement nobody proved wrong in both
// directions is a number with no error bar. Three things have to hold, and only
// the first is about finding couplings:
//
//   1. RED on the shape. A test that reads its module's source, mirrors its
//      budget, reaches a private member, mocks an internal module, asserts
//      nothing or skips in silence is FOUND, by name.
//   2. GREEN on the corrected form. The same behaviour expressed through the
//      public surface is NOT found — this is the half that decides whether the
//      census is usable. A classifier that fires on the fixed version teaches a
//      reader to ignore it, which is worse than not measuring at all.
//   3. SILENT on the legitimate shapes its own first drafts mistook for
//      violations, each recorded here with the count it produced on this tree:
//      an assertion routed through a file-local helper (167 rows), a literal `2`
//      shared with a module (1,176 rows), a behavioural string that also occurs
//      in src (102 rows), `spyOn(console,'error')` (4 rows), a `test.each`
//      factory (40+ rows), a `Record` lookup by string key (22 rows), and a fake's
//      own `if (…) return {…}` dispatch (77 rows). Every one of those is a live
//      shape in this repository, so each keeps a test.
//
// EVERY FIXTURE IS TEXT. `measureFile` takes a path and a body, so a red
// demonstration never writes a file — the reason `gate-set-equality.test.ts`
// gives for the same choice: a seeded file changes what every other gate
// measures while it runs.

import { describe, expect, test } from 'bun:test';

import {
  BLIND_SPOTS, CATEGORIES, type Category, type CensusInputs, checkRatchet, type Finding,
  isCensusFile, lockText, measureFile, mergeFindings, noFindings, nonPublicMembers, ratchetKey,
  runnerClaims, runCensus,
} from './test-census';
import { isParseable, isRunnableSuite, isTestFile, trackedFiles } from './sources';

/* ── The seam ──────────────────────────────────────────────────────────── */

const PROBE = 'packages/probe/tests/unit-probe.test.ts';
const MODULE = 'packages/probe/src/budget.ts';

/** The module under test, as text. Its private members and its named constants
 *  are what the mirror and private-reach classifiers resolve against. */
const MODULE_TEXT = `
export const PROMPT_BUDGET = 4096;
export const MARKER = 'kinu-prompt-marker';
export const clampToBudget = (text: string): string => text.slice(0, PROMPT_BUDGET);
export class Orchestrator {
  private settleTurn(id: string): void { void id; }
  protected wakeAt = 1_800_000;
  publicRead(): number { return this.wakeAt; }
}
`;

/** Inputs built once over a synthetic one-module tree, so a classifier is
 *  measured against a module a reader can hold in their head. */
function probeInputs(): CensusInputs {
  const sources = new Map([[MODULE, MODULE_TEXT]]);
  return {
    sources,
    nonPublic: nonPublicMembers(sources),
    generators: new Map([['prompt-golden.json', 'scripts/prompt-golden.ts']]),
    bridges: new Map([['harnessSettle', {
      name: 'harnessSettle',
      file: 'packages/probe/tests/helpers/harness.ts',
      line: 12,
      forwards: ['settleTurn'],
      nonPublic: ['settleTurn'],
    }]]),
    tracked: new Set([MODULE, PROBE]),
    scope: '@kinu.run',
  };
}

const inputs = probeInputs();

/** One fixture's findings for one category, as `line what` strings. */
function found(category: Category, body: string): string[] {
  return measureFile(PROBE, body, inputs).findings[category]
    .map((finding) => `${finding.what}`);
}

/* ── 1 + 2: red on the shape, green on its corrected form ─────────────── */

describe('source_text', () => {
  test('RED: an assertion over a member body read out of the module', () => {
    expect(found('source_text', `
      import { readFileSync } from 'node:fs';
      import { memberBody } from '@kinu.run/test-utils';
      test('the wake is armed inside onStart', () => {
        const source = readFileSync('../src/budget.ts', 'utf8');
        expect(memberBody(source, 'private settleTurn(')).toContain('this.wakeAt');
      });
    `)).toEqual([
      'reads a source file',
      'memberBody() over source text',
      'expect(<source text>).toContain',
    ]);
  });

  test('GREEN: the same invariant asserted through the value the code produces', () => {
    expect(found('source_text', `
      import { Orchestrator } from '@kinu.run/probe/budget';
      test('the wake is armed inside onStart', () => {
        const orchestrator = new Orchestrator();
        expect(orchestrator.publicRead()).toBe(1_800_000);
      });
    `)).toEqual([]);
  });

  test('SILENT: a behavioural string that also occurs in the module', () => {
    // The 102-row false-positive class. `SameSite=Lax` appears in the code that
    // sets the cookie, and asserting it on a RESPONSE is the test working.
    expect(found('source_text', `
      import { login } from '@kinu.run/probe/budget';
      test('the handoff cookie is Lax', async () => {
        const response = await login(new Request('https://x/api/login'));
        expect(response.headers.get('set-cookie')).toContain('kinu-prompt-marker');
      });
    `)).toEqual([]);
  });

  test('SILENT: a workspace file read inside the system under test', () => {
    // `vfs.readFile('src/main.ts')` reads a file in the workspace under test,
    // not this repository's source.
    expect(found('source_text', `
      test('a relative path resolves at the workspace root', async () => {
        expect(await vfs.readFile('src/main.ts', { encoding: 'utf8' })).toBe('a');
      });
    `)).toEqual([]);
  });
});

describe('mirror', () => {
  test('RED: a test-local constant restating the module s budget', () => {
    expect(found('mirror', `
      import { clampToBudget } from '../src/budget';
      const PROMPT_BUDGET = 4096;
      test('a prompt is clamped to the budget', () => {
        expect(clampToBudget('x'.repeat(9000)).length).toBe(PROMPT_BUDGET);
      });
    `)).toEqual(['mirrored constant']);
  });

  test('RED: the author s own declaration of the mirror', () => {
    expect(found('mirror', `
      // Mirrors the private 4096 budget; drift fails these tests.
      test('clamped', () => { expect(1).toBe(1); });
    `)).toEqual(['declared mirror']);
  });

  test('RED: a test-local reimplementation of the module s one-liner', () => {
    expect(found('mirror', `
      import { clampToBudget } from '../src/budget';
      const clampLocal = (text: string): string => text.slice(0, PROMPT_BUDGET);
      test('agrees', () => { expect(clampToBudget('ab')).toBe(clampLocal('ab')); });
    `)).toEqual(['mirrored body']);
  });

  test('GREEN: the behaviour asserted at the boundary rather than at the number', () => {
    expect(found('mirror', `
      import { clampToBudget } from '../src/budget';
      test('a prompt longer than the budget is cut and a shorter one is not', () => {
        const long = 'x'.repeat(9000);
        expect(clampToBudget(long).length).toBeLessThan(long.length);
        expect(clampToBudget('short')).toBe('short');
      });
    `)).toEqual([]);
  });

  test('SILENT: a small literal the module also happens to contain', () => {
    // The 1,176-row false-positive class: `2` is shared by accident all day.
    expect(found('mirror', `
      import { clampToBudget } from '../src/budget';
      const RETRIES = 2;
      test('retries twice', () => { expect(RETRIES).toBe(2); });
    `)).toEqual([]);
  });
});

describe('private_reach', () => {
  test('RED: a bracket reach to a member production declares private', () => {
    expect(found('private_reach', `
      import { Orchestrator } from '../src/budget';
      test('settling twice is idempotent', () => {
        const agent = new Orchestrator();
        agent['settleTurn']('t-1');
        expect(agent.publicRead()).toBe(1_800_000);
      });
    `)).toEqual(['bracket reach to a non-public member']);
  });

  test('RED: a harness bridge that forwards to a protected member', () => {
    expect(found('private_reach', `
      import { harness } from './helpers/harness';
      test('a settled turn clears its checkpoint', async () => {
        const agent = harness();
        await agent.harnessSettle('t-1');
        expect(agent.publicRead()).toBe(1_800_000);
      });
    `)).toEqual(['harness bridge to a non-public member']);
  });

  test('GREEN: the same state read through the public method', () => {
    expect(found('private_reach', `
      import { Orchestrator } from '../src/budget';
      test('the wake is readable', () => {
        expect(new Orchestrator().publicRead()).toBe(1_800_000);
      });
    `)).toEqual([]);
  });

  test('SILENT: a Record lookup by string key', () => {
    // The 22-row false-positive class: `headers['authorization']` and
    // `BACKGROUNDABLE_TOOLS['agents']` are dictionary reads, not private reaches.
    expect(found('private_reach', `
      test('the header is sent', () => {
        expect(request.headers['authorization']).toBe('Bearer x');
        expect(BACKGROUNDABLE_TOOLS['agents']?.completion).toBe('spawn');
      });
    `)).toEqual([]);
  });
});

describe('internal_mock versus external_seam_mock', () => {
  test('RED: mock.module of a module in this repository', () => {
    const measured = measureFile(PROBE, `
      import { mock } from 'bun:test';
      await mock.module('../src/budget', () => ({ clampToBudget: (t: string) => t }));
      test('clamped', () => { expect(1).toBe(1); });
    `, inputs);
    expect(measured.findings.internal_mock.map((f) => f.detail))
      .toEqual(["module('../src/budget')"]);
    expect(measured.externalSeam).toEqual([]);
  });

  test('GREEN: the platform SDK replaced at its own seam', () => {
    const measured = measureFile(PROBE, `
      import { mock } from 'bun:test';
      await mock.module('@cloudflare/sandbox', () => ({ Sandbox: class {} }));
      await mock.module('cloudflare:workers', () => ({ RpcTarget: class {} }));
      test('clamped', () => { expect(1).toBe(1); });
    `, inputs);
    expect(measured.findings.internal_mock).toEqual([]);
    expect(measured.externalSeam.map((f) => f.what))
      .toEqual(['external seam mock', 'external seam mock']);
  });

  test('SILENT: a spy at a platform global or a node builtin', () => {
    // The 4-row false-positive class: the target used to be read off the callee.
    const measured = measureFile(PROBE, `
      import { spyOn } from 'bun:test';
      import * as fs from 'node:fs';
      test('warns once', () => {
        const warn = spyOn(console, 'error');
        const rename = spyOn(fs, 'renameSync');
        expect(warn).toBeDefined();
        expect(rename).toBeDefined();
      });
    `, inputs);
    expect(measured.findings.internal_mock).toEqual([]);
    expect(measured.externalSeam).toHaveLength(2);
  });
});

describe('tautology_suspect', () => {
  test('RED: the expected side computed by the code under test', () => {
    expect(found('tautology_suspect', `
      import { clampToBudget } from '../src/budget';
      test('clamping is stable', () => {
        expect(clampToBudget('abc')).toBe(clampToBudget('abc'));
      });
    `)).toEqual(['expected side computed by the code under test']);
  });

  test('RED: a test whose only assertion is toBeDefined', () => {
    expect(found('tautology_suspect', `
      import { clampToBudget } from '../src/budget';
      test('clamping works', () => {
        expect(clampToBudget('abc')).toBeDefined();
      });
    `)).toEqual(['weak-only test']);
  });

  test('GREEN: an independently derived expected value', () => {
    expect(found('tautology_suspect', `
      import { clampToBudget } from '../src/budget';
      test('a prompt is cut at the budget', () => {
        expect(clampToBudget('x'.repeat(5000))).toHaveLength(4096);
      });
    `)).toEqual([]);
  });

  test('SILENT: toThrow carrying the message it expects', () => {
    expect(found('tautology_suspect', `
      import { clampToBudget } from '../src/budget';
      test('an empty prompt is refused by name', () => {
        expect(() => clampToBudget('')).toThrow('a prompt cannot be empty');
      });
    `)).toEqual([]);
  });
});

describe('assertion_free and silent_skip', () => {
  test('RED: a test with no assertion at all', () => {
    expect(found('assertion_free', `
      test('independent resources run at the same time', async () => {
        const held = owner.a.op('write');
        await held.entered;
        held.release();
      });
    `)).toEqual(['assertion-free test']);
  });

  test('RED: a test whose only failure mode is a wait timing out', () => {
    const rows = measureFile(PROBE, `
      test('the rename survives a release', async () => {
        await page.click('[data-rename]');
        await page.waitForFunction(() => document.title === 'Renamed', { timeout: 10_000 });
      });
    `, inputs).findings.assertion_free;
    expect(rows.map((f) => f.what)).toEqual(['asserts only by waiting']);
  });

  test('RED: an undeclared skip at the top of a test body', () => {
    expect(found('silent_skip', `
      test('a live turn reaches the model', async () => {
        const creds = process.env.KINU_TOKEN;
        if (!creds) return;
        expect(await turn(creds)).toBe('ok');
      });
    `)).toEqual(['silent return guard']);
  });

  test('RED: a declared skip is still reported, with its own name', () => {
    expect(found('silent_skip', `
      test.skipIf(process.env.CI === undefined)('a live turn', () => {
        expect(1).toBe(1);
      });
    `)).toEqual(['declared test.skipIf']);
  });

  test('GREEN: the assertion routed through a file-local helper', () => {
    // The 167-row false-positive class: six `expect`s live in `expectRefused`.
    expect(found('assertion_free', `
      async function expectRefused(request: Request): Promise<void> {
        const response = await handle(request);
        expect(response?.status).toBe(404);
      }
      test('an unminted route is refused', async () => {
        await expectRefused(new Request('https://x/api/hook'));
      });
    `)).toEqual([]);
  });

  test('SILENT: a fake s own dispatch is not a skip', () => {
    // The 77-row false-positive class: `if (!stream) return {…}` is a stub
    // answering, and the return carries a value rather than bailing out.
    expect(found('silent_skip', `
      test('a non-streaming call answers directly', async () => {
        const model = fakeModel((inputs) => {
          if (!inputs.stream) return { response: 'direct binding' };
          return { stream: true };
        });
        expect(await model.call({ stream: false })).toMatchObject({ response: 'direct binding' });
      });
    `)).toEqual([]);
  });
});

describe('golden_regenerated', () => {
  test('RED: a comparison against a fixture the implementation writes', () => {
    expect(found('golden_regenerated', `
      import { readFileSync } from 'node:fs';
      const golden = JSON.parse(readFileSync('fixtures/prompt-golden.json', 'utf8'));
      test('every surface is byte-identical', () => {
        expect(build('defaults')).toBe(golden.defaults);
      });
    `)).toEqual(['reads a generated fixture']);
  });

  test('GREEN: an expected value written by hand', () => {
    expect(found('golden_regenerated', `
      test('the prefix is stable', () => {
        expect(build('defaults')).toStartWith('# Kinu');
      });
    `)).toEqual([]);
  });
});

describe('public_surface_entry', () => {
  test('an HTTP entry, a CLI spawn and a package API import all count', () => {
    const measured = measureFile(PROBE, `
      import { handleWebhookDeliveryRequest } from '@kinu.run/cf-backend';
      test('a minted route reaches the object', async () => {
        const response = await handleWebhookDeliveryRequest(new Request('https://x/hook'), env);
        expect(response?.status).toBe(200);
      });
      test('the CLI creates a workspace', async () => {
        const child = spawnSync(['packages/cli/bin/cli.ts', 'create', 'w']);
        expect(child.exitCode).toBe(0);
      });
    `, inputs);
    expect(measured.publicSurface.map((f) => f.what).sort())
      .toEqual(['CLI spawn entry', 'HTTP entry', 'package API entry']);
  });
});

describe('kind and test counting', () => {
  test('a table-driven suite counts its own test call sites, not its rows', () => {
    // The `test.each` factory used to be counted as a test of its own, which
    // made every table-driven suite read as assertion-free.
    const measured = measureFile(PROBE, `
      test.each([['a', 1], ['b', 2]])('%s maps to %d', (name, value) => {
        expect(map(name)).toBe(value);
      });
    `, inputs);
    expect(measured.row.tests).toBe(1);
    expect(measured.findings.assertion_free).toEqual([]);
  });

  test('a helper module with no runnable suffix is support, not a suite', () => {
    const measured = measureFile('packages/probe/tests/helpers/harness.ts', `
      export function harness(): number { return 1; }
    `, inputs);
    expect(measured.row.kind).toBe('support');
    expect(measured.row.runner).toBe('imported only');
  });
});

/* ── 3: the ratchet, red in both directions ───────────────────────────── */

describe('the ratchet', () => {
  const clean = measureFile(PROBE, `
    import { clampToBudget } from '../src/budget';
    test('a long prompt is cut', () => {
      expect(clampToBudget('x'.repeat(9000)).length).toBeLessThan(9000);
    });
  `, inputs).findings;
  const lock = lockText(clean, 'probe: 1 file, 1 test');

  test('a clean tree against its own lock is silent', () => {
    const verdict = checkRatchet(clean, lock);
    expect(verdict).toEqual({ added: [], grown: [], stale: [] });
  });

  test('RED: an injected mirror test fails the ratchet BY NAME', () => {
    const injected = measureFile(PROBE, `
      import { clampToBudget } from '../src/budget';
      const PROMPT_BUDGET = 4096;
      test('a long prompt is cut', () => {
        expect(clampToBudget('x'.repeat(9000)).length).toBeLessThan(9000);
      });
      test('the budget is 4096', () => {
        expect(PROMPT_BUDGET).toBe(4096);
      });
    `, inputs).findings;
    const verdict = checkRatchet(injected, lock);
    expect(verdict.added).toHaveLength(1);
    expect(verdict.added[0]).toContain('mirror ::');
    expect(verdict.added[0]).toContain(PROBE);
    expect(verdict.stale).toEqual([]);
  });

  test('GREEN: a new PUBLIC-SURFACE test passes the ratchet', () => {
    const added = measureFile(PROBE, `
      import { clampToBudget } from '../src/budget';
      test('a long prompt is cut', () => {
        expect(clampToBudget('x'.repeat(9000)).length).toBeLessThan(9000);
      });
      test('the clamp is reachable over HTTP', async () => {
        const response = await handleRequest(new Request('https://x/api/prompt'));
        expect(response.status).toBe(200);
      });
    `, inputs).findings;
    const verdict = checkRatchet(added, lock);
    expect(verdict.added).toEqual([]);
    expect(verdict.grown).toEqual([]);
    expect(verdict.stale).toEqual([]);
  });

  test('RED: a second coupling inside the SAME test is a growth, not a silence', () => {
    const once = measureFile(PROBE, `
      import { Orchestrator } from '../src/budget';
      test('settles', () => {
        new Orchestrator()['settleTurn']('a');
        expect(1).toBe(1);
      });
    `, inputs).findings;
    const twice = measureFile(PROBE, `
      import { Orchestrator } from '../src/budget';
      test('settles', () => {
        new Orchestrator()['settleTurn']('a');
        new Orchestrator()['settleTurn']('b');
        expect(1).toBe(1);
      });
    `, inputs).findings;
    const verdict = checkRatchet(twice, lockText(once, 'probe'));
    expect(verdict.added).toEqual([]);
    expect(verdict.grown).toHaveLength(1);
    expect(verdict.grown[0]).toContain('(1 -> 2)');
  });

  test('a removed coupling goes STALE rather than passing quietly', () => {
    const before = measureFile(PROBE, `
      import { Orchestrator } from '../src/budget';
      test('settles', () => {
        new Orchestrator()['settleTurn']('a');
        expect(1).toBe(1);
      });
    `, inputs).findings;
    const after = measureFile(PROBE, `
      import { Orchestrator } from '../src/budget';
      test('settles', () => {
        expect(new Orchestrator().publicRead()).toBe(1_800_000);
      });
    `, inputs).findings;
    const verdict = checkRatchet(after, lockText(before, 'probe'));
    expect(verdict.stale).toHaveLength(1);
    expect(verdict.stale[0]).toContain('private_reach ::');
  });

  test('the key survives a line move, because it carries the test title', () => {
    const body = (padding: string): string => `
      ${padding}
      import { Orchestrator } from '../src/budget';
      test('settles', () => {
        new Orchestrator()['settleTurn']('a');
        expect(1).toBe(1);
      });
    `;
    const top = measureFile(PROBE, body(''), inputs).findings;
    const moved = measureFile(PROBE, body('\n\n\n// twenty lines lower\n\n\n'), inputs).findings;
    expect(checkRatchet(moved, lockText(top, 'probe')))
      .toEqual({ added: [], grown: [], stale: [] });
  });
});

/* ── The tree as it stands ─────────────────────────────────────────────── */

const tracked = trackedFiles();

describe('this repository', () => {
  const census = runCensus();

  test('the corpus is the whole test corpus minus the vendored plugin', () => {
    const expected = tracked.filter(isCensusFile);
    expect(census.files.map((row) => row.file).sort()).toEqual([...expected].sort());
    // A tracked test path outside the census is either vendored or UNPARSEABLE —
    // a `tests/` directory here also holds Python, JSON fixtures and a C probe,
    // and handing one of those to the parser is a crash rather than a finding.
    // There is no fourth set, which is what makes the corpus total.
    const outside = tracked
      .filter((file) => isTestFile(file) && !isCensusFile(file))
      .filter((file) => !file.startsWith('tools/oxlint/anti-slop/'))
      .filter((file) => isParseable(file));
    expect(outside).toEqual([]);
  });

  test('it measured something in every dimension it reports', () => {
    expect(census.tree.files).toBeGreaterThan(700);
    expect(census.tree.tests).toBeGreaterThan(9000);
    expect(census.runnerClaims.length).toBeGreaterThan(20);
    expect(census.bridges.length).toBeGreaterThan(10);
    expect(census.publicSurface.length).toBeGreaterThan(100);
  });

  /**
   * The never-run set as it stands, and it is a FIXTURE rather than an emptiness
   * check for one reason: this census's own suite is in it. Nothing in the ladder
   * or in deploy.sh runs `bun test scripts/test-census.test.ts` yet, because
   * wiring the census into the ladder is a decision for the review that
   * commissioned it, not for the commit that builds it.
   *
   * So this list is red in both directions. A suite that STOPS being executed
   * appears here and fails. When the census is wired in, its own entry stops
   * reproducing and this fails too — with the list to delete named in the diff.
   */
  const NEVER_RUN_TODAY = ['scripts/test-census.test.ts'];

  test('the never-run set is exactly the suites no runner claims', () => {
    const unclaimed = census.files
      .filter((row) => row.kind !== 'support' && row.runners.length === 0)
      .map((row) => row.file);
    expect(unclaimed).toEqual([...census.neverRun]);
    expect(census.neverRun).toEqual(NEVER_RUN_TODAY);
  });

  test('the anti-slop rule suites are claimed by the aggregator and nothing else', () => {
    const aggregator = census.runnerClaims
      .find((claim) => claim.name.includes('rules.test.ts'));
    expect(aggregator?.files.length).toBeGreaterThan(20);
    expect(aggregator?.files.every((file) => file.startsWith('tools/oxlint/anti-slop/rules/')))
      .toBe(true);
  });

  test('every finding names a file in the corpus and a test or file scope', () => {
    const corpus = new Set(census.files.map((row) => row.file));
    const orphans: string[] = [];
    for (const category of CATEGORIES) {
      for (const finding of census.findings[category]) {
        if (!corpus.has(finding.file) || finding.test.length === 0) {
          orphans.push(`${category} ${finding.file}`);
        }
      }
    }
    expect(orphans).toEqual([]);
  });

  test('the per-package counts sum to the per-file rows', () => {
    for (const category of CATEGORIES) {
      const fromRows = census.files.reduce((sum, row) => sum + row[category], 0);
      const fromPackages = Object.values(census.perPackage)
        .reduce((sum, bucket) => sum + (bucket[category] ?? 0), 0);
      expect(fromPackages).toBe(fromRows);
    }
  });

  test('the ratchet over the live tree is stable across two runs', () => {
    const lock = lockText(census.findings, 'live');
    expect(checkRatchet(census.findings, lock))
      .toEqual({ added: [], grown: [], stale: [] });
  });

  test('it prints its blind spots on the success path', () => {
    expect(BLIND_SPOTS.length).toBeGreaterThan(5);
    // The rejected heuristic is recorded, because its absence is itself a blind
    // spot: a test that hard-codes a source string without reading the file is
    // invisible to the surviving rule.
    expect(BLIND_SPOTS.join('\n')).toContain('REJECTED HEURISTIC');
  });
});

describe('the runner table is resolved, never listed', () => {
  test('scripts/test.sh default set is claimed and matches its four directories', () => {
    const claim = runnerClaims(tracked).find((row) => row.name === 'bash scripts/test.sh');
    expect(claim).toBeDefined();
    const roots = new Set((claim?.files ?? []).map((file) => file.split('/').slice(0, 3).join('/')));
    expect([...roots].sort()).toEqual([
      'packages/cf-backend/tests', 'packages/cli-backend/tests', 'packages/cli/tests',
      'packages/core/tests',
    ]);
  });

  test('the packages the default set omits are claimed by another runner', () => {
    // docs/TESTING.md's own admission: the default run excludes agent-utils,
    // compaction, pc-agent, devbox and the scripts gates. Each must be claimed
    // somewhere, or it is never run — which is the whole point of the table.
    const claims = runnerClaims(tracked);
    const omitted = ['packages/agent-utils/', 'packages/compaction/', 'packages/pc-agent/',
      'packages/devbox/', 'packages/test-utils/', 'scripts/', 'tests/'];
    const unclaimed: string[] = [];
    for (const prefix of omitted) {
      for (const file of tracked.filter((f) => f.startsWith(prefix) && isRunnableSuite(f))) {
        if (!claims.some((claim) => claim.files.includes(file))) unclaimed.push(file);
      }
    }
    // This census's own suite, until the ladder declares it. Same fixture, same
    // reason as `NEVER_RUN_TODAY` above: the wiring decision is the review's.
    expect(unclaimed).toEqual(['scripts/test-census.test.ts']);
  });
});

describe('the ratchet key', () => {
  test('names the category, the file, the test and the shape', () => {
    const finding: Finding = {
      file: PROBE, line: 12, test: 'the budget is 4096',
      what: 'mirrored constant', detail: 'PROMPT_BUDGET = 4096 duplicates PROMPT_BUDGET',
    };
    expect(ratchetKey('mirror', finding))
      .toBe(`mirror :: ${PROBE} :: the budget is 4096 :: mirrored constant`);
  });

  test('a merged measurement keeps every part s findings', () => {
    const one = noFindings();
    one.mirror.push({ file: PROBE, line: 1, test: 'a', what: 'mirrored constant', detail: 'x' });
    const two = noFindings();
    two.private_reach.push({ file: PROBE, line: 2, test: 'b', what: 'as any', detail: 'y' });
    const merged = mergeFindings([one, two]);
    expect(merged.mirror).toHaveLength(1);
    expect(merged.private_reach).toHaveLength(1);
  });
});

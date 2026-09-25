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
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { scratchDir } from '@kinu.run/test-utils';

import {
  BLIND_SPOTS, bannedKeys, bridgesOf, CATEGORIES, type Category, type CensusInputs, checkRatchet,
  classNonPublicMembers, type Finding, gateTests, isCensusFile, lockText, measureFile, mergeFindings,
  noFindings, nonPublicMembers, productUnitsOf, ratchetCounts, ratchetKey, runnerClaims, runCensus,
} from './test-census';
import { failedPlanted, parseLock, type Plant } from './census-plants';
import { isParseable, isRunnableSuite, isTestFile, trackedFiles } from './sources';

/* ── The seam ──────────────────────────────────────────────────────────── */

const PROBE = 'packages/probe/tests/unit-probe.test.ts';

const MODULE = 'packages/probe/src/budget.ts';

/** The module under test, as text. Its private members, its named constants and
 *  its function bodies are what the mirror and private-reach classifiers resolve
 *  against. */
const MODULE_TEXT = `
export const PROMPT_BUDGET = 4096;
export const MARKER = 'kinu-prompt-marker';
export const REFRESH_LEAD_MS = 300_000;
const TOKEN_URL = 'https://auth.example.com/v1/oauth/token';
export const refresh = (fetcher: (url: string) => void): void => { fetcher(TOKEN_URL); };
export const clampToBudget = (text: string): string => text.slice(0, PROMPT_BUDGET);
export function pendingIds(ids: readonly string[], done: ReadonlySet<string>): string[] {
  const pending: string[] = [];

  for (const id of ids) {
    if (done.has(id)) continue;
    pending.push(id.trim().toLowerCase());
  }

  return pending;
}
export class Orchestrator {
  private settleTurn(id: string): void { void id; }
  protected wakeAt = 1_800_000;
  protected armWake(): void { this.wakeAt += 1; }
  publicRead(): number { return this.wakeAt; }
}
`;

const HELPER = 'packages/probe/tests/helpers/harness.ts';

/** A ladder gate program's own test, whose subject is the tree. */
const GATE_TEST = 'scripts/probe-gate.test.ts';

/** A test helper over the module's class, one member per bridge shape. The
 *  detector reads it the way it reads every helper in the tree. */
const HELPER_TEXT = `
import { Orchestrator } from '../../src/budget';
export class ProbeHarness extends Orchestrator {
  harnessSettle(id: string): void { this.settleTurn(id); }
  observeWake(): number { return this.wakeAt; }
  get observedWake(): number { return this.wakeAt; }
  observeThroughOwn(): number { return this.observeWake(); }
  readPublic(): number { return this.publicRead(); }
  override publicRead(): number { return super.publicRead(); }
  override armWake(): void { super.armWake(); }
  protected ownHelper(): number { return this.wakeAt; }
}
`;

/** Inputs built once over a synthetic one-module tree, so a classifier is
 *  measured against a module a reader can hold in their head. */
function probeInputs(): CensusInputs {
  const sources = new Map([[MODULE, MODULE_TEXT]]);
  const bridges = bridgesOf(HELPER, HELPER_TEXT, classNonPublicMembers(sources));

  return {
    gateTests: new Set([GATE_TEST]),
    sources,
    nonPublic: nonPublicMembers(sources),
    generators: new Map([['prompt-golden.json', 'scripts/prompt-golden.ts']]),
    bridges: new Map(bridges.map((bridge) => [bridge.name, bridge])),
    productUnits: productUnitsOf(sources),
    tracked: new Set([MODULE, PROBE, HELPER]),
    scope: '@kinu.run',
  };
}

const inputs = probeInputs();

/** One fixture's findings for one category, as `line what` strings. */
function found(category: Category, body: string): readonly string[] {
  return measureFile(PROBE, body, inputs).findings[category]
    .map((finding) => `${finding.what}`);
}

/** The source_text findings that are assertions, leaving the reads aside. */
function sourceAssertions(body: string): readonly string[] {
  return found('source_text', body).filter((what) => what.startsWith('expect('));
}

/** One fixture for a category: the shape, and exactly what the census must say
 *  about it. */
interface CategoryCase {
  readonly name: string;
  readonly source: string;
  readonly expected: readonly string[];
}

function describeCategory(category: Category, cases: readonly CategoryCase[]): void {
  describe(category, () => {
    for (const fixture of cases) {
      test(fixture.name, () => {
        expect(found(category, fixture.source)).toEqual(fixture.expected);
      });
    }
  });
}

/* ── 1 + 2: red on the shape, green on its corrected form ─────────────── */

describe('source_text', () => {
  test('a gate program\'s own test reads the tree it governs, so its reads are its input', () => {
    const body = `
      import { readFileSync } from 'node:fs';
      test('the gate sees the wake', () => {
        expect(readFileSync('packages/probe/src/budget.ts', 'utf8')).toContain('this.wakeAt');
      });
    `;

    expect(measureFile(GATE_TEST, body, inputs).findings.source_text).toEqual([]);
    expect(measureFile(GATE_TEST, body, { ...inputs, gateTests: new Set() }).findings.source_text)
      .not.toEqual([]);
  });

  test('the gate tests are the `scripts/` suites a ladder row runs', () => {
    expect(gateTests(runnerClaims(trackedFiles()))).toContain('scripts/dead-code.test.ts');
  });

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

  test('RED: a read whose path is built from segments, none of which names the file', () => {
    expect(found('source_text', `
      import { readFileSync } from 'node:fs';
      import { join } from 'node:path';
      const budget = readFileSync(join(import.meta.dir, '..', 'src', 'budget.ts'), 'utf8');
      test('the budget is not restated', () => {
        expect(budget).not.toContain('8192');
      });
    `)).toEqual(['reads a source file', 'expect(<source text>).not.toContain']);
  });

  test('RED: a reader helper built on a root the suite climbs to', () => {
    expect(found('source_text', `
      import { readFileSync } from 'node:fs';
      import { join } from 'node:path';
      const root = join(import.meta.dir, '..');
      function source(path: string): string {
        return readFileSync(join(root, path), 'utf8');
      }
      test('the budget is not restated', () => {
        expect(source('src/budget.ts')).not.toContain('8192');
      });
    `)).toEqual(['reads a source file', 'expect(<source text>).not.toContain']);
  });

  test('a mutation harness executes the copy it writes: its read and the mutant\'s behaviour are not text', () => {
    expect(found('source_text', `
      import { readFileSync, writeFileSync } from 'node:fs';
      async function mutate(find: string, replace: string) {
        const source = readFileSync('../src/budget.ts', 'utf8');
        const path = '/tmp/budget.mutant.ts';
        writeFileSync(path, source.replace(find, replace));
        return await import(path);
      }
      test('RED: without the wake the budget never settles', async () => {
        const mutant = await mutate('this.wakeAt', 'null');
        expect(mutant.settle()).toBe('open');
      });
    `)).toEqual([]);
  });

  test('RED: a harness that also hands the text back is a reader', () => {
    expect(found('source_text', `
      import { readFileSync, writeFileSync } from 'node:fs';
      function copy() {
        const source = readFileSync('../src/budget.ts', 'utf8');
        writeFileSync('/tmp/budget.copy.ts', source);
        return source;
      }
      test('the copy keeps the wake', () => {
        expect(copy()).toContain('this.wakeAt');
      });
    `)).toEqual(['reads a source file', 'expect(<source text>).toContain']);
  });

  test('RED: a root spelled as a URL, read through a template', () => {
    expect(found('source_text', `
      import { readFileSync } from 'node:fs';
      const root = new URL('../', import.meta.url).pathname;
      const read = (path: string): string => readFileSync(\`\${root}\${path}\`, 'utf8');
      test('the budget is exported', () => {
        expect(read('src/budget.ts')).toContain('PROMPT_BUDGET');
      });
    `)).toEqual(['reads a source file', 'expect(<source text>).toContain']);
  });

  test('SILENT: a file under a known root that is not product source', () => {
    expect(found('source_text', `
      import { readFileSync } from 'node:fs';
      import { join } from 'node:path';
      const root = join(import.meta.dir, '..');
      test('the package names itself', () => {
        expect(JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).name).toBe('@kinu.run/probe');
      });
    `)).toEqual([]);
  });

  test('RED: an assertion over a slice of the file text', () => {
    expect(found('source_text', `
      import { readFileSync } from 'node:fs';
      const budget = readFileSync('../src/budget.ts', 'utf8');
      test('the settle runs before the wake', () => {
        const settle = budget.slice(budget.indexOf('settleTurn('));
        expect(settle.indexOf('wakeAt')).toBeGreaterThan(-1);
      });
    `)).toEqual(['reads a source file', 'expect(<source text>).toBeGreaterThan']);
  });

  test('RED: a local tree walker handed the product source directory', () => {
    expect(found('source_text', `
      import { readdirSync, readFileSync } from 'node:fs';
      import { join } from 'node:path';
      function mentions(needle: string): string[] {
        const hits: string[] = [];
        const scan = (dir: string) => {
          for (const entry of readdirSync(dir)) {
            if (readFileSync(join(dir, entry), 'utf8').includes(needle)) hits.push(entry);
          }
        };
        scan(join(import.meta.dir, '..', 'src'));
        return hits;
      }
      test('one module names the budget', () => {
        expect(mentions('PROMPT_BUDGET')).toEqual(['budget.ts']);
      });
    `)).toEqual(['reads a source file', 'expect(<source text>).toEqual']);
  });

  test('SILENT: a listing of a directory the test built for itself', () => {
    expect(found('source_text', `
      import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
      import { join } from 'node:path';
      declare const exported: string;
      test('the export writes one file', () => {
        writeFileSync(join(exported, 'src', 'budget.ts'), 'x');
        const names = readdirSync(join(exported, 'src'));
        expect(readFileSync(join(exported, 'src', names[0]), 'utf8')).toBe('x');
      });
    `)).toEqual([]);
  });

  test('SILENT: a name one test binds to a read says nothing about another test', () => {
    // Resolved per binding: `source` is a file read in one test and a template in the next.
    expect(sourceAssertions(`
      import { readFileSync } from 'node:fs';
      import { compile } from '../src/budget';
      test('the builder renders through the template', () => {
        const source = readFileSync('../src/budget.ts', 'utf8');
        expect(source.length).toBeGreaterThan(0);
      });
      test('a template renders its slots', () => {
        const source = 'A {{x}}';
        const section = compile(source);
        expect(section.render({ x: 'y' })).toBe('A y');
      });
    `)).toEqual(['expect(<source text>).toBeGreaterThan']);
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

  test('SILENT: a method name that a source slice elsewhere also binds', () => {
    // `beforeTurn` is a source-slice variable in one test and a METHOD NAME in
    // another; the member property is a name, not a read of that binding.
    expect(sourceAssertions(`
      import { readFileSync } from 'node:fs';
      import { memberBody } from '@kinu.run/test-utils';
      import { Orchestrator } from '@kinu.run/probe/budget';
      test('the slice pins the wiring', () => {
        const source = readFileSync('../src/budget.ts', 'utf8');
        const beforeTurn = memberBody(source, 'async beforeTurn(');
        expect(beforeTurn).toContain('x');
      });
      test('the turn rejects a denied caller', async () => {
        const agent = new Orchestrator();
        await expect(agent.beforeTurn({})).rejects.toMatchObject({ code: 'denied' });
      });
    `)).toEqual(['expect(<source text>).toContain']);
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

  test('RED: a constant expression folded to the value an exported constant names', () => {
    expect(found('mirror', `
      import { REFRESH_LEAD_MS } from '../src/budget';
      const LEAD_MS = 5 * 60 * 1000;
      test('a token is refreshed ahead of expiry', () => {
        expect(LEAD_MS).toBeGreaterThan(0);
      });
    `)).toEqual(['mirrored constant']);
  });

  test('GREEN: an external contract the module keeps to itself, stated by the test and asserted', () => {
    // The endpoint is the provider's fact; the test states it from outside and asserts the URL the
    // code fetched, which is the behaviour test. Importing it would make the check agree by construction.
    expect(found('mirror', `
      import { refresh } from '../src/budget';
      const TOKEN_ENDPOINT = 'https://auth.example.com/v1/oauth/token';
      test('a refresh posts to the provider token endpoint', () => {
        const fetched: string[] = [];
        refresh((url) => { fetched.push(url); });
        expect(fetched).toEqual([TOKEN_ENDPOINT]);
      });
    `)).toEqual([]);
  });

  test('RED: a test function restating a product function with its names changed', () => {
    expect(found('mirror', `
      function stillOpen(items: readonly string[], finished: ReadonlySet<string>): string[] {
        const open: string[] = [];

        for (const item of items) {
          if (finished.has(item)) continue;
          open.push(item.trim().toLowerCase());
        }

        return open;
      }
      test('a settled id is not pending', () => {
        expect(stillOpen(['a', 'b'], new Set(['a']))).toEqual(['b']);
      });
    `)).toEqual(['mirrored function']);
  });

  test('GREEN: the product function called rather than restated', () => {
    expect(found('mirror', `
      import { pendingIds } from '../src/budget';
      test('a settled id is not pending', () => {
        expect(pendingIds([' A ', 'b'], new Set(['b']))).toEqual(['a']);
      });
    `)).toEqual([]);
  });

  test('SILENT: a comment that says "mirrors" is prose, not a copy', () => {
    // The axis this replaced was a regex over comments: about half its 31 hits on
    // b2c60d09f were prose ("never mirrored into config.json"), and rewording a
    // comment cleared a hit without changing any code.
    expect(found('mirror', `
      // Mirrors the private 4096 budget; drift fails these tests.
      test('clamped', () => { expect(1).toBe(1); });
    `)).toEqual([]);
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

describeCategory('private_reach', [
  {
    name: 'RED: a bracket reach to a member production declares private',
    source: `
      import { Orchestrator } from '../src/budget';
      test('settling twice is idempotent', () => {
        const agent = new Orchestrator();
        agent['settleTurn']('t-1');
        expect(agent.publicRead()).toBe(1_800_000);
      });
    `,
    expected: ['bracket reach to a non-public member'],
  },
  {
    name: 'RED: a harness bridge that forwards to a private member',
    source: `
      import { harness } from './helpers/harness';
      test('a settled turn clears its checkpoint', async () => {
        const agent = harness();
        await agent.harnessSettle('t-1');
        expect(agent.publicRead()).toBe(1_800_000);
      });
    `,
    expected: ['harness bridge to a non-public member'],
  },
  {
    name: 'RED: the same bridge under any other name, called or read as a getter',
    source: `
      import { harness } from './helpers/harness';
      test('the wake moves', () => {
        const agent = harness();
        expect(agent.observeWake()).toBe(agent.observedWake);
      });
    `,
    expected: ['harness bridge to a non-public member', 'harness bridge to a non-public member'],
  },
  {
    name: 'RED: a bridge that reaches through another member of its own class',
    source: `
      import { harness } from './helpers/harness';
      test('the wake moves', () => {
        expect(harness().observeThroughOwn()).toBe(1_800_000);
      });
    `,
    expected: ['harness bridge to a non-public member'],
  },
  {
    name: 'RED: an override that widens a protected member to public',
    source: `
      import { harness } from './helpers/harness';
      test('arming moves the wake', () => {
        const agent = harness();
        agent.armWake();
        expect(agent.publicRead()).toBe(1_800_001);
      });
    `,
    expected: ['harness bridge to a non-public member'],
  },
  {
    name: 'SILENT: a helper accessor over the public surface, and a public override',
    source: `
      import { harness } from './helpers/harness';
      test('the wake is readable', () => {
        const agent = harness();
        expect(agent.readPublic()).toBe(agent.publicRead());
      });
    `,
    expected: [],
  },
  {
    name: 'GREEN: the same state read through the public method',
    source: `
      import { Orchestrator } from '../src/budget';
      test('the wake is readable', () => {
        expect(new Orchestrator().publicRead()).toBe(1_800_000);
      });
    `,
    expected: [],
  },
  {
    // The 22-row false-positive class: `headers['authorization']` and
    // `BACKGROUNDABLE_TOOLS['agents']` are dictionary reads, not private reaches.
    name: 'SILENT: a Record lookup by string key',
    source: `
      test('the header is sent', () => {
        expect(request.headers['authorization']).toBe('Bearer x');
        expect(BACKGROUNDABLE_TOOLS['agents']?.completion).toBe('spawn');
      });
    `,
    expected: [],
  },
]);

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
    // The 4-row false-positive class: a spy target read off the callee rather
    // than off its first argument.
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

  test('RED: a spy on our object, traced through a factory, a later assignment and a parameter', () => {
    const measured = measureFile(PROBE, `
      import { spyOn, beforeEach } from 'bun:test';
      import { Orchestrator, pendingIds } from '../src/budget';
      const { store } = pendingIds([], new Set());
      let agent: Orchestrator;
      beforeEach(() => { agent = new Orchestrator(); });
      function watch(target: Orchestrator) { return spyOn(target, 'publicRead'); }
      test('spied', () => {
        spyOn(store.rows, 'get');
        spyOn(agent, 'publicRead');
        expect(watch(agent)).toBeDefined();
      });
    `, inputs);

    expect(measured.findings.internal_mock.map((f) => f.detail))
      .toEqual(["spyOn(target, 'publicRead')", "spyOn(store.rows, 'get')", "spyOn(agent, 'publicRead')"]);
  });

  test('SILENT: a spy on a stand-in the test builds itself', () => {
    const measured = measureFile(PROBE, `
      import { spyOn, beforeEach } from 'bun:test';
      class Recorder { write(): void {} }
      const sink = { write: (line: string) => line };
      let later: { write(): void };
      beforeEach(() => { later = { write() {} }; });
      test('recorded', () => {
        spyOn(sink, 'write');
        spyOn(new Recorder(), 'write');
        spyOn(later, 'write');
        expect(1).toBe(1);
      });
    `, inputs);

    expect(measured.findings.internal_mock).toEqual([]);
    expect(measured.externalSeam).toEqual([]);
  });
});

describeCategory('tautology_suspect', [
  {
    name: 'RED: the expected side computed by the code under test',
    source: `
      import { clampToBudget } from '../src/budget';
      test('clamping is stable', () => {
        expect(clampToBudget('abc')).toBe(clampToBudget('abc'));
      });
    `,
    expected: ['expected side computed by the code under test'],
  },
  {
    name: 'RED: a test whose only assertion is toBeDefined',
    source: `
      import { clampToBudget } from '../src/budget';
      test('clamping works', () => {
        expect(clampToBudget('abc')).toBeDefined();
      });
    `,
    expected: ['weak-only test'],
  },
  {
    name: 'GREEN: an independently derived expected value',
    source: `
      import { clampToBudget } from '../src/budget';
      test('a prompt is cut at the budget', () => {
        expect(clampToBudget('x'.repeat(5000))).toHaveLength(4096);
      });
    `,
    expected: [],
  },
  {
    name: 'SILENT: toThrow carrying the message it expects',
    source: `
      import { clampToBudget } from '../src/budget';
      test('an empty prompt is refused by name', () => {
        expect(() => clampToBudget('')).toThrow('a prompt cannot be empty');
      });
    `,
    expected: [],
  },
]);

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
    // Counting the `test.each` factory as a test of its own makes every
    // table-driven suite read as assertion-free.
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
  const PLANT: Plant = { defect: 'the clamp keeps the whole prompt', file: MODULE, edits: [['text.slice(0, PROMPT_BUDGET)', 'text']] };

  const clean = measureFile(PROBE, `
    import { clampToBudget } from '../src/budget';
    test('a long prompt is cut', () => {
      expect(clampToBudget('x'.repeat(9000)).length).toBeLessThan(9000);
    });
  `, inputs).findings;

  const lock = lockText(clean, 'probe: 1 file, 1 test');

  test('a clean tree against its own lock is silent', () => {
    const verdict = checkRatchet(clean, lock);
    expect(verdict).toEqual({ banned: [], added: [], grown: [], stale: [], unproven: [] });
  });

  const reaching = measureFile(PROBE, `
    import { Orchestrator } from '../src/budget';
    test('settles', () => {
      new Orchestrator()['settleTurn']('a');
      expect(1).toBe(1);
    });
  `, inputs).findings;

  test('RED: a banned finding fails BY NAME, and no lock can hold it', () => {
    const verdict = checkRatchet(reaching, lockText(reaching, 'probe'));
    expect(verdict.banned).toHaveLength(1);
    expect(verdict.banned[0]).toContain('private_reach ::');
    expect(verdict.banned[0]).toContain(PROBE);
    expect(lockText(reaching, 'probe')).not.toContain('private_reach ::');
  });

  test('RED: a lock written before the ban does not excuse a finding it lists', () => {
    const [key = ''] = bannedKeys(reaching);
    const old = JSON.stringify({ measured: 'before the ban', entries: [{ key, count: 1 }] });
    const verdict = checkRatchet(reaching, old);
    expect(verdict.banned).toEqual([key]);
    // The old entry goes stale, so the next lock drops it.
    expect(verdict.stale).toEqual([key]);
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

  const selfCompared = (checks: readonly string[]): string => `
    import { clampToBudget } from '../src/budget';
    test('the clamp is deterministic', () => {
      ${checks.join('\n      ')}
    });
  `;

  test('RED: an injected tautology fails the ratchet BY NAME', () => {
    const injected = measureFile(PROBE, `
      import { clampToBudget } from '../src/budget';
      test('a long prompt is cut', () => {
        expect(clampToBudget('x'.repeat(9000)).length).toBeLessThan(9000);
      });
      test('the clamp is deterministic', () => {
        expect(clampToBudget('abc')).toBe(clampToBudget('abc'));
      });
    `, inputs).findings;

    const verdict = checkRatchet(injected, lock);
    expect(verdict.added).toHaveLength(1);
    expect(verdict.added[0]).toContain('tautology_suspect ::');
    expect(verdict.added[0]).toContain(PROBE);
    expect(verdict.stale).toEqual([]);
  });

  test('RED: a second self-comparison inside the SAME test is a growth, not a silence', () => {
    const once = measureFile(PROBE, selfCompared(["expect(clampToBudget('a')).toBe(clampToBudget('a'));"]), inputs).findings;

    const twice = measureFile(PROBE, selfCompared([
      "expect(clampToBudget('a')).toBe(clampToBudget('a'));",
      "expect(clampToBudget('b')).toBe(clampToBudget('b'));",
    ]), inputs).findings;

    const verdict = checkRatchet(twice, lockText(once, 'probe'));
    expect(verdict.added).toEqual([]);
    expect(verdict.grown).toHaveLength(1);
    expect(verdict.grown[0]).toContain('(1 -> 2)');
  });

  test('a removed suspect goes STALE rather than passing quietly', () => {
    const before = measureFile(PROBE, selfCompared(["expect(clampToBudget('a')).toBe(clampToBudget('a'));"]), inputs).findings;
    const after = measureFile(PROBE, selfCompared(["expect(clampToBudget('a')).toBe('a');"]), inputs).findings;

    const verdict = checkRatchet(after, lockText(before, 'probe'));
    expect(verdict.stale).toHaveLength(1);
    expect(verdict.stale[0]).toContain('tautology_suspect ::');
  });

  test('the key survives a line move, because it carries the test title', () => {
    const body = selfCompared(["expect(clampToBudget('a')).toBe(clampToBudget('a'));"]);
    const top = measureFile(PROBE, body, inputs).findings;
    const moved = measureFile(PROBE, `\n\n\n// twenty lines lower\n\n\n${body}`, inputs).findings;
    const plants = new Map([...ratchetCounts(top).keys()].map((key) => [key, [PLANT]]));
    expect(checkRatchet(moved, lockText(top, 'probe', plants)))
      .toEqual({ banned: [], added: [], grown: [], stale: [], unproven: [] });
  });

  test('RED: a locked suspect that names no plant is unproven, and a relock keeps the plants it had', () => {
    const suspect = measureFile(PROBE, selfCompared(["expect(clampToBudget('a')).toBe(clampToBudget('a'));"]), inputs).findings;
    const [key = ''] = ratchetCounts(suspect).keys();
    expect(checkRatchet(suspect, lockText(suspect, 'probe')).unproven).toEqual([key]);

    const relocked = lockText(suspect, 'relocked', new Map(parseLock(lockText(suspect, 'probe', new Map([[key, [PLANT]]])))
      .entries.map((entry) => [entry.key, entry.plants ?? []])));

    expect(parseLock(relocked).entries).toEqual([{ key, count: 1, plants: [PLANT] }]);
  });

  test('a plant reaches its test and never the tree, which every gate beside it reads', () => {
    const dir = scratchDir('census-plant');
    const module = join(dir, 'double.ts');
    const suite = join(dir, 'double.test.ts');
    const seen = join(dir, 'seen');
    const original = 'export const double = (n: number): number => n * 2;\n';
    writeFileSync(module, original);
    // The suite writes down what the tree held while the plant ran.
    writeFileSync(suite, [
      "import { test, expect } from 'bun:test';",
      "import { readFileSync, writeFileSync } from 'node:fs';",
      "import { double } from './double';",
      `writeFileSync(${JSON.stringify(seen)}, readFileSync(${JSON.stringify(module)}, 'utf8'));`,
      "test('doubles', () => { expect(double(3)).toBe(6); });",
    ].join('\n'));

    expect(failedPlanted(suite, 'doubles', module, original.replace('n * 2', 'n + 2'))).toBe(true);
    expect(readFileSync(seen, 'utf8')).toBe(original);
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
    expect(census.tree.productNonPublic).toBeGreaterThan(100);
    expect(census.tree.productFunctions).toBeGreaterThan(1000);
    expect(census.publicSurface.length).toBeGreaterThan(100);
  });

  /**
   * The never-run set, EMPTY.
   *
   * `scripts/test-census.test.ts` — this census's own suite — is claimed by the
   * push tier's gate-tests row and `deploy.sh`'s "Gate self-tests" command,
   * whose execution `deploy.test.ts` checks by set equality, so no suite in the
   * corpus goes unclaimed.
   *
   * The assertion is red in the direction that matters: a suite that STOPS
   * being executed appears here and fails by name. The reverse direction — an
   * entry that becomes claimed — has nothing to describe, because an empty list
   * cannot go stale.
   */
  const NEVER_RUN_TODAY: readonly string[] = [];

  test('the never-run set is exactly the suites no runner claims', () => {
    const unclaimed = census.files
      .filter((row) => row.kind !== 'support' && row.runners.length === 0)
      .map((row) => row.file);

    expect(unclaimed).toEqual([...census.neverRun]);
    expect(census.neverRun).toEqual([...NEVER_RUN_TODAY]);
  });

  test('the unclaimed denominator splits into the runnable half and the support half', () => {
    // THE COLUMN'S HONEST DENOMINATOR. `never_run` counts the runnable half
    // only, which is why it read 0 for every package while 50 support modules
    // were claimed by nothing at all. Both halves are asserted here so the
    // report cannot go back to printing one and implying the other.
    const byFile = new Map(census.files.map((row) => [row.file, row]));
    expect(census.unclaimed.every((file) => byFile.get(file)?.runners.length === 0)).toBe(true);
    const runnable = census.unclaimed.filter((file) => byFile.get(file)?.kind !== 'support');
    const support = census.unclaimed.filter((file) => byFile.get(file)?.kind === 'support');
    expect(runnable).toEqual([...census.neverRun]);
    // A tree with no unclaimed support module would make this vacuous, and this
    // one has fifty: every helper, fixture and probe worker no runner's glob
    // sweeps up. The report names them rather than counting them.
    expect(support.length).toBeGreaterThan(0);
    expect(support.length).toBeLessThan(census.supportOnly.length);
    expect(runnable.length + support.length).toBe(census.unclaimed.length);
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

  test('the live tree holds no banned finding, and the committed lock is exact and proven', () => {
    const lock = readFileSync(join(import.meta.dir, 'test-census.lock.json'), 'utf8');
    expect(checkRatchet(census.findings, lock))
      .toEqual({ banned: [], added: [], grown: [], stale: [], unproven: [] });
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

    // NONE, since the ladder declared this census's own suite. This read
    // `['scripts/test-census.test.ts']` for the same reason `NEVER_RUN_TODAY`
    // above did, and it is empty for the same reason: the wiring landed.
    expect(unclaimed).toEqual([]);
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

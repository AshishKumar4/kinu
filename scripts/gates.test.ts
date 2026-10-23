import { describe, expect, test } from 'bun:test';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { scratchDir } from '@kinu.run/test-utils';

import { findMovable } from './capability-parity';
import { classify, exportedDeclarations, inScope, keyOf } from './dead-code';
import { projectsImportingEffect } from './effect-diagnostics';
import {
  auditInterception, declaredSandboxClasses, nativeRoutingReasons, readInterceptionSources,
} from './egress-interception';
import { assertMeasured, reconcile, writeLock } from './gate-ratchet';
import { boundContainerClasses } from './infra-manifest';
import { configuredScanner, judgeAdvisories } from './dependency-advisory-gate';
import {
  advisoriesFor, queryAdvisories, type Exposure, type ReviewedPackage,
} from './security-scanner';

describe('dead code gate', () => {
  test('a declaration is in scope whether exported inline or later', () => {
    const names = exportedDeclarations('packages/core/src/a.ts', `
      export function inline(): void {}
      function later(): void {}
      export { later };
      export const one = 1, two = 2;
      export interface Shape { a: string }
      const unexported = 3;
    `);

    expect([...names].sort()).toEqual(['Shape', 'inline', 'later', 'one', 'two']);
  });

  test('a re-export is not a declaration', () => {
    const names = exportedDeclarations('packages/core/src/index.ts', `
      import { local } from './other';
      export { computeParetoFront, sampleParentByWeight } from './pareto';
      export type { MergePair } from './merge';
      export * from './engine';
      export { local };
    `);

    expect([...names]).toEqual([]);
  });

  test('only-a-test references is a distinct verdict from no references', () => {
    const productionOnly = new Map([
      ['packages/cf-backend/src/user/capability.ts', [
        { name: 'setTier', line: 10 },
        { name: 'orphan', line: 20 },
      ]],
    ]);

    const everywhere = new Map([
      ['packages/cf-backend/src/user/capability.ts', [{ name: 'orphan', line: 20 }]],
    ]);

    const source = `
      export function setTier(): void {}
      export function orphan(): void {}
    `;

    expect(classify(productionOnly, everywhere, () => source).map(keyOf)).toEqual([
      'packages/cf-backend/src/user/capability.ts#orphan (unreferenced)',
      'packages/cf-backend/src/user/capability.ts#setTier (test-only)',
    ]);
  });

  test('test scaffolding and script entry points are out of scope', () => {
    const finding = [{ name: 'makeSqlExec', line: 1 }];
    const source = 'export function makeSqlExec(): void {}';

    const dead = classify(
      new Map([
        ['packages/core/tests/helpers.ts', finding],
        ['packages/test-utils/src/workspace-resolution.ts', finding],
        ['scripts/eval.ts', finding],
        ['tools/oxlint/anti-slop/shared/reflect-method.ts', finding],
      ]),
      new Map(),
      () => source,
    );

    expect(dead).toEqual([]);
  });

  test('scope is product source, and it is the same predicate for files', () => {
    expect(inScope('packages/core/src/config.ts')).toBe(true);
    expect(inScope('packages/cf-backend/src/pages/HomePage.tsx')).toBe(true);
    expect(inScope('packages/test-utils/src/workspace-resolution.ts')).toBe(false);
    expect(inScope('packages/core/tests/helpers.ts')).toBe(false);
    expect(inScope('scripts/eval.ts')).toBe(false);
  });
});

describe('capability parity gate', () => {
  /* `findMovable` reads each package's real tsconfig for its path aliases, so
     these synthetic files sit at real package paths. That is deliberate: the
     alias table is the part most likely to rot, and a fixture that stubbed it
     would keep passing after `@/*` was renamed while the gate stopped seeing
     two thirds of cf-backend. */
  const shared = new Map([
    ['packages/core/src/index.ts', "import * as v from 'valibot';\nexport const x = v.string();\n"],
  ]);

  const withShared = (files: Record<string, string>): Map<string, string> =>
    new Map([...shared, ...Object.entries(files)]);

  test('a backend module importing only what core imports is reported movable', () => {
    const { movable } = findMovable(withShared({
      'packages/cf-backend/src/components/summary.ts':
        "import * as v from 'valibot';\nexport const s = v.string();\n",
    }));

    expect(movable.map((m) => m.file)).toEqual(['packages/cf-backend/src/components/summary.ts']);
    expect(movable[0].closure).toBe('cf');
  });

  /** Each file set reports nothing movable, for the reason its name gives. */
  const PINNED: readonly { readonly name: string; readonly files: Record<string, string> }[] = [
    {
      name: 'the same module is silent once it lives in a shared package',
      files: {
        'packages/core/src/summary.ts': "import * as v from 'valibot';\nexport const s = v.string();\n",
      },
    },
    {
      name: 'a platform import pins the module where it is',
      files: {
        'packages/cf-backend/src/do.ts': "import { Agent } from 'agents';\nexport const a = Agent;\n",
      },
    },
    {
      name: 'the block is transitive: a pure module importing a platform one stays put',
      files: {
        'packages/cf-backend/src/do.ts': "import { Agent } from 'agents';\nexport const a = Agent;\n",
        'packages/cf-backend/src/pure.ts': "import { a } from './do.ts';\nexport const b = a;\n",
      },
    },
    {
      name: 'a stylesheet is a real dependency a shared package cannot take',
      files: {
        'packages/cf-backend/src/styled.ts': "import './theme.css';\nexport const s = 1;\n",
      },
    },
    {
      name: 'a relative reach into node_modules is a dependency, not tracked source',
      // The live instance is nimbus-programmatic.ts: `@nimbus-sh/worker` exports
      // no `./dist/session/*` subpath, so the module is held through the
      // installed tree. The resolver must read that as a DEPENDENCY that pins
      // its importer — before this arm existed it threw `resolves to no tracked
      // source file` over a file that resolves fine at build time.
      files: {
        'packages/cf-backend/src/reach.ts':
          "export { deep } from '../../../node_modules/@x/y/dist/inner.js';\n",
      },
    },
    {
      name: "the `@/` alias resolves, so an aliased platform import still blocks",
      files: {
        'packages/cf-backend/src/do.ts': "import { Agent } from 'agents';\nexport const a = Agent;\n",
        'packages/cf-backend/src/uses.ts': "import { a } from '@/do';\nexport const b = a;\n",
      },
    },
  ];

  for (const pinned of PINNED) {
    test(pinned.name, () => {
      expect(findMovable(withShared(pinned.files)).movable).toEqual([]);
    });
  }

  test("the allowlist is derived: a library core does not use is a blocker", () => {
    const files = {
      'packages/cf-backend/src/pure.ts': "import { z } from 'zod';\nexport const s = z.string();\n",
    };

    expect(findMovable(withShared(files)).movable).toEqual([]);
    // core takes the same dependency, and the same file becomes movable — with
    // nothing about the gate edited.
    const widened = new Map(withShared(files));
    widened.set('packages/core/src/index.ts', "import { z } from 'zod';\nexport const q = z.number();\n");
    expect(findMovable(widened).movable.map((m) => m.file)).toEqual(['packages/cf-backend/src/pure.ts']);
  });

  test('an intra-package import resolving to nothing is fatal, never a pass', () => {
    // The silent version of this reports the importer as dependency-free, which
    // is the shape that turns a resolver bug into a wider finding set.
    expect(() => findMovable(withShared({
      'packages/cf-backend/src/broken.ts': "import { y } from './gone.ts';\nexport const z = y;\n",
    }))).toThrow(/resolves to no tracked source file/);
  });

  test('the resolver reports how many edges it resolved, so a broken one is visible', () => {
    const { edges } = findMovable(withShared({
      'packages/cf-backend/src/a.ts': "export const a = 1;\n",
      'packages/cf-backend/src/b.ts': "import { a } from './a.ts';\nexport const b = a;\n",
    }));

    // Exactly the one import edge above: zero means the count is not wired up,
    // and more than one means an edge is counted twice.
    expect(edges).toBe(1);
  });
});

describe('effect diagnostics gate', () => {
  test('a project is selected by an import of effect, never by a string that spells one', () => {
    // A lint rule's fixture spells the import inside a string; the service would read its project for nothing.
    const projects = [{ config: 'a/tsconfig.json', directory: 'a' }, { config: 'b/tsconfig.json', directory: 'b' }];

    const selected = projectsImportingEffect(projects, new Map([
      ['a/x.ts', "import { Effect } from 'effect';\nexport const x = Effect.void;\n"],
      ['b/rule.test.ts', 'export const code = "import { Effect } from \'effect\'; export const p = Effect.void;";\n'],
    ]));

    expect(selected.map((project) => project.config)).toEqual(['a/tsconfig.json']);
  });
});

describe('gate ratchet', () => {
  const lockPath = (keys: readonly string[]): string => {
    const path = join(scratchDir('gates-ratchet'), 'lock.json');
    writeFileSync(path, `${JSON.stringify(keys, null, 2)}\n`);

    return path;
  };

  test('a new violation is added and a fixed one goes stale', () => {
    const path = lockPath(['a', 'b']);
    expect(reconcile(['b', 'c'], path)).toEqual({ added: ['c'], stale: ['a'] });
  });

  test('an unchanged inventory reconciles empty', () => {
    const path = lockPath(['a', 'b']);
    expect(reconcile(['b', 'a'], path)).toEqual({ added: [], stale: [] });
  });

  test('a gate that scanned nothing dies instead of reporting a clean tree', () => {
    expect(() => assertMeasured('probe', [['source files', 0]]))
      .toThrow(/measured nothing \(source files is zero\)/);
    expect(() => assertMeasured('probe', [['files', 12], ['declarations', 0]]))
      .toThrow(/declarations is zero/);
  });

  test('a measured gate reports every denominator it counted', () => {
    expect(assertMeasured('probe', [['source files', 587], ['function bodies', 5818]]))
      .toBe('587 source files, 5818 function bodies');
  });

  test('the lock is written sorted and deduplicated', () => {
    const path = lockPath([]);
    expect(writeLock(['b', 'a', 'b'], path)).toBe(2);
    expect(reconcile(['a', 'b'], path)).toEqual({ added: [], stale: [] });
  });

  test('a lock that is not a list of strings is rejected, not ignored', () => {
    const path = lockPath([]);
    writeFileSync(path, '{"a":1}');
    expect(() => reconcile([], path)).toThrow(/Expected Array but received Object/);
  });
});

describe('dependency advisory gate', () => {
  const exposure = (over: Partial<Exposure> = {}): Exposure => ({
    pkg: 'valibot',
    version: '1.4.1',
    id: 1124298,
    severity: 'moderate',
    title: 'record() issue paths can make flatten() throw',
    url: 'https://github.com/advisories/GHSA-5qjj-4xww-7phc',
    range: '<=1.4.1',
    ...over,
  });

  const reviewed = {
    valibot: { reason: 'flatten() is called nowhere in tracked source', ids: [1124298] },
  } satisfies Record<string, ReviewedPackage>;

  test('an exposure the reviewed set accounts for is accepted, not reported', () => {
    expect(judgeAdvisories([exposure()], reviewed))
      .toEqual({ findings: [], accepted: 1 });
  });

  test('an advisory against a package nobody reviewed fails the gate', () => {
    const { findings, accepted } = judgeAdvisories(
      [exposure(), exposure({ pkg: 'left-pad' })],
      reviewed,
    );

    expect(accepted).toBe(1);
    expect(findings).toHaveLength(1);
    expect(findings[0]?.at).toBe('left-pad@1.4.1 — advisory 1124298');
    expect(findings[0]?.rendered).toContain('never reviewed');
  });

  // The case a per-package acceptance would swallow: the package is known, the
  // vulnerability is not.
  test('a NEW advisory against an already-reviewed package fails the gate', () => {
    const { findings, accepted } = judgeAdvisories(
      [exposure(), exposure({ id: 9999999 })],
      reviewed,
    );

    expect(accepted).toBe(1);
    expect(findings).toHaveLength(1);
    expect(findings[0]?.rendered).toContain('gained a new one');
  });

  test('a recorded advisory that stopped reproducing fails the gate too', () => {
    const { findings } = judgeAdvisories([], reviewed);
    expect(findings).toHaveLength(1);
    expect(findings[0]?.at).toBe('valibot — advisory 1124298');
    expect(findings[0]?.rendered).toContain('no matching advisory at all');
  });


  test('only a scanner under [install.security] counts as wired', () => {
    expect(configuredScanner('[install.security]\nscanner = "./scripts/security-scanner.ts"\n'))
      .toBe('./scripts/security-scanner.ts');
    // A `scanner` key in the wrong table configures nothing, and reading it as
    // wired would certify a scan bun never performs.
    expect(configuredScanner('[install]\nscanner = "./scripts/security-scanner.ts"\n'))
      .toBeUndefined();
    expect(configuredScanner('[install]\nlinker = "hoisted"\n')).toBeUndefined();
  });

  const onePackage = [{
    name: 'valibot',
    version: '1.4.1',
    requestedRange: '^1.4.1',
    tarball: 'https://registry.npmjs.org/valibot/-/valibot-1.4.1.tgz',
  }];

  // The whole offline contract. 127.0.0.1:1 refuses instantly, so this is
  // deterministic and needs no network.
  test('a feed that does not answer is unreachable, never a clean scan', async () => {
    const scan = await queryAdvisories(onePackage, 'http://127.0.0.1:1/bulk');
    expect(scan.status).toBe('unreachable');

    if (scan.status !== 'unreachable') throw new Error('unreachable expected');
    expect(scan.reason).toBe('io');
    expect(scan.error.length).toBeGreaterThan(0);
    expect(scan.scanned).toBe(1);
  });

  test('an unreachable feed yields a warn advisory, never an empty list', () => {
    const advisories = advisoriesFor({
      status: 'unreachable', scanned: 1288, reason: 'io', error: 'ConnectionRefused',
    });

    expect(advisories).toHaveLength(1);
    expect(advisories[0]?.level).toBe('warn');
    expect(advisories[0]?.description).toContain('were NOT checked');
  });

  test('a feed answering an unreadable shape is unreachable, not empty', async () => {
    const server = Bun.serve({ port: 0, fetch: () => Response.json({ valibot: 'nope' }) });

    try {
      const scan = await queryAdvisories(onePackage, server.url.href);
      expect(scan.status).toBe('unreachable');

      if (scan.status !== 'unreachable') throw new Error('unreachable expected');
      expect(scan.reason).toBe('unreadable');
    } finally {
      await server.stop(true);
    }
  });

  test('a feed answering HTTP 500 is unreachable, not empty', async () => {
    const server = Bun.serve({ port: 0, fetch: () => new Response('nope', { status: 500 }) });

    try {
      const scan = await queryAdvisories(onePackage, server.url.href);
      expect(scan.status).toBe('unreachable');

      if (scan.status !== 'unreachable') throw new Error('unreachable expected');
      expect(scan.error).toContain('500');
    } finally {
      await server.stop(true);
    }
  });

  // The feed answers per NAME once any submitted version matches, so attributing
  // an advisory to the version that actually matches is the scanner's job. Both
  // hono copies are asked about; only 4.12.23 is vulnerable.
  test('an advisory is attributed only to the versions its range matches', async () => {
    const server = Bun.serve({
      port: 0,
      fetch: () => Response.json({
        hono: [{
          id: 1123999,
          url: 'https://github.com/advisories/x',
          title: 'CORS middleware reflects any Origin',
          severity: 'high',
          vulnerable_versions: '<4.12.25',
        }],
      }),
    });

    try {
      const scan = await queryAdvisories([
        { name: 'hono', version: '4.12.23', requestedRange: '^4.11.4', tarball: 'a' },
        { name: 'hono', version: '4.13.2', requestedRange: '^4.13.0', tarball: 'b' },
      ], server.url.href);

      expect(scan.status).toBe('reported');

      if (scan.status !== 'reported') throw new Error('reported expected');
      expect(scan.exposures.map((each) => each.version)).toEqual(['4.12.23']);
    } finally {
      await server.stop(true);
    }
  });

  test('a feed that matches nothing is a clean scan, distinguishable from an outage', async () => {
    const server = Bun.serve({ port: 0, fetch: () => Response.json({}) });

    try {
      const scan = await queryAdvisories(onePackage, server.url.href);
      expect(scan).toEqual({ status: 'reported', scanned: 1, exposures: [] });
    } finally {
      await server.stop(true);
    }
  });
});

/**
 * The egress gate's denominator, over the shapes a regex reader gets wrong:
 * measuring rendered text lets a nested array truncate the container block and
 * a generic parameter hide a class — silent shrinks in a security gate's corpus
 * (2026-08-19 census).
 */
describe('egress interception denominator', () => {
  test('a container entry after an array-valued field is still counted, in every environment', () => {
    const config = join(scratchDir('egress'), 'wrangler.jsonc');
    writeFileSync(config, `{
      // a commented-out block must not count:
      // "containers": [ { "class_name": "Retired", "scheduling_policy": "durable_object" } ],
      "containers": [
        { "class_name": "A", "scheduling_policy": "durable_object", "images": { "a": { "image": "a" } } },
        { "class_name": "B", "image": "b" }
      ],
      "env": { "staging": {
        "routes": [ { "pattern": "staging.example.com", "custom_domain": true } ],
        "containers": [ { "class_name": "C", "scheduling_policy": "durable_object" } ]
      } }
    }`);
    expect(boundContainerClasses(config)).toEqual(['A', 'B', 'C']);
  });

  test('a generic container class is in the denominator', () => {
    expect(declaredSandboxClasses(new Map([
      ['packages/cf-backend/src/g.ts', 'export class Gen<T> extends Devbox<T> { run(): void {} }'],
    ]))).toEqual(['Gen']);
  });

  test('a mention in a comment or a string is not a declaration', () => {
    expect(declaredSandboxClasses(new Map([
      ['packages/cf-backend/src/c.ts',
        `// class Fake extends Devbox
export const doc = "class AlsoFake extends Devbox";`],
    ]))).toEqual([]);
  });
});

describe('native egress constraints — red in every governed direction', () => {
  const sources = readInterceptionSources();
  const base = 'packages/devbox/src/devbox.ts';
  const kinu = 'packages/cf-backend/src/kinu-devbox.ts';
  const router = 'packages/devbox/src/gateway.ts';
  const sender = 'packages/cf-backend/src/egress/send-out.ts';
  const policy = 'packages/cf-backend/src/egress/policy.ts';
  const worker = 'packages/cf-backend/src/server.ts';
  const bench = 'packages/devbox/bench/worker.ts';
  const generic = ['Devbox', 'BenchBox', 'SnapshotChainBox', 'ExampleBox'];
  const entry = sources.get(worker) ?? '';

  // A subject that occurs twice would mutate whichever comes first, which need not be the edge its constraint names:
  // on 2026-09-30 a second `internet: this.enableInternet` (the start inputs) took the router's mutation, and the
  // audit rightly found nothing broken. So a subject must name exactly one place.
  function changed(file: string, before: string, after: string): Map<string, string> {
    const original = sources.get(file);

    if (original === undefined || !original.includes(before)) throw new Error('mutation has no subject: ' + file + ' / ' + before);

    if (original.indexOf(before) !== original.lastIndexOf(before)) throw new Error('mutation subject is not unique: ' + file + ' / ' + before);

    return new Map(sources).set(file, original.replace(before, after));
  }

  function policySources(internet: boolean): Map<string, string> {
    const file = join(scratchDir('egress-policy'), 'hosts.ts');

    writeFileSync(file, `
      class Devbox { enableInternet = true; }
      export class KinuDevbox extends Devbox { enableInternet = ${internet}; }
    `);

    return new Map([[file, readFileSync(file, 'utf8')]]);
  }

  test('the private and public hosts retain their declared network policies', () => {
    expect(auditInterception(policySources(true), ['KinuDevbox'], true).violations).toEqual([]);
    expect(auditInterception(sources, generic, true).violations).toEqual([]);
    expect(nativeRoutingReasons(sources, entry)).toEqual([]);
  });

  test('closing Kinu\'s raw internet is refused', () => {
    expect(auditInterception(policySources(false), ['KinuDevbox'], true).violations).not.toEqual([]);
  });

  test('closing generic Devbox networking closes its inherited hosts and is refused', () => {
    const mutated = changed(base, 'enableInternet = true;', 'enableInternet = false;');
    expect(auditInterception(mutated, generic, true).violations.map(issue => issue.owner).sort()).toEqual([...generic].sort());
  });

  test('a benchmark-only override cannot silently remove public networking', () => {
    const mutated = changed(bench, 'class BenchBox extends Devbox<BenchEnv> {', 'class BenchBox extends Devbox<BenchEnv> { enableInternet = false;');
    expect(auditInterception(mutated, generic, true).violations.map(issue => issue.owner).sort()).toEqual(['BenchBox', 'SnapshotChainBox']);
  });

  const paths = [
    [base, 'instance: instanceOf(this.#admittedSize ?? inputs.size), enableInternet: this.enableInternet })', 'instance: instanceOf(this.#admittedSize ?? inputs.size), enableInternet: true })', 'declared internet policy'],
    [router, '.interceptAllOutboundHttp(router)', '.removedHttpRoute(router)', 'HTTP has no total'],
    [router, ".interceptOutboundHttps('*', router)", ".interceptOutboundHttps('api.example.com', router)", 'HTTPS has no total'],
    [base, 'internet: this.enableInternet,', 'internet: true,', 'router does not receive'],
    [router, 'internet: this.host.internet', 'internet: true', 'router does not receive'],
    [kinu, 'outboundPolicy()', 'removedVaultPolicy()', 'does not bind the vault'],
    [kinu, 'this.#nativeExports.KinuEgress({ props: params })', 'this.#nativeExports.KinuEvents({ props: params })', 'does not bind the vault'],
    [base, 'await this.outboundPolicy()', '{ routes: {} }', 'does not bind the vault'],
    [router, 'this.#fallback = policy.fallback', 'this.#fallback = undefined', 'does not bind the vault'],
    [worker, "return forwardEgress(request, this.env, principal, { self: exports.default, github: githubRecorder(this.env.OrchestratorAgent, this.ctx), seam: 'container' });", 'return fetch(request);', 'does not enter credential injection'],
    [sender, 'owner.resolveEgressInjection(', 'owner.unrelatedInjection(', 'does not consult the owner vault'],
    [policy, 'return yield* sendOut(request, env, authority.vault, github);', 'return yield* Effect.promise(() => fetch(request));', 'does not leave through sendOut'],
    [router, '?? outbound.fallback', '', 'owned routes do not precede'],
    [router, 'outbound.internet ?', 'true ?', 'public forwarding is not conditional'],
    [router, ": routeEgress(request, props.outbound)", ": serveStore(request, props.store, (name) => this.env[name])", 'does not route egress through its router'],
    [worker, "from '@kinu.run/devbox'", "from '@unrelated/devbox'", 'DevboxGateway is not bound'],
    [worker, 'export class KinuEgress', 'class KinuEgress', 'KinuEgress is not bound'],
  ] as const;

  for (const [file, before, after, constraint] of paths) {
    test('refuses a broken native edge: ' + constraint, () => {
      const mutated = changed(file, before, after);
      expect(nativeRoutingReasons(mutated, mutated.get(worker) ?? '').some(reason => reason.includes(constraint))).toBe(true);
    });
  }
});

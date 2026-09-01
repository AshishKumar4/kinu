/**
 * The wired gate, proven RED IN BOTH DIRECTIONS over a fixture repository the
 * shape of this one, and then held to its own denominator over the live tree.
 *
 * Both directions matter equally and for different reasons. A gate that never
 * fires is a green light over nothing; a gate that fires on a symbol a
 * production module genuinely imports through a barrel is a gate somebody
 * switches off, and every export in `packages/core` is published through
 * `src/index.ts`. So each case below adds ONE production line and asserts the
 * verdict flips.
 */

import { describe, expect, test } from 'bun:test';

import { inScope } from './dead-code';
import { readMatching, readTests } from './sources';
import {
  BLIND_SPOTS, buildGraph, builtinToolNames, findEntrypoints, findUnreached, findUnsupplied,
  isReacher, keyOf, measureFields, measureReach, type EntrypointKind,
} from './wired';

/* ── The fixture ───────────────────────────────────────────────────────── */

/** The reach table the gate roots on, in the shape the registry declares it:
 *  `native: true` is the membership rule, so the `release` row below must NOT
 *  become an entrypoint name. `BUILTIN_TOOLS` is derived from it exactly as the
 *  real registry derives it, and the fixture's tool builder iterates that. */
const REGISTRY = [
  "export const TOOL_REACH = {",
  "  run: { native: true, codemode: 'workspace' },",
  "  release: { native: false, codemode: 'release' },",
  "} as const;",
  "export const BUILTIN_TOOLS = Object.keys(TOOL_REACH)",
  "  .filter((name) => TOOL_REACH[name as keyof typeof TOOL_REACH].native);",
].join('\n');

/** A barrel over a barrel, which is how `packages/core` publishes everything:
 *  `index.ts` -> `strategy/index.ts` -> the declaring file. */
const ROOT_BARREL = `export * from './strategy/index';`;
const STRATEGY_BARREL = `export * from './provisioner';\nexport * from './wired';\nexport * from './run';`;

const PROVISIONER = `export function provisionHome(): string { return '/home/node'; }`;
const WIRED = `export function usedThroughBarrel(): string { return 'live'; }`;

const RUN = `
export interface RunDeps {
  readonly rt: string;
  /** The mission ledger a node's steps charge, when the run has one. */
  readonly mission?: string;
  readonly logger?: string;
}

export function runIt(deps: RunDeps): string {
  return deps.mission ?? deps.logger ?? deps.rt;
}
`;

/** The only entrypoint: a handler bound under a name in `BUILTIN_TOOLS`. */
function builtins(body: string): string {
  return `
import { BUILTIN_TOOLS, TOOL_REACH } from './registry';
import { usedThroughBarrel, runIt, type RunDeps } from '../index';

export function buildTools(): Record<string, unknown> {
  const tools: Record<string, unknown> = {};
  for (const name of BUILTIN_TOOLS) void TOOL_REACH[name as keyof typeof TOOL_REACH];
  tools.run = tool({ execute: async () => usedThroughBarrel() });
${body}
  return tools;
}
`;
}

const BASE = 'packages/probe/src/';

/** `path -> text`, the corpus shape every entry point in the gate takes. */
function fixture(body: string, extra: readonly (readonly [string, string])[] = []): Map<string, string> {
  return new Map([
    [`${BASE}index.ts`, ROOT_BARREL],
    [`${BASE}strategy/index.ts`, STRATEGY_BARREL],
    [`${BASE}strategy/provisioner.ts`, PROVISIONER],
    [`${BASE}strategy/wired.ts`, WIRED],
    [`${BASE}strategy/run.ts`, RUN],
    [`${BASE}tools/registry.ts`, REGISTRY],
    [`${BASE}tools/builtins.ts`, builtins(body)],
    ...extra,
  ]);
}

/** The same corpus with one file replaced — later entries win in a `Map`. */
function replacing(body: string, file: string, text: string): Map<string, string> {
  return new Map([...fixture(body), [file, text]]);
}

/** The whole pipeline over a fixture: the same calls `import.meta.main` makes. */
function census(
  reachers: ReadonlyMap<string, string>,
  tests: ReadonlyMap<string, string> = new Map(),
): string[] {
  const graph = buildGraph(reachers);
  expect(graph.dangling).toEqual([]);
  const read = (file: string): string => reachers.get(file) ?? '';
  const builtinNames = builtinToolNames(graph.modules, read);
  const entrypoints = findEntrypoints(reachers, graph.modules, builtinNames);
  const reach = measureReach(graph, entrypoints);
  const facts = measureFields(reachers);
  return [
    ...findUnreached(graph, reach, tests, read),
    ...findUnsupplied(graph, reach, facts, read),
  ].map(keyOf).sort();
}

const PROVISION_HOME = `${BASE}strategy/provisioner.ts#provisionHome (unreached-export)`;
const BARREL_SYMBOL = `${BASE}strategy/wired.ts#usedThroughBarrel (unreached-export)`;
const MISSION = `${BASE}strategy/run.ts#RunDeps.mission (unsupplied-field)`;
const LOGGER = `${BASE}strategy/run.ts#RunDeps.logger (unsupplied-field)`;

/** Every case supplies a `RunDeps`, so field findings are separable from
 *  reachability ones. `rt` is required, which is why only the two optional
 *  fields can ever be reported. */
const SUPPLY = (literal: string): string =>
  `  const deps: RunDeps = ${literal};\n  runIt(deps);`;

/* ── Red in both directions ────────────────────────────────────────────── */

describe('an exported value with no production consumer', () => {
  test('is reported, even though a barrel publishes it and a test uses it', () => {
    const tests = new Map([['packages/probe/tests/unit-home.test.ts', `
      import { provisionHome } from '../src/index';
      test('provisions', () => { expect(provisionHome()).toBe('/home/node'); });`]]);
    expect(census(fixture(SUPPLY(`{ rt: 'x', mission: 'm', logger: 'l' }`)), tests))
      .toEqual([PROVISION_HOME]);
  });

  test('is NOT reported once one production line calls it', () => {
    // The ONLY change: the entrypoint's file imports it through the same barrel
    // and calls it. Nothing about the declaration, the barrel or the test moved.
    const wired = builtins(`${SUPPLY(`{ rt: 'x', mission: 'm', logger: 'l' }`)}
  tools.home = provisionHome();`)
      .replace(`import { usedThroughBarrel,`, `import { provisionHome, usedThroughBarrel,`);
    expect(census(replacing('', `${BASE}tools/builtins.ts`, wired))).toEqual([]);
  });

  test('names the test that is its only caller, so "wire it or delete it" is sayable', () => {
    const tests = new Map([
      ['packages/probe/tests/unit-home.test.ts', 'import { provisionHome } from "../src/index";'],
    ]);
    const reachers = fixture(SUPPLY(`{ rt: 'x', mission: 'm', logger: 'l' }`));
    const graph = buildGraph(reachers);
    const read = (file: string): string => reachers.get(file) ?? '';
    const entrypoints = findEntrypoints(reachers, graph.modules, builtinToolNames(graph.modules, read));
    const [finding] = findUnreached(
      graph, measureReach(graph, entrypoints), tests, read,
    );
    expect(finding?.reason).toContain('packages/probe/tests/unit-home.test.ts');
  });
});

/* ── The false positive that would get it switched off ─────────────────── */

describe('a barrel', () => {
  test('does not hide a symbol a production module imports through it', () => {
    // `usedThroughBarrel` is declared in `strategy/wired.ts`, republished by TWO
    // `export *` hops, and imported from the ROOT barrel by the entrypoint's
    // file. Reporting it would be the false positive that makes this gate
    // untrustworthy on a codebase where every export is published this way.
    expect(census(fixture(SUPPLY(`{ rt: 'x', mission: 'm', logger: 'l' }`))))
      .not.toContain(BARREL_SYMBOL);
  });

  test('confers nothing by itself: drop the consumer and the same symbol is reported', () => {
    const orphaned = builtins(SUPPLY(`{ rt: 'x', mission: 'm', logger: 'l' }`))
      .replace('usedThroughBarrel, ', '')
      .replace('usedThroughBarrel()', 'null');
    expect(census(replacing('', `${BASE}tools/builtins.ts`, orphaned)))
      .toEqual([PROVISION_HOME, BARREL_SYMBOL]);
  });

  test('is traversed, so a symbol behind two hops is reachable at all', () => {
    // If barrels were not followed, `provisionHome` would be reported for the
    // wrong reason — an unreachable FILE rather than an unconsumed symbol — and
    // the second direction above could never go green.
    const reachers = fixture('');
    const graph = buildGraph(reachers);
    const read = (file: string): string => reachers.get(file) ?? '';
    const entrypoints = findEntrypoints(reachers, graph.modules, builtinToolNames(graph.modules, read));
    expect(measureReach(graph, entrypoints).live).toContain(`${BASE}strategy/provisioner.ts`);
  });
});

/* ── The field detector ────────────────────────────────────────────────── */

describe('an optional field production reads', () => {
  test('is reported when the interface is built and the field is not supplied', () => {
    expect(census(fixture(SUPPLY(`{ rt: 'x' }`))))
      .toEqual([PROVISION_HOME, LOGGER, MISSION]);
  });

  test('is NOT reported once a construction site supplies it', () => {
    expect(census(fixture(SUPPLY(`{ rt: 'x', mission: 'm' }`))))
      .toEqual([PROVISION_HOME, LOGGER]);
  });

  test('is NOT reported when `Object.assign` supplies it', () => {
    // Two fields of the real `SwarmRunDeps` are wired exactly this way, and were
    // false positives until this arm existed.
    const body = `${SUPPLY(`{ rt: 'x', mission: 'm' }`)}\n  Object.assign(deps, { logger: 'l' });`;
    expect(census(fixture(body))).toEqual([PROVISION_HOME]);
  });

  test('is NOT reported when a spread makes the site opaque', () => {
    const body = `${SUPPLY(`{ rt: 'x', ...overrides }`)}`;
    expect(census(fixture(body))).toEqual([PROVISION_HOME]);
  });

  test('is NOT reported when the supplying literal is returned through a ternary', () => {
    // The false positive this direction locks. `AgentOrchestrator.scopeTurn`
    // supplies `CompletedTurn.missionLabels` as
    // `labels.length === 0 ? turn : { ...turn, missionLabels: [...labels] }`,
    // and a detector reading only a ReturnStatement's DIRECT children saw no
    // construction site there at all — so a field wired at both ends was
    // reported connected at neither, which is the finding that gets a gate
    // switched off.
    const body = `  function scope(deps: RunDeps): RunDeps {
    return deps.rt === '' ? deps : { rt: 'x', mission: 'm', logger: 'l' };
  }
  void scope;
${SUPPLY(`{ rt: 'x' }`)}`;
    expect(census(fixture(body))).toEqual([PROVISION_HOME]);
  });

  test('is NOT judged at all when nothing visibly builds the interface', () => {
    // `runIt` is called with a value this gate cannot type. Guessing here is how
    // a gate earns a false positive and then a disabled line in a config.
    const body = '  runIt(fromSomewhereElse());';
    expect(census(fixture(body))).toEqual([PROVISION_HOME]);
  });
});

/* ── Entrypoints are discovered, never listed ──────────────────────────── */

const KINDS: readonly EntrypointKind[] = [
  'builtin-tool', 'callable-rpc', 'cli-command', 'platform-hook', 'module-default',
  'browser-bundle', 'process-entry',
];

function kindsOf(reachers: ReadonlyMap<string, string>): Set<EntrypointKind> {
  const graph = buildGraph(reachers);
  const read = (file: string): string => reachers.get(file) ?? '';
  const found = findEntrypoints(reachers, graph.modules, builtinToolNames(graph.modules, read));
  return new Set(found.map((entry) => entry.kind));
}

describe('entrypoint discovery', () => {
  test('finds every kind from the declaration that creates it', () => {
    expect(kindsOf(fixture('', [
      [`${BASE}rpc.ts`, `
        import { Agent } from 'agents';
        export class Orchestrator extends Agent {
          @callable()
          async listDeferredApprovals(): Promise<string[]> { return []; }
          async alarm(): Promise<void> { await this.sweep(); }
          private async sweep(): Promise<void> {}
        }`],
      [`${BASE}program.ts`, `
        import { Command } from 'commander';
        export function buildProgram(): Command {
          return new Command().command('chat').action(() => undefined);
        }`],
      [`${BASE}server.ts`, `
        export default {
          async fetch(request: Request): Promise<Response> { return route(request); },
        } satisfies ExportedHandler;`],
      [`${BASE}client.tsx`, `
        import { createRoot } from 'react-dom/client';
        createRoot(document.getElementById('root')!).render(null);`],
      [`${BASE}bin.ts`, '#!/usr/bin/env bun\nrun();'],
    ]))).toEqual(new Set(KINDS));
  });

  test('a `run` property that is not a built tool is not a tool handler', () => {
    // `run` and `file` are ordinary property names. Keying on the name alone
    // found 164 builtin-tool entrypoints on this tree over a surface of 8, and
    // every spurious one ROOTS a file, which hides findings rather than
    // inventing them.
    const kinds = kindsOf(new Map([
      [`${BASE}tools/registry.ts`, REGISTRY],
      [`${BASE}opts.ts`, `
        import { BUILTIN_TOOLS } from './tools/registry';
        export const options = { run: BUILTIN_TOOLS[0], file: 'x' };`],
    ]));
    expect(kinds.has('builtin-tool')).toBe(false);
  });

  test('a private method on a framework-rooted class is not a platform hook', () => {
    const kinds = kindsOf(new Map([
      [`${BASE}do.ts`, `
        import { DurableObject } from 'cloudflare:workers';
        export class MonitorDO extends DurableObject {
          private async helper(): Promise<void> {}
        }`],
    ]));
    expect(kinds.has('platform-hook')).toBe(false);
  });
});

/* ── The measurement cannot be quietly zero ────────────────────────────── */

describe('the analysis refuses to shrink in silence', () => {
  test('an import that resolves to no file is fatal, not a dropped edge', () => {
    // A dropped edge makes a file unreachable and every export in it a finding.
    // The `@/*` alias was exactly this: 33 specifiers in one page, 3 resolved,
    // and 95 phantom findings — every React component in the tree.
    const graph = buildGraph(new Map([[`${BASE}a.ts`, `import { b } from './nowhere';\nb();`]]));
    expect(graph.dangling).toEqual([`${BASE}a.ts -> ./nowhere`]);
  });

  test('a default export is resolved to the name its declaration carries', () => {
    // `import App from './App'` binds the DEFAULT. Without this, every
    // default-exported page component reads as unwired.
    expect(census(new Map([
      [`${BASE}tools/registry.ts`, REGISTRY],
      [`${BASE}page.tsx`, 'export default function Page(): null { return null; }'],
      [`${BASE}tools/builtins.ts`, `
        import { BUILTIN_TOOLS, TOOL_REACH } from './registry';
        import Page from '../page';
        export function buildTools(): Record<string, unknown> {
          const tools: Record<string, unknown> = { run: tool({ execute: async () => Page() }) };
          for (const name of BUILTIN_TOOLS) void TOOL_REACH[name as keyof typeof TOOL_REACH];
          return tools;
        }`],
    ]))).toEqual([]);
  });
});

/* ── Blind spots, and the live-tree denominator ────────────────────────── */

describe('over the live tree', () => {
  const reachers = readMatching(isReacher);
  const graph = buildGraph(reachers);
  const read = (file: string): string => reachers.get(file) ?? '';
  const builtinNames = builtinToolNames(graph.modules, read);
  const entrypoints = findEntrypoints(reachers, graph.modules, builtinNames);
  const reach = measureReach(graph, entrypoints);

  test('every local import resolves, so no edge is dropped', () => {
    expect(graph.dangling).toEqual([]);
  });

  test('every entrypoint kind has at least one live instance', () => {
    // The denominator. A detector that stops matching — a renamed decorator, a
    // commander upgrade, a moved registry — makes this gate more permissive and
    // nothing else would say so.
    const present = new Set(entrypoints.map((entry) => entry.kind));
    expect([...present].sort()).toEqual([...KINDS].sort());
  });

  test('the model surface, the tool names and the reach set are all non-empty', () => {
    expect(builtinNames.size).toBeGreaterThan(0);
    expect(reach.live.size).toBeGreaterThan(0);
    expect(reach.reached.size).toBeGreaterThan(0);
  });

  test('every finding sits in the set the gate governs', () => {
    const facts = measureFields(reachers);
    const findings = [
      ...findUnreached(graph, reach, readTests(), read),
      ...findUnsupplied(graph, reach, facts, read),
    ];
    expect(findings.length).toBeGreaterThan(0);
    expect(findings.filter((finding) => !inScope(finding.file))).toEqual([]);
  });

  test('no finding is also reported reached', () => {
    const findings = findUnreached(graph, reach, readTests(), read);
    const contradictions = findings
      .map((finding) => `${finding.file}#${finding.name}`)
      .filter((key) => reach.reached.has(key));
    expect(contradictions).toEqual([]);
  });

  test('every finding carries a reason, which is what the lock records', () => {
    const findings = findUnreached(graph, reach, readTests(), read);
    expect(findings.filter((finding) => finding.reason.length === 0)).toEqual([]);
  });
});

describe('blind spots', () => {
  test('each one states a VERDICT, not just a topic', () => {
    // A blind-spot list that names an area without saying whether the gate sees
    // it is a list nobody can act on. Every entry must carry one of these.
    const VERDICT = /NOT DETECTED|OUT OF SCOPE|This gate proves|LOGIC RUNS/;
    expect(BLIND_SPOTS.length).toBeGreaterThan(0);
    expect(BLIND_SPOTS.filter((spot) => !VERDICT.test(spot))).toEqual([]);
  });

  test('the three the brief names are among them', () => {
    const joined = BLIND_SPOTS.join('\n');
    expect(joined).toContain('DYNAMIC DISPATCH');
    expect(joined).toContain('CONFIG FILE');
    expect(joined).toContain('ASSIGNED AND NEVER READ');
    expect(joined).toContain('ONE ARM OF A UNION');
  });
});

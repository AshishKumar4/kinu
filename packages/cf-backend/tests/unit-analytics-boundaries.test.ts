/**
 * Defends: a deleted emit line leaves a passing suite and a silently empty dataset. Asserts
 * `FLEET_BOUNDARIES` equals the emit sites both ways, via an AST walk (text search matches comments).
 */
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { Visitor, parseSync, type Expression, type VisitorObject } from 'oxc-parser';
import * as v from 'valibot';

import { boundaryOf, eventFamily } from '@kinu.run/core/analytics';
import { AGENT_METRICS_SCHEMA, CONTROL_PLANE_OPS_SCHEMA } from '@kinu.run/core/analytics';
import * as record from '@kinu.run/core/analytics';
import type { AnalyticsEnv } from '@kinu.run/core/analytics';

const REPO = new URL('../../../', import.meta.url).pathname;

interface Captured {
  indexes?: ((ArrayBuffer | string) | null)[];
  blobs?: ((ArrayBuffer | string) | null)[];
  doubles?: number[];
}

interface CapturedPlane {
  readonly env: AnalyticsEnv;
  readonly agent: Captured[];
  readonly ops: Captured[];
}

function captureEnv(): CapturedPlane {
  const agent: Captured[] = [];
  const ops: Captured[] = [];

  return {
    agent,
    ops,
    env: {
      AGENT_METRICS: { writeDataPoint: (point?: Captured) => { agent.push(point ?? {}); } },
      CONTROL_PLANE_OPS: { writeDataPoint: (point?: Captured) => { ops.push(point ?? {}); } },
    },
  };
}

interface CallSite {
  readonly callee: string;
  readonly firstString: string | null;
}

/** ESTree string and numeric literals are both `type: 'Literal'`, so the value is parsed. */
const StringValued = v.object({ value: v.string() });

function calleeName(callee: Expression): string | null {
  if (callee.type === 'Identifier') return callee.name;

  if (callee.type === 'MemberExpression' && callee.property.type === 'Identifier') {
    return callee.property.name;
  }

  return null;
}

function callSites(file: string): readonly CallSite[] {
  const text = readFileSync(`${REPO}${file}`, 'utf8');
  const parsed = parseSync(file, text);
  const sites: CallSite[] = [];

  const visitor = new Visitor({
    CallExpression(node) {
      const callee = calleeName(node.callee);

      if (callee === null) return;
      const first = node.arguments[0];

      const literal = first !== undefined && first.type === 'Literal'
        ? v.safeParse(StringValued, first)
        : null;

      sites.push({ callee, firstString: literal?.success === true ? literal.output.value : null });
    },
  } satisfies VisitorObject);

  visitor.visit(parsed.program);

  return sites;
}

const SITES_BY_FILE: Map<string, readonly CallSite[]> = new Map();

function sitesOf(file: string): readonly CallSite[] {
  const cached = SITES_BY_FILE.get(file);

  if (cached) return cached;
  const parsed = callSites(file);
  SITES_BY_FILE.set(file, parsed);

  return parsed;
}

const BOUNDARIES_FILE = 'packages/core/src/obs/analytics/boundaries.ts';

/** `mechanism` is narrowed because the gate branches on it; a typo would silently drop a boundary. */
const BoundaryRow = v.object({
  id: v.string(),
  family: v.string(),
  event: v.string(),
  site: v.string(),
  mechanism: v.picklist(['diagnostics', 'writer']),
  emitter: v.string(),
  means: v.string(),
});

type BoundaryRow = v.InferOutput<typeof BoundaryRow>;

const StringLiteral = v.object({ type: v.literal('Literal'), value: v.string() });

const Concatenation = v.object({
  type: v.literal('BinaryExpression'),
  operator: v.literal('+'),
  left: v.unknown(),
  right: v.unknown(),
});

const ArrayLiteral = v.object({
  type: v.literal('ArrayExpression'),
  elements: v.array(v.unknown()),
});

const AsConst = v.object({ type: v.literal('TSAsExpression'), expression: v.unknown() });

const ObjectLiteral = v.object({
  type: v.literal('ObjectExpression'),
  properties: v.array(v.object({
    type: v.literal('Property'),
    key: v.object({ name: v.string() }),
    value: v.unknown(),
  })),
});

const TopLevelConst = v.object({
  type: v.literal('VariableDeclaration'),
  declarations: v.array(v.object({ id: v.object({ name: v.string() }), init: v.unknown() })),
});

/** `means` is written as a `+` concatenation, so a bare `Literal` read would miss it. */
function stringValueOf(input: { node: unknown }): string | null {
  const literal = v.safeParse(StringLiteral, input.node);

  if (literal.success) return literal.output.value;
  const joined = v.safeParse(Concatenation, input.node);

  if (!joined.success) return null;
  const left = stringValueOf({ node: joined.output.left });
  const right = stringValueOf({ node: joined.output.right });

  return left === null || right === null ? null : left + right;
}

/** Throws rather than returning empty: an empty list would make every loop vacuous. */
function declaredElements(name: string): readonly unknown[] {
  const parsed = parseSync(BOUNDARIES_FILE, readFileSync(`${REPO}${BOUNDARIES_FILE}`, 'utf8'));

  for (const statement of parsed.program.body) {
    const declaration = v.safeParse(TopLevelConst, statement);

    if (!declaration.success) continue;

    for (const declarator of declaration.output.declarations) {
      if (declarator.id.name !== name) continue;
      const unwrapped = v.safeParse(AsConst, declarator.init);

      return v.parse(ArrayLiteral, unwrapped.success ? unwrapped.output.expression : declarator.init)
        .elements;
    }
  }

  throw new Error(`${BOUNDARIES_FILE} declares no array named ${name}`);
}

/** Module-private in production (an export only this file uses is what `gate:wired` removes), so parsed. */
const FLEET_BOUNDARIES: readonly BoundaryRow[] = declaredElements('FLEET_BOUNDARIES')
  .map((element) => {
    const fields: Record<string, string> = {};

    for (const property of v.parse(ObjectLiteral, element).properties) {
      const held = stringValueOf({ node: property.value });

      if (held !== null) fields[property.key.name] = held;
    }

    return v.parse(BoundaryRow, fields);
  });

const BOUNDARY_FAMILIES: readonly string[] = declaredElements('BOUNDARY_FAMILIES')
  .map((element) => v.parse(StringLiteral, element).value);

describe('the declared boundaries are the instrumented boundaries', () => {
  test('the declaration was read, not silently read as empty', () => {
    // A recovery that yielded no rows would make every check below pass vacuously.
    expect(FLEET_BOUNDARIES.length).toBeGreaterThanOrEqual(BOUNDARY_FAMILIES.length);

    for (const boundary of FLEET_BOUNDARIES) {
      for (const field of Object.values(boundary)) expect(field).not.toBe('');
    }
  });

  test('the family set is exactly the pinned five', () => {
    expect([...BOUNDARY_FAMILIES]).toEqual(['error', 'turn', 'provider', 'job', 'release']);
    const declared = new Set<string>(FLEET_BOUNDARIES.map((b) => b.family));
    expect([...declared].sort()).toEqual([...BOUNDARY_FAMILIES].sort());
  });

  test('every family is covered by at least one boundary', () => {
    for (const family of BOUNDARY_FAMILIES) {
      const covering = FLEET_BOUNDARIES.filter((b) => b.family === family);
      expect(covering.length).toBeGreaterThan(0);
    }
  });

  test('boundary ids and event names are unique — an id is a join key into the dataset', () => {
    expect(new Set(FLEET_BOUNDARIES.map((b) => b.id)).size).toBe(FLEET_BOUNDARIES.length);
    expect(new Set(FLEET_BOUNDARIES.map((b) => b.event)).size).toBe(FLEET_BOUNDARIES.length);
  });

  test('every declared boundary calls its emitter at the file it names', () => {
    const missing: string[] = [];

    for (const boundary of FLEET_BOUNDARIES) {
      const called = sitesOf(boundary.site).some((site) => site.callee === boundary.emitter);

      if (!called) missing.push(`${boundary.id} -> ${boundary.emitter}() in ${boundary.site}`);
    }

    // Named rather than counted, so the failure says which instrument stopped.
    expect(missing).toEqual([]);
  });

  test('every diagnostics boundary emits its own declared event name at its site', () => {
    const missing: string[] = [];

    for (const boundary of FLEET_BOUNDARIES) {
      if (boundary.mechanism !== 'diagnostics') continue;
      const emitted = sitesOf(boundary.site).some((site) => site.firstString === boundary.event);

      if (!emitted) missing.push(`${boundary.id} -> '${boundary.event}' in ${boundary.site}`);
    }

    // A renamed event with the call left in place still runs and can no longer be found.
    expect(missing).toEqual([]);
  });

  test('every writer boundary has a real emitter exported from record.ts', () => {
    const exports = Object.entries(record);

    for (const boundary of FLEET_BOUNDARIES) {
      if (boundary.mechanism !== 'writer') continue;
      const found = exports.find(([name]) => name === boundary.emitter);
      // A type-only export would otherwise pass.
      expect(found).toBeDefined();
      expect(v.is(v.function(), found?.[1])).toBe(true);
    }
  });

  test('every record adapter is a declared boundary — nothing is wired undeclared', () => {
    const declared = new Set(
      FLEET_BOUNDARIES.filter((b) => b.mechanism === 'writer').map((b) => b.emitter),
    );

    const adapters = Object.keys(record).filter((name) => /^record[A-Z]/.test(name));
    // Equal, not contained: an undeclared adapter writes rows no query looks for.
    expect(adapters.slice().sort()).toEqual([...declared].sort());
  });

  test('every declared site is a real file this package ships', () => {
    for (const boundary of FLEET_BOUNDARIES) {
      expect(sitesOf(boundary.site).length).toBeGreaterThan(0);
    }
  });

  test('each boundary says what a row means, so a dataset reader needs no source', () => {
    for (const boundary of FLEET_BOUNDARIES) {
      expect(boundary.means.length).toBeGreaterThan(40);
    }
  });
});

describe('the registry is read at runtime, not only by this gate', () => {
  test('a declared event stamps its boundary id and an undeclared one stamps nothing', () => {
    for (const boundary of FLEET_BOUNDARIES) {
      expect(boundaryOf(boundary.event)).toBe(boundary.id);
    }

    // Empty: a `boundary` filter asks about the declared set only.
    expect(boundaryOf('something.undeclared')).toBe('');
  });

  test('a family is the segment before the first dot, and a bare name is its own', () => {
    expect(eventFamily('turn.settled')).toBe('turn');
    expect(eventFamily('control_plane.workspace_remove')).toBe('control_plane');
    expect(eventFamily('bare')).toBe('bare');
  });
});

/** Stops the AST half from being a proof about strings. */
describe('a writer boundary emits the event and boundary it declares', () => {
  const eventSlot = AGENT_METRICS_SCHEMA.blobs.findIndex((slot) => slot.name === 'event');
  const boundarySlot = AGENT_METRICS_SCHEMA.blobs.findIndex((slot) => slot.name === 'boundary');
  const opsOperationSlot = CONTROL_PLANE_OPS_SCHEMA.blobs.findIndex((s) => s.name === 'operation');

  test('turn.settled', () => {
    const captured = captureEnv();
    record.recordTurnRow(captured.env, {
      workspace: 'w', agentKind: 'orchestrator', provider: 'p', model: 'm',
      outcome: 'ok', code: '', durationMs: 1, steps: 1, toolCalls: 0, usage: {}, usd: undefined,
    });
    expect(captured.agent[0].blobs?.[eventSlot]).toBe('turn.settled');
    expect(captured.agent[0].blobs?.[boundarySlot]).toBe('turn.settled');
  });

  test('turn.first_token', () => {
    const captured = captureEnv();
    record.recordTtftRow(captured.env, {
      workspace: 'w', agentKind: 'orchestrator', provider: 'p', model: 'm', ttftMs: 5,
    });
    expect(captured.agent[0].blobs?.[eventSlot]).toBe('turn.first_token');
    expect(captured.agent[0].blobs?.[boundarySlot]).toBe('turn.first_token');
  });

  test('tool.settled', () => {
    const captured = captureEnv();
    record.recordToolRow(captured.env, {
      workspace: 'w', agentKind: 'orchestrator', tool: 'read', failed: false, durationMs: 1,
    });
    expect(captured.agent[0].blobs?.[eventSlot]).toBe('tool.settled');
    expect(captured.agent[0].blobs?.[boundarySlot]).toBe('tool.settled');
  });

  test('model.call', () => {
    const captured = captureEnv();
    record.recordModelRow(captured.env, {
      workspace: 'w', agentKind: 'orchestrator', provider: 'p', model: 'm',
      source: 'judge', usage: {}, usd: undefined,
    });
    expect(captured.agent[0].blobs?.[eventSlot]).toBe('model.call');
    expect(captured.agent[0].blobs?.[boundarySlot]).toBe('model.call');
  });

  test('job.settled', () => {
    const captured = captureEnv();
    record.recordJobSettled(captured.env, {
      workspace: 'w', agentKind: 'orchestrator', operation: 'cancel', outcome: 'ok',
    });
    expect(captured.agent[0].blobs?.[eventSlot]).toBe('job.settled');
    expect(captured.agent[0].blobs?.[boundarySlot]).toBe('job.settled');
  });

  test('sandbox.recovery_settled', () => {
    const captured = captureEnv();
    record.recordSandboxRecovery(captured.env, {
      workspace: 'w', stage: 'attach', outcome: 'ok', code: '', attempts: 3, durationMs: 12_000,
    });
    expect(captured.agent[0].blobs?.[eventSlot]).toBe('sandbox.recovery_settled');
    expect(captured.agent[0].blobs?.[boundarySlot]).toBe('sandbox.recovery');
  });

  test('release.transitioned', () => {
    const captured = captureEnv();
    record.recordReleaseTransition(captured.env, {
      actor: 'u', operation: 'transition', reason: 'merged', target: 'c',
      outcome: 'ok', code: '',
    });
    // The audit dataset has no `event` slot; its rows are identified by operation.
    expect(captured.agent).toHaveLength(0);
    expect(captured.ops[0].blobs?.[opsOperationSlot]).toBe('release_transition');
  });
});

/** The gate's own red direction: proves the presence checks discriminate. */
describe('the gate fails when an instrument is missing', () => {
  test('an emitter with no call site at its file is caught', () => {
    const invented = {
      emitter: 'recordSomethingNobodyCalls',
      site: 'packages/cf-backend/src/actor-agent.ts',
    };

    const called = sitesOf(invented.site).some((site) => site.callee === invented.emitter);
    expect(called).toBe(false);
  });

  test('an event name nothing emits at its file is caught', () => {
    const invented = {
      event: 'provider.error_that_was_renamed',
      site: 'packages/core/src/providers/cloudflare-ai-fetch.ts',
    };

    const emitted = sitesOf(invented.site).some((site) => site.firstString === invented.event);
    expect(emitted).toBe(false);
    // The real one is found, so the predicate is not answering false for everything.
    expect(sitesOf(invented.site).some((site) => site.firstString === 'provider.error')).toBe(true);
  });

  test('a name mentioned only in a comment or a string is not a call site', () => {
    // `boundaries.ts` names every emitter as data; a text search would report them all wired.
    const sites = sitesOf('packages/core/src/obs/analytics/boundaries.ts');

    for (const boundary of FLEET_BOUNDARIES) {
      if (boundary.mechanism !== 'writer') continue;
      expect(sites.some((site) => site.callee === boundary.emitter)).toBe(false);
    }
  });
});

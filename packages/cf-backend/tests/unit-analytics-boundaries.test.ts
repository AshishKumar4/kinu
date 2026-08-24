/**
 * The set-equality gate over the fleet event boundaries.
 *
 * ## What class of defect this exists to catch
 *
 * Instrumentation is uniquely prone to going missing without a symptom. A deleted
 * emit line leaves a passing build, a passing suite, and a dataset whose absent
 * rows read exactly like "nothing happened there" — so the failure looks like
 * good news. Nothing else in this package can see that: a unit test over an
 * adapter proves the adapter works, and proves nothing about whether anything
 * calls it.
 *
 * So this file asserts the EQUALITY the declaration claims, in both directions:
 *
 *   DECLARED ⊆ PRESENT.  Every boundary in `FLEET_BOUNDARIES` has a live emit at
 *   the file it names. Deleting the call in `actor-agent.ts` reds this.
 *
 *   PRESENT ⊆ DECLARED.  Every emitter this package exports for the purpose is
 *   declared as a boundary. Adding `recordSomethingNew` and wiring it without
 *   declaring it reds this — which is the shape that leaves a dataset with a
 *   column nobody documented and a query nobody wrote.
 *
 *   FAMILIES ARE EXACTLY THE PINNED FIVE.  A sixth family is a new question and
 *   has to be argued for rather than appear.
 *
 * ## Why the presence half is read from the AST
 *
 * "Is there a call to X in this file" is a question about SOURCE STRUCTURE, and
 * that is what a wiring assertion is for — the same job `gate:wired` does one
 * layer up. It is deliberately not a substitute for behaviour: the ROW each
 * boundary produces is asserted for real, against a fake binding, in
 * `unit-analytics-plane.test.ts` and again below where the declared event name is
 * compared with the one the adapter actually writes. Structure plus behaviour is
 * the pair; either alone is the gap this file exists to close.
 *
 * The predicate is an AST walk rather than a text search because a text search
 * matches a mention in a comment, a name inside a string, and an import that
 * nothing calls — three ways to report an instrument as wired when it is not.
 */
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { Visitor, parseSync, type VisitorObject } from 'oxc-parser';
import * as v from 'valibot';

import {
  BOUNDARY_FAMILIES, FLEET_BOUNDARIES, boundaryOf, eventFamily,
  type BoundaryFamily,
} from '../src/analytics/boundaries';
import { AGENT_METRICS_SCHEMA, CONTROL_PLANE_OPS_SCHEMA } from '../src/analytics/schemas';
import * as record from '../src/analytics/record';
import type { AnalyticsEnv } from '../src/analytics/writer';

const REPO = new URL('../../../', import.meta.url).pathname;

interface Captured {
  indexes?: ((ArrayBuffer | string) | null)[];
  blobs?: ((ArrayBuffer | string) | null)[];
  doubles?: number[];
}

/** A fake plane: the two datasets a boundary can land on, and the environment
 *  that carries them. Named because three tests destructure it. */
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

/** One call in a file: the callee's readable name, and its first argument when
 *  that argument is a plain string. `diagnostics.failure('x.y', …)` reads as
 *  `{ callee: 'failure', firstString: 'x.y' }`. */
interface CallSite {
  readonly callee: string;
  readonly firstString: string | null;
}

/**
 * A string-valued literal, parsed rather than shape-tested.
 *
 * `StringLiteral` and `NumericLiteral` are both `type: 'Literal'` in ESTree and
 * differ only in what `value` holds — a fact about the parser's output, not about
 * our types — so the question "is this argument a name" is answered by parsing
 * the value, exactly as `scripts/syntax.ts` answers it.
 */
const StringValued = v.object({ value: v.string() });

function callSites(file: string): readonly CallSite[] {
  const text = readFileSync(`${REPO}${file}`, 'utf8');
  const parsed = parseSync(file, text);
  const sites: CallSite[] = [];
  // The parser's OWN visitor rather than a hand-rolled walk: it knows which keys
  // hold children, so no node is missed and nothing has to guess at the spine.
  const visitor = new Visitor({
    CallExpression(node) {
      const callee = node.callee.type === 'Identifier'
        ? node.callee.name
        : node.callee.type === 'MemberExpression' && node.callee.property.type === 'Identifier'
          ? node.callee.property.name
          : null;
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

/** Parsed once per file: the corpus is fixed and several boundaries share a
 *  file, and re-parsing `actor-agent.ts` four times is four passes over 4,000
 *  lines for one answer. */
const SITES_BY_FILE: Map<string, readonly CallSite[]> = new Map();

function sitesOf(file: string): readonly CallSite[] {
  const cached = SITES_BY_FILE.get(file);
  if (cached) return cached;
  const parsed = callSites(file);
  SITES_BY_FILE.set(file, parsed);
  return parsed;
}

describe('the declared boundaries are the instrumented boundaries', () => {
  test('the family set is exactly the pinned five', () => {
    expect([...BOUNDARY_FAMILIES]).toEqual(['error', 'turn', 'provider', 'job', 'release']);
    const declared = new Set<BoundaryFamily>(FLEET_BOUNDARIES.map((b) => b.family));
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
    // Named rather than counted: the whole value of this gate is that the failure
    // message says which instrument stopped.
    expect(missing).toEqual([]);
  });

  test('every diagnostics boundary emits its own declared event name at its site', () => {
    const missing: string[] = [];
    for (const boundary of FLEET_BOUNDARIES) {
      if (boundary.mechanism !== 'diagnostics') continue;
      const emitted = sitesOf(boundary.site).some((site) => site.firstString === boundary.event);
      if (!emitted) missing.push(`${boundary.id} -> '${boundary.event}' in ${boundary.site}`);
    }
    // The stronger half of the check for a diagnostics boundary: `failure()` is a
    // common callee, and the EVENT NAME is what the sink routes and the dataset
    // groups by. A renamed event with the call left in place is a boundary that
    // still runs and can no longer be found.
    expect(missing).toEqual([]);
  });

  test('every writer boundary has a real emitter exported from record.ts', () => {
    const exports = Object.entries(record);
    for (const boundary of FLEET_BOUNDARIES) {
      if (boundary.mechanism !== 'writer') continue;
      const found = exports.find(([name]) => name === boundary.emitter);
      // A declared emitter that is not an exported FUNCTION is a boundary whose
      // gate would pass on a type-only export, which is the shape of an
      // instrument that was renamed and left behind.
      expect(found).toBeDefined();
      expect(v.is(v.function(), found?.[1])).toBe(true);
    }
  });

  test('every record adapter is a declared boundary — nothing is wired undeclared', () => {
    const declared = new Set(
      FLEET_BOUNDARIES.filter((b) => b.mechanism === 'writer').map((b) => b.emitter),
    );
    const adapters = Object.keys(record).filter((name) => /^record[A-Z]/.test(name));
    // Both directions, so the sets are EQUAL rather than one merely containing
    // the other: an adapter that exists and is not declared produces rows no
    // query knows to look for, and a declaration with no adapter is a gate
    // measuring nothing.
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
    // Empty rather than the event's own name: a query filtering on `boundary` is
    // asking about the DECLARED set, and widening it to every diagnostic in the
    // codebase would make the filter meaningless.
    expect(boundaryOf('something.undeclared')).toBe('');
  });

  test('a family is the segment before the first dot, and a bare name is its own', () => {
    expect(eventFamily('turn.settled')).toBe('turn');
    expect(eventFamily('control_plane.workspace_remove')).toBe('control_plane');
    expect(eventFamily('bare')).toBe('bare');
  });
});

/**
 * The declared event name against the one the adapter actually writes.
 *
 * This is what stops the AST half from being a proof about strings. A boundary
 * whose declaration and whose emitted row disagree is worse than an undeclared
 * one: the gate above passes, the dataset fills, and the id in the `boundary`
 * column matches nothing anyone declared.
 */
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

  test('release.transitioned', () => {
    const captured = captureEnv();
    record.recordReleaseTransition(captured.env, {
      actor: 'u', operation: 'transition', reason: 'merged', target: 'c',
      outcome: 'ok', code: '',
    });
    // The audit dataset has no `event` slot: a control-plane row is identified by
    // its operation, which is the dimension an audit is grouped by.
    expect(captured.agent).toHaveLength(0);
    expect(captured.ops[0].blobs?.[opsOperationSlot]).toBe('release_transition');
  });
});

/**
 * The gate's own red direction.
 *
 * A gate that cannot be made to fail is a gate nobody can trust, and this
 * repository has already found several that ran after everything they could catch
 * was deleted. These two prove the presence checks discriminate: a boundary
 * naming an emitter nothing calls, and one naming an event nothing emits, are
 * both caught — so the passing result above is a measurement rather than a
 * vacuity.
 */
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
      site: 'packages/cf-backend/src/providers/cloudflare-ai-fetch.ts',
    };
    const emitted = sitesOf(invented.site).some((site) => site.firstString === invented.event);
    expect(emitted).toBe(false);
    // And the real one IS found at that same file, so the predicate is reading
    // the file rather than answering false for everything.
    expect(sitesOf(invented.site).some((site) => site.firstString === 'provider.error')).toBe(true);
  });

  test('a name mentioned only in a comment or a string is not a call site', () => {
    // `boundaries.ts` names every emitter as DATA. If the predicate were a text
    // search it would report all of them as wired from this file alone.
    const sites = sitesOf('packages/cf-backend/src/analytics/boundaries.ts');
    for (const boundary of FLEET_BOUNDARIES) {
      if (boundary.mechanism !== 'writer') continue;
      expect(sites.some((site) => site.callee === boundary.emitter)).toBe(false);
    }
  });
});

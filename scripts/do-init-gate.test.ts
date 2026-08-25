import { describe, expect, test } from 'bun:test';

import { readSources } from './sources';
import { audit, auditFile } from './do-init-gate';

/**
 * The fixture is not invented. This is `SubordinateAgent.onStart` exactly as it
 * stood before `RpcTimeout`'s fix, recovered from the diff:
 *
 *   async onStart(): Promise<void> {
 *     this.ensureSchema();
 *     if (this.identity.read()) {
 *       if (!(await this.rt.identity.scaffold.exists())) await bootstrapScaffold(this.rt);
 *     }
 *   }
 *
 * `this.rt.identity.scaffold.exists()` reaches `env.NIMBUS_SESSION` — a second
 * Durable Object — through four hops of injected values. This is the shipped
 * defect, at full size, in its own words.
 */
const SHIPPED = `
export class SubordinateAgent extends ActorAgent {
  async onStart(): Promise<void> {
    this.ensureSchema();
    if (this.identity.read()) {
      if (!(await this.rt.identity.scaffold.exists())) await bootstrapScaffold(this.rt);
    }
  }
}
`;

/** The landed fix. */
const FIXED = `
export class SubordinateAgent extends ActorAgent {
  onStart(): void {
    this.ensureSchema();
  }
}
`;

const reasons = (src: string): string[] =>
  auditFile('subordinate-agent.ts', src).violations.map((v) => v.reason);

describe('DO init-gate purity', () => {
  test('the shipped defect is reported, on all three independent grounds', () => {
    const found = reasons(SHIPPED);
    expect(found).toHaveLength(3);
    expect(found[0]).toContain('async');
    expect(found[1]).toContain('must annotate `: void`');
    expect(found[2]).toContain('awaits in its own scope');
  });
  test('the landed fix is clean', () => {
    expect(reasons(FIXED)).toEqual([]);
  });

  // ── Each escape route from the invariant, closed ──────────────────────

  test('a missing return annotation is a violation even with no await today', () => {
    // `onStart() {}` infers `void` now and `Promise<void>` the instant someone
    // adds `async`. The base accepts `void | Promise<void>`, so tsc never
    // objects and the widening is invisible in a diff. The explicit annotation
    // is the thing `orchestrator.ts:1522` calls "the enforcement".
    expect(reasons('export class A extends Agent { onStart() { this.ensureSchema(); } }'))
      .toEqual([expect.stringContaining('must annotate `: void`')]);
  });

  test('`: Promise<void>` without `async` is still a violation', () => {
    expect(reasons('export class A extends Agent { onStart(): Promise<void> { return this.init(); } }'))
      .toEqual([expect.stringContaining('must annotate `: void`')]);
  });

  test('a nested blockConcurrencyWhile is the same gate by another name', () => {
    const sneaky = `export class A extends Agent {
      onStart(): void {
        this.ctx.blockConcurrencyWhile(async () => { await this.rt.identity.scaffold.exists(); });
      }
    }`;
    expect(reasons(sneaky)).toEqual([expect.stringContaining('nested `blockConcurrencyWhile`')]);
  });

  test('a detached async task is NOT a violation — it is the prescribed fix', () => {
    // The fix for recovery work that must reach the model is to detach it. An
    // await inside a nested async function has its own scope and cannot extend
    // the gate, so flagging it would flag the remedy.
    const detached = `export class A extends Agent {
      onStart(): void {
        this.ensureSchema();
        void (async () => { await reconcileInterruptedForks(this.rt); })();
      }
    }`;
    expect(reasons(detached)).toEqual([]);
  });

  test('a method that is not onStart is out of scope', () => {
    expect(reasons('export class A extends Agent { async beforeTurn(): Promise<void> { await this.x(); } }'))
      .toEqual([]);
  });
});

// ── The container-start hook: the same name, the opposite requirement ────────
//
// `@cloudflare/containers`' Container.onStart is awaited inside
// blockConcurrencyWhile too, but only on the container start path — never on DO
// construction and never per request. There, returning the promise is what gives
// the restore its ordering guarantee, and detaching it loses the work outright.
// So the rule inverts, and the protection is replaced rather than removed: the
// method still cannot await (it is not async), and what it returns must be
// bounded.
describe('DO init-gate purity — container-start hook', () => {
  const CORRECT = `export class KinuSandbox extends Sandbox<Env> {
    onStart(): Promise<void> {
      return withContainerStartDeadline('x', 25_000, () => this.start(), () => {});
    }
  }`;

  test('the correct shape is clean', () => {
    expect(reasons(CORRECT)).toEqual([]);
  });

  test('`: void` is the violation here — it detaches the work the gate must hold', () => {
    const detached = `export class KinuSandbox extends Sandbox<Env> {
      onStart(): void {
        void withContainerStartDeadline('x', 1, () => this.start(), () => {});
      }
    }`;
    expect(reasons(detached))
      .toEqual([expect.stringContaining('must annotate `: Promise<void>`')]);
  });

  test('unbounded work is a violation even with the right annotation', () => {
    const unbounded = `export class KinuSandbox extends Sandbox<Env> {
      onStart(): Promise<void> {
        return this.restoreWorkspace();
      }
    }`;
    expect(reasons(unbounded))
      .toEqual([expect.stringContaining('must route its work through `withContainerStartDeadline`')]);
  });

  test('`async` is still a violation — it is how an unbounded await gets in', () => {
    const widened = `export class KinuSandbox extends Sandbox<Env> {
      async onStart(): Promise<void> {
        await withContainerStartDeadline('x', 1, () => this.start(), () => {});
      }
    }`;
    expect(reasons(widened)).toEqual([
      expect.stringContaining('declared `async`'),
      expect.stringContaining('awaits in its own scope'),
    ]);
  });

  test('the narrowing is keyed on the base class, not on the file or the name', () => {
    // Same method body, a different `extends`: held to the per-request rule.
    const impostor = `export class KinuSandbox extends ActorAgent {
      onStart(): Promise<void> {
        return withContainerStartDeadline('x', 1, () => this.start(), () => {});
      }
    }`;
    expect(reasons(impostor))
      .toEqual([expect.stringContaining('must annotate `: void`')]);
  });
});

describe('DO init-gate purity, against the real tree', () => {
  const SOURCES = readSources();

  test('it inspects every onStart the backend declares, in both populations', () => {
    // The denominator. `violations: []` is only good news over a non-empty
    // `inspected`; a matcher that stopped matching would pass forever. And the
    // split matters as much as the total: the container-start rule is the
    // narrower one, so an empty container-start population would mean the
    // narrowing had quietly become an exemption over nothing.
    const { inspected } = audit(SOURCES);
    expect(inspected.map((i) => `${i.owner}:${i.hook}`).sort()).toEqual([
      'Devbox:container-start',
      'ExplorationAgent:per-request',
      'OrchestratorAgent:per-request',
      'SubordinateAgent:per-request',
    ]);
  });

  test('the real tree passes', () => {
    expect(audit(SOURCES).violations).toEqual([]);
  });

  test('cut the wire: re-adding `async` to the real orchestrator goes red', () => {
    // Against the real file, not a fixture — one token changed in memory.
    const file = 'packages/cf-backend/src/orchestrator.ts';
    const real = SOURCES.get(file);
    expect(real).toBeDefined();

    const widened = real!.replace('  onStart(): void {', '  async onStart(): Promise<void> {');
    expect(widened).not.toBe(real);
    const { violations } = auditFile(file, widened);
    expect(violations.map((v) => v.owner)).toContain('OrchestratorAgent');
    expect(violations[0]!.reason).toContain('async');
  });

  test('cut the wire: unbounding the real container hook goes red', () => {
    // The per-start arming is the reason this hook may hold the gate at all.
    // Take its budget away against the real file and the gate must say so.
    // The hook lives on Devbox since the extraction; KinuSandbox inherits it.
    const file = 'packages/devbox/src/devbox.ts';
    const real = SOURCES.get(file);
    expect(real).toBeDefined();

    const unbounded = real!.replace(
      'return withContainerStartDeadline(', 'return this.unbounded(',
    );
    expect(unbounded).not.toBe(real);
    const { violations } = auditFile(file, unbounded);
    expect(violations.map((v) => v.owner)).toEqual(['Devbox']);
    expect(violations[0]!.reason).toContain('must route its work through');
  });

  test('cut the wire: detaching the real container hook goes red', () => {
    const file = 'packages/devbox/src/devbox.ts';
    const real = SOURCES.get(file);
    const detached = real!.replace('onStart(): Promise<void> {', 'onStart(): void {');
    expect(detached).not.toBe(real);
    const { violations } = auditFile(file, detached);
    expect(violations.map((v) => v.reason))
      .toEqual([expect.stringContaining('must annotate `: Promise<void>`')]);
  });
});

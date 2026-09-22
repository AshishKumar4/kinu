import { describe, expect, test } from 'bun:test';
import { auditTracing, tracerCallSites, tracingConfigOf } from './tracing-gate';
import type { SpanObservations, TracingConfig } from './tracing-gate';
import { isProductSource, readMatching } from './sources';

const TRACED: TracingConfig = {
  label: 'wrangler.jsonc', workerName: 'kinu', tracesEnabled: true, tailConsumers: ['kinu-sink'],
};

const CLEAN: SpanObservations = {
  withSink: [{ name: 'turn', isTraced: true }],
  withoutSink: [{ name: 'turn', isTraced: false }],
};

describe('tracing — the census is derived from the product corpus', () => {
  test('a call counts, the declaration does not, and a mention in prose does not', () => {
    expect(tracerCallSites(new Map([
      ['packages/cf-backend/src/obs/cf-tracer.ts', 'export function createWorkersTracer(): Tracer { return t; }'],
      ['packages/cf-backend/src/actor-agent.ts', 'const tracing = { tracer: createWorkersTracer() };'],
      ['packages/cf-backend/src/notes.ts', '// createWorkersTracer() is what actor-agent uses\nconst text = "createWorkersTracer()";'],
    ]))).toEqual(['packages/cf-backend/src/actor-agent.ts']);
  });

  test('the live corpus holds a production call site', () => {
    expect(tracerCallSites(readMatching(isProductSource))).toContain('packages/cf-backend/src/actor-agent.ts');
  });

  test('the live config enables traces where the call site ships', () => {
    expect(tracingConfigOf('packages/cf-backend/wrangler.jsonc').tracesEnabled).toBe(true);
  });
});

describe('tracing — red in every direction it claims', () => {
  test('traces off in an environment while a call site ships is a finding', () => {
    const findings = auditTracing([{ ...TRACED, tracesEnabled: false }], 1, CLEAN);

    expect(findings).toHaveLength(1);
    expect(findings[0]).toContain('observability.traces.enabled');
  });

  test('traces off with NO call site is not a finding — nothing is dropped', () => {
    expect(auditTracing([{ ...TRACED, tracesEnabled: false }], 0, CLEAN)).toEqual([]);
  });

  test('a worker naming itself in tail_consumers is the load generator', () => {
    const findings = auditTracing([{ ...TRACED, tailConsumers: ['kinu'] }], 1, CLEAN);

    expect(findings).toHaveLength(1);
    expect(findings[0]).toContain('tail_consumers');
  });

  test('a span inert with a sink attached is a tracer that records nothing', () => {
    const findings = auditTracing([TRACED], 1, { ...CLEAN, withSink: [{ name: 'turn', isTraced: false }] });

    expect(findings).toHaveLength(1);
    expect(findings[0]).toContain('isTraced false with a tail consumer attached');
  });

  test('a span traced with NO sink is a gate that lost its discriminating power', () => {
    const findings = auditTracing([TRACED], 1, { ...CLEAN, withoutSink: [{ name: 'turn', isTraced: true }] });

    expect(findings).toHaveLength(1);
    expect(findings[0]).toContain('isTraced true with no trace consumer');
  });

  test('every direction at once is every finding at once', () => {
    expect(auditTracing(
      [{ ...TRACED, tracesEnabled: false, tailConsumers: ['kinu'] }],
      1,
      { withSink: [{ name: 'a', isTraced: false }], withoutSink: [{ name: 'a', isTraced: true }] },
    )).toHaveLength(4);
  });

  test('the corrected form is silent', () => {
    expect(auditTracing([TRACED], 1, CLEAN)).toEqual([]);
  });
});

// Backend conformance — the comparator itself, and the LLM-facing phantom
// scan.
//
// The comparator is a guard, and a guard that cannot fail is the exact defect
// class it belongs to (assertEventSequence passed every input; the broadcast
// gate once matched a producer string and called it a consumer). So the first
// tests here are falsifiability proofs: every finding kind is driven to fire
// from a fabricated observation. The per-backend harnesses that feed REAL
// observations live in packages/cf-backend and packages/cli.
import { describe, test, expect } from 'bun:test';
import {
  BACKEND_CONFORMANCE, CONFORMANCE_PLANES, CONFORMANCE_ROOTS, PLANE_UNIVERSE,
  compareSurface, normalizeObservedTables, observedActionEnum, phantomCallables,
  renderConformanceFindings,
  AGENTS_TOOL_ACTIONS, BUILTIN_TOOLS,
  type ConformanceManifest, type ObservedSurface, type RootStatuses,
} from '../src/index.ts';
import { renderForLLM } from '../src/events/hub/index.ts';
import type { ProteusEvent } from '../src/events/hub/index.ts';

// ── Falsifiability: every finding kind can fire ─────────────────────────────

function observing(planes: ObservedSurface['planes']): ObservedSurface {
  return { root: 'cli', planes };
}

describe('compareSurface can fail (canaries)', () => {
  test('declared wired but not observed → missing', () => {
    const report = compareSurface(observing({ tool: new Set(['run']) }));
    const missing = report.findings.filter((f) => f.kind === 'missing').map((f) => f.name);
    // Every tool the manifest wires on cli except `run` must be reported.
    expect(missing).toContain('execute_tools');
    expect(missing).toContain('memory');
    expect(missing).not.toContain('run');
  });

  test('observed but not declared → undeclared', () => {
    const report = compareSurface(observing({ table: new Set(['a_table_nobody_declared']) }));
    expect(report.findings.some((f) => f.kind === 'undeclared' && f.name === 'a_table_nobody_declared')).toBe(true);
  });

  test('observed but declared absent → contradicted, citing the stale reason', () => {
    const report = compareSurface(observing({ tool: new Set([...BUILTIN_TOOLS]) }));
    const contradiction = report.findings.find((f) => f.kind === 'contradicted' && f.name === 'report');
    expect(contradiction).toBeDefined();
    expect(contradiction?.staleReason).toContain('report sink');
  });

  test('an unmeasured plane is reported, never silently conformant', () => {
    const report = compareSurface(observing({ tool: new Set() }));
    expect(report.unmeasured).toEqual(['agents-action', 'memory-action', 'table']);
  });

  test('a fully conforming observation yields zero findings', () => {
    const manifest: ConformanceManifest = {
      tool: { ...BACKEND_CONFORMANCE.tool },
      'agents-action': { ...BACKEND_CONFORMANCE['agents-action'] },
      'memory-action': { ...BACKEND_CONFORMANCE['memory-action'] },
      table: {},
    };
    const wiredOnCli = (record: Readonly<Record<string, RootStatuses>>): Set<string> =>
      new Set(Object.entries(record).filter(([, s]) => 'wired' in s.cli).map(([n]) => n));
    const report = compareSurface(observing({
      tool: wiredOnCli(manifest.tool),
      'agents-action': wiredOnCli(manifest['agents-action']),
      'memory-action': wiredOnCli(manifest['memory-action']),
      table: new Set(),
    }), manifest);
    expect(renderConformanceFindings(report)).toBe('');
    expect(report.unmeasured).toEqual([]);
  });
});

// ── Manifest hygiene ────────────────────────────────────────────────────────

describe('manifest hygiene', () => {
  test('every deliberate absence names a reason', () => {
    for (const plane of CONFORMANCE_PLANES) {
      for (const [name, statuses] of Object.entries(BACKEND_CONFORMANCE[plane])) {
        for (const root of CONFORMANCE_ROOTS) {
          const status = (statuses as RootStatuses)[root];
          if ('absent' in status) {
            expect({ plane, name, root, reason: status.absent.length > 10 })
              .toEqual({ plane, name, root, reason: true });
          }
        }
      }
    }
  });

  test('the closed planes cover their registry universe exactly', () => {
    // A registry addition without a manifest decision is a compile error via
    // the Record key type; this locks the runtime view to the same truth.
    expect(Object.keys(BACKEND_CONFORMANCE.tool).sort()).toEqual([...PLANE_UNIVERSE.tool!].sort());
    expect(Object.keys(BACKEND_CONFORMANCE['agents-action']).sort()).toEqual([...AGENTS_TOOL_ACTIONS].sort());
    expect(Object.keys(BACKEND_CONFORMANCE['memory-action']).sort()).toEqual([...PLANE_UNIVERSE['memory-action']!].sort());
  });

  test('no capability is declared absent everywhere (dead declaration)', () => {
    for (const plane of CONFORMANCE_PLANES) {
      for (const [name, statuses] of Object.entries(BACKEND_CONFORMANCE[plane])) {
        const anyWired = CONFORMANCE_ROOTS.some((root) => 'wired' in (statuses as RootStatuses)[root]);
        expect({ plane, name, anyWired }).toEqual({ plane, name, anyWired: true });
      }
    }
  });
});

// ── Observation helpers ─────────────────────────────────────────────────────

describe('normalizeObservedTables', () => {
  test('drops sqlite bookkeeping and FTS5 shadows, keeps the virtual table', () => {
    const observed = normalizeObservedTables([
      'messages', 'sqlite_sequence',
      'memory_chunks_fts', 'memory_chunks_fts_data', 'memory_chunks_fts_idx',
      'memory_chunks_fts_content', 'memory_chunks_fts_docsize', 'memory_chunks_fts_config',
    ]);
    expect([...observed].sort()).toEqual(['memory_chunks_fts', 'messages']);
  });

  test('keeps a _data-suffixed real table when no virtual parent exists', () => {
    expect([...normalizeObservedTables(['telemetry_data'])]).toEqual(['telemetry_data']);
  });
});

describe('observedActionEnum', () => {
  test('reads the action enum from an ai-sdk jsonSchema wrapper', () => {
    const tool = { inputSchema: { jsonSchema: { properties: { action: { enum: ['fork', 'staff'] } } } } };
    expect([...observedActionEnum(tool)].sort()).toEqual(['fork', 'staff']);
  });
  test('an absent schema observes as empty, not as everything', () => {
    expect(observedActionEnum(undefined).size).toBe(0);
  });
});

// ── Phantom callables in LLM-facing text ────────────────────────────────────

describe('phantomCallables', () => {
  test('flags a snake_case instruction that resolves to nothing', () => {
    expect(phantomCallables('use read_external_payload(event_id) if authorized', new Set(BUILTIN_TOOLS)))
      .toEqual(['read_external_payload']);
  });
  test('accepts real tools, namespaced calls under a wired root, and prose', () => {
    const callables = new Set<string>([...BUILTIN_TOOLS, 'workspace.*']);
    const text = 'call workspace.readdir("/x"), then execute_tools(...), and run (verb) it';
    expect(phantomCallables(text, callables)).toEqual([]);
  });
});

describe('event briefs name only real callables', () => {
  // The whole point: text injected into the prompt is an API contract. Render
  // every payload-visibility branch and every variant brief the hub can emit,
  // then require each call-shaped instruction to resolve.
  const CALLABLES = new Set<string>([...BUILTIN_TOOLS, ...AGENTS_TOOL_ACTIONS.map((a) => `agents.${a}`)]);

  function eventFor(variant: ProteusEvent['variant'], payload: unknown,
    vis: ProteusEvent['payload_visibility'] = 'full'): ProteusEvent {
    return {
      id: 'eid', trace_id: 'tid', caused_by: null,
      ingress: 'webhook_hmac', variant, trust: 'authenticated',
      priority: 'normal', payload_visibility: vis,
      received_at: 0, schema_version: 1, reply_channel: null, dedupe_key: null,
      payload,
    } as ProteusEvent;
  }

  const BRIEF_SOURCES: ProteusEvent[] = [
    eventFor('chat', { text: 'hello' }),
    eventFor('webhook', { http_method: 'POST', body: { ok: true }, webhook_id: 'w', http_headers: {}, delivery_id: 'd' }),
    eventFor('webhook', { _visibility: 'hash', sha256: 'ab'.repeat(32), size: 9 }, 'hash'),
    eventFor('webhook', { _visibility: 'hmac', size: 9 }, 'hmac'),
    eventFor('webhook', { _visibility: 'opaque_handle', handle: 'opaque:abcd' }, 'opaque_handle'),
    eventFor('process_done', { command: 'ls', exit_code: 1, stderr_excerpt: 'boom' }),
    eventFor('timer', { label: 'nightly' }),
    eventFor('peer_agent', { topic: 'sync', body: 'text', from_agent_name: 'peer' }),
    eventFor('subordinate_task', { kind: 'assignment', body: 'do the thing', from_workspace: 'ws' }),
    eventFor('subordinate_report', { status: 'completed', content: 'done', from_subordinate: 'sub' }),
    eventFor('email', { from: 'a@b.c', subject: 's', body_text: 'hi' }),
  ];

  test('every rendered brief is free of phantom callables', () => {
    for (const event of BRIEF_SOURCES) {
      const { brief } = renderForLLM(event);
      expect({ variant: event.variant, vis: event.payload_visibility, phantoms: phantomCallables(brief, CALLABLES) })
        .toEqual({ variant: event.variant, vis: event.payload_visibility, phantoms: [] });
    }
  });

  test('the scan sees the brief surface at all (guards the guard)', () => {
    // If renderForLLM's shape changes so briefs go empty, the phantom test
    // above would pass while checking nothing.
    const briefs = BRIEF_SOURCES.map((e) => renderForLLM(e).brief);
    expect(briefs.filter((b) => b.length > 0).length).toBeGreaterThanOrEqual(9);
  });
});

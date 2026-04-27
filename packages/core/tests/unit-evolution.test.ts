/**
 * Unit tests for the EvolutionEngine — 3 timescales of auto-evolution.
 */

import { describe, test, expect } from 'bun:test';
import { createTestRuntime } from './helpers.js';
import { EvolutionEngine, type EvolutionEvent, type CompletedTurn, type CompletedSession } from '../src/evolution/index.js';
import { initSearchTables } from '../src/mcts/schemas.js';
import { initScaffoldTables } from '../src/scaffold/schemas.js';
import { initCraftScoreTables } from '../src/craft/schemas.js';

function makeTurn(overrides: Partial<CompletedTurn> = {}): CompletedTurn {
  return {
    userMessage: 'test question',
    assistantResponse: 'test response that is long enough to have substance in it for quality assessment',
    toolCalls: [],
    steps: 1,
    durationMs: 5000,
    feedback: null,
    hadError: false,
    ...overrides,
  };
}

describe('EvolutionEngine — Turn-level', () => {
  test('emits reflection on low-quality turn (error)', async () => {
    const { rt } = createTestRuntime();
    const engine = new EvolutionEngine(rt);

    const events: EvolutionEvent[] = [];
    engine.onEvent(e => events.push(e));

    await engine.onTurnComplete(makeTurn({ hadError: true }));

    const reflections = events.filter(e => e.type === 'reflection');
    expect(reflections.length).toBeGreaterThanOrEqual(1);
  });

  test('emits reflection on negative feedback', async () => {
    const { rt } = createTestRuntime();
    const engine = new EvolutionEngine(rt);

    const events: EvolutionEvent[] = [];
    engine.onEvent(e => events.push(e));

    await engine.onTurnComplete(makeTurn({ feedback: 'negative' }));

    expect(events.some(e => e.type === 'reflection')).toBe(true);
  });

  test('does NOT emit reflection on high-quality turn', async () => {
    const { rt } = createTestRuntime();
    const engine = new EvolutionEngine(rt);

    const events: EvolutionEvent[] = [];
    engine.onEvent(e => events.push(e));

    await engine.onTurnComplete(makeTurn({
      feedback: 'positive',
      assistantResponse: 'A comprehensive, well-structured answer that addresses all points.',
    }));

    expect(events.filter(e => e.type === 'reflection')).toHaveLength(0);
  });

  test('extracts pattern on high-quality turn with tool calls', async () => {
    const { rt } = createTestRuntime({
      llmResponses: {
        'Extract a reusable pattern': '{"name":"compute_value","description":"Execute code and return result","params":{"type":"object","properties":{"code":{"type":"string"}},"required":["code"]},"code":"async (args) => { return eval(args.code); }"}',
      },
    });
    initCraftScoreTables(rt.storage.execRaw);

    const engine = new EvolutionEngine(rt, { turnCraftThreshold: 0.7 });

    const events: EvolutionEvent[] = [];
    engine.onEvent(e => events.push(e));

    await engine.onTurnComplete(makeTurn({
      feedback: 'positive',
      toolCalls: [
        { name: 'search_memory', args: { query: 'test' }, result: [] },
        { name: 'execute_tools', args: { code: 'return 42' }, result: 42 },
      ],
    }));

    // Should extract a pattern since quality is high and tools were used
    expect(events.some(e => e.type === 'craft_discovered')).toBe(true);
  });

  test('stores reflection in memory/MEMORY.md', async () => {
    const { rt } = createTestRuntime();
    const engine = new EvolutionEngine(rt);

    await engine.onTurnComplete(makeTurn({ hadError: true }));

    const memory = await rt.memory.read('memory/MEMORY.md');
    expect(memory).toContain('Lesson');
  });

  test('respects enabled=false config', async () => {
    const { rt } = createTestRuntime();
    const engine = new EvolutionEngine(rt, { enabled: false });

    const events: EvolutionEvent[] = [];
    engine.onEvent(e => events.push(e));

    await engine.onTurnComplete(makeTurn({ hadError: true }));
    expect(events).toHaveLength(0);
  });
});

describe('EvolutionEngine — Session-level', () => {
  test('triggers session reflection after N turns', async () => {
    const { rt } = createTestRuntime();
    // Set interval to 3 turns for testing
    const engine = new EvolutionEngine(rt, { sessionReflectionInterval: 3 });

    const events: EvolutionEvent[] = [];
    engine.onEvent(e => events.push(e));

    // First store some lessons so reflection has content
    await rt.memory.append('memory/MEMORY.md', '\n### Lesson\nPrevious lesson content\n');

    // Send 3 normal turns
    for (let i = 0; i < 3; i++) {
      await engine.onTurnComplete(makeTurn({ feedback: 'positive' }));
    }

    // Session reflection should have been triggered
    const memory = await rt.memory.read('memory/MEMORY.md');
    expect(memory).toContain('Session reflection');
  });

  test('onSessionComplete tracks conversation count', async () => {
    const { rt } = createTestRuntime();
    const engine = new EvolutionEngine(rt, { lifetimeEvolutionInterval: 100 });

    const session: CompletedSession = {
      sessionId: 'test',
      turns: [makeTurn(), makeTurn(), makeTurn()],
      startedAt: Date.now() - 60000,
      endedAt: Date.now(),
    };

    // Should not crash
    await engine.onSessionComplete(session);
  });
});

describe('EvolutionEngine — Lifetime-level', () => {
  test('runs CraftStore consolidation', async () => {
    const { rt } = createTestRuntime();
    initSearchTables(rt.storage.execRaw);
    initScaffoldTables(rt.storage.execRaw);
    initCraftScoreTables(rt.storage.execRaw);

    const engine = new EvolutionEngine(rt);

    const events: EvolutionEvent[] = [];
    engine.onEvent(e => events.push(e));

    await engine.onLifetimeEvolution();

    expect(events.some(e => e.type === 'consolidation')).toBe(true);
  });
});

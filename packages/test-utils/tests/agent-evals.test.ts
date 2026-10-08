/**
 * Each scorer: a pass, its defect going red, and an empty store reporting a zero
 * denominator rather than a pass.
 */
import { describe, test, expect } from 'bun:test';
import { initRunEventTables, type ActorHandle, type JsonObject } from '@kinu.run/core';
import { createTestSql, testActorHandle, type TestSql } from '../src/sql';
import {
  BEHAVIOUR_SCORERS, completionHonesty, craftReuse, editLanding,
  recoveryDurability,
  spillRetrieval, steeringConversion, toolOutcomes,
} from '../src/agent-evals';

/** A run-event store bound to one actor. */
type EventStore = TestSql & { actor: ActorHandle };

function eventStore(): EventStore {
  const store = createTestSql();
  initRunEventTables(store.execRaw);

  return { ...store, actor: testActorHandle(store.sql) };
}

let eventIndex = 0;

/**
 * Payload is the whole stamped event `{...input, eventIndex, runId, timestamp}`, as
 * `RunEventRecorder` writes it; type fields alone pass `json_extract` but fail the canonical parse.
 */
function emit(
  store: EventStore, runId: string, type: string, payload: JsonObject,
): void {
  eventIndex += 1;

  const event = {
    ...payload, type, runId, eventIndex, timestamp: new Date().toISOString(),
  };

  void store.sql`INSERT INTO run_events (actor_id, run_id, event_index, type, payload, ts)
    VALUES (${store.actor.actorId}, ${runId}, ${eventIndex}, ${type},
            ${JSON.stringify(event)}, ${event.timestamp})`;
}

describe('BEHAVIOUR_SCORERS — the panel contract', () => {
  test('every scorer is uniquely named and reports a null rate over an empty store', () => {
    const store = eventStore();
    const names = BEHAVIOUR_SCORERS.map((s) => s.name);
    expect(new Set(names).size).toBe(names.length);
    expect(BEHAVIOUR_SCORERS.length).toBeGreaterThanOrEqual(6);

    for (const scorer of BEHAVIOUR_SCORERS) {
      const score = scorer.score(store.sql, store.actor);
      expect(score.eligible, `${scorer.name} denominator`).toBe(0);
      expect(score.passed, `${scorer.name} numerator`).toBe(0);
      // Absent is not zero.
      expect(score.rate, `${scorer.name} rate`).toBeNull();
      expect(scorer.asserts.length, `${scorer.name} asserts`).toBeGreaterThan(0);
    }

    store.close();
  });

  test('a rate is never reported above 1, so paired statistics stay well-formed', () => {
    const store = eventStore();
    // followUps deliberately exceeds referenced: one spill address cited twice.
    emit(store, 'run-a', 'context_budget', {
      admittedChars: 10, omittedChars: 900, trips: { run: 1 },
      referenced: 1, followUps: 3,
    });
    const score = spillRetrieval.score(store.sql, store.actor);
    expect(score.eligible).toBe(1);
    expect(score.rate).toBe(1);
    store.close();
  });
});

describe('steeringConversion — every mechanical trigger', () => {
  test('a repeat-breaker steer that converted is counted', () => {
    const store = eventStore();
    emit(store, 'run-a', 'turn_steering', { trigger: 'repeated_call', step: 3, tool: 'shell', converted: true });
    emit(store, 'run-a', 'turn_steering', { trigger: 'no_progress', step: 9, converted: true });

    expect(steeringConversion.score(store.sql, store.actor).rate).toBe(1);
    store.close();
  });

  test('RED: steers that fired and did not convert score below 1', () => {
    const store = eventStore();

    for (let i = 0; i < 3; i++) {
      emit(store, `run-${String(i)}`, 'turn_steering', {
        trigger: 'repeated_failure', step: 5, tool: 'shell', converted: false,
      });
    }

    emit(store, 'run-x', 'turn_steering', { trigger: 'repeated_failure', step: 5, tool: 'shell', converted: true });

    const score = steeringConversion.score(store.sql, store.actor);
    expect(score.eligible).toBe(4);
    expect(score.passed).toBe(1);
    expect(score.rate).toBe(0.25);
    store.close();
  });

  test('a trigger outside the producer picklist THROWS rather than vanishing', () => {
    // `trigger` is a picklist, so a trigger missing from the schema throws instead of silently
    // dropping out of this denominator.
    const store = eventStore();
    emit(store, 'run-a', 'turn_steering', { trigger: 'some_future_trigger', step: 1, converted: false });
    expect(() => steeringConversion.score(store.sql, store.actor))
      .toThrow(/Invalid type: Expected \("repeated_call" \| "repeated_failure" \| "no_progress"\) but received "some_future_trigger"/);
    store.close();
  });

  test('a malformed row of an UNRELATED type does not break this scorer', () => {
    // Scorers narrow by type in SQL first, so a corrupt `step_finish` costs one number, not eight.
    const store = eventStore();
    emit(store, 'run-a', 'turn_steering', { trigger: 'no_progress', step: 2, converted: true });
    void store.sql`INSERT INTO run_events (actor_id, run_id, event_index, type, payload, ts)
      VALUES (${store.actor.actorId}, ${'run-a'}, ${9_999}, ${'step_finish'},
              ${'{"type":"step_finish","nonsense":true}'}, ${'t'})`;

    const score = steeringConversion.score(store.sql, store.actor);

    expect(score.eligible).toBe(1);
    expect(score.passed).toBe(1);
    expect(toolOutcomes.score(store.sql, store.actor).eligible).toBe(0);
    store.close();
  });
});

describe('craftReuse — the in-episode loop closing', () => {
  test('crafted then reused scores over the tools crafted, not the turns', () => {
    const store = eventStore();
    emit(store, 'run-a', 'craft_cycle', {
      crafted: ['grep_imports', 'count_todos'], invoked: ['grep_imports'],
      reused: ['grep_imports'], returned: 1, raised: 0, dropped: [],
    });
    const score = craftReuse.score(store.sql, store.actor);
    expect(score.eligible).toBe(2);
    expect(score.passed).toBe(1);
    expect(score.rate).toBe(0.5);
    store.close();
  });

  test('RED: a tool crafted and never reached for again scores zero over a real denominator', () => {
    const store = eventStore();
    emit(store, 'run-a', 'craft_cycle', {
      crafted: ['write_only'], invoked: [], reused: [], returned: 0, raised: 0, dropped: [],
    });
    const score = craftReuse.score(store.sql, store.actor);
    expect(score.eligible).toBe(1);
    expect(score.passed).toBe(0);
    expect(score.rate).toBe(0);
    store.close();
  });

  test('a turn that only invoked a previously-crafted tool crafts no new denominator', () => {
    const store = eventStore();
    emit(store, 'run-a', 'craft_cycle', {
      crafted: [], invoked: ['from_last_turn'], reused: [], returned: 1, raised: 0, dropped: [],
    });
    const score = craftReuse.score(store.sql, store.actor);
    expect(score.eligible).toBe(0);
    expect(score.rate).toBeNull();
    expect(score.detail).toContain('1 crafted-tool invocations');
    store.close();
  });
});

describe('editLanding — did the edit actually land', () => {
  test('applied over attempted, with the dominant failure mode named', () => {
    const store = eventStore();
    emit(store, 'run-a', 'file_edit', {
      attempts: 4, applied: 3, failures: { not_found: 1 },
      recoveredPaths: 1, abandonedPaths: 0,
    });
    const score = editLanding.score(store.sql, store.actor);
    expect(score.eligible).toBe(4);
    expect(score.passed).toBe(3);
    expect(score.detail).toContain('not_found×1');
    store.close();
  });

  test('RED: a turn that attempted edits and landed none scores zero, not null', () => {
    const store = eventStore();
    emit(store, 'run-a', 'file_edit', {
      attempts: 5, applied: 0, failures: { stale: 3, ambiguous: 2 },
      recoveredPaths: 0, abandonedPaths: 2,
    });
    const score = editLanding.score(store.sql, store.actor);
    expect(score.eligible).toBe(5);
    expect(score.passed).toBe(0);
    expect(score.rate).toBe(0);
    expect(score.detail).toContain('stale×3');
    expect(score.detail).toContain('2 paths abandoned');
    store.close();
  });
});

describe('recoveryDurability — the recovery that TOOK', () => {
  test('a finding whose signature never recurs holds', () => {
    const store = eventStore();
    emit(store, 'run-a', 'execution_recovery', {
      recoveries: [{ tool: 'shell', failures: 3, failedSignature: 'run:bun test x' }],
    });
    const score = recoveryDurability.score(store.sql, store.actor);
    expect(score.eligible).toBe(1);
    expect(score.passed).toBe(1);
    expect(score.detail).toContain('3 consecutive failures absorbed');
    store.close();
  });

  test('RED: the same signature failing again in a LATER turn scores the finding red', () => {
    // The producer's named falsifier: without it, recoveries-over-recoveries is 1.00 on every run.
    const store = eventStore();
    emit(store, 'run-a', 'execution_recovery', {
      recoveries: [{ tool: 'shell', failures: 2, failedSignature: 'run:pytest -q' }],
    });
    emit(store, 'run-a', 'execution_recovery', {
      recoveries: [{ tool: 'shell', failures: 4, failedSignature: 'run:pytest -q' }],
    });
    const score = recoveryDurability.score(store.sql, store.actor);
    expect(score.eligible).toBe(1);
    expect(score.passed).toBe(0);
    expect(score.rate).toBe(0);
    expect(score.detail).toContain('1 signatures failed again later');
    store.close();
  });

  test('the same signature under a DIFFERENT tool is a different finding', () => {
    const store = eventStore();
    emit(store, 'run-a', 'execution_recovery', {
      recoveries: [
        { tool: 'shell', failures: 1, failedSignature: 'same' },
        { tool: 'file', failures: 1, failedSignature: 'same' },
      ],
    });
    const score = recoveryDurability.score(store.sql, store.actor);
    expect(score.eligible).toBe(2);
    expect(score.passed).toBe(2);
    store.close();
  });
});

describe('completionHonesty — polarity is the reverse of every other scorer', () => {
  test('a gate that found no work left is the PASS', () => {
    const store = eventStore();
    emit(store, 'run-a', 'completion_gate', { converted: false });
    const score = completionHonesty.score(store.sql, store.actor);
    expect(score.eligible).toBe(1);
    expect(score.passed).toBe(1);
    expect(score.detail).toContain('0 were forced back to work');
    store.close();
  });

  test('RED: converted=true means it claimed done with work left, and must score red', () => {
    // Converted-as-numerator would reward declaring victory early.
    const store = eventStore();
    emit(store, 'run-a', 'completion_gate', { converted: true });
    emit(store, 'run-b', 'completion_gate', { converted: true });
    emit(store, 'run-c', 'completion_gate', { converted: false });
    const score = completionHonesty.score(store.sql, store.actor);
    expect(score.eligible).toBe(3);
    expect(score.passed).toBe(1);
    expect(score.rate).toBeCloseTo(1 / 3);
    expect(score.detail).toContain('2 were forced back to work');
    store.close();
  });
});

describe('spillRetrieval — spilled context read back', () => {
  test('a follow-up against a readable spill passes', () => {
    const store = eventStore();
    emit(store, 'run-a', 'context_budget', {
      admittedChars: 1_000, omittedChars: 40_000, trips: { run: 2 },
      referenced: 2, followUps: 2,
    });
    const score = spillRetrieval.score(store.sql, store.actor);
    expect(score.eligible).toBe(2);
    expect(score.passed).toBe(2);
    expect(score.detail).toContain('40000 chars withheld');
    store.close();
  });

  test('RED: a readable spill the agent never fetched scores zero', () => {
    const store = eventStore();
    emit(store, 'run-a', 'context_budget', {
      admittedChars: 500, omittedChars: 80_000, trips: { run: 3 },
      referenced: 3, followUps: 0,
    });
    const score = spillRetrieval.score(store.sql, store.actor);
    expect(score.eligible).toBe(3);
    expect(score.passed).toBe(0);
    expect(score.rate).toBe(0);
    store.close();
  });

  test('a spill with no resolvable address is excluded, not charged to the agent', () => {
    // Nothing to read back is a harness failure, not the model's.
    const store = eventStore();
    emit(store, 'run-a', 'context_budget', {
      admittedChars: 0, omittedChars: 9_000, trips: { attachment: 1 },
      referenced: 0, followUps: 0,
    });
    const score = spillRetrieval.score(store.sql, store.actor);
    expect(score.eligible).toBe(0);
    expect(score.rate).toBeNull();
    store.close();
  });
});

describe('toolOutcomes — structural attribution with an observed denominator', () => {
  test('producer outcomes win over error-looking data and clean-looking failures', () => {
    const store = eventStore();
    emit(store, 'run-a', 'tool_call_end', {
      name: 'file', toolCallId: 't1', outcome: { success: true }, result: { error: 'ordinary document data' },
    });
    emit(store, 'run-a', 'tool_call_end', {
      name: 'shell', toolCallId: 't2', outcome: { success: true }, result: 'Error (exit 3)',
    });
    emit(store, 'run-a', 'tool_call_end', {
      name: 'shell', toolCallId: 't3', outcome: { success: false, reason: null, execution: { exitCode: 3 } }, result: 'ok',
    });
    const result = toolOutcomes.score(store.sql, store.actor);
    expect(result.eligible).toBe(3);
    expect(result.passed).toBe(2);
    expect(result.rate).toBeCloseTo(2 / 3);
    expect(result.measured).toEqual({ succeeded: 2, failed: 1, unmeasured: 0, refused: 0, workFailed: 1, runtimeAbsent: 0, broke: 0 });
    store.close();
  });

  test('rows with no producer outcome remain observed but cannot supply a success rate', () => {
    const store = eventStore();
    emit(store, 'run-a', 'tool_call_end', { name: 'shell', toolCallId: 't1', result: 'Error (exit 3)' });
    emit(store, 'run-a', 'tool_call_end', { name: 'shell', toolCallId: 't2', error: 'a bare error string, no outcome' });
    emit(store, 'run-a', 'tool_call_end', { name: 'file', toolCallId: 't3', error: '', result: 'ok' });
    const result = toolOutcomes.score(store.sql, store.actor);
    expect(result.eligible).toBe(3);
    expect(result.passed).toBe(0);
    expect(result.rate).toBeNull();
    expect(result.measured).toEqual({ succeeded: 0, failed: 1, unmeasured: 2, refused: 0, workFailed: 0, runtimeAbsent: 0, broke: 1 });
    store.close();
  });

  test('failure attribution uses recorded refusal reasons and process exits', () => {
    const store = eventStore();

    for (const id of ['t1', 't2']) emit(store, 'run-a', 'tool_call_end', {
      name: 'file', toolCallId: id, args: { op: 'edit' }, outcome: { success: false, reason: 'not_found' }, result: 'no details',
    });
    emit(store, 'run-a', 'tool_call_end', {
      name: 'shell', toolCallId: 't3', outcome: { success: false, reason: null, execution: { exitCode: 1 } }, result: 'no details',
    });
    const result = toolOutcomes.score(store.sql, store.actor);
    expect(result.eligible).toBe(3);
    expect(result.passed).toBe(0);
    expect(result.rate).toBe(0);
    expect(result.detail).toContain('failed: file·edit·not_found×2, shell·exit_1×1');
    store.close();
  });

  test('an eval whose inner call broke is a failed call, and the break is counted as unexpected', () => {
    const store = eventStore();
    // The owner's 2048 transcript: the program recovered, but `fs.readdir('skills')` failed inside it.
    emit(store, 'run-a', 'tool_call_end', {
      name: 'eval', toolCallId: 't1', outcome: {
        success: true,
        failures: [{ success: false, tool: 'file', op: null, reason: 'missing', error: 'ENOENT: no such directory, home/user/skills' }],
      },
    });
    emit(store, 'run-a', 'tool_call_end', { name: 'shell', toolCallId: 't2', outcome: { success: true } });
    const result = toolOutcomes.score(store.sql, store.actor);
    expect(result.rate).toBe(0.5);
    expect(result.measured).toEqual({ succeeded: 1, failed: 1, unmeasured: 0, refused: 0, workFailed: 0, runtimeAbsent: 0, broke: 1 });
    expect(result.detail).toContain('failed: file·missing×1');
    store.close();
  });
});

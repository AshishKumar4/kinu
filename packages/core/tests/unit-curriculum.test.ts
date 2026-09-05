import { describe, test, expect } from 'bun:test';
import {
  proposeNextTasks, listProposedTasks, updateProposedTaskStatus, PROPOSED_TASK_STATUSES,
} from '../src/curriculum/proposer';
import { createScriptedLLM, createJSONLLM } from '@kinu.run/test-utils';
import { createTestRuntime, makeSqlExec } from './helpers';
import { initWorkspaceSchema } from '../src/identity/workspace-schema';

function setup() {
  const { rt, db } = createTestRuntime();
  // The production table set, not just `proposed_tasks`: the proposer reads the
  // crafted-tool registry and the durable turn-outcome ledger, and a harness
  // that creates fewer tables than a real workspace is what made tolerating
  // their absence look reasonable in shipped code.
  initWorkspaceSchema({ execRaw: rt.storage.execRaw, sql: rt.storage.sql, exec: makeSqlExec(db) });
  return { rt };
}

describe('Voyager curriculum proposer', () => {
  test('parses LLM response + filters by learnability window', async () => {
    const { rt } = setup();
    const judge = createJSONLLM([
      { task: 'easy A',     rationale: 'r1', predictedSuccess: 0.9, targetsSkills: ['x'] },
      { task: 'goldilocks', rationale: 'r2', predictedSuccess: 0.5, targetsSkills: ['y'] },
      { task: 'hard',       rationale: 'r3', predictedSuccess: 0.1, targetsSkills: ['z'] },
    ]);
    const proposals = await proposeNextTasks({ rt, judge });
    expect(proposals.length).toBe(1);
    expect(proposals[0].task).toBe('goldilocks');
    expect(proposals[0].predictedSuccess).toBe(0.5);
  });

  test('persists + lists proposals', async () => {
    const { rt } = setup();
    const judge = createJSONLLM([{ task: 't1', rationale: 'r', predictedSuccess: 0.5, targetsSkills: [] }]);
    await proposeNextTasks({ rt, judge });
    const stored = listProposedTasks(rt);
    expect(stored.length).toBe(1);
    expect(stored[0].task).toBe('t1');
    expect(stored[0].status).toBe('pending');
  });

  test('updateProposedTaskStatus flips status', async () => {
    const { rt } = setup();
    const judge = createJSONLLM([{ task: 'x', rationale: '', predictedSuccess: 0.5, targetsSkills: [] }]);
    const [p] = await proposeNextTasks({ rt, judge });
    updateProposedTaskStatus(rt, p.id, 'accepted');
    const accepted = listProposedTasks(rt, 'accepted');
    expect(accepted.length).toBe(1);
    expect(accepted[0].id).toBe(p.id);
  });

  test('throws on unparseable LLM response', async () => {
    const { rt } = setup();
    const judge = createScriptedLLM(['I cannot do that.']);
    await expect(proposeNextTasks({ rt, judge })).rejects.toThrow(/no JSON/);
  });

  test('respects custom learnability window', async () => {
    const { rt } = setup();
    const judge = createJSONLLM([
      { task: 'a', rationale: '', predictedSuccess: 0.2, targetsSkills: [] },
      { task: 'b', rationale: '', predictedSuccess: 0.8, targetsSkills: [] },
    ]);
    const proposals = await proposeNextTasks({ rt, judge, learnabilityWindow: [0.1, 0.3] });
    expect(proposals.length).toBe(1);
    expect(proposals[0].task).toBe('a');
  });

  test('caps persisted proposals at count', async () => {
    const { rt } = setup();
    const tasks = Array.from({ length: 8 }, (_, i) => ({ task: `t${i}`, rationale: 'r', predictedSuccess: 0.5, targetsSkills: [] }));
    const proposals = await proposeNextTasks({ rt, judge: createJSONLLM(tasks), count: 5 });
    expect(proposals.length).toBe(5);
    expect(listProposedTasks(rt).length).toBe(5);
  });

  test('rejects a bad count or window before calling the judge', async () => {
    for (const count of [0, -2, 2.5]) {
      const { rt } = setup();
      const judge = createScriptedLLM(['[]']);
      await expect(proposeNextTasks({ rt, judge, count })).rejects.toThrow(/count/);
      expect(judge.callCount).toBe(0);
    }
    const windows: Array<[number, number]> = [[0.7, 0.3], [-0.1, 0.5], [0.3, 1.5], [Number.NaN, 0.5]];
    for (const learnabilityWindow of windows) {
      const { rt } = setup();
      const judge = createScriptedLLM(['[]']);
      await expect(proposeNextTasks({ rt, judge, learnabilityWindow })).rejects.toThrow(/learnabilityWindow/);
      expect(judge.callCount).toBe(0);
    }
  });

  test('throws naming the window and nearest score when nothing survives the filter', async () => {
    const { rt } = setup();
    const judge = createJSONLLM([{ task: 'far', rationale: 'r', predictedSuccess: 0.05, targetsSkills: [] }]);
    const pending = proposeNextTasks({ rt, judge });
    await expect(pending).rejects.toThrow(/0\.3, 0\.7/);
    await expect(pending).rejects.toThrow(/0\.05/);
  });

  test('leaves abandoned turns out of the prompt context', async () => {
    const { rt } = setup();
    void rt.storage.sql`INSERT INTO turn_outcomes (id, outcome, confidence, source, user_message, assistant_response, created_at)
        VALUES ('o-abandoned', 'abandoned', 0.5, 'classifier', 'abandoned-marker-task', 'resp', 3)`;
    void rt.storage.sql`INSERT INTO turn_outcomes (id, outcome, confidence, source, user_message, assistant_response, created_at)
        VALUES ('o-accepted', 'accepted', 0.9, 'classifier', 'accepted-marker-task', 'resp', 4)`;
    const judge = createScriptedLLM(['[]']);
    await proposeNextTasks({ rt, judge });
    const promptText = judge.prompts.join('\n');
    expect(promptText).toContain('accepted-marker-task');
    expect(promptText).not.toContain('abandoned-marker-task');
  });

  test('mints unique ids for calls inside the same millisecond', async () => {
    const { rt } = setup();
    const realNow = Date.now;
    Date.now = () => 1_700_000_000_000;
    try {
      const first = await proposeNextTasks({ rt, judge: createJSONLLM([{ task: 'a', rationale: 'r', predictedSuccess: 0.5, targetsSkills: [] }]) });
      const second = await proposeNextTasks({ rt, judge: createJSONLLM([{ task: 'b', rationale: 'r', predictedSuccess: 0.5, targetsSkills: [] }]) });
      expect(first[0]?.id).toBeDefined();
      expect(second[0]?.id).toBeDefined();
      expect(first[0]?.id).not.toBe(second[0]?.id);
      expect(listProposedTasks(rt).length).toBe(2);
    } finally {
      Date.now = realNow;
    }
  });

  test('updateProposedTaskStatus throws on an unknown id', () => {
    const { rt } = setup();
    expect(() => updateProposedTaskStatus(rt, 'no-such-id', 'accepted')).toThrow(/unknown proposed task/);
  });

  test('status-filtered list is capped at 50, newest first', () => {
    const { rt } = setup();
    for (let i = 1; i <= 55; i++) {
      void rt.storage.sql`INSERT INTO proposed_tasks (id, task, rationale, predicted_success, targets_skills, proposed_at, status)
          VALUES (${`seed-${i}`}, ${`task ${i}`}, 'r', 0.5, '[]', ${i}, 'pending')`;
    }
    const listed = listProposedTasks(rt, 'pending');
    expect(listed.length).toBe(50);
    expect(listed[0]?.proposedAt).toBe(55);
  });

  test('equal timestamps order by id', () => {
    const { rt } = setup();
    for (const id of ['tie-a', 'tie-b']) {
      void rt.storage.sql`INSERT INTO proposed_tasks (id, task, rationale, predicted_success, targets_skills, proposed_at, status)
          VALUES (${id}, ${id}, 'r', 0.5, '[]', 10, 'pending')`;
    }
    void rt.storage.sql`INSERT INTO proposed_tasks (id, task, rationale, predicted_success, targets_skills, proposed_at, status)
        VALUES ('older', 'older', 'r', 0.5, '[]', 9, 'pending')`;
    expect(listProposedTasks(rt).map((p) => p.id)).toEqual(['tie-b', 'tie-a', 'older']);
  });

  test('publishes the one status list', () => {
    expect(PROPOSED_TASK_STATUSES).toEqual(['pending', 'accepted', 'rejected', 'completed']);
  });
});

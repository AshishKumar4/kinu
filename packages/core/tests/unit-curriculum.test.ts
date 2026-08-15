import { describe, test, expect } from 'bun:test';
import {
  initCurriculumTable, proposeNextTasks, listProposedTasks, updateProposedTaskStatus,
} from '../src/curriculum/proposer.ts';
import { createScriptedLLM, createJSONLLM } from '@proteus/test-utils';
import { createTestRuntime } from './helpers.js';

function setup() {
  const { rt } = createTestRuntime();
  initCurriculumTable(rt.storage.execRaw);
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
});

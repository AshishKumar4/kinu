// The evolution loop's evidence budget: the end of a long turn must reach the judge.
import { describe, test, expect } from 'bun:test';
import {
  EVIDENCE_BUDGETS, evidenceWindow,
} from '../src/index';
import { renderReflectionPrompt } from '../src/evolution/gepa/mutate';
import type { GepaCandidate } from '../src/evolution/gepa/types';
import { rateTurn } from '../src/evolution/ratings';

/** A seed candidate carrying `source`, the only field these prompts read. */
function candidate(source: string): GepaCandidate {
  return {
    id: 'p', parentId: null, source, scores: new Map(), feedback: new Map(),
    aggregateScore: 0.5, createdAt: 0,
  };
}

/** Decisive material at the very end. */
function trajectory(chars: number, ending: string): string {
  return 'step boilerplate. '.repeat(Math.ceil(chars / 18)).slice(0, chars) + ending;
}

describe('evidenceWindow', () => {
  test('text within budget passes through byte-identical', () => {
    const short = 'a conclusive answer';
    expect(evidenceWindow(short, 100)).toBe(short);
    expect(evidenceWindow('x'.repeat(100), 100)).toBe('x'.repeat(100));
  });

  test('keeps both ends and says how much it dropped', () => {
    const text = `OPENING${'-'.repeat(1000)}CLOSING`;
    const windowed = evidenceWindow(text, 100);
    expect(windowed.startsWith('OPENING')).toBe(true);
    expect(windowed.endsWith('CLOSING')).toBe(true);
    expect(windowed).toContain(`${text.length - 100} chars omitted from the middle`);
  });

  test('the split is even, so the tail is not a token gesture', () => {
    const text = `${'a'.repeat(500)}${'b'.repeat(500)}`;
    const windowed = evidenceWindow(text, 100);
    expect(windowed.startsWith('a'.repeat(50))).toBe(true);
    expect(windowed.endsWith('b'.repeat(50))).toBe(true);
  });
});

describe('the budgets are ordered — a reader never asks for more than was stored', () => {
  test('every ledger reader fits inside the ledger row it reads', () => {
    const stored = EVIDENCE_BUDGETS;
    expect(stored.replayTask).toBeLessThanOrEqual(stored.storedUserMessage);
    expect(stored.outcomeFollowup).toBeLessThanOrEqual(stored.storedFollowup);
    expect(stored.gepaInstanceInput).toBeLessThanOrEqual(stored.storedUserMessage);
    expect(stored.outcomeAssistantResponse).toBeLessThanOrEqual(stored.storedAssistantResponse);
  });
});

describe('the readers can see the end of a long turn', () => {
  const ending = 'THE-DECISIVE-STEP';

  test('the decision model sees how the request, the answer and the reply ended', async () => {
    const states: string[] = [];

    await rateTurn(async ({ state }) => {
      states.push(state);

      return { answers: {
        satisfaction: { type: 'score', score: 2 }, corrected: { type: 'noul', noul: 0 }, wrong: { type: 'choice', choice: 'nothing' },
      }, usage: { input: 0, output: 0 } };
    }, {
      request: trajectory(20_000, `ASK-${ending}`),
      actions: '',
      answer: trajectory(40_000, `ANSWER-${ending}`),
      followup: trajectory(20_000, `FOLLOWUP-${ending}`),
    }, 0);

    expect(states[0]).toContain(`ASK-${ending}`);
    expect(states[0]).toContain(`ANSWER-${ending}`);
    expect(states[0]).toContain(`FOLLOWUP-${ending}`);
  });

  test('the GEPA reflector sees how each rollout ended', () => {
    const prompt = renderReflectionPrompt({
      parent: candidate('const x = 1;'),
      minibatch: [{ id: 'i1', input: trajectory(20_000, `INPUT-${ending}`), evidence: trajectory(20_000, `EVIDENCE-${ending}`) }],
      rollout: { outcomes: [{ instanceId: 'i1', outcome: { score: 0.1, feedback: trajectory(20_000, `FEEDBACK-${ending}`) } }], metricCalls: 1 },
    });

    expect(prompt).toContain(`INPUT-${ending}`);
    expect(prompt).toContain(`EVIDENCE-${ending}`);
    expect(prompt).toContain(`FEEDBACK-${ending}`);
  });

  test('a candidate source is head-truncated, never middle-elided — a rewrite of holed code comes back holed', () => {
    const source = `// header\n${'const filler = 1;\n'.repeat(2000)}// footer`;

    const prompt = renderReflectionPrompt({
      parent: candidate(source),
      minibatch: [], rollout: { outcomes: [], metricCalls: 0 },
    });

    expect(prompt).toContain('// header');
    expect(prompt).not.toContain('// footer');
  });
});

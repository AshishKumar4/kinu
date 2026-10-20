/** The decision port over a chat model: one category a question, each standing for a fixed answer, refused when off-list. */
import { describe, expect, test } from 'bun:test';
import { createStructuredDecisionPort } from '../src/providers/structured-decision';
import type { DecisionQuestion } from '../src/providers/decision-model';
import { rateTurn } from '../src/evolution/ratings';
import type { LLM } from '../src/types/primitives';

function scripted(answer: string, prompts: string[] = []): LLM {
  return {
    stream: () => { throw new Error('not streamed'); },
    complete: async (prompt) => {
      prompts.push(prompt);

      return answer;
    },
  };
}

const QUESTIONS = {
  corrected: { type: 'noul', instructions: 'Did the reply correct the turn?' },
  satisfaction: { type: 'score', instructions: 'How satisfied is the user?', criteria: ['unhappy', 'neutral', 'happy'] },
  wrong: { type: 'choice', instructions: 'What went wrong?', criteria: { nothing: 'Nothing', incorrect: 'A wrong result' } },
} satisfies Readonly<Record<string, DecisionQuestion>>;

describe('createStructuredDecisionPort', () => {
  test('each question takes one allowed category, read as its fixed answer', async () => {
    const prompts: string[] = [];
    // A criterion's number may come back as a JSON number.
    const decide = createStructuredDecisionPort({ llm: () => scripted('{"corrected":"yes","satisfaction":0,"wrong":"incorrect"}', prompts) });

    expect(await decide({ state: 'THE TURN', questions: QUESTIONS })).toEqual({
      answers: {
        corrected: { type: 'noul', noul: 0.9 },
        satisfaction: { type: 'score', score: 0 },
        wrong: { type: 'choice', choice: 'incorrect' },
      },
      usage: { input: 0, output: 0 },
    });
    expect(prompts[0]).toContain('THE TURN');
    expect(prompts[0]).toContain('- corrected (one of yes, no, unclear): Did the reply correct the turn?');
    expect(prompts[0]).toContain('- satisfaction (one of 0, 1, 2): How satisfied is the user?\n    0: unhappy');
    expect(prompts[0]).toContain('- wrong (one of nothing, incorrect): What went wrong?\n    nothing: Nothing');
  });

  test('an answer off the list, or a question left out, is refused rather than guessed', async () => {
    for (const answer of ['{"corrected":"maybe","satisfaction":"0","wrong":"nothing"}', '{"corrected":"no","wrong":"nothing"}', 'no JSON here']) {
      const decide = createStructuredDecisionPort({ llm: () => scripted(answer) });

      await expect(decide({ state: 's', questions: QUESTIONS })).rejects.toMatchObject({ code: 'bad_input' });
    }
  });

  test('the production rater reads its answers as it reads the decision model\'s', async () => {
    const decide = createStructuredDecisionPort({ llm: () => scripted('{"satisfaction":"1","corrected":"yes","wrong":"misunderstood"}') });

    expect(await rateTurn(decide, { request: 'use staging', actions: '', answer: 'used production', followup: 'no, staging' }, 0))
      .toEqual({ score: 2, corrected: 0.9, wrong: 'misunderstood' });
  });
});

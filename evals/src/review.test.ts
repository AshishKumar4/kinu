import { describe, expect, test } from 'bun:test';
import { parseReview, rankedFindings, renderReviews, type Reviewed, type TrialReview } from './review';

const AT = { objectives: ['chat: build it', 'chat: answer a mention'], turns: 2, files: new Set(['packages/core/src/prompts/lead-brief.md']) };

const REVIEW: TrialReview = {
  objectives: [
    { objective: 'chat: build it', met: 'yes', evidence: 'turn 1, the slate answers signUp' },
    { objective: 'chat: answer a mention', met: 'no', evidence: 'turn 1, no Kinu message in the room' },
  ],
  use: { clean: false, findings: [{ kind: 'polling', what: 'slept in a loop on messages()', turn: 1 }] },
  frictions: [{ what: 'wrote the page twice', turn: 2, cause: 'prompt', file: 'packages/core/src/prompts/lead-brief.md:12', fix: 'say a slate rebuilds on save' }],
  summary: 'Built the app; never wired the assistant.',
};

describe('a trial review', () => {
  test('is taken only as the task\u2019s objectives in order, its turns and the files it was given', () => {
    expect(parseReview(JSON.stringify(REVIEW), AT)).toEqual(REVIEW);

    const refused = (review: TrialReview) => () => parseReview(JSON.stringify(review), AT);

    expect(refused({ ...REVIEW, objectives: [...REVIEW.objectives].reverse() })).toThrow('not the task\u2019s objectives in order');
    expect(refused({ ...REVIEW, frictions: [{ ...REVIEW.frictions[0], turn: 3 }] })).toThrow('past the trial\u2019s 2');
    expect(refused({ ...REVIEW, frictions: [{ ...REVIEW.frictions[0], file: 'src/made-up.ts' }] })).toThrow('src/made-up.ts');
    expect(refused({ ...REVIEW, use: { clean: true, findings: REVIEW.use.findings } })).toThrow('clean');
    expect(() => parseReview('Here it is: {}', AT)).toThrow();
  });

  test('frictions rank by the trials they held in, and an objective unmet behind passing checks is named', () => {
    const reviewed: Reviewed[] = [
      { task: 'chat-app', trial: 1, passed: true, review: REVIEW, refused: null },
      { task: 'chat-app', trial: 2, passed: false, review: { ...REVIEW, frictions: [...REVIEW.frictions, { ...REVIEW.frictions[0], file: 'none', cause: 'model' }] }, refused: null },
      { task: 'chess', trial: 1, passed: false, review: null, refused: 'the reply was not JSON' },
    ];

    expect(rankedFindings(reviewed).map(({ cause, file, trials, failed }) => ({ cause, file, trials, failed }))).toEqual([
      { cause: 'prompt', file: 'packages/core/src/prompts/lead-brief.md', trials: ['chat-app #1', 'chat-app #2'], failed: 1 },
      { cause: 'model', file: 'none', trials: ['chat-app #2'], failed: 1 },
    ]);

    const rendered = renderReviews(reviewed, [{ what: '`file` calls failed as bad_input 9 times', trials: 9 }]);

    expect(rendered).toContain('- chat-app #1: `chat: answer a mention`');
    expect(rendered).toContain('1. `file` calls failed as bad_input 9 times (9 trials)');
    expect(rendered).toContain('2. prompt in `packages/core/src/prompts/lead-brief.md`: `say a slate rebuilds on save` (2 trials)');
    expect(rendered).toContain('| chat-app | 2/2 | 2 / 0 / 2 | 2 | 3 |');
    expect(rendered).toContain('- chess #1: `the reply was not JSON`');
  });
});

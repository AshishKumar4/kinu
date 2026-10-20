// What a turn picked and which picks a dream reads as confused: a skill read and then another in one turn, or a pick
// in a turn the user corrected and another in the next one.
import { describe, expect, test } from 'bun:test';
import { compactToolCall } from '../src/evolution/tool-call-record';
import { confusedPicks, renderConfusedPicks, turnPicks, type TurnPicks } from '../src/evolution/picks';
import { initTurnRatingTables, listTurnRatings, recordTurnRating, type TurnRating } from '../src/evolution/ratings';
import { createTestRuntime } from './helpers';

const read = (path: string) => compactToolCall({ name: 'file', args: { op: 'read', path } });

describe('what a turn picked', () => {
  test('skills read through the file tool or an eval program, in order; a write is no pick; crafted tools used', () => {
    const picks = turnPicks({
      toolCalls: [
        read('/skills/report-writing/SKILL.md'),
        compactToolCall({ name: 'file', args: { op: 'write', path: '/home/main/skills/draft-notes/SKILL.md', content: 'x' } }),
        compactToolCall({ name: 'eval', args: { code: "const a = await file.read('vfs://skills/report-writing/SKILL.md');\nreturn file.read('/skills/slates/SKILL.md');" } }),
        read('/home/main/notes.md'),
      ],
      craftedToolsUsed: ['csv_sum'],
    });

    expect(picks).toEqual({ skills: ['report-writing', 'slates'], tools: ['csv_sum'] });
  });
});

let at = 0;

function rated(turnId: string, corrected: number, picks: TurnPicks | null): TurnRating {
  at += 1;

  return {
    id: `rate-${turnId}`, turnId, score: corrected >= 0.5 ? 1.5 : 4.5, corrected, wrong: null, source: 'model',
    request: 'r', actions: '', answer: 'a', followup: null, scaffoldVersion: null, artifacts: null, picks, rejects: null,
    createdAt: at,
  };
}

describe('which picks are confused', () => {
  test('a skill read and then another in one turn is a switch', () => {
    expect(confusedPicks([rated('t1', 0, { skills: ['report-writing', 'slates'], tools: [] })]).switches)
      .toEqual([{ kind: 'skill', from: 'report-writing', to: 'slates', turns: ['t1'] }]);
  });

  test('a pick in a corrected turn and another in the next is a switch, and the corrected pick is counted', () => {
    const confused = confusedPicks([
      rated('t1', 0.9, { skills: ['report-writing'], tools: ['csv_sum'] }),
      rated('t2', 0.1, { skills: ['slates'], tools: ['csv_total'] }),
      rated('t3', 0.1, { skills: ['report-writing'], tools: [] }),
    ]);

    expect(confused.switches).toEqual([
      { kind: 'skill', from: 'report-writing', to: 'slates', turns: ['t1'] },
      { kind: 'tool', from: 'csv_sum', to: 'csv_total', turns: ['t1'] },
    ]);
    expect(confused.corrected).toEqual([
      { kind: 'skill', name: 'report-writing', picked: 2, corrected: 1 },
      { kind: 'tool', name: 'csv_sum', picked: 1, corrected: 1 },
    ]);
  });

  test('another pick after a turn nobody corrected is no switch, and a turn with no recorded picks is skipped', () => {
    expect(confusedPicks([
      rated('t1', 0.1, { skills: ['report-writing'], tools: [] }),
      rated('t2', 0.9, null),
      rated('t3', 0.1, { skills: ['slates'], tools: [] }),
    ])).toEqual({ switches: [], corrected: [] });
  });

  test('the section names each switch and corrected pick, then the description of each one named', () => {
    const section = renderConfusedPicks(confusedPicks([
      rated('t1', 0.9, { skills: ['report-writing'], tools: [] }),
      rated('t2', 0.1, { skills: ['slates'], tools: [] }),
    ]), (kind, name) => `${kind} ${name} described`);

    expect(section.split('\n')).toEqual([
      '  - skill `report-writing`, then `slates`: 1 time',
      '  - skill `report-writing`: picked in 1 turn, 1 of them corrected',
      '  Their descriptions now:',
      '  - skill `report-writing`: skill report-writing described',
      '  - skill `slates`: skill slates described',
    ]);
    expect(renderConfusedPicks({ switches: [], corrected: [] }, () => '')).toBe('');
  });
});

describe('a rating keeps what its turn picked', () => {
  test('the effective rating reads the picks of whichever of its turn\'s rows recorded them', () => {
    const { rt } = createTestRuntime();
    initTurnRatingTables(rt.storage.execRaw);
    const picks = { skills: ['slates'], tools: ['csv_sum'] };

    recordTurnRating(rt.storage.sql, rt.actor, {
      turnId: 't1', score: 4, corrected: 0, wrong: null, source: 'model', request: 'r', answer: 'a', picks, now: 1,
    });
    // A thumb outranks the model's reading and knows nothing of the turn's calls.
    recordTurnRating(rt.storage.sql, rt.actor, {
      turnId: 't1', score: 1, corrected: 1, wrong: null, source: 'thumbs', request: 'r', answer: 'a', now: 2,
    });

    expect(listTurnRatings(rt.storage.sql, rt.actor).map((rating) => [rating.source, rating.picks]))
      .toEqual([['thumbs', picks]]);
  });
});

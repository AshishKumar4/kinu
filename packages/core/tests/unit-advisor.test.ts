/** The advisor's decision half: each suppression rule alone, as pure parts. What the session advisor reads, says and
 *  keeps is in unit-session-advisor. */

import { describe, test, expect } from 'bun:test';
import {
  isAdvisorSeverity, isContentFree, isDuplicateNote, judgeNote, normalizeNote,
  type AdvisorNote,
} from '../src/index';

const NOTE: AdvisorNote = {
  note: 'the rotate command exited 1 and the reply says it worked',
  severity: 'concern',
  class: 'wrong-work',
};

describe('normalizeNote', () => {
  test('collapses case and punctuation, so "Stop." and "Stop!" are one note', () => {
    expect(isDuplicateNote('Stop.', ['stop'])).toBe(true);
    expect(isDuplicateNote('Stop!', ['stop'])).toBe(true);
    expect(isDuplicateNote('  LGTM  ', ['lgtm'])).toBe(true);
    expect(isDuplicateNote('No   issues -- found', ['no issues found'])).toBe(true);
  });
});

describe('the content-free rule', () => {

  test('drops the same phrase wearing punctuation', () => {
    expect(isContentFree('Stop.')).toBe(true);
    expect(isContentFree('LGTM!')).toBe(true);
  });

  test('drops a note with no letters at all', () => {
    expect(isContentFree('   ...   ')).toBe(true);
  });

  test('keeps a note that states a fact', () => {
    expect(isContentFree(NOTE.note)).toBe(false);
  });

});

describe('the duplicate rule', () => {
  test('matches on the normalised text, not the raw text', () => {
    expect(isDuplicateNote('The Rotate Command Failed!', ['the rotate command failed'])).toBe(true);
  });

  test('does not match a different note', () => {
    expect(isDuplicateNote('a different finding', ['the rotate command failed'])).toBe(false);
  });

});

describe('the completion-gate rule', () => {
  test('an open gate holds back a blocker too — one runtime voice per boundary', () => {
    expect(judgeNote({
      note: { note: 'the build is broken', severity: 'blocker', class: 'wrong-work' },
      minSeverity: 'nit', recent: [], gateOpen: true,
    })).toEqual({ disposition: 'changelog', rule: 'gate-open' });
  });

});

describe('rule precedence', () => {
  test('a content-free duplicate is dropped as content-free, so nothing is stored', () => {
    expect(judgeNote({
      note: { note: 'Stop.', severity: 'blocker', class: 'wrong-work' },
      minSeverity: 'nit', recent: ['stop'], gateOpen: true,
    })).toEqual({ disposition: 'drop', rule: 'content-free' });
  });

  test('a duplicate beats an open gate: the row it duplicates is already there', () => {
    expect(judgeNote({
      note: NOTE, minSeverity: 'nit', recent: [normalizeNote(NOTE.note)], gateOpen: true,
    })).toEqual({ disposition: 'drop', rule: 'duplicate' });
  });

  test('an open gate beats the floor, because both answer the Changelog anyway', () => {
    expect(judgeNote({ note: NOTE, minSeverity: 'nit', recent: [], gateOpen: true }).rule).toBe('gate-open');
  });

  test('a note that survives every rule carries no rule at all', () => {
    expect(judgeNote({ note: NOTE, minSeverity: 'concern', recent: [], gateOpen: false }))
      .toEqual({ disposition: 'deliver', rule: null });
  });
});

describe('the user-dissatisfaction class', () => {
  test('a quoted note still obeys the suppression rules', () => {
    const quoted = { note: 'the user asked you to "write better commit messages"', severity: 'concern', class: 'dissatisfaction' } as const;
    expect(judgeNote({ note: quoted, minSeverity: 'concern', recent: [], gateOpen: false }).disposition).toBe('deliver');
    expect(judgeNote({ note: quoted, minSeverity: 'concern', recent: [normalizeNote(quoted.note)], gateOpen: false }).disposition).toBe('drop');
  });
});

describe('severities', () => {
  test('no value but a declared severity is one', () => {
    for (const other of ['critical', 'NIT', '', null, 2]) expect(isAdvisorSeverity(other)).toBe(false);
  });
});

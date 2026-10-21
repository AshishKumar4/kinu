/**
 * 2026-10-20, the owner on setup's assistant: "why a pink agent with a crown? maybe use the user's name". The assistant
 * wears a look drawn from the person's name, the same wherever it is drawn, and never Main's crown.
 */
import './helpers/ui-module-globals';
import { describe, expect, test } from 'bun:test';
import { mascotAccessory, personMascot } from '../src/components/Marks';
import { personName } from '../src/hooks/use-chat-mascot';

const NAMES = ['Ada Lovelace', 'Ashish', 'Lucía Ferreira', 'kai', 'Owner', '李雷'];

describe("a person's assistant", () => {
  test('looks the same for the same name, however it is spaced or cased', () => {
    expect(['  ada LOVELACE ', 'Ada Lovelace', 'ADA LOVELACE'].map((name) => personMascot(name).seed))
      .toEqual(['person:ada lovelace', 'person:ada lovelace', 'person:ada lovelace']);
  });

  test("never wears Main's crown, and two people's assistants differ", () => {
    expect(NAMES.map((name) => mascotAccessory(personMascot(name).seed)).filter((worn) => worn === 'crown')).toEqual([]);
    expect(new Set(NAMES.map((name) => JSON.stringify(personMascot(name)))).size).toBe(NAMES.length);
  });

  test("is drawn from the person's name, else their address's first part", () => {
    expect(personName({ displayName: 'Ada', email: 'ada@example.com' })).toBe('Ada');
    expect(personName({ displayName: ' ', email: 'lovelace@example.com' })).toBe('lovelace');
    expect(personName(null)).toBe('');
  });
});

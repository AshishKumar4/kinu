/** What the turn review reads besides the rating itself: the trivial-turn pre-filter. */
import { compactToolCall } from '../src/evolution/tool-call-record';
import { describe, test, expect } from 'bun:test';
import { isTrivialTurn } from '../src/evolution/ratings';
import type { ToolCallRecord } from '../src/evolution/types';

describe('isTrivialTurn — the LLM-call pre-filter', () => {
  const turn = (userMessage: string, toolCalls: ToolCallRecord[] = []) =>
    ({ userMessage, toolCalls });

  test('greetings and acknowledgements are trivial', () => {
    for (const msg of ['hi', 'Hey!', 'thanks', 'Thank you!!', 'ok', 'cool', 'good morning', 'bye']) {
      expect(isTrivialTurn(turn(msg))).toBe(true);
    }
  });

  test('real requests are not trivial, even short ones with a question', () => {
    expect(isTrivialTurn(turn('why?'))).toBe(false);
    expect(isTrivialTurn(turn('Refactor the auth module to use the new token store'))).toBe(false);
  });

  test('a turn that ran tools is never trivial', () => {
    expect(isTrivialTurn(turn('ok', [compactToolCall({ name: 'eval', args: {}, result: 1 })]))).toBe(false);
  });
});

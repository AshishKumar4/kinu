/**
 * PROV-3, 2026-10-23: a stored effort the model does not take was offered as a plain choice, while every turn sent
 * another level. The choice keeps the stored level visible and says what turns send for it.
 */
import { describe, expect, test } from 'bun:test';
import { reasoningEffortChoice } from '../src/components/model-picker-options';

const GLM = ['low', 'high', 'max'] as const;

describe('a reasoning effort as a settings choice', () => {
  test('a level the model declares reads as itself', () => {
    expect(reasoningEffortChoice('high', GLM)).toBe('High');
    expect(reasoningEffortChoice('xhigh', ['xhigh'])).toBe('Extra high');
  });

  test('a stored level the model does not take says the level turns send instead, or none', () => {
    expect(reasoningEffortChoice('medium', GLM)).toBe('Medium → runs Low');
    expect(reasoningEffortChoice('xhigh', GLM)).toBe('Extra high → runs High');
    expect(reasoningEffortChoice('medium', [])).toBe('Medium → runs none');
  });

  test('a model whose levels are unknown sends what is stored', () => {
    expect(reasoningEffortChoice('medium', undefined)).toBe('Medium');
  });
});

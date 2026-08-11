/**
 * selectFastModel — which model the MECHANICAL evolution calls run on.
 *
 * The property under test is that this is a cheaper TIER of the model the user
 * already chose, never a hop to another vendor (which would need credentials
 * the workspace may not have) and never a silent downgrade when the vendor has
 * nothing smaller.
 */
import { describe, test, expect } from 'bun:test';
import { selectFastModel } from '../src/providers/fast-model.js';

const PROVIDERS = [
  { id: 'anthropic', fastModel: 'claude-haiku-4-5' },
  { id: 'openai', fastModel: 'gpt-5.4-mini' },
  { id: 'openrouter' },
];

describe('selectFastModel', () => {
  test('the chat vendor\'s own small tier, on the same credential', () => {
    expect(selectFastModel({
      fastSpec: null, chatSpec: 'anthropic/claude-opus-4-7', providers: PROVIDERS,
    })).toEqual({ spec: 'anthropic/claude-haiku-4-5', source: 'provider-small' });
  });

  test('an operator pin wins outright', () => {
    expect(selectFastModel({
      fastSpec: '  openai/gpt-5.4-mini  ', chatSpec: 'anthropic/claude-opus-4-7', providers: PROVIDERS,
    })).toEqual({ spec: 'openai/gpt-5.4-mini', source: 'configured' });
  });

  test('a vendor with no declared small tier keeps the chat model', () => {
    expect(selectFastModel({
      fastSpec: null, chatSpec: 'openrouter/some/model', providers: PROVIDERS,
    })).toEqual({ spec: 'openrouter/some/model', source: 'chat-model' });
  });

  test('a chat model that already IS the small tier is left alone', () => {
    expect(selectFastModel({
      fastSpec: null, chatSpec: 'anthropic/claude-haiku-4-5', providers: PROVIDERS,
    })).toEqual({ spec: 'anthropic/claude-haiku-4-5', source: 'chat-model' });
  });

  test('an unknown provider keeps the chat model rather than guessing', () => {
    expect(selectFastModel({
      fastSpec: null, chatSpec: 'mystery/model-x', providers: PROVIDERS,
    })).toEqual({ spec: 'mystery/model-x', source: 'chat-model' });
  });

  test('an unparseable chat spec is returned untouched, not thrown on', () => {
    expect(selectFastModel({ fastSpec: null, chatSpec: '', providers: PROVIDERS }))
      .toEqual({ spec: '', source: 'chat-model' });
  });

  test('never crosses vendors on its own — that is the judge selector\'s job, not this one\'s', () => {
    const selection = selectFastModel({
      fastSpec: null, chatSpec: 'anthropic/claude-opus-4-7', providers: PROVIDERS,
    });
    expect(selection.spec.startsWith('anthropic/')).toBe(true);
  });
});

import { describe, expect, test } from 'bun:test';
import * as v from 'valibot';
import { createScriptedLLM } from '../src/llm';

describe('createScriptedLLM', () => {
  test('an exhausted completion rejects and records the attempted call', async () => {
    const llm = createScriptedLLM([]);
    await expect(llm.complete('missing')).rejects.toThrow(
      'ScriptedLLM out of responses (called 1 times, only 0 scripted).',
    );
    expect(llm.callCount).toBe(1);
    expect(llm.prompts).toEqual(['missing']);
  });

  test('an explicitly scripted empty string succeeds exactly once', async () => {
    const llm = createScriptedLLM(['']);

    await expect(llm.complete('empty')).resolves.toBe('');
    await expect(llm.complete('exhausted')).rejects.toThrow(
      'ScriptedLLM out of responses (called 2 times, only 1 scripted).',
    );
    expect(llm.callCount).toBe(2);
    expect(llm.prompts).toEqual(['empty', 'exhausted']);
  });

  test('interleaved completions and structured answers consume one script and record each prompt once', async () => {
    const llm = createScriptedLLM(['first', '{"n":2}', 'third']);
    await expect(llm.complete('complete one')).resolves.toBe('first');
    await expect(llm.object('object one', v.object({ n: v.number() }))).resolves.toEqual({ n: 2 });
    await expect(llm.complete('complete two')).resolves.toBe('third');
    expect(llm.callCount).toBe(3);
    expect(llm.prompts).toEqual(['complete one', 'object one', 'complete two']);
  });
});

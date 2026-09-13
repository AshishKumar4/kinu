import { describe, expect, test } from 'bun:test';
import { createScriptedLLM } from '../src/llm';

async function collect(stream: AsyncIterable<string>): Promise<string[]> {
  const chunks: string[] = [];

  for await (const chunk of stream) chunks.push(chunk);

  return chunks;
}

describe('createScriptedLLM', () => {
  test('an exhausted completion rejects and records the attempted call', async () => {
    const llm = createScriptedLLM([]);
    await expect(llm.complete('missing')).rejects.toThrow(
      'ScriptedLLM out of responses (called 1 times, only 0 scripted).',
    );
    expect(llm.callCount).toBe(1);
    expect(llm.prompts).toEqual(['missing']);
  });

  test('an exhausted stream rejects during iteration, not when created', async () => {
    const llm = createScriptedLLM([]);
    const stream = llm.stream({ system: '', messages: [{ role: 'user', content: 'missing' }] });
    expect(llm.callCount).toBe(0);
    expect(llm.prompts).toEqual([]);
    await expect(collect(stream)).rejects.toThrow(
      'ScriptedLLM out of responses (called 1 times, only 0 scripted).',
    );
    expect(llm.callCount).toBe(1);
    expect(llm.prompts).toEqual(['missing']);
  });

  test.each(['complete', 'stream'])('an explicitly scripted empty string succeeds exactly once through %s', async (method) => {
    const llm = createScriptedLLM(['']);

    const response = method === 'complete'
      ? async (prompt: string) => [await llm.complete(prompt)]
      : (prompt: string) => collect(llm.stream({ system: '', messages: [{ role: 'user', content: prompt }] }));

    await expect(response('empty')).resolves.toEqual(['']);
    await expect(response('exhausted')).rejects.toThrow(
      'ScriptedLLM out of responses (called 2 times, only 1 scripted).',
    );
    expect(llm.callCount).toBe(2);
    expect(llm.prompts).toEqual(['empty', 'exhausted']);
  });

  test('interleaved completions and streams consume one script and record each prompt once', async () => {
    const llm = createScriptedLLM(['first', 'second', 'third']);
    await expect(llm.complete('complete one')).resolves.toBe('first');
    await expect(collect(llm.stream({
      system: 'not part of the recorded message framing',
      messages: [
        { role: 'user', content: 'stream one' },
        { role: 'assistant', content: 'stream two' },
      ],
    }))).resolves.toEqual(['second']);
    await expect(llm.complete('complete two')).resolves.toBe('third');
    expect(llm.callCount).toBe(3);
    expect(llm.prompts).toEqual(['complete one', 'stream one\nstream two', 'complete two']);
  });
});

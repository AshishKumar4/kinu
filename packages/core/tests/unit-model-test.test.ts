import { describe, expect, test } from 'bun:test';
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import { asFetchFunction, testModel, withRateLimitRetry, ProviderPacer } from '../src/index';

const SSE = { 'content-type': 'text/event-stream' };

const SPENT = (): Response => Response.json({ error: { message: 'Monthly usage limit reached.' } }, { status: 429, headers: { 'Retry-After': '729883' } });

const answer = (): Response => new Response([
  `data: ${JSON.stringify({ choices: [{ delta: { content: 'OK' } }] })}\n\n`,
  `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 9, completion_tokens: 1, total_tokens: 10 } })}\n\n`,
  'data: [DONE]\n\n',
].join(''), { headers: SSE });

function modelAnswering(reply: () => Response | Promise<Response>, sent: { count: number }) {
  const fetchImpl = withRateLimitRetry(asFetchFunction(async () => {
    sent.count++;

    return reply();
  }), { provider: 'probe', pacer: new ProviderPacer({ sleep: async () => {} }), sleep: async () => {}, warn: () => {} });

  return createOpenAICompatible({ name: 'probe', baseURL: 'https://probe.test/v1', fetch: fetchImpl }).chatModel('m');
}

describe('testModel', () => {
  test('an answering model reports time to first token and total time', async () => {
    let clock = 0;
    const sent = { count: 0 };

    const result = await testModel({
      model: modelAnswering(() => {
        clock += 120;

        return answer();
      }, sent),
      now: () => clock,
    });

    expect(result).toEqual({ ok: true, firstTokenMs: 120, totalMs: 120 });
    expect(sent.count).toBe(1);
  });

  test('each refusal is named once, in the words the model row shows', async () => {
    const cases: ReadonlyArray<readonly [string, () => Response]> = [
      ['signed-out', () => Response.json({ error: { message: 'Invalid token' } }, { status: 401 })],
      ['spent', SPENT],
      ['unknown-model', () => Response.json({ error: { message: 'model m does not exist' } }, { status: 404 })],
      ['unreachable', () => { throw new TypeError('fetch failed'); }],
    ];

    for (const [failure, reply] of cases) {
      const sent = { count: 0 };
      const result = await testModel({ model: modelAnswering(reply, sent) });

      expect({ failure, got: result.ok ? 'ok' : result.failure }).toEqual({ failure, got: failure });

      if (failure !== 'unreachable') expect({ failure, sent: sent.count }).toEqual({ failure, sent: 1 });
    }
  });

  test('a spent allowance names its reset time', async () => {
    const result = await testModel({
      model: modelAnswering(SPENT, { count: 0 }),
    });

    expect(result.ok ? '' : result.message).toMatch(/rate-limited until \d{4}-\d{2}-\d{2} \d{2}:\d{2} UTC/);
  });
});

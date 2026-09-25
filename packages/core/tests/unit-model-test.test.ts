import { describe, expect, test } from 'bun:test';
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import type { LanguageModel } from 'ai';
import { asFetchFunction, modelTestText, testModel, withRateLimitRetry, ProviderPacer, type ModelCallReport } from '../src/index';

const SSE = { 'content-type': 'text/event-stream' };

const SPENT = (): Response => Response.json({ error: { message: 'Monthly usage limit reached.' } }, { status: 429, headers: { 'Retry-After': '729883' } });

const answer = (): Response => new Response([
  `data: ${JSON.stringify({ choices: [{ delta: { content: 'OK' } }] })}\n\n`,
  `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 9, completion_tokens: 1, total_tokens: 10 } })}\n\n`,
  'data: [DONE]\n\n',
].join(''), { headers: SSE });

function modelAnswering(reply: () => Response | Promise<Response>, sent: { count: number }): (spec: string) => LanguageModel {
  const fetchImpl = withRateLimitRetry(asFetchFunction(async () => {
    sent.count++;

    return reply();
  }), { provider: 'probe', pacer: new ProviderPacer({ sleep: async () => {} }), sleep: async () => {}, warn: () => {} });

  return () => createOpenAICompatible({ name: 'probe', baseURL: 'https://probe.test/v1', fetch: fetchImpl }).chatModel('m');
}

describe('testModel', () => {
  test('an answering model reports time to first token and total time, and files its spend as a test', async () => {
    let clock = 0;
    const sent = { count: 0 };
    const reports: ModelCallReport[] = [];

    const resolve = modelAnswering(() => {
      clock += 120;

      return answer();
    }, sent);

    const result = await testModel({ spec: 'probe/m', resolve, report: (report) => reports.push(report), now: () => clock });

    expect(result).toEqual({ ok: true, firstTokenMs: 120, totalMs: 120 });
    expect(sent.count).toBe(1);
    expect(reports.map((report) => [report.source, report.spec, report.usage.output])).toEqual([['test', 'probe/m', 1]]);
  });

  test('each refusal is named once, in the words the model row shows, never retried', async () => {
    const cases: ReadonlyArray<readonly [string, () => Response]> = [
      ['signed-out', () => Response.json({ error: { message: 'Invalid token' } }, { status: 401 })],
      ['spent', SPENT],
      ['spent', () => Response.json({ error: { message: 'Insufficient credits', code: 402 } }, { status: 402 })],
      ['spent', () => Response.json({ error: { message: 'You exceeded your current quota.', type: 'insufficient_quota', code: 'insufficient_quota' } }, { status: 429 })],
      ['unknown-model', () => Response.json({ error: { message: 'model m does not exist' } }, { status: 404 })],
      ['unreachable', () => Response.json({ error: { message: 'upstream down' } }, { status: 503 })],
    ];

    for (const [failure, reply] of cases) {
      const sent = { count: 0 };
      const result = await testModel({ spec: 'probe/m', resolve: modelAnswering(reply, sent) });

      expect({ failure, got: result.ok ? 'ok' : result.failure, sent: sent.count }).toEqual({ failure, got: failure, sent: 1 });
    }
  });

  test('a spec no provider resolves answers as an unknown model, not a throw', async () => {
    const result = await testModel({ spec: 'nobody/m', resolve: () => { throw new Error('Unknown provider "nobody"'); } });

    expect(result).toMatchObject({ ok: false, failure: 'unknown-model' });
  });

  test('a spent allowance names its reset time', async () => {
    const result = await testModel({ spec: 'probe/m', resolve: modelAnswering(SPENT, { count: 0 }) });

    expect(result.ok ? '' : result.message).toMatch(/rate-limited until \d{4}-\d{2}-\d{2} \d{2}:\d{2} UTC/);
    expect(result.ok ? 0 : result.until ?? 0).toBeGreaterThan(Date.now() + 8 * 86_400_000);
    expect(modelTestText(result, { provider: 'opencode-go', from: 'here' })).toMatch(/^OpenCode Go allowance is spent until \d{4}-\d{2}-\d{2} \d{2}:\d{2} UTC\.$/u);
  });
});

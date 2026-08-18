import { afterEach, describe, expect, test } from 'bun:test';
import { createBenchInferenceProxy } from './bench-inference-proxy';

const servers: Array<{ stop(closeActiveConnections?: boolean): void }> = [];

afterEach(() => {
  for (const server of servers.splice(0)) server.stop(true);
});

describe('bench inference proxy', () => {
  test('counts every successful JSON response and preserves the upstream request', async () => {
    const seen: Array<{ path: string; authorization: string | null }> = [];
    const upstream = Bun.serve({
      port: 0,
      async fetch(request) {
        seen.push({
          path: new URL(request.url).pathname,
          authorization: request.headers.get('authorization'),
        });
        await request.text();
        return Response.json({
          choices: [],
          usage: { prompt_tokens: 11, completion_tokens: 7, total_tokens: 18 },
        });
      },
    });
    servers.push(upstream);
    const meter = createBenchInferenceProxy({
      upstreamBaseURL: `http://127.0.0.1:${upstream.port}/v1`,
      maxTokens: 100,
    });
    servers.push(meter);

    const response = await fetch(`${meter.baseURL}/chat/completions`, {
      method: 'POST',
      headers: { authorization: 'Bearer test' },
      body: '{}',
    });
    expect(response.status).toBe(200);
    await response.text();
    await meter.settle();

    expect(seen).toEqual([{ path: '/v1/chat/completions', authorization: 'Bearer test' }]);
    expect(meter.usage()).toEqual({
      calls: 1,
      tokens: 18,
      peakPromptTokens: 11,
      unmeteredResponses: 0,
    });
  });

  test('routes multiple upstreams through one shared meter', async () => {
    const seen: string[] = [];
    const first = Bun.serve({
      port: 0,
      fetch(request) {
        seen.push(`first:${new URL(request.url).pathname}`);
        return Response.json({ usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 } });
      },
    });
    const second = Bun.serve({
      port: 0,
      fetch(request) {
        seen.push(`second:${new URL(request.url).pathname}`);
        return Response.json({ usage: { prompt_tokens: 7, completion_tokens: 4, total_tokens: 11 } });
      },
    });
    servers.push(first, second);
    const firstURL = `http://127.0.0.1:${first.port}/v1`;
    const secondURL = `http://127.0.0.1:${second.port}/api`;
    const meter = createBenchInferenceProxy({
      upstreamBaseURL: firstURL,
      additionalUpstreamBaseURLs: [secondURL],
      maxTokens: 100,
    });
    servers.push(meter);

    const responses = await Promise.all([
      fetch(`${meter.baseURLFor(firstURL)}/chat/completions`, { method: 'POST', body: '{}' }),
      fetch(`${meter.baseURLFor(secondURL)}/messages`, { method: 'POST', body: '{}' }),
    ]);
    await Promise.all(responses.map((response) => response.text()));
    await meter.settle();

    expect(seen.sort()).toEqual(['first:/v1/chat/completions', 'second:/api/messages']);
    expect(meter.usage()).toEqual({
      calls: 2,
      tokens: 16,
      peakPromptTokens: 7,
      unmeteredResponses: 0,
    });
  });

  test('counts one streaming call once when the terminal event repeats usage', async () => {
    const upstream = Bun.serve({
      port: 0,
      fetch() {
        const body = [
          'data: {"choices":[{"delta":{"content":"ok"}}]}',
          '',
          'data: {"usage":{"prompt_tokens":20,"completion_tokens":4,"total_tokens":24}}',
          '',
          'data: {"usage":{"prompt_tokens":20,"completion_tokens":4,"total_tokens":24}}',
          '',
          'data: [DONE]',
          '',
        ].join('\n');
        return new Response(body, { headers: { 'content-type': 'text/event-stream' } });
      },
    });
    servers.push(upstream);
    const meter = createBenchInferenceProxy({
      upstreamBaseURL: `http://127.0.0.1:${upstream.port}/v1`,
      maxTokens: 100,
    });
    servers.push(meter);

    const response = await fetch(`${meter.baseURL}/chat/completions`, { method: 'POST', body: '{}' });
    await response.text();
    await meter.settle();

    expect(meter.usage()).toEqual({
      calls: 1,
      tokens: 24,
      peakPromptTokens: 20,
      unmeteredResponses: 0,
    });
  });

  test('marks a successful inference response without usage as invalid evidence', async () => {
    const upstream = Bun.serve({
      port: 0,
      fetch: () => Response.json({ choices: [{ message: { content: 'unmetered' } }] }),
    });
    servers.push(upstream);
    const meter = createBenchInferenceProxy({
      upstreamBaseURL: `http://127.0.0.1:${upstream.port}/v1`,
      maxTokens: 100,
    });
    servers.push(meter);

    const response = await fetch(`${meter.baseURL}/chat/completions`, { method: 'POST', body: '{}' });
    await response.text();
    await meter.settle();

    expect(meter.usage().unmeteredResponses).toBe(1);
  });

  test('rejects internally inconsistent provider usage', async () => {
    const upstream = Bun.serve({
      port: 0,
      fetch: () => Response.json({
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 2 },
      }),
    });
    servers.push(upstream);
    const meter = createBenchInferenceProxy({
      upstreamBaseURL: `http://127.0.0.1:${upstream.port}/v1`,
      maxTokens: 100,
    });
    servers.push(meter);

    const response = await fetch(`${meter.baseURL}/chat/completions`, { method: 'POST', body: '{}' });
    await response.text();
    await meter.settle();

    expect(meter.usage()).toMatchObject({ tokens: 0, unmeteredResponses: 1 });
  });

  test('trips the shared token cap and refuses later callers', async () => {
    let breaches = 0;
    const upstream = Bun.serve({
      port: 0,
      fetch: () => Response.json({ usage: { input_tokens: 8, output_tokens: 5, total_tokens: 13 } }),
    });
    servers.push(upstream);
    const meter = createBenchInferenceProxy({
      upstreamBaseURL: `http://127.0.0.1:${upstream.port}/v1`,
      maxTokens: 10,
      onBreach: () => { breaches++; },
    });
    servers.push(meter);

    const response = await fetch(`${meter.baseURL}/chat/completions`, { method: 'POST', body: '{}' });
    await response.text();
    await meter.settle();

    expect(meter.usage().tokens).toBe(13);
    expect(breaches).toBe(1);
    const refused = await fetch(`${meter.baseURL}/chat/completions`, { method: 'POST', body: '{}' });
    expect(refused.status).toBe(429);
  });
});

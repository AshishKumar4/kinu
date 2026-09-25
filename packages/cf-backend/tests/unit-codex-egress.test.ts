import { describe, expect, test } from 'bun:test';
import { generateText } from 'ai';
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import { codexEgressAllowed, EgressCalls, toProviderError } from '@kinu.run/core';
import { ALLOWED_ROUTES, forwardedHeaders, refusal } from '../containers/codex-egress/policy.mjs';
import { codexEgressFetch, type CodexEgressNamespace } from '../src/egress/codex-egress-route';

function egressOver(opts: {
  readonly start?: (signal: AbortSignal) => Promise<void>;
  readonly upstream: (signal: AbortSignal) => Promise<Response>;
}) {
  const calls = new EgressCalls();
  const forwarded: string[] = [];
  const cancelled: string[] = [];

  const stub = {
    forward: async (_owner: string, callId: string, _request: Request) => {
      forwarded.push(callId);

      return calls.run(callId, { start: opts.start ?? (async () => {}), fetch: opts.upstream });
    },
    cancel: async (callId: string) => {
      cancelled.push(callId);
      calls.cancel(callId);
    },
  };

  const namespace: CodexEgressNamespace<string> = { idFromName: (name) => name, get: () => stub };

  return { fetch: codexEgressFetch(namespace, 'user-1'), calls, forwarded, cancelled };
}

describe('the Codex egress route', () => {
  test('a Stop while chatgpt.com has not answered aborts the upstream request', async () => {
    const upstreamAborted = Promise.withResolvers<unknown>();
    const upstreamHeld = Promise.withResolvers<void>();

    const egress = egressOver({
      upstream: (signal) => {
        signal.addEventListener('abort', () => upstreamAborted.resolve(signal.reason), { once: true });
        upstreamHeld.resolve();

        return new Promise<Response>(() => {});
      },
    });

    const stop = new AbortController();
    const call = egress.fetch('https://chatgpt.com/backend-api/codex/responses', { method: 'POST', body: '{}', signal: stop.signal });

    await upstreamHeld.promise;
    stop.abort(new DOMException('stopped', 'AbortError'));

    await expect(call).rejects.toThrow('stopped');
    expect(egress.cancelled).toEqual(egress.forwarded);
    expect(egress.calls.size).toBe(0);
    expect(await upstreamAborted.promise).toBeInstanceOf(DOMException);
  });

  test('a streamed answer is passed through whole, and the call ends with its body', async () => {
    const egress = egressOver({ upstream: async () => new Response('data: ok\n\n', { headers: { 'content-type': 'text/event-stream' } }) });
    const response = await egress.fetch('https://chatgpt.com/backend-api/codex/responses', { method: 'POST', body: '{}' });

    expect(await response.text()).toBe('data: ok\n\n');
    expect(egress.calls.size).toBe(0);
  });

  const noInstance = new Error('there is no container instance that can be provided to this durable object');

  test('no free container is named as capacity, once, and a start failure by its own reason', async () => {
    for (const [cause, named, code] of [
      [noInstance, 'Codex is busy for everyone right now', 'codex_egress_busy'],
      [new Error('image pull denied'), "Codex's egress container failed to start: image pull denied", 'codex_egress_start'],
    ] as const) {
      let upstream = 0;

      const egress = egressOver({
        start: async () => { throw cause; },
        upstream: async () => {
          upstream++;

          return new Response('never');
        },
      });

      const model = createOpenAICompatible({ name: 'codex', baseURL: 'https://chatgpt.com/backend-api/codex', fetch: egress.fetch }).chatModel('gpt-5.5');
      let classified = toProviderError({ doing: 'calling the model', cause: new Error('the call succeeded') });

      try {
        await generateText({ model, prompt: 'hi', maxRetries: 2 });
      } catch (error) {
        classified = toProviderError({ doing: 'calling the model', cause: error });
      }

      expect({ forwarded: egress.forwarded.length, upstream, code: classified.code }).toEqual({ forwarded: 1, upstream: 0, code: 'unavailable' });
      expect(classified.message + String(classified.cause)).toContain(named);
      expect(classified.message).toContain(code);
      expect(egress.calls.size).toBe(0);
    }
  });
});

describe('the egress container forwards only the Codex API', () => {
  test('another host, another path, another method or a credential in the URL is refused', () => {
    const cases: ReadonlyArray<readonly [string, string, number | null]> = [
      ['GET', 'https://chatgpt.com/backend-api/codex/models?client_version=1.0.0', null],
      ['POST', 'https://chatgpt.com/backend-api/codex/responses', null],
      ['GET', 'https://chatgpt.com/backend-api/wham/usage', null],
      ['GET', 'https://example.com/backend-api/codex/models', 403],
      ['GET', 'https://chatgpt.com.example.com/backend-api/codex/models', 403],
      ['GET', 'http://chatgpt.com/backend-api/codex/models', 403],
      ['GET', 'https://chatgpt.com:8443/backend-api/codex/models', 403],
      ['GET', 'https://user:pass@chatgpt.com/backend-api/codex/models', 403],
      ['GET', 'https://chatgpt.com/backend-api/conversation', 403],
      ['POST', 'https://chatgpt.com/backend-api/codex/models', 403],
      ['DELETE', 'https://chatgpt.com/backend-api/codex/responses', 405],
      ['GET', 'not a url', 403],
      ['GET', 'https://chatgpt.com/backend-api/codex/%2e%2e/conversation', 403],
      ['GET', 'https://chatgpt.com/backend-api/codex%2Fmodels', 403],
      ['GET', 'https://chatgpt.com/backend-api/codex/models;x', 403],
      ['GET', 'https://chatgpt.com//backend-api/codex/models', 403],
      ['GET', 'https://chatgpt.com/backend-api/codex/models/', 403],
      ['GET', 'https://chatgpt.com/backend-api/codex/../conversation', 403],
    ];

    expect(cases.map(([method, target]) => [method, target, refusal(method, target)?.status ?? null] as const)).toEqual([...cases]);
  });

  test('a target-port, forwarding or egress header never reaches chatgpt.com', () => {
    const sent = forwardedHeaders({
      authorization: 'Bearer t', 'cf-container-target-port': '22', 'x-kinu-target': 'https://chatgpt.com/', 'x-forwarded-for': '1.2.3.4',
      host: 'codex-egress', 'content-type': 'application/json',
    });

    expect([...sent.keys()].sort()).toEqual(['authorization', 'content-type']);
  });

  test('the container and core allow the same routes, so one list is the rule', () => {
    const core = ALLOWED_ROUTES.filter((route) => {
      const [method = '', path = ''] = route.split(' ');

      return codexEgressAllowed({ method, url: `https://chatgpt.com${path}` });
    });

    expect(core).toEqual([...ALLOWED_ROUTES]);

    for (const [method, url] of [['GET', 'https://chatgpt.com/backend-api/conversation'], ['POST', 'https://chatgpt.com/backend-api/codex/models']] as const) {
      expect({ url, core: codexEgressAllowed({ method, url }), container: refusal(method, url) === null }).toEqual({ url, core: false, container: false });
    }
  });
});

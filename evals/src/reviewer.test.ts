import { afterAll, expect, test } from 'bun:test';
import * as v from 'valibot';
import { BUILTIN_PROFILE_CATALOG, JsonValueSchema, profileCatalogDigest, type RunEvent } from '@kinu.run/core';
import { REVIEW_LOGIN } from './config';
import { reviewerCatalog, REVIEWER_ROLE_ID } from './reviewer';
import { askOnce, reviewerModel } from './target';
import { chatChunkFrame, chatErrorFrame, chatTerminalFrame, rpcReplyFrame } from './fixtures/session-frames';

const held: string[] = [];

const deployment = Bun.serve({ port: 0, hostname: '127.0.0.1', routes: {
  '/api/user/credentials': () => Response.json(held.map((key) => ({ key, kind: 'oauth' }))),
} });

const target = { origin: `http://127.0.0.1:${String(deployment.port)}`, identity: { kind: 'loopback' as const } };

afterAll(() => deployment.stop(true));

test('a review runs on the owner\'s ChatGPT login, and on nothing else when the deployment lacks it', async () => {
  // A menu names no account: the login's own spec is never listed, only its credential held.
  held.splice(0, held.length, REVIEW_LOGIN.key, 'opencode-go.bearer');

  expect(await reviewerModel(target)).toBe('chatgpt@ashishkmr472/gpt-6.1-sol');

  held.splice(0, held.length, 'opencode-go.bearer', 'openrouter.bearer');

  await expect(reviewerModel(target)).rejects.toThrow('reviewer-sign-in.ts');
});

test('the reviewer is a file-only Plan role, and its model falls back along no chain', () => {
  const model = 'chatgpt@ashishkmr472/gpt-6.1-sol';
  const written = reviewerCatalog(model)({ ...BUILTIN_PROFILE_CATALOG, modelFallbacks: { [model]: ['openrouter/openai/gpt-6.1-sol'] } });

  expect(written?.roles[REVIEWER_ROLE_ID]).toMatchObject({ allowedTools: ['file'], plan: true, spawns: [] });
  // A chain an earlier run wrote is a paid route the review would follow when its login refuses.
  expect(written?.modelFallbacks).toEqual({});

  if (written === null) throw new Error('nothing was written');

  expect(reviewerCatalog(model)(written)).toBeNull();
});

/** The public workspace routes and socket after a reviewer finishes, including the ledger's terminal cause. */
function answeredReview(answer: { failure?: string; text?: string; wireError?: boolean }) {
  const model = 'fixture/reviewer';
  const catalog = { ...BUILTIN_PROFILE_CATALOG, ...reviewerCatalog(model)(BUILTIN_PROFILE_CATALOG), betaSwarms: true };
  const events: RunEvent[] = [];
  const history: { id: string; role: 'user' | 'assistant'; parts: { type: 'text'; text: string }[] }[] = [];
  let deleted = false;

  const server = Bun.serve({ port: 0, hostname: '127.0.0.1',
    async fetch(request, upgrading) {
      const path = new URL(request.url).pathname;

      if (path === '/api/user/profile-catalog') return Response.json({
        authority: { kind: 'account', accountId: 'fixture' }, version: 1, digest: profileCatalogDigest(catalog), catalog,
      });

      if (path === '/api/user/workspaces' && request.method === 'POST') return Response.json(v.parse(v.object({ name: v.string() }), await request.json()));

      if (request.method === 'DELETE') { deleted = true;

 return Response.json({ ok: true }); }

      if (path.endsWith('/get-messages')) return Response.json(history);

      if (path.endsWith('/runs')) return Response.json({ status: 'end', items: events.length === 0 ? [] : [{ runId: 'review-run' }] });

      if (path.endsWith('/events')) return Response.json(events.filter((event) => event.eventIndex >= Number(new URL(request.url).searchParams.get('since') ?? 0)));

      if (upgrading.upgrade(request)) return;

      return new Response('Not found', { status: 404 });
    },
    websocket: { message(socket, data) {
      const frame = v.parse(v.object({ id: v.string(), method: v.optional(v.string()), args: v.optional(v.array(JsonValueSchema), []),
        init: v.optional(v.object({ body: v.string() })) }), JSON.parse(data.toString()));

      if (frame.method !== undefined) {
        socket.send(rpcReplyFrame({ requestId: frame.id, result: frame.method === 'setModel' ? { spec: model } : [] }));

        return;
      }

      const sent = v.parse(v.object({ messages: v.array(v.object({ parts: v.array(v.object({ type: v.string(), text: v.string() })) })) }),
        JSON.parse(frame.init?.body ?? '{}'));

      const prompt = sent.messages.flatMap((message) => message.parts.map((part) => part.text)).join('');
      const base = { runId: 'review-run', timestamp: '2026-10-09T20:13:51.714Z' };

      events.push({ ...base, eventIndex: 0, type: 'run_start', agentId: 'root', userMessage: prompt });

      const ended: Extract<RunEvent, { type: 'run_end' }> = {
        ...base, eventIndex: 1, type: 'run_end', reason: answer.failure === undefined ? 'completed' : 'error',
      };

      if (answer.failure !== undefined) ended.error = answer.failure;
      events.push(ended);
      history.push({ id: frame.id, role: 'user', parts: [{ type: 'text', text: prompt }] });

      if (answer.text !== undefined) {
        history.push({ id: 'reply', role: 'assistant', parts: [{ type: 'text', text: answer.text }] });
        socket.send(chatChunkFrame({ requestId: frame.id, chunk: { type: 'text-delta', id: 'reply', delta: answer.text } }));
      }

      socket.send(answer.wireError === true
        ? chatErrorFrame({ requestId: frame.id, message: answer.failure ?? 'fixture failure' })
        : chatTerminalFrame({ requestId: frame.id }));
    } },
  });

  return { server, deleted: () => deleted,
    ask: () => askOnce({ origin: server.url.origin, identity: { kind: 'loopback' } },
      { subject: 'review-fixture', mission: 'Exercise the reviewer answer boundary.', model, files: [], prompt: 'Read the evidence and answer.' }) };
}

test('a truncated reviewer stream preserves its terminal failure instead of parsing absent or partial text', async () => {
  const failure = 'ChatGPT ended the stream before response.completed';

  for (const text of [undefined, '{"verdict":']) {
    const fixture = answeredReview({ failure, text, wireError: true });

    try {
      await expect(fixture.ask()).rejects.toThrow(failure);
      expect(fixture.deleted()).toBe(true);
    } finally { await fixture.server.stop(true); }
  }
});

test('a failed ledger ends the review even if the wire marked completion, and a genuinely empty answer is refused', async () => {
  for (const answer of [{ failure: 'The recorded reviewer operation failed.' }, {}]) {
    const fixture = answeredReview(answer);

    try {
      await expect(fixture.ask()).rejects.toThrow();
      expect(fixture.deleted()).toBe(true);
    } finally { await fixture.server.stop(true); }
  }

  const fixture = answeredReview({ text: '{"complete":true}' });

  try { expect(await fixture.ask()).toBe('{"complete":true}'); }
  finally { await fixture.server.stop(true); }
});

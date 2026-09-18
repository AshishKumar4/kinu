/**
 * ONE turn through the product's PUBLIC surface, inside the pool.
 *
 * WHAT IS PLATFORM HERE, by this layer's own rule. The subject is not the
 * orchestrator's arithmetic — it is the three runtime mechanisms the public door
 * is built out of, none of which `bun test` has: a WebSocket UPGRADE answered by
 * a Worker and carried back to its caller (101 plus a live `response.webSocket`,
 * which bun's fetch cannot produce), the agents-SDK chat rail running inside the
 * Durable Object that owns the conversation, and the durable transcript read
 * back over HTTP from that same object's SQLite. Until this file the whole door
 * was measured only against a deployment (`tests/evals/public-session.ts`), so a
 * break in the route table, the upgrade, or the identity gate was findable only
 * after a deploy.
 *
 * THE PATH, all of it the product's own: `POST /api/user/workspaces` creates the
 * workspace (`handleCreateWorkspaceRequest`, the same handler the CLI plane
 * calls), the socket is opened at `/agents/orchestrator-agent/<name>` and the
 * turn is a `cf_agent_use_chat_request` frame carrying one UIMessage, and the
 * ANSWER is read from `GET /agents/.../get-messages` — the route the web pane is
 * seeded from — rather than from the stream, so what is asserted is what the
 * object durably recorded.
 *
 * THE MODEL SEAM IS THE HTTP ONE, pinned over the product's own `setModel`, and
 * that choice is a measurement rather than a preference: driven instead through
 * the `AI` SERVICE binding on 2026-09-16, the turn's answer still arrived and
 * committed but the model stream's EOF did not — four `llm_call.deferred_rejected`
 * lines, one `chat.stream_observe_failed`, and workerd cancelling the abandoned
 * callee as hung — because the adapter reads the stream's head eagerly and pulls
 * the rest lazily (`direct-workers-ai-fetch.ts:279-330`) and an RPC response body
 * cannot be read after its invocation ends; reproduced identically with the socket
 * opened on the workspace object's own stub, so it is the model plane's shape.
 * Production's `AI` is a Workers AI binding over a subrequest
 * (`wrangler.jsonc:373`), so the seam under test here — openai-compat over the
 * global fetch — is the shape production actually takes.
 *
 * The fake's turn lane answers `echo:<last typed user line>`, so the assertion is
 * an exact string: the answer in the transcript is this test's prompt, echoed,
 * which is only true if the frame reached the DO, the turn ran, and the
 * transcript was written.
 *
 * NO CLOCK. Every wait here ends on a frame the runtime sent — the terminal
 * `done` frame, or the `done` frame that carries the DO's own failure words.
 */
import { env } from 'cloudflare:test';
import { CHAT_MESSAGE_TYPES } from 'agents/chat';
import { ORCHESTRATOR_AGENT_SLUG } from '@kinu.run/core';
import { describe, expect, it } from 'vitest';
import * as v from 'valibot';

/** Loopback: the one host `authenticateRequest` accepts without an identity
 *  secret, because possession of the machine is the boundary there
 *  (auth/session.ts:200-213). */
const ORIGIN = 'http://localhost';

const PROMPT = 'ping from the pool';

const WorkspaceEntrySchema = v.object({ name: v.string() });

const HistorySchema = v.array(v.object({
  role: v.string(),
  parts: v.optional(v.array(v.object({ type: v.string(), text: v.optional(v.string()) }))),
}));

const FrameSchema = v.object({
  type: v.string(),
  id: v.optional(v.string()),
  body: v.optional(v.string()),
  done: v.optional(v.boolean()),
  error: v.optional(v.union([v.boolean(), v.string()])),
  success: v.optional(v.boolean()),
  result: v.optional(v.unknown()),
});

const SetModelSchema = v.object({ spec: v.string() });

/** The credential the pinned model resolves through — the same fixture the
 *  two-turn probe installs, whose `baseURL` is the Node-side fake's host. */
const FIXTURE_CREDENTIAL = {
  kind: 'openai-compat',
  baseURL: 'http://fake-models.invalid/v1',
  apiKey: 'probe-fixture-key',
};

/** The model the fake echoes for. `openai-compat` is the provider the static
 *  credential above serves, so the spec is the product's own spelling. */
const PINNED_MODEL = 'openai-compat/probe';

async function publicJson<T>(path: string, schema: v.GenericSchema<T>, init?: RequestInit): Promise<T> {
  const response = await env.PUBLIC_SURFACE.fetch(`${ORIGIN}${path}`, init);
  const text = await response.text();

  if (!response.ok) throw new Error(`${path} answered ${String(response.status)}: ${text.slice(0, 400)}`);

  return v.parse(schema, JSON.parse(text));
}

/** One `{type:'rpc', …}` frame — the shape the agents-SDK client sends for a
 *  callable method, which is what the web client's `rpc()` wrapper is bound to.
 *  The type word is a literal because the SDK exports no constant for it. */
function rpcRequest(id: string, method: string, args: readonly string[]): string {
  return JSON.stringify({ type: 'rpc', id, method, args: [...args] });
}

/** The chat frame the web client's transport sends, by the SDK's own constant so
 *  a rename there is a compile error rather than a silent hang. */
function chatRequest(id: string, text: string): string {
  return JSON.stringify({
    type: CHAT_MESSAGE_TYPES.USE_CHAT_REQUEST,
    id,
    init: {
      method: 'POST',
      body: JSON.stringify({
        messages: [{ id: `input-${id}`, role: 'user', parts: [{ type: 'text', text }] }],
        trigger: 'submit-message',
      }),
    },
  });
}

describe('the public surface, driven inside the pool', () => {
  it('creates a workspace over REST and answers one socket turn', async () => {
    // The Settings pane's own route: the fixture credential is what the pinned
    // model resolves its baseURL and key through, so the turn's requests are
    // addressed at the fake by the product's credential store, not by a flag.
    await publicJson(`/api/user/credentials/openai-compat.default`, v.object({ ok: v.boolean() }), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(FIXTURE_CREDENTIAL),
    });

    const created = await publicJson('/api/user/workspaces', WorkspaceEntrySchema, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      // No `purpose`: a mission on the create would queue the workspace's own
      // genesis turn, and this file's subject is ONE turn, the one it sends.
      body: JSON.stringify({ name: 'pool-public', displayName: 'Pool Public Surface' }),
    });

    const socketPath = `/agents/${ORCHESTRATOR_AGENT_SLUG}/${encodeURIComponent(created.name)}`;

    const upgrade = await env.PUBLIC_SURFACE.fetch(new Request(`${ORIGIN}${socketPath}`, {
      headers: { Upgrade: 'websocket' },
    }));

    expect(upgrade.status).toBe(101);
    const socket = upgrade.webSocket;

    if (socket === null) throw new Error('the public chat route answered 101 without a WebSocket');
    socket.accept();

    const pinned = Promise.withResolvers<unknown>();
    const turn = Promise.withResolvers<void>();
    socket.addEventListener('message', (event) => {
      const raw = v.is(v.string(), event.data) ? event.data : '';
      const frame = v.safeParse(FrameSchema, raw.startsWith('{') ? JSON.parse(raw) : {});

      if (!frame.success) return;

      // An RPC REPLY, told from a request by the field only a reply carries.
      if (frame.output.type === 'rpc' && frame.output.id === 'pin' && frame.output.success !== undefined) {
        if (frame.output.success) pinned.resolve(frame.output.result);
        else pinned.reject(new Error(`setModel was refused: ${JSON.stringify(frame.output.error)}`));

        return;
      }

      if (frame.output.type !== CHAT_MESSAGE_TYPES.USE_CHAT_RESPONSE) return;

      if (frame.output.id !== PROMPT) return;

      // `error` is carried on non-terminal frames too — a broken RELAY is
      // reported that way while the turn goes on (chat-transport.ts:432-446) —
      // so what settles this wait is the DO saying `done`, and only a `done`
      // frame that also carries `error` is a failed turn, in its own words.
      if (frame.output.done !== true) return;

      if (frame.output.error === true) {
        turn.reject(new Error(`the turn failed: ${frame.output.body ?? 'no body'}`));

        return;
      }

      turn.resolve();
    });
    socket.addEventListener('close', () => {
      turn.reject(new Error('the public chat socket closed before the turn finished'));
    });

    // Pin the arm's model before the prompt, the call the web client makes for
    // the model menu. The accepted spec is asserted by CONTAINMENT because the
    // deployment normalizes a spec, and what matters is that no substitution
    // happened: a turn on the account default would answer from another lane.
    socket.send(rpcRequest('pin', 'setModel', [PINNED_MODEL]));
    expect(v.parse(SetModelSchema, await pinned.promise).spec).toContain(PINNED_MODEL);

    socket.send(chatRequest(PROMPT, PROMPT));
    await turn.promise;

    const history = await publicJson(`${socketPath}/get-messages`, HistorySchema);

    const said = history.map((row) => ({
      role: row.role,
      text: (row.parts ?? []).filter((part) => part.type === 'text').map((part) => part.text ?? '').join(''),
    }));

    expect(said.filter((row) => row.role === 'user' || row.role === 'assistant')).toEqual([
      { role: 'user', text: PROMPT },
      { role: 'assistant', text: `echo:${PROMPT}` },
    ]);

    socket.close();
    // The model fake's captured log is one Node-side module for every worker
    // bound to it, and `two-turn.test.ts:281` reads it unfiltered: this file
    // borrows the log and hands it back empty.
    await env.SURFACE_CONTROL.resetModelLog();
  });
});

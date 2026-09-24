/**
 * A scoped CLI token's workspace socket holds exactly the authority of the token behind its ticket. Driven through
 * the production Worker in the pool, as the CLI does: device sign-in, an access token, its connect ticket, the socket.
 * The scopes are the token's at the moment the ticket is spent: a client-sent scopes header is replaced at the edge,
 * the socket cannot write the agent's synced state, and a token revoked after its ticket was minted opens nothing.
 */
import { env } from 'cloudflare:workers';
import { MessageType } from 'agents';
import { ORCHESTRATOR_AGENT_SLUG } from '@kinu.run/core';
import { expect, it } from 'vitest';
import * as v from 'valibot';

/** Loopback: the one host `authenticateRequest` accepts without an identity secret (auth/session.ts). */
const ORIGIN = 'http://localhost';

const StartedSchema = v.object({ deviceToken: v.string(), userCode: v.string() });

const ApprovedSchema = v.object({ status: v.literal('approved'), token: v.string() });

const TokenSchema = v.object({ token: v.string() });

const TicketSchema = v.object({ ticket: v.string() });

const RpcAnswerSchema = v.object({
  type: v.literal('rpc'),
  id: v.string(),
  success: v.boolean(),
  error: v.optional(v.string()),
});

const StateRefusedSchema = v.object({ type: v.literal(MessageType.CF_AGENT_STATE_ERROR), error: v.string() });

/** The forged state, as the object would broadcast it to every other socket had it accepted the write. */
const FORGED_STATE = { forged: 'scoped-socket' } as const;

const ForgedBroadcastSchema = v.object({
  type: v.literal(MessageType.CF_AGENT_STATE),
  state: v.object({ forged: v.literal(FORGED_STATE.forged) }),
});

async function publicJson<T>(path: string, schema: v.GenericSchema<T>, init?: RequestInit): Promise<T> {
  const response = await env.PUBLIC_SURFACE.fetch(`${ORIGIN}${path}`, init);
  const text = await response.text();

  if (!response.ok) throw new Error(`${path} answered ${String(response.status)}: ${text.slice(0, 400)}`);

  return v.parse(schema, JSON.parse(text));
}

/** A JSON POST as the CLI sends it: the body already serialized, the bearer when one is signed in. */
function postJson(body: string, bearer?: string): RequestInit {
  const headers = new Headers({ 'content-type': 'application/json' });

  if (bearer !== undefined) headers.set('authorization', `Bearer ${bearer}`);

  return { method: 'POST', headers, body };
}

/** `kinu auth`: start, approve in the browser the loopback host signs in, poll for the session token. */
async function cliSession(): Promise<string> {
  const started = await publicJson('/api/cli/auth/start', StartedSchema, postJson(JSON.stringify({ deviceName: 'pool' })));
  const page = await env.PUBLIC_SURFACE.fetch(`${ORIGIN}/cli/auth?code=${encodeURIComponent(started.userCode)}`);
  const cookie = (page.headers.get('set-cookie') ?? '').split(';')[0] ?? '';
  const csrf = cookie.slice(cookie.indexOf('=') + 1);

  await page.text();

  const approval = await env.PUBLIC_SURFACE.fetch(`${ORIGIN}/cli/auth`, {
    method: 'POST',
    headers: { origin: ORIGIN, cookie },
    body: new URLSearchParams({ userCode: started.userCode, csrf }),
  });

  expect(approval.status, await approval.text()).toBe(200);

  return (await publicJson('/api/cli/auth/poll', ApprovedSchema, postJson(JSON.stringify({ deviceToken: started.deviceToken })))).token;
}

/** A workspace, a signed-in CLI, and a connect ticket for an access token holding `scopes`. */
async function ticketFor(workspace: string, token: string, scopes: readonly string[]) {
  await publicJson('/api/user/workspaces', v.object({ name: v.string() }), postJson(JSON.stringify({ name: workspace, displayName: workspace })));
  const session = await cliSession();
  const minted = await publicJson('/api/cli/tokens', TokenSchema, postJson(JSON.stringify({ name: token, scopes }), session));
  const { ticket } = await publicJson(`/api/cli/workspaces/${workspace}/connect-ticket`, TicketSchema, postJson('{}', minted.token));

  return { session, ticket };
}

function upgrade(workspace: string, ticket: string, headers: Record<string, string> = {}): Promise<Response> {
  return env.PUBLIC_SURFACE.fetch(new Request(
    `${ORIGIN}/agents/${ORCHESTRATOR_AGENT_SLUG}/${workspace}?ticket=${encodeURIComponent(ticket)}`,
    { headers: { Upgrade: 'websocket', ...headers } },
  ));
}

function accepted(answer: Response): WebSocket {
  expect(answer.status).toBe(101);
  const socket = answer.webSocket;

  if (socket === null) throw new Error('the workspace route answered 101 without a WebSocket');
  socket.accept();

  return socket;
}

/** Resolves with the first frame `schema` admits; each call listens from the moment it is made. */
function nextFrame<T>(socket: WebSocket, schema: v.GenericSchema<T>): Promise<T> {
  const arrived = Promise.withResolvers<T>();

  const listen = (event: MessageEvent) => {
    const frame = v.safeParse(schema, v.is(v.string(), event.data) ? JSON.parse(event.data) : null);

    if (!frame.success) return;
    socket.removeEventListener('message', listen);
    arrived.resolve(frame.output);
  };

  socket.addEventListener('message', listen);

  return arrived.promise;
}

it('an exec-only token cannot widen its socket by sending the scopes header', async () => {
  const { ticket } = await ticketFor('pool-scoped', 'ci', ['workspace.exec']);
  const socket = accepted(await upgrade('pool-scoped', ticket, { 'x-kinu-cli-scopes': 'workspace.read,workspace.exec' }));

  // A read row the socket serves: without the scope gate this call succeeds.
  const read = nextFrame(socket, RpcAnswerSchema);

  socket.send(JSON.stringify({ type: 'rpc', id: 'memory-read', method: 'getMemoryContent', args: [] }));
  expect(await read).toMatchObject({ id: 'memory-read', success: false });
  expect((await read).error).toContain('workspace.read');

  // The owner's open tab: an accepted write reaches it as a broadcast, so exactly one of the two frames arrives.
  const tab = accepted(await env.PUBLIC_SURFACE.fetch(new Request(`${ORIGIN}/agents/${ORCHESTRATOR_AGENT_SLUG}/pool-scoped`, {
    headers: { Upgrade: 'websocket' },
  })));

  const write = Promise.race([
    nextFrame(socket, StateRefusedSchema).then((frame) => frame.error),
    nextFrame(tab, ForgedBroadcastSchema).then(() => 'the forged state reached the owner\'s tab'),
  ]);

  socket.send(JSON.stringify({ type: MessageType.CF_AGENT_STATE, state: FORGED_STATE }));
  expect(await write).toBe('Connection is readonly');
  socket.close();
  tab.close();
});

it('a ticket minted before its token was revoked opens nothing', async () => {
  const { session, ticket } = await ticketFor('pool-revoked', 'ci-revoked', ['workspace.exec']);

  const revoked = await env.PUBLIC_SURFACE.fetch(`${ORIGIN}/api/cli/tokens/ci-revoked`, {
    method: 'DELETE',
    headers: { authorization: `Bearer ${session}` },
  });

  expect(revoked.status, await revoked.text()).toBe(200);
  const answer = await upgrade('pool-revoked', ticket);

  expect(answer.status, await answer.text()).toBe(401);
});

/**
 * The scripted model on the network, for the tiers that drive a deployment: kinu.run and staging call it as an
 * account's `openai-compat` provider, the way a local run calls `startScriptedModel`, and it answers from the same
 * protocol and the same script (`tierModel`). Every answer is a pure function of the request, but for an OAuth
 * grant's refresh generation.
 *
 * It is its own Worker on a Workers Custom Domain, `scripted-model.kinu.run`, because the product's Worker may fetch a
 * Worker of the same account only through a service binding, the `global_fetch_strictly_public` flag, or a Custom
 * Domain (Workers fetch docs; anything else answers error 1042), and the first two would put a test fixture into
 * production's own configuration.
 *
 * It also serves an MCP server whose sessions end on cue (scripted-mcp.ts), that server again behind OAuth with
 * expiring access tokens and rotating refresh tokens (scripted-mcp-oauth.ts). Its route is public, so it answers only a
 * request bearing `SCRIPTED_MODEL_KEY`, the secret deploy.sh uploads with it and the tiers store as the scripted
 * account's model key (scripted-tier.ts), except the OAuth routes a client reaches before and after a person
 * authorizes, each of which checks what it was handed against that key. It reads a body only up to MAX_BODY_BYTES. A
 * refresh grant's generation is its one state, held by `ScriptedOAuthGrants`.
 */
import * as v from 'valibot';
import { PLATFORM_CATALOG } from '../packages/core/src/platform-catalog';
import { timingSafeEqual } from '../packages/core/src/utils/crypto';
import { SCRIPTED_MCP_PATH, scriptedMcp, type McpAnswer } from './scripted-mcp';
import { OAUTH_AUTHORIZE_PATH, downFor, isPublicOAuthPath, scriptedOAuth, type GrantLedger } from './scripted-mcp-oauth';
import { tierModel } from './tier-model';
import { SCRIPTED_MODELS_BODY, errorAnswer, pacedStream, readScriptedRequest, scriptedBody } from './scripted-protocol';

/** A Durable Object id, as much of it as this Worker reads. */
interface GrantsId {
  toString(): string;
}

/** The Durable Object namespace of `ScriptedOAuthGrants`, as much of it as this Worker calls. */
interface GrantsNamespace {
  idFromName(name: string): GrantsId;
  get(id: GrantsId): { fetch(request: Request): Promise<Response> };
}

interface Env {
  readonly SCRIPTED_MODEL_KEY?: string;
  readonly OAUTH_GRANTS?: GrantsNamespace;
}

/** Storage as a grant's object reads it: its generation and whether it is revoked. */
export interface GrantStorage {
  get(key: string): Promise<number | boolean | undefined>;
  put(key: string, value: number | boolean): Promise<void>;
}

/**
 * One OAuth grant's generations: which refresh token is current, and through which generation its access tokens are
 * expired. Its storage calls hold the object's input gate, so two refreshes of one grant are answered one after the
 * other: the second presents a used generation and revokes the grant.
 */
export class ScriptedOAuthGrants {
  constructor(private readonly state: { readonly storage: GrantStorage }) {}

  async fetch(request: Request): Promise<Response> {
    const { pathname, searchParams } = new URL(request.url);
    const presented = Number(searchParams.get('generation'));

    if (pathname === '/expire') {
      await this.state.storage.put('expiredThrough', Math.max(presented, await this.number('expiredThrough', -1)));

      return Response.json({ expired: true });
    }

    if (pathname === '/expired') return Response.json({ expired: presented <= await this.number('expiredThrough', -1) });
    const current = await this.number('generation', 0);

    if ((await this.state.storage.get('revoked')) === true || presented !== current) {
      await this.state.storage.put('revoked', true);

      return Response.json({ rotation: 'reused' });
    }

    await this.state.storage.put('generation', current + 1);

    return Response.json({ rotation: 'rotated' });
  }

  private async number(key: string, otherwise: number): Promise<number> {
    const stored = await this.state.storage.get(key);

    return typeof stored === 'number' ? stored : otherwise;
  }
}

/** The grants namespace as one process holds it, for a run with no Durable Objects: a map of objects, each over a map. */
export function inMemoryGrants(): GrantsNamespace {
  const objects = new Map<string, ScriptedOAuthGrants>();

  return {
    idFromName: (name) => ({ toString: () => name }),
    get: (id) => {
      const name = id.toString();
      const kept = new Map<string, number | boolean>();
      const object = objects.get(name) ?? new ScriptedOAuthGrants({ storage: { get: async (key) => kept.get(key), put: async (key, value) => { kept.set(key, value); } } });

      objects.set(name, object);

      return object;
    },
  };
}

const RotationSchema = v.object({ rotation: v.picklist(['rotated', 'reused']) });

const ExpiredSchema = v.object({ expired: v.boolean() });

function grantLedger(grants: GrantsNamespace): GrantLedger {
  const ask = async <S extends v.GenericSchema>(schema: S, grant: string, action: 'rotate' | 'expire' | 'expired', generation: number): Promise<v.InferOutput<S>> => {
    const answer = await grants.get(grants.idFromName(grant)).fetch(new Request(`https://grants/${action}?generation=${String(generation)}`, { method: 'POST' }));

    return v.parse(schema, await answer.json());
  };

  return {
    rotate: async (grant, generation) => (await ask(RotationSchema, grant, 'rotate', generation)).rotation,
    expire: async (grant, generation) => { await ask(ExpiredSchema, grant, 'expire', generation); },
    expired: async (grant, generation) => (await ask(ExpiredSchema, grant, 'expired', generation)).expired,
  };
}

const answered = (answer: McpAnswer): Response => new Response(answer.body, { status: answer.status, headers: answer.headers });

/** A sixteenth of an isolate's memory: the body is read whole and parsed, so a larger one could take the isolate. */
export const MAX_BODY_BYTES = PLATFORM_CATALOG['worker.isolate.memory'].limit.value / 16;

const refused = (status: number, message: string): Response => Response.json({ error: { message } }, { status });

/** The body as text, or null past `limit` bytes; the declared length is not trusted, the bytes are counted. */
async function boundedText(request: Request, limit: number): Promise<string | null> {
  if (Number(request.headers.get('content-length') ?? 0) > limit) return null;
  const reader = request.body?.getReader();

  if (reader === undefined) return '';
  const chunks: Uint8Array[] = [];
  let size = 0;

  for (let next = await reader.read(); next.done !== true; next = await reader.read()) {
    size += next.value.byteLength;

    if (size > limit) {
      await reader.cancel();

      return null;
    }

    chunks.push(next.value);
  }

  const whole = new Uint8Array(size);
  let at = 0;

  for (const chunk of chunks) {
    whole.set(chunk, at);
    at += chunk.byteLength;
  }

  return new TextDecoder().decode(whole);
}

/** An OAuth route's answer (scripted-mcp-oauth.ts), or null where the path is none of them. */
async function oauthAnswer(request: Request, env: Env, keyed: { readonly url: URL; readonly key: string; readonly keyed: boolean }): Promise<Response | null> {
  if (env.OAUTH_GRANTS === undefined) return refused(503, 'this scripted model has no OAUTH_GRANTS binding, so it grants nothing');

  const body = request.method === 'POST' ? await boundedText(request, MAX_BODY_BYTES) : '';

  if (body === null) return refused(413, `the body is over ${String(MAX_BODY_BYTES)} bytes`);

  const answer = await scriptedOAuth({
    method: request.method, url: keyed.url, headers: request.headers, body, now: Date.now(), nonce: crypto.randomUUID().slice(0, 8),
    key: keyed.key, keyed: keyed.keyed, ledger: grantLedger(env.OAUTH_GRANTS),
  });

  return answer === null ? null : answered(answer);
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const key = env.SCRIPTED_MODEL_KEY ?? '';

    if (key === '') return refused(503, 'this scripted model has no SCRIPTED_MODEL_KEY, so it answers nobody');
    const url = new URL(request.url);
    const { pathname } = url;
    const keyed = timingSafeEqual(request.headers.get('authorization') ?? '', `Bearer ${key}`);

    const oauth = isPublicOAuthPath(pathname) || pathname === OAUTH_AUTHORIZE_PATH ? await oauthAnswer(request, env, { url, key, keyed }) : null;

    if (oauth !== null) return oauth;

    if (!keyed) return refused(401, 'unauthorized');

    if (pathname === '/models' && request.method === 'GET') {
      return new Response(SCRIPTED_MODELS_BODY, { headers: { 'content-type': 'application/json' } });
    }

    if (pathname === SCRIPTED_MCP_PATH) {
      const down = downFor(url, Date.now());

      if (down !== null) return answered(down);
      const body = request.method === 'POST' ? await boundedText(request, MAX_BODY_BYTES) : '';

      if (body === null) return refused(413, `the body is over ${String(MAX_BODY_BYTES)} bytes`);

      return answered(scriptedMcp({ method: request.method, session: request.headers.get('mcp-session-id'), body }, Date.now(), crypto.randomUUID().slice(0, 8)));
    }

    if (pathname === '/chat/completions' && request.method === 'POST') {
      const text = await boundedText(request, MAX_BODY_BYTES);

      if (text === null) return refused(413, `the body is over ${String(MAX_BODY_BYTES)} bytes`);
      const read = readScriptedRequest(text);

      if ('refusal' in read) {
        return new Response(read.refusal.body, { status: read.refusal.status, headers: { 'content-type': 'application/json' } });
      }

      const asked = read.request;
      const answer = tierModel(asked);

      const failed = errorAnswer(answer);

      if (failed !== null) return new Response(failed.body, { status: failed.status, headers: failed.headers });

      if (asked.streamed && answer.pace !== undefined) {
        const encoder = new TextEncoder();
        const chunks = pacedStream(answer, answer.pace, asked, (ms) => new Promise((resolve) => { setTimeout(resolve, ms); }));

        const body = new ReadableStream<Uint8Array>({
          async pull(controller) {
            const next = await chunks.next();

            if (next.done === true) controller.close();
            else controller.enqueue(encoder.encode(next.value));
          },
        });

        return new Response(body, { headers: { 'content-type': 'text/event-stream' } });
      }

      const { contentType, body } = scriptedBody(answer, asked);

      return new Response(body, { headers: { 'content-type': contentType } });
    }

    return new Response('not found', { status: 404 });
  },
};

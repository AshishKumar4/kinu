/**
 * The scripted model on the network, for the tiers that drive a deployment: kinu.run and staging call it as an
 * account's `openai-compat` provider, the way a local run calls `startScriptedModel`, and it answers from the same
 * protocol and the same script (`tierModel`). Every answer is a pure function of the request, so this Worker holds no
 * state.
 *
 * It is its own Worker on a Workers Custom Domain, `scripted-model.kinu.run`, because the product's Worker may fetch a
 * Worker of the same account only through a service binding, the `global_fetch_strictly_public` flag, or a Custom
 * Domain (Workers fetch docs; anything else answers error 1042), and the first two would put a test fixture into
 * production's own configuration.
 *
 * Its route is public, so it answers only a request bearing `SCRIPTED_MODEL_KEY`, the secret deploy.sh uploads with
 * it and the tiers store as the scripted account's API key (scripted-tier.ts), and it reads a body only up to
 * MAX_BODY_BYTES.
 */
import { PLATFORM_CATALOG } from '../packages/core/src/platform-catalog';
import { tierModel } from './tier-model';
import { SCRIPTED_MODELS_BODY, pacedStream, readScriptedRequest, scriptedBody } from './scripted-protocol';

interface Env {
  readonly SCRIPTED_MODEL_KEY?: string;
}

/** A sixteenth of an isolate's memory: the body is read whole and parsed, so a larger one could take the isolate. */
export const MAX_BODY_BYTES = PLATFORM_CATALOG['worker.isolate.memory'].limit.value / 16;

const refused = (status: number, message: string): Response => Response.json({ error: { message } }, { status });

/** Equal in time whatever the first differing byte, so the answer's timing does not spell the key. */
function sameKey(offered: string, key: string): boolean {
  const a = new TextEncoder().encode(offered);
  const b = new TextEncoder().encode(key);
  let differ = a.length ^ b.length;

  for (let index = 0; index < b.length; index += 1) differ |= (a[index] ?? 0) ^ (b[index] ?? 0);

  return differ === 0;
}

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

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const key = env.SCRIPTED_MODEL_KEY ?? '';

    if (key === '') return refused(503, 'this scripted model has no SCRIPTED_MODEL_KEY, so it answers nobody');

    if (!sameKey(request.headers.get('authorization') ?? '', `Bearer ${key}`)) return refused(401, 'unauthorized');
    const { pathname } = new URL(request.url);

    if (pathname === '/models' && request.method === 'GET') {
      return new Response(SCRIPTED_MODELS_BODY, { headers: { 'content-type': 'application/json' } });
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

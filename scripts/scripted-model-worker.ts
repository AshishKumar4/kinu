/**
 * The scripted model on the network, for the tiers that drive a deployment: kinu.run and staging call it as an
 * account's `openai-compat` provider, the way a local run calls `startScriptedModel`, and it answers from the same
 * protocol and the same script (`tierModel`). Every answer is a pure function of the request, so this Worker holds no
 * state and no secret.
 *
 * It is its own Worker on a Workers Custom Domain, `scripted-model.kinu.run`, because the product's Worker may fetch a
 * Worker of the same account only through a service binding, the `global_fetch_strictly_public` flag, or a Custom
 * Domain (Workers fetch docs; anything else answers error 1042), and the first two would put a test fixture into
 * production's own configuration.
 */
import { tierModel } from './tier-model';
import { SCRIPTED_MODELS_BODY, pacedStream, readScriptedRequest, scriptedBody } from './scripted-protocol';

export default {
  async fetch(request: Request): Promise<Response> {
    const { pathname } = new URL(request.url);

    if (pathname === '/models' && request.method === 'GET') {
      return new Response(SCRIPTED_MODELS_BODY, { headers: { 'content-type': 'application/json' } });
    }

    if (pathname === '/chat/completions' && request.method === 'POST') {
      const asked = readScriptedRequest(await request.text());
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

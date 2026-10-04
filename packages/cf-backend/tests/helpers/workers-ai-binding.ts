import { createServer } from 'node:http';
import * as v from 'valibot';
import type { RemoteProxyConnectionString, Response as MiniflareResponse } from 'miniflare';
import { CLEF_BINDING_ANSWER } from '../../../test-utils/src/clef-binding-answer';

/** One `env.AI.run(model, inputs)` as the installed binding sends it: the model in a header, the inputs in the body. */
export interface AiRun {
  readonly model: string;
  readonly inputs: v.InferOutput<typeof AiInputsSchema>;
}

const AiInputsSchema = v.looseObject({
  messages: v.optional(v.array(v.looseObject({ role: v.optional(v.string()), content: v.optional(v.unknown()) }))),
  stream: v.optional(v.boolean()),
  state: v.optional(v.string()),
  questions: v.optional(v.record(v.string(), v.unknown())),
});

export async function readAiRun(request: Request): Promise<AiRun> {
  const { inputs } = v.parse(v.looseObject({ inputs: AiInputsSchema }), await request.json());

  return { model: request.headers.get('mf-header-cf-consn-model-id') ?? '', inputs };
}

/** The decision models (core's `DECISION_MODELS`); the vitest config loads in Node, where core's source does not. */
const DECISION_MODEL_IDS: ReadonlySet<string> = new Set(['@cf/cloudflare/clef', '@cf/cloudflare/clef-flash']);

/** The product lanes that call the binding, each known by its real request shape: a decision model's `state` and
 *  `questions` (rating), a chat led by a system message (title), a user-only chat (sleep-time judge). Turns stream over
 *  the HTTP seam, never here. */
export const AI_LANES = ['decision', 'title', 'sleep'] as const;

export function aiLane({ model, inputs }: AiRun): (typeof AI_LANES)[number] | null {
  if (DECISION_MODEL_IDS.has(model) && inputs.state !== undefined && inputs.questions !== undefined) return 'decision';

  const messages = inputs.messages ?? [];

  if (inputs.stream === true || messages.length === 0) return null;

  if (messages[0]?.role === 'system') return 'title';

  return messages.every((message) => message.role === 'user') ? 'sleep' : null;
}

/** A rating with what Clef answered on the binding (`CLEF_BINDING_ANSWER`, measured 2026-10-02), a title, an empty
 *  sleep-time update. Any other run is refused with its model and keys, so a new caller fails by name. */
export function workersAiAnswer(run: AiRun): Response {
  switch (aiLane(run)) {
    case 'decision': return Response.json(CLEF_BINDING_ANSWER);
    case 'title': return Response.json({ response: JSON.stringify({ title: 'Probe Workspace' }) });
    case 'sleep': return Response.json({ response: JSON.stringify({ upserts: [], decay: [] }) });
    case null: return Response.json(
      { errors: [{ message: `no fixture answers ${run.model} with keys ${Object.keys(run.inputs).join(', ')}` }] },
      { status: 400 },
    );
  }
}

const ProxyUrlSchema = v.custom<RemoteProxyConnectionString>((value) => v.is(v.instance(URL), value));

export async function workersAiBinding(answer: (request: Request) => Promise<Response | MiniflareResponse>) {
  const server = createServer((incoming, outgoing) => {
    const controller = new AbortController();

    outgoing.on('close', () => { if (!outgoing.writableEnded) controller.abort(); });
    void (async () => {
      const chunks: Buffer[] = [];

      for await (const chunk of incoming) chunks.push(Buffer.from(chunk));
      const headers = new Headers();

      for (const [name, value] of Object.entries(incoming.headers)) {
        if (value !== undefined) headers.set(name, Array.isArray(value) ? value.join(', ') : value);
      }

      const response = await answer(new Request(headers.get('mf-url') ?? 'https://workers-binding.ai/run?version=3', {
        method: incoming.method, headers, body: Buffer.concat(chunks).toString(), signal: controller.signal,
      }));

      outgoing.writeHead(response.status, Object.fromEntries(response.headers));

      if (response.body === null) outgoing.end();
      else {
        const reader = response.body.getReader();

        controller.signal.addEventListener('abort', () => { void reader.cancel().catch(outgoing.destroy.bind(outgoing)); }, { once: true });

        for (;;) {
          const chunk = await reader.read();

          if (chunk.done) break;
          outgoing.write(chunk.value);
        }

        outgoing.end();
      }
    })().catch(outgoing.destroy.bind(outgoing));
  });

  server.on('connection', (socket) => { socket.unref(); });
  await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', resolve); });
  server.unref();
  const address = v.parse(v.object({ port: v.number() }), server.address());

  return { binding: 'AI', remoteProxyConnectionString: v.parse(ProxyUrlSchema, new URL(`http://127.0.0.1:${address.port}`)) };
}

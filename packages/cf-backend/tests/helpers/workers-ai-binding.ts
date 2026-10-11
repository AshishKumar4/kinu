import { createServer } from 'node:http';
import * as v from 'valibot';
import type { RemoteProxyConnectionString, Response as MiniflareResponse } from 'miniflare';
import { startRemoteProxySession, unstable_readConfig } from 'wrangler';
import { fileURLToPath } from 'node:url';
import { restApiToken } from '../../../../scripts/cloudflare-rest';

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

export async function readAiRun(request: Pick<Request, 'json' | 'headers'>): Promise<AiRun> {
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

let remote: ReturnType<typeof startRemoteProxySession> | undefined;

let runningTest = 'native harness setup';

export function workersAiTestRunning(name: string): void { runningTest = name; }

async function refuseExhaustedQuota(answer: Response, model: string): Promise<void> {
  if (answer.status !== 429) return;

  const body = await answer.text();

  process.stderr.write(`Workers AI quota exhausted; model=${model}; test=${runningTest}\n${body}\n`);
  await closeRemoteWorkersAi();
  process.stderr.write('Wrangler remote AI session disposed; terminating the native run.\n');
  process.exit(1);
}

/** The native AI wire is passed to Wrangler's remote binding, never answered by a fixture. */
export async function remoteWorkersAi(request: Request): Promise<Response> {
  remote ??= startRemoteProxySession({ AI: { type: 'ai' } }, {
    auth: async () => {
      const accountId = unstable_readConfig({ config: fileURLToPath(new URL('../../wrangler.jsonc', import.meta.url)), env: 'staging' }).account_id;
      const apiToken = restApiToken();

      if (accountId === undefined || apiToken === '') throw new Error('Workers AI binding tests require the configured account and KINU_CLOUDFLARE_API_TOKEN from Armada secrets.');

      return { accountId, apiToken: { apiToken } };
    },
  });
  const session = await remote;
  const headers = new Headers(request.headers);
  headers.delete('host');
  headers.delete('content-length');
  const answer = await fetch(session.remoteProxyConnectionString, { method: request.method, headers, body: await request.arrayBuffer(), signal: request.signal });

  await refuseExhaustedQuota(answer, request.headers.get('mf-header-cf-consn-model-id') ?? 'not supplied by the binding');
  // fetch decoded the bytes; the binding must not gunzip them a second time.
  const decoded = new Headers(answer.headers);
  decoded.delete('content-encoding');
  decoded.delete('content-length');

  return new Response(answer.body, { status: answer.status, statusText: answer.statusText, headers: decoded });
}

export async function closeRemoteWorkersAi(): Promise<void> {
  if (remote !== undefined) await (await remote).dispose();
  remote = undefined;
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

  // Node closes an idle keep-alive connection (here 6 s after an answer); a call reaching it as it closes is lost
  // ("Network connection lost", measured in 1 ms steps 2026-10-03), the more often the busier the process. The
  // client owns its connections.
  server.keepAliveTimeout = 0;
  server.on('connection', (socket) => { socket.unref(); });
  await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', resolve); });
  server.unref();
  const address = v.parse(v.object({ port: v.number() }), server.address());

  return { binding: 'AI', remoteProxyConnectionString: v.parse(ProxyUrlSchema, new URL(`http://127.0.0.1:${address.port}`)) };
}

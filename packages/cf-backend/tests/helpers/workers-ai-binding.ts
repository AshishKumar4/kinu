import { createServer } from 'node:http';
import * as v from 'valibot';
import type { RemoteProxyConnectionString } from 'miniflare';

const ProxyUrlSchema = v.custom<RemoteProxyConnectionString>((value) => v.is(v.instance(URL), value));

export async function workersAiBinding(answer: (request: Request) => Promise<Response>) {
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

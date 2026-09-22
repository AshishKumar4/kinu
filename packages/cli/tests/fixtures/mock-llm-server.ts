/**
 * Out-of-process /chat/completions stub: PTY tests block the test's event loop. Also serves a
 * deny-all proxy and `/network-check`; prints `READY {"model":N,"proxy":N}` once listening.
 */
import * as v from 'valibot';

const answer = Bun.env.MOCK_LLM_ANSWER ?? 'ok';

const CompletionRequestSchema = v.object({ stream: v.optional(v.boolean()) });

interface CompletionChunk {
  id: string;
  object: 'chat.completion.chunk';
  created: number;
  model: string;
  choices: {
    index: number;
    delta: { role?: string; content?: string };
    finish_reason: string | null;
  }[];
}

// A child that bypasses the proxy still fails the test via `attempted`.
let networkAttempted = false;

const proxy = Bun.listen({
  hostname: '127.0.0.1',
  port: 0,
  socket: {
    data(socket) {
      networkAttempted = true;
      socket.end('HTTP/1.1 502 Offline fixture\r\nContent-Length: 0\r\nConnection: close\r\n\r\n');
    },
  },
});

const server = Bun.serve({
  port: 0,
  hostname: '127.0.0.1',
  async fetch(request) {
    const url = new URL(request.url);

    if (url.pathname === '/network-check') {
      if (request.method === 'POST') networkAttempted = false;

      return Response.json({ attempted: networkAttempted });
    }

    if (url.pathname.endsWith('/models')) {
      return Response.json({
        object: 'list',
        data: [{ id: 'mock-model', object: 'model', created: 1, owned_by: 'mock' }],
      });
    }

    if (!url.pathname.endsWith('/chat/completions')) {
      return new Response('not found', { status: 404 });
    }

    const body = v.parse(CompletionRequestSchema, await request.json());

    if (!body.stream) {
      return Response.json({
        id: 'chatcmpl-mock',
        object: 'chat.completion',
        created: 1,
        model: 'mock-model',
        choices: [
          { index: 0, message: { role: 'assistant', content: answer }, finish_reason: 'stop' },
        ],
      });
    }

    const chunk = (data: CompletionChunk) => `data: ${JSON.stringify(data)}\n\n`;

    return new Response(
      [
        chunk({
          id: 'chatcmpl-mock',
          object: 'chat.completion.chunk',
          created: 1,
          model: 'mock-model',
          choices: [
            {
              index: 0,
              delta: { role: 'assistant', content: answer },
              finish_reason: null,
            },
          ],
        }),
        chunk({
          id: 'chatcmpl-mock',
          object: 'chat.completion.chunk',
          created: 1,
          model: 'mock-model',
          choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
        }),
        'data: [DONE]\n\n',
      ].join(''),
      { headers: { 'content-type': 'text/event-stream' } },
    );
  },
});

console.log(`READY ${JSON.stringify({ model: server.port, proxy: proxy.port })}`);

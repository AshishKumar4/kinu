import * as v from 'valibot';
/**
 * The Node-side outbound handler for the two-turn HTTP-seam probe — the same
 * fail-and-record pattern the in-tree `slate-egress-probe` worker already
 * proves, and the host for the test-only control surface.
 *
 * WHAT REACHES HERE. `createAgentProviderRegistry` passes no `deps.fetch`
 * (owned-model-services.ts:90-98), so `createAuthedFetch` falls back to the
 * global fetch (providers/util.ts:73-74), which the pool routes through this
 * worker's `outboundService` callback. Three hosts are meaningful:
 *
 *  - `http://fake-models.invalid` — the model plane itself. The fixture
 *    credential's `baseURL` points every compat call at this host, so the
 *    requests it answers are exactly the turn's model traffic: streamed
 *    `/v1/chat/completions` posts keyed on the body `model` (never prompt
 *    text), plus the `/v1/models` listing the provider's `listModels` call
  *    makes. Unknown paths and unknown models throw loudly rather than
  *    defaulting to an echo: an unrecognized shape is a lane the probe does
  *    not satisfy.
  */

export interface CapturedHttpCall {
  readonly url: string;
  readonly method: string;
  readonly host: string;
  readonly path: string;
  readonly model: string;
  readonly stream: boolean;
  readonly users: string[];
  readonly authHeader: string | null;
  /** Tool definitions the request offered, by function name — the real
   *  registry surface as it reached the wire. */
  readonly offeredTools: string[];
  /** Assistant tool_calls in this request, by call id and function name. */
  readonly toolCalls: ReadonlyArray<{ id: string; name: string }>;
  /** `role: 'tool'` contents in this request — the executed results. */
  readonly toolResults: string[];
}

const log: CapturedHttpCall[] = [];

const TextPartSchema = v.object({ type: v.literal('text'), text: v.string() });

const MessageContentSchema = v.union([v.string(), v.array(v.unknown())]);

type MessageContent = v.InferOutput<typeof MessageContentSchema>;

// `content: null` is valid OpenAI wire for an assistant row whose only
// content is tool_calls — the exact shape the tool-call-only lane sends.
const NullableMessageContentSchema = v.union([v.null(), MessageContentSchema]);

const OutboundMessageSchema = v.object({
  role: v.optional(v.string()),
  content: v.optional(NullableMessageContentSchema),
  tool_calls: v.optional(v.array(v.object({
    id: v.string(),
    function: v.object({ name: v.string() }),
  }))),
});

const OutboundBodySchema = v.object({
  model: v.optional(v.string()),
  stream: v.optional(v.boolean()),
  messages: v.optional(v.array(OutboundMessageSchema)),
  tools: v.optional(v.array(v.object({ function: v.object({ name: v.string() }) }))),
});

type OutboundBody = v.InferOutput<typeof OutboundBodySchema>;

type SseDelta =
  | { content: string }
  | { role: string }
  | { tool_calls: ReadonlyArray<{ index: number; id: string; type: string; function: { name: string; arguments: string } }> };

function textOf(content: MessageContent | null | undefined): string {
  if (content === undefined || content === null) return '';

  if (Array.isArray(content)) {
    return content.flatMap((p) => {
      const part = v.safeParse(TextPartSchema, p);

      return part.success ? [part.output.text] : [];
    }).join('');
  }

  return content;
}

function sseChunk(delta: SseDelta, finishReason?: string): string {
  const base = { index: 0, delta };

  const choice = finishReason === undefined ? base : { ...base, finish_reason: finishReason };

  const chunk = {
    id: 'chatcmpl-probe',
    object: 'chat.completion.chunk',
    created: Math.floor(Date.now() / 1000),
    model: 'probe',
    choices: [choice],
  };

  return `data: ${JSON.stringify(chunk)}\n\n`;
}

function sseDone(): string {
  return 'data: [DONE]\n\n';
}

function recordCall(url: URL, request: Request, body: OutboundBody): void {
  const messages = body.messages ?? [];

  log.push({
    url: url.toString(),
    method: request.method,
    host: url.host,
    path: url.pathname,
    model: body.model ?? '',
    stream: body.stream === true,
    users: messages.filter((m) => m.role === 'user').map((m) => textOf(m.content)),
    authHeader: request.headers.get('authorization'),
    offeredTools: (body.tools ?? []).map((t) => t.function.name),
    toolCalls: messages.flatMap((m) => (m.tool_calls ?? [])
      .map((c) => ({ id: c.id, name: c.function.name }))),
    toolResults: messages
      .filter((m) => m.role === 'tool')
      .map((m) => textOf(m.content)),
  });
}

async function echoBody(body: OutboundBody): Promise<Response> {
  const users = (body.messages ?? []).filter((m) => m.role === 'user').map((m) => textOf(m.content));
  const text = users.filter((u) => !u.startsWith('<')).at(-1) ?? '';

  const encoder = new TextEncoder();

  const bodyChunks = [
    sseChunk({ content: `echo:${text}` }),
    sseChunk({ role: 'assistant' }, 'stop'),
    sseDone(),
  ];

  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        for (const c of bodyChunks) controller.enqueue(encoder.encode(c));

        controller.close();
      },
    }),
    { headers: { 'content-type': 'text/event-stream' } },
  );
}

async function earlyDoneBody(): Promise<Response> {
  // Producer-open: the content frame and [DONE] go out, then the body stays
  // open forever. The consumer's contract is to stop at [DONE]; whether the
  // runtime's subrequest machinery does the same is the discriminating datum
  // against the normal-EOF echo, which closes its own body.

  const encoder = new TextEncoder();

  const chunks = [
    sseChunk({ content: 'echo:early' }),
    sseChunk({ role: 'assistant' }, 'stop'),
    sseDone(),
  ];

  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        for (const c of chunks) controller.enqueue(encoder.encode(c));
      },
    }),
    { headers: { 'content-type': 'text/event-stream' } },
  );
}

async function toolBody(body: OutboundBody): Promise<Response> {
  const messages = body.messages ?? [];

  // The tool call fires on the FIRST request — no `role: 'tool'` row yet.
  // The second request carries the tool's result; answering its text then
  // proves the result arrived inside the model request.
  const sawToolResult = messages.some((m) => m.role === 'tool');
  const encoder = new TextEncoder();

  if (!sawToolResult) {
    const chunks = [
      sseChunk({ content: 'I will read that fixture file.' }),
      sseChunk({
        tool_calls: [{
          index: 0,
          id: 'call_probe_1',
          type: 'function',
          function: {
            name: 'file',
            arguments: JSON.stringify({ action: 'read', path: 'probe-fixture.txt' }),
          },
        }],
      }),
      sseChunk({ role: 'assistant' }, 'tool_calls'),
      sseDone(),
    ];

    return new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          for (const c of chunks) controller.enqueue(encoder.encode(c));

          controller.close();
        },
      }),
      { headers: { 'content-type': 'text/event-stream' } },
    );
  }

  const chunks = [
    sseChunk({ content: 'echo:tool-answered' }),
    sseChunk({ role: 'assistant' }, 'stop'),
    sseDone(),
  ];

  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        for (const c of chunks) controller.enqueue(encoder.encode(c));

        controller.close();
      },
    }),
    { headers: { 'content-type': 'text/event-stream' } },
  );
}

async function errorBody(body: OutboundBody): Promise<Response> {
  const messages = body.messages ?? [];

  // One hard failure, then recovery — so the provider-error case ends with a
  // settled turn rather than an owed one, which is what the probe asserts.
  // `recordCall` already logged this request, so the first call is the only
  // entry: a bare `some` would see itself and the 500 would never fire.
  if (log.filter((c) => c.model === 'probe-error').length <= 1) {
    return new Response(JSON.stringify({ error: { message: 'probe refuses this request' } }), { status: 500 });
  }

  const users = messages.filter((m) => m.role === 'user').map((m) => textOf(m.content));
  const text = users.filter((u) => !u.startsWith('<')).at(-1) ?? '';

  const encoder = new TextEncoder();

  const chunks = [
    sseChunk({ content: `echo:${text}` }),
    sseChunk({ role: 'assistant' }, 'stop'),
    sseDone(),
  ];

  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        for (const c of chunks) controller.enqueue(encoder.encode(c));

        controller.close();
      },
    }),
    { headers: { 'content-type': 'text/event-stream' } },
  );
}


/** The tool-call-only lane: a first step that carries the tool call and
 * NOTHING else — valid OpenAI wire (no leading text delta), the shape
 * real act-first models answer with. The step after the tool result answers
 * with text, exactly as the narrated tools lane does. The assistant row this
 * round-trips into the next request legally carries `content: null`, which is
 * why `OutboundMessageSchema` accepts it explicitly. */
async function toolCallOnlyBody(body: OutboundBody): Promise<Response> {
  const messages = body.messages ?? [];
  const encoder = new TextEncoder();

  if (messages.some((m) => m.role === 'tool')) {
    const chunks = [
      sseChunk({ content: 'echo:tool-answered' }),
      sseChunk({ role: 'assistant' }, 'stop'),
      sseDone(),
    ];

    return new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          for (const c of chunks) controller.enqueue(encoder.encode(c));

          controller.close();
        },
      }),
      { headers: { 'content-type': 'text/event-stream' } },
    );
  }

  const chunks = [
    sseChunk({
      tool_calls: [{
        index: 0,
        id: 'call_probe_only_1',
        type: 'function',
        function: {
          name: 'file',
          arguments: JSON.stringify({ action: 'read', path: 'probe-fixture.txt' }),
        },
      }],
    }),
    sseChunk({ role: 'assistant' }, 'tool_calls'),
    sseDone(),
  ];

  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        for (const c of chunks) controller.enqueue(encoder.encode(c));

        controller.close();
      },
    }),
    { headers: { 'content-type': 'text/event-stream' } },
  );
}

async function modelsBody(): Promise<Response> {
  return Response.json({
    data: [
      { id: 'probe' },
      { id: 'probe-early-done' },
      { id: 'probe-tools' },
      { id: 'probe-tools-only' },
      { id: 'probe-error' },
    ],
  });
}

/**
 * The outbound handler miniflare hands every subrequest on this worker.
 * Answers fake-model and probe-control hosts; records and throws everything
 * else — the "no passthrough" half of the contract.
 */
export async function probeOutbound(request: Request): Promise<Response> {
  const url = new URL(request.url);

  if (url.host === 'probe-control.invalid') {
    if (url.pathname === '/log' && request.method === 'GET') {
      return Response.json({ calls: [...log] });
    }

    if (url.pathname === '/reset' && request.method === 'POST') {
      log.length = 0;

      return Response.json({ ok: true });
    }

    throw new Error(`probe-control: unhandled ${request.method} ${url.pathname}`);
  }

  if (url.host === 'fake-models.invalid') {
    if (url.pathname === '/v1/models' && request.method === 'GET') {
      return modelsBody();
    }

    if (url.pathname === '/v1/chat/completions' && request.method === 'POST') {
      // SAFETY: the compat SDK posts JSON chat-completion bodies — parsed here
      // against `OutboundBodySchema` once, so every arm below reads typed
      // fields and unknown models throw rather than trusting the shape.
      const body = v.parse(OutboundBodySchema, await request.json());

      recordCall(url, request, body);

      switch (body.model) {
        case 'probe': return echoBody(body);
        case 'probe-early-done': return earlyDoneBody();
        case 'probe-tools': return toolBody(body);
        case 'probe-tools-only': return toolCallOnlyBody(body);
        case 'probe-error': return errorBody(body);
        default: throw new Error(`fake-models: unknown model ${JSON.stringify(body.model)}`);
      }
    }

    throw new Error(`fake-models: unhandled ${request.method} ${url.pathname}`);
  }

  throw new Error(`Outbound refused — not an expected probe endpoint: ${request.url}`);
}

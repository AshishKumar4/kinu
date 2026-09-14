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
  readonly conversation: ReadonlyArray<{ role: string; content: string }>;
  /** Non-text content parts per message — attachments as they reached the
   *  wire (image_url / file / input_audio), which `textOf` drops. */
  readonly fileParts: ReadonlyArray<ReadonlyArray<{ type: string; url: string }>>;
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

interface HeldGate {
  readonly arrived: PromiseWithResolvers<void>;
  readonly release: PromiseWithResolvers<void>;
}

/** Armed by `/queue/hold`: either the FIRST `probe-queue` call (no `from`), or
 *  every `probe-queue` call numbered `from` onward until `/queue/release`. The
 *  second shape is how a drive parks ONE turn's model call — the queued ask,
 *  the durable submission, the continuation — while the turns before it run
 *  to completion. `arrived` resolves on the first call actually held, so a
 *  prepare RPC can join on "the held call exists" rather than a counter. */
let heldRequest: { readonly gate: HeldGate; readonly from: number } | null = null;

/**
 * The parity lane's own hold, armed by `/parity/hold`: the next `probe-parity`
 * call named by `parkAt` parks — `first` parks the turn's opening call
 * before it answers (the mid-turn window), `partial` streams one text delta
 * of the tool-answering step and then parks with the body open, which is the
 * exact instant an eviction leaves a flushed partial and a settled tool
 * result behind. Released by `/parity/release`; the parked producer is then
 * finished so the runtime can reclaim it.
 */
let parityHold: { readonly gate: HeldGate; readonly parkAt: 'first' | 'partial' } | null = null;

/** The gate a parity call is parked on right now — kept apart from the armed
 *  hold so `/parity/release` still reaches it after the call consumed the arm. */
let parityParked: HeldGate | null = null;

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

/** The attachment halves of one message's content array: non-text parts the
 *  wire carries (`image_url`, `file`, `input_audio`), reduced to a comparable
 *  `{type,url}` so a splice assertion reads the part, not the adapter shape. */
function filePartsOf(content: MessageContent | null | undefined): { type: string; url: string }[] {
  if (!Array.isArray(content)) return [];

  return content.flatMap((part): { type: string; url: string }[] => {
    const image = v.safeParse(v.object({ type: v.literal('image_url'), image_url: v.object({ url: v.string() }) }), part);

    if (image.success) return [{ type: image.output.type, url: image.output.image_url.url }];

    const file = v.safeParse(v.object({ type: v.literal('file'), file: v.object({ file_data: v.string() }) }), part);

    if (file.success) return [{ type: file.output.type, url: file.output.file.file_data }];

    const audio = v.safeParse(v.object({ type: v.literal('input_audio'), input_audio: v.object({ data: v.string() }) }), part);

    if (audio.success) return [{ type: audio.output.type, url: audio.output.input_audio.data }];

    return [];
  });
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
    conversation: messages.map((m) => ({ role: m.role ?? '', content: textOf(m.content) })),
    fileParts: messages.map((m) => filePartsOf(m.content)),
    authHeader: request.headers.get('authorization'),
    offeredTools: (body.tools ?? []).map((t) => t.function.name),
    toolCalls: messages.flatMap((m) => (m.tool_calls ?? [])
      .map((c) => ({ id: c.id, name: c.function.name }))),
    toolResults: messages
      .filter((m) => m.role === 'tool')
      .map((m) => textOf(m.content)),
  });
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

/** One scripted SSE answer: the given frames, then stream close. */
function sseResponse(chunks: readonly string[]): Response {
  const encoder = new TextEncoder();

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

/** The tools lane: the FIRST request is answered with a real `file` tool call
 *  (optionally after a narration text delta, `narration`); the second request
 *  carries the tool's result, answered with text. The `callId` differs per
 *  variant so the two lanes' wires stay distinguishable in the log. The
 *  assistant row the tool call round-trips into the next request legally
 *  carries `content: null` on the OpenAI wire, which is why
 *  `OutboundMessageSchema` accepts null content explicitly. */
function toolBody(body: OutboundBody, callId: string, narration?: string): Response {
  const messages = body.messages ?? [];

  if (messages.some((m) => m.role === 'tool')) {
    return sseResponse([
      sseChunk({ content: 'echo:tool-answered' }),
      sseChunk({ role: 'assistant' }, 'stop'),
      sseDone(),
    ]);
  }

  const chunks: string[] = [];

  if (narration !== undefined) chunks.push(sseChunk({ content: narration }));
  chunks.push(
    sseChunk({
      tool_calls: [{
        index: 0,
        id: callId,
        type: 'function',
        function: {
          name: 'file',
          arguments: JSON.stringify({ action: 'read', path: 'probe-fixture.txt' }),
        },
      }],
    }),
    sseChunk({ role: 'assistant' }, 'tool_calls'),
    sseDone(),
  );

  return sseResponse(chunks);
}

/**
 * The parity conversation's model. One lane, keyed on the request shape and
 * the last typed user line, so a whole scripted conversation runs on one pin:
 *
 *   - a user line naming `TOOL` opens a tool script: the first request is
 *     answered with a real `file` tool call; the request carrying its result
 *     streams `echo:part-one ` and — when the `partial` hold is armed — parks
 *     there with the body open; a request whose transcript already ends in
 *     that partial assistant text (the continuation) answers `part-two`;
 *   - every other line is an echo, parked before answering when the `first`
 *     hold is armed.
 */
async function parityBody(body: OutboundBody): Promise<Response> {
  const messages = body.messages ?? [];
  const users = messages.filter((m) => m.role === 'user').map((m) => textOf(m.content));
  const text = users.filter((u) => !u.startsWith('<')).at(-1) ?? '';
  const trailingAssistant = messages.at(-1)?.role === 'assistant' ? textOf(messages.at(-1)?.content ?? '') : '';
  const encoder = new TextEncoder();

  const parkedResponse = (before: readonly string[], after: readonly string[], gate: HeldGate): Response => new Response(
    new ReadableStream<Uint8Array>({
      async start(controller) {
        for (const c of before) controller.enqueue(encoder.encode(c));
        gate.arrived.resolve();
        await gate.release.promise;

        for (const c of after) controller.enqueue(encoder.encode(c));
        controller.close();
      },
    }),
    { headers: { 'content-type': 'text/event-stream' } },
  );

  if (text.includes('TOOL')) {
    if (trailingAssistant.startsWith('echo:part-one')) {
      return sseResponse([sseChunk({ content: 'part-two' }), sseChunk({ role: 'assistant' }, 'stop'), sseDone()]);
    }

    if (messages.some((m) => m.role === 'tool')) {
      const tail = [sseChunk({ content: 'part-two' }), sseChunk({ role: 'assistant' }, 'stop'), sseDone()];

      if (parityHold?.parkAt === 'partial') {
        const { gate } = parityHold;
        parityHold = null;
        parityParked = gate;

        return parkedResponse([sseChunk({ content: 'echo:part-one ' })], tail, gate);
      }

      return sseResponse([sseChunk({ content: 'echo:part-one ' }), ...tail]);
    }

    return sseResponse([
      sseChunk({
        tool_calls: [{
          index: 0, id: 'call_parity_1', type: 'function',
          function: { name: 'file', arguments: JSON.stringify({ action: 'read', path: 'probe-fixture.txt' }) },
        }],
      }),
      sseChunk({ role: 'assistant' }, 'tool_calls'),
      sseDone(),
    ]);
  }

  const answer = [sseChunk({ content: `echo:${text}` }), sseChunk({ role: 'assistant' }, 'stop'), sseDone()];

  if (parityHold?.parkAt === 'first') {
    const { gate } = parityHold;
    parityHold = null;
    parityParked = gate;

    return parkedResponse([], answer, gate);
  }

  return sseResponse(answer);
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


async function modelsBody(): Promise<Response> {
  return Response.json({
    data: [
      { id: 'probe' },
      { id: 'probe-early-done' },
      { id: 'probe-tools' },
      { id: 'probe-tools-only' },
      { id: 'probe-error' },
      { id: 'probe-queue' },
      { id: 'probe-parity' },
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
    if (url.pathname === '/queue/hold' && request.method === 'POST') {
      const raw = await request.text();
      const spec = v.parse(v.looseObject({ from: v.optional(v.number()) }), raw === '' ? {} : JSON.parse(raw));
      heldRequest = { gate: { arrived: Promise.withResolvers<void>(), release: Promise.withResolvers<void>() }, from: spec.from ?? 1 };

      return Response.json({ ok: true });
    }

    if (url.pathname === '/queue/arrived' && request.method === 'GET') {
      if (heldRequest === null) throw new Error('queue model hold was not armed');
      await heldRequest.gate.arrived.promise;

      return Response.json({ ok: true });
    }

    if (url.pathname === '/queue/release' && request.method === 'POST') {
      heldRequest?.gate.release.resolve();
      heldRequest = null;

      return Response.json({ ok: true });
    }

    if (url.pathname === '/parity/hold' && request.method === 'POST') {
      const spec = v.parse(v.object({ parkAt: v.picklist(['first', 'partial']) }), await request.json());
      parityHold = { gate: { arrived: Promise.withResolvers<void>(), release: Promise.withResolvers<void>() }, parkAt: spec.parkAt };

      return Response.json({ ok: true });
    }

    if (url.pathname === '/parity/arrived' && request.method === 'GET') {
      const gate = parityHold?.gate ?? parityParked;

      if (gate === null || gate === undefined) throw new Error('parity model hold was not armed');
      await gate.arrived.promise;

      return Response.json({ ok: true });
    }

    if (url.pathname === '/parity/release' && request.method === 'POST') {
      parityParked?.release.resolve();
      parityHold?.gate.release.resolve();
      parityParked = null;
      parityHold = null;

      return Response.json({ ok: true });
    }

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
        case 'probe-queue': {
          const ordinal = log.filter((call) => call.model === 'probe-queue').length;

          if (ordinal >= (heldRequest?.from ?? Number.POSITIVE_INFINITY)) {
            if (heldRequest === null) throw new Error('queue model hold was not armed');
            heldRequest.gate.arrived.resolve();
            await heldRequest.gate.release.promise;
          }

          return echoBody(body);
        }

        case 'probe': return echoBody(body);
        case 'probe-parity': return parityBody(body);
        case 'probe-early-done': return earlyDoneBody();
        case 'probe-tools': return toolBody(body, 'call_probe_1', 'I will read that fixture file.');
        case 'probe-tools-only': return toolBody(body, 'call_probe_only_1');
        case 'probe-error': return errorBody(body);
        default: throw new Error(`fake-models: unknown model ${JSON.stringify(body.model)}`);
      }
    }

    throw new Error(`fake-models: unhandled ${request.method} ${url.pathname}`);
  }

  throw new Error(`Outbound refused — not an expected probe endpoint: ${request.url}`);
}

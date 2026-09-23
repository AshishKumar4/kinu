import * as v from 'valibot';
import { WAKE_MARKER, WakeHoldPlacementSchema, type WakeHoldPlacement } from './two-turn-shapes';
/**
 * Node-side outbound handler for the two-turn HTTP-seam probe, and its test-only control surface.
 * The compat provider falls back to the global fetch, which the pool routes here; model routes key
 * on the body `model` (never prompt text), and unknown paths/models throw rather than echo.
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
  /** Non-text content parts as they reached the wire, which `textOf` drops. */
  readonly fileParts: ReadonlyArray<ReadonlyArray<{ type: string; url: string }>>;
  readonly authHeader: string | null;
  /** Tool definitions the request offered, by function name. */
  readonly offeredTools: string[];
  readonly toolCalls: ReadonlyArray<{ id: string; name: string }>;
  readonly toolResults: string[];
}

const log: CapturedHttpCall[] = [];

/** Readers parked on `/log/until?marker=`, released the moment the marker is recorded (never a clock poll). */
const logWaiters: { readonly marker: string; readonly resolve: () => void }[] = [];

function carriesMarker(call: CapturedHttpCall, marker: string): boolean {
  return call.conversation.some((m) => m.content.includes(marker));
}

/** Catalog request count, read through `/log` to assert the catalog was served, not refused. */
let catalogHits = 0;

/** The `https://models.dev/api.json` answer: 200 and well-formed so no provider takes the fallback
 *  path; its one provider is unnamed by the fixture credential. Shape: `ModelsDevCatalogSchema`. */
const MODELS_DEV_CATALOG = {
  groq: {
    id: 'groq', name: 'Groq', doc: 'https://console.groq.com/docs/models',
    env: ['GROQ_API_KEY'], npm: '@ai-sdk/openai-compatible', api: 'https://api.groq.com/openai/v1',
    models: {
      'llama-3.3-70b-versatile': {
        id: 'llama-3.3-70b-versatile', name: 'Llama 3.3 70B', tool_call: true,
        limit: { context: 131072, output: 32768 }, modalities: { input: ['text'] },
      },
    },
  },
};

interface HeldGate {
  readonly arrived: PromiseWithResolvers<void>;
  readonly release: PromiseWithResolvers<void>;
}

/** Armed by `/queue/hold`: the first `probe-queue` call, or every call numbered `from` onward until
 *  `/queue/release`. `arrived` resolves on the first call actually held. */
let heldRequest: { readonly gate: HeldGate; readonly from: number } | null = null;

/** The parity hold (`/parity/hold`): `first` parks the opening call; `partial` streams one text delta
 *  of the tool-answering step then parks with the body open. Released by `/parity/release`. */
let parityHold: { readonly gate: HeldGate; readonly parkAt: 'first' | 'partial' } | null = null;

/** The gate a parity call is parked on now, apart from the arm so release reaches it after consumption. */
let parityParked: HeldGate | null = null;

/** The wake proof's hold (`/wake/hold`): `reply` parks the reply step carrying the detach handle;
 *  `settle` parks the turn-end extension over `/wake/wait`, inside the just-closed turn's settle. */
let wakeHold: { readonly where: WakeHoldPlacement; readonly gate: HeldGate } | null = null;

async function holdWakeWindow(where: WakeHoldPlacement): Promise<void> {
  if (wakeHold === null || wakeHold.where !== where) return;
  wakeHold.gate.arrived.resolve();
  await wakeHold.gate.release.promise;
}

/** The AI proxy's held model (`/proxy/hold`): each `/proxy/park` waits for `/proxy/release`, which also answers
 *  every `/proxy/parked` reader still short of its count. Node-side, so no request context owns the wait. */
let proxyHold: {
  parked: number;
  readonly release: PromiseWithResolvers<void>;
  readonly readers: { readonly count: number; readonly resolve: () => void }[];
} | null = null;

/** Park a scripted call numbered `from` onward (counted per model) until `/queue/release`. */
async function holdQueuedCall(model: string): Promise<void> {
  const hold = heldRequest;

  if (hold === null || log.filter((call) => call.model === model).length < hold.from) return;
  hold.gate.arrived.resolve();
  await hold.gate.release.promise;
}

const TextPartSchema = v.object({ type: v.literal('text'), text: v.string() });

const MessageContentSchema = v.union([v.string(), v.array(v.unknown())]);

type MessageContent = v.InferOutput<typeof MessageContentSchema>;

// `content: null` is valid OpenAI wire for an assistant row whose only content is tool_calls.
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
  model: v.string(),
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

/** Non-text parts of one message, reduced to `{type,url}` so assertions read the part, not the adapter shape. */
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
    model: body.model,
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

  const recorded = log[log.length - 1];

  if (recorded === undefined) return;

  for (const waiter of logWaiters.splice(0)) {
    if (carriesMarker(recorded, waiter.marker)) waiter.resolve();
    else logWaiters.push(waiter);
  }
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

/** The background-wake model: a `shell` call, `echo:detached`, then the woken turn's `eval` reading
 *  the job result, answered with that result's text. Keyed on request shape. */
async function wakeBody(body: OutboundBody): Promise<Response> {
  const messages = body.messages ?? [];
  const users = messages.filter((m) => m.role === 'user').map((m) => textOf(m.content));
  const toolResults = messages.filter((m) => m.role === 'tool').map((m) => textOf(m.content));
  // The wake message sits among runtime context lines; the woken turn is found by that line, wherever it sits.
  const woken = users.map((line) => /Background shell job (\S+) completed/.exec(line)).find((match) => match !== null) ?? null;

  const answer = (content: string): Response => sseResponse([
    sseChunk({ content }), sseChunk({ role: 'assistant' }, 'stop'), sseDone(),
  ]);

  const call = (id: string, name: string, args: Record<string, string>): Response => sseResponse([
    sseChunk({ tool_calls: [{ index: 0, id, type: 'function', function: { name, arguments: JSON.stringify(args) } }] }),
    sseChunk({ role: 'assistant' }, 'tool_calls'),
    sseDone(),
  ]);

  if (woken !== null) {
    const read = toolResults.find((result) => result.includes(WAKE_MARKER));

    if (read !== undefined) return answer(`echo:${read}`);

    return call('call_wake_read_1', 'eval', { code: `return await agent.jobResult(${JSON.stringify(woken[1])});` });
  }

  if (toolResults.length > 0) {
    await holdWakeWindow('reply');

    return answer('echo:detached');
  }

  return call('call_wake_run_1', 'shell', { runtime: 'workspace', command: `sleep 45 && echo ${WAKE_MARKER}` });
}

function longBody(body: OutboundBody): Response {
  const users = (body.messages ?? []).filter((m) => m.role === 'user').map((m) => textOf(m.content));
  const spec = users.filter((u) => u.startsWith('long:')).at(-1) ?? 'long:100';
  const deltas = Number.parseInt(spec.slice('long:'.length), 10);
  const chunks: string[] = [];

  for (let i = 0; i < deltas; i += 1) chunks.push(sseChunk({ content: `w${i} ` }));
  chunks.push(sseChunk({ role: 'assistant' }, 'stop'), sseDone());

  return sseResponse(chunks);
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
  // Producer-open: [DONE] is sent, then the body stays open forever. Whether the runtime stops at [DONE]
  // is the datum discriminating this from the normal-EOF echo.

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

/** The tools lane: a real `file` tool call, then text. `callId` differs per variant to keep wires
 *  distinguishable. The round-tripped assistant row legally carries `content: null`. */
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

/** The parity model: a `TOOL` line opens a `file` call, then `echo:part-one ` (parked on `partial`)
 *  and `part-two` for the continuation; other lines echo, parked on `first`. */
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

  // One hard failure, then recovery. `recordCall` already logged this request, so a bare `some`
  // would see itself and the 500 would never fire.
  if (log.filter((c) => c.model === 'probe-error').length <= 1) {
    return new Response(JSON.stringify({ error: { message: 'probe refuses this request' } }), { status: 500 });
  }

  const users = messages.filter((m) => m.role === 'user').map((m) => textOf(m.content));
  const text = users.filter((u) => !u.startsWith('<')).at(-1) ?? '';

  return sseResponse([
    sseChunk({ content: `echo:${text}` }),
    sseChunk({ role: 'assistant' }, 'stop'),
    sseDone(),
  ]);
}

async function modelsBody(): Promise<Response> {
  return Response.json({
    data: [
      { id: 'probe' },
      { id: 'probe-early-done' },
      { id: 'probe-tools' },
      { id: 'probe-tools-only' },
      { id: 'probe-long' },
      { id: 'probe-error' },
      { id: 'probe-queue' },
      { id: 'probe-parity' },
      { id: 'probe-wake' },
      { id: 'probe-steer' },
    ],
  });
}

/** The parity lane's controls: arm a hold, wait for the parked call, release it. */
async function parityControl(pathname: string, request: Request): Promise<Response> {
  if (pathname === '/parity/hold' && request.method === 'POST') {
    const spec = v.parse(v.object({ parkAt: v.picklist(['first', 'partial']) }), await request.json());
    parityHold = { gate: { arrived: Promise.withResolvers<void>(), release: Promise.withResolvers<void>() }, parkAt: spec.parkAt };

    return Response.json({ ok: true });
  }

  if (pathname === '/parity/arrived' && request.method === 'GET') {
    const gate = parityHold?.gate ?? parityParked;

    if (gate === null || gate === undefined) throw new Error('parity model hold was not armed');
    await gate.arrived.promise;

    return Response.json({ ok: true });
  }

  if (pathname === '/parity/release' && request.method === 'POST') {
    parityParked?.release.resolve();
    parityHold?.gate.release.resolve();
    parityParked = null;
    parityHold = null;

    return Response.json({ ok: true });
  }

  throw new Error(`probe-control: unhandled ${request.method} ${pathname}`);
}

/** The AI proxy lane's controls: arm the hold, park a model call, wait for a parked count, release them all. */
async function proxyControl(url: URL, request: Request): Promise<Response> {
  if (url.pathname === '/proxy/hold' && request.method === 'POST') {
    proxyHold = { parked: 0, release: Promise.withResolvers<void>(), readers: [] };

    return Response.json({ ok: true });
  }

  const hold = proxyHold;

  if (hold === null) throw new Error('proxy model hold was not armed');

  if (url.pathname === '/proxy/park' && request.method === 'POST') {
    hold.parked += 1;

    for (const reader of hold.readers) {
      if (reader.count <= hold.parked) reader.resolve();
    }

    await hold.release.promise;

    return Response.json({ ok: true });
  }

  if (url.pathname === '/proxy/parked' && request.method === 'GET') {
    const count = v.parse(v.pipe(v.string(), v.toNumber(), v.integer()), url.searchParams.get('count'));

    if (hold.parked < count) {
      const { promise, resolve } = Promise.withResolvers<void>();
      hold.readers.push({ count, resolve });
      await Promise.race([promise, hold.release.promise]);
    }

    return Response.json({ parked: hold.parked });
  }

  if (url.pathname === '/proxy/release' && request.method === 'POST') {
    hold.release.resolve();
    proxyHold = null;

    return Response.json({ ok: true });
  }

  throw new Error(`probe-control: unhandled ${request.method} ${url.pathname}`);
}

/** The probe control host: holds, the call log, and the reset between drives. */
async function probeControl(url: URL, request: Request): Promise<Response> {
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

  if (url.pathname.startsWith('/parity/')) return parityControl(url.pathname, request);

  if (url.pathname.startsWith('/proxy/')) return proxyControl(url, request);

  if (url.pathname === '/wake/hold' && request.method === 'POST') {
    const { where } = v.parse(v.object({ where: WakeHoldPlacementSchema }), JSON.parse(await request.text()));
    wakeHold = { where, gate: { arrived: Promise.withResolvers<void>(), release: Promise.withResolvers<void>() } };

    return Response.json({ ok: true });
  }

  if (url.pathname === '/wake/arrived' && request.method === 'GET') {
    if (wakeHold === null) throw new Error('wake hold was not armed');
    await wakeHold.gate.arrived.promise;

    return Response.json({ ok: true });
  }

  if (url.pathname === '/wake/wait' && request.method === 'GET') {
    await holdWakeWindow('settle');

    return Response.json({ ok: true });
  }

  if (url.pathname === '/wake/release' && request.method === 'POST') {
    wakeHold?.gate.release.resolve();
    wakeHold = null;

    return Response.json({ ok: true });
  }

  if (url.pathname === '/log' && request.method === 'GET') {
    return Response.json({ calls: [...log], catalogHits });
  }

  if (url.pathname === '/log/until' && request.method === 'GET') {
    const marker = url.searchParams.get('marker') ?? '';

    if (!log.some((call) => carriesMarker(call, marker))) {
      const { promise, resolve } = Promise.withResolvers<void>();
      logWaiters.push({ marker, resolve });
      await promise;
    }

    return Response.json({ ok: true });
  }

  if (url.pathname === '/reset' && request.method === 'POST') {
    log.length = 0;
    logWaiters.length = 0;
    catalogHits = 0;

    return Response.json({ ok: true });
  }

  throw new Error(`probe-control: unhandled ${request.method} ${url.pathname}`);
}

/** The catalog for a GET of `https://models.dev/api.json`; `null` for any other request. */
function catalogAnswer(url: URL, request: Request): Response | null {
  if (url.host !== 'models.dev' || url.pathname !== '/api.json' || request.method !== 'GET') return null;
  catalogHits += 1;

  return Response.json(MODELS_DEV_CATALOG);
}

/** The outbound handler for every subrequest: answers fake-model and control hosts; records and throws everything else. */
export async function probeOutbound(request: Request): Promise<Response> {
  const url = new URL(request.url);

  if (url.host === 'probe-control.invalid') return probeControl(url, request);

  const catalog = catalogAnswer(url, request);

  if (catalog !== null) return catalog;

  if (url.host === 'fake-models.invalid') {
    if (url.pathname === '/v1/models' && request.method === 'GET') {
      return modelsBody();
    }

    if (url.pathname === '/v1/chat/completions' && request.method === 'POST') {
      // SAFETY: the compat SDK posts JSON chat-completion bodies; parsed once against `OutboundBodySchema`.
      const body = v.parse(OutboundBodySchema, await request.json());

      recordCall(url, request, body);

      switch (body.model) {
        case 'probe-queue': {
          await holdQueuedCall('probe-queue');

          return echoBody(body);
        }

        // Answered with a real tool call so the held turn has a second step, the boundary a mid-turn steer lands at.
        case 'probe-steer': {
          await holdQueuedCall('probe-steer');

          return toolBody(body, 'call_steer_probe');
        }

        case 'probe': return echoBody(body);
        case 'probe-long': return longBody(body);
        case 'probe-parity': return parityBody(body);
        case 'probe-wake': return wakeBody(body);
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

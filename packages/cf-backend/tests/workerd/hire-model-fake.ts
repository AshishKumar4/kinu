/**
 * Lanes are keyed on who is speaking, not the model id: root and child share the workspace pin
 * (`hostedActorProfile`); a delegated turn carries the `report` tool. `hire-probe.ts:HireAI` answers
 * only the auxiliary lanes. No clocks: `scripts/test-clocks.ts` locks the clock corpus shrink-only,
 * so every wait is a gate a request resolves.
 */

import * as v from 'valibot';
import { CHILD_ANSWER, HIRE_CHILD_MODEL, HIRE_DURABLE_MODEL, HIRE_MISSION, HIRE_ROOT_MODEL } from './hire-shapes';

export interface HireCall {
  readonly model: string;
  readonly stream: boolean;
  readonly tools: readonly string[];
  /** Tool-result bodies carried into this request: the caller's resolved `agents` value. */
  readonly toolResults: readonly string[];
  readonly lastUser: string;
}

const log: HireCall[] = [];

/** Resolved when a root request arrives carrying a tool result; one waiter per arm. */
let rootSaw = Promise.withResolvers<void>();

let childSpoke = Promise.withResolvers<void>();

/** Resolved when the durable lane's `msg` call was authored. */
let durableMsgSent = Promise.withResolvers<void>();

/** Resolved when the child's model has been asked for both durable turns. `runHostedTask` writes
 *  `run_start` before calling the model, so the second request means both runs are open. */
let childAskedTwice = Promise.withResolvers<void>();

let childCalls = 0;

let childScript: 'answer' | 'throw' | 'park' = 'answer';

let childPark = Promise.withResolvers<void>();

const ContentPartSchema = v.looseObject({
  text: v.optional(v.unknown()),
  output: v.optional(v.unknown()),
  result: v.optional(v.unknown()),
  content: v.optional(v.unknown()),
});

const MessageContentSchema = v.union([v.string(), v.array(v.unknown()), v.looseObject({}), v.null()]);

type MessageContent = v.InferOutput<typeof MessageContentSchema>;

const OutboundBodySchema = v.looseObject({
  model: v.optional(v.string()),
  stream: v.optional(v.boolean()),
  messages: v.optional(v.array(v.looseObject({
    role: v.optional(v.string()),
    content: v.optional(MessageContentSchema),
  }))),
  tools: v.optional(v.array(v.looseObject({
    function: v.optional(v.looseObject({ name: v.optional(v.string()) })),
    name: v.optional(v.string()),
  }))),
});

type OutboundBody = v.InferOutput<typeof OutboundBodySchema>;

function contentText(content: MessageContent): string {
  if (v.is(v.string(), content)) return content;

  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (v.is(v.string(), part)) return part;

        const parsed = v.safeParse(ContentPartSchema, part);

        const text = parsed.success
          ? parsed.output.text ?? parsed.output.output ?? parsed.output.result ?? parsed.output.content
          : undefined;

        if (v.is(v.string(), text)) return text;

        return JSON.stringify(parsed.success ? parsed.output : part);
      })
      .join(' ');
  }

  if (content !== null) return JSON.stringify(content);

  return '';
}

function toolNames(body: OutboundBody): string[] {
  return (body.tools ?? [])
    .map((tool) => tool.function?.name ?? tool.name ?? '')
    .filter((name) => name !== '');
}

function toolResults(body: OutboundBody): string[] {
  return (body.messages ?? [])
    .filter((message) => message.role === 'tool')
    .map((message) => contentText(message.content ?? ''));
}

function lastUser(body: OutboundBody): string {
  const users = (body.messages ?? []).filter((message) => message.role === 'user');

  return contentText(users.at(-1)?.content ?? '');
}

interface AgentsToolArgs {
  readonly action: 'hire' | 'msg';
  readonly lifetime?: 'task' | 'durable';
  readonly role?: string;
  readonly mission?: string;
  readonly agent?: string;
  readonly message?: string;
}

interface SseChunk {
  readonly id: string;
  readonly object: 'chat.completion.chunk';
  readonly model: string;
  readonly choices: readonly [{
    readonly index: 0;
    readonly delta: {
      readonly role?: string;
      readonly content?: string;
      readonly tool_calls?: readonly [{
        readonly index: number;
        readonly id: string;
        readonly type: 'function';
        readonly function: { readonly name: string; readonly arguments: string };
      }];
    };
    readonly finish_reason: 'stop' | 'tool_calls' | null;
  }];
}

function sse(payload: SseChunk): string {
  return `data: ${JSON.stringify(payload)}\n\n`;
}

function streamResponse(frames: readonly string[]): Response {
  return new Response(`${frames.join('')}data: [DONE]\n\n`, {
    headers: { 'content-type': 'text/event-stream' },
  });
}

function textBody(model: string, text: string): Response {
  return streamResponse([
    sse({
      id: 'hire-text', object: 'chat.completion.chunk', model,
      choices: [{ index: 0, delta: { role: 'assistant', content: text }, finish_reason: null }],
    }),
    sse({
      id: 'hire-text', object: 'chat.completion.chunk', model,
      choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
    }),
  ]);
}

function toolCallBody(model: string, callId: string, name: string, args: AgentsToolArgs): Response {
  return streamResponse([
    sse({
      id: callId, object: 'chat.completion.chunk', model,
      choices: [{
        index: 0,
        delta: {
          role: 'assistant',
          tool_calls: [{
            index: 0, id: callId, type: 'function',
            function: { name, arguments: JSON.stringify(args) },
          }],
        },
        finish_reason: null,
      }],
    }),
    sse({
      id: callId, object: 'chat.completion.chunk', model,
      choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }],
    }),
  ]);
}

/** The name the durable hire minted, read from its own tool result. */
function mintedName(results: readonly string[]): string | null {
  for (const result of results) {
    const match = /"name"\s*:\s*"([a-z0-9-]+)"/i.exec(result);

    if (match?.[1] !== undefined) return match[1];
  }

  return null;
}

/** Keyed on the conversation, not a counter: an interrupted turn re-enters with the same history,
 *  and a counter would author a second hire where the product resumed one. */
function rootLane(body: OutboundBody, results: readonly string[]): Response {
  const model = body.model ?? HIRE_ROOT_MODEL;

  if (results.length !== 0) {
    rootSaw.resolve();

    return textBody(model, `ROOT-SAW ${results.join(' ')}`.slice(0, 600));
  }

  return toolCallBody(model, 'call_hire_1', 'agents', {
    action: 'hire',
    lifetime: 'task',
    role: 'auditor',
    mission: HIRE_MISSION,
  });
}

/** Hire a durable child, message it once, wait until it works on both; keyed on history like `rootLane`. */
async function durableLane(body: OutboundBody, results: readonly string[]): Promise<Response> {
  const model = body.model ?? HIRE_DURABLE_MODEL;
  const name = mintedName(results);

  if (name === null) {
    return toolCallBody(model, 'call_durable_1', 'agents', {
      action: 'hire',
      lifetime: 'durable',
      role: 'auditor',
      mission: HIRE_MISSION,
    });
  }

  // Keyed on the delivery receipt a `msg` call returns: `{"status":"delivered",...}`.
  const sent = results.some((result) => result.includes('"status":"delivered"'));

  if (!sent) {
    // Resolve before authoring: the suite reads the child's log while the call is in flight.
    durableMsgSent.resolve();

    return toolCallBody(model, 'call_durable_2', 'agents', {
      action: 'msg',
      agent: name,
      message: 'HIRE-MSG-BODY',
    });
  }

  await childAskedTwice.promise;
  rootSaw.resolve();

  return textBody(model, `ROOT-SAW-DURABLE ${name}`);
}

/** The child's closing prose is the report a task-lifetime child relays. */
async function childLane(body: OutboundBody): Promise<Response> {
  childCalls += 1;
  childSpoke.resolve();

  if (childCalls >= 2) childAskedTwice.resolve();

  // 'park' is consumed by the call that parks; the recovery re-run must be answered,
  // or the hang is the fake's own doing.
  if (childScript === 'park') {
    childScript = 'answer';

    await childPark.promise;
  }

  if (childScript === 'throw') {
    return new Response(JSON.stringify({ error: { message: 'hire-child model refuses this turn' } }), { status: 500 });
  }

  return textBody(body.model ?? HIRE_CHILD_MODEL, CHILD_ANSWER);
}

/** Auto-title and sleep-time judge want non-streamed JSON; keyed by role: title leads with a system
 *  message, the judge is user-only. */
function auxLane(body: OutboundBody): Response {
  const model = body.model ?? HIRE_CHILD_MODEL;
  const title = (body.messages ?? [])[0]?.role === 'system';

  const content = title
    ? JSON.stringify({ title: 'Hire Probe' })
    : JSON.stringify({ upserts: [], decay: [] });

  return Response.json({
    id: 'hire-aux', object: 'chat.completion', model,
    choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
  });
}

function modelsBody(): Response {
  return Response.json({
    object: 'list',
    data: [HIRE_ROOT_MODEL, HIRE_DURABLE_MODEL, HIRE_CHILD_MODEL].map((id) => ({ id, object: 'model' })),
  });
}

async function hireControl(url: URL, request: Request): Promise<Response> {
  if (url.pathname === '/hire/reset' && request.method === 'POST') {
    const raw = await request.text();

    const spec = v.parse(
      v.looseObject({ script: v.optional(v.picklist(['answer', 'throw', 'park'])) }),
      raw === '' ? {} : JSON.parse(raw),
    );

    log.length = 0;
    rootSaw = Promise.withResolvers<void>();
    childSpoke = Promise.withResolvers<void>();
    childPark = Promise.withResolvers<void>();
    durableMsgSent = Promise.withResolvers<void>();
    childAskedTwice = Promise.withResolvers<void>();
    childCalls = 0;
    childScript = spec.script ?? 'answer';

    return Response.json({ ok: true });
  }

  if (url.pathname === '/hire/release-child' && request.method === 'POST') {
    childPark.resolve();

    return Response.json({ ok: true });
  }

  // Settles when a caller's `agents` call resolved into its next model request.
  if (url.pathname === '/hire/root-saw' && request.method === 'GET') {
    await rootSaw.promise;

    return Response.json({ ok: true });
  }

  if (url.pathname === '/hire/child-spoke' && request.method === 'GET') {
    await childSpoke.promise;

    return Response.json({ ok: true });
  }

  if (url.pathname === '/hire/msg-sent' && request.method === 'GET') {
    await durableMsgSent.promise;

    return Response.json({ ok: true });
  }

  if (url.pathname === '/hire/log' && request.method === 'GET') {
    return Response.json({ calls: [...log] });
  }

  throw new Error(`hire-control: unhandled ${request.method} ${url.pathname}`);
}

export async function hireOutbound(request: Request): Promise<Response> {
  const url = new URL(request.url);

  if (url.hostname === 'hire-control.invalid') return hireControl(url, request);

  if (url.hostname === 'models.dev') return Response.json({});

  if (url.hostname !== 'hire-models.invalid') {
    throw new Error(`hire-models: unexpected host ${url.hostname}`);
  }

  if (url.pathname === '/v1/models') return modelsBody();

  if (url.pathname !== '/v1/chat/completions') {
    throw new Error(`hire-models: unhandled ${request.method} ${url.pathname}`);
  }

  const body = v.parse(OutboundBodySchema, JSON.parse(await request.text()));
  const results = toolResults(body);

  log.push({
    model: body.model ?? '',
    stream: body.stream ?? false,
    tools: toolNames(body),
    toolResults: results,
    lastUser: lastUser(body),
  });

  // No actor turn arrives unstreamed on this wire, so non-streamed is auxiliary.
  if (body.stream !== true) return auxLane(body);

  // The child's lane: `report` is deps-gated (core's `DEPS_GATED_TOOLS`), so only a hired actor carries it.
  if (toolNames(body).includes('report')) return await childLane(body);

  if (body.model === HIRE_DURABLE_MODEL) return await durableLane(body, results);

  return rootLane(body, results);
}

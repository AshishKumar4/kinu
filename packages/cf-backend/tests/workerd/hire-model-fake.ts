/**
 * Two lanes, because a hire has two speakers. Both speak over HTTP: the
 * workspace model is pinned to `openai-compat/hire-root`, whose credential
 * baseURL is this fixture's host, and the CHILD's wire is the same lane —
 * the fixture writes the account profile catalog's default tier as
 * `openai-compat/hire-child` (`hire-probe.ts:setup`), because a hosted
 * actor's profile resolves its model from the catalog's TIER, not the
 * workspace pin. The AI service binding (`hire-probe.ts:HireAI`) answers
 * only the auxiliary lanes a workspace always emits: title, sleep-time.

 * NO CLOCKS. Every wait in this fixture is a gate a request resolves, never a
 * deadline: `scripts/test-clocks.ts` locks the clock corpus shrink-only, and a
 * new file with a `setTimeout` or a `Date.now()` comparison would raise that
 * lock. So a suite that needs "the root has seen its tool result" awaits a
 * promise this handler resolves when that request actually arrives. A product
 * that never gets there hangs, and the hang is the finding.
 */

import * as v from 'valibot';
import { CHILD_ANSWER, HIRE_CHILD_MODEL, HIRE_DURABLE_MODEL, HIRE_MISSION, HIRE_ROOT_MODEL } from './hire-shapes';

/** One captured request, in arrival order. */
export interface HireCall {
  readonly model: string;
  readonly stream: boolean;
  /** The tool names offered on this request, so a suite can prove `agents` was
   *  actually on the turn rather than assumed. */
  readonly tools: readonly string[];
  /** Every tool-result body carried INTO this request — the resolved value of
   *  the caller's own `agents` call, which is what case 1 asserts on. */
  readonly toolResults: readonly string[];
  /** The last user-authored line, for keying a lane on what was asked. */
  readonly lastUser: string;
}

const log: HireCall[] = [];

/** Resolved when a root request arrives carrying a tool result. One waiter per
 *  arm, so a suite that arms twice observes two distinct arrivals. */
let rootSaw = Promise.withResolvers<void>();

/** Resolved when the child's brief reached the model wire at all. */
let childSpoke = Promise.withResolvers<void>();

/** Resolved when the durable lane's `msg` call was authored — the point a
 *  suite may read the child's log with the message admitted but its turn
 *  still owed. */
let durableMsgSent = Promise.withResolvers<void>();

/** Resolved when the CHILD's model has been asked for BOTH of the durable
 *  lane's turns — the birth brief and the message.
 *
 *  The durable lane waits for this before it answers, and the wait is what
 *  makes the case reading it deterministic rather than a race. A delegated turn
 *  is on the child's run ledger from its `run_start`, which `runHostedTask`
 *  writes BEFORE it calls the model, so a second request arriving on this wire
 *  IS both of the child's runs being open. Without it the caller's own answer
 *  races the delegation sweep in the alarm frame and a count of the child's
 *  turns reads whatever had landed by then. */
let childAskedTwice = Promise.withResolvers<void>();

/** Requests the child's model has taken, for the gate above. */
let childCalls = 0;

/** What the child's model does on its turn, armed over the control host. */
let childScript: 'answer' | 'throw' | 'park' = 'answer';

/** A parked child: how a mid-turn interruption is staged without a timer. */
let childPark = Promise.withResolvers<void>();

/** One member of a content array, parsed for the string fields the wire
 *  dialects carry (`text`, `output`, `result`, `content`). */
const ContentPartSchema = v.looseObject({
  text: v.optional(v.unknown()),
  output: v.optional(v.unknown()),
  result: v.optional(v.unknown()),
  content: v.optional(v.unknown()),
});

/** The message content shapes the OpenAI wire sends: a bare string, an array
 *  of parts, or a bare object a tool result serialises into. */
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

/** The text of one message's content, whichever shape the SDK sent. */
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

/** The arguments this fixture authors on an `agents` tool call. */
interface AgentsToolArgs {
  readonly action: 'hire' | 'msg';
  readonly lifetime?: 'task' | 'durable';
  readonly role?: string;
  readonly mission?: string;
  readonly agent?: string;
  readonly message?: string;
}

/** One `chat.completion.chunk` frame, wide enough for the text and
 *  tool-call deltas below. */
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

/** An SSE frame in the OpenAI streaming dialect. */
function sse(payload: SseChunk): string {
  return `data: ${JSON.stringify(payload)}\n\n`;
}


function streamResponse(frames: readonly string[]): Response {
  return new Response(`${frames.join('')}data: [DONE]\n\n`, {
    headers: { 'content-type': 'text/event-stream' },
  });
}

/** A plain assistant answer. */
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

/** One tool call, streamed the way the SDK expects to read it. */
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

/** The name the durable hire minted, read back out of its own tool result, so
 *  the `msg` lane can address the child the product actually created rather
 *  than a name this fixture invented. */
function mintedName(results: readonly string[]): string | null {
  for (const result of results) {
    const match = /"name"\s*:\s*"([a-z0-9-]+)"/i.exec(result);

    if (match?.[1] !== undefined) return match[1];
  }

  return null;
}

/**
 * The root's hire lane: author the `agents` hire on the first request, and
 * answer with the child's words once the tool result comes back.
 *
 * Keyed on the conversation rather than a call counter, because an interrupted
 * turn re-enters this lane with the SAME history and a counter would then
 * author a second hire where the product resumed one.
 */
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

/**
 * The durable lane for the `msg` case: hire a durable child, then send it one
 * message, wait for the child to be working on both, then stop. Each request is
 * keyed on what the history already carries — never on a counter, for the
 * reason `rootLane` states.
 */
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

  // THE DELIVERY RECEIPT, which is what a `msg` call actually returns:
  // `{"status":"delivered","agent":…,"event_id":…,"delivery":…}`. Keyed on the
  // message BODY until 2026-09-17, which no result on this wire has ever
  // carried — so the guard could not become true and this lane authored the
  // same `msg` on every step for as long as the turn lasted: 329 steps in the
  // 30 s the probe sampled, the caller's turn never ending and the case that
  // waits on it hanging with the loop, not the product, as its cause.
  const sent = results.some((result) => result.includes('"status":"delivered"'));

  if (!sent) {
    // Resolve BEFORE the call is authored: the suite reads the child's log
    // while the tool call is in flight, which is exactly the interval whose
    // admissions the case counts.
    durableMsgSent.resolve();

    return toolCallBody(model, 'call_durable_2', 'agents', {
      action: 'msg',
      agent: name,
      message: 'HIRE-MSG-BODY',
    });
  }

  // Both admissions are the child's work now; this caller has asked for
  // everything it was going to ask for and waits for its colleague to be on
  // both before it closes the turn.
  await childAskedTwice.promise;
  rootSaw.resolve();

  return textBody(model, `ROOT-SAW-DURABLE ${name}`);
}

/**
 * The child's lane: its brief arrives as the last user line, and it answers
 * with closing prose. That prose IS the report a task-lifetime child relays,
 * so the caller's resolved value is built from these words.
 */
async function childLane(body: OutboundBody): Promise<Response> {
  childCalls += 1;
  childSpoke.resolve();

  if (childCalls >= 2) childAskedTwice.resolve();

  // 'park' is consumed by the call that parks: an interruption is staged as
  // one model request that never answers, and the turn a recovery re-runs
  // calls the model AGAIN — which a real model answers. Re-parking every
  // later call would make a hang the fake's own doing.
  if (childScript === 'park') {
    childScript = 'answer';

    await childPark.promise;
  }

  if (childScript === 'throw') {
    return new Response(JSON.stringify({ error: { message: 'hire-child model refuses this turn' } }), { status: 500 });
  }

  return textBody(body.model ?? HIRE_CHILD_MODEL, CHILD_ANSWER);
}

/**
 * The auxiliary lanes a settled turn owes: auto-title and sleep-time fact
 * compression. Both are non-streamed completions that read a JSON answer —
 * the child's lane answers them with a STREAMED chat body, which the judge's
 * own parse then reports as `fact_compression_failed`, a harness artifact on
 * a case that was measuring delegation. Lane by ROLE, the same key the
 * two-turn fake's binding-side lanes use: the title lane leads with a system
 * message, the sleep judge is user-only.
 */
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


/** The catalog the openai-compat provider lists to decide a spec is real. */
function modelsBody(): Response {
  return Response.json({
    object: 'list',
    data: [HIRE_ROOT_MODEL, HIRE_DURABLE_MODEL, HIRE_CHILD_MODEL].map((id) => ({ id, object: 'model' })),
  });
}

/** The control host: gates and reads, no clocks. */
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

  // Settles when a caller's own `agents` call has resolved INTO its next model
  // request. That is the caller observing its answer, which is the thing every
  // settle case is about — not a timer, and not this fixture's opinion.
  if (url.pathname === '/hire/root-saw' && request.method === 'GET') {
    await rootSaw.promise;

    return Response.json({ ok: true });
  }

  if (url.pathname === '/hire/child-spoke' && request.method === 'GET') {
    await childSpoke.promise;

    return Response.json({ ok: true });
  }

  /** Settles when the durable lane's `msg` call was authored — the interval
   *  whose admissions case 6 counts before it waits on settlement. */
  if (url.pathname === '/hire/msg-sent' && request.method === 'GET') {
    await durableMsgSent.promise;

    return Response.json({ ok: true });
  }

  if (url.pathname === '/hire/log' && request.method === 'GET') {
    return Response.json({ calls: [...log] });
  }

  throw new Error(`hire-control: unhandled ${request.method} ${url.pathname}`);
}

/**
 * The worker's outbound handler: the control host, the provider catalog, and
 * the root's chat lane.
 */
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

  // A non-streamed request is an auxiliary completion — auto-title or the
  // sleep-time judge — whichever model it names: no actor's TURN arrives
  // unstreamed on this wire.
  if (body.stream !== true) return auxLane(body);


  if (body.model === HIRE_CHILD_MODEL) return await childLane(body);

  if (body.model === HIRE_DURABLE_MODEL) return await durableLane(body, results);

  return rootLane(body, results);
}

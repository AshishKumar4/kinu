/**
 * Lanes are keyed on who is speaking, not the model id: root and child share the workspace pin
 * (`hostedActorProfile`); a delegated turn carries the `report` tool. The native Workers AI fixture answers
 * only the auxiliary lanes. No clocks: `scripts/test-clocks.ts` locks the clock corpus shrink-only,
 * so every wait is a gate a request resolves.
 */

import * as v from 'valibot';
import {
  CHAIN_BOTTOM, CHILD_ANSWER, HIRE_CHILD_MODEL, HIRE_DURABLE_MODEL, HIRE_MISSION, HIRE_ROOT_MODEL, JOB_COMMAND, JOB_MISSION, JOB_NOTED,
  JOB_STARTED, NEST_MISSION, NEST_RELAY, REPORT_MARK, type ChildScript,
} from './hire-shapes';

export interface HireCall {
  readonly model: string;
  readonly stream: boolean;
  readonly tools: readonly string[];
  /** Tool-result bodies carried into this request: the caller's resolved `agents` value. */
  readonly toolResults: readonly string[];
  readonly lastUser: string;
}

/**
 * One workspace's script and gates. Keyed by the workspace its requests name (`hireModelsBaseUrl` in hire-shapes.ts), never shared:
 * a late request from one test's workspace cannot open another test's gate (2026-09-29: the Dismiss case's re-driven
 * root answered after the next case reset a shared fake and opened its `rootSaw`).
 */
interface HireRun {
  readonly log: HireCall[];
  /** Resolved when the root's turn opens on its hire's settling report; one waiter per arm. */
  readonly rootSaw: PromiseWithResolvers<void>;
  readonly childSpoke: PromiseWithResolvers<void>;
  readonly childPark: PromiseWithResolvers<void>;
  childCalls: number;
  childScript: ChildScript;
}

const runs = new Map<string, HireRun>();

function freshRun(script: ChildScript): HireRun {
  return {
    log: [],
    rootSaw: Promise.withResolvers<void>(),
    childSpoke: Promise.withResolvers<void>(),
    childPark: Promise.withResolvers<void>(),
    childCalls: 0,
    childScript: script,
  };
}

function runOf(workspace: string): HireRun {
  const run = runs.get(workspace) ?? freshRun('answer');

  runs.set(workspace, run);

  return run;
}


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

/** The first thing the conversation was told, past the runtime's own state blocks. */
function openedOn(body: OutboundBody): string {
  const told = (body.messages ?? []).filter((message) => message.role === 'user').map((message) => contentText(message.content ?? ''));

  return told.find((text) => !text.startsWith('<dynamic_context')) ?? '';
}

/** Every user turn the request carries, one string: an agent's brief stays in it across its later turns. */
function allUsers(body: OutboundBody): string {
  return (body.messages ?? []).filter((message) => message.role === 'user').map((message) => contentText(message.content ?? '')).join('\n');
}

/** A turn opened on a hired agent's report, as against a hire request or a brief. */
function onReport(body: OutboundBody): boolean {
  return lastUser(body).includes(REPORT_MARK);
}

interface AgentsToolArgs {
  readonly action: 'hire' | 'msg';
  readonly lifetime?: 'task' | 'durable';
  readonly role?: string;
  readonly mission?: string;
  readonly agent?: string;
  readonly message?: string;
}

/** The `nest-progress` grandchild's mid-work note. */
interface ReportToolArgs {
  readonly status: 'progress' | 'completed';
  readonly content: string;
}

interface ShellToolArgs {
  readonly command: string;
  readonly runtime: 'workspace';
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

function toolCallBody(model: string, callId: string, name: string, args: AgentsToolArgs | ReportToolArgs | ShellToolArgs): Response {
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
 *  and a counter would author a second hire where the product resumed one. A hire returns at once; the answer is
 *  a later turn opened on its report. */
function rootLane(run: HireRun, body: OutboundBody, results: readonly string[]): Response {
  const model = body.model ?? HIRE_ROOT_MODEL;

  if (onReport(body)) {
    run.rootSaw.resolve();

    return textBody(model, 'ROOT-GOT-ANSWER');
  }

  if (results.length !== 0) return textBody(model, 'ROOT-WAITS');

  // `job`: a durable hire, so the hire outlives its brief and its job wakes it.
  if (run.childScript === 'job') {
    return toolCallBody(model, 'call_hire_job', 'agents', { action: 'hire', lifetime: 'durable', role: 'auditor', mission: JOB_MISSION });
  }

  return toolCallBody(model, 'call_hire_1', 'agents', {
    action: 'hire',
    // `nest-park`'s middle helper is durable: the owner dismisses it while it waits on its own task hire.
    lifetime: run.childScript === 'nest-park' ? 'durable' : 'task',
    role: 'auditor',
    mission: run.childScript === 'answer' || run.childScript === 'throw' || run.childScript === 'park' ? HIRE_MISSION : NEST_MISSION,
  });
}

/** Hire a durable child, message it once, wait until it works on both; keyed on history like `rootLane`. */
async function durableLane(run: HireRun, body: OutboundBody, results: readonly string[]): Promise<Response> {
  const model = body.model ?? HIRE_DURABLE_MODEL;

  if (onReport(body)) return textBody(model, `ROOT-NOTED ${CHILD_ANSWER}`);
  const name = mintedName(results);

  if (name === null) {
    return toolCallBody(model, 'call_durable_1', 'agents', {
      action: 'hire',
      lifetime: 'durable',
      role: 'auditor',
      mission: run.childScript === 'chain' ? NEST_MISSION : HIRE_MISSION,
    });
  }

  // Queued is a successful durable admission, not a reason to send again.
  const sent = results.some((result) => result.includes('"status":"delivered"') || result.includes('"status":"queued"'));

  if (!sent) {
    return toolCallBody(model, 'call_durable_2', 'agents', {
      action: 'msg',
      agent: name,
      message: 'HIRE-MSG-BODY',
    });
  }

  run.rootSaw.resolve();

  return textBody(model, `ROOT-SAW-DURABLE ${name}`);
}

/** The child's closing prose is the report a task-lifetime child relays; under `nest` it first hires its own, and
 *  relays that hire's answer from the turn the answer opens. */
async function childLane(run: HireRun, body: OutboundBody, results: readonly string[]): Promise<Response> {
  const model = body.model ?? HIRE_CHILD_MODEL;

  // `chain`: every helper hires one of its own, to the depth cap; the others nest one level.
  if (run.childScript !== 'answer' && run.childScript !== 'throw' && run.childScript !== 'park' && allUsers(body).includes(NEST_MISSION)) {
    if (onReport(body)) return textBody(model, `${NEST_RELAY} ${lastUser(body)}`.slice(0, 600));

    // At the depth cap `hire` is not among this helper's actions: it is the bottom of the chain, so it answers.
    if (results.some((result) => result.includes('"reason":"unsupported"') && result.includes('hire'))) return textBody(model, CHAIN_BOTTOM);

    if (results.length !== 0) return textBody(model, 'HELPER-WAITS');

    return toolCallBody(model, 'call_nested_hire_1', 'agents', {
      action: 'hire',
      lifetime: 'task',
      role: 'auditor',
      mission: run.childScript === 'chain' ? NEST_MISSION : HIRE_MISSION,
    });
  }

  if (run.childScript === 'answer' && allUsers(body).includes('HIRE-MSG-BODY')
    && !results.some((result) => result.includes('"disposition":'))) {
    return toolCallBody(model, 'call_message_reply', 'report', { status: 'completed', content: CHILD_ANSWER });
  }

  run.childCalls += 1;
  run.childSpoke.resolve();


  // 'park' is consumed by the call that parks; the recovery re-run must be answered,
  // or the hang is the fake's own doing.
  if (run.childScript === 'park' || run.childScript === 'nest-park') {
    run.childScript = run.childScript === 'park' ? 'answer' : 'nest';

    await run.childPark.promise;
  }

  // A progress note first: it reaches a hirer that is waiting on this very child.
  if (run.childScript === 'nest-progress' && results.length === 0) {
    return toolCallBody(model, 'call_progress_1', 'report', { status: 'progress', content: 'halfway' });
  }

  if (run.childScript === 'throw') {
    return new Response(JSON.stringify({ error: { message: 'hire-child model refuses this turn' } }), { status: 500 });
  }

  return textBody(model, CHILD_ANSWER);
}

/**
 * `job`, the hire's every turn, keyed on what it last read: the brief starts the command; told it became a job, the hire
 * ends its turn; a wake about the job is noted. With or without the `report` tool, since a wake is not its hirer's task.
 */
function jobLane(body: OutboundBody, results: readonly string[]): Response {
  const model = body.model ?? HIRE_CHILD_MODEL;

  if (lastUser(body).includes('Background shell job')) return textBody(model, JOB_NOTED);

  if (results.some((result) => result.includes('backgrounded'))) return textBody(model, JOB_STARTED);

  if (allUsers(body).includes(JOB_MISSION) && results.length === 0) {
    return toolCallBody(model, 'call_job_1', 'shell', { command: JOB_COMMAND, runtime: 'workspace' });
  }

  return textBody(model, 'JOB-IDLE');
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

const ControlPathSchema = v.tuple([v.literal(''), v.literal('hire'), v.pipe(v.string(), v.minLength(1)), v.string()]);

async function hireControl(url: URL, request: Request): Promise<Response> {
  const [, , encoded, op] = v.parse(ControlPathSchema, url.pathname.split('/'));
  const workspace = decodeURIComponent(encoded);

  if (op === 'reset' && request.method === 'POST') {
    const raw = await request.text();

    const spec = v.parse(
      v.looseObject({ script: v.optional(v.picklist(['answer', 'throw', 'park', 'nest', 'nest-park', 'nest-progress', 'chain', 'job'])) }),
      raw === '' ? {} : JSON.parse(raw),
    );

    runs.set(workspace, freshRun(spec.script ?? 'answer'));

    return Response.json({ ok: true });
  }

  const run = runOf(workspace);

  if (op === 'release-child' && request.method === 'POST') {
    run.childPark.resolve();

    return Response.json({ ok: true });
  }

  // Settles when a caller's `agents` call resolved into its next model request.
  if (op === 'root-saw' && request.method === 'GET') {
    await run.rootSaw.promise;

    return Response.json({ ok: true });
  }

  if (op === 'child-spoke' && request.method === 'GET') {
    await run.childSpoke.promise;

    return Response.json({ ok: true });
  }

  if (op === 'log' && request.method === 'GET') {
    return Response.json({ calls: [...run.log] });
  }



  throw new Error(`hire-control: unhandled ${request.method} ${url.pathname}`);
}

const ModelsPathSchema = v.tuple([v.literal(''), v.literal('w'), v.pipe(v.string(), v.minLength(1)), v.literal('v1')]);

export async function hireOutbound(request: Request): Promise<Response> {
  const url = new URL(request.url);

  if (url.hostname === 'hire-control.invalid') return hireControl(url, request);

  if (url.hostname === 'models.dev') return Response.json({});

  if (url.hostname !== 'hire-models.invalid') {
    throw new Error(`hire-models: unexpected host ${url.hostname}`);
  }

  // `/w/<workspace>/v1/...`: the workspace whose run answers.
  const segments = url.pathname.split('/');
  const [, , encoded] = v.parse(ModelsPathSchema, segments.slice(0, 4));
  const run = runOf(decodeURIComponent(encoded));
  const endpoint = `/${segments.slice(4).join('/')}`;

  if (endpoint === '/models') return modelsBody();

  if (endpoint !== '/chat/completions') {
    throw new Error(`hire-models: unhandled ${request.method} ${url.pathname}`);
  }

  const body = v.parse(OutboundBodySchema, JSON.parse(await request.text()));
  const results = toolResults(body);

  run.log.push({
    model: body.model ?? '',
    stream: body.stream ?? false,
    tools: toolNames(body),
    toolResults: results,
    lastUser: lastUser(body),
  });

  // No actor turn arrives unstreamed on this wire, so non-streamed is auxiliary.
  if (body.stream !== true) return auxLane(body);

  // The hire runs on the workspace's pin too: it is the conversation that opened on the brief.
  if (run.childScript === 'job' && openedOn(body) === JOB_MISSION) return jobLane(body, results);

  // The child's lane: `report` is deps-gated (core's `DEPS_GATED_TOOLS`), so only a hired actor carries it.
  if (toolNames(body).includes('report')) return await childLane(run, body, results);

  if (body.model === HIRE_DURABLE_MODEL) return await durableLane(run, body, results);

  return rootLane(run, body, results);
}

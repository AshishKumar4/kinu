import { describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { Effect } from 'effect';
import * as v from 'valibot';
import {
  buildDrainBatch, DeferredApprovalQueue, DeferredApprovalStore, DeviceConsentRegistry, DeviceConsentStore, EventLog,
  initDeferredApprovalsTable, initEventsHubTables, reviewCommand, steerSkillsBlock, workspaceGenesisSignal, type JsonObject,
} from '@kinu.run/core';
import { initDeviceConsentAsksTable } from '../../packages/core/src/safety/device-consent';
import { createTestActors, createTestActorsOver, createTestSql, present } from '@kinu.run/test-utils';
import { makeSqlExec } from '../../packages/core/tests/helpers';
import { createMemoryVfs } from '../../packages/test-utils/src/vfs';
import {
  CONSENT_ASK, DELEGATION_ROSTER_ASK, DELEGATION_TASK_ASK, DELEGATION_WORD, DEVICE_JOB_ASK, DEVICE_JOB_COMMAND, HELLO_SLATE_ASK, HELLO_SLATE_ID,
  RELAY_MISSION, STANDBY_MISSION, TREE_ASK, TREE_DEEP_WORD, delegationDismissAsk, sayWordMission,
} from './asks';
import worker, { MAX_BODY_BYTES } from '../../scripts/scripted-model-worker';
import { SCRIPTED_CREDENTIAL, startScriptedModel } from '../../scripts/scripted-model';
import { FALLBACK_ANSWER } from '../../scripts/scripted-protocol';
import { tierModel } from '../../scripts/tier-model';
import {
  APPROVALS_ASK, DECISION_HEARD, HIRE_APPROVAL_ASK, HIRE_EXECUTED, HIRE_PARKED_COMMAND, HIRE_RAN, HOME_ASK, HOME_BRIEF, HOME_REPORTED, JOB_ASK, JOB_COMMAND,
  JOB_STARTED, PARKED_COMMANDS,
} from '../../scripts/flows-script';
import { COMPUTER } from '../../packages/core/src/operations/executors';
import { wakeText } from '../../packages/core/src/jobs/runner';
import type { BackgroundJob } from '../../packages/core/src/types/jobs';
import { generateText, streamText } from 'ai';
import { codemodeNamespace, createOpenAICompatProvider, runSleepTimeCompute, type JsonValue, type LLM } from '@kinu.run/core';
import { SLEEP_TIME_PROMPT_OPENING } from '../../packages/core/src/utils/prompt-sections';

/** An OpenAI-shaped refusal of a request, with the failure's class as its code. */
const RefusalSchema = v.object({
  error: v.object({ message: v.string(), type: v.literal('invalid_request_error'), code: v.literal('malformed-input') }),
});

const CompletionSchema = v.object({ choices: v.tuple([v.object({ message: v.object({ content: v.string() }) })]) });

/** Bodies no chat completion request is: text that is not JSON, and JSON whose messages are not a list. */
const UNREADABLE = ['{"messages": [', JSON.stringify({ messages: 'not a list' })];

const COMPLETIONS = 'https://scripted-model.kinu.run/chat/completions';

const KEY = 'fixture-scripted-key';

const ENV = { SCRIPTED_MODEL_KEY: KEY };

/** A request as the deployment's provider sends it: the account's API key as its bearer. */
function asked(url: string, body?: BodyInit): Request {
  const headers = { authorization: `Bearer ${KEY}` };

  return body === undefined ? new Request(url, { headers }) : new Request(url, { method: 'POST', headers, body });
}

describe('the scripted model refuses a body it cannot read, the way a provider does', () => {
  test('the deployed tiers\' Worker answers 400 with the refusal\'s class', async () => {
    for (const body of UNREADABLE) {
      const response = await worker.fetch(asked(COMPLETIONS, body), ENV);

      expect(response.status).toBe(400);
      expect(v.safeParse(RefusalSchema, await response.json()).success).toBe(true);
    }
  });

  test('the local runs\' server answers the same refusal', async () => {
    const server = await startScriptedModel(tierModel);

    try {
      for (const body of UNREADABLE) {
        const response = await fetch(`${server.baseURL}/chat/completions`, { method: 'POST', body });

        expect(response.status).toBe(400);
        expect(v.safeParse(RefusalSchema, await response.json()).success).toBe(true);
      }
    } finally {
      await server.stop();
    }
  });

  test('a request it can read is answered, not refused', async () => {
    const body = JSON.stringify({ messages: [{ role: 'user', content: `Explain the phrase "${SLEEP_TIME_PROMPT_OPENING}"` }] });
    const response = await worker.fetch(asked(COMPLETIONS, body), ENV);

    expect(response.status).toBe(200);
    expect(v.parse(CompletionSchema, await response.json()).choices[0].message.content).toBe(FALLBACK_ANSWER);
  });
});

// Its route is public (HARDEN #7): only the bearer the tiers store answers, and a body is read up to a bound.
describe('the deployed tiers\' Worker answers only its key, and reads a bounded body', () => {
  const body = JSON.stringify({ messages: [{ role: 'user', content: 'hi' }] });

  test('no key, a wrong key, or no configured key answers nothing', async () => {
    const statuses = await Promise.all([
      worker.fetch(new Request(COMPLETIONS, { method: 'POST', body }), ENV),
      worker.fetch(new Request('https://scripted-model.kinu.run/models', { headers: { authorization: `Bearer ${KEY}x` } }), ENV),
      worker.fetch(asked(COMPLETIONS, body), {}),
    ].map(async (answer) => (await answer).status));

    expect(statuses).toEqual([401, 401, 503]);
    expect((await worker.fetch(asked('https://scripted-model.kinu.run/models'), ENV)).status).toBe(200);
  });

  test('a body past the bound is refused unread, whatever length it declares', async () => {
    const oversize = new Uint8Array(MAX_BODY_BYTES + 1);
    const declared = await worker.fetch(asked(COMPLETIONS, oversize), ENV);
    const streamed = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(oversize); controller.close(); } });
    const undeclared = await worker.fetch(asked(COMPLETIONS, streamed), ENV);

    expect([declared.status, undeclared.status]).toEqual([413, 413]);
  });
});

// The first-run web-search case searches through the account's `tavily` credential, pointed here.
describe('the deployed tiers\' Worker answers a Tavily search', () => {
  test('with results whose URLs the provider keeps, and refuses a body with no query', async () => {
    const search = 'https://scripted-model.kinu.run/search';
    const answered = await worker.fetch(asked(search, JSON.stringify({ query: 'Cloudflare Durable Objects documentation', max_results: 2 })), ENV);
    const body = v.parse(v.object({ results: v.array(v.object({ url: v.pipe(v.string(), v.url()) })) }), await answered.json());

    expect([answered.status, body.results.length]).toEqual([200, 2]);
    expect(body.results.every((result) => result.url.startsWith('https://'))).toBe(true);
    expect((await worker.fetch(asked(search, '{}'), ENV)).status).toBe(400);
    expect((await worker.fetch(new Request(search, { method: 'POST', body: '{}' }), ENV)).status).toBe(401);
  });
});

test('an ask spliced into genesis survives the skills it activates', async () => {
  const purpose = 'A precise engineer who builds small TypeScript HTTP apps.';
  const genesis = workspaceGenesisSignal(purpose);

  const skills = await steerSkillsBlock({
    vfs: createMemoryVfs().vfs, config: { getAlwaysActiveSkills: () => [] },
    userText: HELLO_SLATE_ASK, alreadyActive: new Set(), trust: () => 'approved',
    limits: { contextWindow: 128_000, modelOutputLimit: 16_384 },
  });

  if (genesis === null || skills === null) throw new Error('the slate ask must activate skills in a genesis turn');

  const messages: JsonObject[] = [
    { role: 'user', content: genesis.text },
    { role: 'user', content: HELLO_SLATE_ASK },
    { role: 'user', content: skills },
  ];

  const tools = ['file', 'eval'].map(name => ({ type: 'function', function: { name } }));
  const ToolCallSchema = v.object({ id: v.string(), function: v.object({ name: v.string(), arguments: v.string() }) });

  const AnswerSchema = v.object({ choices: v.tuple([v.object({ message: v.object({
    content: v.nullish(v.string()), tool_calls: v.optional(v.array(ToolCallSchema)),
  }) })]) });

  for (const file of ['package.json', 'server.ts']) {
    const response = await worker.fetch(asked(COMPLETIONS, JSON.stringify({ messages, tools })), ENV);
    const message = v.parse(AnswerSchema, await response.json()).choices[0].message;

    expect(message.tool_calls?.map(call => call.function.name), message.content ?? '').toEqual(['file']);
    const call = v.parse(ToolCallSchema, message.tool_calls?.[0]);

    const args = v.parse(v.pipe(v.string(), v.parseJson(), v.object({
      op: v.literal('write'), path: v.string(), content: v.string(),
    })), call.function.arguments);

    expect(args.path).toBe(`/slates/${HELLO_SLATE_ID}/${file}`);

    if (file === 'package.json') expect(JSON.parse(args.content)).toMatchObject({
      main: 'server.ts', slate: { title: 'Hello', port: 8787 },
    });
    messages.push(
      { role: 'assistant', content: message.content ?? '', tool_calls: message.tool_calls ?? [] },
      { role: 'tool', tool_call_id: call.id, content: 'written' },
    );
  }

  const preview = await worker.fetch(asked(COMPLETIONS, JSON.stringify({ messages, tools })), ENV);
  const previewed = v.parse(AnswerSchema, await preview.json()).choices[0].message;

  expect(previewed.tool_calls?.map(call => call.function.name), previewed.content ?? '').toEqual(['eval']);

  messages.push({ role: 'user', content: 'Stop building the slate. Reply without calling a tool.' });
  const stopped = await worker.fetch(asked(COMPLETIONS, JSON.stringify({ messages, tools })), ENV);

  expect(v.parse(CompletionSchema, await stopped.json()).choices[0].message.content).toBe(FALLBACK_ANSWER);
});

describe('the tier model behind background memory compression', () => {
  test('a conversation with no durable knowledge returns a usable no-change update', async () => {
    const server = await startScriptedModel(tierModel);

    try {
      const model = createOpenAICompatProvider().createModel('fake-live', {
        env: {},
        sessionAffinity: 'sleep-time-tier-test',
        workspaceAffinity: 'sleep-time-tier-test',
        getAuth: async (key) => key === SCRIPTED_CREDENTIAL ? { baseURL: server.baseURL, headers: {} } : null,
        hasCredential: async (key) => key === SCRIPTED_CREDENTIAL,
      });

      const llm: LLM = {
        async *stream(options) {
          yield* streamText({ model, instructions: options.system, messages: options.messages, tools: options.tools }).textStream;
        },
        async complete(prompt) {
          return (await generateText({ model, prompt, maxRetries: 0 })).text;
        },
      };

      const update = await runSleepTimeCompute(llm, {
        turns: [
          { task: 'Hello', output: 'Hello back', toolCalls: [], ownerWords: 'Hello' },
          { task: 'How are you?', output: 'Ready to help', toolCalls: [], ownerWords: 'How are you?' },
          { task: 'Thanks', output: 'You are welcome', toolCalls: [], ownerWords: 'Thanks' },
        ],
        currentFacts: [],
      });

      expect(update).toEqual({ upserts: [], decay: [] });
    } finally {
      await server.stop();
    }
  });
});

/** The message a helper's answer opens its hirer's next turn with, rendered by the product's own drain. */
function answerArrives(agent: string, task: string, content: string): string {
  return reported(agent, task, content, 'completed').text;
}

/** A helper's report as its hirer's drain renders it: `text` opens a turn of its own, `midTurnText` lands in one at work. */
function reported(agent: string, task: string, content: string, status: 'completed' | 'progress'): NonNullable<ReturnType<typeof buildDrainBatch>> {
  const db = new Database(':memory:');
  const sql = makeSqlExec(db);
  initEventsHubTables(sql);
  const log = new EventLog(sql, createTestActorsOver(db).main);

  log.publish({
    descriptor: {
      ingress: 'subordinate', variant: 'subordinate_report',
      payload: { from_subordinate: agent, status, content, sequence_id: `settle:${agent}`, task, kinu_mode: 'build' },
    },
    now: 1_000,
  });

  const batch = buildDrainBatch(log.pending());

  if (batch === null) throw new Error('a published answer must drain');

  return batch;
}

const ReplySchema = v.object({ choices: v.tuple([v.object({ message: v.object({
  content: v.nullish(v.string()),
  tool_calls: v.optional(v.array(v.object({ id: v.string(), function: v.object({ name: v.string(), arguments: v.string() }) }))),
}) })]) });

/** Where the workspace shell runs a call, as its ask records it: the member, the directory, and a background job. */
const WORKSPACE_CALL = { member: 'exec', cwd: '/home/main', background: true } as const;

/** The wake the product sends when the owner decides `command`, parked where the workspace shell runs it. */
/** The turn the owner's consent answer on a device call opens, as the workspace's registry words it. */
async function consentWake(machine: string, command: string, answer: 'once' | 'deny'): Promise<string> {
  const db = createTestSql();
  const woken: string[] = [];

  try {
    initDeviceConsentAsksTable(db.execRaw);

    const registry = new DeviceConsentRegistry({
      store: new DeviceConsentStore(db.sql), announce: () => {}, newId: () => 'cons-1',
      wake: (_actor, signal) => Effect.sync(() => { woken.push(signal.text); }),
    });

    registry.ask({ deviceId: 'dev-1', deviceLabel: machine, method: 'exec', command, actorId: 'actor-main', epoch: 0 });
    await registry.resolve('cons-1', answer);
  } finally {
    db.close();
  }

  const [text] = woken;

  if (text === undefined) throw new Error(`answering ${command} woke nobody`);

  return text;
}

async function decisionWake(command: string, answer: 'approved' | 'denied'): Promise<string> {
  const db = createTestSql();
  const { sql, execRaw } = db;
  const woken: string[] = [];

  try {
    initDeferredApprovalsTable(execRaw);

    const queue = new DeferredApprovalQueue({
      writes: null, store: new DeferredApprovalStore(sql, createTestActors(sql, execRaw).main), remember: () => {},
      wake: (_actor, signal) => Effect.sync(() => { woken.push(signal.text); }),
    });

    await queue.park({ command, executor: 'workspace', context: WORKSPACE_CALL, review: reviewCommand(command, 'agent') });
    await queue.decide(queue.list().map((action) => action.id), answer);
  } finally {
    db.close();
  }

  const [text] = woken;

  if (text === undefined) throw new Error(`deciding ${command} woke nobody`);

  return text;
}

describe('the approval flow acknowledges only the current unanswered decisions', () => {
  const parked = [{ role: 'user', content: APPROVALS_ASK }, { role: 'assistant', content: 'BOTH PARKED' }];

  test('Approve then immediate Deny both reach the answer without re-issuing a command', async () => {
    const answered = await reply([
      ...parked, { role: 'user', content: await decisionWake(PARKED_COMMANDS[1], 'approved') },
      { role: 'user', content: await decisionWake(PARKED_COMMANDS[0], 'denied') },
    ]);

    expect(answered.tool_calls).toBeUndefined();
    expect(answered.content).toBe(`${DECISION_HEARD} approved denied`);
  });

  test('an approval acknowledged in an earlier answer is not counted by the next turn', async () => {
    const answered = await reply([
      ...parked, { role: 'user', content: await decisionWake(PARKED_COMMANDS[1], 'approved') },
      { role: 'assistant', content: `${DECISION_HEARD} approved` },
      { role: 'user', content: await decisionWake(PARKED_COMMANDS[0], 'denied') },
    ]);

    expect(answered.content).toBe(`${DECISION_HEARD} denied`);
  });

  test('a decision for a different fixture is not claimed by this flow', async () => {
    const answered = await reply([
      ...parked, { role: 'user', content: await decisionWake(`${PARKED_COMMANDS[0]}-elsewhere`, 'approved') },
      { role: 'user', content: await decisionWake(PARKED_COMMANDS[0], 'denied') },
    ]);

    expect(answered.content).toBe(`${DECISION_HEARD} denied`);
  });
});

test('the approved hire recognizes its explicit stdout witness, not Git diagnostics or the quoted command', async () => {
  const opened = await reply([{ role: 'user', content: HIRE_APPROVAL_ASK }]);
  const command = opened.tool_calls?.[0];

  if (command === undefined) throw new Error('the hire fixture offered no gated shell command');

  const invoke = (result: string) => reply([
    { role: 'user', content: `APPROVED, still not run: re-issue once:\n  hire-id: ${HIRE_PARKED_COMMAND}` },
    { role: 'assistant', content: 'Re-issuing the approved command.', tool_calls: [{ id: 'hire-call', type: 'function', function: command.function }] },
    { role: 'tool', tool_call_id: 'hire-call', content: result },
  ]);

  expect((await invoke(`${HIRE_EXECUTED}\n\n--- stderr ---\ngit: unknown option`)).content).toBe(HIRE_RAN);
  expect((await invoke(JSON.stringify({ reason: 'denied', error: `still queued: ${HIRE_PARKED_COMMAND}` }))).content).not.toBe(HIRE_RAN);
  expect((await invoke('fatal: not a git repository')).content).not.toBe(HIRE_RAN);
});

/** One request to the deployed tiers' Worker, as a hosted turn makes it: the conversation so far and the agent's tools. */
async function reply(messages: readonly JsonObject[], offered: readonly string[] = ['agents']): Promise<v.InferOutput<typeof ReplySchema>['choices'][0]['message']> {
  const tools = offered.map((name) => ({ type: 'function', function: { name } }));
  const response = await worker.fetch(asked(COMPLETIONS, JSON.stringify({ messages, tools })), ENV);

  return v.parse(ReplySchema, await response.json()).choices[0].message;
}

/** The conversation after a turn that hired one helper, which answered at once that the helper is working. */
function hiredAndWaiting(ask: string, hired: { readonly id: string; readonly agent: string; readonly mission: string }): JsonObject[] {
  return [
    { role: 'user', content: ask },
    { role: 'assistant', content: 'Calling agents.', tool_calls: [{
      id: hired.id, type: 'function',
      function: { name: 'agents', arguments: JSON.stringify({ op: 'hire', lifetime: 'task', role: 'task', mission: hired.mission }) },
    }] },
    { role: 'tool', tool_call_id: hired.id, content: JSON.stringify({ status: 'working', agent: hired.agent, lifetime: 'task', role: 'task' }) },
    { role: 'assistant', content: 'WAITING' },
  ];
}

// The deployed Worker answers device-job-output's ask, so the case runs on the build that ships with this script.
describe('the device job the first-run tier runs on a machine', () => {
  test('is one shell call on the device, answered with the job it detached into', async () => {
    const first = await reply([{ role: 'user', content: DEVICE_JOB_ASK }]);

    expect(first.tool_calls?.map((made) => [made.function.name, JSON.parse(made.function.arguments)])).toEqual([
      ['shell', { runtime: 'device', command: DEVICE_JOB_COMMAND, why: 'The owner asked for this command on that machine.' }],
    ]);

    const handle = { background: true, jobId: 'bgjob-devjob01', kind: 'shell', message: 'Outran the 30s foreground window; backgrounded.' };

    const answered = await reply([
      { role: 'user', content: DEVICE_JOB_ASK },
      { role: 'assistant', content: 'Calling shell.', tool_calls: [{ id: 'call_job', type: 'function', function: { name: 'shell', arguments: JSON.stringify({ runtime: 'device', command: DEVICE_JOB_COMMAND }) } }] },
      { role: 'tool', tool_call_id: 'call_job', content: JSON.stringify(handle) },
    ]);

    expect(answered.content).toBe('JOB bgjob-devjob01');
  });
});

// Staging f9c17ac7b: the agent-job row's program called `computer.startProcess({ command })`, which the computer's
// surface refuses (its members take their required fields positionally), and the row waited 369 s for a job never started.
describe("the agent-job row's job", () => {
  test("is started by a program the computer's own surface takes, and is called started only once it is", async () => {
    const started: JsonValue[] = [];

    const computer = codemodeNamespace('computer', 'the computer', [{ op: COMPUTER.startProcess, run: async (input) => {
      started.push(input);

      return { value: JSON.stringify({ processId: 'job-1', restartable: true }) };
    } }]);

    const call = present((await reply([{ role: 'user', content: JOB_ASK }], ['eval'])).tool_calls?.[0], 'the job call');
    const code = v.parse(v.object({ code: v.string() }), JSON.parse(call.function.arguments)).code;
    const members = Object.fromEntries(Object.entries(computer.tools).map(([name, tool]) => [name, tool.execute]));
    const ran: unknown = await new Function('computer', `return (async () => { ${code} })();`)(members);

    const answered = async (result: string) => (await reply([
      { role: 'user', content: JOB_ASK },
      { role: 'assistant', content: '', tool_calls: [{ id: 'call_job', type: 'function', function: { name: 'eval', arguments: call.function.arguments } }] },
      { role: 'tool', tool_call_id: 'call_job', content: result },
    ], ['eval'])).content;

    expect({ started, ran }).toEqual({ started: [{ command: JOB_COMMAND }], ran: JSON.stringify({ processId: 'job-1', restartable: true }) });
    // As the eval tool answers it: the program's value, a JSON string, inside the tool's own JSON.
    expect(await answered(JSON.stringify({ result: JSON.stringify({ processId: 'job-1', restartable: true }) }))).toBe(JOB_STARTED);
    expect(await answered(JSON.stringify({ success: false, reason: 'bad_input', error: 'refused' }))).not.toBe(JOB_STARTED);
  });

  // Staging b11719d71: a fresh workspace's computer took longer to wake than the eval tool waits, so the program was
  // backgrounded. Staging fcc2e05d6: the wake the product sends names the job and asks for `agent.jobResult`, carrying
  // no result; the script read a wake of its own invention, so it said the job did not start and the row waited 396 s.
  test('started in the background, it reads the job its wake names and is called started only from that', async () => {
    const call = { id: 'call_job', type: 'function', function: { name: 'eval', arguments: JSON.stringify({ code: 'return 1;' }) } };
    const handle = { background: true, jobId: 'bgjob-start01', kind: 'eval', message: 'Outran the 30s foreground window; backgrounded.' };
    const started = JSON.stringify({ processId: 'job-1', restartable: true });

    const job = (status: 'completed' | 'failed', result: string | null): BackgroundJob => ({
      id: 'bgjob-start01', kind: 'eval', label: null, workMode: 'build', status, result, error: status === 'failed' ? 'the computer did not start' : null,
      createdAt: 1, settledAt: 2, epoch: 0, retriedBy: null, attemptStartedAt: 1, resumeAfter: null, serves: null,
    });

    // The ask's turn, its eval backgrounded, then the wake the product sends (core jobs/runner.ts).
    const woken = (wake: BackgroundJob, ...after: JsonObject[]): JsonObject[] => [
      { role: 'user', content: JOB_ASK },
      { role: 'assistant', content: 'Calling eval.', tool_calls: [call] },
      { role: 'tool', tool_call_id: 'call_job', content: JSON.stringify(handle) },
      { role: 'assistant', content: 'The job is starting in the background as bgjob-start01.' },
      { role: 'user', content: wakeText(wake) },
      ...after,
    ];

    const read = present((await reply(woken(job('completed', started)), ['eval'])).tool_calls?.[0], 'the read of the job');
    const readCall = { id: 'call_read', type: 'function', function: { name: 'eval', arguments: read.function.arguments } };

    const said = async (row: BackgroundJob) => (await reply(woken(job('completed', started),
      { role: 'assistant', content: '', tool_calls: [readCall] },
      { role: 'tool', tool_call_id: 'call_read', content: JSON.stringify({ result: JSON.stringify(row) }) },
    ), ['eval'])).content;

    expect(v.parse(v.object({ code: v.string() }), JSON.parse(read.function.arguments)).code).toContain("agent.jobResult('bgjob-start01')");
    expect(await said(job('completed', started))).toBe(JOB_STARTED);
    expect(await said(job('completed', JSON.stringify({ success: false, reason: 'unavailable', error: 'refused' })))).not.toBe(JOB_STARTED);
    expect((await reply(woken(job('failed', null)), ['eval'])).content).toContain('did not start');
  });
});

// A hire returns at once (cafab2bfc): each answer opens its hirer's next turn, and the cases' scripts answer that turn.
describe('the first-run scripts answer the turn a helper\'s answer opens', () => {
  test('the parent repeats the named hire home from its real drain report without running its own pwd', async () => {
    const agent = 'harbour-lamps-keeper';
    const home = `/home/${agent}`;
    const report = answerArrives(agent, HOME_BRIEF, `HOME ${home}`);

    const messages = [
      ...hiredAndWaiting(HOME_ASK, { id: 'call_home', agent, mission: HOME_BRIEF }),
      { role: 'user', content: report },
    ];

    const answered = await reply(messages);

    expect(answered.tool_calls).toBeUndefined();
    expect(answered.content).toBe(`${HOME_REPORTED} ${home}`);
  });

  test('the delegation lead relays the word its helper answered', async () => {
    const mission = sayWordMission(DELEGATION_WORD);

    const messages = [
      ...hiredAndWaiting(DELEGATION_TASK_ASK, { id: 'call_hire', agent: 'ask-task-ymhu3n', mission }),
      { role: 'user', content: answerArrives('ask-task-ymhu3n', mission, DELEGATION_WORD) },
    ];

    expect((await reply(messages)).content).toBe(`HIRED ${DELEGATION_WORD}`);
  });

  test('the relay hires its own helper first, and relays the answer that helper sends', async () => {
    const hired = await reply([{ role: 'user', content: RELAY_MISSION }]);

    expect(hired.tool_calls?.map((made) => made.function.arguments)).toEqual([
      JSON.stringify({ op: 'hire', lifetime: 'task', role: 'task', mission: sayWordMission(TREE_DEEP_WORD) }),
    ]);

    const messages = [
      ...hiredAndWaiting(RELAY_MISSION, { id: 'call_deep', agent: 'ask-task-deep01', mission: sayWordMission(TREE_DEEP_WORD) }),
      { role: 'user', content: answerArrives('ask-task-deep01', sayWordMission(TREE_DEEP_WORD), TREE_DEEP_WORD) },
    ];

    expect((await reply(messages)).content).toBe(TREE_DEEP_WORD);
  });

  test('the tree root answers each arrival with the word it carries', async () => {
    const messages = [
      ...hiredAndWaiting(TREE_ASK, { id: 'call_relay', agent: 'ask-task-relay1', mission: RELAY_MISSION }),
      { role: 'user', content: answerArrives('ask-task-relay1', RELAY_MISSION, TREE_DEEP_WORD) },
    ];

    expect((await reply(messages)).content).toBe(`TREE ${TREE_DEEP_WORD}`);
  });
});

// Production f9c17ac7b (2026-10-14 17:59:54Z): the durable helper's progress report landed in the dismiss turn as it opened,
// spliced after the ask, and the script read the splice as the ask: it answered the fallback, and nothing was dismissed.
describe('a report that lands in a turn at work is not the ask that turn answers', () => {
  const helper = 'stand-one-question';
  const dismissAsk = delegationDismissAsk(helper);
  const landed = reported(helper, STANDBY_MISSION, FALLBACK_ANSWER, 'progress').midTurnText;

  const call = (id: string, args: JsonObject): JsonObject[] => [
    { role: 'assistant', content: 'Calling agents.', tool_calls: [{ id, type: 'function', function: { name: 'agents', arguments: JSON.stringify(args) } }] },
    { role: 'tool', tool_call_id: id, content: JSON.stringify({ ok: true }) },
  ];

  const rostered: JsonObject[] = [{ role: 'user', content: DELEGATION_ROSTER_ASK }, { role: 'assistant', content: `ROSTER ${helper}` }, { role: 'user', content: dismissAsk }];
  const made = async (messages: readonly JsonObject[]) => (await reply(messages)).tool_calls?.map((toolCall) => JSON.parse(toolCall.function.arguments));

  test('the dismiss, then the listing, then the answer, wherever the report lands', async () => {
    expect(await made([...rostered, { role: 'user', content: landed }])).toEqual([{ op: 'dismiss', agent: helper }]);
    expect(await made([...rostered, { role: 'user', content: landed }, ...call('d', { op: 'dismiss', agent: helper })])).toEqual([{ op: 'list' }]);
    expect(await made([...rostered, ...call('d', { op: 'dismiss', agent: helper }), { role: 'user', content: landed }])).toEqual([{ op: 'list' }]);

    const listed = [...rostered, ...call('d', { op: 'dismiss', agent: helper }), { role: 'user', content: landed }, ...call('l', { op: 'list' })];

    expect((await reply(listed)).content).toBe('RETIRED');
  });

  test('a word that lands in the turn that hired its helper is relayed there', async () => {
    const mission = sayWordMission(DELEGATION_WORD);
    const hired = hiredAndWaiting(DELEGATION_TASK_ASK, { id: 'call_hire', agent: 'ask-task-ymhu3n', mission }).slice(0, -1);
    const word = reported('ask-task-ymhu3n', mission, DELEGATION_WORD, 'completed').midTurnText;

    expect((await reply([...hired, { role: 'user', content: word }])).content).toBe(`HIRED ${DELEGATION_WORD}`);
  });

  test('the relay relays the word that lands in the turn that hired its helper', async () => {
    const mission = sayWordMission(TREE_DEEP_WORD);
    const hired = hiredAndWaiting(RELAY_MISSION, { id: 'call_deep', agent: 'ask-task-deep01', mission }).slice(0, -1);
    const word = reported('ask-task-deep01', mission, TREE_DEEP_WORD, 'completed').midTurnText;

    expect((await reply([...hired, { role: 'user', content: word }])).content).toBe(TREE_DEEP_WORD);
  });
});

// Since c66751bf2 a device call with no binding parks NOT RUN on its consent card, and the owner's answer wakes the agent
// that asked, which re-issues it once: machine-consent's scripted agent, whose own call parks, does so.
describe('the owner\'s consent answer wakes the agent, which re-issues the call it approves', () => {
  const parkedOn = (machine: string) => `NOT RUN: using ${machine} from this workspace waits on the owner's consent. You are woken when they answer; do not re-issue it before then.`;

  const shellCall = (id: string, command: string): JsonObject[] => [
    { role: 'assistant', content: 'Calling shell.', tool_calls: [{ id, type: 'function', function: { name: 'shell', arguments: JSON.stringify({ runtime: 'device', command, why: 'asked' }) } }] },
    { role: 'tool', tool_call_id: id, content: parkedOn('kinu-first-run-consent') },
  ];

  const reissued = async (messages: readonly JsonObject[]) => (await reply(messages, ['shell'])).tool_calls?.map((made) => JSON.parse(made.function.arguments));

  test('machine-consent: hostname, approved, is run again on the device', async () => {
    const wake = await consentWake('kinu-first-run-consent', 'hostname', 'once');

    expect(await reissued([{ role: 'user', content: CONSENT_ASK }, ...shellCall('c1', 'hostname'), { role: 'assistant', content: 'HOST parked' }, { role: 'user', content: wake }]))
      .toEqual([expect.objectContaining({ runtime: 'device', command: 'hostname' })]);
    // Spliced into the turn that parked, as it lands while that turn is at work.
    expect(await reissued([{ role: 'user', content: CONSENT_ASK }, ...shellCall('c1', 'hostname'), { role: 'user', content: wake }]))
      .toEqual([expect.objectContaining({ runtime: 'device', command: 'hostname' })]);
  });

  test('a denial re-issues nothing, nor does an approval of a call this agent never asked for', async () => {
    const denied = await consentWake('kinu-first-run-consent', 'hostname', 'deny');
    const elsewhere = await consentWake('kinu-first-run-link', 'printf ok', 'once');

    expect(await reissued([{ role: 'user', content: CONSENT_ASK }, ...shellCall('c1', 'hostname'), { role: 'assistant', content: 'HOST parked' }, { role: 'user', content: denied }])).toBeUndefined();
    expect(await reissued([{ role: 'user', content: elsewhere }])).toBeUndefined();
  });
});

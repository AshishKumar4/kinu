import { describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import * as v from 'valibot';
import {
  buildDrainBatch, EventLog, initEventsHubTables, steerSkillsBlock, workspaceGenesisSignal, type JsonObject,
} from '@kinu.run/core';
import { createTestActorsOver } from '@kinu.run/test-utils';
import { makeSqlExec } from '../../packages/core/tests/helpers';
import { createMemoryVfs } from '../../packages/test-utils/src/vfs';
import {
  DELEGATION_TASK_ASK, DELEGATION_WORD, DEVICE_JOB_ASK, DEVICE_JOB_COMMAND, HELLO_SLATE_ASK, HELLO_SLATE_ID, RELAY_MISSION, TREE_ASK,
  TREE_DEEP_WORD, sayWordMission,
} from './asks';
import worker, { MAX_BODY_BYTES } from '../../scripts/scripted-model-worker';
import { SCRIPTED_CREDENTIAL, startScriptedModel } from '../../scripts/scripted-model';
import { FALLBACK_ANSWER } from '../../scripts/scripted-protocol';
import { tierModel } from '../../scripts/tier-model';
import { generateText, streamText } from 'ai';
import { createOpenAICompatProvider, runSleepTimeCompute, type LLM } from '@kinu.run/core';
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
          { task: 'Hello', output: 'Hello back', toolCalls: [] },
          { task: 'How are you?', output: 'Ready to help', toolCalls: [] },
          { task: 'Thanks', output: 'You are welcome', toolCalls: [] },
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
  const db = new Database(':memory:');
  const sql = makeSqlExec(db);
  initEventsHubTables(sql);
  const log = new EventLog(sql, createTestActorsOver(db).main);

  log.publish({
    descriptor: {
      ingress: 'subordinate', variant: 'subordinate_report',
      payload: { from_subordinate: agent, status: 'completed', content, sequence_id: `settle:${agent}`, task, kinu_mode: 'build' },
    },
    now: 1_000,
  });

  const batch = buildDrainBatch(log.pending());

  if (batch === null) throw new Error('a published answer must drain');

  return batch.text;
}

const ReplySchema = v.object({ choices: v.tuple([v.object({ message: v.object({
  content: v.nullish(v.string()),
  tool_calls: v.optional(v.array(v.object({ id: v.string(), function: v.object({ name: v.string(), arguments: v.string() }) }))),
}) })]) });

/** One request to the deployed tiers' Worker, as a hosted turn makes it: the conversation so far and the agent's tools. */
async function reply(messages: readonly JsonObject[]): Promise<v.InferOutput<typeof ReplySchema>['choices'][0]['message']> {
  const tools = ['agents'].map((name) => ({ type: 'function', function: { name } }));
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

// A hire returns at once (cafab2bfc): each answer opens its hirer's next turn, and the cases' scripts answer that turn.
describe('the first-run scripts answer the turn a helper\'s answer opens', () => {
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

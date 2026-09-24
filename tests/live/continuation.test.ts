/**
 * Continuation on a live model, the two probes of GATE-6.
 *
 * A REAL FOLD KEEPS THE TASK. An episode states a path, an identifier, an abandoned approach and an unfinished step,
 * then buries them under routine work. The production compaction extension folds it with its production summarizer
 * on the live model, and the live model continues from the folded history. It must recall all four; the same
 * question over the full history is the control, so a question it cannot answer reads as the probe's failure, not
 * the fold's.
 *
 * ONE CONVERSATION SURVIVES EVERY TRANSITION. A two-turn conversation whose turns each complete a tool call is
 * continued on the same provider after each of prune, edit, reset, model change and compaction, each made by the
 * product's own transform. Every request is captured as the provider received it: each completed call sits beside
 * its result, the messages the transition did not touch reach the provider as the bytes it already had, and the
 * answer is right.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { tool, type LanguageModel, type ModelMessage, type ToolSet } from 'ai';
import * as v from 'valibot';
import { z } from 'zod';

import {
  asFetchFunction, createChatModel, initWorkspaceSchema, pruneStepToolOutputs, runChat, type LLMProviderConfig,
} from '../../packages/core/src/index';
import { DEFAULT_WORKERS_AI_MODEL_ID } from '../../packages/core/src/providers/workers-ai';
import {
  createCompactionExtension, createCompactionStateStore, createModelSummarizer, createVfsTranscriptStore,
} from '../../packages/compaction/src/index';
import { createCLIRuntime, makeWorkspaceSchemaSql } from '../../packages/cli-backend/src/runtime';
import {
  EVAL_BACKEND_ENV, liveModelCallSink, liveModelTarget, recordLiveModelEpisode, recordLiveModelSpend,
  reportLiveModelSpend, resolveEvalBackend, scratchPath, UNCONFIGURED_LLM,
} from '@kinu.run/test-utils';

const BACKEND = resolveEvalBackend();

if (BACKEND.kind === 'refused') throw new Error(`Continuation: ${BACKEND.reason}`);

const IN_PROCESS = BACKEND.backend === 'local';

if (!IN_PROCESS) {
  console.warn(`[skip] Continuation — ${EVAL_BACKEND_ENV}=cloud, and these probes drive the in-process turn loop `
    + 'and compaction extension, which a deployed workspace does not hand out.');
}

const TARGET = IN_PROCESS ? liveModelTarget('Continuation') : null;

const liveTest = test.skipIf(!TARGET);

const LLM: LLMProviderConfig = TARGET?.llm ?? UNCONFIGURED_LLM;

const KIMI = '@cf/moonshotai/kimi-k2.6';

/** Another tool-calling model on the same provider, for the model change. */
const OTHER_MODEL = LLM.model === KIMI ? DEFAULT_WORKERS_AI_MODEL_ID : KIMI;

const SYSTEM = 'You are a careful assistant. Answer from the conversation; use a tool only when asked to.';

const RequestSchema = v.looseObject({
  messages: v.array(v.looseObject({
    role: v.string(),
    tool_call_id: v.optional(v.string()),
    tool_calls: v.optional(v.array(v.looseObject({ id: v.string() }))),
  })),
});

type SentRequest = v.InferOutput<typeof RequestSchema>;

/** The live model, keeping every request body as the provider received it. */
function recordingModel(model: string, sent: SentRequest[]): LanguageModel {
  return createChatModel({
    kind: 'openai-compat', name: LLM.name, baseURL: LLM.baseURL, headers: LLM.headers, modelId: model,
    // Every request this model makes is a chat completion with a JSON body.
    fetch: asFetchFunction(async (input, init) => {
      sent.push(v.parse(RequestSchema, JSON.parse(v.parse(v.string(), init?.body))));

      return fetch(input, init);
    }),
  });
}

interface Continued {
  readonly text: string;
  /** The turn's assistant and tool messages. */
  readonly produced: readonly ModelMessage[];
  readonly failure: string | null;
}

/** One turn through the product's loop on `history` plus `question`. */
async function continueTurn(model: LanguageModel, history: readonly ModelMessage[], question: string, tools: ToolSet): Promise<Continued> {
  let text = '';
  let produced: readonly ModelMessage[] = [];
  let failure: string | null = null;

  for await (const event of runChat({
    model, system: SYSTEM, history: [...history, { role: 'user', content: question }], tools,
    // Each step hands over the turn's messages so far.
    persistStep: async (messages) => { produced = [...messages]; },
    onStep: (step) => { recordLiveModelSpend(step.usage); },
  })) {
    if (event.type === 'text-delta') text += event.delta;

    if (event.type === 'error') failure = event.message;
  }

  return { text, produced, failure };
}

/** Ids of completed calls the request carries without their results. */
function unpairedCalls(request: SentRequest): string[] {
  const answered = new Set(request.messages.flatMap((message) => message.tool_call_id === undefined ? [] : [message.tool_call_id]));

  return request.messages.flatMap((message) => (message.tool_calls ?? []).map((call) => call.id)).filter((id) => !answered.has(id));
}

const db = new Database(scratchPath('continuation', 'agent.db'));

initWorkspaceSchema(makeWorkspaceSchemaSql(db));

const rt = createCLIRuntime(db, { dbPath: db.filename, llm: LLM });

afterAll(() => {
  if (TARGET) {
    // The summarizer's calls are store rows; the turn loop's are metered per step.
    recordLiveModelEpisode(rt.storage.sql, rt.actor);
    reportLiveModelSpend('Continuation');
  }

  db.close();
});

/** The production compaction extension over this store, summarizing on `model`; forced, as overflow recovery is. */
function productionFold(model: LanguageModel) {
  const state = createCompactionStateStore(rt.storage.sql, rt.actor);
  const quiet = () => {};

  const extension = createCompactionExtension({
    ports: {
      transcripts: createVfsTranscriptStore(() => rt.storage.vfs),
      plans: state.plans,
      logger: { info: quiet, debug: quiet, warn: quiet, error: quiet },
    },
    archive: state.archive,
    summarize: createModelSummarizer(() => model, { source: 'compaction', report: liveModelCallSink(rt.storage.sql, rt.actor) }),
    ephemeral: { dropSuperseded: () => 0 },
  });

  return async (messages: readonly ModelMessage[], sessionKey: string, contextWindow: number): Promise<ModelMessage[]> => {
    const folded = await extension.transformContext?.({ sessionKey, messages, system: SYSTEM, contextWindow, trigger: 'force' });

    if (folded === undefined) throw new Error(`the forced fold of ${sessionKey} changed nothing`);

    return folded;
  };
}

/** Summaries the live model wrote; a failed call leaves a deterministic preview and no row. */
function summaries(): number {
  return db.query<{ n: number }, []>(
    "SELECT COUNT(*) AS n FROM run_events WHERE type = 'model_call' AND json_extract(payload, '$.source') = 'compaction'",
  ).get()?.n ?? 0;
}

describe('a real fold keeps the task', () => {
  const RECALL = [
    { fact: 'the report path', found: (answer: string) => answer.includes('/srv/reports/q3-summary.md') },
    { fact: 'the customer id', found: (answer: string) => answer.includes('CUST-40913') },
    { fact: 'the abandoned approach', found: (answer: string) => /regex/iu.test(answer) },
    { fact: 'the unfinished step', found: (answer: string) => /currency/iu.test(answer) },
  ];

  const QUESTION = 'From our conversation so far, answer in four short lines: 1) the exact path the report must be '
    + "written to, 2) the customer's id, 3) the approach we abandoned, 4) the step that is still unfinished.";

  /** The task's facts come first; routine parsing buries them. */
  function episode(): ModelMessage[] {
    const opening: ModelMessage[] = [
      { role: 'user', content: 'We are building the Q3 revenue report. It must be written to /srv/reports/q3-summary.md and covers customer CUST-40913 only.' },
      { role: 'assistant', content: 'Understood: the report goes to /srv/reports/q3-summary.md and covers customer CUST-40913.' },
      { role: 'user', content: 'Parsing the invoices with a regex broke on nested quotes, so we abandon the regex approach and use the CSV parser. The EUR to USD currency conversion step is not done yet; it comes after parsing.' },
      { role: 'assistant', content: 'Abandoning the regex approach for the CSV parser. The currency conversion step remains to be done after parsing.' },
    ];

    const rows = (batch: number) => [...Array(40).keys()]
      .map((row) => `INV-${String(batch * 100 + row)},${String(1_000 + row * 7)}.${String(row % 100).padStart(2, '0')},EUR`);

    const batches = [...Array(12).keys()].flatMap((batch): ModelMessage[] => [
      { role: 'user', content: `Invoice batch ${String(batch)}:\n${rows(batch).join('\n')}` },
      { role: 'assistant', content: `Batch ${String(batch)} parsed with the CSV parser: 40 rows, all in EUR, no rejects.` },
    ]);

    return [...opening, ...batches, { role: 'user', content: 'All batches are parsed.' }, { role: 'assistant', content: 'Good, parsing is complete.' }];
  }

  liveTest('the live continuation of a folded episode recalls every fact the full one does', async () => {
    const model = recordingModel(LLM.model, []);
    const full = episode();
    // A window this size makes the forced fold summarize everything before the last batch.
    const folded = await productionFold(model)(full, 'fold-quality', 2_000);

    expect(summaries()).toBeGreaterThan(0);
    expect(folded.length).toBeLessThan(full.length);
    expect(folded).not.toContainEqual(full[2]);

    const control = await continueTurn(model, full, QUESTION, {});
    const compacted = await continueTurn(model, folded, QUESTION, {});

    console.log(`[fold] ${String(full.length)} messages folded to ${String(folded.length)}; recalled over the full history `
      + `${String(RECALL.filter((item) => item.found(control.text)).length)}/4, over the folded one `
      + `${String(RECALL.filter((item) => item.found(compacted.text)).length)}/4`);

    expect([control.failure, compacted.failure]).toEqual([null, null]);
    expect(RECALL.filter((item) => !item.found(control.text)).map((item) => item.fact)).toEqual([]);
    expect(RECALL.filter((item) => !item.found(compacted.text)).map((item) => item.fact)).toEqual([]);
  }, 600_000);
});

describe('one same-provider conversation survives every transition', () => {
  const CODES = { north: 'VAULT-7431', south: 'VAULT-2206' } as const;
  // Long enough that a prune truncates it; the code stays in the head a truncation keeps.
  const AUDIT = [...Array(60).keys()].map((line) => `audit ${String(line)}: vault shelf checked, seal intact, humidity nominal`).join('\n');
  let lookups = 0;

  const tools: ToolSet = {
    lookup: tool({
      description: 'Look up the vault code for a topic.',
      inputSchema: z.object({ topic: z.string() }),
      execute: async ({ topic }) => {
        lookups += 1;
        const code = topic.trim().toLowerCase() === 'south' ? CODES.south : CODES.north;

        return `vault code for ${topic}: ${code}\n${AUDIT}`;
      },
    }),
  };

  const ASK_NORTH = "Use the lookup tool to get the vault code for the topic 'north', then tell me the code.";
  const ASK_SOUTH = "Now use the lookup tool for the topic 'south' and tell me that code.";

  liveTest('prune, edit, reset, model change and compaction each keep completed calls paired, and the provider answers', async () => {
    const sent: SentRequest[] = [];
    const model = recordingModel(LLM.model, sent);

    // Two turns, each completing one call: the older result is the one a prune truncates.
    const first = await continueTurn(model, [], ASK_NORTH, tools);
    const opening: ModelMessage[] = [{ role: 'user', content: ASK_NORTH }, ...first.produced];
    const second = await continueTurn(model, opening, ASK_SOUTH, tools);
    const conversation: ModelMessage[] = [...opening, { role: 'user', content: ASK_SOUTH }, ...second.produced];
    const baseline = sent.at(-1);

    expect([first.failure, second.failure, lookups]).toEqual([null, null, 2]);

    if (baseline === undefined) throw new Error('the provider received no request');
    const pruned = pruneStepToolOutputs(conversation, { contextWindow: 1_000, modelOutputLimit: 100 });

    if (pruned === undefined) throw new Error('the prune truncated nothing');

    const transitions: ReadonlyArray<{ readonly name: string; readonly model: LanguageModel; readonly history: readonly ModelMessage[]; readonly code: string }> = [
      { name: 'prune', model, history: pruned, code: CODES.south },
      { name: 'edit', model, history: [{ role: 'user', content: `Please ${ASK_NORTH.toLowerCase()}` }, ...conversation.slice(1)], code: CODES.north },
      // An intentional reset to the end of the first turn keeps only what it reset to.
      { name: 'reset', model, history: opening, code: CODES.north },
      { name: 'model change', model: recordingModel(OTHER_MODEL, sent), history: conversation, code: CODES.north },
      { name: 'compaction', model, history: await productionFold(model)(conversation, 'transition-fold', 600), code: CODES.south },
    ];

    const outcomes: string[] = [];

    for (const transition of transitions) {
      const topic = transition.code === CODES.south ? 'south' : 'north';
      const from = sent.length;
      const continued = await continueTurn(transition.model, transition.history, `What was the vault code for ${topic}? Answer with the code only.`, tools);
      const requests = sent.slice(from);
      const opened = requests[0];

      if (opened === undefined) throw new Error(`the ${transition.name} continuation sent nothing`);

      // The system prompt plus every message the transition left as the conversation had it.
      const untouched = transition.history.findIndex((message, index) => JSON.stringify(message) !== JSON.stringify(conversation[index]));
      const kept = Math.min(1 + (untouched === -1 ? transition.history.length : untouched), baseline.messages.length);

      outcomes.push(`${transition.name}: ${continued.failure ?? 'answered'}; unpaired ${JSON.stringify(requests.flatMap(unpairedCalls))}; `
        + `${String(kept)} messages as sent before; answer ${continued.text.includes(transition.code) ? 'names' : 'lacks'} ${transition.code}`);

      expect(continued.failure).toBeNull();
      expect(requests.flatMap(unpairedCalls)).toEqual([]);
      expect(opened.messages.slice(0, kept)).toEqual(baseline.messages.slice(0, kept));
      expect(continued.text).toContain(transition.code);
    }

    console.log(`[transitions]\n${outcomes.join('\n')}`);
  }, 900_000);
});

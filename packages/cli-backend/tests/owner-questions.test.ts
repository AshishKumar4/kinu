// The agent's questions to its owner on the local backend, read from the requests the model received: the turn ends on
// the ask, and every later request carries the answer, the dismissal or the owner's message in its place.
import { describe, test, expect } from 'bun:test';
import { scratchPath, scriptedTurnModel, scratchDir, workspaceDatabase } from '@kinu.run/test-utils';
import { initWorkspaceSchema, OwnerQuestionStore, type JsonObject, type LLMProviderConfig, type OwnerAnswer } from '@kinu.run/core';
import { settleSync } from '@kinu.run/core/obs';
import { createCLIRuntime, makeSql, makeWorkspaceSchemaSql } from '../src/runtime';
import { LocalAgentSession } from '../src/local-session';

const DUMMY_LLM: LLMProviderConfig = { name: 'fake', baseURL: 'http://localhost:0', headers: {}, model: 'fake-model' };

const USAGE = {
  inputTokens: { total: 1, noCache: 1, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: 1, text: 1, reasoning: undefined },
} as const;

const QUIET = { content: [{ type: 'text' as const, text: 'Nothing to change.' }], finishReason: { unified: 'stop' as const, raw: undefined }, usage: USAGE, warnings: [] };

const ASK = {
  questions: [{
    id: 'units', question: 'Which unit should the ledger store?', header: 'Units',
    options: [{ label: 'Integer cents', description: 'Exact; every reader converts.' }, { label: 'Decimal dollars', description: 'Readable; rounding at every sum.' }],
    recommended: 0,
  }],
};

type Step = { readonly call: string; readonly input: JsonObject } | { readonly answer: string };

/** One request as the model received it: its messages, exactly. */
type Prompt = readonly { readonly role: string; readonly content: unknown }[];

function session(steps: readonly Step[], db = workspaceDatabase(scratchPath('owner-questions', 'agent.db'))) {
  initWorkspaceSchema(makeWorkspaceSchemaSql(db));
  const rt = createCLIRuntime(db, { cwd: scratchDir('workspace-folder'), llm: DUMMY_LLM });
  const requests: Prompt[] = [];
  let taken = 0;

  const model = scriptedTurnModel({ doGenerate: async (options) => {
    if ((options.tools ?? []).length === 0) return QUIET;
    requests.push(options.prompt.filter((message) => message.role !== 'system'));
    const step = steps[taken] ?? { answer: 'nothing left to do' };
    taken += 1;

    if ('answer' in step) return { content: [{ type: 'text' as const, text: step.answer }], finishReason: { unified: 'stop' as const, raw: undefined }, usage: USAGE, warnings: [] };

    return {
      content: [{ type: 'tool-call' as const, toolCallId: `call-${String(taken)}`, toolName: step.call, input: JSON.stringify(step.input) }],
      finishReason: { unified: 'tool-calls' as const, raw: undefined }, usage: USAGE, warnings: [],
    };
  } });

  rt.actor.config.setLearning(false);

  return { db, rt, agent: new LocalAgentSession({ rt, db, model, onEvent: () => {} }), requests };
}

/** The `ask_owner` call and its result in a request, and what follows the result. */
function askPair(prompt: Prompt) {
  const at = prompt.findIndex((message) => message.role === 'assistant' && JSON.stringify(message.content).includes('"toolName":"ask_owner"'));
  const result = prompt[at + 1];

  return { at, result: result?.role === 'tool' ? JSON.stringify(result.content) : null, after: prompt.slice(at + 2) };
}

const ANSWER: readonly OwnerAnswer[] = [{ id: 'units', selected: ['Integer cents'], note: 'Round half to even.' }];

describe('LocalAgentSession: asking the owner', () => {
  test('the turn ends on the ask; the answer is the call\'s result, and the model goes on from it with the prefix untouched', async () => {
    const { db, agent, requests } = session([
      { call: 'ask_owner', input: ASK },
      { answer: 'Storing integer cents, rounding half to even.' },
    ]);

    try {
      await agent.send('Migrate the ledger.', { id: crypto.randomUUID(), mode: 'build' });
      expect(requests).toHaveLength(1);
      const [open] = (await agent.listOwnerQuestions()).filter((asking) => asking.asked.status === 'open');

      if (open === undefined) throw new Error('the ask left no open question');
      await agent.answerOwnerQuestions(open.asked.id, ANSWER);
      await agent.settleBackgroundWork();

      const [asking, resumed] = requests;

      if (asking === undefined || resumed === undefined) throw new Error('the answer started no request');
      const pair = askPair(resumed);

      // One call, one result, and nothing after it: no message stands in for the answer.
      expect(pair.at).toBe(asking.length);
      expect(pair.result).toContain('Integer cents');
      expect(pair.result).toContain('Round half to even.');
      expect(pair.after).toEqual([]);
      // What the model had read before it asked arrives again byte for byte, so its cache holds up to the ask.
      expect(JSON.stringify(resumed.slice(0, asking.length))).toBe(JSON.stringify(asking));
    } finally {
      await agent.end();
      db.close();
    }
  });

  test('an answer recorded by a process that then died is resumed by the next one, from the same call', async () => {
    const db = workspaceDatabase(scratchPath('owner-questions-restart', 'agent.db'));
    const first = session([{ call: 'ask_owner', input: ASK }], db);

    await first.agent.send('Migrate the ledger.', { id: crypto.randomUUID(), mode: 'build' });
    const [open] = (await first.agent.listOwnerQuestions()).filter((asking) => asking.asked.status === 'open');

    if (open === undefined) throw new Error('the ask left no open question');
    // Recorded, and the process gone before the turn it owes opened.
    settleSync(new OwnerQuestionStore(makeSql(db), first.rt.actor).answer(open.asked.id, ANSWER));
    await first.agent.end();

    const second = session([{ answer: 'Storing integer cents.' }], db);

    try {
      await second.agent.recoverTerminalTransitions();
      await second.agent.settleBackgroundWork();
      const [resumed] = second.requests;

      if (resumed === undefined) throw new Error('the restart did not resume the answer');
      const pair = askPair(resumed);

      expect(pair.result).toContain('Integer cents');
      expect(pair.after).toEqual([]);
      expect(second.requests).toHaveLength(1);
    } finally {
      await second.agent.end();
      db.close();
    }
  });

  test('work that arrives while a question is open waits for it, then runs after the answer\'s own turn', async () => {
    const { db, agent, requests } = session([
      { call: 'ask_owner', input: ASK },
      { answer: 'Integer cents it is.' },
      { answer: 'The job finished.' },
    ]);

    try {
      await agent.send('Migrate the ledger.', { id: crypto.randomUUID(), mode: 'build' });
      const held = agent.enqueueTurn({ text: 'A background job finished.', metadata: { kinuEvent: 'background_job' } });
      await agent.settleBackgroundWork();
      expect(requests).toHaveLength(1);

      const [open] = (await agent.listOwnerQuestions()).filter((asking) => asking.asked.status === 'open');

      if (open === undefined) throw new Error('the ask left no open question');
      await agent.answerOwnerQuestions(open.asked.id, ANSWER);
      await held;
      await agent.settleBackgroundWork();

      expect(requests).toHaveLength(3);
      expect(askPair(requests[1] ?? []).after).toEqual([]);
      expect(JSON.stringify(requests[2]?.at(-1))).toContain('A background job finished.');
    } finally {
      await agent.end();
      db.close();
    }
  });

  test('Stop closes the question unanswered, and the next message reads that in the call\'s place', async () => {
    const { db, agent, requests } = session([
      { call: 'ask_owner', input: ASK },
      { answer: 'Then I will keep decimal dollars for now.' },
    ]);

    try {
      await agent.send('Migrate the ledger.', { id: crypto.randomUUID(), mode: 'build' });
      agent.interrupt();
      expect((await agent.listOwnerQuestions()).map((asking) => asking.asked.status)).toEqual(['dismissed']);
      expect(requests).toHaveLength(1);

      await agent.send('Leave it for now.', { id: crypto.randomUUID(), mode: 'build' });
      const pair = askPair(requests[1] ?? []);

      expect(pair.result).toContain('dismissed');
      expect(JSON.stringify(pair.after)).toContain('Leave it for now.');
    } finally {
      await agent.end();
      db.close();
    }
  });

  test('a message sent while a question is open answers it in the chat', async () => {
    const { db, agent, requests } = session([
      { call: 'ask_owner', input: ASK },
      { answer: 'Cents, then.' },
    ]);

    try {
      await agent.send('Migrate the ledger.', { id: crypto.randomUUID(), mode: 'build' });
      await agent.send('Use cents, and keep the old column a week.', { id: crypto.randomUUID(), mode: 'build' });

      expect((await agent.listOwnerQuestions()).map((asking) => asking.asked.status)).toEqual(['in_chat']);
      const pair = askPair(requests[1] ?? []);

      expect(pair.result).not.toBeNull();
      expect(JSON.stringify(pair.after)).toContain('keep the old column a week');
    } finally {
      await agent.end();
      db.close();
    }
  });
});

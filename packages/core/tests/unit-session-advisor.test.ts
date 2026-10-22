// The in-session advisor: it reads each step's output once, batches what ends while it reviews, routes its notes by
// severity, guards what it may say, never fails the turn it watches, and does nothing until the owner turns it on.
import { describe, expect, test } from 'bun:test';
import { tool, jsonSchema, type ModelMessage } from 'ai';
import { createTestSql } from '@kinu.run/test-utils';
import { createTestActor } from './helpers';
import { SessionAdvisor, ADVISOR_NOTES_PER_UPDATE, type AdvisedTurn, type AdvisorModel, type AdvisorReply } from '../src/advisor/session-advisor';
import { ADVISOR_HEADER, ADVISOR_SEVERITY_LABEL, keptAdvisorNote, type AdvisorNote } from '../src/advisor/review';
import type { AgentSignal, SendOutcome } from '../src/types/signals';
import type { JsonValue } from '../src/utils/json';

function harness(opts: { readonly enabled?: boolean; readonly reviewed?: boolean; readonly finalWaitMs?: number } = {}) {
  const { sql, execRaw } = createTestSql();
  const actor = createTestActor(sql, execRaw, crypto.randomUUID(), 'reviewed');

  if (opts.enabled !== false) actor.config.setAdvisorEnabled(true);
  actor.config.setAdvisorMinSeverity('nit');
  const sent: AgentSignal[] = [];
  const recorded: { readonly note: AdvisorNote; readonly spoken: boolean }[] = [];
  let interrupts = 0;
  let outcome: SendOutcome = 'mid-turn';

  const advisor = new SessionAdvisor({
    actor,
    config: () => actor.config,
    reviewed: opts.reviewed ?? true,
    notes: () => ({
      recentAdvisorNotes: () => recorded.map((entry) => entry.note.note.toLowerCase()),
      recordAdvisorNote: (note, _turnId, spoken = false) => { recorded.push({ note, spoken }); },
    }),
    gateOpen: () => false,
    send: async (signal) => {
      sent.push(signal);

      return outcome;
    },
    interrupt: async () => {
      interrupts += 1;

      return true;
    },
    guidance: async () => '',
    ...(opts.finalWaitMs !== undefined && { finalWaitMs: opts.finalWaitMs }),
  });

  return {
    advisor, sent, recorded,
    interrupts: () => interrupts,
    outcome: (next: SendOutcome) => { outcome = next; },
  };
}

/** A model that answers each call with the next reply, recording the conversation each call was sent. */
function scripted(replies: readonly (AdvisorReply | (() => Promise<AdvisorReply>))[]) {
  const asked: (readonly ModelMessage[])[] = [];
  let at = 0;

  const model: AdvisorModel = async ({ messages }) => {
    asked.push([...messages]);
    const next = replies[at] ?? silent;
    at += 1;

    return typeof next === 'function' ? await next() : next;
  };

  return { model, asked, calls: () => at };
}

const silent: AdvisorReply = { toolCalls: [], responseMessages: [{ role: 'assistant', content: '' }] };

function advising(...notes: readonly JsonValue[]): AdvisorReply {
  const toolCalls = notes.map((input, at) => ({ toolCallId: `c${String(at)}`, toolName: 'advise', input }));

  return { toolCalls, responseMessages: [{ role: 'assistant', content: toolCalls.map((call) => ({ type: 'tool-call' as const, ...call })) }] };
}

const step = (text: string): ModelMessage[] => [{ role: 'assistant', content: [{ type: 'text', text }] }];

const turnOf = (model: AdvisorModel, tools: AdvisedTurn['tools'] = {}): AdvisedTurn => ({ turnId: 't1', model, tools, reachable: ['file', 'agents'] });

/** A turn of `steps`, each outlasting the review it starts (a model call takes longer than a scripted review), unless
 *  `overlapping`: then the steps end at once and the turn ends with its reviews still to run. */
async function runTurn(advisor: SessionAdvisor, turn: AdvisedTurn, steps: readonly ModelMessage[][], overlapping = false): Promise<void> {
  const hooks = advisor.extension(turn);
  const stepTakes = async () => { if (!overlapping) await advisor.settled(1000); };

  await hooks.onTurnStart?.({ system: '', history: [{ role: 'user', content: 'Fix the ledger rounding.' }] });
  await stepTakes();

  for (const [at, produced] of steps.entries()) {
    await hooks.onStepEnd?.({ stepNumber: at, produced });
    await stepTakes();
  }

  await hooks.onTurnEnd?.({ text: '', responseMessages: [] });
}

/** The agent's own messages an update was sent, as the advisor rendered them. */
const readOf = (asked: readonly ModelMessage[]): string[] => asked.flatMap((message) => (message.role === 'user' && typeof message.content === 'string' ? [message.content] : []));

describe('the in-session advisor', () => {
  test('reads each step once, its request first, and never the history again', async () => {
    const { advisor } = harness();
    const { model, asked } = scripted([]);
    await runTurn(advisor, turnOf(model), [step('read the ledger'), step('rounded at the boundary')]);
    const last = readOf(asked.at(-1) ?? []);

    expect(last.filter((text) => text.includes('Fix the ledger rounding.'))).toHaveLength(1);
    expect(last.filter((text) => text.includes('read the ledger'))).toHaveLength(1);
    expect(last.filter((text) => text.includes('rounded at the boundary'))).toHaveLength(1);
    expect(last.every((text) => text.startsWith('[in progress] '))).toBe(true);
  });

  test('batches the steps that end while a review runs into the next review', async () => {
    const { advisor } = harness();
    const gate = Promise.withResolvers<AdvisorReply>();
    const { model, asked, calls } = scripted([() => gate.promise]);
    const hooks = advisor.extension(turnOf(model));
    await hooks.onTurnStart?.({ system: '', history: [{ role: 'user', content: 'go' }] });
    await hooks.onStepEnd?.({ stepNumber: 0, produced: step('one') });
    await hooks.onStepEnd?.({ stepNumber: 1, produced: step('two') });
    await hooks.onStepEnd?.({ stepNumber: 2, produced: step('three') });
    gate.resolve(silent);
    await hooks.onTurnEnd?.({ text: '', responseMessages: [] });

    // The first review read the request; every step that ended while it ran is the second's, read together.
    expect(calls()).toBe(2);
    const second = readOf(asked[1] ?? []).slice(readOf(asked[0] ?? []).length);
    expect(second.map((text) => text.replace(/^\[in progress\] assistant:\n/u, ''))).toEqual(['one', 'two', 'three']);
  });

  test('a blocker interrupts the step; a concern lands at the next step without interrupting', async () => {
    const { advisor, sent, interrupts } = harness();

    const { model } = scripted([
      advising({ note: 'The migration ran before the suite. Stop and check the backup.', severity: 'blocker' }),
      advising({ note: 'The rounding mode differs from the spec; weigh it before the next edit.', severity: 'concern' }),
    ]);

    await runTurn(advisor, turnOf(model), [step('ran the migration'), step('edited rounding')]);

    expect(sent.map((signal) => signal.severity)).toEqual(['blocker', 'concern']);
    expect(interrupts()).toBe(1);
    expect(new Set(sent.map((signal) => signal.idempotencyKey)).size).toBe(2);
  });

  test('after its turn, a concern is kept as a changelog note and only a blocker is said, interrupting nothing', async () => {
    const { advisor, sent, recorded, interrupts, outcome } = harness({ finalWaitMs: 0 });
    const gate = Promise.withResolvers<AdvisorReply>();
    const { model } = scripted([() => gate.promise, advising({ note: 'The sum is computed twice over the same rows.', severity: 'blocker' })]);
    outcome('queued');
    await runTurn(advisor, turnOf(model), [step('done')], true);
    gate.resolve(advising({ note: 'A cheaper index exists for this lookup; consider it later.', severity: 'concern' }));
    await advisor.settled(1000);

    expect(recorded.map((entry) => [entry.note.severity, entry.spoken])).toEqual([['concern', false], ['blocker', true]]);
    expect({ said: sent.map((signal) => signal.severity), interrupts: interrupts() }).toEqual({ said: ['blocker'], interrupts: 0 });
  });

  test("the last step's review is waited for, and only its blocker is said", async () => {
    const { advisor, sent, recorded, interrupts } = harness();

    const { model } = scripted([
      silent,
      advising(
        { note: 'The summary claims the tests passed; none ran.', severity: 'blocker' },
        { note: 'The changelog entry could name the issue it closes.', severity: 'nit' },
      ),
    ]);

    // The request's review, then the last step's: the turn's end waits for the second.
    await runTurn(advisor, turnOf(model), [step('all tests pass')], true);

    expect({ said: sent.map((signal) => signal.severity), kept: recorded.map((entry) => [entry.note.severity, entry.spoken]), interrupts: interrupts() })
      .toEqual({ said: ['blocker'], kept: [['blocker', true], ['nit', false]], interrupts: 0 });
  });

  test(`says at most ${String(ADVISOR_NOTES_PER_UPDATE)} notes short of a blocker in one update`, async () => {
    const { advisor, sent } = harness();
    const notes = Array.from({ length: ADVISOR_NOTES_PER_UPDATE + 2 }, (_, at) => ({ note: `Distinct problem number ${String(at)} in the rounding code.`, severity: 'nit' }));
    const { model } = scripted([advising(...notes)]);
    await runTurn(advisor, turnOf(model), [step('edited')]);

    expect(sent).toHaveLength(ADVISOR_NOTES_PER_UPDATE);
  });

  test('a call repeated is warned once, then ends the update', async () => {
    const { advisor } = harness();
    const read = { toolCalls: [{ toolCallId: 'r', toolName: 'file', input: { op: 'read', path: 'a.ts' } }], responseMessages: [{ role: 'assistant' as const, content: '' }] };
    const { model, calls } = scripted([read, read, read, read, read]);
    const file = tool({ inputSchema: jsonSchema({ type: 'object' }), execute: async () => 'contents' });
    await runTurn(advisor, turnOf(model, { file }), []);

    // The read, its repeat (warned), and the third (stopped): three calls, not the update's six.
    expect(calls()).toBe(3);
  });

  test('a review that fails is no failure of the turn', async () => {
    const { advisor, sent } = harness();
    const { model } = scripted([async () => { throw new Error('the advisor model is down'); }]);

    await runTurn(advisor, turnOf(model), [step('edited')]);
    expect(sent).toEqual([]);
  });

  test('reviews nothing with the switch off, or for an agent that takes no input', async () => {
    for (const unreviewed of [{ enabled: false }, { reviewed: false }]) {
      const { advisor } = harness(unreviewed);
      const { model, calls } = scripted([]);
      await runTurn(advisor, turnOf(model), [step('edited')]);

      expect(calls()).toBe(0);
    }
  });

  test('is off for a new agent until the owner turns it on', () => {
    const { sql, execRaw } = createTestSql();

    expect(createTestActor(sql, execRaw, crypto.randomUUID(), 'fresh').config.getAdvisorEnabled()).toBe(false);
  });

  test("a card reads a blocker's note out of its row, this build's header and the hire's before it", () => {
    const hire = '[Advisor: a second model reviewed the turn you just finished. This is the Kinu runtime, not the user. Weigh it against what you know; it may be wrong.]';
    const said = (header: string) => `${header}\n\n${ADVISOR_SEVERITY_LABEL.blocker}: Stop and check the backup.`;

    expect([said(ADVISOR_HEADER), said(hire)].map((text) => keptAdvisorNote(text, 'blocker'))).toEqual(['Stop and check the backup.', 'Stop and check the backup.']);
    expect(keptAdvisorNote(`${ADVISOR_SEVERITY_LABEL.blocker}: not an advisor's row`, 'blocker')).toBeNull();
  });
});

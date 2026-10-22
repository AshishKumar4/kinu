// The in-session advisor: it reads each step's output once, batches what ends while it reviews, routes its notes by
// severity, guards what it may say, never fails the turn it watches, and does nothing until the owner turns it on.
import { describe, expect, test } from 'bun:test';
import { writeText } from '@nimbus-sh/core/vfs/vfs.js';
import { tool, jsonSchema, type ModelMessage } from 'ai';
import { createMemoryVfs, createTestSql } from '@kinu.run/test-utils';
import { createTestActor } from './helpers';
import { SessionAdvisor, type AdvisedTurn, type AdvisorModel, type AdvisorReply } from '../src/advisor/session-advisor';
import {
  ADVISOR_HEADER, ADVISOR_NOTE_MAX_CHARS, ADVISOR_SEVERITIES, ADVISOR_SEVERITY_LABEL, ADVISOR_SEVERITY_METADATA_KEY,
  ADVISOR_SIGNAL_KIND, keptAdvisorNote, normalizeNote, type AdvisorNote,
} from '../src/advisor/review';
import { advisorWorkspaceGuidance, type AdvisorWorkspace } from '../src/prompting/agents-md';
import { stepContextLimit } from '../src/context-window';
import { CHARS_PER_TOKEN } from '../src/token-estimate';
import type { AdvisorSeverity } from '../src/types/advisor';
import type { AgentSignal, SendOutcome } from '../src/types/signals';
import type { JsonObject, JsonValue } from '../src/utils/json';

/** The most notes short of a blocker one update says: oh-my-pi's emission guard, `ADVISOR_NOTES_PER_UPDATE`. */
const NOTES_PER_UPDATE = 4;

function harness(opts: {
  readonly enabled?: boolean;
  readonly reviewed?: boolean;
  readonly finalWaitMs?: number;
  readonly minSeverity?: AdvisorSeverity;
  readonly gateOpen?: boolean;
  readonly guidance?: () => Promise<string>;
  /** The reviewed agent's id: the same across two harnesses, as across a restart of its session. */
  readonly actorId?: string;
} = {}) {
  const { sql, execRaw } = createTestSql();
  const actor = createTestActor(sql, execRaw, opts.actorId ?? crypto.randomUUID(), 'reviewed');

  if (opts.enabled !== false) actor.config.setAdvisorEnabled(true);
  actor.config.setAdvisorMinSeverity(opts.minSeverity ?? 'nit');
  const sent: AgentSignal[] = [];
  const hirer: AgentSignal[] = [];
  const recorded: { readonly note: AdvisorNote; readonly spoken: boolean }[] = [];
  let interrupts = 0;
  // What the agent's delivery inbox answers a note it queued, whether or not its turn runs.
  let outcome: SendOutcome = 'queued';

  const advisor = new SessionAdvisor({
    actor,
    config: () => actor.config,
    reviewed: opts.reviewed ?? true,
    notes: () => ({
      recentAdvisorNotes: () => recorded.map((entry) => normalizeNote(entry.note.note)),
      recordAdvisorNote: (note, _turnId, spoken = false) => { recorded.push({ note, spoken }); },
    }),
    gateOpen: () => opts.gateOpen ?? false,
    send: async (signal) => {
      sent.push(signal);

      return outcome;
    },
    parent: async (signal) => {
      hirer.push(signal);

      return 'queued';
    },
    interrupt: async () => {
      interrupts += 1;

      return true;
    },
    guidance: opts.guidance ?? (async () => ''),
    ...(opts.finalWaitMs !== undefined && { finalWaitMs: opts.finalWaitMs }),
  });

  return {
    advisor, sent, recorded, hirer,
    interrupts: () => interrupts,
    outcome: (next: SendOutcome) => { outcome = next; },
  };
}

/** A model that answers each call with the next reply, recording the system prompt and conversation each was sent. */
function scripted(replies: readonly (AdvisorReply | (() => Promise<AdvisorReply>))[]) {
  const asked: (readonly ModelMessage[])[] = [];
  const systems: string[] = [];
  let at = 0;

  const model: AdvisorModel = async ({ system, messages }) => {
    asked.push([...messages]);
    systems.push(system);
    const next = replies[at] ?? silent;
    at += 1;

    return typeof next === 'function' ? await next() : next;
  };

  return { model, asked, systems, calls: () => at };
}

const silent: AdvisorReply = { toolCalls: [], responseMessages: [{ role: 'assistant', content: '' }] };

function advising(...notes: readonly JsonValue[]): AdvisorReply {
  const toolCalls = notes.map((input, at) => ({ toolCallId: `c${String(at)}`, toolName: 'advise', input }));

  return { toolCalls, responseMessages: [{ role: 'assistant', content: toolCalls.map((call) => ({ type: 'tool-call' as const, ...call })) }] };
}

const step = (text: string): ModelMessage[] => [{ role: 'assistant', content: [{ type: 'text', text }] }];

const turnOf = (model: AdvisorModel, tools: AdvisedTurn['tools'] = {}, turnId: string | null = 't1'): AdvisedTurn => ({ turnId, model, tools, reachable: ['file', 'agents'] });

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

/** The ids of the advisor's own tool calls with no result after them: a provider refuses a request that holds one. */
function unanswered(messages: readonly ModelMessage[]): string[] {
  const parts = messages.flatMap((message) => (typeof message.content === 'string' ? [] : message.content));
  const answered = new Set(parts.flatMap((part) => (part.type === 'tool-result' ? [part.toolCallId] : [])));

  return parts.flatMap((part) => (part.type === 'tool-call' && !answered.has(part.toolCallId) ? [part.toolCallId] : []));
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
      advising({ note: 'The migration ran before the suite. Stop and check the backup.', severity: 'blocker', class: 'wrong-work' }),
      advising({ note: 'The rounding mode differs from the spec; weigh it before the next edit.', severity: 'concern', class: 'wrong-work' }),
    ]);

    await runTurn(advisor, turnOf(model), [step('ran the migration'), step('edited rounding')]);

    expect(sent.map((signal) => signal.severity)).toEqual(['blocker', 'concern']);
    expect(interrupts()).toBe(1);
    expect(new Set(sent.map((signal) => signal.idempotencyKey)).size).toBe(2);
  });

  test('after its turn, a concern is kept as a changelog note and only a blocker is said, interrupting nothing', async () => {
    const { advisor, sent, recorded, interrupts, outcome } = harness({ finalWaitMs: 0 });
    const gate = Promise.withResolvers<AdvisorReply>();
    const { model } = scripted([() => gate.promise, advising({ note: 'The sum is computed twice over the same rows.', severity: 'blocker', class: 'wrong-work' })]);
    outcome('queued');
    await runTurn(advisor, turnOf(model), [step('done')], true);
    gate.resolve(advising({ note: 'A cheaper index exists for this lookup; consider it later.', severity: 'concern', class: 'wrong-work' }));
    await advisor.settled(1000);

    expect(recorded.map((entry) => [entry.note.severity, entry.spoken])).toEqual([['concern', false], ['blocker', true]]);
    expect({ said: sent.map((signal) => signal.severity), interrupts: interrupts() }).toEqual({ said: ['blocker'], interrupts: 0 });
  });

  test("the last step's review is waited for, and only its blocker is said", async () => {
    const { advisor, sent, recorded, interrupts } = harness();

    const { model } = scripted([
      silent,
      advising(
        { note: 'The summary claims the tests passed; none ran.', severity: 'blocker', class: 'wrong-work' },
        { note: 'The changelog entry could name the issue it closes.', severity: 'nit', class: 'wrong-work' },
      ),
    ]);

    // The request's review, then the last step's: the turn's end waits for the second.
    await runTurn(advisor, turnOf(model), [step('all tests pass')], true);

    expect({ said: sent.map((signal) => signal.severity), kept: recorded.map((entry) => [entry.note.severity, entry.spoken]), interrupts: interrupts() })
      .toEqual({ said: ['blocker'], kept: [['blocker', true], ['nit', false]], interrupts: 0 });
  });

  test(`says at most ${String(NOTES_PER_UPDATE)} notes short of a blocker in one update`, async () => {
    const { advisor, sent } = harness();
    const notes = Array.from({ length: NOTES_PER_UPDATE + 2 }, (_, at) => ({ note: `Distinct problem number ${String(at)} in the rounding code.`, severity: 'nit', class: 'wrong-work' }));
    const { model } = scripted([advising(...notes)]);
    await runTurn(advisor, turnOf(model), [step('edited')]);

    expect(sent).toHaveLength(NOTES_PER_UPDATE);
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

  test('a stopped review answers every call it made, and a read that fails is its result, so the next review is not refused', async () => {
    const { advisor } = harness();
    const input = { op: 'read', path: 'a.ts' };

    const calling = (toolName: string, id: string): AdvisorReply => ({
      toolCalls: [{ toolCallId: id, toolName, input }], responseMessages: [{ role: 'assistant', content: [{ type: 'tool-call', toolCallId: id, toolName, input }] }],
    });

    const { model, asked } = scripted([calling('file', 'r1'), calling('file', 'r2'), calling('file', 'r3'), calling('memory', 'm1')]);
    const file = tool({ inputSchema: jsonSchema({ type: 'object' }), execute: async () => 'contents' });
    const memory = tool({ inputSchema: jsonSchema({ type: 'object' }), execute: async () => { throw new Error('the memory store is gone'); } });
    await runTurn(advisor, turnOf(model, { file, memory }), [step('edited'), step('edited again')]);

    expect(asked.length).toBeGreaterThanOrEqual(5);
    expect(unanswered(asked.at(-1) ?? [])).toEqual([]);
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

  test("a review that outlives its turn speaks for that turn alone, and the next turn's steps go to the next turn's model", async () => {
    const { advisor, sent, recorded, interrupts } = harness({ finalWaitMs: 0 });
    const gate = Promise.withResolvers<AdvisorReply>();
    const first = scripted([() => gate.promise]);
    const second = scripted([]);
    const one = advisor.extension(turnOf(first.model, {}, 't1'));
    await one.onTurnStart?.({ system: '', history: [{ role: 'user', content: 'the first ask' }] });
    await one.onStepEnd?.({ stepNumber: 0, produced: step('the first turn step') });
    await one.onTurnEnd?.({ text: '', responseMessages: [] });
    const two = advisor.extension(turnOf(second.model, {}, 't2'));
    await two.onTurnStart?.({ system: '', history: [{ role: 'user', content: 'the second ask' }] });
    gate.resolve(advising({ note: 'The first turn skipped its tests.', severity: 'blocker', class: 'wrong-work' }));
    await two.onStepEnd?.({ stepNumber: 0, produced: step('the second turn step') });
    await advisor.settled(1000);
    await two.onTurnEnd?.({ text: '', responseMessages: [] });
    const secondRead = readOf(second.asked.at(-1) ?? []);

    // The first turn's blocker came after it: said to open a turn, keyed on its own turn, interrupting the second nothing.
    expect(recorded.map((entry) => [entry.note.severity, entry.spoken])).toEqual([['blocker', true]]);
    expect(sent.map((signal) => signal.idempotencyKey?.includes(':t1:'))).toEqual([true]);
    expect(interrupts()).toBe(0);
    // Its step not reviewed when the second turn began is dropped; the second's steps go to the second's model alone.
    expect(first.calls()).toBe(1);
    expect(secondRead.some((text) => text.includes('the second turn step'))).toBe(true);
    expect(secondRead.some((text) => text.includes('the first turn step'))).toBe(false);
  });

  test('a turn that ends without its end hook (a failed turn) is ended for its advisor: a late concern is kept, not said', async () => {
    const { advisor, sent, recorded } = harness();
    const gate = Promise.withResolvers<AdvisorReply>();
    const { model } = scripted([() => gate.promise]);
    await advisor.extension(turnOf(model)).onTurnStart?.({ system: '', history: [{ role: 'user', content: 'go' }] });
    advisor.endTurn();
    gate.resolve(advising({ note: 'The retry loop never reads its exit status.', severity: 'concern', class: 'wrong-work' }));
    await advisor.settled(1000);

    expect({ said: sent, kept: recorded.map((entry) => [entry.note.severity, entry.spoken]) }).toEqual({ said: [], kept: [['concern', false]] });
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

describe('where a note goes', () => {
  const concern = { note: 'The retry loop never reads the exit status; read it before reporting.', severity: 'concern', class: 'wrong-work' } as const;
  const nit = { note: 'The variable name is inconsistent with the module.', severity: 'nit', class: 'wrong-work' } as const;
  const blocker = { note: 'The migration ran against production, not staging.', severity: 'blocker', class: 'wrong-work' } as const;

  /** One step, its review answering `answer`: what was said, what was kept and whether the step was interrupted. */
  async function oneStep(answer: AdvisorReply, opts: Parameters<typeof harness>[0] = {}, turnId: string | null = 't1') {
    const run = harness(opts);
    const { model } = scripted([silent, answer]);
    await runTurn(run.advisor, turnOf(model, {}, turnId), [step('edited')]);

    return {
      said: run.sent, hirer: run.hirer, interrupts: run.interrupts(),
      kept: run.recorded.map((entry) => [entry.note.severity, entry.spoken]),
    };
  }

  test('at the floor it is said once, as a severity-tagged signal keyed on its turn, and kept as said', async () => {
    const { said, kept } = await oneStep(advising(concern), { minSeverity: 'concern' });

    expect(said).toHaveLength(1);
    expect(said[0]).toMatchObject({ kind: ADVISOR_SIGNAL_KIND, severity: 'concern', metadata: { [ADVISOR_SEVERITY_METADATA_KEY]: 'concern' } });
    expect(said[0]?.text).toContain(ADVISOR_HEADER);
    expect(said[0]?.text).toContain(concern.note);
    expect(said[0]?.idempotencyKey).toContain('t1');
    expect(kept).toEqual([['concern', true]]);
  });

  test('below the floor it is kept for the changelog and never said', async () => {
    expect(await oneStep(advising(nit), { minSeverity: 'concern' })).toMatchObject({ said: [], kept: [['nit', false]] });
    expect(await oneStep(advising(concern), { minSeverity: 'blocker' })).toMatchObject({ said: [], kept: [['concern', false]] });
  });

  test('an open completion gate holds back even a blocker: kept, not said, nothing interrupted', async () => {
    expect(await oneStep(advising(blocker), { gateOpen: true })).toMatchObject({ said: [], kept: [['blocker', false]], interrupts: 0 });
  });

  test('a blocker is also its hirer\'s; a concern is not', async () => {
    expect((await oneStep(advising(blocker))).hirer.map((signal) => signal.severity)).toEqual(['blocker']);
    expect((await oneStep(advising(concern))).hirer).toEqual([]);
  });

  test('a note that repeats a kept one, however punctuated, or that says nothing, is neither said nor kept', async () => {
    const run = harness();
    const { model } = scripted([silent, advising(concern), advising({ ...concern, note: `${concern.note.toUpperCase()}!` }), advising({ ...blocker, note: 'Stop.' })]);
    await runTurn(run.advisor, turnOf(model), [step('one'), step('two'), step('three')]);

    expect(run.sent).toHaveLength(1);
    expect(run.recorded).toHaveLength(1);
  });

  test('a blocker interrupts the running step whatever the inbox answered, except a note the agent never took', async () => {
    expect((await oneStep(advising(blocker))).interrupts).toBe(1);

    const yielded = harness();
    yielded.outcome('yielded');
    const { model } = scripted([silent, advising(blocker)]);
    await runTurn(yielded.advisor, turnOf(model), [step('edited')]);
    expect({ interrupts: yielded.interrupts(), kept: yielded.recorded.map((entry) => entry.spoken) }).toEqual({ interrupts: 0, kept: [false] });
  });

  test('a note is keyed by its turn and what it says, so a restarted turn says a new note, and an old one only once', async () => {
    const actorId = crypto.randomUUID();
    const keyOf = async (note: JsonObject) => (await oneStep(advising(note), { actorId })).said[0]?.idempotencyKey;
    const first = await keyOf(concern);

    expect(first).toBeDefined();
    expect(await keyOf({ ...concern, note: 'A different finding: the ledger rounds twice.' })).not.toBe(first);
    expect(await keyOf({ ...concern, note: `${concern.note.toUpperCase()}!` })).toBe(first);
  });

  test('a turn with no durable id says its note without an idempotency key, not with a made-up one', async () => {
    for (const turnId of [null, '']) {
      const { said } = await oneStep(advising(concern), {}, turnId);

      expect(said).toHaveLength(1);
      expect(said[0]).not.toHaveProperty('idempotencyKey');
    }
  });

  test('every declared severity and class is advice, and an over-long note is cut, not refused', async () => {
    for (const severity of ADVISOR_SEVERITIES) {
      for (const noteClass of ['wrong-work', 'missed-capability', 'dissatisfaction'] as const) {
        const { said } = await oneStep(advising({ note: `A ${severity} about ${noteClass}.`, severity, class: noteClass }));

        expect(said.map((signal) => signal.severity)).toEqual([severity]);
      }
    }

    const run = harness();
    const { model } = scripted([silent, advising({ ...concern, note: 'x'.repeat(ADVISOR_NOTE_MAX_CHARS + 200) })]);
    await runTurn(run.advisor, turnOf(model), [step('edited')]);
    expect(run.recorded.map((entry) => entry.note.note.length)).toEqual([ADVISOR_NOTE_MAX_CHARS]);
  });

  test('advice with an unknown or absent severity or class is refused, neither said nor kept', async () => {
    const refused: JsonValue[] = [
      { note: 'x is wrong', severity: 'critical', class: 'wrong-work' },
      { note: 'x is wrong', class: 'wrong-work' },
      { note: 'x is wrong', severity: 'nit', class: 'style' },
      { note: 'x is wrong', severity: 'nit' },
      { note: '   ', severity: 'blocker', class: 'wrong-work' },
    ];

    for (const advice of refused) expect(await oneStep(advising(advice))).toMatchObject({ said: [], kept: [] });
  });
});

describe('what the advisor reads', () => {
  /** The request and `steps`, each its own step, as one review after another reads them. */
  async function read(steps: readonly ModelMessage[][]): Promise<string> {
    const { advisor } = harness();
    const { model, asked } = scripted([]);
    await runTurn(advisor, turnOf(model), steps);

    return readOf(asked.at(-1) ?? []).join('\n');
  }

  const call = (input: JsonObject): ModelMessage[] => [{ role: 'assistant', content: [{ type: 'tool-call', toolCallId: 'c', toolName: 'shell', input }] }];

  const result = (value: string): ModelMessage[] => [{
    role: 'tool', content: [{ type: 'tool-result', toolCallId: 'c', toolName: 'shell', output: { type: 'text', value } }],
  }];

  test('a call and its result, by tool, and nothing of a step that only reasoned', async () => {
    const text = await read([call({ command: 'kinu rotate' }), result('exit 1'), [{ role: 'assistant', content: [{ type: 'reasoning', text: 'thinking it over' }] }]]);

    expect(text).toContain('shell');
    expect(text).toContain('kinu rotate');
    expect(text).toContain('exit 1');
    expect(text).not.toContain('thinking it over');
  });

  // The advisor's route may be another vendor's, so credential-shaped values are redacted before its model reads them.
  // Fixtures are assembled at runtime: a contiguous real-shaped literal trips `scripts/secret-scan.ts` and push protection.
  const bearer = 'Bearer ' + 't'.repeat(40);
  const awsKey = 'AK' + 'IA' + '1'.repeat(16);
  const kinuToken = 'pt' + 'a_' + 'ab12cd34';
  const providerKey = 'sk' + '-ant-' + 'x'.repeat(24);
  const privateKey = '-----BE' + 'GIN RSA PRIVATE KEY-----\nMIIB fake body\n-----END RSA PRIVATE KEY-----';

  test('tool arguments, results and replies carrying credentials are read redacted, a private key body and all', async () => {
    const leaked = `deployed with ${awsKey} as ${kinuToken}\n${privateKey}`;
    const text = await read([call({ command: 'deploy', token: bearer, key: providerKey }), result(leaked), step(leaked)]);

    for (const secret of [bearer, awsKey, kinuToken, providerKey, 'MIIB fake body']) expect(text).not.toContain(secret);
    expect(text).toContain('<redacted>');
  });

  test('secret-free values are read verbatim, lookalikes included', async () => {
    const commit = 'deadbeef'.repeat(5);
    const text = await read([call({ command: 'kinu rotate', commit, hint: 'pass a Bearer token along' }), result('exit 1')]);

    for (const kept of ['kinu rotate', commit, 'Bearer token', 'exit 1']) expect(text).toContain(kept);
    expect(text).not.toContain('redacted');
  });
});

describe("the advisor's system prompt", () => {
  test('names the capabilities the agent can reach, so a missed one can be named', async () => {
    const { advisor } = harness();
    const { model, systems } = scripted([]);
    await runTurn(advisor, turnOf(model), [step('edited')]);

    expect(systems[0]).toContain('file, agents');
  });

  const limits = { contextWindow: 800, modelOutputLimit: 400 };
  const budget = stepContextLimit(limits) * CHARS_PER_TOKEN;

  /** The system prompt a review sends with the workspace's ADVISOR.md holding `content`, and the files read for it. */
  async function promptWith(content?: string) {
    const { vfs } = createMemoryVfs();

    if (content !== undefined) await writeText(vfs, 'ADVISOR.md', content);
    const reads: string[] = [];

    const workspace: AdvisorWorkspace = {
      vfs: {
        ...vfs,
        stat: async (path) => {
          const stat = await vfs.stat(path);

          return stat === null || content === undefined ? stat : { ...stat, size: new TextEncoder().encode(content).length };
        },
        readFile: async (path) => {
          reads.push(path);

          return vfs.readFile(path);
        },
      },
      limits: async () => limits,
    };

    const { advisor } = harness({ guidance: async () => await advisorWorkspaceGuidance(workspace) });
    const { model, systems } = scripted([]);
    await runTurn(advisor, turnOf(model), []);

    return { prompt: systems[0] ?? '', reads };
  }

  test('with no ADVISOR.md, the prompt is the one with no guidance, and nothing is read', async () => {
    const without = await promptWith();
    const { advisor } = harness();
    const { model, systems } = scripted([]);
    await runTurn(advisor, turnOf(model), []);

    expect(without.reads).toEqual([]);
    expect(without.prompt).toBe(systems[0] ?? '');
  });

  test('an admitted ADVISOR.md has its own section, at the exact byte budget too', async () => {
    const guidance = 'Watch the migration backup. '.padEnd(budget, 'x');
    const { prompt, reads } = await promptWith(guidance);

    expect(reads).toEqual(['ADVISOR.md']);
    expect(prompt).toContain(guidance);
  });

  test('an oversized ADVISOR.md is never read or partly admitted, and UTF-8 bytes are what is priced', async () => {
    const oversized = await promptWith('x'.repeat(budget + 1));
    const wide = await promptWith('é'.repeat(budget));

    expect(oversized.reads).toEqual([]);
    expect(oversized.prompt).not.toContain('x'.repeat(budget + 1));
    expect(wide.reads).toEqual([]);
    expect(wide.prompt).toContain('ADVISOR.md');
  });
});

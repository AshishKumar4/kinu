/**
 * The evidence an episode keeps whatever happens to it: its ledger, transcript and spend, retained
 * once, with the channels that did not answer named rather than invented. First-run cases read a
 * failed row's evidence from here, so a lost channel must say which one and why.
 */
import { describe, expect, test } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import * as v from 'valibot';
import { REAL_CLOCK, RunEventSchema, type RunEvent, type WorkspaceSpend } from '@kinu.run/core';

import {
  EPISODE_TRANSCRIPT_FILES, EVIDENCE_GRACE_MS, projectRunEventProvenance, retainEpisodeTranscript, withEpisodeEvidence,
} from '../src/eval-run';
import { ledgerTotalsFromEvents } from '../src/eval-target';
import { handClock } from '../src/hand-clock';
import { liveModelSpend, resetLiveModelSpend } from '../src/live-model';
import { scratchDir } from '../src/scratch';

const TIMESTAMP = '2026-08-30T12:00:00.000Z';

/**
 * A two-turn ledger as the public events route serves it: a file written, a command that failed
 * (`bun test` exiting 1, a successful tool result whose text begins `Error (exit 1)`), the same
 * command run clean, an edit that landed, and a completion gate that found nothing left to do.
 */
const LEDGER_EVENTS: readonly RunEvent[] = [
  { type: 'run_start', runId: 'run-1', eventIndex: 0, timestamp: TIMESTAMP, agentId: 'eval-public' },
  { type: 'turn_start', runId: 'run-1', eventIndex: 1, timestamp: TIMESTAMP, turnIndex: 0 },
  {
    type: 'tool_call_end', runId: 'run-1', eventIndex: 2, timestamp: TIMESTAMP,
    name: 'file', toolCallId: 'call-1',
    args: { action: 'write', path: 'note.txt' }, result: 'Wrote note.txt', durationMs: 12,
    outcome: { success: true },
  },
  {
    type: 'tool_call_end', runId: 'run-1', eventIndex: 3, timestamp: TIMESTAMP,
    name: 'shell', toolCallId: 'call-2',
    args: { command: 'bun test broken.test.ts' },
    result: 'Error (exit 1)\n--- stderr ---\n1 fail', durationMs: 900,
    outcome: { success: false, reason: null, execution: { exitCode: 1 } },
  },
  { type: 'step_finish', runId: 'run-1', eventIndex: 4, timestamp: TIMESTAMP, stepIndex: 0, reason: 'tool-calls' },
  {
    type: 'turn_end', runId: 'run-1', eventIndex: 5, timestamp: TIMESTAMP, turnIndex: 0,
    usage: { input: 1_200, output: 300 },
  },
  { type: 'turn_start', runId: 'run-1', eventIndex: 6, timestamp: TIMESTAMP, turnIndex: 1 },
  {
    type: 'tool_call_end', runId: 'run-1', eventIndex: 7, timestamp: TIMESTAMP,
    name: 'file', toolCallId: 'call-3',
    args: { action: 'edit', path: 'broken.ts' }, result: 'Applied 1 edit', durationMs: 20,
    outcome: { success: true },
  },
  {
    type: 'file_edit', runId: 'run-1', eventIndex: 8, timestamp: TIMESTAMP,
    attempts: 2, applied: 1, failures: { not_found: 1 }, recoveredPaths: 1, abandonedPaths: 0,
  },
  {
    type: 'tool_call_end', runId: 'run-1', eventIndex: 9, timestamp: TIMESTAMP,
    name: 'shell', toolCallId: 'call-4',
    args: { command: 'bun test broken.test.ts' }, result: '1 pass, 0 fail', durationMs: 850,
    outcome: { success: true },
  },
  { type: 'completion_gate', runId: 'run-1', eventIndex: 10, timestamp: TIMESTAMP, converted: false },
  { type: 'step_finish', runId: 'run-1', eventIndex: 11, timestamp: TIMESTAMP, stepIndex: 1, reason: 'stop' },
  {
    type: 'turn_end', runId: 'run-1', eventIndex: 12, timestamp: TIMESTAMP, turnIndex: 1,
    usage: { input: 1_500, output: 220 },
  },
  { type: 'run_end', runId: 'run-1', eventIndex: 13, timestamp: TIMESTAMP, reason: 'completed' },
];

/** `collection.json` as a reader must be able to read it back: one row per
 *  channel, the status, and the reason a channel that did not land carries. */
const CollectionSchema = v.array(v.object({
  channel: v.string(), status: v.string(), reason: v.optional(v.string()),
}));

describe('an episode keeps its evidence', () => {
  test('the record\'s provenance is the ledger\'s shape with every payload stripped', () => {
    // Fed in REVERSE so the ordering is proven rather than inherited from the
    // fixture: a projection that kept route order would publish a trail whose
    // "later call of the same tool ran clean" reads backwards.
    const provenance = projectRunEventProvenance([...LEDGER_EVENTS].reverse());
    expect(provenance.totalEvents).toBe(LEDGER_EVENTS.length);
    expect(provenance.events.map((event) => event.eventIndex))
      .toEqual(LEDGER_EVENTS.map((event) => event.eventIndex));
    // The failing `shell` keeps its CLASS and its name; the clean one keeps no class.
    const calls = provenance.events.filter((event) => event.type === 'tool_call_end');
    expect(calls.map((event) => event.name)).toEqual(['file', 'shell', 'file', 'shell']);
    expect(calls.map((event) => event.failureClass ?? null)).toEqual([null, 'exit_1', null, null]);
    expect(calls.map((event) => event.durationMs)).toEqual([12, 900, 20, 850]);
    expect(calls[1]?.outcome).toEqual({ success: false, reason: null, execution: { exitCode: 1 } });
    // Nothing that was SAID survives: not the command, not the result text.
    const serialized = JSON.stringify(provenance);
    expect(serialized).not.toContain('bun test broken.test.ts');
    expect(serialized).not.toContain('1 fail');
    expect(serialized).not.toContain('args');
  });

  test('the bound clips the slice and says so, never the count', () => {
    const long = Array.from({ length: 1_203 }, (_, index): RunEvent => ({
      type: 'step_finish', runId: 'run-9', eventIndex: index, timestamp: '2026-08-30T12:00:00.000Z', stepIndex: index,
      reason: 'tool-calls',
    }));

    const provenance = projectRunEventProvenance(long);
    expect(provenance.totalEvents).toBe(1_203);
    expect(provenance.events).toHaveLength(provenance.bound);
    expect(provenance.events.at(-1)?.eventIndex).toBe(provenance.bound - 1);
  });

  test('a retained episode is readable back as the ledger, the transcript and the verdicts', () => {
    const root = scratchDir('retained-episode');
    const history = [{ role: 'user', text: 'write it' }, { role: 'assistant', text: 'DONE' }];
    const subgoals = [{ what: 'artifact', reached: false, detail: 'the file was empty' }];

    const dir = retainEpisodeTranscript(root, 'public-file-artifact', {
      events: LEDGER_EVENTS, history, subgoals,
    });

    expect(dir).toBe(join(root, 'public-file-artifact'));
    // ONE EVENT A LINE, every one the canonical union: a clipped or concatenated
    // read is still a parse of what was written, and a foreign shape fails here
    // rather than in a reader a month later.
    const lines = readFileSync(join(dir, EPISODE_TRANSCRIPT_FILES.events), 'utf8').trimEnd().split('\n');
    expect(lines).toHaveLength(LEDGER_EVENTS.length);
    const events = lines.map((line) => v.parse(RunEventSchema, JSON.parse(line)));
    expect(ledgerTotalsFromEvents(events)).toEqual({
      turns: 2, toolCalls: 4, toolNames: ['file', 'shell', 'file', 'shell'],
      tokensIn: 2700, tokensOut: 520, reasoningOut: 0, steps: 2, failures: ['shell: exit_1'],
    });
    expect(JSON.parse(readFileSync(join(dir, EPISODE_TRANSCRIPT_FILES.history), 'utf8'))).toEqual(history);
    expect(JSON.parse(readFileSync(join(dir, EPISODE_TRANSCRIPT_FILES.subgoals), 'utf8'))).toEqual(subgoals);
    // An episode with no events leaves an EMPTY file, not a file holding one
    // blank line that a reader would parse as a malformed event.
    const empty = retainEpisodeTranscript(root, 'no-events', { events: [], history: [], subgoals: [] });
    expect(existsSync(join(empty, EPISODE_TRANSCRIPT_FILES.events))).toBe(true);
    expect(readFileSync(join(empty, EPISODE_TRANSCRIPT_FILES.events), 'utf8')).toBe('');
  });

  test('an operation failure still retains its ledger and spend exactly once', async () => {
    resetLiveModelSpend();
    const root = scratchDir('failed-episode-evidence');

    const spend: WorkspaceSpend = {
      total: {
        calls: 8, callsWithoutUsage: 0, unpricedCalls: 8, floorPricedCalls: 0,
        usage: { input: 234433, output: 29531 },
      },
      producers: [], missions: [], offTurnShare: null,
      coverage: { calls: 8, measured: 8, reported: 1, silent: [], partial: [] },
    };

    const reader = {
      async runEvents() { return LEDGER_EVENTS; },
      async history() { return [{ role: 'assistant', text: 'partial answer' }]; },
      async spend() { return spend; },
    };

    try {
      await expect(withEpisodeEvidence(async () => reader, { transcripts: root, taskId: 'failure', modelCalls: 'expected', clock: REAL_CLOCK }, async () => {
        throw new Error('failed after model work');
      })).rejects.toThrow('failed after model work');
      expect(liveModelSpend().calls).toBe(8);
      expect(JSON.parse(readFileSync(join(root, 'failure/spend.json'), 'utf8'))).toEqual(spend);
      const events = readFileSync(join(root, 'failure/events.jsonl'), 'utf8').split('\n').map((line) => v.parse(RunEventSchema, JSON.parse(line)));
      expect(ledgerTotalsFromEvents(events).turns).toBe(2);
      expect(readFileSync(join(root, 'failure/failure.json'), 'utf8')).toContain('failed after model work');

      resetLiveModelSpend();
      await expect(withEpisodeEvidence(async () => reader, { transcripts: root, taskId: 'assertion', modelCalls: 'expected', clock: REAL_CLOCK }, async (_reader, collect) => {
        await collect();
        throw new Error('subgoal missed');
      })).rejects.toThrow('subgoal missed');
      expect(liveModelSpend().calls).toBe(8);

      resetLiveModelSpend();
      await expect(withEpisodeEvidence(async () => ({ ...reader, async spend() { throw new Error('spend endpoint unavailable'); } }),
        { transcripts: root, taskId: 'outage', modelCalls: 'expected', clock: REAL_CLOCK }, async () => 'finished')).rejects.toThrow('spend endpoint unavailable');
      expect(liveModelSpend().episodesUnmeasured).toBe(1);
      expect(readFileSync(join(root, 'outage/history.json'), 'utf8')).toContain('partial answer');
      expect(JSON.parse(readFileSync(join(root, 'outage/collection.json'), 'utf8'))).toContainEqual({
        channel: 'spend', status: 'failed', reason: 'spend endpoint unavailable',
      });
    } finally {
      resetLiveModelSpend();
    }
  });

  test('a spent episode budget tells the operation, retains the evidence as found, and fails on the budget', async () => {
    resetLiveModelSpend();
    const root = scratchDir('budget-evidence');

    const spend: WorkspaceSpend = {
      total: { calls: 3, callsWithoutUsage: 0, unpricedCalls: 3, floorPricedCalls: 0, usage: { input: 10, output: 5 } },
      producers: [], missions: [], offTurnShare: null,
      coverage: { calls: 3, measured: 3, reported: 1, silent: [], partial: [] },
    };

    const reader = {
      async runEvents() { return LEDGER_EVENTS; },
      async history() { return [{ role: 'assistant', text: 'still waiting' }]; },
      async spend() { return spend; },
    };

    try {
      // The operation is a wait the product never ends; the budget is the
      // subject's own configuration, and the operation stops on its signal.
      // The budget runs on a clock the test hands it, so "the budget was
      // spent" is the advance below, never a sleep racing a real timer.
      let told = false;
      const clock = handClock();

      const episode = withEpisodeEvidence(async () => reader, { transcripts: root, taskId: 'budget', modelCalls: 'expected', clock, budgetMs: 20 },
        async (_reader, _collect, budget) => {
          await new Promise<void>((resolve) => { budget.addEventListener('abort', () => resolve(), { once: true }); });
          told = true;

          return 'never';
        });

      await clock.whenArmed(1);
      clock.advance(20);
      await expect(episode).rejects.toThrow('the episode budget of 20 ms was spent');
      expect(told).toBe(true);
      expect(JSON.parse(readFileSync(join(root, 'budget/failure.json'), 'utf8'))).toMatchObject({ phase: 'budget' });
      expect(readFileSync(join(root, 'budget/history.json'), 'utf8')).toContain('still waiting');
      expect(readFileSync(join(root, 'budget/events.jsonl'), 'utf8').split('\n')).toHaveLength(LEDGER_EVENTS.length);
      expect(JSON.parse(readFileSync(join(root, 'budget/spend.json'), 'utf8'))).toEqual(spend);
    } finally {
      resetLiveModelSpend();
    }
  });

  test('a spent budget names what the turn was waiting on, off its own ledger', async () => {
    resetLiveModelSpend();
    const root = scratchDir('budget-waited-on');

    // A turn held by the model provider: rate-limited twice and not yet ended
    // when the case's budget ran out. The verdict names that, rather than only
    // that time ran out.
    const ledger: readonly RunEvent[] = [
      { eventIndex: 0, runId: 'run-held', type: 'run_start', timestamp: '2026-09-23T14:16:15.415Z', agentId: 'orchestrator' },
      { eventIndex: 1, runId: 'run-held', type: 'provider_wait', timestamp: '2026-09-23T14:16:17.341Z',
        provider: 'workers-ai', waitMs: 1983, attempt: 1, status: 429, source: 'backoff' },
      { eventIndex: 2, runId: 'run-held', type: 'provider_wait', timestamp: '2026-09-23T14:16:21.000Z',
        provider: 'workers-ai', waitMs: 4017, attempt: 2, status: 429, source: 'backoff' },
    ];

    const reader = {
      async runEvents() { return ledger; },
      async history() { return []; },
      async spend(): Promise<WorkspaceSpend> {
        return {
          total: { calls: 1, callsWithoutUsage: 0, unpricedCalls: 1, floorPricedCalls: 0, usage: { input: 1, output: 1 } },
          producers: [], missions: [], offTurnShare: null,
          coverage: { calls: 1, measured: 1, reported: 1, silent: [], partial: [] },
        };
      },
    };

    try {
      const clock = handClock();

      const episode = withEpisodeEvidence(async () => reader,
        { transcripts: root, taskId: 'held', modelCalls: 'expected', clock, budgetMs: 20 },
        async (_reader, _collect, budget) => {
          const stopped = Promise.withResolvers<void>();

          budget.addEventListener('abort', () => { stopped.resolve(); }, { once: true });
          await stopped.promise;

          return 'never';
        });

      await clock.whenArmed(1);
      clock.advance(20);

      const [outcome] = await Promise.allSettled([episode]);
      const failure = outcome?.status === 'rejected' ? v.parse(v.instance(Error), outcome.reason).message : 'the episode ended';

      for (const fact of ['provider_wait', 'had not ended', '2 provider wait(s) on workers-ai', '429', '6.0 s']) {
        expect(failure).toContain(fact);
      }

      expect(JSON.parse(readFileSync(join(root, 'held/failure.json'), 'utf8'))).toEqual({ name: 'Error', message: failure, phase: 'budget' });
    } finally {
      resetLiveModelSpend();
    }
  });

  test('a ledger the wedged product never answers ends at the grace, keeping what did answer', async () => {
    resetLiveModelSpend();
    const root = scratchDir('wedged-episode-evidence');

    const spend: WorkspaceSpend = {
      total: { calls: 3, callsWithoutUsage: 0, unpricedCalls: 3, floorPricedCalls: 0, usage: { input: 10, output: 5 } },
      producers: [], missions: [], offTurnShare: null,
      coverage: { calls: 3, measured: 3, reported: 1, silent: [], partial: [] },
    };

    // THE WEDGED SHAPE, as the deployed build answered it: the Durable Object
    // holds the turn it never closed, so the run-event route never answers
    // while the two routes served elsewhere still do. Before the read had an
    // end of its own this episode never settled at all — the budget fired,
    // the operation stopped, and the collection it was waiting on stayed
    // pending until the runner killed the process with no verdict.
    const reader = {
      runEvents(): Promise<readonly RunEvent[]> { return new Promise<readonly RunEvent[]>(() => undefined); },
      async history() { return [{ role: 'assistant', text: 'still waiting' }]; },
      async spend() { return spend; },
    };

    try {
      const clock = handClock();

      const episode = withEpisodeEvidence(async () => reader,
        { transcripts: root, taskId: 'wedged', modelCalls: 'expected', clock, budgetMs: 20 },
        async (_reader, collect) => collect());

      await clock.whenArmed(2);
      clock.advance(20 + EVIDENCE_GRACE_MS);

      await expect(episode).rejects.toThrow('the episode budget of 20 ms was spent');
      expect(JSON.parse(readFileSync(join(root, 'wedged/failure.json'), 'utf8'))).toMatchObject({ phase: 'budget' });

      const collection = v.parse(CollectionSchema, JSON.parse(readFileSync(join(root, 'wedged/collection.json'), 'utf8')));

      expect(collection.find((row) => row.channel === 'events')?.status).toBe('failed');
      expect(collection.find((row) => row.channel === 'events')?.reason).toContain(String(EVIDENCE_GRACE_MS));
      expect(existsSync(join(root, 'wedged/events.jsonl'))).toBe(false);

      // What DID answer is still the episode's evidence.
      expect(collection.filter((row) => row.status === 'retained').map((row) => row.channel)).toEqual(['history', 'spend']);
      expect(readFileSync(join(root, 'wedged/history.json'), 'utf8')).toContain('still waiting');
      expect(JSON.parse(readFileSync(join(root, 'wedged/spend.json'), 'utf8'))).toEqual(spend);
    } finally {
      resetLiveModelSpend();
    }
  });

  test('an unbudgeted episode whose socket read never answers ends at the grace, keeping what did answer', async () => {
    resetLiveModelSpend();
    const root = scratchDir('silent-socket-evidence');

    // THE SILENT-SOCKET SHAPE, as device-link-holds met it on 2026-09-23: the
    // runtime replaced the workspace's object mid-case and closed its socket
    // (1006, "this Durable Object instance is no longer active"), so the spend
    // read, the one channel that rides the socket, never answered while both
    // REST channels did. The case set no budget, and the read had no end of its
    // own until the tier's deadline killed the run with no verdict.
    const reader = {
      async runEvents() { return LEDGER_EVENTS; },
      async history() { return [{ role: 'assistant', text: 'held' }]; },
      spend(): Promise<WorkspaceSpend> { return Promise.withResolvers<WorkspaceSpend>().promise; },
    };

    try {
      const clock = handClock();

      const episode = withEpisodeEvidence(async () => reader,
        { transcripts: root, taskId: 'silent', modelCalls: 'none', clock },
        async () => 'finished');

      await clock.whenArmed(1);
      clock.advance(EVIDENCE_GRACE_MS);

      await expect(episode).rejects.toThrow('the spend channel had not answered');

      const collection = v.parse(CollectionSchema, JSON.parse(readFileSync(join(root, 'silent/collection.json'), 'utf8')));

      expect(collection.find((row) => row.channel === 'spend')?.status).toBe('failed');
      expect(collection.filter((row) => row.status === 'retained').map((row) => row.channel)).toEqual(['events', 'history']);
    } finally {
      resetLiveModelSpend();
    }
  });

  test('an opening failure retains the cause and unavailable channels without inventing measurements', async () => {
    resetLiveModelSpend();
    const root = scratchDir('opening-evidence');
    const failure = new Error('created workspace but connection failed');

    try {
      await expect(withEpisodeEvidence(async () => { throw failure; },
        { transcripts: root, taskId: 'opening', modelCalls: 'expected', clock: REAL_CLOCK },
        async () => { throw new Error('unreachable operation'); })).rejects.toBe(failure);
      expect(JSON.parse(readFileSync(join(root, 'opening/failure.json'), 'utf8'))).toMatchObject({ phase: 'open', message: failure.message });
      expect(JSON.parse(readFileSync(join(root, 'opening/collection.json'), 'utf8'))).toEqual([
        { channel: 'events', status: 'unavailable', reason: 'session opening failed' },
        { channel: 'history', status: 'unavailable', reason: 'session opening failed' },
        { channel: 'spend', status: 'unavailable', reason: 'session opening failed' },
      ]);
      expect(existsSync(join(root, 'opening/spend.json'))).toBe(false);
      expect(existsSync(join(root, 'opening/events.jsonl'))).toBe(false);
      expect(liveModelSpend().episodesUnmeasured).toBe(1);
      expect(liveModelSpend().episodesWithoutModel).toBe(0);
    } finally {
      resetLiveModelSpend();
    }
  });
});

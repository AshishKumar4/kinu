// Core seams where backend drift lands (CoreAdapterAudit): each block pins one thing the two
// backends could otherwise disagree about silently.

import { describe, test, expect } from 'bun:test';
import { Database } from 'bun:sqlite';
import * as v from 'valibot';
import { jsonSchema, tool, type FinishReason } from 'ai';
import { createRecordingLogger, setDiagnosticsSink } from '../src/obs/index';
import { createTestActors, createTestActorsOver, createTestSql } from '@kinu.run/test-utils';
import {
  EVENT_VARIANTS, type EventVariant,
  buildModelCallEvent, type ModelCallReport,
  classifyRunEnd, RUN_END_REASONS, type RunEndReason,
  TOOL_CALLS_PENDING, TURN_ENDED_MID_WORK,
  declareTerminalRoster,
  AgentOrchestrator, type AgentOrchestratorDeps,
  providerSnapshotOf, ProviderListingCache, type ProviderListing,
  defaultSpecFor, DEFAULT_WORKERS_AI_MODEL_SPEC, workersAiSpec,
  DEFAULT_ROLE_ID, REPORT_TOOL, SUBMIT_PLAN_TOOL, DEPS_GATED_TOOLS,
  craftedToolDescription, toCraftedToolSource, type CraftedTool,
  CRAFTED_TOOL_NAMESPACE, nativeToolFunctions,
  attributeCraftedFailure, craftFailureMarker,
  initCompletedTurnTable, createCompletedTurnStore,
  initEventsHubTables, EventLog,
  type ModelPricing, type CompletedTurn, type SqlExec,
  type BackendHost, type BroadcastEvent, type ProgrammaticTurn,
} from '../src/index';
import { makeSqlExec } from './helpers';

describe('EVENT_VARIANTS — the array and the type cannot disagree', () => {
  // One declaration: a hand-mirrored picklist would compile yet refuse a new variant at its route.
  test('every declared variant is accepted by a picklist built from the array', () => {
    const schema = v.picklist(EVENT_VARIANTS);

    for (const variant of EVENT_VARIANTS) {
      expect(v.parse(schema, variant)).toBe(variant);
    }

    expect(() => v.parse(schema, 'not_a_variant')).toThrow();
  });

  test('the type is derived from the array, both directions', () => {
    // Assignability both ways is type equality; a hand re-declared type stops compiling here.
    const fromArray: EventVariant = EVENT_VARIANTS[0];
    const toArray: (typeof EVENT_VARIANTS)[number] = fromArray;
    expect(EVENT_VARIANTS).toContain(toArray);
    expect(new Set(EVENT_VARIANTS).size).toBe(EVENT_VARIANTS.length);
  });
});

describe('buildModelCallEvent — usage is always present, pricing is guarded', () => {
  // Per-1M-token rates: 1M input + 1M output tokens cost 1 + 2 = $3.
  const pricing: ModelPricing = { input: 1, output: 2 };

  const report = (over: Partial<ModelCallReport> = {}): ModelCallReport => ({
    source: 'judge', usage: { input: 1_000_000, output: 1_000_000 }, spec: 'openai/gpt-x', ...over,
  });

  // Both backends must shape usage for an unreported call identically, or a spend reader cannot
  // tell unmeasured from not recorded.
  test('a provider that reported nothing still carries usage, as {}', () => {
    const event = buildModelCallEvent(report({ usage: {} }), { effectiveSpec: 'openai/gpt-x', pricing });
    expect(event.usage).toEqual({});
    expect('usage' in event).toBe(true);
  });

  test('a measured call carries what the provider said', () => {
    const event = buildModelCallEvent(report(), { effectiveSpec: 'openai/gpt-x', pricing });
    expect(event.usage).toEqual({ input: 1_000_000, output: 1_000_000 });
  });

  test('priced when the rate belongs to the model that served the call', () => {
    const event = buildModelCallEvent(report(), { effectiveSpec: 'openai/gpt-x', pricing });
    expect(event.usd).toBeCloseTo(3, 10);
  });

  // A judge runs on a different model; pricing it at the actor's rate would invent a number.
  test('NOT priced when the call ran on a different model than the rate', () => {
    const event = buildModelCallEvent(report(), { effectiveSpec: 'anthropic/claude-x', pricing });
    expect(event.usd).toBeUndefined();
    expect(event.usage).toEqual({ input: 1_000_000, output: 1_000_000 });
  });

  test('NOT priced when the report carries no spec at all', () => {
    const bare = buildModelCallEvent(report({ spec: undefined }), { effectiveSpec: 'openai/gpt-x', pricing });
    expect(bare.usd).toBeUndefined();
    expect('spec' in bare).toBe(false);
  });

  // Guards the `undefined === null` accident: an absent spec must not match an absent effective spec.
  test('an absent spec does not match an absent effective spec', () => {
    const event = buildModelCallEvent(report({ spec: undefined }), { effectiveSpec: null, pricing });
    expect(event.usd).toBeUndefined();
  });

  test('NOT priced before the catalog lookup lands', () => {
    const event = buildModelCallEvent(report(), { effectiveSpec: 'openai/gpt-x', pricing: null });
    expect(event.usd).toBeUndefined();
  });

  test('modelId rides when the provider named what served the call', () => {
    const event = buildModelCallEvent(report({ modelId: 'gpt-x-2026-01' }), { effectiveSpec: null, pricing: null });
    expect(event.modelId).toBe('gpt-x-2026-01');
  });
});

describe('classifyRunEnd — a user Stop is aborted on every backend', () => {
  // A local Stop must seal 'aborted' on both backends. runChat yields `done` and then throws the
  // interruption, so when both are true the Stop names the run.
  const ends = [
    { name: 'a finished turn completes', completed: true, interrupted: false, reason: 'completed' },
    { name: 'an interrupted turn is aborted, never error', completed: false, interrupted: true, reason: 'aborted' },
    { name: 'an interrupt outranks a completed flag the driver already set',
      completed: true, interrupted: true, reason: 'aborted' },
  ] as const;

  for (const end of ends) {
    test(end.name, () => {
      expect(classifyRunEnd({ completed: end.completed, interrupted: end.interrupted }))
        .toEqual({ reason: end.reason });
    });
  }

  test('the interruption text is dropped, not carried onto the aborted row', () => {
    const classified = classifyRunEnd({
      completed: false, interrupted: true,
      errorText: 'The turn was interrupted before it finished.',
    });

    expect(classified).toEqual({ reason: 'aborted' });
    expect('error' in classified).toBe(false);
  });

  test('a thrown failure is an error, and keeps its text', () => {
    expect(classifyRunEnd({ completed: false, interrupted: false, errorText: 'provider 500' }))
      .toEqual({ reason: 'error', error: 'provider 500' });
  });

  test('neither finished nor threw anything nameable is still an error, with no invented cause', () => {
    const classified = classifyRunEnd({ completed: false, interrupted: false });
    expect(classified).toEqual({ reason: 'error' });
    expect('error' in classified).toBe(false);
  });

  test('a turn that stopped with work pending is its own reason, not a completion', () => {
    // A loop that ended while the model was still calling tools did not finish (issue #16).
    expect([...RUN_END_REASONS]).toEqual(['completed', 'aborted', 'error', 'incomplete']);
    const every: readonly RunEndReason[] = RUN_END_REASONS;
    expect(every).toHaveLength(4);
  });
});

// R4: a turn must never end with tool calls pending (`@cloudflare/think` once capped steps at 10).
// No ledger reason exists for it; this tripwire fires if the state becomes reachable again.

describe('the mid-work invariant is loud when it breaks', () => {
  /** One classification with the diagnostics sink captured. */
  function classifyWithLog(facts: Parameters<typeof classifyRunEnd>[0]) {
    const log = createRecordingLogger();
    const restore = setDiagnosticsSink(log);

    try {
      return { classified: classifyRunEnd(facts), emitted: log.emitted };
    } finally {
      restore();
    }
  }

  test('a clean end with tool calls pending is reported as a DEFECT', () => {
    const { emitted } = classifyWithLog({
      completed: true, interrupted: false, lastFinishReason: TOOL_CALLS_PENDING,
    });

    const tripped = emitted.filter((row) => row.event === TURN_ENDED_MID_WORK);
    expect(tripped).toHaveLength(1);
    expect(tripped[0]?.code).toBe('unavailable');
    expect(tripped[0]?.cause).toContain('tool calls pending');
    expect(tripped[0]?.cause).toContain('step ceiling');
  });

  test('it is sealed incomplete, and carries no failure text it did not observe', () => {
    const { classified } = classifyWithLog({
      completed: true, interrupted: false, lastFinishReason: TOOL_CALLS_PENDING,
    });

    expect(classified).toEqual({ reason: 'incomplete' });
    expect('error' in classified).toBe(false);
  });

  test('a turn whose last step stopped on its own trips nothing', () => {
    // Control: without it the test above would pass on a tripwire that fires for every turn.
    const { classified, emitted } = classifyWithLog({
      completed: true, interrupted: false, lastFinishReason: 'stop',
    });

    expect(classified).toEqual({ reason: 'completed' });
    expect(emitted.filter((row) => row.event === TURN_ENDED_MID_WORK)).toHaveLength(0);
  });

  test('a turn that reported no finish reason trips nothing — absent is not evidence', () => {
    const { emitted } = classifyWithLog({ completed: true, interrupted: false });
    expect(emitted.filter((row) => row.event === TURN_ENDED_MID_WORK)).toHaveLength(0);
  });

  test('a user Stop mid-tool-call is aborted and trips nothing — the user cut it', () => {
    const { classified, emitted } = classifyWithLog({
      completed: true, interrupted: true, lastFinishReason: TOOL_CALLS_PENDING,
    });

    expect(classified).toEqual({ reason: 'aborted' });
    expect(emitted.filter((row) => row.event === TURN_ENDED_MID_WORK)).toHaveLength(0);
  });

  test('a thrown failure mid-tool-call is an error and trips nothing — the throw is the cause', () => {
    const { classified, emitted } = classifyWithLog({
      completed: false, interrupted: false,
      errorText: 'provider 500', lastFinishReason: TOOL_CALLS_PENDING,
    });

    expect(classified).toEqual({ reason: 'error', error: 'provider 500' });
    expect(emitted.filter((row) => row.event === TURN_ENDED_MID_WORK)).toHaveLength(0);
  });

  test("the pending word is the SDK's own, not a Kinu spelling", () => {
    // Typed against `ai`'s union: a renamed finish reason would silently stop the tripwire.
    const sdkReason: FinishReason = TOOL_CALLS_PENDING;
    expect(sdkReason).toBe('tool-calls');
  });
});

// R5: a stream cut mid-prose leaves the provider's end unnamed; the driver must not seal it
// 'completed' as though the model had finished.

describe('a turn whose provider never named an end is not completed', () => {
  // The SDK default when `finish_reason` never arrived; the annotation pins the word so a rename
  // stops compiling.
  const unnamedEnd: FinishReason = 'other';

  test('an unnamed end seals error with text, not completed', () => {
    const classified = classifyRunEnd({
      completed: true, interrupted: false, lastFinishReason: unnamedEnd,
    });

    expect(classified.reason).toBe('error');
    expect(classified.error).toContain('without naming');
  });

  test('a user Stop outranks it — a cut the user made is not a broken pipe', () => {
    expect(classifyRunEnd({
      completed: true, interrupted: true, lastFinishReason: unnamedEnd,
    })).toEqual({ reason: 'aborted' });
  });

  test('a thrown failure keeps its own text — the throw is the better cause', () => {
    expect(classifyRunEnd({
      completed: false, interrupted: false,
      errorText: 'provider 500', lastFinishReason: unnamedEnd,
    })).toEqual({ reason: 'error', error: 'provider 500' });
  });

  test('a named end still completes — the control', () => {
    expect(classifyRunEnd({ completed: true, interrupted: false, lastFinishReason: 'stop' }))
      .toEqual({ reason: 'completed' });
  });
});

function seamOrchestrator(opts?: { enabled?: boolean }) {
  const recorded: CompletedTurn[] = [];
  const { sql, execRaw } = createTestSql();
  initCompletedTurnTable(execRaw);
  const store = createCompletedTurnStore(sql, createTestActors(sql, execRaw).main);

  const engine: AgentOrchestratorDeps['engine'] = {
    enabled: opts?.enabled ?? true,
    get recordsTurns() { return this.enabled; },
    recoverInterruptedWork: () => {},
    recentAdvisorNotes: () => [],
    recordAdvisorNote: () => { throw new Error('This fixture runs no advisor'); },
    hasAdvisorNoteForTurn: () => false,
    sessionWindow: store,
    craftLedger: { names: () => [], observe: () => [] },
    reviewTurn: async (turn) => { recorded.push(turn); },
    runStoredTurnReview: async (rowId, turn) => { recorded.push(turn); void rowId; },
    onSessionComplete: async () => {},
    runDueShadowTrials: async () => {},
    recordRecovery: () => {},
    deferTurnReview: () => 'queued',
    // With no follow-up turn, this drain runs the review the recording wrote onto the turn row, the
    // same claim-guarded path production takes.
    runDeferredTurnReviews: async () => {
      const taken = store.takeQueuedReviews(8);

      for (const row of taken.reviews) {
        recorded.push(row.turn);
        store.settleReview(row.id);
      }

      return { reviewed: taken.reviews.length, refused: taken.refused };
    },
  };

  const broadcasts: BroadcastEvent[] = [];
  const enqueued: ProgrammaticTurn[] = [];

  const host: BackendHost = {
    broadcast: (event) => { broadcasts.push(event); },
    enqueueTurn: async (i) => {
      enqueued.push(i);

      return { status: 'queued' };
    },
    turnInFlight: () => false,
    setTimer: () => {},
  };

  const eventDb = new Database(':memory:');
  const eventSql: SqlExec = makeSqlExec(eventDb);
  initEventsHubTables(eventSql);
  const eventActor = createTestActorsOver(eventDb).main;
  const orch = new AgentOrchestrator({ host, engine, eventLog: new EventLog(eventSql, eventActor) });

  return { orch, recorded };
}

const settledTurn = (over: Partial<CompletedTurn> = {}): CompletedTurn => ({
  userMessage: 'q', assistantResponse: 'a', toolCalls: [], durationMs: 1, steps: 1,
  hadError: false, feedback: null, turnId: 'm1', origin: 'programmatic', ...over,
});

describe('the settled turn’s recording — every settled turn is recorded', () => {
  /** The rows a settled turn owes for the status under test (`turn_record`, `turn_end_extensions`). */
  const roster = (status: RunEndReason, over: Partial<Parameters<typeof declareTerminalRoster>[0]> = {}) =>
    declareTerminalRoster({
      messageId: 'm1', status, workMode: 'build', continuity: 'independent_task',
      completed: status === 'completed', userText: 'q', assistantText: 'a',
      scopedTurn: {}, recordedAt: 1, evolutionEnabled: true, ...over,
    }, { turnEndExtensions: true });

  // Failed turns are evidence: every status must reach the outcome-review buffer and the session
  // cadence, or evolution grades successes against successes.
  for (const status of ['error', 'aborted'] as const) {
    test(`an ${status === 'error' ? 'errored' : status} turn is recorded`, () => {
      const { orch, recorded } = seamOrchestrator();

      orch.recordTurn(orch.recordedTurn(status, settledTurn()), 'independent_task');
      expect(recorded).toHaveLength(1);
    });
  }

  test('a FAILED turn still owes its extension end, and owes it before the recording', () => {
    // Recorded after the hook, since its effects are part of the turn the review reads. Both rows are
    // owed on every status.
    for (const status of RUN_END_REASONS) {
      const owed = roster(status).map((effect) => effect.name);
      expect(owed).toContain('turn_end_extensions');
      expect(owed.indexOf('turn_record')).toBeGreaterThan(owed.indexOf('turn_end_extensions'));
    }
  });

  // A user Stop is not an agent failure; stamping it an error would feed the outcome classifier an
  // unearned negative label.
  const stamps = [
    { name: 'an errored turn is stamped hadError even when the accumulator missed it',
      status: 'error', hadError: true },
    { name: 'an aborted turn is NOT stamped as an error', status: 'aborted', hadError: false },
  ] as const;

  for (const stamp of stamps) {
    test(stamp.name, () => {
      const { orch, recorded } = seamOrchestrator();

      orch.recordTurn(
        orch.recordedTurn(stamp.status, settledTurn({ hadError: false })), 'independent_task',
      );
      expect(recorded[0]?.hadError).toBe(stamp.hadError);
    });
  }

  test('with evolution off nothing is recorded, and the extension end is still owed', () => {
    const { orch, recorded } = seamOrchestrator({ enabled: false });
    orch.recordTurn(orch.recordedTurn('completed', settledTurn()), 'independent_task');
    expect(recorded).toEqual([]);
    // Extensions are not evolution: `--no-auto-evolve` must not silence the turn-end row.
    expect(roster('completed', { evolutionEnabled: false }).map((effect) => effect.name))
      .toContain('turn_end_extensions');
  });
});

describe('providerSnapshotOf — one formula, deterministic', () => {
  test('input order does not change the revision', () => {
    const a = providerSnapshotOf({ models: ['b/2', 'a/1'], failures: [] });
    const b = providerSnapshotOf({ models: ['a/1', 'b/2'], failures: [] });
    expect(a.revision).toBe(b.revision);
    expect(a.availableModels).toEqual(['a/1', 'b/2']);
  });

  test('duplicates collapse rather than changing the identity', () => {
    const once = providerSnapshotOf({ models: ['a/1'], failures: [] });
    const twice = providerSnapshotOf({ models: ['a/1', 'a/1'], failures: [] });
    expect(twice.availableModels).toEqual(['a/1']);
    expect(twice.revision).toBe(once.revision);
  });

  // A snapshot taken while a provider was down is a different availability picture, so it must not
  // share a revision with a complete one.
  test('a failure changes the revision even with an identical model list', () => {
    const clean = providerSnapshotOf({ models: ['a/1'], failures: [] });
    const degraded = providerSnapshotOf({ models: ['a/1'], failures: [{ provider: 'b', reason: '503' }] });
    expect(degraded.revision).not.toBe(clean.revision);
    expect(degraded.availableModels).toEqual(clean.availableModels);
  });

  test('the failure reason is part of the identity, not just the provider', () => {
    const a = providerSnapshotOf({ models: [], failures: [{ provider: 'b', reason: '503' }] });
    const b = providerSnapshotOf({ models: [], failures: [{ provider: 'b', reason: 'revoked' }] });
    expect(a.revision).not.toBe(b.revision);
  });

  test('a failure sorts stably and falls back to the provider id for its label', () => {
    const snapshot = providerSnapshotOf({ models: [], failures: [
      { provider: 'z', reason: 'r' },
      { provider: 'a', label: 'Ay', reason: 'r' },
    ] });

    expect(snapshot.unavailableProviders).toEqual([
      { provider: 'a', label: 'Ay', reason: 'r' },
      { provider: 'z', label: 'z', reason: 'r' },
    ]);
  });

  // The `!` separator is collision-free only because no real spec starts with `!`; what is pinned is
  // that both halves reach the hash.
  test('both halves reach the revision — models and failures each move it', () => {
    const bare = providerSnapshotOf({ models: ['a/1'], failures: [] });
    const moreModels = providerSnapshotOf({ models: ['a/1', 'a/2'], failures: [] });
    const moreFailures = providerSnapshotOf({ models: ['a/1'], failures: [{ provider: 'b', reason: 'x' }] });
    expect(new Set([bare.revision, moreModels.revision, moreFailures.revision]).size).toBe(3);
  });

  test('a pinned spec moves the revision without being listed, so an unlisted pin cannot serve', () => {
    const listing: ProviderListing = { models: ['a/1'], failures: [] };
    const bare = providerSnapshotOf(listing);
    const pinned = providerSnapshotOf(listing, ['a/retired']);

    expect(pinned.availableModels).toEqual(['a/1']);
    expect(pinned.revision).not.toBe(bare.revision);
    expect(providerSnapshotOf(listing, ['a/other']).revision).not.toBe(pinned.revision);
  });
});

describe('ProviderListingCache — complete listings only, guarded by generation', () => {
  const clean: ProviderListing = { models: ['a/1'], failures: [] };

  test('a complete listing is memoized; the second read is a hit', async () => {
    let sweeps = 0;

    const cache = new ProviderListingCache(async () => {
      sweeps += 1;

      return clean;
    });

    expect((await cache.read()).cache).toBe('miss');
    expect((await cache.read()).cache).toBe('hit');
    expect(sweeps).toBe(1);
  });

  // A non-empty failure set admits every configured model unverified; caching it would hold that
  // window open past the fault.
  test('a degraded listing is returned but never cached', async () => {
    let sweeps = 0;

    const cache = new ProviderListingCache(async () => {
      sweeps += 1;

      return { models: ['a/1'], failures: [{ provider: 'b', reason: '503' }] };
    });

    expect((await cache.read()).cache).toBe('miss');
    expect((await cache.read()).cache).toBe('miss');
    expect(sweeps).toBe(2);
  });

  test('concurrent callers join ONE sweep', async () => {
    let sweeps = 0;
    const gate = Promise.withResolvers<void>();

    const cache = new ProviderListingCache(async () => {
      sweeps += 1;
      await gate.promise;

      return clean;
    });

    const first = cache.read();
    const second = cache.read();
    gate.resolve();
    const [a, b] = await Promise.all([first, second]);
    expect(sweeps).toBe(1);
    expect([a.cache, b.cache]).toEqual(['miss', 'joined']);
  });

  // A credential change mid-sweep must not let the pre-change listing become the cached answer,
  // though the waiting caller still gets it.
  test('a listing whose sweep straddled an invalidation is returned but not cached', async () => {
    let sweeps = 0;
    const gate = Promise.withResolvers<void>();

    const cache = new ProviderListingCache(async () => {
      sweeps += 1;
      await gate.promise;

      return clean;
    });

    const inFlight = cache.read();
    cache.invalidate();
    gate.resolve();
    expect((await inFlight).listing).toEqual(clean);
    expect((await cache.read()).cache).toBe('miss');
    expect(sweeps).toBe(2);
  });

  test('invalidate drops the cached listing so the next read sweeps again', async () => {
    let sweeps = 0;

    const cache = new ProviderListingCache(async () => {
      sweeps += 1;

      return clean;
    });

    await cache.read();
    expect((await cache.read()).cache).toBe('hit');
    cache.invalidate();
    expect((await cache.read()).cache).toBe('miss');
    expect(sweeps).toBe(2);
  });

  test('nothing expires but a signal', async () => {
    // Structural rather than sleeping: a CI-short wait cannot disprove a long TTL.
    let sweeps = 0;

    const cache = new ProviderListingCache(async () => {
      sweeps += 1;

      return clean;
    });

    for (let i = 0; i < 5; i++) await cache.read();
    expect(sweeps).toBe(1);
  });
});

describe('defaultSpecFor — never the first thing in the menu', () => {
  test('a configured choice the account can serve wins', () => {
    expect(defaultSpecFor('paid/x', ['paid/x', DEFAULT_WORKERS_AI_MODEL_SPEC])).toBe('paid/x');
  });

  // A default naming a provider whose key was revoked would fail on its first call.
  test('a configured choice the account cannot serve is refused, not honoured', () => {
    expect(defaultSpecFor('paid/gone', [DEFAULT_WORKERS_AI_MODEL_SPEC]))
      .toBe(DEFAULT_WORKERS_AI_MODEL_SPEC);
  });

  test('with no choice, the native default is the only automatic answer', () => {
    expect(defaultSpecFor(null, ['paid/x', DEFAULT_WORKERS_AI_MODEL_SPEC]))
      .toBe(DEFAULT_WORKERS_AI_MODEL_SPEC);
  });

  // Falling through to menu[0] would silently sign new workspaces up to a paid BYO provider.
  test('never falls through to whatever happened to be first', () => {
    expect(defaultSpecFor(null, ['paid/x', 'paid/y'])).toBeNull();
    expect(defaultSpecFor('', ['paid/x'])).toBeNull();
    expect(defaultSpecFor(undefined, [])).toBeNull();
  });

  test('workersAiSpec qualifies a bare id and is idempotent', () => {
    expect(workersAiSpec('@cf/meta/llama')).toBe('workers-ai/@cf/meta/llama');
    expect(workersAiSpec('workers-ai/@cf/meta/llama')).toBe('workers-ai/@cf/meta/llama');
  });
});

describe('the sandbox contract — one namespace for every tool', () => {
  test('the namespace is `tools`, and a crafted tool without a description is labelled', () => {
    expect(CRAFTED_TOOL_NAMESPACE).toBe('tools');
    expect(craftedToolDescription('summarize')).toBe('Crafted tool: summarize');
    expect(craftedToolDescription('summarize', 'Folds a report')).toBe('Folds a report');
  });

  test('a native tool takes exactly one JSON object through the sandbox', async () => {
    const seen: unknown[] = [];

    const bound = nativeToolFunctions({
      file: tool({
        description: 'The file plane.',
        inputSchema: jsonSchema<{ action: string; path?: string }>({ type: 'object' }),
        execute: async (input) => {
          seen.push(input);

          return { ok: true };
        },
      }),
    });

    const file = bound.file;

    if (!file) throw new Error('file was not bound');
    expect(await file.execute({ action: 'read', path: 'a' })).toEqual({ ok: true });
    expect(await file.execute()).toEqual({ ok: true });
    expect(seen).toEqual([{ action: 'read', path: 'a' }, {}]);
    const refused = await file.execute('a');
    expect(refused).toEqual({ success: false, reason: 'bad_input', error: 'tools.file(input): input must be one JSON object, the same shape the native `file` tool takes' });
    expect(seen).toHaveLength(2);
  });
});

/** The Error a rejected promise threw; a non-Error rejection fails loudly rather than being coerced. */
async function rejectionOf(work: Promise<unknown>): Promise<Error> {
  try {
    await work;
  } catch (err) {
    if (err instanceof Error) return err;
    throw new Error(`expected an Error rejection, got ${String(err)}`, { cause: err });
  }

  throw new Error('expected a rejection, got a resolved value');
}

describe('craft failure attribution — the same marker in both substrates', () => {
  test('a compiled tool failure is stamped with the tool that raised', async () => {
    const wrapped = attributeCraftedFailure('summarize', async () => { throw new Error('boom'); });
    await expect(wrapped()).rejects.toThrow(craftFailureMarker('summarize'));
  });

  test('the original error survives as the cause', async () => {
    const cause = new Error('boom');
    const wrapped = attributeCraftedFailure('summarize', async () => { throw cause; });
    expect((await rejectionOf(wrapped())).cause).toBe(cause);
  });

  test('a success passes straight through', async () => {
    const wrapped = attributeCraftedFailure('double', async (n: number) => n * 2);
    expect(await wrapped(21)).toBe(42);
  });

  // buildCraftedTools is the one attribution point; a substrate that also wraps its own compile makes
  // one failure read as several (`[crafted:x] [crafted:x]`).
  test('attribution stamps exactly once, never twice', async () => {
    const wrapped = attributeCraftedFailure('brokenIt', async () => { throw new Error('nope'); });
    const message = (await rejectionOf(wrapped())).message;
    expect(message.split(craftFailureMarker('brokenIt')).length - 1).toBe(1);
  });

  // The codec and the label answer different questions; do not merge them.
  test('the label replaces an empty description; the codec preserves it', () => {
    expect(craftedToolDescription('f', '')).toBe('Crafted tool: f');

    const stored: CraftedTool = {
      name: 'f', description: '', code: 'async () => 1',
      params: null, scope: 'local', createdAt: 0, updatedAt: 0,
    };

    expect(toCraftedToolSource(stored)?.description).toBe('');
  });
});

describe('the declared ids no adapter spells by hand', () => {
  test('the default role is a declared constant', () => {
    expect(DEFAULT_ROLE_ID).toBe('task');
  });

  test('the deps-gated set is derived from the tool id, not a loose string', () => {
    expect(DEPS_GATED_TOOLS).toEqual([REPORT_TOOL]);
    expect(REPORT_TOOL).toBe('report');
  });

  // submit_plan is deliberately not a BuiltinToolName: it exists only on Plan turns whose actor owns
  // the submission boundary.
  test('submit_plan is declared but is not a standing builtin', () => {
    expect(SUBMIT_PLAN_TOOL).toBe('submit_plan');
    expect(DEPS_GATED_TOOLS).not.toContain(SUBMIT_PLAN_TOOL);
  });
});

describe('the post-settle lane verdict is ONE core decision', () => {
  const cases = [
    ['completed', 'build', true],
    ['completed', 'plan', false],
    ['error', 'build', false],
    ['aborted', 'build', false],
  ] as const;

  for (const [status, mode, open] of cases) {
    test(`a ${status} ${mode} turn ${open ? 'opens' : 'closes'} the improvement lanes`, () => {
      const { orch } = seamOrchestrator();
      orch.beginTurn(Date.now(), mode === 'plan' ? { kinuMode: 'plan' } : {});
      // As the `improvement_lanes` row asks: the live mode on the producing activation, the recorded
      // mode on replay.
      expect(orch.improvementLanesOpen(status)).toBe(open);
      expect(orch.improvementLanesOpen(status, mode)).toBe(open);
    });
  }
});

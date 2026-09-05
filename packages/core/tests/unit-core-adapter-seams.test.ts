// The nine core seams that closed measured backend drift (CoreAdapterAudit).
//
// Each block below pins the ONE thing the two backends used to disagree about,
// so a future adapter cannot re-open it silently. Where a test looks trivially
// true, the drift it prevents is named — that is the point of the assertion.

import { describe, test, expect } from 'bun:test';
import { Database } from 'bun:sqlite';
import * as v from 'valibot';
import { jsonSchema, tool, type FinishReason } from 'ai';
import { createRecordingLogger, setDiagnosticsSink } from '../src/obs/index';
import { createTestSql } from '@kinu.run/test-utils';
import {
  EVENT_VARIANTS, type EventVariant,
  buildModelCallEvent, type ModelCallReport,
  classifyRunEnd, RUN_END_REASONS, type RunEndReason,
  TOOL_CALLS_PENDING, TURN_ENDED_MID_WORK,
  declareTerminalRoster,
  AgentOrchestrator, type AgentOrchestratorDeps,
  buildProviderCatalogSnapshot, ProviderListingCache, type ProviderListing,
  defaultSpecFor, DEFAULT_WORKERS_AI_MODEL_SPEC, workersAiSpec,
  DEFAULT_ROLE_ID, REPORT_TOOL, SUBMIT_PLAN_TOOL, DEPS_GATED_TOOLS,
  craftedToolDescription, toCraftedToolSource, type CraftedTool,
  CRAFTED_TOOL_NAMESPACE, renderToolsDeclaration, nativeToolFunctions, jsonSchemaToTs,
  attributeCraftedFailure, craftFailureMarker,
  initCompletedTurnTable, createCompletedTurnStore,
  initEventsHubTables, EventLog,
  type ModelPricing, type CompletedTurn, type SqlExec,
  type BackendHost, type BroadcastEvent, type ProgrammaticTurn,
} from '../src/index';
import { makeSqlExec } from './helpers';

// ── Seam 7: the variant picklist and the type are one declaration ────────────

describe('EVENT_VARIANTS — the array and the type cannot disagree', () => {
  // The drift: one backend mirrored these literals into its own valibot
  // picklist, so a variant added in core compiled here and was silently
  // REFUSED at that route. The array is now the single declaration.
  test('every declared variant is accepted by a picklist built from the array', () => {
    const schema = v.picklist(EVENT_VARIANTS);
    for (const variant of EVENT_VARIANTS) {
      expect(v.parse(schema, variant)).toBe(variant);
    }
    expect(() => v.parse(schema, 'not_a_variant')).toThrow();
  });

  test('the type is derived from the array, both directions', () => {
    // Assignability in BOTH directions is the equality. If the type were ever
    // re-declared by hand, one of these two lines stops compiling — which is
    // the mechanism, so these are deliberately about compilation.
    const fromArray: EventVariant = EVENT_VARIANTS[0];
    const toArray: (typeof EVENT_VARIANTS)[number] = fromArray;
    expect(EVENT_VARIANTS).toContain(toArray);
    // A duplicate would make the picklist and the union quietly disagree about
    // cardinality, which is the shape a careless append produces.
    expect(new Set(EVENT_VARIANTS).size).toBe(EVENT_VARIANTS.length);
  });
});

// ── Seam 2: the model_call usage and pricing policy ──────────────────────────

describe('buildModelCallEvent — usage is always present, pricing is guarded', () => {
  // Per-1M-token rates, which is what priceCall divides by. One million input
  // and one million output tokens therefore cost 1 + 2 = $3.
  const pricing: ModelPricing = { input: 1, output: 2 };
  const report = (over: Partial<ModelCallReport> = {}): ModelCallReport => ({
    source: 'judge', usage: { input: 1_000_000, output: 1_000_000 }, spec: 'openai/gpt-x', ...over,
  });

  // THE ARM THAT DRIFTED. One backend gated `usage` behind usageReported(), so
  // the same silent call had no usage field there and `{}` on the other — and a
  // spend reader could not tell "unmeasured" from "not recorded".
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

  // A judge deliberately runs on a DIFFERENT model from the actor. Pricing it at
  // the actor's rate would invent a number, which is worse than no number.
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

  // An absent spec must not match an absent effective spec — the `undefined ===
  // null` accident this guard is written to avoid.
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

// ── Seam 3: run_end.reason is derived, never chosen ──────────────────────────

describe('classifyRunEnd — a user Stop is aborted on every backend', () => {
  test('a finished turn completes', () => {
    expect(classifyRunEnd({ completed: true, interrupted: false })).toEqual({ reason: 'completed' });
  });

  // THE DRIFT. The identical user action sealed as 'aborted' on one backend and
  // 'error' on the other, so every cross-backend run-ledger reader counted local
  // stops as failures.
  test('an interrupted turn is aborted, never error', () => {
    expect(classifyRunEnd({ completed: false, interrupted: true })).toEqual({ reason: 'aborted' });
  });

  test('an interrupt outranks a completed flag the driver already set', () => {
    // runChat yields `done` and THEN throws the interruption, so both facts can
    // arrive true. The user's Stop is the one that names the run.
    expect(classifyRunEnd({ completed: true, interrupted: true })).toEqual({ reason: 'aborted' });
  });

  // The interruption sentence is the flag beside it, restated. A run sealed
  // 'aborted' that still carries a failure text is the same drift, relabelled.
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

  test('the vocabulary is exactly three values', () => {
    expect([...RUN_END_REASONS]).toEqual(['completed', 'aborted', 'error']);
    const every: readonly RunEndReason[] = RUN_END_REASONS;
    expect(every).toHaveLength(3);
  });
});

// ── R4: a turn must never end with tool calls pending ────────────────────────
//
// THE DEFECT THIS GUARDS. `@cloudflare/think` OR-s `stepCountIs(this.maxSteps)`
// — default 10 — ahead of anything a caller passes, so the cloud loop was hard
// capped: four of four production runs that reached ten steps were cut with the
// model still emitting tool calls, and every one sealed 'completed'.
//
// WHY THE LEDGER GAINED NO WORD FOR IT. The ceiling was the ONLY producer, and
// removing it removes the state — so a fourth reason would have been vocabulary
// no run could carry, plus a dead branch in a union, a valibot mirror, two read
// models, a status dot and an analytics row. What is owed instead is a tripwire
// that fires if any of the facts behind "unreachable" stops being true: a vendor
// release re-introducing a cap, an actor that starts requesting structured
// output, a tool that stops executing server-side.

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
    // A failure with a classification, not a bare event: the state is impossible,
    // so whatever produced it is broken rather than merely notable.
    expect(tripped[0]?.code).toBe('unavailable');
    expect(tripped[0]?.cause).toContain('tool calls pending');
    // And it names the thing to go looking for.
    expect(tripped[0]?.cause).toContain('step ceiling');
  });

  test('the reason it reports is unchanged — the classifier names what the driver saw', () => {
    // The diagnostic is the visibility. Inventing a status here would put a word
    // in the ledger for a state no run can reach.
    const { classified } = classifyWithLog({
      completed: true, interrupted: false, lastFinishReason: TOOL_CALLS_PENDING,
    });
    expect(classified).toEqual({ reason: 'completed' });
  });

  test('a turn whose last step stopped on its own trips nothing', () => {
    // The control. Without it the test above would pass on a tripwire that fired
    // for every turn.
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
    // If the AI SDK renamed this finish reason the tripwire would silently stop
    // firing, which is the failure mode it exists to prevent. `ai`'s union is the
    // source of the string.
    const sdkReason: FinishReason = TOOL_CALLS_PENDING;
    expect(sdkReason).toBe('tool-calls');
  });
});

// ── Seam 4: the settle rule — failed turns are evidence ──────────────────────

function seamOrchestrator(opts?: { enabled?: boolean }) {
  const recorded: CompletedTurn[] = [];
  const { sql, execRaw } = createTestSql();
  initCompletedTurnTable(execRaw);
  const store = createCompletedTurnStore(sql);
  const engine: AgentOrchestratorDeps['engine'] = {
    enabled: opts?.enabled ?? true,
    sessionWindow: store,
    craftLedger: { names: () => [], observe: () => [] },
    reviewTurn: async (turn) => { recorded.push(turn); },
    runStoredTurnReview: async (rowId, turn) => { recorded.push(turn); void rowId; },
    onSessionComplete: async () => {},
    runDueShadowTrials: async () => {},
    recordRecovery: () => {},
    deferTurnReview: () => 'queued',
    // Every turn here has no conversational follow-up coming, so the recording
    // writes its review obligation onto the turn row and this DRAIN is what runs
    // it — the same claim-guarded path production takes. A double that returned
    // an empty drain would make the recording look like it lost the review.
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
    enqueueTurn: async (i) => { enqueued.push(i); return { status: 'queued' }; },
    turnInFlight: () => false,
    setTimer: () => {},
  };
  const eventSql: SqlExec = makeSqlExec(new Database(':memory:'));
  initEventsHubTables(eventSql);
  const orch = new AgentOrchestrator({ host, engine, eventLog: new EventLog(eventSql) });
  return { orch, recorded };
}

const settledTurn = (over: Partial<CompletedTurn> = {}): CompletedTurn => ({
  userMessage: 'q', assistantResponse: 'a', toolCalls: [], durationMs: 1, steps: 1,
  hadError: false, feedback: null, turnId: 'm1', origin: 'programmatic', ...over,
});

describe('the settled turn’s recording — every settled turn is recorded', () => {
  /** The roster a settled turn owes, for the status under test. What the
   *  `turn_record` and `turn_end_extensions` rows are read off. */
  const roster = (status: RunEndReason, over: Partial<Parameters<typeof declareTerminalRoster>[0]> = {}) =>
    declareTerminalRoster({
      messageId: 'm1', status, workMode: 'build', continuity: 'independent_task',
      completed: status === 'completed', userText: 'q', assistantText: 'a',
      scopedTurn: {}, recordedAt: 1, evolutionEnabled: true, ...over,
    }, { turnEndExtensions: { message: {} } });

  // THE DIVERGENCE. One backend early-returned on any status but 'completed', so
  // a failed cloud turn reached neither the outcome-review buffer nor the
  // session cadence — the evolution loop graded successes against successes
  // there and the whole distribution locally.
  test('an errored turn is recorded', () => {
    const { orch, recorded } = seamOrchestrator();
    orch.recordTurn(orch.recordedTurn('error', settledTurn()), 'independent_task');
    expect(recorded).toHaveLength(1);
  });

  test('an aborted turn is recorded', () => {
    const { orch, recorded } = seamOrchestrator();
    orch.recordTurn(orch.recordedTurn('aborted', settledTurn()), 'independent_task');
    expect(recorded).toHaveLength(1);
  });

  test('a FAILED turn still owes its extension end, and owes it before the recording', () => {
    // Recorded AFTER the hook: the hook's effects (memory writes, compaction
    // state) are part of the turn the review then reads. Both rows are owed on
    // every status, which is the half that used to be lost — a failed cloud turn
    // reached neither.
    for (const status of RUN_END_REASONS) {
      const owed = roster(status).map((effect) => effect.name);
      expect(owed).toContain('turn_end_extensions');
      expect(owed.indexOf('turn_record')).toBeGreaterThan(owed.indexOf('turn_end_extensions'));
    }
  });

  test('an errored turn is stamped hadError even when the accumulator missed it', () => {
    // A turn can throw outside the accumulator's view, which is why one backend
    // had to set acc.hadError by hand in its catch.
    const { orch, recorded } = seamOrchestrator();
    orch.recordTurn(
      orch.recordedTurn('error', settledTurn({ hadError: false })), 'independent_task',
    );
    expect(recorded[0]?.hadError).toBe(true);
  });

  // A user pressing Stop did not make the agent fail. Stamping their turn as an
  // error would feed the outcome classifier a negative label nothing earned.
  test('an aborted turn is NOT stamped as an error', () => {
    const { orch, recorded } = seamOrchestrator();
    orch.recordTurn(
      orch.recordedTurn('aborted', settledTurn({ hadError: false })), 'independent_task',
    );
    expect(recorded[0]?.hadError).toBe(false);
  });

  test('with evolution off nothing is recorded, and the extension end is still owed', () => {
    const { orch, recorded } = seamOrchestrator({ enabled: false });
    orch.recordTurn(orch.recordedTurn('completed', settledTurn()), 'independent_task');
    expect(recorded).toEqual([]);
    // Extensions are not evolution: `--no-auto-evolve` must not silence them, so
    // the row that announces the turn's end is owed whatever the gate says.
    expect(roster('completed', { evolutionEnabled: false }).map((effect) => effect.name))
      .toContain('turn_end_extensions');
  });
});

// ── Seam 8: the provider snapshot builder ───────────────────────────────────

describe('buildProviderCatalogSnapshot — one formula, deterministic', () => {
  test('input order does not change the revision', () => {
    const a = buildProviderCatalogSnapshot(['b/2', 'a/1'], []);
    const b = buildProviderCatalogSnapshot(['a/1', 'b/2'], []);
    expect(a.revision).toBe(b.revision);
    expect(a.availableModels).toEqual(['a/1', 'b/2']);
  });

  test('duplicates collapse rather than changing the identity', () => {
    const once = buildProviderCatalogSnapshot(['a/1'], []);
    const twice = buildProviderCatalogSnapshot(['a/1', 'a/1'], []);
    expect(twice.availableModels).toEqual(['a/1']);
    expect(twice.revision).toBe(once.revision);
  });

  // The producer obligation resolve.ts documents: a snapshot taken while a
  // provider was down is a DIFFERENT availability picture, so anything keyed on
  // revision must not serve it as though it were complete.
  test('a failure changes the revision even with an identical model list', () => {
    const clean = buildProviderCatalogSnapshot(['a/1'], []);
    const degraded = buildProviderCatalogSnapshot(['a/1'], [{ provider: 'b', reason: '503' }]);
    expect(degraded.revision).not.toBe(clean.revision);
    expect(degraded.availableModels).toEqual(clean.availableModels);
  });

  test('the failure reason is part of the identity, not just the provider', () => {
    const a = buildProviderCatalogSnapshot([], [{ provider: 'b', reason: '503' }]);
    const b = buildProviderCatalogSnapshot([], [{ provider: 'b', reason: 'revoked' }]);
    expect(a.revision).not.toBe(b.revision);
  });

  test('a failure sorts stably and falls back to the provider id for its label', () => {
    const snapshot = buildProviderCatalogSnapshot([], [
      { provider: 'z', reason: 'r' },
      { provider: 'a', label: 'Ay', reason: 'r' },
    ]);
    expect(snapshot.unavailableProviders).toEqual([
      { provider: 'a', label: 'Ay', reason: 'r' },
      { provider: 'z', label: 'z', reason: 'r' },
    ]);
  });

  // The `!` prefix separates the two halves of the hashed body. Its guarantee is
  // CONDITIONAL on no real model spec beginning with `!`, which holds because a
  // spec is `<provider>/<id>` and a provider id is not punctuation. Feeding the
  // builder a synthetic `'!b\tx'` model DOES collide — asserting otherwise would
  // be asserting a property the code does not have, on an input production
  // cannot produce. What is worth pinning is that both halves reach the hash.
  test('both halves reach the revision — models and failures each move it', () => {
    const bare = buildProviderCatalogSnapshot(['a/1'], []);
    const moreModels = buildProviderCatalogSnapshot(['a/1', 'a/2'], []);
    const moreFailures = buildProviderCatalogSnapshot(['a/1'], [{ provider: 'b', reason: 'x' }]);
    expect(new Set([bare.revision, moreModels.revision, moreFailures.revision]).size).toBe(3);
  });
});

// ── Seam 8: the cache policy ────────────────────────────────────────────────

describe('ProviderListingCache — complete listings only, guarded by generation', () => {
  const clean: ProviderListing = { models: ['a/1'], failures: [] };

  test('a complete listing is memoized; the second read is a hit', async () => {
    let sweeps = 0;
    const cache = new ProviderListingCache(async () => { sweeps += 1; return clean; });
    expect((await cache.read()).cache).toBe('miss');
    expect((await cache.read()).cache).toBe('hit');
    expect(sweeps).toBe(1);
  });

  // A non-empty failure set admits every configured model unverified. Caching
  // one would hold that window open past the fault it came from.
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
    const cache = new ProviderListingCache(async () => { sweeps += 1; await gate.promise; return clean; });
    const first = cache.read();
    const second = cache.read();
    gate.resolve();
    const [a, b] = await Promise.all([first, second]);
    expect(sweeps).toBe(1);
    expect([a.cache, b.cache]).toEqual(['miss', 'joined']);
  });

  // THE GENERATION GUARD. A credential change landing mid-sweep must not let a
  // listing of the world BEFORE the change become the answer for every
  // resolution after it — while still being returned to the caller waiting on it.
  test('a listing whose sweep straddled an invalidation is returned but not cached', async () => {
    let sweeps = 0;
    const gate = Promise.withResolvers<void>();
    const cache = new ProviderListingCache(async () => { sweeps += 1; await gate.promise; return clean; });
    const inFlight = cache.read();
    cache.invalidate();
    gate.resolve();
    expect((await inFlight).listing).toEqual(clean);
    expect((await cache.read()).cache).toBe('miss');
    expect(sweeps).toBe(2);
  });

  test('invalidate drops the cached listing so the next read sweeps again', async () => {
    let sweeps = 0;
    const cache = new ProviderListingCache(async () => { sweeps += 1; return clean; });
    await cache.read();
    expect((await cache.read()).cache).toBe('hit');
    cache.invalidate();
    expect((await cache.read()).cache).toBe('miss');
    expect(sweeps).toBe(2);
  });

  test('nothing expires but a signal', async () => {
    // Asserted structurally rather than by sleeping: a wall-clock wait short
    // enough for CI cannot disprove a long TTL, so it would be a test that
    // passes for the wrong reason. Repeated reads with no invalidation between
    // them is the observable form of "only a signal expires this".
    let sweeps = 0;
    const cache = new ProviderListingCache(async () => { sweeps += 1; return clean; });
    for (let i = 0; i < 5; i++) await cache.read();
    expect(sweeps).toBe(1);
  });
});

// ── Seam 9: the default-model rule ──────────────────────────────────────────

describe('defaultSpecFor — never the first thing in the menu', () => {
  test('a configured choice the account can serve wins', () => {
    expect(defaultSpecFor('paid/x', ['paid/x', DEFAULT_WORKERS_AI_MODEL_SPEC])).toBe('paid/x');
  });

  // A stored default naming a provider whose key was revoked is not an answer,
  // it is a turn that fails on its first call.
  test('a configured choice the account cannot serve is refused, not honoured', () => {
    expect(defaultSpecFor('paid/gone', [DEFAULT_WORKERS_AI_MODEL_SPEC]))
      .toBe(DEFAULT_WORKERS_AI_MODEL_SPEC);
  });

  test('with no choice, the native default is the only automatic answer', () => {
    expect(defaultSpecFor(null, ['paid/x', DEFAULT_WORKERS_AI_MODEL_SPEC]))
      .toBe(DEFAULT_WORKERS_AI_MODEL_SPEC);
  });

  // THE PINNED REGRESSION: falling through to menu[0] silently signed new
  // workspaces up to a paid BYO provider.
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

// ── Seam 1: the sandbox contract ────────────────────────────────────────────

describe('the sandbox contract — one namespace for every tool', () => {
  test('the namespace is `tools`, and a crafted tool without a description is labelled', () => {
    expect(CRAFTED_TOOL_NAMESPACE).toBe('tools');
    expect(craftedToolDescription('summarize')).toBe('Crafted tool: summarize');
    expect(craftedToolDescription('summarize', 'Folds a report')).toBe('Folds a report');
  });

  test('the declaration lists native tools with their input type, then crafted tools', () => {
    const native = {
      file: tool({
        description: 'The file plane: read | edit | write.\nMore doctrine.',
        inputSchema: jsonSchema<{ action: string; path: string }>({
          type: 'object',
          properties: {
            action: { type: 'string', enum: ['read', 'edit', 'write'] },
            path: { type: 'string', description: 'A workspace path.' },
          },
          required: ['action', 'path'],
        }),
        execute: async () => 'x',
      }),
    };
    const rendered = renderToolsDeclaration(native, [{ name: 'summarize', description: 'Folds a report' }]);
    expect(rendered).toContain('export declare const tools: {');
    expect(rendered).toContain('file(input: { action: "read" | "edit" | "write"; /** A workspace path. */ path: string }): Promise<unknown>;');
    expect(rendered).toContain('/** The file plane: read | edit | write. Same input as the native `file` tool. */');
    expect(rendered).toContain('/** Folds a report (crafted by you) */');
    expect(rendered).toContain('summarize(...args: unknown[]): Promise<unknown>;');
  });

  test('a native tool takes exactly one JSON object through the sandbox', async () => {
    const seen: unknown[] = [];
    const bound = nativeToolFunctions({
      file: tool({
        description: 'The file plane.',
        inputSchema: jsonSchema<{ action: string; path?: string }>({ type: 'object' }),
        execute: async (input) => { seen.push(input); return { ok: true }; },
      }),
    });
    const file = bound.file;
    if (!file) throw new Error('file was not bound');
    expect(await file.execute({ action: 'read', path: 'a' })).toEqual({ ok: true });
    expect(await file.execute()).toEqual({ ok: true });
    expect(seen).toEqual([{ action: 'read', path: 'a' }, {}]);
    const refused = await file.execute('a');
    expect(refused).toEqual({ error: expect.stringContaining('tools.file(input): input must be one JSON object') });
    expect(seen).toHaveLength(2);
  });

  test('a schema this renderer cannot read renders as unknown, never throws', () => {
    expect(jsonSchemaToTs(undefined)).toBe('unknown');
    expect(jsonSchemaToTs({ type: 'array', items: { type: 'number' } })).toBe('number[]');
    expect(jsonSchemaToTs({ anyOf: [{ type: 'string' }, { type: 'null' }] })).toBe('string | null');
  });
});

// ── Seam 6: craft failure attribution in both substrates ────────────────────

/** The Error a rejected promise threw, narrowed once here so no test has to
 *  assert its way past an `unknown`. A non-Error rejection fails loudly rather
 *  than being coerced into one. */
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

  // THE HAZARD A SECOND WRAPPER CREATES. buildCraftedTools is the ONE runtime
  // attribution point on every backend, and blame matches on the marker — so a
  // substrate that wrapped its own compile as well would make one failure read
  // as several, which is strictly worse than the missing stamp it was meant to
  // fix. Found when a cutover added exactly that and saw `[crafted:x] [crafted:x]`.
  test('attribution stamps exactly once, never twice', async () => {
    const wrapped = attributeCraftedFailure('brokenIt', async () => { throw new Error('nope'); });
    const message = (await rejectionOf(wrapped())).message;
    expect(message.split(craftFailureMarker('brokenIt')).length - 1).toBe(1);
  });

  // The codec and the label answer different questions, and the codec's
  // losslessness is pinned. Kept beside each other so a future reader does not
  // "simplify" them back into one.
  test('the label replaces an empty description; the codec preserves it', () => {
    expect(craftedToolDescription('f', '')).toBe('Crafted tool: f');
    const stored: CraftedTool = {
      name: 'f', description: '', code: 'async () => 1',
      params: null, scope: 'local', createdAt: 0, updatedAt: 0,
    };
    expect(toCraftedToolSource(stored)?.description).toBe('');
  });
});

// ── Seam 7: the remaining literal mirrors ───────────────────────────────────

describe('the declared ids the adapters used to spell by hand', () => {
  test('the default role is a declared constant', () => {
    expect(DEFAULT_ROLE_ID).toBe('general');
  });

  test('the deps-gated set is derived from the tool id, not a loose string', () => {
    expect(DEPS_GATED_TOOLS).toEqual([REPORT_TOOL]);
    expect(REPORT_TOOL).toBe('report');
  });

  // submit_plan is deliberately NOT a BuiltinToolName: it exists only on a Plan
  // turn whose actor owns the submission boundary, so it never joins the
  // standing surface.
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
      // Asked exactly as the `improvement_lanes` row's body asks it: the live
      // turn's mode when the row is running on the activation that produced it,
      // and the RECORDED mode on a replay.
      expect(orch.improvementLanesOpen(status)).toBe(open);
      expect(orch.improvementLanesOpen(status, mode)).toBe(open);
    });
  }
});

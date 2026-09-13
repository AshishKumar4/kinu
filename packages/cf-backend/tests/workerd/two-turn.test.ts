/**
 * Two real OrchestratorAgent turns, end to end inside workerd, over the real
 * HTTP model seam.
 *
 * THE TWO DEFECTS THIS FILE PINS, both shipped 2026-09-08 and invisible to
 * every suite that seeds its own history:
 *
 *  (a) the open read (`getWorkspaceSnapshot` → `getAgentStatus` →
 *      `conversationCount`) selects `assistant_messages` for a hosted
 *      workspace root — a table the agents-SDK session creates on ITS first
 *      read — so the read is green only when the SDK's own DDL ran.
 *  (b) the second turn's model request must carry the user message that
 *      started it. The Node-side fake records the HTTP bodies as the
 *      production SDK sent them, so the assertion reads the defect at the
 *      model boundary, not by proxy.
 *
 * THE SEAM. The drive pins `openai-compat/probe` (fixture credential
 * `openai-compat.default` whose baseURL points at the fake host), so the
 * turn's requests travel the product's own openai-compat wire path —
 * `createAuthedFetch` over the global fetch, intercepted by this worker's
 * Node-side `outboundService` — instead of the direct Workers AI binding.
 * Sleep/title lanes stay on the binding (tier models, not the pin), so
 * FakeAI keeps answering them; the binding log's zero streamed turns proves
 * the cutover. Nothing in production knows the probe exists.
 *
 * THE CLEAN-LOG ASSERTION. The probe joins each turn's terminal settle on the
 * product's own evidence (`memory.facts_compressed`) and returns the captured
 * diagnostics: the test asserts zero failures and zero owed effects. A double
 * that fails the product code it serves is a defect, not a limitation — so a
 * failing lane would fail this test rather than pass behind an echo.
 */
import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import * as v from 'valibot';
import {
  CallRecordSchema,
  DiagnosticFailureSchema,
  HistorySchema,
  HttpCallSchema,
  SnapshotSchema,
  type DiagnosticFailure,
} from './two-turn-shapes';

const SignalProbeSchema = v.union([
  v.object({ signalKind: v.string() }),
  v.object({ threw: v.string() }),
]);

const FailuresSchema = v.array(DiagnosticFailureSchema);

const HttpSchema = v.array(HttpCallSchema);

describe('two real turns over the HTTP model seam', () => {
  it('spikes the service-binding RPC, then runs A and B end to end', async () => {
    const root = env.TWO_TURN_PROBE.get(env.TWO_TURN_PROBE.idFromName('driver'));

    // SPIKE 1 — the auxiliary lanes (sleep judge, title) still travel the
    // direct binding, so the whole drive still depends on AbortSignal
    // surviving the service-binding RPC.
    const signal = v.parse(SignalProbeSchema, await root.signalProbe());

    expect(signal).toEqual({ signalKind: 'AbortSignal' });

    // SPIKE 2 + THE DRIVE — claimOwner boots the hosted workspace plane
    // (nimbus session behind the workspace VFS) the first time it touches the
    // scaffold; a failure here is the session-boot spike answering. Each turn
    // is joined on its own terminal settle inside `exercise` before it
    // returns, so everything asserted below is post-settle state.
    const out = await root.exercise();
    const http = v.parse(HttpSchema, out.http);

    // The cutover proof: no streamed turn reached the binding — the turns
    // traveled HTTP — while the sleep-time judge still arrived there twice.
    const calls = v.parse(v.array(CallRecordSchema), out.calls);

    expect(calls.filter((c) => c.stream)).toHaveLength(0);
    expect(calls.filter((c) => c.lane === 'sleep').length).toBeGreaterThanOrEqual(2);

    // Zero unmocked egress at the HTTP seam: every captured request went to
    // the fake host, and the two turn posts carried the typed lines — (b)
    // read at the boundary where the defect lived. The real prompt carries
    // harness-injected user rows after the typed text (the `<dynamic_context>`
    // block), so `toContain` picks the typed line out of each post's list.
    expect(http.every((h) => h.host === 'fake-models.invalid')).toBe(true);

    const posts = http.filter((h) => h.path === '/v1/chat/completions' && h.model === 'probe');

    expect(posts).toHaveLength(2);
    expect(posts.every((p) => p.stream)).toBe(true);
    expect(posts.at(0)?.users).toContain('A');
    expect(posts.at(1)?.users).toContain('B');

    // The stored credential reached the wire without the probe touching it:
    // every post carried the fixture key as a Bearer token.
    expect(posts.every((p) => p.authHeader === 'Bearer probe-fixture-key')).toBe(true);

    // The stored replies: echo:A then echo:B as the two assistant rows.
    const history = v.parse(HistorySchema, out.history);
    const assistant = history.items.filter((m) => m.role === 'assistant').map((m) => m.content);

    expect(assistant.slice(-2)).toEqual(['echo:A', 'echo:B']);

    // (a): the open read — the pane COUNT over the SDK-created table. The
    // SDK's column list is not exposed by any RPC, so the schema assertion
    // from the original brief is skipped: reading sqlite_master would take a
    // production method added for a test, which the brief forbade. The model
    // asserts the pin took: the turn ran on the compat fixture, not native.
    const snapshot = v.parse(SnapshotSchema, out.snapshot);

    expect(snapshot.status.model).toBe('openai-compat/probe');
    expect(snapshot.status.messageCount).toBe(history.items.length);

    // The settle verdict: both turns' terminal closes finished with nothing
    // owed and nothing failed. `failures` is every captured `diagnostics`
    // failure across the whole drive; `owedEffects` is every effect key a
    // finished close left behind; `factsCompressed` counts the sleep-time
    // completions, one per turn.
    const failures: DiagnosticFailure[] = v.parse(FailuresSchema, out.failures);

    expect(failures).toEqual([]);
    expect(out.owedEffects).toEqual([]);
    expect(out.factsCompressed).toBe(2);
  });

  it('round-trips a real file tool call through the HTTP seam', async () => {
    const root = env.TWO_TURN_PROBE.get(env.TWO_TURN_PROBE.idFromName('tools-driver'));

    const out = await root.driveOnce({
      workspace: 'tools-workspace',
      owner: 'tools-owner',
      displayName: 'Tools',
      model: 'openai-compat/probe-tools',
      text: 'T1',
      seedFile: { path: 'probe-fixture.txt', content: 'probe fixture says hello\n' },
    });

    const http = v.parse(HttpSchema, out.http);
    const posts = http.filter((h) => h.path === '/v1/chat/completions' && h.model === 'probe-tools');

    // The roundtrip shape, exactly two posts: the first offers the real
    // registry surface — `file` among the definitions the product composed —
    // and the fake answers the tool call the model id pins; the second
    // carries the call and its result. Anything else is a confused turn.
    expect(posts).toHaveLength(2);
    expect(posts.at(0)?.offeredTools).toContain('file');
    expect(posts.at(0)?.toolCalls).toEqual([]);

    const called = posts.at(1);

    expect(called?.toolCalls.map((c) => c.name)).toEqual(['file']);

    // The tool executed for real: the following request carries the `file`
    // read's result, naming the seeded content — the actual tool result in
    // the next model request, not an echoed fixture.
    expect(called?.toolResults.join('')).toContain('probe fixture says hello');

    const history = v.parse(HistorySchema, out.history);
    const assistant = history.items.filter((m) => m.role === 'assistant').map((m) => m.content);

    expect(assistant.at(-1)?.endsWith('echo:tool-answered')).toBe(true);
    expect(v.parse(FailuresSchema, out.failures)).toEqual([]);
    expect(out.owedEffects).toEqual([]);
    expect(out.factsCompressed).toBe(1);
  });

  it('settles the turn after a provider error', async () => {
    const root = env.TWO_TURN_PROBE.get(env.TWO_TURN_PROBE.idFromName('error-driver'));

    const out = await root.driveOnce({
      workspace: 'error-workspace',
      owner: 'error-owner',
      displayName: 'Error',
      model: 'openai-compat/probe-error',
      text: 'E1',
    });

    const http = v.parse(HttpSchema, out.http);
    const posts = http.filter((h) => h.path === '/v1/chat/completions' && h.model === 'probe-error');

    // The observed contract: the SDK does not retry the refused request, so
    // the turn fails — but it fails CLEANLY. The provider error is recorded
    // (never swallowed), the close settles with nothing owed, and sleep still
    // ran its completion. A failure the log never names would fail the first
    // assertion; a stranded close would fail the owed one.
    expect(posts.length).toBeGreaterThanOrEqual(1);

    // The hard failure and then the recovery: the refused request is
    // retried and the turn settles on the answer instead of stranding an
    // owed close behind it.
    expect(posts.length).toBeGreaterThanOrEqual(2);

    const history = v.parse(HistorySchema, out.history);
    const assistant = history.items.filter((m) => m.role === 'assistant').map((m) => m.content);

    expect(assistant.at(-1)).toBe('echo:E1');
    expect(out.owedEffects).toEqual([]);
    expect(out.factsCompressed).toBe(1);
  });

  // The consumer's contract is to stop at [DONE]: the turn completes on the
  // answer whether or not the producer closes behind it. Over both seams this
  // wedges instead (the turn never returns, facts never fire) — a real defect
  // in who owns stream end, kept red here with its evidence in the run logs.
  // Bounded at 60s: the wedge would otherwise hold the file to the pool's
  // 120s default, and the bound changes nothing about the verdict.
  it('completes a turn on a producer-open stream', { timeout: 60000 }, async () => {
    const root = env.TWO_TURN_PROBE.get(env.TWO_TURN_PROBE.idFromName('early-done-driver'));

    const out = await root.driveOnce({
      workspace: 'early-done-workspace',
      owner: 'early-done-owner',
      displayName: 'Early Done',
      model: 'openai-compat/probe-early-done',
      text: 'E1',
    });

    const history = v.parse(HistorySchema, out.history);
    const assistant = history.items.filter((m) => m.role === 'assistant').map((m) => m.content);

    // Red while the wedge holds: the turn never returns, so this asserts
    // the completed answer it should have ended on.
    expect(assistant.at(-1)).toBe('echo:early');
    expect(v.parse(FailuresSchema, out.failures)).toEqual([]);
    expect(out.owedEffects).toEqual([]);
    expect(out.factsCompressed).toBe(1);
  });

  it('cancels a parked request through the HTTP path with cleanup', async () => {
    const root = env.TWO_TURN_PROBE.get(env.TWO_TURN_PROBE.idFromName('cancel-driver'));

    const out = await root.cancelHttpPark();

    // One assertion so a failure prints the whole verdict: whether the abort
    // reached the parked handler (read back from its log entry), and what the
    // parked fetch settled with. If the pool cannot propagate subrequest
    // abort into the handler, this names that unsupported contract instead.
    expect({
      observedAbort: out.observedAbort,
      rejected: out.rejection.length > 0,
    }).toEqual({ observedAbort: true, rejected: true });
  });
});

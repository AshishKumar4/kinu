/**
 * Two real OrchestratorAgent turns, end to end inside workerd.
 *
 * THE TWO DEFECTS THIS FILE PINS, both shipped 2026-09-08 and invisible to
 * every suite that seeds its own history:
 *
 *  (a) the open read (`getWorkspaceSnapshot` → `getAgentStatus` →
 *      `conversationCount`) selects `assistant_messages` for a hosted
 *      workspace root — a table the agents-SDK session creates on ITS first
 *      read — so the read is green only when the SDK's own DDL ran.
 *  (b) the second turn's model request must carry the user message that
 *      started it. The FakeAI service binding records `inputs.messages` as
 *      the production adapter sent them, so the assertion reads the defect at
 *      the model boundary, not by proxy.
 *
 * THE CLEAN-LOG ASSERTION. The probe joins each turn's terminal settle on the
 * product's own evidence (`memory.facts_compressed`) and returns the captured
 * diagnostics: the test asserts zero failures and zero owed effects. A double
 * that fails the product code it serves is a defect, not a limitation — so a
 * failing lane would fail this test rather than pass behind an echo.
 *
 * The model seam is `env.AI` bound to this worker's own `WorkerEntrypoint`
 * (`two-turn-probe.ts` carries the reasoning); nothing in production knows
 * the probe exists.
 */
import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import * as v from 'valibot';
import {
  CallRecordSchema,
  DiagnosticFailureSchema,
  HistorySchema,
  SnapshotSchema,
  type DiagnosticFailure,
} from './two-turn-shapes';

const SignalProbeSchema = v.union([
  v.object({ signalKind: v.string() }),
  v.object({ threw: v.string() }),
]);

const FailuresSchema = v.array(DiagnosticFailureSchema);

describe('two real turns over the direct Workers AI seam', () => {
  it('spikes the service-binding RPC, then runs A and B end to end', async () => {
    const root = env.TWO_TURN_PROBE.get(env.TWO_TURN_PROBE.idFromName('driver'));

    // SPIKE 1 — the adapter passes `request.signal` unconditionally, so the
    // whole seam depends on AbortSignal surviving the service-binding RPC.
    // A throw here means the fallback (outboundService SSE intercept) owns
    // this test's transport instead.
    const signal = v.parse(SignalProbeSchema, await root.signalProbe());

    expect(signal).toEqual({ signalKind: 'AbortSignal' });

    // SPIKE 2 + THE DRIVE — claimOwner boots the hosted workspace plane
    // (nimbus session behind the workspace VFS) the first time it touches the
    // scaffold; a failure here is the session-boot spike answering. Each turn
    // is joined on its own terminal settle inside `exercise` before it
    // returns, so everything asserted below is post-settle state.
    const out = await root.exercise();

    // Turn one's request carried 'A'; turn two's carried 'B' — (b) read at
    // the boundary where the defect lived. The real prompt carries
    // harness-injected user rows after the typed text (the `<dynamic_context>`
    // block), so `stream: true` picks the turns and `toContain` picks the
    // typed line out of each turn's user list.
    const calls = v.parse(v.array(CallRecordSchema), out.calls);
    const turns = calls.filter((c) => c.stream);
    const lanes = calls.map((c) => c.lane);

    // Zero unmocked egress at the binding seam: every request the product made
    // is a known lane — the two streamed turns plus the completion lanes
    // (sleep-time judge every turn; the title suggest whenever the naming
    // policy asks). An unknown shape throws inside the fake instead of
    // passing, so anything recorded here was answered, not just seen.
    expect(turns).toHaveLength(2);
    expect(lanes.filter((l) => l === 'sleep').length).toBeGreaterThanOrEqual(2);
    expect(turns.at(-2)?.users).toContain('A');
    expect(turns.at(-1)?.users).toContain('B');
    // The stored replies: echo:A then echo:B as the two assistant rows.
    const history = v.parse(HistorySchema, out.history);
    const assistant = history.items.filter((m) => m.role === 'assistant').map((m) => m.content);

    expect(assistant.slice(-2)).toEqual(['echo:A', 'echo:B']);

    // (a): the open read — the pane COUNT over the SDK-created table. The
    // SDK's column list is not exposed by any RPC, so the schema assertion
    // from the original brief is skipped: reading sqlite_master would take a
    // production method added for a test, which the brief forbade.
    const snapshot = v.parse(SnapshotSchema, out.snapshot);

    expect(snapshot.status.model).toMatch(/^workers-ai\//);
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

  // Lifecycle repros for the per-turn workerd "hung" kills (run logs under
  // kinu-logs/two-turn): the main drive above hangs twice per run with a
  // clean log. These discriminate WHERE: a producer-open pipe versus a clean
  // EOF, and caller cancellation through the binding.
  it('completes a turn on a producer-open stream', async () => {
    const root = env.TWO_TURN_PROBE.get(env.TWO_TURN_PROBE.idFromName('early-done-driver'));

    const out = await root.driveOnce({
      workspace: 'early-done-workspace',
      owner: 'early-done-owner',
      displayName: 'Early Done',
      model: 'workers-ai/@cf/zai-org/glm-5.3',
      text: 'E1',
    });

    const calls = v.parse(v.array(CallRecordSchema), out.calls)
      .filter((c) => c.model.includes('glm-5.3'));

    const history = v.parse(HistorySchema, out.history);
    const assistant = history.items.filter((m) => m.role === 'assistant').map((m) => m.content);

    // The turn still completes: the consumer stops at [DONE] whether or not
    // the producer closes behind it. The hang comparison happens in the run
    // log, not here — this test proves the variant drives a real turn.
    expect(calls.filter((c) => c.stream)).toHaveLength(1);
    expect(assistant.at(-1)).toBe('echo:early');
    expect(v.parse(FailuresSchema, out.failures)).toEqual([]);
    expect(out.owedEffects).toEqual([]);
    expect(out.factsCompressed).toBe(1);
  });

  it('cancels a pending request through the binding with listener cleanup', async () => {
    const root = env.TWO_TURN_PROBE.get(env.TWO_TURN_PROBE.idFromName('cancel-driver'));

    const out = await root.cancelProbe();

    // One assertion so a failure prints the whole verdict: whether the abort
    // reached the callee, whether the listener was removed, and what the
    // parked call settled with.
    expect({
      observedAbort: out.observedAbort,
      activeListeners: out.activeListeners,
      rejected: out.rejection.length > 0,
    }).toEqual({ observedAbort: true, activeListeners: 0, rejected: true });
  });
});

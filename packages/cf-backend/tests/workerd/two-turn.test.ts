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
 * The model seam is `env.AI` bound to this worker's own `WorkerEntrypoint`
 * (`two-turn-probe.ts` carries the reasoning); nothing in production knows
 * the probe exists.
 */
import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import * as v from 'valibot';

const SnapshotSchema = v.looseObject({
  status: v.looseObject({
    messageCount: v.number(),
    model: v.string(),
  }),
});

const HistorySchema = v.looseObject({
  status: v.picklist(['more', 'end']),
  items: v.array(v.looseObject({ role: v.string(), content: v.string() })),
});

const CallSchema = v.object({
  model: v.string(),
  users: v.array(v.string()),
  signalKind: v.string(),
  stream: v.boolean(),
});

const SignalProbeSchema = v.union([
  v.object({ signalKind: v.string() }),
  v.object({ threw: v.string() }),
]);

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
    // scaffold; a failure here is the session-boot spike answering.
    const out = await root.exercise();
    // Turn one's request carried 'A'; turn two's carried 'B' — (b) read at
    // the boundary where the defect lived. Non-turn lanes (fact compression,
    // reflections) also reach this binding, and the real prompt carries
    // harness-injected user rows after the typed text (the `<dynamic_context>`
    // block), so `stream: true` picks the turns and `toContain` picks the
    // typed line out of each turn's user list.
    const calls = v.parse(v.array(CallSchema), out.calls);
    const turns = calls.filter((c) => c.stream);

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
  });
});

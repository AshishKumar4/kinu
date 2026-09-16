/**
 * A background job's wake reaches the model, on the loop, when the job
 * settles while the interactive turn still owns the session.
 *
 * THE DEFECT, measured live on the deployed build (kinu-logs/bgjob-wake): a
 * `run` detached at 30 s and its process exited one second BEFORE the turn's
 * reply step; `runner.wake()` asked for a turn and was answered 'queued' —
 * and the admission parked in Think's TurnQueue behind the running turn with
 * nothing re-driving it once that turn closed. `publishWakeRetry` arms only
 * on enqueue REJECTION, so the woken turn never ran and the owner never got
 * the job's result.
 *
 * On the loop 'queued' means the pump runs it next: an admission that arrives
 * while a turn is running or settling is accepted at admission and taken up
 * as soon as the turn ends. The drive holds one window open (the reply step,
 * in the fake; or the settle, at the probe's turn-end hook) until the job row
 * says settled, releases it, and asks whether the woken turn reached its
 * reply.
 *
 * Real: the `run` tool's schema and background wrap, the runner's detach and
 * settle, the wake signal, the loop's admission and pump, the transcript and
 * the run ledger. Scripted: the model, and the command's body (a sleeper that
 * prints the marker, since no container is bound here).
 */
import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import * as v from 'valibot';
import { WAKE_MARKER as MARKER, WakeDriveResultSchema, type WakeHoldPlacement } from '../two-turn-shapes';

describe('a background job settling while the interactive turn still owns the session wakes a turn that reaches the model', () => {
  const cases: ReadonlyArray<{ where: WakeHoldPlacement; window: string }> = [
    { where: 'reply', window: 'inside the running turn\'s reply step (the live incident\'s window)' },
    { where: 'settle', window: 'inside the just-closed turn\'s settle' },
  ];

  it.each(cases)('$window: the woken run opens for the runner\'s message, reads the job, and replies with its output', { timeout: 240_000 }, async ({ where }) => {
    const root = env.TWO_TURN_PROBE.get(env.TWO_TURN_PROBE.idFromName(`wake-driver-${where}`));
    const drive = v.parse(WakeDriveResultSchema, await root.backgroundWakeConversation(where));

    // The job: one `run`, detached, settled with the marker as its result.
    expect(drive.rows.jobs).toHaveLength(1);
    const job = drive.rows.jobs[0];
    expect(job).toMatchObject({ kind: 'run', status: 'completed' });
    expect(job?.result).toContain(MARKER);

    // The window WAS held when it settled: the drive released the held party
    // only after the job row said so.
    expect(drive.settledAt).toBeLessThanOrEqual(drive.releasedAt);

    // The woken run: opened for the runner's own message naming the job,
    // and closed by its reply — not parked, not skipped.
    const woken = drive.rows.runs.filter((run) => run.userMessage.includes(`Background run job ${job?.id ?? ''}`));
    expect(woken).toHaveLength(1);
    expect(woken[0]?.reason).toBe('completed');

    // It reached the model: the wake lane was asked with the runner's
    // message, then again with the job's result read through
    // `agent.jobResult`, which is what the reply carries.
    const wakeCalls = drive.calls.filter((call) => call.users.some((line) => line.includes('Background run job')));
    expect(wakeCalls.length).toBeGreaterThanOrEqual(2);
    expect(wakeCalls.at(-1)?.toolResults.some((result) => result.includes(MARKER))).toBe(true);
    expect(drive.rows.assistantTexts.some((text) => text.includes(MARKER))).toBe(true);
  });
});

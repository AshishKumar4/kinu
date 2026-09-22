/**
 * Defect measured live (kinu-logs/bgjob-wake): a background job settled while the turn owned the session, `runner.wake()`
 * got 'queued', and the admission parked in Think's TurnQueue with nothing re-driving it. On the loop, 'queued' must run next.
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

    expect(drive.rows.jobs).toHaveLength(1);
    const job = drive.rows.jobs[0];
    expect(job).toMatchObject({ kind: 'shell', status: 'completed' });
    expect(job?.result).toContain(MARKER);

    // The window was held when the job settled.
    expect(drive.settledAt).toBeLessThanOrEqual(drive.releasedAt);

    // Opened for the runner's message naming the job and closed by its reply, not parked or skipped.
    const woken = drive.rows.runs.filter((run) => run.userMessage.includes(`Background shell job ${job?.id ?? ''}`));
    expect(woken).toHaveLength(1);
    expect(woken[0]?.reason).toBe('completed');

    // The reply carries the job's result read through `agent.jobResult`.
    const wakeCalls = drive.calls.filter((call) => call.users.some((line) => line.includes('Background shell job')));
    expect(wakeCalls.length).toBeGreaterThanOrEqual(2);
    expect(wakeCalls.at(-1)?.toolResults.some((result) => result.includes(MARKER))).toBe(true);
    expect(drive.rows.assistantTexts.some((text) => text.includes(MARKER))).toBe(true);
  });
});

/**
 * A shared app's guest end to end in workerd, through the workspace's own seams (core slates/guest.ts): a visitor's
 * message to a shared board's chat reaches their own guest, never the owner's agent; the guest is told only its app,
 * holds only its one tool, and answers through the reply the visitor's page reads; each visitor has their own; and the
 * owner ending the share retires them, their conversations kept.
 */
import { env } from 'cloudflare:test';
import { expect, it } from 'vitest';
import { GUEST_ANSWER } from '../hire-shapes';

const probe = (workspace: string) => env.HIRE_PROBE.get(env.HIRE_PROBE.idFromName(workspace));

/** Dana's soul for her own agent: no guest is ever told it. */
const OWNER_SOUL = 'Delegate exactly what the owner asks for.';

it("a visitor's message to a shared app's chat reaches their own guest, which knows only the app, and its answer comes back", async () => {
  const workspace = 'guest-board';

  await probe(workspace).setup(workspace, 'hire-root', 'answer');

  const visit = await probe(workspace).guestVisit(workspace, [
    { subject: 'anon:3f2a0000000000000000000000000000', text: 'Which issues are open on the board?' },
    { subject: 'anon:3f2a0000000000000000000000000000', text: 'And which is oldest?' },
    { subject: 'viewer:9c41', text: 'Can I file one?' },
  ]);

  expect(visit.answers).toEqual([GUEST_ANSWER, GUEST_ANSWER, GUEST_ANSWER]);
  // One guest per visitor, kept across their messages.
  expect(visit.guests.map((guest) => [guest.subject, guest.live])).toEqual([['anon:3f2a0000000000000000000000000000', true], ['viewer:9c41', true]]);

  // Every model call that read a visitor's words was a guest's: the owner's own agent was never asked.
  expect(visit.calls.length).toBeGreaterThan(0);
  expect(visit.calls.every((call) => call.tools.length === 1 && call.tools[0] === 'app')).toBe(true);
  expect(visit.calls.some((call) => call.system.includes(OWNER_SOUL))).toBe(false);
  expect(visit.calls.every((call) => call.system.includes('guest assistant'))).toBe(true);

  const after = await probe(workspace).guestShareEnded(workspace);

  expect(after.map((guest) => [guest.subject, guest.live])).toEqual([['anon:3f2a0000000000000000000000000000', false], ['viewer:9c41', false]]);
});

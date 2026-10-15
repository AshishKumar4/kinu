/**
 * A workspace whose storage a release's tables step has not reached is refused, with one message that says so: the
 * history seed and a chat socket answer it instead of running or failing a turn, the platform's wake returns instead of
 * failing, and its export is refused too. The step's own call brings it to this build, and it serves again.
 */
import { env } from 'cloudflare:test';
import { expect, it } from 'vitest';

const REFUSED = "This workspace's storage was made before this release changed its tables";

it('a workspace behind its stamp is refused with one message until the tables step reaches it', async () => {
  const probe = env.STORE_RESET_PROBE.get(env.STORE_RESET_PROBE.idFromName('store-reset'));
  const workspace = 'behind-workspace';

  expect(await probe.plantRefusedWorkspace(workspace)).toContain('the older stamp is planted');
  const seeded = await probe.seed(workspace);

  expect(seeded.status).toBe(503);
  expect(JSON.parse(seeded.body)).toMatchObject({ reason: 'unavailable', success: false });

  // The page shows a failed turn's answer from these frames, so the refusal is seen the moment the tab opens.
  const chat = await probe.chat(workspace);

  expect(JSON.parse(chat.connected)).toMatchObject({ reason: 'unavailable', body: expect.stringContaining(REFUSED) });
  expect(JSON.parse(chat.answered)).toMatchObject({ id: 'refused-send', body: expect.stringContaining(REFUSED) });
  expect(await probe.wake(workspace)).toBe('returned');
  expect(await probe.exported(workspace)).toContain(REFUSED);

  expect(await probe.repaired(workspace)).toBe('behind');
  expect((await probe.seed(workspace)).status).toBe(200);
  expect(await probe.exported(workspace)).toMatch(/^\d+ line\(s\)$/u);
});

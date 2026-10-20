/**
 * A workspace a release left behind repairs itself as it constructs, on workerd's own SQLite, before any call reads it:
 * a stale table is rebuilt keeping its rows, and it serves. One whose rows this build's shape cannot take is refused,
 * with one message that says why: the history seed and a chat socket answer it instead of running or failing a turn,
 * the platform's wake returns instead of failing, and its export is refused too. A workspace nothing has claimed answers
 * the deploy's walk for itself alone.
 */
import { env } from 'cloudflare:test';
import { expect, it } from 'vitest';

const REFUSED = "This workspace's storage could not be brought to this release's tables";

it('a workspace behind its stamp repairs itself as it constructs, keeping its rows, and serves', async () => {
  const probe = env.STORE_RESET_PROBE.get(env.STORE_RESET_PROBE.idFromName('store-repair'));
  const workspace = 'stale-workspace';

  expect(await probe.plantOlderWorkspace(workspace, 'stale')).toContain('the older stamp is planted');
  expect((await probe.seed(workspace)).status).toBe(200);
  expect(await probe.walked(workspace)).toMatchObject({ refused: null });
  expect(await probe.exported(workspace)).toMatch(/^\d+ line\(s\)$/u);
});

it('a workspace whose repair refuses answers every call with one message that says why', async () => {
  const probe = env.STORE_RESET_PROBE.get(env.STORE_RESET_PROBE.idFromName('store-reset'));
  const workspace = 'refusing-workspace';

  expect(await probe.plantOlderWorkspace(workspace, 'refusing')).toContain('the older stamp is planted');
  const seeded = await probe.seed(workspace);

  expect(seeded.status).toBe(503);
  expect(JSON.parse(seeded.body)).toMatchObject({ reason: 'unavailable', success: false });

  // The page shows a failed turn's answer from these frames, so the refusal is seen the moment the tab opens.
  const chat = await probe.chat(workspace);

  expect(JSON.parse(chat.connected)).toMatchObject({ reason: 'unavailable', body: expect.stringContaining(REFUSED) });
  expect(JSON.parse(chat.answered)).toMatchObject({ id: 'refused-send', body: expect.stringContaining('turn_struggles.errors') });
  expect(await probe.wake(workspace)).toBe('returned');
  expect(await probe.exported(workspace)).toContain(REFUSED);
  expect(await probe.walked(workspace)).toMatchObject({ refused: expect.stringContaining('turn_struggles'), agents: [] });
});

it('a reshaped table is rebuilt on a Durable Object keeping its rows, its rowids and the rows that refer to it', async () => {
  const probe = env.STORE_RESET_PROBE.get(env.STORE_RESET_PROBE.idFromName('store-rebuild'));
  const { repair, notes, children } = await probe.rebuilt();

  expect(repair).toEqual({ rebuilt: ['notes', 'notes_children'], refused: null });
  expect(notes).toEqual([{ r: 7, id: 'a', body: 'kept' }]);
  expect(children).toEqual([{ id: 'c', note: 'a' }]);
});

it('a workspace nothing has claimed answers the walk for itself, with no agents', async () => {
  const probe = env.STORE_RESET_PROBE.get(env.STORE_RESET_PROBE.idFromName('store-unborn'));

  expect(await probe.walked('never-claimed')).toEqual({ rebuilt: [], refused: null, agents: [] });
});

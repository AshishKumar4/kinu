/**
 * A workspace a release left behind resets itself as it constructs, on workerd's own SQLite, before any call reads it:
 * a changed table is dropped and made anew empty, and it serves. One whose init cannot run over what it holds (a table
 * holding an index's name) is refused, with one message that says why: the history seed and a chat socket answer it instead of running or failing a turn,
 * the platform's wake returns instead of failing, and its export is refused too. A workspace nothing has claimed answers
 * the deploy's walk for itself alone.
 */
import { env } from 'cloudflare:test';
import { expect, it } from 'vitest';

const REFUSED = "This workspace's storage could not be brought to this release's tables";

it('a workspace behind its stamp resets itself as it constructs, and serves', async () => {
  const probe = env.STORE_RESET_PROBE.get(env.STORE_RESET_PROBE.idFromName('store-repair'));
  const workspace = 'stale-workspace';

  expect(await probe.plantOlderWorkspace(workspace, 'stale')).toContain('the older stamp is planted');
  expect((await probe.seed(workspace)).status).toBe(200);
  expect(await probe.walked(workspace)).toMatchObject({ refused: null, dropped: expect.arrayContaining(['turn_struggles']) });
  expect(await probe.exported(workspace)).toMatch(/^\d+ line\(s\)$/u);
});

it('a workspace whose reset refuses answers every call with one message that says why', async () => {
  const probe = env.STORE_RESET_PROBE.get(env.STORE_RESET_PROBE.idFromName('store-reset'));
  const workspace = 'refusing-workspace';

  expect(await probe.plantOlderWorkspace(workspace, 'refusing')).toContain('the older stamp is planted');
  const seeded = await probe.seed(workspace);

  expect(seeded.status).toBe(503);
  expect(JSON.parse(seeded.body)).toMatchObject({ reason: 'unavailable', success: false });

  // The page shows a failed turn's answer from these frames, so the refusal is seen the moment the tab opens.
  const chat = await probe.chat(workspace);

  expect(JSON.parse(chat.connected)).toMatchObject({ reason: 'unavailable', body: expect.stringContaining(REFUSED) });
  expect(JSON.parse(chat.answered)).toMatchObject({ id: 'refused-send', body: expect.stringContaining('idx_turn_struggles_actor') });
  expect(await probe.wake(workspace)).toBe('returned');
  expect(await probe.exported(workspace)).toContain(REFUSED);
  expect(await probe.walked(workspace)).toMatchObject({ refused: expect.stringContaining('idx_turn_struggles_actor'), agents: [] });
});

it('a changed table is dropped on a Durable Object with what refers to it, and every other table kept byte for byte', async () => {
  const probe = env.STORE_RESET_PROBE.get(env.STORE_RESET_PROBE.idFromName('store-drop'));
  const { repair, rows, keptAlike } = await probe.reset();

  expect(repair).toEqual({ dropped: ['notes', 'notes_children'], refused: null });
  expect(rows).toEqual([{ notes: 0, children: 0, kept: 2500 }]);
  expect(keptAlike).toBe(true);
});

it('a workspace nothing has claimed answers the walk for itself, with no agents', async () => {
  const probe = env.STORE_RESET_PROBE.get(env.STORE_RESET_PROBE.idFromName('store-unborn'));

  expect(await probe.walked('never-claimed')).toEqual({ dropped: [], refused: null, agents: [] });
});

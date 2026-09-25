/**
 * A workspace whose store was created before the conversation store's storage reset is refused once, with one
 * message that says what happened and what to do. The history seed and a chat socket answer it instead of running
 * or failing a turn, the platform's wake returns instead of failing, and export still reads the store.
 */
import { env } from 'cloudflare:test';
import { expect, it } from 'vitest';

const REFUSED = 'This workspace was created before a storage reset, and this version cannot run it: its session_messages '
  + 'table has no envelope_json, sealed_at, content_json, content_path, content_digest. Export the workspace, or create a new one.';

it('a store created before the conversation store reset is refused with one message, and still exports', async () => {
  const probe = env.STORE_RESET_PROBE.get(env.STORE_RESET_PROBE.idFromName('store-reset'));
  const workspace = 'pre-reset-workspace';

  expect(await probe.plantRefusedWorkspace(workspace)).toContain('the pre-reset store is planted');
  expect(await probe.seed(workspace)).toEqual({ status: 415, body: JSON.stringify({ reason: 'unsupported', error: REFUSED }) });
  expect(await probe.overview(workspace)).toContain(REFUSED);

  // The page shows a failed turn's answer from these frames, so the refusal is seen the moment the tab opens.
  const chat = await probe.chat(workspace);

  expect(JSON.parse(chat.connected)).toMatchObject({ reason: 'unsupported', body: REFUSED });
  expect(JSON.parse(chat.answered)).toMatchObject({ id: 'refused-send', body: REFUSED });
  expect(await probe.wake(workspace)).toBe('returned');
  expect(await probe.exportedLines(workspace)).toBeGreaterThan(0);
});

import { env } from 'cloudflare:workers';
import { expect, it } from 'vitest';

// Trash empties itself 30 days on (docs/MAIL.md §4): whoever trashes a thread, the person in the app or an agent with
// mail.trash, the Mailbox arms the alarm that purges it.
const CALLER = { workspace: 'api-worker', title: 'API Worker', mainActorId: 'actor-main', actorId: 'actor-main', name: 'main' };

it.each([['the person', 'person'], ['an agent', 'agent']] as const)('a thread %s trashes is due to be purged', async (_who, by) => {
  const mailbox = env.MAILBOX.get(env.MAILBOX.idFromName(`trash-${by}`));

  await mailbox.open({ userId: `u-${by}`, email: 'me@ashishkumarsingh.com', username: 'ashish', assistant: null });
  const draft = await mailbox.draftFor(CALLER, { to: ['dana@northwind.io'], subject: 'Webhook signing', text: 'Checking the signing change.' });

  if (by === 'person') await mailbox.update(draft.threadId, { trashed: true });
  else await mailbox.updateFor(CALLER, draft.threadId, { trashed: true });

  expect(await mailbox.alarmAt()).not.toBeNull();
});

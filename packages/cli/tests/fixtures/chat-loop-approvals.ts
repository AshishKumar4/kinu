/** The classic chat loop on a terminal, whose workspace parks a command on the owner while the chat sits idle. */
import type { DeferredApproval } from '@kinu.run/core';
import { runChatLoop } from '../../src/chat-loop';
import { fakeClient } from '../helpers/chat-app-fixture';

let waiting: DeferredApproval[] = [];

const fake = fakeClient({
  name: 'loop',
  approvals: {
    list: async () => waiting.filter((action) => action.status === 'queued'),
    decide: async (ids, answer) => {
      waiting = waiting.map((action) => (ids.includes(action.id) ? { ...action, status: answer === 'denied' ? 'denied' : 'approved' } : action));
      console.log(`DECIDED ${ids.join(',')} ${answer}`);

      return { decided: ids };
    },
  },
});

// After the opening pass found nothing, so only the queue moving can ask it.
setTimeout(() => {
  waiting = [{
    id: 'park-1', actor: 'actor-main', command: 'git push --force origin main', executor: 'sandbox',
    reason: 'force push (gate): rewrites history', status: 'queued', requestedAt: Date.now(), decidedAt: null,
  }];
  fake.emit({ type: 'broadcast', event: { type: 'reads_changed', reads: ['listPendingActions'] } });
}, 1500);

await runChatLoop({ client: fake.client });

// Admission dedupe: a redelivered event lands on the row the first delivery wrote; a different one is admitted.
import { describe, test, expect } from 'bun:test';
import { Database } from 'bun:sqlite';
import { EventLog } from '../src/events/hub/log';
import { initEventsHubTables } from '../src/events/hub/schema';
import type { IngressDescriptor, WebhookPayload } from '../src/events/hub/types';
import { makeSqlExec } from './helpers';
import { createTestActorsOver } from '@kinu.run/test-utils';

function makeLog(): EventLog {
  const db = new Database(':memory:');
  const sql = makeSqlExec(db);

  initEventsHubTables(sql);

  return new EventLog(sql, createTestActorsOver(db).main);
}

function webhook(payload: Partial<WebhookPayload> = {}): IngressDescriptor {
  const webhook_id = payload.webhook_id ?? 'github-pr';

  return {
    ingress: 'webhook_hmac', variant: 'webhook', auth_outcome: 'verified', webhook_id,
    payload: { webhook_id, http_method: 'POST', http_headers: {}, body: { action: 'opened', number: 42 }, delivery_id: 'gh-abc-123', ...payload },
  };
}

describe('webhook admission dedupe', () => {
  test('a redelivered body inside its window is the first event; another body, window or hook is admitted', () => {
    const log = makeLog();
    // On a five-minute boundary, so a redelivery three minutes on falls inside the first delivery's window.
    const at = 1_700_000_100_000;
    const first = log.publish({ descriptor: webhook(), now: at });

    expect(log.publish({ descriptor: webhook(), now: at + 3 * 60_000 })).toEqual({ id: first.id, admitted: false });
    expect(log.publish({ descriptor: webhook({ body: { action: 'closed' } }), now: at }).admitted).toBe(true);
    expect(log.publish({ descriptor: webhook(), now: at + 10 * 60_000 }).admitted).toBe(true);
    expect(log.publish({ descriptor: webhook({ webhook_id: 'gh-issues' }), now: at }).admitted).toBe(true);
  });
});

describe('process_done admission dedupe', () => {
  test('one event per process, whatever else its report says', () => {
    const log = makeLog();

    const done = (process_id: string, command: string): IngressDescriptor => ({
      ingress: 'computer_cb', variant: 'process_done', launching_head_trust: 'owner',
      payload: { process_id, command, exit_code: 0, stdout_excerpt: '', stderr_excerpt: '', duration_ms: 0 },
    });

    const first = log.publish({ descriptor: done('pid-42', 'ls'), now: 1 });

    expect(log.publish({ descriptor: done('pid-42', 'pwd'), now: 2 }).id).toBe(first.id);
    expect(log.publish({ descriptor: done('pid-43', 'ls'), now: 3 }).admitted).toBe(true);
  });
});

describe('undeduped variants', () => {
  test('a chat sent twice is two events', () => {
    const log = makeLog();
    const chat: IngressDescriptor = { ingress: 'chat_ws', variant: 'chat', payload: { text: 'hello' }, operator_user_id: 'u', session_id: 's' };

    expect(log.publish({ descriptor: chat, now: 1 }).id).not.toBe(log.publish({ descriptor: chat, now: 1 }).id);
  });
});

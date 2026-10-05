// The start-up context measure is decided by how a session opens, never by when its first message arrives.
import { describe, expect, test } from 'bun:test';
import { WORKSPACE_RUN_ID } from '@kinu.run/core';
import type { SessionEvent } from '../src/local-session';
import { setup } from './helpers/local-session';

/** Each run event, labelled by whether it is the workspace's own (the start-up measure's run) or a turn's. */
function ledger(events: readonly SessionEvent[]): string[] {
  return events.flatMap((event) => (event.type === 'run-event'
    ? [`${event.event.runId === WORKSPACE_RUN_ID ? 'workspace' : 'turn'}:${event.event.type}`]
    : []));
}

describe('LocalAgentSession: the start-up measure', () => {
  test('a one-shot session opens with its first message in hand, so it takes no start-up measure', async () => {
    const { session, events } = setup('hello there', undefined, { oneShot: true });

    // No message at all: whatever the measure would race against, it never runs.
    await session.end();

    expect(ledger(events.items)).not.toContain('workspace:context_admitted');
  });

  test('an interactive session records its start-up measure before it takes a message, however soon one arrives', async () => {
    const { session, events } = setup('hello there');

    await session.send('hi', { id: crypto.randomUUID() });
    await session.end();

    const rows = ledger(events.items);

    expect(rows.filter((row) => row === 'workspace:context_admitted')).toHaveLength(1);
    expect(rows.indexOf('workspace:context_admitted')).toBeLessThan(rows.indexOf('turn:run_start'));
  });
});

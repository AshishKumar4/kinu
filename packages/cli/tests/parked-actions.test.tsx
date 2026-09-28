import { afterEach, expect, test } from 'bun:test';
import type { DeferredApproval, DeferredApprovalAnswer } from '@kinu.run/core';
import { flushSync } from '@opentui/react';
import type { LocalSessionControls } from '../src/agent-client';
import { cleanupChats, fakeClient, mountChat } from './helpers/chat-app-fixture';

afterEach(cleanupChats);

function parked(id: string, command: string): DeferredApproval {
  return { id, command, executor: 'sandbox', reason: 'force push', status: 'queued', requestedAt: 1, decidedAt: null };
}

type QueueControls = Pick<LocalSessionControls, 'listDeferredApprovals' | 'decideDeferredApprovals'>;

function queue(initial: DeferredApproval[]) {
  const waiting = [...initial];
  const decisions: Array<{ ids: string[]; answer: DeferredApprovalAnswer }> = [];

  const controls: QueueControls = {
    listDeferredApprovals: async () => [...waiting],
    decideDeferredApprovals: async (ids, answer) => {
      decisions.push({ ids, answer });
      const decided = waiting.filter((action) => ids.includes(action.id)).map((action) => action.id);
      waiting.splice(0, waiting.length, ...waiting.filter((action) => !decided.includes(action.id)));

      return { decided };
    },
  };

  return { waiting, decisions, controls };
}


function withQueue(controls: QueueControls) {
  const agent = fakeClient({ name: 'parked' });
  const local = agent.client.localControls;

  if (!local) throw new Error('the fixture is local');
  Object.assign(local, controls);

  return agent;
}

test('a command parked while the TUI is open is announced once, and /parked approves it', async () => {
  const parkedQueue = queue([]);
  const agent = withQueue(parkedQueue.controls);
  const screen = await mountChat(agent.client);

  parkedQueue.waiting.push(parked('park-1', 'git push --force origin main'));
  agent.emit({ type: 'broadcast', event: { type: 'pending_actions_changed' } });
  await screen.waitFor('the parked notice', () => screen.frame().includes('git push --force origin main'));
  agent.emit({ type: 'broadcast', event: { type: 'pending_actions_changed' } });
  parkedQueue.waiting.push(parked('park-2', 'rm -rf build'));
  agent.emit({ type: 'broadcast', event: { type: 'pending_actions_changed' } });
  await screen.waitFor('the second notice', () => screen.frame().includes('rm -rf build'));
  expect(screen.frame().split('git push --force origin main')).toHaveLength(2);

  await screen.mockInput.typeText('/parked approve all');
  flushSync(() => screen.mockInput.pressEnter());
  await screen.waitFor('the decision', () => screen.frame().includes('Approved: park-1, park-2'));
  expect(parkedQueue.decisions).toEqual([{ ids: ['park-1', 'park-2'], answer: 'approved' }]);
  expect(parkedQueue.waiting).toEqual([]);
});

test('a command parked before the TUI opened is announced on open', async () => {
  const agent = withQueue(queue([parked('park-9', 'terraform apply')]).controls);
  const screen = await mountChat(agent.client);

  await screen.waitFor('the parked notice', () => screen.frame().includes('terraform apply'));
});

test('/parked denies by id, and names an id that was not waiting', async () => {
  const parkedQueue = queue([parked('park-1', 'git push --force origin main')]);
  const agent = withQueue(parkedQueue.controls);
  const screen = await mountChat(agent.client);
  await screen.waitFor('the parked notice', () => screen.frame().includes('git push --force origin main'));

  await screen.mockInput.typeText('/parked deny park-1 park-7');
  flushSync(() => screen.mockInput.pressEnter());
  await screen.waitFor('the decision', () => screen.frame().includes('Denied: park-1'));
  expect(screen.frame()).toContain('park-7');
  expect(parkedQueue.decisions).toEqual([{ ids: ['park-1', 'park-7'], answer: 'denied' }]);
});

test('a read that lands after a newer one never re-announces a command', async () => {
  const waiting: DeferredApproval[] = [];
  const reads: Array<() => void> = [];

  const agent = withQueue({
    listDeferredApprovals: () => {
      const snapshot = [...waiting];
      const read = Promise.withResolvers<DeferredApproval[]>();
      reads.push(() => { read.resolve(snapshot); });

      return read.promise;
    },
    decideDeferredApprovals: async () => ({ decided: [] }),
  });

  const laps = async () => {
    for (let lap = 0; lap < 20; lap++) await new Promise((resolve) => { setImmediate(resolve); });
  };

  const releaseNewestFirst = async () => {
    for (let read = reads.pop(); read !== undefined; read = reads.pop()) {
      read();
      await laps();
    }
  };

  const screen = await mountChat(agent.client);

  waiting.push(parked('park-1', 'git push --force origin main'));
  agent.emit({ type: 'broadcast', event: { type: 'pending_actions_changed' } });
  await laps();
  await releaseNewestFirst();
  waiting.push(parked('park-2', 'rm -rf build'));
  agent.emit({ type: 'broadcast', event: { type: 'pending_actions_changed' } });
  await laps();
  await releaseNewestFirst();
  await screen.waitFor('the later notice', () => screen.frame().includes('rm -rf build'));

  expect(screen.frame().split('git push --force origin main')).toHaveLength(2);
});

test('/parked always names the rules and the machine it stops asking about, and never takes all', async () => {
  const parkedQueue = queue([parked('park-1', 'git push --force origin main'), parked('park-2', 'rm -rf build')]);
  const agent = withQueue(parkedQueue.controls);
  const screen = await mountChat(agent.client);
  await screen.waitFor('the parked notice', () => screen.frame().includes('rm -rf build'));

  await screen.mockInput.typeText('/parked always all');
  flushSync(() => screen.mockInput.pressEnter());
  await screen.waitFor('the refusal', () => screen.frame().includes('name each command'));
  expect(parkedQueue.decisions).toEqual([]);

  await screen.mockInput.typeText('/parked always park-1');
  flushSync(() => screen.mockInput.pressEnter());
  await screen.waitFor('the standing grant', () => screen.frame().includes('From now on sandbox runs'));
  expect(screen.frame().replace(/\s+/gu, ' ')).toContain('trip the same rules without asking: force push');
  expect(parkedQueue.decisions).toEqual([{ ids: ['park-1'], answer: 'always' }]);
});

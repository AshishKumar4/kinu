/** @jsxImportSource @opentui/react */
import { afterEach, describe, expect, test } from 'bun:test';

import { cleanupChats, fakeClient, mountChat } from './helpers/chat-app-fixture';
import { deviceConsentCanApprove } from '../src/tui/overlays';
import { executorLabel, type DeferredApproval, type DeferredApprovalAnswer, type ShellApprovalRequest, type ShellApprovalOutcome } from '@kinu.run/core';
import type { WaitingApprovalSurface } from '../src/agent-client';

afterEach(cleanupChats);

const shellRequest: ShellApprovalRequest = {
  command: 'sudo whoami', executor: 'device',
  review: { decision: 'gate', hits: [{ decision: 'gate', rule: 'sudo', explanation: 'Privilege escalation' }] },
};

describe('inline shell approval', () => {
  const decisions: Array<readonly [string, ShellApprovalOutcome]> = [['o', 'allow'], ['a', 'allow_always'], ['n', 'deny']];

  for (const [key, outcome] of decisions) {
    test(`${key} answers ${outcome} without editing or sending the composer`, async () => {
      const sent: unknown[] = [];

      const agent = fakeClient({ name: 'shell', send: async (input) => {
        sent.push(input);

        return { landed: 'turn' as const, text: '', toolCalls: [], steps: 1, durationMs: 1, hadError: false };
      } });

      const screen = await mountChat(agent.client);
      await screen.mockInput.typeText('kept draft');
      const answer = agent.requestShellApproval(shellRequest);
      await screen.waitFor('shell approval', () => screen.frame().includes('Run this command?'));
      expect(screen.frame()).toContain('sudo whoami');
      expect(screen.frame()).toContain(`Executor: ${executorLabel(shellRequest.executor)}`);
      expect(screen.frame()).toContain('Privilege escalation');
      await screen.mockInput.typeText('zzz');
      await screen.mockInput.pasteBracketedText('blocked paste');
      screen.mockInput.pressKey('l', { ctrl: true });
      await screen.renderOnce();
      expect(screen.frame()).not.toContain('zzz');
      expect(screen.frame()).not.toContain('blocked paste');
      expect(screen.frame()).not.toContain('Select model');
      expect(sent).toEqual([]);
      screen.mockInput.pressKey(key);
      expect(await answer).toBe(outcome);
      await screen.waitFor('approval closed', () => !screen.frame().includes('Run this command?'));
      expect(screen.frame()).toContain('kept draft');
    });
  }

  test('parallel requests retain separate answers and unmount releases the last', async () => {
    const agent = fakeClient({ name: 'shell' });
    const screen = await mountChat(agent.client);
    const first = agent.requestShellApproval(shellRequest);
    const second = agent.requestShellApproval({ ...shellRequest, command: 'sudo id' });
    await screen.waitFor('first request', () => screen.frame().includes('sudo whoami'));
    screen.mockInput.pressKey('o');
    expect(await first).toBe('allow');
    await screen.waitFor('second request', () => screen.frame().includes('sudo id'));
    cleanupChats();
    expect(await second).toBeNull();
  });

  test('an unseen command cannot receive a grant', async () => {
    const agent = fakeClient({ name: 'shell' });
    const screen = await mountChat(agent.client);
    const answer = agent.requestShellApproval({ ...shellRequest, command: 'sudo '.repeat(400) });
    await screen.waitFor('resize warning', () => screen.frame().includes('Enlarge the terminal'));
    screen.mockInput.pressKey('a');
    await screen.renderOnce();
    expect(screen.frame()).toContain('Run this command?');
    screen.mockInput.pressKey('n');
    expect(await answer).toBe('deny');
  });
});

describe('ChatApp consent ownership', () => {
  test('device consent owns every key until the decision closes it', async () => {
    const decisions: string[] = [];

    const pending = {
      consentId: 'consent-1',
      deviceLabel: 'Workstation',
      method: 'shell',
      command: 'bun test',
    };

    const controlled = fakeClient({
      name: 'cloudish',
      consents: {
        listPending: async () => [pending],
        resolve: async (_id, decision) => {
          decisions.push(decision);

          return { ok: true };
        },
      },
    });

    const screen = await mountChat(controlled.client);
    await screen.mockInput.typeText('/settings');
    screen.mockInput.pressEnter();
    await screen.waitFor('settings below consent', () => screen.frame().includes('Filter settings'));
    controlled.emit({ type: 'turn-start', kind: 'user', text: 'run the suite' });
    await screen.waitFor('the consent overlay', () => screen.frame().includes('Use your PC?'));
    await screen.mockInput.typeText('hidden draft');
    screen.mockInput.pressKey('l', { ctrl: true });
    screen.mockInput.pressTab();
    await screen.renderOnce();
    expect(screen.frame()).not.toContain('hidden draft');
    expect(screen.frame()).not.toContain('Select model');
    expect(screen.frame()).not.toContain('queued');
    screen.mockInput.pressKey('n');
    await screen.waitFor('the consent decision', () => decisions.length === 1);
    expect(decisions).toEqual(['deny']);
    expect(screen.frame()).toContain('Filter settings');
  });


  test('consent Return cannot activate the focused panel below it', async () => {
    const decisions: string[] = [];

    const controlled = fakeClient({
      name: 'cloudish',
      consents: {
        listPending: async () => [{
          consentId: 'consent-enter',
          deviceLabel: 'Workstation',
          method: 'shell',
          command: 'bun test',
        }],
        resolve: async (_id, decision) => {
          decisions.push(decision);

          return { ok: true };
        },
      },
    });

    const screen = await mountChat(controlled.client);
    await screen.mockInput.typeText('/settings');
    screen.mockInput.pressEnter();
    await screen.waitFor('settings below consent', () => screen.frame().includes('Filter settings'));
    controlled.emit({ type: 'turn-start', kind: 'user', text: 'run the suite' });
    await screen.waitFor('consent above settings', () => screen.frame().includes('Use your PC?'));
    screen.mockInput.pressEnter();
    await screen.waitFor('the one-time approval', () => decisions.length === 1);
    expect(decisions).toEqual(['once']);
    expect(screen.frame()).toContain('Filter settings');
    expect(screen.frame()).not.toContain('Select model');
  });
  test('an unseen consent tail cannot be approved', async () => {
    const decisions: string[] = [];

    const controlled = fakeClient({
      name: 'cloudish',
      consents: {
        listPending: async () => [{
          consentId: 'long-consent',
          deviceLabel: 'Workstation',
          method: 'shell',
          command: `bun run ${'private-argument '.repeat(200)}`,
        }],
        resolve: async (_id, decision) => {
          decisions.push(decision);

          return { ok: true };
        },
      },
    });

    const screen = await mountChat(controlled.client);
    controlled.emit({ type: 'turn-start', kind: 'user', text: 'run it' });
    await screen.waitFor('the unapprovable consent warning', () =>
      screen.frame().includes('Enlarge the terminal to read it all'));
    screen.mockInput.pressKey('a');
    screen.mockInput.pressKey('y');
    screen.mockInput.pressEnter();

    for (let index = 0; index < 4; index += 1) await screen.renderOnce();
    expect(decisions).toEqual([]);
    screen.mockInput.pressKey('n');
    await screen.waitFor('the long consent denial', () => decisions.length === 1);
    expect(decisions).toEqual(['deny']);
  });

  test('an approval shows a command\'s control characters as marks, never obeys them', async () => {
    // A carriage return, an erase or a conceal would make the prompt show a command other than the one that runs.
    const command = 'rm -rf ~\rsafe \u001b[2K\u001b[8mhidden\u001b[0m';
    const shown = ['rm -rf ~', '␍safe', '␛[2K', '␛[8mhidden'];

    const agent = fakeClient({
      name: 'shell',
      consents: {
        listPending: async () => [{ consentId: 'consent-raw', deviceLabel: 'Workstation', method: 'shell', command }],
        resolve: async () => ({ ok: true }),
      },
    });

    const screen = await mountChat(agent.client);
    const answer = agent.requestShellApproval({ ...shellRequest, command });
    await screen.waitFor('shell approval', () => screen.frame().includes('Run this command?'));

    for (const part of shown) expect(screen.frame()).toContain(part);
    expect(screen.frame().replaceAll('\n', '')).not.toMatch(/\p{Cc}/u);
    screen.mockInput.pressKey('n');
    expect(await answer).toBe('deny');

    agent.emit({ type: 'turn-start', kind: 'user', text: 'run it' });
    await screen.waitFor('the consent overlay', () => screen.frame().includes('Use your PC?'));

    for (const part of shown) expect(screen.frame()).toContain(part);
    expect(screen.frame().replaceAll('\n', '')).not.toMatch(/\p{Cc}/u);
  });

  test('an approval shows a command\'s bidi and zero-width characters as marks, so it reads as what runs', async () => {
    // U+202E and U+2066 reorder what follows; U+200B hides a byte. Shown raw, the prompt reads as other text.
    const command = 'rm -rf ./build \u202E\u2066gpj.x\u200B';

    const agent = fakeClient({
      name: 'shell',
      consents: {
        listPending: async () => [{ consentId: 'consent-bidi', deviceLabel: 'Workstation', method: 'shell', command }],
        resolve: async () => ({ ok: true }),
      },
    });

    const screen = await mountChat(agent.client);
    const answer = agent.requestShellApproval({ ...shellRequest, command });
    await screen.waitFor('shell approval', () => screen.frame().includes('Run this command?'));
    expect(screen.frame()).not.toMatch(/[\u200B-\u200F\u202A-\u202E\u2066-\u2069\uFEFF]/u);
    expect(screen.frame()).toContain('\uFFFD');
    screen.mockInput.pressKey('n');
    expect(await answer).toBe('deny');

    agent.emit({ type: 'turn-start', kind: 'user', text: 'run it' });
    await screen.waitFor('the consent overlay', () => screen.frame().includes('Use your PC?'));
    expect(screen.frame()).not.toMatch(/[\u200B-\u200F\u202A-\u202E\u2066-\u2069\uFEFF]/u);
    expect(screen.frame()).toContain('\uFFFD');
  });

  test('a wide glyph is budgeted two columns, not four', () => {
    // Counting UTF-16 units would read 39 emoji as four rows and refuse.
    expect(deviceConsentCanApprove({ command: '😀'.repeat(39) }, { width: 100, height: 11 })).toBe(true);
    expect(deviceConsentCanApprove({ command: '😀'.repeat(40) }, { width: 100, height: 11 })).toBe(false);
  });
});

describe('waiting approvals', () => {
  function parked(id: string, command: string): DeferredApproval {
    return { id, actor: 'actor-main', command, executor: 'sandbox', reason: 'Approval review: gate\n- force push (gate): rewrites history', status: 'queued', requestedAt: 1, decidedAt: null };
  }

  /** The workspace's queue as both backends serve it: a decided row leaves it. */
  function queue(initial: DeferredApproval[]) {
    const waiting = [...initial];
    const decided: Array<readonly [string[], DeferredApprovalAnswer]> = [];

    const approvals: WaitingApprovalSurface = {
      list: async () => waiting.filter((action) => !decided.some(([ids]) => ids.includes(action.id))),
      decide: async (ids, answer) => {
        decided.push([ids, answer]);

        return { decided: ids };
      },
    };

    return { waiting, decided, approvals };
  }

  test('the chat asks each parked command with the web\'s answers, and later leaves the rest waiting', async () => {
    const parkedQueue = queue([parked('park-1', 'git push --force origin main'), parked('park-2', 'rm -rf build')]);
    const screen = await mountChat(fakeClient({ name: 'parked', approvals: parkedQueue.approvals }).client);

    await screen.waitFor('the first waiting approval', () => screen.frame().includes('git push --force origin main'));
    expect(screen.frame()).toContain('Run this command?');
    expect(screen.frame()).toContain('rewrites history');
    screen.mockInput.pressKey('a');
    await screen.waitFor('the second waiting approval', () => screen.frame().includes('rm -rf build'));
    // Later takes the prompt at once: an approving key in the same frame answers nothing.
    screen.mockInput.pressKey('l');
    screen.mockInput.pressKey('y');
    await screen.waitFor('the prompt put off', () => !screen.frame().includes('Run this command?'));

    expect(parkedQueue.decided).toEqual([[['park-1'], 'always']]);
  });

  test('a key pressed as one answer lands never answers the next, and a file write is not approved here', async () => {
    const write = parked('park-2', `file write /home/main/notes.md sha256:${'a'.repeat(64)} over sha256:${'b'.repeat(64)}`);
    const parkedQueue = queue([parked('park-1', 'ls -la'), write]);
    const screen = await mountChat(fakeClient({ name: 'parked', approvals: parkedQueue.approvals }).client);

    await screen.waitFor('the first waiting approval', () => screen.frame().includes('ls -la'));
    // Both keys arrive before the first answer lands or the next prompt is drawn.
    screen.mockInput.pressKey('o');
    screen.mockInput.pressKey('o');
    await screen.waitFor('the parked write, drawn next', () => screen.frame().includes('Replace this file?'));

    expect(parkedQueue.decided).toEqual([[['park-1'], 'approved']]);
  });

  test('a file write offers only deny and later in the terminal', async () => {
    const parkedQueue = queue([parked('park-1', `file write /home/main/notes.md sha256:${'a'.repeat(64)} over sha256:${'b'.repeat(64)}`)]);
    const screen = await mountChat(fakeClient({ name: 'parked', approvals: parkedQueue.approvals }).client);

    await screen.waitFor('the parked write', () => screen.frame().includes('Replace this file?'));
    screen.mockInput.pressKey('o');
    screen.mockInput.pressKey('a');
    await screen.renderOnce();
    expect(parkedQueue.decided).toEqual([]);
    screen.mockInput.pressKey('n');
    await screen.waitFor('the denial', () => parkedQueue.decided.length === 1);

    expect(parkedQueue.decided).toEqual([[['park-1'], 'denied']]);
  });

  test('a refused answer leaves the chat usable and asks the row again once the queue reads', async () => {
    const parkedQueue = queue([parked('park-1', 'git push --force origin main')]);
    let reachable = true;
    let attempts = 0;

    const approvals: WaitingApprovalSurface = {
      list: async () => {
        if (!reachable) throw new Error('the workspace is unreachable');

        return parkedQueue.approvals.list();
      },
      decide: async (ids, answer) => {
        attempts += 1;

        // The first answer, and every read after it, are refused until the workspace answers again.
        if (attempts === 1) {
          reachable = false;

          throw new Error('the workspace is unreachable');
        }

        return parkedQueue.approvals.decide(ids, answer);
      },
    };

    const agent = fakeClient({ name: 'parked', approvals });
    const screen = await mountChat(agent.client);

    await screen.waitFor('the waiting approval', () => screen.frame().includes('git push --force origin main'));
    screen.mockInput.pressKey('o');
    await screen.waitFor('the refusal said', () => screen.frame().includes('the workspace is unreachable'));
    await screen.mockInput.typeText('still here');
    await screen.waitFor('the composer taking keys', () => screen.frame().includes('still here'));
    expect(screen.frame()).not.toContain('Run this command?');

    for (let left = 'still here'.length; left > 0; left -= 1) screen.mockInput.pressBackspace();

    reachable = true;
    agent.emit({ type: 'broadcast', event: { type: 'reads_changed', reads: ['listPendingActions'] } });
    await screen.waitFor('the row asked again', () => screen.frame().includes('Run this command?'));
    screen.mockInput.pressKey('n');
    await screen.waitFor('the denial', () => parkedQueue.decided.length === 1);

    expect(parkedQueue.decided).toEqual([[['park-1'], 'denied']]);
  });

  test('a draft holds a newly parked command back, so no keystroke meant for it answers', async () => {
    const parkedQueue = queue([]);
    const agent = fakeClient({ name: 'parked', approvals: parkedQueue.approvals });
    const screen = await mountChat(agent.client);

    await screen.mockInput.typeText('yes, and also');
    parkedQueue.waiting.push(parked('park-1', 'git push --force origin main'));
    agent.emit({ type: 'broadcast', event: { type: 'reads_changed', reads: ['listPendingActions'] } });
    await screen.mockInput.typeText(' y');
    await screen.renderOnce();
    expect(screen.frame()).not.toContain('Run this command?');

    // Emptied key by key: each one is the composer's while it still holds a character.
    for (let left = 'yes, and also y'.length; left > 0; left -= 1) screen.mockInput.pressBackspace();

    await screen.waitFor('the waiting approval once the composer is empty', () => screen.frame().includes('git push --force origin main'));
    screen.mockInput.pressKey('n');
    await screen.waitFor('the denial', () => parkedQueue.decided.length === 1);

    expect(parkedQueue.decided).toEqual([[['park-1'], 'denied']]);
  });
});

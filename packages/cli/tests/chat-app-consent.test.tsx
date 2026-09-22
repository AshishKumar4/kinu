/** @jsxImportSource @opentui/react */
import { afterEach, describe, expect, test } from 'bun:test';

import { cleanupChats, fakeClient, mountChat } from './helpers/chat-app-fixture';
import { deviceConsentCanApprove } from '../src/tui/overlays';
import type { ShellApprovalRequest, ShellApprovalOutcome } from '@kinu.run/core';

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
      expect(screen.frame()).toContain('Executor: device');
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
    await screen.waitFor('resize warning', () => screen.frame().includes('Resize to inspect'));
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
      screen.frame().includes('Resize to inspect the full command'));
    screen.mockInput.pressKey('a');
    screen.mockInput.pressKey('y');
    screen.mockInput.pressEnter();

    for (let index = 0; index < 4; index += 1) await screen.renderOnce();
    expect(decisions).toEqual([]);
    screen.mockInput.pressKey('n');
    await screen.waitFor('the long consent denial', () => decisions.length === 1);
    expect(decisions).toEqual(['deny']);
  });

  test('a wide glyph is budgeted two columns, not four', () => {
    // 24 half-width columns: "Command: " plus 39 emoji is 48 code points, two
    // rows, and the 9-row terminal holds those two with the dialog's seven.
    // Counted in UTF-16 units the same command reads as four rows and refuses.
    expect(deviceConsentCanApprove({ command: '😀'.repeat(39) }, { width: 100, height: 11 })).toBe(true);
    expect(deviceConsentCanApprove({ command: '😀'.repeat(40) }, { width: 100, height: 11 })).toBe(false);
  });
});

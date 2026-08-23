/** @jsxImportSource @opentui/react */
import { afterEach, describe, expect, test } from 'bun:test';

import { cleanupChats, fakeClient, mountChat } from './helpers/chat-app-fixture';

afterEach(cleanupChats);

describe('ChatApp consent ownership', () => {
  test('device consent owns every key until the decision closes it', async () => {
    const decisions: string[] = [];
    const pending = {
      consentId: 'consent-1',
      deviceLabel: 'Workstation',
      method: 'run',
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
    screen.mockInput.pressKey('g', { ctrl: true });
    await screen.waitFor('settings below consent', () => screen.frame().includes('Filter settings'));
    controlled.emit({ type: 'turn-start', kind: 'user', text: 'run the suite' });
    await screen.waitFor('the consent overlay', () => screen.frame().includes('Use your PC?'));
    await screen.mockInput.typeText('hidden draft');
    screen.mockInput.pressKey('p', { ctrl: true });
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
          method: 'run',
          command: 'bun test',
        }],
        resolve: async (_id, decision) => {
          decisions.push(decision);
          return { ok: true };
        },
      },
    });
    const screen = await mountChat(controlled.client);
    screen.mockInput.pressKey('g', { ctrl: true });
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
          method: 'run',
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


});

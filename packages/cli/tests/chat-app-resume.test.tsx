/** @jsxImportSource @opentui/react */
import { afterEach, describe, expect, test } from 'bun:test';

import {
  TURN,
  cleanupChats,
  fakeClient,
  mountChat,
  session,
} from './helpers/chat-app-fixture';

afterEach(cleanupChats);

describe('ChatApp resume and chronology', () => {
  test('resume picker starts in the current folder and expands on Tab', async () => {
    const resumed: string[] = [];
    const controlled = fakeClient({
      name: 'alpha',
      sessionHistory: {
        list: () => [session('older')],
        resume: async (id) => { resumed.push(id); },
      },
    });
    const screen = await mountChat(controlled.client);
    await screen.mockInput.typeText('/resume');
    screen.mockInput.pressEnter();
    await screen.waitFor('the folder-scoped resume picker', () =>
      screen.frame().includes('No conversations in this folder'));
    screen.mockInput.pressTab();
    await screen.waitFor('all recorded conversations', () =>
      screen.frame().includes('Earlier task'));
    screen.mockInput.pressEnter();
    await screen.waitFor('the selected conversation to resume', () => resumed.length === 1);
    expect(resumed).toEqual(['older']);
  });

  test('failed resume restores a usable composer and keeps the failure actionable', async () => {
    const controlled = fakeClient({
      name: 'alpha',
      sessionHistory: {
        list: () => [session('older')],
        resume: async () => { throw new Error('Unauthorized model provider'); },
      },
    });
    const screen = await mountChat(controlled.client);
    await screen.mockInput.typeText('/resume');
    screen.mockInput.pressEnter();
    await screen.waitFor('the failed session in the resume picker', () =>
      screen.frame().includes('No conversations in this folder'));
    screen.mockInput.pressTab();

    await screen.waitFor('the failed session after expanding scope', () =>
      screen.frame().includes('Earlier task'));
    screen.mockInput.pressEnter();
    await screen.waitFor('the resume failure', () =>
      screen.frame().includes('Unauthorized model provider'));
    await screen.waitFor('the composer after failed resume', () =>
      screen.frame().includes('Send a message'));
    await screen.mockInput.typeText('/status');
    screen.mockInput.pressEnter();
    await screen.waitFor('a command after failed resume', () =>
      screen.frame().includes('Workspace Status'));
    expect(screen.frame()).not.toContain('Still connecting.');
  });
  test('resume commits the new session before reporting history hydration failure', async () => {
    const controlled = fakeClient({
      name: 'alpha',
      sessionHistory: {
        list: () => [session('older')],
        resume: async () => {},
      },
      history: async () => { throw new Error('Session history is unreadable'); },
    });
    const screen = await mountChat(controlled.client);
    await screen.mockInput.typeText('/resume');
    screen.mockInput.pressEnter();
    await screen.waitFor('the folder-scoped resume picker', () =>
      screen.frame().includes('No conversations in this folder'));
    screen.mockInput.pressTab();
    await screen.waitFor('the selected session', () => screen.frame().includes('Earlier task'));
    screen.mockInput.pressEnter();
    await screen.waitFor('the history failure', () =>
      screen.frame().includes('Session history is unreadable'));
    expect(screen.frame()).toContain('Resumed');
    expect(screen.frame()).not.toContain('Connected to alpha');
  });

  test('/status lands between the transcript events around it', async () => {
    const controlled = fakeClient({ name: 'alpha' });
    const screen = await mountChat(controlled.client);
    controlled.emit({ type: 'turn-start', kind: 'programmatic', text: 'before status' });
    controlled.emit({ type: 'turn-end', turn: TURN });
    await screen.mockInput.typeText('/status');
    screen.mockInput.pressEnter();
    await screen.waitFor('the status snapshot', () => screen.frame().includes('Workspace Status'));
    controlled.emit({ type: 'error', message: 'after status' });
    await screen.waitFor('the event after status', () => screen.frame().includes('after status'));
    const frame = screen.frame();
    expect(frame.indexOf('before status')).toBeLessThan(frame.indexOf('Workspace Status'));
    expect(frame.indexOf('Workspace Status')).toBeLessThan(frame.indexOf('after status'));
  });

});

/**
 * The connect card hands the keys to the composer, on a real terminal.
 *
 * This is the first-run `enter-sends` path over a local fixture: the shipped
 * `ChatApp` in cloud mode raises the connect card after the client connects,
 * every keystroke goes to the card until it is answered, and the card LEAVING
 * the screen is the render that gives the composer its focus back. Measured
 * 2026-09-05 on this fixture, three runs each: a draft typed straight after the
 * card's own key was lost whole, and a draft typed after the card had left the
 * screen was echoed, sent, and answered. So the steps here are in the order a
 * person does them, each after the screen fact a person waits for, and the
 * running-turn placeholder is the product's own word that Enter sent.
 */
import { describe, expect, test } from 'bun:test';
import { resolve } from 'node:path';

import { TUI_COMPOSER_PLACEHOLDER, TUI_COMPOSER_STEERING_PLACEHOLDER } from '@kinu.run/core';

import { runTuiInPty } from './helpers/pty-screen';

const entry = resolve(import.meta.dir, 'fixtures/pty-connect-card.tsx');

describe('the connect card on a real terminal', () => {
  test('keys go to the card until it leaves, then Enter sends from the composer', () => {
    const draft = 'draft after the card';
    const run = runTuiInPty(entry, {
      steps: [
        { wait: 'not now', timeout: 15 },
        // No card binding among these letters, so the card swallows them.
        { send: 'quirk' },
        { send: 'n' },
        { gone: 'not now', timeout: 5 },
        { wait: TUI_COMPOSER_PLACEHOLDER, timeout: 5 },
        { send: draft },
        { wait: draft, timeout: 5 },
        { send: '\r' },
        { wait: TUI_COMPOSER_STEERING_PLACEHOLDER, timeout: 5 },
        { wait: 'agent prose reply', timeout: 5 },
      ],
    });
    expect(run.waits.map((wait) => [wait.until, wait.text, wait.met])).toEqual([
      ['shown', 'not now', true],
      ['gone', 'not now', true],
      ['shown', TUI_COMPOSER_PLACEHOLDER, true],
      ['shown', draft, true],
      ['shown', TUI_COMPOSER_STEERING_PLACEHOLDER, true],
      ['shown', 'agent prose reply', true],
    ]);
    expect(run.screen).not.toContain('quirk');
  }, 60_000);
});

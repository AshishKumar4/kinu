/** Chat-error surface (the "UI shows nothing on error frames" P0): which frames become the error card
 *  and whether a card is a replay. The card as drawn is proved in the browser tier
 *  (`scripts/chat-and-files-ux.test.ts`, live versus replayed headings). */

import { describe, expect, test } from 'bun:test';
import { terminalChatError } from '@kinu.run/core';

describe('use-kinu chat-error frames', () => {
  test('catches the on-connect terminal-error replay frame in the raw onMessage handler', () => {
    // Cases for the bugs source-text assertions could not catch: inverted replay comparison, dropped `done`, unpopulated resumed-id set.
    const announced = new Set<string>();

    expect(terminalChatError(
      { type: 'cf_agent_use_chat_response', error: true, done: true, body: 'Unauthorized', id: 'req-1' },
      announced,
    )).toEqual({ body: 'Unauthorized', replayed: false });

    announced.add('req-1');
    expect(terminalChatError(
      { type: 'cf_agent_use_chat_response', error: true, done: true, body: 'Unauthorized', id: 'req-1' },
      announced,
    )).toEqual({ body: 'Unauthorized', replayed: true });

    // A different id after a replay announcement is still live; `announced.size > 0` would backdate it.
    expect(terminalChatError(
      { type: 'cf_agent_use_chat_response', error: true, done: true, body: 'boom', id: 'req-2' },
      announced,
    )).toEqual({ body: 'boom', replayed: false });

    expect(terminalChatError(
      { type: 'cf_agent_use_chat_response', error: true, done: true, body: 'boom' },
      announced,
    )).toEqual({ body: 'boom', replayed: false });

    // Mid-stream failures belong to the live channel; folding them in draws the card twice.
    expect(terminalChatError(
      { type: 'cf_agent_use_chat_response', error: true, id: 'req-1' }, announced,
    )).toBeNull();
    expect(terminalChatError(
      { type: 'cf_agent_use_chat_response', done: true, body: 'fine' }, announced,
    )).toBeNull();
    expect(terminalChatError({ type: 'cf_agent_stream_resuming', id: 'req-1' }, announced)).toBeNull();

    expect(terminalChatError(
      { type: 'cf_agent_use_chat_response', error: true, done: true, body: '   ', id: 'x' }, announced,
    )).toEqual({ body: 'The turn failed with an unknown error.', replayed: false });
  });
});

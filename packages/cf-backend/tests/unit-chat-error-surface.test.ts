/** Chat-error surface (the "UI shows nothing on error frames" P0). The replay rule is behavioural via `terminalChatError`;
 *  the rest is React effect wiring asserted in source (no DOM harness) through `between`, which throws on a rename. */

import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { between } from '@kinu.run/test-utils';
import { terminalChatError } from '@kinu.run/core';

const hook = readFileSync(join(import.meta.dir, '..', 'src', 'hooks', 'use-kinu.ts'), 'utf8');

const page = readFileSync(join(import.meta.dir, '..', 'src', 'pages', 'WorkspacePage.tsx'), 'utf8');

describe('use-kinu chat-error wiring', () => {
  test('consumes the useAgentChat stream error and folds it into chatError', () => {
    expect(hook).toContain('error: streamError');
    // The transport only reaches this channel for a request id still in flight, so it is never a replay.
    expect(hook).toContain('setChatError({ body: streamError.message || String(streamError), replayed: false })');
  });

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

  test('clears the error on the next send and on workspace switch; exposes retry + clear + state', () => {
    const send = between(hook, 'const sendChat = useCallback', 'const searchMemory', 'use-kinu.ts');
    expect(send).toContain('setChatError(null)');
    // Bounded by the effect's own dependency array, not a trailing marker a rename can move.
    const reset = between(hook, 'setLoadGeneration(0);', '}, [workspace, subordinate]);', 'use-kinu.ts');
    expect(reset).toContain('setChatError(null)');
    const returned = hook.slice(hook.indexOf('return {\n    messages'));
    expect(returned).toContain('chatError,');
    expect(returned).toContain('clearChatError:');
    expect(returned).toContain('retryLastMessage,');
  });

  test('retry RE-RUNS the failed turn and never appends a second user message', () => {
    const retry = hook.slice(hook.indexOf('const retryLastMessage'), hook.indexOf('const searchMemory'));
    // The invariant, not the call spelling: retry goes through the SDK's `regenerate` and never reaches `sendMessage`,
    // which appended a duplicate user turn on every press.
    expect(retry).toContain('regenerate()');
    expect(retry).not.toContain('sendMessage(');
    expect(hook).toContain('    regenerate,');
  });
});

describe('WorkspacePage error-card wiring', () => {
  test('renders the honest error body inside the chat thread with retry and dismiss', () => {
    expect(page).toContain('function ChatErrorCard');
    const card = page.slice(page.indexOf('function ChatErrorCard'), page.indexOf('function BackgroundEventCard'));
    expect(card).toContain('{message}');
    expect(card).toContain('onRetry');
    expect(card).toContain('onDismiss');
    // Token-pure styling: p-* classes and the --c-danger token, no raw palette classes.
    expect(card).toContain('p-danger');
    expect(card).toContain('var(--c-danger)');
    expect(card).not.toMatch(/text-red-\d|border-red-\d|bg-red-\d/);

    // Bounded by the block after it; anchored on `thread.entries`, the map that draws the transcript.
    const thread = page.slice(page.lastIndexOf('{thread.entries.map'), page.indexOf('Device-consent cards'));
    expect(thread).toContain('state.chatError && (');
    expect(thread).toContain('onRetry={state.retryLastMessage}');
    expect(thread).toContain('onDismiss={state.clearChatError}');
  });
});

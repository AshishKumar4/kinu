/** Chat-error surface wiring (the "UI shows nothing on error frames" P0).
 *  No DOM harness exists in this repo, so — like unit-turn-pipeline-
 *  correctness — these assert the load-bearing seams in source: both error
 *  channels feed one exposed chat-error state, the on-connect terminal
 *  replay (dropped by the ws transport's request-id filter) is caught in the
 *  raw onMessage handler, and WorkspacePage renders the card with retry.
 *  The interactive behavior needs a browser check (see the fix report). */

import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { between } from '@kinu.run/test-utils';

const hook = readFileSync(join(import.meta.dir, '..', 'src', 'hooks', 'use-kinu.ts'), 'utf8');
const page = readFileSync(join(import.meta.dir, '..', 'src', 'pages', 'WorkspacePage.tsx'), 'utf8');

describe('use-kinu chat-error wiring', () => {
  test('consumes the useAgentChat stream error and folds it into chatError', () => {
    expect(hook).toContain('error: streamError');
    // Live by construction: the transport only reaches this channel for a
    // request id still in flight, so it is never a replay.
    expect(hook).toContain('setChatError({ body: streamError.message || String(streamError), replayed: false })');
  });

  test('catches the on-connect terminal-error replay frame in the raw onMessage handler', () => {
    const handler = hook.slice(hook.indexOf('onMessage: useCallback'), hook.indexOf('const {'));
    expect(handler).toContain('data?.type === "cf_agent_use_chat_response" && data.error === true && data.done === true');
    expect(handler).toContain('setChatError(');
    // And it must be able to SAY it is a replay. The server keeps its last
    // terminal record until a later turn supersedes it, so an idle workspace
    // re-serves an old failure on every connect; the id it announced in
    // `cf_agent_stream_resuming` is what tells the two apart.
    expect(handler).toContain('resumedRequestIds.current.add(data.id)');
    expect(handler).toContain('replayed: data.id !== undefined && resumedRequestIds.current.has(data.id)');
  });

  test('clears the error on the next send and on workspace switch; exposes retry + clear + state', () => {
    const send = between(hook, 'const sendChat = useCallback', 'const searchMemory', 'use-kinu.ts');
    expect(send).toContain('setChatError(null)');
    // The whole workspace-switch effect, bounded by its own dependency array —
    // not a trailing marker that a rename can move out from under it.
    const reset = between(hook, 'setLoadGeneration(0);', '}, [workspace, subordinate]);', 'use-kinu.ts');
    expect(reset).toContain('setChatError(null)');
    const returned = hook.slice(hook.indexOf('return {\n    messages'));
    expect(returned).toContain('chatError,');
    expect(returned).toContain('clearChatError:');
    expect(returned).toContain('retryLastMessage,');
  });

  test('retry RE-RUNS the failed turn and never appends a second user message', () => {
    const retry = hook.slice(hook.indexOf('const retryLastMessage'), hook.indexOf('const searchMemory'));
    // The SDK's own regenerate: it drops the assistant message being retried,
    // or keeps a trailing user message when the turn produced none, and sends
    // `trigger: 'regenerate-message'`. `sendMessage` here appended a duplicate
    // user turn on every press.
    expect(retry).toContain('void regenerate()');
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
    // Token-pure styling (the repo is mid-light-mode-fix): p-* classes +
    // the --c-danger token, no raw palette classes.
    expect(card).toContain('p-danger');
    expect(card).toContain('var(--c-danger)');
    expect(card).not.toMatch(/text-red-\d|border-red-\d|bg-red-\d/);

    // The workspace column's thread, bounded by the block after it. Anchored on
    // the map that draws the transcript — `thread.entries` since the steer
    // placement moved the list behind one builder.
    const thread = page.slice(page.lastIndexOf('{thread.entries.map'), page.indexOf('Device-consent cards'));
    expect(thread).toContain('state.chatError && (');
    expect(thread).toContain('onRetry={state.retryLastMessage}');
    expect(thread).toContain('onDismiss={state.clearChatError}');
  });
});

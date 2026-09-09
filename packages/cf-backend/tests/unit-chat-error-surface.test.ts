/** Chat-error surface wiring (the "UI shows nothing on error frames" P0).
 *
 *  The REPLAY RULE is behavioural: `terminalChatError` is the decision the raw
 *  `onMessage` handler makes, extracted so an inverted comparison fails a test
 *  instead of leaving the expected characters in place. See
 *  `src/hooks/chat-turn-error.ts`.
 *
 *  The rest is still asserted in source, because no DOM harness exists in this
 *  repo and the remaining seams are React effect wiring — a `setChatError(null)`
 *  inside the send path and inside the workspace-switch effect, and the names
 *  the hook returns. Those anchors are `between`, which THROWS on a rename
 *  rather than silently slicing an empty region. The card's rendered behaviour
 *  is covered for real by the browser tier: `scripts/chat-and-files-ux.test.ts`
 *  reads the live and replayed headings off the mounted card. */

import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { between } from '@kinu.run/test-utils';
import { terminalChatError, UNKNOWN_TURN_FAILURE } from '../src/hooks/chat-turn-error';

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
    // BEHAVIOURAL, over the rule the handler now calls. This asserted the
    // handler's source text, which could not fail on the three bugs that
    // matter: an inverted replay comparison, a dropped `done` check, and a
    // resumed-id set that is read but never populated. All three read as
    // correct characters. Each is now a case.
    const announced = new Set<string>();

    // The live failure: no id was announced, so this is this session's turn.
    expect(terminalChatError(
      { type: 'cf_agent_use_chat_response', error: true, done: true, body: 'Unauthorized', id: 'req-1' },
      announced,
    )).toEqual({ body: 'Unauthorized', replayed: false });

    // The server announces the record it is about to resume, then replays it.
    announced.add('req-1');
    expect(terminalChatError(
      { type: 'cf_agent_use_chat_response', error: true, done: true, body: 'Unauthorized', id: 'req-1' },
      announced,
    )).toEqual({ body: 'Unauthorized', replayed: true });

    // A DIFFERENT id, with a replay already announced: still live. An
    // implementation that reported `announced.size > 0` would backdate it.
    expect(terminalChatError(
      { type: 'cf_agent_use_chat_response', error: true, done: true, body: 'boom', id: 'req-2' },
      announced,
    )).toEqual({ body: 'boom', replayed: false });

    // No id at all is in no set, so it is never a replay.
    expect(terminalChatError(
      { type: 'cf_agent_use_chat_response', error: true, done: true, body: 'boom' },
      announced,
    )).toEqual({ body: 'boom', replayed: false });

    // Mid-stream failures are the live channel's, not this one's: `done` is
    // absent, and folding them in here draws the card twice for one failure.
    expect(terminalChatError(
      { type: 'cf_agent_use_chat_response', error: true, id: 'req-1' }, announced,
    )).toBeNull();
    // A successful terminal frame is not an error.
    expect(terminalChatError(
      { type: 'cf_agent_use_chat_response', done: true, body: 'fine' }, announced,
    )).toBeNull();
    // And no other frame type reaches the card at all.
    expect(terminalChatError({ type: 'cf_agent_stream_resuming', id: 'req-1' }, announced)).toBeNull();

    // An empty body still says something honest rather than rendering blank —
    // the "UI shows nothing on error frames" P0 this file exists for.
    expect(terminalChatError(
      { type: 'cf_agent_use_chat_response', error: true, done: true, body: '   ', id: 'x' }, announced,
    )).toEqual({ body: UNKNOWN_TURN_FAILURE, replayed: false });
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
    // The INVARIANT, not the call spelling: retry must go through `regenerate`
    // and must never reach `sendMessage`. Asserting the exact statement broke on
    // a refactor that put the same call under the send-admission latch, which is
    // a ratchet failing on a change that preserved the property it defends.
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

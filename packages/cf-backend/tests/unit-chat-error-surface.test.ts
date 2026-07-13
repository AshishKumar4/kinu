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

const hook = readFileSync(join(import.meta.dir, '..', 'src', 'hooks', 'use-proteus.ts'), 'utf8');
const page = readFileSync(join(import.meta.dir, '..', 'src', 'pages', 'WorkspacePage.tsx'), 'utf8');

describe('use-proteus chat-error wiring', () => {
  test('consumes the useAgentChat stream error and folds it into chatError', () => {
    expect(hook).toContain('error: streamError');
    expect(hook).toContain('if (streamError) setChatError(streamError.message || String(streamError))');
  });

  test('catches the on-connect terminal-error replay frame in the raw onMessage handler', () => {
    const handler = hook.slice(hook.indexOf('onMessage: useCallback'), hook.indexOf('const {'));
    expect(handler).toContain('data?.type === "cf_agent_use_chat_response" && data.error === true && data.done === true');
    expect(handler).toContain('setChatError(');
  });

  test('clears the error on the next send and on workspace switch; exposes retry + clear + state', () => {
    const send = hook.slice(hook.indexOf('const sendChat = useCallback'), hook.indexOf('const searchMemory'));
    expect(send).toContain('setChatError(null)');
    const reset = hook.slice(hook.indexOf('setRunTimeline([]);\n    setPinnedPorts([]);'), hook.indexOf('}, [agentId])'));
    expect(reset).toContain('setChatError(null)');
    const returned = hook.slice(hook.indexOf('return {\n    messages'));
    expect(returned).toContain('chatError,');
    expect(returned).toContain('clearChatError:');
    expect(returned).toContain('retryLastMessage,');
  });

  test('retry re-sends the last user message parts', () => {
    const retry = hook.slice(hook.indexOf('const retryLastMessage'), hook.indexOf('const searchMemory'));
    expect(retry).toContain('.find((m) => m.role === "user")');
    expect(retry).toContain('sendMessage({ role: "user", parts: lastUser.parts })');
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

    const thread = page.slice(page.indexOf('{state.messages.map'), page.indexOf('Device-consent cards'));
    expect(thread).toContain('state.chatError && (');
    expect(thread).toContain('onRetry={state.retryLastMessage}');
    expect(thread).toContain('onDismiss={state.clearChatError}');
  });
});

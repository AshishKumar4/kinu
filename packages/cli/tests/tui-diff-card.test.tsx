/**
 * The file-edit diff card: a `file` call's edit/write result draws the change
 * it made — header, counts, prefixed hunk lines — reconstructed from the
 * call's own record by the same LCS the workspace change-set runs. The cases
 * here are the card's whole contract: what it shows, what it collapses to,
 * how it says so when it cannot show a diff.
 */
import { afterEach, describe, expect, test } from 'bun:test';

import { EXPANDED_RESULT_LINES } from '../src/tui/diff-card';
import { cleanupChats, fakeClient, mountChat } from './helpers/chat-app-fixture';

afterEach(cleanupChats);

/** The shape `file action=edit` answers, rendered the way the event stream
 *  carries it. */
function editResult(path: string, applied: Array<{ line: number; removed_lines: number; added_lines: number }>): string {
  return JSON.stringify({ ok: true, path, applied });
}

function writeResult(path: string, action: 'created' | 'replaced', bytes: number): string {
  return JSON.stringify({ ok: true, path, bytes, action });
}

describe('the file diff card', () => {
  test('an edit result renders its hunks with the recorded counts, not the result JSON', async () => {
    const agent = fakeClient({ name: 'diffs' });
    const screen = await mountChat(agent.client, { width: 96 });

    agent.emit({
      type: 'tool-call', toolName: 'file', toolCallId: 'call-1',
      args: {
        action: 'edit',
        path: 'src/state.ts',
        edits: [{ old_text: 'export const ready = false;', new_text: 'export const ready = true;' }],
      },
    });
    agent.emit({
      type: 'tool-result', toolName: 'file', toolCallId: 'call-1',
      result: editResult('src/state.ts', [{ line: 12, removed_lines: 1, added_lines: 1 }]),
      success: true,
    });

    await screen.waitFor('the diff card', () => screen.frame().includes('src/state.ts'));
    const frame = screen.frame();

    expect(frame).toContain('src/state.ts');
    expect(frame).toContain('+1');
    expect(frame).toContain('−1');
    expect(frame).toContain('− export const ready = false;');
    expect(frame).toContain('+ export const ready = true;');
    // The result's own JSON never appears as the clipped text row it used to be.
    expect(frame).not.toContain('"applied"');
  });

  test('a new file writes as an all-added card', async () => {
    const agent = fakeClient({ name: 'diffs' });
    const screen = await mountChat(agent.client, { width: 96 });

    agent.emit({
      type: 'tool-call', toolName: 'file', toolCallId: 'call-1',
      args: { action: 'write', path: 'notes/todo.md', content: 'alpha\nbeta' },
    });
    agent.emit({
      type: 'tool-result', toolName: 'file', toolCallId: 'call-1',
      result: writeResult('notes/todo.md', 'created', 10),
      success: true,
    });

    await screen.waitFor('the new-file card', () => screen.frame().includes('notes/todo.md'));
    const frame = screen.frame();

    expect(frame).toContain('notes/todo.md');
    expect(frame).toContain('+2');
    expect(frame).toContain('new file');
    expect(frame).toContain('+ alpha');
    expect(frame).toContain('+ beta');
    expect(frame).not.toContain('−0');
  });

  test('collapsed shows the first hunk; Ctrl+O reveals the rest', async () => {
    const agent = fakeClient({ name: 'diffs' });
    const screen = await mountChat(agent.client, { width: 96 });

    agent.emit({
      type: 'tool-call', toolName: 'file', toolCallId: 'call-1',
      args: {
        action: 'edit',
        path: 'src/state.ts',
        edits: [
          { old_text: 'const one = 1;', new_text: 'const one = 101;' },
          { old_text: 'const two = 2;', new_text: 'const two = 202;' },
        ],
      },
    });
    agent.emit({
      type: 'tool-result', toolName: 'file', toolCallId: 'call-1',
      result: editResult('src/state.ts', [
        { line: 3, removed_lines: 1, added_lines: 1 },
        { line: 40, removed_lines: 1, added_lines: 1 },
      ]),
      success: true,
    });

    await screen.waitFor('the collapsed card', () => screen.frame().includes('+ const one = 101;'));
    expect(screen.frame()).not.toContain('+ const two = 202;');

    screen.mockInput.pressKey('o', { ctrl: true });
    await screen.waitFor('the expanded card', () => screen.frame().includes('+ const two = 202;'));

    const frame = screen.frame();
    expect(frame).toContain('− const one = 1;');
    expect(frame).toContain('− const two = 2;');
    // Two hunks, one separator between them.
    expect(frame).toContain('⋮');
  });

  test('the shared line budget caps a long card and counts what it held back', async () => {
    const agent = fakeClient({ name: 'diffs' });
    const content = Array.from({ length: EXPANDED_RESULT_LINES + 5 }, (_, index) => `line ${index + 1}`).join('\n');
    const screen = await mountChat(agent.client, { width: 96 });

    agent.emit({
      type: 'tool-call', toolName: 'file', toolCallId: 'call-1',
      args: { action: 'write', path: 'src/large.txt', content },
    });
    agent.emit({
      type: 'tool-result', toolName: 'file', toolCallId: 'call-1',
      result: writeResult('src/large.txt', 'created', content.length),
      success: true,
    });

    await screen.waitFor('the capped card', () => screen.frame().includes('more lines'));
    const frame = screen.frame();

    expect(frame).toContain(`line ${String(EXPANDED_RESULT_LINES)}`);
    expect(frame).not.toContain(`line ${String(EXPANDED_RESULT_LINES + 1)}`);
    expect(frame).toContain('+5 more lines');
  });

  test('a replaced file, whose earlier contents are nowhere, says the words', async () => {
    const agent = fakeClient({ name: 'diffs' });
    const screen = await mountChat(agent.client, { width: 96 });

    agent.emit({
      type: 'tool-call', toolName: 'file', toolCallId: 'call-1',
      args: { action: 'write', path: 'src/app.ts', content: 'const app = 1;\n' },
    });
    agent.emit({
      type: 'tool-result', toolName: 'file', toolCallId: 'call-1',
      result: writeResult('src/app.ts', 'replaced', 15),
      success: true,
    });

    await screen.waitFor('the unavailable card', () => screen.frame().includes('diff unavailable'));
    const frame = screen.frame();

    expect(frame).toContain('src/app.ts');
    expect(frame).toContain('replaced');
    expect(frame).not.toContain('"bytes"');
  });

  test('a file result whose call never reached the transcript keeps its true counts', async () => {
    const agent = fakeClient({ name: 'diffs' });
    const screen = await mountChat(agent.client, { width: 96 });

    agent.emit({
      type: 'tool-result', toolName: 'file', toolCallId: 'orphan',
      result: editResult('src/orphaned.ts', [{ line: 1, removed_lines: 2, added_lines: 3 }]),
      success: true,
    });

    await screen.waitFor('the counted card', () => screen.frame().includes('src/orphaned.ts'));
    const frame = screen.frame();

    expect(frame).toContain('+3');
    expect(frame).toContain('−2');
    expect(frame).toContain('diff unavailable');
  });

  test('a result pairs with its own call, not the nearest one of the same tool', async () => {
    const agent = fakeClient({ name: 'diffs' });
    const screen = await mountChat(agent.client, { width: 96 });

    agent.emit({
      type: 'tool-call', toolName: 'file', toolCallId: 'edit-a',
      args: { action: 'edit', path: 'a.ts', edits: [{ old_text: 'const one = 1;', new_text: 'const one = 101;' }] },
    });
    agent.emit({
      type: 'tool-call', toolName: 'file', toolCallId: 'edit-b',
      args: { action: 'edit', path: 'b.ts', edits: [{ old_text: 'const two = 2;', new_text: 'const two = 202;' }] },
    });
    // Results arrive in call order: positional pairing alone would hand
    // b.ts's call to a.ts's result.
    agent.emit({
      type: 'tool-result', toolName: 'file', toolCallId: 'edit-a',
      result: editResult('a.ts', [{ line: 1, removed_lines: 1, added_lines: 1 }]),
      success: true,
    });
    agent.emit({
      type: 'tool-result', toolName: 'file', toolCallId: 'edit-b',
      result: editResult('b.ts', [{ line: 9, removed_lines: 1, added_lines: 1 }]),
      success: true,
    });
    await screen.waitFor('both cards', () => screen.frame().includes('+ const two = 202;'));
    const frame = screen.frame();

    expect(frame).toContain('a.ts');
    expect(frame).toContain('− const one = 1;');
    expect(frame).toContain('+ const one = 101;');
    expect(frame).toContain('b.ts');
    expect(frame).toContain('− const two = 2;');
    // A wrong pairing would have failed the path check and left a card
    // worded "diff unavailable" instead of these hunks.
    expect(frame).not.toContain('diff unavailable');
  });

  test('a refused edit stays a text row', async () => {
    const agent = fakeClient({ name: 'diffs' });
    const screen = await mountChat(agent.client, { width: 96 });

    agent.emit({
      type: 'tool-call', toolName: 'file', toolCallId: 'call-1',
      args: { action: 'edit', path: 'src/state.ts', edits: [{ old_text: 'nope', new_text: 'yep' }] },
    });
    agent.emit({
      type: 'tool-result', toolName: 'file', toolCallId: 'call-1',
      result: 'old_text does not appear in src/state.ts',
      success: false, reason: 'not_found',
    });

    await screen.waitFor('the refusal row', () => screen.frame().includes('does not appear'));
    const frame = screen.frame();

    expect(frame).toContain('✗');
    expect(frame).not.toContain('+1');
    expect(frame).not.toContain('diff unavailable');
  });
});

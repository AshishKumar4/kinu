/** @jsxImportSource @opentui/react */
/** The composer against wrapped one-line drafts, which a `split('\n')` row count cannot see. */
import { afterEach, describe, expect, test } from 'bun:test';
import { composerVisibleRows } from '@kinu.run/core';
import { cleanupChats, fakeClient, mountChat } from './helpers/chat-app-fixture';

const CAP = composerVisibleRows(10_000);

afterEach(cleanupChats);

/** Rows of the composer box, border to border; it is the last rounded box on screen. */
function composerBoxRows(frame: string): string[] {
  const lines = frame.split('\n');
  let bottom = -1;

  for (let index = lines.length - 1; index >= 0; index -= 1) {
    if (lines[index].startsWith('╰')) { bottom = index; break; }
  }

  if (bottom < 0) throw new Error(`no closed box in frame:\n${frame}`);
  let top = -1;

  for (let index = bottom - 1; index >= 0; index -= 1) {
    if (lines[index].startsWith('╭')) { top = index; break; }
  }

  if (top < 0) throw new Error(`composer box never opens in frame:\n${frame}`);

  return lines.slice(top, bottom + 1);
}

function composerDraftRows(frame: string): string[] {
  return composerBoxRows(frame).slice(1, -1).map((row) => row.replace(/^│\s?/, '').replace(/\s*│$/, ''));
}

describe('the composer over wrapped drafts', () => {
  test('one long typed line grows the composer row for row as it wraps', async () => {
    const agent = fakeClient({ name: 'wrapper' });
    const screen = await mountChat(agent.client, { width: 60 });
    const before = composerDraftRows(screen.frame()).length;
    expect(before).toBe(1);

    await screen.mockInput.typeText('cornbread '.repeat(30).trim());
    await screen.waitFor('the composer to grow past one row', () => composerDraftRows(screen.frame()).length > 1);

    const rows = composerDraftRows(screen.frame());
    const filled = rows.filter((row) => row.trim() !== '');
    expect(filled.length).toBeGreaterThan(3);

    for (const row of composerBoxRows(screen.frame()).slice(1, -1)) expect(row.startsWith('│')).toBe(true);
    expect(composerBoxRows(screen.frame()).at(-1)).not.toContain('cornbread');
    expect(filled.join(' ').replace(/\s+/g, ' ')).toContain('cornbread cornbread cornbread');
  });

  test('a draft past the cap stops growing and scrolls to the cursor instead', async () => {
    const agent = fakeClient({ name: 'capper' });
    const screen = await mountChat(agent.client, { width: 60 });

    const words = Array.from({ length: 120 }, (_, index) => `w${String(index).padStart(3, '0')}`);
    await screen.mockInput.typeText(words.join(' '));
    await screen.waitFor('the composer to reach its cap', () => composerDraftRows(screen.frame()).length === CAP);

    const rows = composerDraftRows(screen.frame());
    expect(rows.length).toBe(CAP);
    // The cursor is at the end, so the capped window shows the end of the draft.
    expect(rows.join(' ')).toContain('w119');
    expect(rows.join(' ')).not.toContain('w000');

    await screen.mockInput.typeText(' tail');
    await screen.waitFor('the tail to reach the visible window', () => composerDraftRows(screen.frame()).join(' ').includes('tail'));
    expect(composerDraftRows(screen.frame()).length).toBe(CAP);
  });

  test('wide glyphs wrap by display columns, not by character count', async () => {
    const agent = fakeClient({ name: 'cjk' });
    const screen = await mountChat(agent.client, { width: 40 });

    // 40 CJK chars at two columns each: two rows by character count, more by columns.
    await screen.mockInput.typeText('世界'.repeat(20));
    await screen.waitFor('the wide draft to wrap', () => composerDraftRows(screen.frame()).length > 1);

    const rows = composerDraftRows(screen.frame()).filter((row) => row.trim() !== '');
    expect(rows.length).toBeGreaterThanOrEqual(3);

    for (const row of rows) expect(row.length).toBeLessThanOrEqual(38);
    expect(rows.join('')).toContain('世界世界');
  });

  test('a draft of multi-code-point clusters is sized by what the editor wrapped', async () => {
    const agent = fakeClient({ name: 'emoji' });
    const screen = await mountChat(agent.client, { width: 40 });

    // A ZWJ cluster is neither one column nor one character; the composer must show exactly the rows the editor wrapped.
    await screen.mockInput.typeText('👨‍👩‍👧‍👦 family '.repeat(6).trim());
    await screen.waitFor('the cluster draft to wrap', () => composerDraftRows(screen.frame()).length > 1);
    const editor = screen.renderer.currentFocusedEditor;

    if (!editor) throw new Error('the composer never took focus');
    expect(composerDraftRows(screen.frame()).length)
      .toBe(Math.min(CAP, editor.editorView.getTotalVirtualLineCount()));

    screen.mockInput.pressEnter();
    await screen.waitFor('the composer to shrink back after sending', () => composerDraftRows(screen.frame()).length === 1);
    expect(screen.frame()).toContain('family');
  });

  test('a newline keystroke wraps its own line and Enter still submits', async () => {
    const agent = fakeClient({ name: 'seams' });
    // The test terminal speaks kitty: legacy bytes cannot express the newline chord, and Ctrl+J
    // is byte-identical with Enter-as-LF (0x0A), which submits.
    const screen = await mountChat(agent.client, { width: 60, kittyKeyboard: true });

    await screen.mockInput.typeText('first '.repeat(12).trim());
    screen.mockInput.pressKey('j', { ctrl: true });
    await screen.mockInput.typeText('second');
    await screen.waitFor('both lines to be on screen', () => {
      const rows = composerDraftRows(screen.frame()).join(' ');

      return rows.includes('second') && rows.includes('first');
    });
    expect(composerDraftRows(screen.frame()).filter((row) => row.trim() !== '').length).toBeGreaterThan(2);

    screen.mockInput.pressEnter();
    await screen.waitFor('the multi-line draft to leave the composer', () => composerDraftRows(screen.frame()).length === 1);
    expect(screen.frame()).toContain('second');
    expect(screen.frame()).toContain('first');
  });
});

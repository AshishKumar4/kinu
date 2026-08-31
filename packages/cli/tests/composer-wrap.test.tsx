/** @jsxImportSource @opentui/react */
/**
 * The composer against WRAPPED drafts — the case a line count cannot see.
 *
 * These drive the real editor: the frame is what a person would read, and the
 * composer's border rows are where its height is asserted. Every draft here is
 * one typed line, so a composer sized by `split('\n')` renders exactly one row
 * of it and fails these.
 */
import { afterEach, describe, expect, test } from 'bun:test';

/** Mirrors the private eight-row cap; drift fails these tests, which is the point. */
const COMPOSER_MAX_ROWS = 8;
import { cleanupChats, fakeClient, mountChat } from './helpers/chat-app-fixture';

afterEach(cleanupChats);

/** Rows of the composer box: its top border through its bottom border. The
 *  status bar draws a box too, so the composer is the LAST box on screen —
 *  it sits under the transcript, at the bottom of the scene. */
function composerBoxRows(frame: string): string[] {
  const lines = frame.split('\n');
  let bottom = -1;
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    if (lines[index]!.startsWith('└')) { bottom = index; break; }
  }
  if (bottom < 0) throw new Error(`no closed box in frame:\n${frame}`);
  let top = -1;
  for (let index = bottom - 1; index >= 0; index -= 1) {
    if (lines[index]!.startsWith('┌')) { top = index; break; }
  }
  if (top < 0) throw new Error(`composer box never opens in frame:\n${frame}`);
  return lines.slice(top, bottom + 1);
}

/** Content rows only — the draft as it is actually laid out on screen. */
function composerDraftRows(frame: string): string[] {
  return composerBoxRows(frame).slice(1, -1).map((row) => row.replace(/^│\s?/, '').replace(/\s*│$/, ''));
}

describe('the composer over wrapped drafts', () => {
  test('one long typed line grows the composer row for row as it wraps', async () => {
    const agent = fakeClient({ name: 'wrapper' });
    const screen = await mountChat(agent.client, { width: 60 });
    const before = composerDraftRows(screen.frame()).length;
    expect(before).toBe(1);

    // 300 characters of one line: no newline anywhere, so only the wrap can
    // make it more than one row.
    await screen.mockInput.typeText('cornbread '.repeat(30).trim());
    await screen.waitFor('the composer to grow past one row', () => composerDraftRows(screen.frame()).length > 1);

    const rows = composerDraftRows(screen.frame());
    const filled = rows.filter((row) => row.trim() !== '');
    expect(filled.length).toBeGreaterThan(3);
    // Every row is inside the box: no draft text bleeds onto a border row.
    for (const row of composerBoxRows(screen.frame()).slice(1, -1)) expect(row.startsWith('│')).toBe(true);
    expect(composerBoxRows(screen.frame()).at(-1)).not.toContain('cornbread');
    // The whole draft is on screen, in order, across the rows it wrapped to.
    expect(filled.join(' ').replace(/\s+/g, ' ')).toContain('cornbread cornbread cornbread');
  });

  test('a draft past the cap stops growing and scrolls to the cursor instead', async () => {
    const agent = fakeClient({ name: 'capper' });
    const screen = await mountChat(agent.client, { width: 60 });

    // Numbered words so which wrapped rows are on screen is an exact read.
    const words = Array.from({ length: 120 }, (_, index) => `w${String(index).padStart(3, '0')}`);
    await screen.mockInput.typeText(words.join(' '));
    await screen.waitFor('the composer to reach its cap', () => composerDraftRows(screen.frame()).length === COMPOSER_MAX_ROWS);

    const rows = composerDraftRows(screen.frame());
    expect(rows.length).toBe(COMPOSER_MAX_ROWS);
    // The cursor sits at the end of the draft, so the END of the draft is what
    // the capped window shows — the earlier rows scrolled out of it.
    expect(rows.join(' ')).toContain('w119');
    expect(rows.join(' ')).not.toContain('w000');

    // Typing one more character keeps the cap and keeps the cursor in view.
    await screen.mockInput.typeText(' tail');
    await screen.waitFor('the tail to reach the visible window', () => composerDraftRows(screen.frame()).join(' ').includes('tail'));
    expect(composerDraftRows(screen.frame()).length).toBe(COMPOSER_MAX_ROWS);
  });

  test('wide glyphs wrap by display columns, not by character count', async () => {
    const agent = fakeClient({ name: 'cjk' });
    const screen = await mountChat(agent.client, { width: 40 });

    // 40 CJK characters at two columns each: 80 columns of content in a
    // composer whose interior is well under that, so it must wrap. Counted as
    // characters it would fit in two rows; counted as columns it cannot.
    await screen.mockInput.typeText('世界'.repeat(20));
    await screen.waitFor('the wide draft to wrap', () => composerDraftRows(screen.frame()).length > 1);

    const rows = composerDraftRows(screen.frame()).filter((row) => row.trim() !== '');
    expect(rows.length).toBeGreaterThanOrEqual(3);
    // No row overflows the interior, and the wide glyphs are never split.
    for (const row of rows) expect(row.length).toBeLessThanOrEqual(38);
    expect(rows.join('')).toContain('世界世界');
  });

  test('a draft of multi-code-point clusters is sized by what the editor wrapped', async () => {
    const agent = fakeClient({ name: 'emoji' });
    const screen = await mountChat(agent.client, { width: 40 });

    // A four-person ZWJ cluster is not one column and not one character; the
    // editor charges it its rendered columns. Whatever that comes to, the
    // composer must show exactly the rows the editor wrapped the draft into —
    // that agreement is the fix, and a cluster draft is where a character
    // count or a line count would disagree.
    await screen.mockInput.typeText('👨‍👩‍👧‍👦 family '.repeat(6).trim());
    await screen.waitFor('the cluster draft to wrap', () => composerDraftRows(screen.frame()).length > 1);
    const editor = screen.renderer.currentFocusedEditor;
    if (!editor) throw new Error('the composer never took focus');
    expect(composerDraftRows(screen.frame()).length)
      .toBe(Math.min(COMPOSER_MAX_ROWS, editor.editorView.getTotalVirtualLineCount()));

    // Enter sends: the draft leaves the composer whole (the transcript keeps
    // the words; a char-grid capture cannot render the cluster itself) and the
    // emptied composer shrinks back to its one row.
    screen.mockInput.pressEnter();
    await screen.waitFor('the composer to shrink back after sending', () => composerDraftRows(screen.frame()).length === 1);
    expect(screen.frame()).toContain('family');
  });

  test('a newline keystroke wraps its own line and Enter still submits', async () => {
    const agent = fakeClient({ name: 'seams' });
    const screen = await mountChat(agent.client, { width: 60 });

    await screen.mockInput.typeText('first '.repeat(12).trim());
    // The contract this scene ships: Enter sends, and the newline binding
    // opens a line. Ctrl+J is the one a terminal without the kitty protocol
    // can actually encode — Shift+Enter reaches such a terminal as Enter.
    screen.mockInput.pressKey('\n');
    await screen.mockInput.typeText('second');
    await screen.waitFor('both lines to be on screen', () => {
      const rows = composerDraftRows(screen.frame()).join(' ');
      return rows.includes('second') && rows.includes('first');
    });
    // Two typed lines, the first of them wrapped: more rows than typed lines.
    expect(composerDraftRows(screen.frame()).filter((row) => row.trim() !== '').length).toBeGreaterThan(2);

    screen.mockInput.pressEnter();
    await screen.waitFor('the multi-line draft to leave the composer', () => composerDraftRows(screen.frame()).length === 1);
    expect(screen.frame()).toContain('second');
    expect(screen.frame()).toContain('first');
  });
});

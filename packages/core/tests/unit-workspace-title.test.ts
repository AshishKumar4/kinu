/**
 * `workspaceDisplayTitle` is the one answer every surface gives for a
 * workspace's name. The defect this pins: a workspace born without a purpose
 * stores ITS OWN SLUG as `display_name`, and rendering that string put
 * `handwrought-walnut-4166c321` across the owner's header, sidebar and tabs.
 * The slug stays a valid address — it is only wrong as a name.
 */
import { describe, expect, test } from 'bun:test';

import { workspaceDisplayTitle, workspaceTitleDraft } from '../src/read-models/workspace-title';

describe('workspaceDisplayTitle', () => {
  test('a real title is what the surface shows', () => {
    expect(workspaceDisplayTitle({ name: 'ashen-kiln-386c2ec1', displayName: 'Fix the kiln' })).toBe('Fix the kiln');
  });

  test('absent, blank and slug-stored titles all read as one shared label', () => {
    // The property, not the words: every untitled shape answers the same
    // non-empty label, and that label is never the slug. The visible words
    // are asserted once, inline in the browser gate, which reads them from
    // the rendered page and placeholder.
    const blank = workspaceDisplayTitle({ name: 'ashen-kiln-386c2ec1', displayName: null });
    const missing = workspaceDisplayTitle({ name: 'ashen-kiln-386c2ec1', displayName: undefined });
    const spaces = workspaceDisplayTitle({ name: 'ashen-kiln-386c2ec1', displayName: '   ' });
    const echo = workspaceDisplayTitle({ name: 'ashen-kiln-386c2ec1', displayName: 'ashen-kiln-386c2ec1' });

    for (const label of [blank, missing, spaces, echo]) {
      expect(label.length).toBeGreaterThan(0);
      expect(label).not.toBe('ashen-kiln-386c2ec1');
    }

    expect(new Set([blank, missing, spaces, echo]).size).toBe(1);
  });

  test('a title that merely LOOKS slug-like still shows — it was chosen', () => {
    // "The id never renders as a title" means the STORED-AS-ID echo, not any
    // string with hyphens: an owner who named a workspace after the slug made
    // a choice the surface honours.
    expect(workspaceDisplayTitle({ name: 'ashen-kiln-386c2ec1', displayName: 'ashen-kiln' })).toBe('ashen-kiln');
  });
});

describe('workspaceTitleDraft', () => {
  // The rename field opens on the STORED title, not the shown one: an
  // untitled workspace's field opens EMPTY, because pre-filling "Untitled
  // workspace" would persist the label as the name on a save without edits.
  test('a real title is what the field opens with', () => {
    expect(workspaceTitleDraft({ name: 'ashen-kiln-386c2ec1', displayName: 'Fix the kiln' })).toBe('Fix the kiln');
  });

  test('absent, blank and slug-stored titles all open empty', () => {
    expect(workspaceTitleDraft({ name: 'ashen-kiln-386c2ec1', displayName: null })).toBe('');
    expect(workspaceTitleDraft({ name: 'ashen-kiln-386c2ec1', displayName: '  ' })).toBe('');
    expect(workspaceTitleDraft({ name: 'ashen-kiln-386c2ec1', displayName: 'ashen-kiln-386c2ec1' })).toBe('');
  });
});

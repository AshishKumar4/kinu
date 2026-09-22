/** A workspace stored with its own slug as `display_name` must not render the slug as its name. */
import { describe, expect, test } from 'bun:test';

import { workspaceDisplayTitle, workspaceTitleDraft } from '../src/read-models/workspace-title';

describe('workspaceDisplayTitle', () => {
  test('a real title is what the surface shows', () => {
    expect(workspaceDisplayTitle({ name: 'ashen-kiln-386c2ec1', displayName: 'Fix the kiln' })).toBe('Fix the kiln');
  });

  test('absent, blank and slug-stored titles all read as one shared label', () => {
    // Every untitled shape yields the same non-empty label, never the slug.
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
    // Only the stored-as-id echo is suppressed; an owner may deliberately name it after the slug.
    expect(workspaceDisplayTitle({ name: 'ashen-kiln-386c2ec1', displayName: 'ashen-kiln' })).toBe('ashen-kiln');
  });
});

describe('workspaceTitleDraft', () => {
  // The rename field opens empty for an untitled workspace, so saving without edits keeps it untitled.
  test('a real title is what the field opens with', () => {
    expect(workspaceTitleDraft({ name: 'ashen-kiln-386c2ec1', displayName: 'Fix the kiln' })).toBe('Fix the kiln');
  });

  test('absent, blank and slug-stored titles all open empty', () => {
    expect(workspaceTitleDraft({ name: 'ashen-kiln-386c2ec1', displayName: null })).toBe('');
    expect(workspaceTitleDraft({ name: 'ashen-kiln-386c2ec1', displayName: '  ' })).toBe('');
    expect(workspaceTitleDraft({ name: 'ashen-kiln-386c2ec1', displayName: 'ashen-kiln-386c2ec1' })).toBe('');
  });
});

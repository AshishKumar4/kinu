/**
 * `workspaceDisplayTitle` is the one answer every surface gives for a
 * workspace's name. The defect this pins: a workspace born without a purpose
 * stores ITS OWN SLUG as `display_name`, and rendering that string put
 * `handwrought-walnut-4166c321` across the owner's header, sidebar and tabs.
 * The slug stays a valid address — it is only wrong as a name.
 */
import { describe, expect, test } from 'bun:test';

import { workspaceDisplayTitle, workspaceTitleDraft } from '../src/read-models/workspace-title';

/** The one string every untitled surface shares, pinned as a literal: the
 *  constant is module-private on purpose (surfaces ask the helper), so this
 *  literal is the pin that keeps the label itself from drifting. */
const UNTITLED = 'Untitled workspace';

describe('workspaceDisplayTitle', () => {
  test('a real title is what the surface shows', () => {
    expect(workspaceDisplayTitle({ name: 'ashen-kiln-386c2ec1', displayName: 'Fix the kiln' })).toBe('Fix the kiln');
  });

  test('absent and blank titles read as the untitled label', () => {
    expect(workspaceDisplayTitle({ name: 'ashen-kiln-386c2ec1', displayName: null })).toBe(UNTITLED);
    expect(workspaceDisplayTitle({ name: 'ashen-kiln-386c2ec1', displayName: undefined })).toBe(UNTITLED);
    expect(workspaceDisplayTitle({ name: 'ashen-kiln-386c2ec1', displayName: '   ' })).toBe(UNTITLED);
  });

  test('a stored slug is a placeholder, never a title', () => {
    // The create-without-purpose row: display_name holds the slug itself.
    expect(workspaceDisplayTitle({ name: 'ashen-kiln-386c2ec1', displayName: 'ashen-kiln-386c2ec1' }))
      .toBe(UNTITLED);
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

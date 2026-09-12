/**
 * The composer's status row as the reader sees it.
 *
 * The workspace load failure arrives as a structured notice (blocking vs
 * partial), and this suite proves what the composer does with each half: a
 * partial failure renders a warning that names the resource, keeps its retry,
 * and — the property K-02 exists for — leaves the textarea and Send enabled.
 * A blocking failure renders an alert. The raw reason is available inside the
 * "Technical details" disclosure, never only in a hover title.
 *
 * Rendered through `renderToStaticMarkup`: the real `Notice` path the page
 * mounts, with no effects needed — tone, role, title, disclosure, and the
 * enabled controls are all derived from props.
 */
import './helpers/ui-module-globals';
import { describe, expect, test } from 'bun:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  Composer,
  workspaceLoadNotice,
  type ComposerNotice,
} from '../src/components/Composer';
import type { WorkspaceNotice } from '../src/hooks/use-kinu';

const BLOCKING: WorkspaceNotice = {
  severity: 'blocking',
  title: "Couldn't open this workspace",
  scope: 'Nothing has loaded yet.',
  detail: 'Network connection lost.',
  retry: 'Retry',
};

const PARTIAL: WorkspaceNotice = {
  severity: 'partial',
  title: 'Tools could not be refreshed.',
  scope: 'The conversation is available. Showing last known data.',
  detail: 'catalog offline',
  retry: 'Retry loading tools',
};

const ACTION_ONLY: WorkspaceNotice = {
  severity: 'partial',
  title: "Couldn't switch model: rejected",
  scope: '',
  detail: '',
  retry: null,
};

function markupFor(notices: readonly ComposerNotice[]): string {
  return renderToStaticMarkup(createElement(Composer, {
    value: '',
    onValueChange: () => {},
    onSend: () => {},
    placeholder: 'Send a message...',
    disabled: false,
    streaming: false,
    onStop: () => {},
    notices,
  }));
}

describe('workspaceLoadNotice', () => {
  test('a blocking notice renders danger with its retry', () => {
    expect(workspaceLoadNotice(BLOCKING, () => {})).toEqual({
      id: 'load',
      tone: 'danger',
      title: "Couldn't open this workspace",
      text: 'Nothing has loaded yet.',
      detail: 'Network connection lost.',
      action: expect.objectContaining({ label: 'Retry' }),
    });
  });

  test('a partial notice renders warning with the scoped retry', () => {
    const notice = workspaceLoadNotice(PARTIAL, () => {});
    expect(notice.tone).toBe('warning');
    expect(notice.title).toBe('Tools could not be refreshed.');
    expect(notice.action?.label).toBe('Retry loading tools');
  });

  test('an action-only failure carries no retry to promise', () => {
    const notice = workspaceLoadNotice(ACTION_ONLY, () => {});
    expect(notice).toEqual({
      id: 'load',
      tone: 'warning',
      title: "Couldn't switch model: rejected",
    });
  });
});

describe('the composer under a partial failure', () => {
  test('the warning names the resource, keeps its retry, and leaves the composer enabled', () => {
    const html = markupFor([workspaceLoadNotice(PARTIAL, () => {})]);
    expect(html).toContain('Tools could not be refreshed.');
    expect(html).toContain('Retry loading tools');
    expect(html).toContain('Technical details');
    expect(html).toContain('catalog offline');
    expect(html).toContain('role="status"');
    expect(html).not.toContain('role="alert"');
    const textarea = /<textarea[^>]*>/.exec(html)?.[0] ?? '';
    expect(textarea).not.toMatch(/(^|\s)disabled(=|\s|>)/);
    expect(html).toContain('aria-label="Send"');
  });

  test('a blocking failure renders an alert with the open sentence', () => {
    const html = markupFor([workspaceLoadNotice(BLOCKING, () => {})]);
    expect(html).toContain('open this workspace');
    expect(html).toContain('Retry');
  });
});

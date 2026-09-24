/**
 * What you type at workspace creation is its mission, not an opening user turn: replaying it as a prompt got a reply
 * treating a standing brief as a task. Before its first turn a workspace shows the mission as its brief, read the way
 * the page reads it: the SOUL.md creation writes, summarized into the status's `purpose`.
 */
import './helpers/ui-module-globals';
import { describe, expect, test } from 'bun:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { renderSoulMarkdown, summarizeSoul } from '@kinu.run/core';
import { EmptyConversation } from '../src/pages/WorkspacePage';

/** The empty conversation of a workspace created with `mission`, as the page renders it from the status. */
function emptyConversation(mission?: string): string {
  const purpose = summarizeSoul(renderSoulMarkdown({ name: 'Checkout', mission }));

  return renderToStaticMarkup(createElement(EmptyConversation, { mission: purpose }));
}

describe('a workspace before its first turn', () => {
  test('shows the mission it was created with as its brief', () => {
    const mission = 'Audit the checkout flow end to end and fix what breaks';

    expect(emptyConversation(mission)).toContain(mission);
  });

  test('a workspace created without a mission shows no brief, not the seeded placeholder', () => {
    const seeded = summarizeSoul(renderSoulMarkdown({ name: 'Checkout' }));

    expect(seeded).not.toBe('');
    expect(emptyConversation()).not.toContain(seeded);
  });
});

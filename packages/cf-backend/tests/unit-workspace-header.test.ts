/**
 * The workspace bar's contract with the person and with assistive tech: a named list of chats with the open one
 * marked, the workspace's name leading to its overview rather than into a rename, Main renamed but never deleted,
 * and every icon control named.
 */
import './helpers/ui-module-globals';
import { describe, expect, test } from 'bun:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import type { PanelAgent } from '@kinu.run/core';
import { WorkspaceHeader, type ChatTab } from '../src/components/WorkspaceHeader';

const chat = (key: string, label: string, path: string | null, activity: PanelAgent['activity']): PanelAgent => ({
  key, label, category: path === null ? 'main' : 'user', activity, parent: path === null ? null : 'main',
  open: { kind: 'chat', path }, tab: true, input: true, figures: { activeMs: 0, cacheEma: null },
});

const CHATS: ChatTab[] = [
  { agent: chat('main', 'Main', null, 'working'), to: '/workspace/kiln', rename: async () => {} },
  { agent: chat('actor-docs', 'Release notes', 'docs', 'waiting'), to: '/workspace/kiln/agents/docs', rename: async () => {}, remove: () => {} },
];

function bar(active: string | null): string {
  return renderToStaticMarkup(createElement(MemoryRouter, null, createElement(WorkspaceHeader, {
    workspace: { name: 'kiln', title: 'Fix the kiln', to: '/workspace/kiln/overview', editValue: 'Fix the kiln', rename: async () => {}, remove: () => {} },
    chats: CHATS, active, newChat: '/workspace/kiln/new',
  })));
}

/** Each opening tag of an element, as the markup writes it. */
const openingTags = (html: string, tag: string): string[] => html.split(`<${tag} `).slice(1).map((rest) => rest.slice(0, rest.indexOf('>')));

describe('the workspace bar', () => {
  test('its chats are a named list, and only the open one is the current page', () => {
    const html = bar('actor-docs');
    const current = openingTags(html, 'a').filter((tag) => tag.includes('aria-current="page"'));

    expect(html).toContain('aria-label="Chats"><ul');
    expect(current).toHaveLength(1);
    expect(current[0]).toContain('href="/workspace/kiln/agents/docs"');
  });

  test('the workspace name opens the overview; renaming it takes its own control', () => {
    const html = bar('main');
    const name = openingTags(html, 'a').find((tag) => tag.includes('title="Workspace overview"'));

    expect(name).toContain('href="/workspace/kiln/overview"');
    expect(html).toContain('aria-label="Rename Fix the kiln"');
    expect(html).toContain('aria-label="Delete Fix the kiln"');
  });

  test('Main can be renamed but never deleted; a chat the person opened can be both', () => {
    const html = bar('main');

    expect(html).toContain('aria-label="Rename Main"');
    expect(html).not.toContain('aria-label="Delete Main"');
    expect(html).toContain('aria-label="Rename Release notes"');
    expect(html).toContain('aria-label="Delete Release notes"');
  });

  test('every icon control has a name, and a status mark says what it shows', () => {
    const html = bar('main');

    for (const tag of openingTags(html, 'button')) expect(tag).toContain('aria-label="');

    expect(openingTags(html, 'a').find((tag) => tag.includes('aria-label="New chat"'))).toContain('href="/workspace/kiln/new"');
    expect(html).toContain('role="img" aria-label="Working"');
    expect(html).toContain('role="img" aria-label="Needs you"');
  });
});

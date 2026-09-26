/**
 * The sidebar before the roster has answered: it claims nothing about the account's workspaces, and its list says it
 * is loading. A roster drawn as "No workspaces yet." while its first read is outstanding is a false statement to the
 * person, and to a check it is indistinguishable from an account with none.
 */
import './helpers/ui-module-globals';
import { expect, test } from 'bun:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import Sidebar from '../src/components/Sidebar';
import { AccountProvider } from '../src/hooks/use-account';
import { WorkspaceRosterProvider } from '../src/hooks/use-workspace-roster';

test('a roster whose first read has not answered is drawn busy, never as empty', () => {
  // Static markup runs no effect, so the roster's first read is still to come: the page whose roster socket is opening.
  const page = createElement(MemoryRouter, { initialEntries: ['/workspace/ws-a'] }, createElement(Sidebar));
  const roster = createElement(WorkspaceRosterProvider, { live: null, children: page });
  const markup = renderToStaticMarkup(createElement(AccountProvider, { children: roster }));

  expect(markup).not.toContain('No workspaces yet.');
  expect(markup).toContain('aria-busy="true"');
});

/**
 * rc28 walkthrough: a signed-in path no page answers drew a blank page, HTTP 200, with no way on. Paths are matched
 * against the app's own route tree: one no page answers opens the not-found page inside the rail, and the catch-all
 * shadows no page of its own.
 */
import './helpers/ui-module-globals';
import { describe, expect, test } from 'bun:test';
import { isValidElement, type ReactElement, type ReactNode } from 'react';
import { createRoutesFromChildren, matchRoutes } from 'react-router-dom';
import * as v from 'valibot';
import App from '../src/App';
import Layout from '../src/components/layout';

const ElementSchema = v.custom<ReactElement>(isValidElement);

const ParentSchema = v.object({ children: v.custom<ReactNode>(() => true) });

/** What `App` draws: its router, holding its `<Routes>`, holding the tree. `App` keeps no state, so it is called as drawn. */
function appTree(): ReactNode {
  const routes = v.parse(ParentSchema, v.parse(ElementSchema, App()).props).children;

  return v.parse(ParentSchema, v.parse(ElementSchema, routes).props).children;
}

const ROUTES = createRoutesFromChildren(appTree());

const PageSchema = v.object({ label: v.string() });

/** The page a path opens, by its `Page` label, and whether the rail's `Layout` frames it; null where nothing matches. */
function opened(path: string): { page: string; framed: boolean } | null {
  const matches = matchRoutes(ROUTES, path) ?? [];
  const leaf = matches.at(-1)?.route.element;

  if (!isValidElement(leaf)) return null;

  return {
    page: v.parse(PageSchema, leaf.props).label,
    framed: matches.some((match) => isValidElement(match.route.element) && match.route.element.type === Layout),
  };
}

describe('a path the app routes', () => {
  test('that no page answers opens the not-found page, inside the rail', () => {
    expect(opened('/this-page-does-not-exist')).toEqual({ page: 'not-found', framed: true });
    expect(opened('/user/settings/nothing-here')).toEqual({ page: 'not-found', framed: true });
  });

  test("that a page answers still opens it: the catch-all shadows none of the app's own", () => {
    expect(opened('/')).toEqual({ page: 'home', framed: true });
    expect(opened('/user/settings')).toEqual({ page: 'user-settings', framed: true });
    expect(opened('/workspace/acme-billing')).toEqual({ page: 'workspace', framed: true });
    expect(opened('/explore')).toEqual({ page: 'explore', framed: true });
    expect(opened('/connected')).toEqual({ page: 'connected', framed: false });
  });
});

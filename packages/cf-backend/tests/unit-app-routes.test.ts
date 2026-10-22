/**
 * rc28 walkthrough: a signed-in path no page answers drew a blank page, HTTP 200, with no way on; and Explore, public by
 * its API, sent a visitor to sign in. Paths are matched against the app's own route trees: the signed-in one opens a
 * not-found page inside the rail where no page answers, and a visitor's opens Explore under the public bar.
 */
import './helpers/ui-module-globals';
import { describe, expect, test } from 'bun:test';
import { isValidElement, type ReactElement, type ReactNode } from 'react';
import { createRoutesFromChildren, matchRoutes } from 'react-router-dom';
import * as v from 'valibot';
import App from '../src/App';
import GalleryShell, { VisitorShell } from '../src/components/gallery/GalleryShell';
import Layout from '../src/components/layout';

const ElementSchema = v.custom<ReactElement>(isValidElement);

const ParentSchema = v.object({ children: v.custom<ReactNode>(() => true) });

const PageSchema = v.object({ label: v.string() });

const FRAMES = new Map<unknown, string>([[Layout, 'rail'], [VisitorShell, 'visitor'], [GalleryShell, 'gallery']]);

/** What `App` draws: its router, holding its `<Routes>`, holding the tree. `App` keeps no state, so it is called as drawn. */
function routesOf(visitor: boolean) {
  const routes = v.parse(ParentSchema, v.parse(ElementSchema, App({ visitor })).props).children;

  return createRoutesFromChildren(v.parse(ParentSchema, v.parse(ElementSchema, routes).props).children);
}

const SIGNED_IN = routesOf(false);

const VISITOR = routesOf(true);

/** The page a path opens, by its `Page` label, and the frame around it; null where nothing matches. */
function opened(routes: ReturnType<typeof routesOf>, path: string): { page: string; frame: string | null } | null {
  const matches = matchRoutes(routes, path) ?? [];
  const leaf = matches.at(-1)?.route.element;

  if (!isValidElement(leaf)) return null;
  const frames = matches.flatMap((match) => (isValidElement(match.route.element) ? [FRAMES.get(match.route.element.type)] : []));

  return { page: v.parse(PageSchema, leaf.props).label, frame: frames.find((frame) => frame !== undefined) ?? null };
}

describe('a path the signed-in app routes', () => {
  test('that no page answers opens the not-found page, inside the rail', () => {
    expect(opened(SIGNED_IN, '/this-page-does-not-exist')).toEqual({ page: 'not-found', frame: 'rail' });
    expect(opened(SIGNED_IN, '/user/settings/nothing-here')).toEqual({ page: 'not-found', frame: 'rail' });
  });

  test("that a page answers still opens it: the catch-all shadows none of the app's own", () => {
    expect(opened(SIGNED_IN, '/')).toEqual({ page: 'home', frame: 'rail' });
    expect(opened(SIGNED_IN, '/user/settings')).toEqual({ page: 'user-settings', frame: 'rail' });
    expect(opened(SIGNED_IN, '/workspace/acme-billing')).toEqual({ page: 'workspace', frame: 'rail' });
    expect(opened(SIGNED_IN, '/explore')).toEqual({ page: 'explore', frame: 'rail' });
    expect(opened(SIGNED_IN, '/gallery/ravi/pr-board')).toEqual({ page: 'gallery-slate', frame: 'gallery' });
    expect(opened(SIGNED_IN, '/connected')).toEqual({ page: 'connected', frame: null });
  });
});

describe("a visitor's page", () => {
  test("opens Explore and a blueprint's page under the public bar, and a listed slate's page as anyone sees it", () => {
    expect(opened(VISITOR, '/explore')).toEqual({ page: 'explore', frame: 'visitor' });
    expect(opened(VISITOR, '/explore/workspaces/personal-assistant')).toEqual({ page: 'explore-workspace', frame: 'visitor' });
    expect(opened(VISITOR, '/gallery/ravi/pr-board')).toEqual({ page: 'gallery-slate', frame: 'gallery' });
  });

  test('sends any other path to the server, which asks for sign-in first', () => {
    expect(opened(VISITOR, '/')).toEqual({ page: 'server', frame: null });
    expect(opened(VISITOR, '/workspace/acme-billing')).toEqual({ page: 'server', frame: null });
  });
});

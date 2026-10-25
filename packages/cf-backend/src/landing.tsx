import { createRoot, hydrateRoot } from 'react-dom/client';
import * as v from 'valibot';

import { requestUrl } from '@kinu.run/core';
import { LANDING_ACCOUNT_READS } from '@/components/landing/landing-fixtures';
import { LandingPage } from '@/components/landing/LandingPage';
import type { ConfigRow } from '@/lib/user-api';
import { publicRoot } from './public-page';

// The static landing serves no `/api/`: its real components' account reads are answered here, and nothing under it
// reaches a server, which would only refuse a page without a session.

const realFetch = window.fetch.bind(window);

const SETTINGS_PATH = '/api/user/config/';

const SettingWriteSchema = v.object({ value: v.string() });

/** The settings chosen on this page, read back until it is left: a sample has no account to keep them in. */
const settings = new Map<string, string>();

async function answerSetting(key: string, method: string, body: () => Promise<string>): Promise<Response> {
  if (method === 'GET') return Response.json({ key, value: settings.get(key) ?? null } satisfies ConfigRow);

  settings.set(key, v.parse(SettingWriteSchema, JSON.parse(await body())).value);

  return Response.json({ ok: true });
}

function answerAccount(path: string, method: string, body: () => Promise<string>): Promise<Response> {
  const read = LANDING_ACCOUNT_READS.get(path);

  if (method === 'GET' && read !== undefined) return Promise.resolve(Response.json(read));

  if (path.startsWith(SETTINGS_PATH) && (method === 'GET' || method === 'PUT')) return answerSetting(path.slice(SETTINGS_PATH.length), method, body);

  return Promise.resolve(Response.json({ error: `The sample answers no ${method} ${path}.` }, { status: 404 }));
}

window.fetch = Object.assign(
  (input: RequestInfo | URL, init?: Parameters<typeof window.fetch>[1]): Promise<Response> => {
    const parsedRequest = v.safeParse(v.instance(Request), input);
    const url = requestUrl(input);

    const path = new URL(url, window.location.origin).pathname;
    const method = (init?.method ?? (parsedRequest.success ? parsedRequest.output.method : 'GET')).toUpperCase();

    if (!path.startsWith('/api/')) return realFetch(input, init);

    const sent = init?.body;

    return answerAccount(path, method, () => (parsedRequest.success ? parsedRequest.output.text() : Promise.resolve(typeof sent === 'string' ? sent : '')));
  },
  { preconnect: realFetch.preconnect },
);

const root = publicRoot('landing-root');

// scripts/prerender-landing.ts fills the built document; a dev template keeps its root empty.
if (root?.firstElementChild === null) createRoot(root).render(<LandingPage />);
else if (root !== null) hydrateRoot(root, <LandingPage />);

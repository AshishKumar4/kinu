import { createRoot, hydrateRoot } from 'react-dom/client';
import * as v from 'valibot';

import { requestUrl } from '@kinu.run/core';
import { LANDING_PROFILE, LANDING_ROSTER } from '@/components/landing/landing-fixtures';
import { LandingPage } from '@/components/landing/LandingPage';
import "virtual:kinu-theme.css";
import './index.css';

// The static landing serves no `/api/user/*`; stub only the two reads the real `Sidebar` makes.

const realFetch = window.fetch.bind(window);

window.fetch = Object.assign(
  (input: RequestInfo | URL, init?: Parameters<typeof window.fetch>[1]): Promise<Response> => {
    const parsedRequest = v.safeParse(v.instance(Request), input);
    const url = requestUrl(input);

    const path = new URL(url, window.location.origin).pathname;
    const method = (init?.method ?? (parsedRequest.success ? parsedRequest.output.method : 'GET')).toUpperCase();

    if (method === 'GET' && path === '/api/user/profile') {
      return Promise.resolve(Response.json(LANDING_PROFILE));
    }

    if (method === 'GET' && path === '/api/user/workspaces') {
      return Promise.resolve(Response.json(LANDING_ROSTER));
    }

    return realFetch(input, init);
  },
  { preconnect: realFetch.preconnect },
);

const mount = document.getElementById('landing-root');

if (mount === null) throw new Error('landing root is missing');

// The build writes the page's markup into `landing.html` (scripts/prerender-landing.ts); a dev server's has none.
if (mount.firstElementChild === null) createRoot(mount).render(<LandingPage />);
else hydrateRoot(mount, <LandingPage />);

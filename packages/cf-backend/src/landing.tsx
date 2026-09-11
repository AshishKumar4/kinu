import { createRoot } from 'react-dom/client';
import * as v from 'valibot';

import { buildCliInstallCommand } from '@/cli/install-command';
import { LANDING_PROFILE, LANDING_ROSTER } from '@/components/landing/landing-fixtures';
import { LandingPage } from '@/components/landing/LandingPage';
import './index.css';

/**
 * The rail's sample data. The landing frames mount the real `Sidebar`, which
 * reads through the real `getProfile` / `listWorkspaces` transport — and the
 * static landing build serves no `/api/user/*`. Answer exactly those two
 * reads the way `gallery.tsx` answers them; everything else reaches the
 * network untouched, so a stubbed 404 can never leak into another surface.
 */

const realFetch = window.fetch.bind(window);

window.fetch = Object.assign(
  (input: RequestInfo | URL, init?: Parameters<typeof window.fetch>[1]): Promise<Response> => {
    const parsedInput = v.safeParse(v.string(), input);
    const parsedUrl = v.safeParse(v.instance(URL), input);
    const parsedRequest = v.safeParse(v.instance(Request), input);

    const url = parsedInput.success ? parsedInput.output
      : parsedUrl.success ? parsedUrl.output.href
      : parsedRequest.success ? parsedRequest.output.url : location.href;

    const path = url.startsWith('/') ? url : new URL(url, window.location.origin).pathname;
    const method = (init?.method ?? (parsedRequest.success ? parsedRequest.output.method : 'GET')).toUpperCase();

    if (method === 'GET' && path === '/api/user/profile') {
      return Promise.resolve(
        new Response(JSON.stringify(LANDING_PROFILE), { headers: { 'content-type': 'application/json' } }),
      );
    }

    if (method === 'GET' && path === '/api/user/workspaces') {
      return Promise.resolve(
        new Response(JSON.stringify(LANDING_ROSTER), { headers: { 'content-type': 'application/json' } }),
      );
    }

    return realFetch(input, init);
  },
  { preconnect: realFetch.preconnect },
);

const mount = document.getElementById('landing-root');

if (mount === null) throw new Error('landing root is missing');

const install = buildCliInstallCommand({ origin: window.location.origin });

createRoot(mount).render(<LandingPage install={install} />);

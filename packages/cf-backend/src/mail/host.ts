/**
 * `mail.<domain>` is a permanent redirect to `https://<domain>/mail` (docs/MAIL.md §7): the session cookie is
 * `__Host-` and host-only by design, so Mail lives on the app's own origin, with one session, one CSRF boundary and
 * one CSP. A link to `mail.<domain>/<thread>` keeps its path and lands on the same thread.
 */
import { hostOf } from '@kinu.run/core';

export function mailHostRedirect(url: URL, env: { readonly CLI_PUBLIC_ORIGIN?: string }): Response | null {
  const app = hostOf(env.CLI_PUBLIC_ORIGIN);

  if (app === null || url.hostname.toLowerCase() !== `mail.${app}`) return null;

  return Response.redirect(`https://${app}/mail${url.pathname === '/' ? '' : url.pathname}${url.search}`, 301);
}

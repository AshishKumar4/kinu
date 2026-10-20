/**
 * `mail.<domain>` is a permanent redirect to `https://<domain>/mail` (docs/MAIL.md §7): the session cookie is
 * `__Host-` and host-only by design, so Mail lives on the app's own origin, with one session, one CSRF boundary and
 * one CSP. A link to `mail.<domain>/<thread>` keeps its path and lands on the same thread.
 */
/** `app`: the app's own host (`hostOf(CLI_PUBLIC_ORIGIN)`), null for a deployment with no published origin. */
export function mailHostRedirect(url: URL, app: string | null): Response | null {
  if (app === null || url.hostname.toLowerCase() !== `mail.${app}`) return null;

  return Response.redirect(`https://${app}/mail${url.pathname === '/' ? '' : url.pathname}${url.search}`, 301);
}

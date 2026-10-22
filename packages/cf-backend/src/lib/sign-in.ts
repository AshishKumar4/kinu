/**
 * Signing in from a page a visitor can reach signed out, and landing back on it. Hosted only, so locked in
 * `capability-parity.lock.json`: the local CLI has no sign-in page.
 */

/** Back to this page after signing in, or after connecting a service. */
const returnHere = () => window.location.pathname + window.location.search;

/** `back`: where to land once signed in, this page by default. */
export function signInAndReturn(back = returnHere()): void {
  const login = new URL("/login", window.location.origin);

  login.searchParams.set("return_to", back);
  window.location.assign(login.toString());
}

/**
 * This page again with what was pressed signed out open (`?fork=1`, the fork picker; `?install=1`, the install dialog):
 * where that person lands once signed in.
 */
export function hereAsking(intent: "fork" | "install"): string {
  const here = new URL(window.location.href);

  here.searchParams.set(intent, "1");

  return here.pathname + here.search;
}

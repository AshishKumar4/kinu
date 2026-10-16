/** Signing in from a page a visitor can reach signed out, and landing back on it. */

/** Back to this page after signing in, or after connecting a service. */
export const returnHere = () => window.location.pathname + window.location.search;

/** `back`: where to land once signed in, this page by default. */
export function signInAndReturn(back = returnHere()): void {
  const login = new URL("/login", window.location.origin);

  login.searchParams.set("return_to", back);
  window.location.assign(login.toString());
}

/** This page again with its fork picker open (`?fork=1`): where someone who pressed Fork signed out lands once signed in. */
export function hereForking(): string {
  const here = new URL(window.location.href);

  here.searchParams.set("fork", "1");

  return here.pathname + here.search;
}

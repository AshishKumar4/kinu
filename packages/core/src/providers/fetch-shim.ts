// Vercel AI SDK declares its `fetch?` option as `typeof globalThis.fetch`,
// which in Bun-types territory includes a `preconnect` method. Bare async
// function literals don't satisfy that shape, so we attach a no-op preconnect
// via Object.assign. The Vercel SDK never calls preconnect — it just calls
// the function — so this stub is invisible at runtime.
export function asFetchFunction(
  fn: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>,
): typeof globalThis.fetch {
  return Object.assign(fn, { preconnect: () => {} });
}

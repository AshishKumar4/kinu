// The AI SDK's `fetch` type includes Bun's `preconnect`; this no-op stub satisfies it and is never called.
export function asFetchFunction(
  fn: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>,
): typeof globalThis.fetch {
  return Object.assign(fn, { preconnect: () => {} });
}

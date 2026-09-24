// The AI SDK's `fetch` type includes Bun's `preconnect`; this no-op stub satisfies it and is never called.
export function asFetchFunction(
  fn: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>,
): typeof globalThis.fetch {
  return Object.assign(fn, { preconnect: () => {} });
}

function isHeaderIterable(value: HeadersInit): value is HeadersInit & Iterable<Iterable<string>> {
  return Symbol.iterator in Object(value);
}

/** Every HeadersInit form, past Bun's narrower `Headers` constructor. */
export function copyHeaders(init: HeadersInit | undefined): Headers {
  const headers = new Headers();

  if (init === undefined) return headers;

  if (init instanceof Headers) {
    for (const [name, value] of init) headers.append(name, value);

    return headers;
  }

  if (isHeaderIterable(init)) {
    for (const pair of init) {
      const [name, value] = pair;

      if (name === undefined || value === undefined) {
        throw new Error('header pair must contain a name and value');
      }

      headers.append(name, value);
    }

    return headers;
  }

  for (const [name, value] of Object.entries(init)) headers.append(name, value);

  return headers;
}

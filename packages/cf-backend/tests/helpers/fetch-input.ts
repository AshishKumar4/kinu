/**
 * The URL a `fetch` call names, whichever of the three shapes the caller used.
 *
 * A fake that reads `String(input)` renders a `Request` as `[object Request]`,
 * so the day a caller switches from a URL string to a Request the fake stops
 * matching and every route assertion in the file passes by matching nothing.
 */
export function requestUrl(input: RequestInfo | URL): string {
  if (input instanceof Request) return input.url;

  return input.toString();
}

/**
 * The text body a `fetch` call carries, read the way a server reads it.
 *
 * `BodyInit` also admits streams, buffers and form data, so a fake that read
 * `String(init.body)` recorded `[object ReadableStream]` for everything but a
 * string — and a `URLSearchParams` body only looked right by accident.
 */
export function requestBodyText(input: RequestInfo | URL, init?: RequestInit): Promise<string> {
  return new Request(input, init).text();
}

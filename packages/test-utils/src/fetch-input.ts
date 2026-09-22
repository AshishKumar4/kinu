/**
 * The text body a `fetch` call carries, read the way a server reads it.
 *
 * `BodyInit` also admits streams, buffers and form data, so a fake that reads
 * `String(init.body)` records `[object ReadableStream]` for everything but a
 * string, and a `URLSearchParams` body only looks right by accident.
 */
export function requestBodyText(input: RequestInfo | URL, init?: RequestInit): Promise<string> {
  return new Request(input, init).text();
}

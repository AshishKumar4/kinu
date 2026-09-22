/** The text body of a `fetch` call; `String(init.body)` would give `[object ReadableStream]` for non-strings. */
export function requestBodyText(input: RequestInfo | URL, init?: RequestInit): Promise<string> {
  return new Request(input, init).text();
}

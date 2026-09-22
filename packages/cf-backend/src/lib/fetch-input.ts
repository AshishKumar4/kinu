import * as v from 'valibot';

/**
 * The URL a `fetch` call names, whichever of its three input shapes the caller
 * used. A browser bundle that fakes `fetch` reads the URL to route the call, and
 * `String(input)` renders a `Request` as `[object Request]`, so the shape is
 * read rather than stringified. An input of none of the shapes is the page's
 * own location: `fetch()` with no argument fetches the document.
 */
export function requestUrl(input: RequestInfo | URL): string {
  const text = v.safeParse(v.string(), input);

  if (text.success) return text.output;

  const url = v.safeParse(v.instance(URL), input);

  if (url.success) return url.output.href;

  const request = v.safeParse(v.instance(Request), input);

  if (request.success) return request.output.url;

  return location.href;
}

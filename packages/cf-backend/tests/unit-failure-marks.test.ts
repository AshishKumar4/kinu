/**
 * A wait in the browser harness ends on a failure the page shows by reading `[data-failure]`
 * (scripts/product-flows.ts), so each failure display marks the words that state its failure. Unmarked, a Drive
 * whose listing failed held a sweep's wait for its sections for 36 minutes (2026-09-24).
 */
import { expect, test } from 'bun:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { ErrorBoundary } from '../src/components/ErrorBoundary';
import { LoadFailure } from '../src/components/ui/LoadFailure';

/** The words each `[data-failure]` element holds, as the harness reads them. */
async function marked(html: string): Promise<string[]> {
  const said: string[] = [];

  await new HTMLRewriter()
    .on('[data-failure]', {
      element() { said.push(''); },
      text(chunk) { said.push(`${said.pop() ?? ''}${chunk.text}`); },
    })
    .transform(new Response(html))
    .text();

  return said.map((text) => text.trim());
}

test('a load that failed marks what could not load and why', async () => {
  const html = renderToStaticMarkup(createElement(LoadFailure, { what: 'this folder', message: 'the Drive answered 503', onRetry: () => undefined }));

  expect(await marked(html)).toEqual(['Could not load this folder: the Drive answered 503']);
});

test('a view that crashed marks which view', async () => {
  const boundary = new ErrorBoundary({ label: 'Files', children: null });

  boundary.state = { error: new Error('files is undefined') };

  expect(await marked(renderToStaticMarkup(boundary.render()))).toEqual(['This view crashed (Files). Try again, or reload the page.']);
});

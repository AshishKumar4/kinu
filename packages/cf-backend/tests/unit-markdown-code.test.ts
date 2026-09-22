/**
 * Inline code in a message, through the renderer the chat column mounts.
 *
 * THE FAILURE THIS LOCKS DOWN SHIPPED. The `code` renderer destructured
 * `{ className, children, ...props }` and spread `props` onto the DOM element.
 * react-markdown puts its hast node in those props, so every inline code span
 * in every message rendered as
 * `<code class="p-code-inline" node="[object Object]">` — an invalid attribute
 * React warns about, holding an object stringified by accident.
 *
 * `renderToStaticMarkup` is the whole apparatus: the renderer's block/inline
 * decision is derived from its content, so what this asserts is what a reader
 * sees on the first paint.
 */
import './helpers/ui-module-globals';
import { describe, expect, test } from 'bun:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MarkdownContent } from '../src/components/surfaces/shared';

const render = (content: string): string =>
  renderToStaticMarkup(createElement(MarkdownContent, { content }));

describe('markdown renders code without leaking its own parse tree', () => {
  test('an inline span carries no hast node into the DOM', () => {
    const html = render('a `tiny` span, and a `second` one');

    expect(html).not.toContain('node=');
    expect(html).not.toContain('[object Object]');
    expect(html).toContain('<code class="p-code-inline">tiny</code>');
  });
});

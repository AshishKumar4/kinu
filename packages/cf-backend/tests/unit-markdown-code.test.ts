/**
 * Inline code through the chat renderer. Defends: spreading react-markdown's `node` prop onto `<code>`
 * (`node="[object Object]"`).
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

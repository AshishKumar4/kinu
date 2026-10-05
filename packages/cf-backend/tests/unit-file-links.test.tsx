/**
 * 2026-10-04: chat named files as plain text. A reference to one of the workspace's planes is a link that opens it in
 * Files. No DOM harness: where a click lands is covered at its pure seam, core's `filesFocusOf`.
 */
import './helpers/ui-module-globals';
import { describe, expect, test } from 'bun:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { filesFocusOf } from '@kinu.run/core';
import { FileLinkContext, MarkdownContent } from '../src/components/surfaces/shared';

const CHAT = { roots: ['vfs', 'sandbox'], open: () => {} };

function chat(content: string): string {
  return renderToStaticMarkup(createElement(FileLinkContext.Provider, { value: CHAT }, createElement(MarkdownContent, { content })));
}

describe('a file the agent names in chat', () => {
  test('is a link in prose, in inline code and as a link target; other schemes keep their own rendering', () => {
    const html = chat('Wrote vfs://home/main/report.md, see `sandbox://w/build.log` and [the plan](vfs://home/main/plan.md). Not postgres://db/x or https://example.com.');

    expect(html).toContain('data-file-link="vfs://home/main/report.md"');
    expect(html).toContain('data-file-link="sandbox://w/build.log"');
    expect(html).toContain('data-file-link="vfs://home/main/plan.md"');
    expect(html).toContain('>the plan</button>');
    expect(html).toContain('report.md</button>, see');
    expect(html).not.toContain('data-file-link="postgres');
    expect(html).toContain('href="https://example.com"');
  });

  // Release review, 2026-10-05: a link target the parser escaped opened "My%20Report.md", and a code span with a space linked nothing.
  test('with a space in its name, opens that file from a link target and from a whole inline code span', () => {
    const opened = [...chat('See [the report](<vfs://home/main/My Report.md>) and `vfs://home/main/My Report.md`.')
      .matchAll(/data-file-link="([^"]*)"/gu)].map((hit) => filesFocusOf(hit[1] ?? '')?.file);

    expect(opened).toEqual(['/home/main/My Report.md', '/home/main/My Report.md']);
  });

  test('stays text where nothing can open it, and in a fenced block', () => {
    const plain = renderToStaticMarkup(createElement(MarkdownContent, { content: 'Wrote vfs://home/main/report.md' }));
    expect(plain).not.toContain('data-file-link');
    expect(plain).toContain('vfs://home/main/report.md');
    expect(chat('```\ncat vfs://home/main/x\n```')).not.toContain('data-file-link');
  });
});

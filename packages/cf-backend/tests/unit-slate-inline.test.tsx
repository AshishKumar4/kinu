/**
 * No DOM harness: effect-bound behaviour is covered at its pure seams, here and
 * in `packages/core/tests/unit-slate-host-context.test.ts`.
 */
import './helpers/ui-module-globals';
import { describe, expect, test } from 'bun:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { buildSlateHostContext, slateFrameSrc, SLATE_QUERY_PARAM, slateLinkId } from '@kinu.run/core';
import { SlateInlineContext } from '../src/components/slates/context';
import { MarkdownContent } from '../src/components/surfaces/shared';
import { MessageView } from '../src/components/MessageView';
import { SLATES_CHANGED_METADATA_KEY } from '@kinu.run/core';

const noopRpc = async (): Promise<never> => { throw new Error('no rpc in the static renderer'); };

describe('the inline slate card', () => {
  test('renders as the transcript block with its header, through the context', () => {
    const html = renderToStaticMarkup(createElement(
      SlateInlineContext.Provider,
      { value: { rpc: noopRpc, openSlate: () => {} } },
      createElement(MarkdownContent, {
        content: 'Pick one below and I will continue.\n\nslate://deploy-choice',
      }),
    ));

    expect(html).toContain('data-slate-inline="deploy-choice"');
    expect(html).toContain('>deploy-choice<');
    expect(html).not.toContain('href="slate://deploy-choice"');
    // The card sits inside the paragraph: not one <div> may appear in it.
    expect(html).not.toContain('<div');
  });

  test('renders the literal address as code when nothing can host the card', () => {
    const html = renderToStaticMarkup(createElement(MarkdownContent, {
      content: 'See slate://deploy-choice here',
    }));

    // Without the provider SlateLink falls back to the literal text as code.
    expect(html).toContain('<code');
    expect(html).toContain('slate://deploy-choice');
    expect(html).not.toContain('data-slate-inline');
  });

  // 2026-09-26: an address that names no slate (`slate://..`) left the pass re-reading it forever, hanging the page.
  test('an address that names no slate stays text, and the addresses after it still render', () => {
    const html = renderToStaticMarkup(createElement(
      SlateInlineContext.Provider,
      { value: { rpc: noopRpc, openSlate: () => {} } },
      createElement(MarkdownContent, { content: 'Not slate://.. but slate://board' }),
    ));

    expect(html).toContain('Not slate://.. but');
    expect(html).toContain('data-slate-inline="board"');
  });

  test('a non-slate link still renders as a normal anchor', () => {
    const html = renderToStaticMarkup(createElement(MarkdownContent, {
      content: 'See [the docs](https://example.com/docs) here',
    }));

    expect(html).toContain('href="https://example.com/docs"');
  });
});

/** An answer whose turn changed `slates`, rendered where a card can be hosted. */
function answer(text: string, slates: string[]): string {
  return renderToStaticMarkup(createElement(
    SlateInlineContext.Provider,
    { value: { rpc: noopRpc, openSlate: () => {} } },
    createElement(MessageView, {
      message: { id: 'a-1', role: 'assistant', metadata: { [SLATES_CHANGED_METADATA_KEY]: slates }, parts: [{ type: 'text', text }] },
    }),
  ));
}

const cards = (html: string): string[] => [...html.matchAll(/data-slate-inline="([^"]+)"/g)].map(([, id]) => id ?? '');

// Owner 2026-09-25 (SLATE-INLINE-0925): a slate the turn changed is previewed after the answer, once.
describe("an answer's changed slates", () => {
  test('each is previewed after the answer, once, even where the answer names it', () => {
    expect(cards(answer('Added the column.', ['board', 'notes']))).toEqual(['board', 'notes']);
    expect(cards(answer('Here it is.\n\nslate://board', ['board']))).toEqual(['board']);
  });

  // Review job 186: `slate://board2` is another slate; it must not stand in for board's preview.
  test('a longer id that starts with the same letters does not count as the slate', () => {
    expect(cards(answer('See slate://board2', ['board']))).toEqual(['board2', 'board']);
  });
});

describe('the host context contract', () => {
  const context = buildSlateHostContext({
    theme: 'dark',
    variables: { '--c-bg': '#0a0a0a', '--c-accent': '#c8a44a' },
    width: 420,
    display: 'inline',
    origin: 'https://kinu.run',
  });

  test('buildSlateHostContext produces the contract the query parameter carries', () => {
    expect(context).toEqual({
      theme: 'dark',
      styles: { variables: { '--c-bg': '#0a0a0a', '--c-accent': '#c8a44a' } },
      containerDimensions: { width: 420 },
      display: 'inline',
      origin: 'https://kinu.run',
    });
  });

  test('the iframe src carries ?kinu= with the context, parsed back exactly', () => {
    const src = slateFrameSrc('https://8789-abc-tok.preview.example.test/', context);
    const back = JSON.parse(new URL(src).searchParams.get(SLATE_QUERY_PARAM) ?? 'null');

    expect(src.startsWith('https://8789-abc-tok.preview.example.test/?')).toBe(true);
    expect(back).toEqual(context);
  });

  test('slateLinkId drives both the renderer and the remark pass', () => {
    expect(slateLinkId('slate://deploy-choice')).toBe('deploy-choice');
    expect(slateLinkId('slate://../etc')).toBeNull();
  });
});

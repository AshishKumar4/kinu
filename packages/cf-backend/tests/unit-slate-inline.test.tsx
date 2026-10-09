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
import { SLATES_CHANGED_METADATA_KEY, slatesToPreview } from '@kinu.run/core';

const noopRpc = async (): Promise<never> => { throw new Error('no rpc in the static renderer'); };

describe('the inline slate card', () => {
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
});

/** An answer whose turn changed `slates`, rendered where a card can be hosted. */
function answer(text: string, slates: string[]): string {
  return renderToStaticMarkup(createElement(
    SlateInlineContext.Provider,
    { value: { rpc: noopRpc, openSlate: () => {} } },
    createElement(MessageView, {
      message: { id: 'a-1', role: 'assistant', metadata: { [SLATES_CHANGED_METADATA_KEY]: slatesToPreview(slates, new Set(), [text]) }, parts: [{ type: 'text', text }] },
    }),
  ));
}

const cards = (html: string): string[] => [...html.matchAll(/data-slate-inline="([^"]+)"/g)].map(([, id]) => id ?? '');

// The producer's metadata and the rendered answer must agree about which addresses draw cards.
describe("an answer's changed slates", () => {
  test('each is previewed after the answer, in order', () => {
    expect(cards(answer('Added the column.', ['board', 'notes']))).toEqual(['board', 'notes']);
  });

  test.each([
    { kind: 'prose', text: 'Updated slate://board', linked: true },
    { kind: 'escaped prose', text: 'Updated slate\\://board', linked: true },
    { kind: 'inline code', text: 'Updated `slate://board`', linked: true },
    { kind: 'double-backtick inline code', text: 'Updated ``slate://board``', linked: true },
    { kind: 'a labelled link', text: '[The board](slate://board)', linked: true },
    { kind: 'a reference link', text: '[The board][board]\n\n[board]: slate://board', linked: true },
    { kind: 'an autolink', text: '<slate://board>', linked: true },
    { kind: 'a backtick fence', text: '```\nslate://board\n```', linked: false },
    { kind: 'a tilde fence', text: '~~~text\nslate://board\n~~~', linked: false },
    { kind: 'an indented code block', text: '    slate://board', linked: false },
    { kind: 'a command in inline code', text: '`open slate://board`', linked: false },
    { kind: 'an unused reference definition', text: '[board]: slate://board', linked: false },
  ])('$kind leaves exactly one card, with literal code left intact', ({ text, linked }) => {
    expect(slatesToPreview(['board'], new Set(), [text])).toEqual(linked ? [] : ['board']);
    const html = answer(text, ['board']);

    expect(cards(html)).toEqual(['board']);

    if (!linked && !text.startsWith('[board]:')) expect(html).toContain('slate://board');
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

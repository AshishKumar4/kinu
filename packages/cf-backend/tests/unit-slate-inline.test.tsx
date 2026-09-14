/**
 * Where the chat's inline slate card is proven. The repo's component tests
 * drive React's static renderer and fake hosts — there is no DOM harness —
 * so what this file asserts is the two things the component cannot hide
 * behind effects: the card and its chrome render through the context, and
 * the pure seams the effects call decide exactly what the browser would
 * have decided.
 *
 * The iframe src carrying `?kinu=`, the clamp on a reported height, the
 * origin/source guard on messages, and the refusal text all execute inside
 * effects and postMessage handlers this harness cannot run; each is covered
 * at its pure seam in `packages/core/tests/unit-slate-host-context.test.ts`
 * and through `slateFrameSrc`/`buildSlateHostContext` here.
 */
import './helpers/ui-module-globals';
import { describe, expect, test } from 'bun:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { buildSlateHostContext, slateFrameSrc, SLATE_QUERY_PARAM, slateLinkId } from '@kinu.run/core';
import { SlateInlineContext } from '../src/components/slates/context';
import { MarkdownContent } from '../src/components/surfaces/shared';

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

    // The bare address became the card, not a link and not dead text.
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

  test('a non-slate link still renders as a normal anchor', () => {
    const html = renderToStaticMarkup(createElement(MarkdownContent, {
      content: 'See [the docs](https://example.com/docs) here',
    }));

    expect(html).toContain('href="https://example.com/docs"');
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

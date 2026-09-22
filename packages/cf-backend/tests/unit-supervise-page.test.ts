/**
 * Supervise as markup: section order, header text, and evolution rendering only a non-empty
 * digest. The fetch is out of scope: the static renderer discards `useEffect`.
 */
import './helpers/ui-module-globals';
import { describe, expect, test } from 'bun:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import type { Rpc } from '@kinu.run/core';
import type { EvolutionEntry } from '../src/components/surfaces/supervise-evolution';

// Namespace imports: a missing symbol fails its own row, not the whole import.
const page = await import('../src/pages/SupervisePage');

const evolution = await import('../src/components/surfaces/supervise-evolution');

async function stubRpc<T>(method: string): Promise<T> {
  throw new Error(`unexpected rpc in markup test: ${method}`);
}

// SAFETY: same signature as the Rpc contract — a method-name async function.
const rpc: Rpc = stubRpc;

const NOW = Date.UTC(2026, 8, 1, 9, 0, 0);

function entry(kind: string, summary: string, id = `${kind}-1`): EvolutionEntry {
  return { id, kind, at: NOW, summary };
}

/** The page under a router: AutomationsBlock reads `agentId` off the route. */
function pageMarkup(): string {
  return renderToStaticMarkup(createElement(
    MemoryRouter,
    { initialEntries: ['/workspace/checkout-fixes'] },
    createElement(
      Routes,
      null,
      createElement(Route, {
        path: '/workspace/:agentId',
        element: createElement(page.SupervisePage, { rpc }),
      }),
    ),
  ));
}

function sectionMarkup(entries: EvolutionEntry[]): string {
  return renderToStaticMarkup(createElement(evolution.EvolutionSection, { entries }));
}

describe('the supervise view, as markup', () => {
  test('there is no Curriculum section', () => {
    const html = pageMarkup();

    expect(html).not.toContain('Curriculum');
    expect(html).not.toContain('Propose tasks');
    expect(html).not.toContain('cur_');
  });

  test('Automations leads and the run history sits directly under it', () => {
    const html = pageMarkup();
    const automations = html.indexOf('Automations');
    const history = html.indexOf('Run history', automations);

    expect(automations).toBeGreaterThanOrEqual(0);
    expect(history).toBeGreaterThan(automations);
    // No reads have resolved, so Evolution mounts nothing.
    expect(html.indexOf('Evolution')).toBe(-1);
  });

  test('the header carries no spend figure or budget wording', () => {
    const html = pageMarkup();

    expect(html).not.toMatch(/\$\d|\bUSD\b|budget/i);
  });
});

describe('the evolution section', () => {
  test('a filtered digest renders its changes', () => {
    const entries = [
      entry('scaffold', 'Rewrote the tool preamble', 's1'),
      entry('fact', 'Remembered: percentage coupons carry kind:null', 'f1'),
    ];

    const html = sectionMarkup(entries);

    expect(html).toContain('Evolution');
    expect(html).toContain('Rewrote the tool preamble');
    expect(html).toContain('percentage coupons carry kind:null');
  });

  test('an empty digest shows nothing', () => {
    expect(sectionMarkup([])).toBe('');
  });
});

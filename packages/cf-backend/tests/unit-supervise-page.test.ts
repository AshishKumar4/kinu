/**
 * The Supervise altitude's contract, as markup.
 *
 * The owner's report: "the whole 'Supervise' view has soo many unnecessary/
 * stupid things — Curriculum isn't needed, evolution shouldn't be shown unless
 * there actually has been any evolution, automations should be prominent along
 * with run history, remove the 'budget' from that header."
 *
 * What is here: section order and the header's text off the page itself, and
 * the evolution gate — a window that produced a self-change shows the section,
 * bookkeeping and silence do not. The gate lives in
 * `components/surfaces/supervise-evolution.tsx` so the loaded branch renders
 * straight off fixture rows.
 *
 * What is NOT here: the fetch — `useAsyncResource` loads inside `useEffect`,
 * which the static renderer discards. The gate's "no data yet" branch is the
 * same "nothing to show ⇒ nothing mounts" path, and the gallery frames
 * (`supervise`, `supervisefresh`) photograph the settled view.
 */
import './helpers/ui-module-globals';
import { describe, expect, test } from 'bun:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import type { Rpc } from '../src/lib/protocol';
import type { EvolutionEntry } from '../src/components/surfaces/supervise-evolution';

// Namespace imports keep every row reporting when a symbol is absent: the red
// pass names each failing assertion instead of dying at the import.
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
    // No reads have resolved: with nothing to show, Evolution mounts nothing —
    // so in this pass the two lead sections are also the only headings.
    expect(html.indexOf('Evolution')).toBe(-1);
  });

  test('the header carries no spend figure or budget wording', () => {
    const html = pageMarkup();

    expect(html).not.toMatch(/\$\d|\bUSD\b|budget/i);
  });
});

describe('the evolution gate', () => {
  test('a closed-window digest with self-changes keeps the section', () => {
    const entries = [
      entry('outcomes', 'Graded 6 turns · 4 accepted', 'o1'),
      entry('scaffold', 'Rewrote the tool preamble', 's1'),
      entry('fact', 'Remembered: percentage coupons carry kind:null', 'f1'),
    ];

    const changes = evolution.evolutionChanges(entries);
    const html = sectionMarkup(changes);

    expect(changes.map((change) => change.id)).toEqual(['s1', 'f1']);
    expect(html).toContain('Evolution');
    expect(html).toContain('Rewrote the tool preamble');
    expect(html).toContain('percentage coupons carry kind:null');
    // Measurement rows never appear as evidence the agent changed.
    expect(html).not.toContain('Graded 6 turns');
  });

  test('a digest of only closed-window bookkeeping shows nothing', () => {
    const entries = [
      entry('outcomes', 'Graded 6 turns · 4 accepted', 'o1'),
      entry('replay', 'Re-scored against 40 graded turns', 'r1'),
    ];

    const changes = evolution.evolutionChanges(entries);

    expect(changes).toEqual([]);
    expect(sectionMarkup(changes)).toBe('');
  });

  test('an empty digest shows nothing', () => {
    expect(evolution.evolutionChanges([])).toEqual([]);
    expect(sectionMarkup([])).toBe('');
  });
});

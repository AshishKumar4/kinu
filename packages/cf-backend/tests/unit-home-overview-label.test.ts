/**
 * The card's one attention line, rendered through the real component.
 *
 * The precedence is the contract the card exists for: a decision outranks a
 * run, green is earned only by a sealed 'completed', durable unfinished work
 * is "Work remains" rather than "active", and a failed or cut run is said in
 * words — nothing paints green what the log did not measure.
 *
 * `renderToStaticMarkup` runs the component for real: the token the row shows
 * is the class on the emitted span, which is exactly what these cases read.
 */
import './helpers/ui-module-globals';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, test } from 'bun:test';
import type { WorkspaceOverview } from '@kinu.run/core';

const { OverviewLabel } = await import('../src/pages/home-overview-label');

const BASE: WorkspaceOverview = {
  observedAt: 0, activity: 'idle', decisionsWaiting: 0, hasUpdates: false, latestRun: null,
};

function withRun(status: string | null): WorkspaceOverview {
  return { ...BASE, latestRun: { status, task: 'a task' } };
}

/** The rendered label, decomposed into its words and the token it speaks in. */
function renderLabel(overview: WorkspaceOverview, stale = false) {
  const html = renderToStaticMarkup(createElement(OverviewLabel, { overview, stale }));
  const match = html.match(/<span class="([^"]*)">([^<]*)<\/span>/);

  if (match === null) throw new Error(`OverviewLabel rendered no span: ${html}`);

  return { tone: match[1]!, text: match[2]! };
}

describe('OverviewLabel', () => {
  test('a waiting decision outranks work in flight, with its count', () => {
    const label = renderLabel({ ...BASE, decisionsWaiting: 3, activity: 'working' });

    expect(label.text).toBe('Needs you · 3');
    expect(label.tone).toBe('p-warning');
  });

  test('live work is "Working"; durable leftovers are "Work remains" — not active', () => {
    expect(renderLabel({ ...BASE, activity: 'working' })).toEqual({ text: 'Working', tone: 'p-accent' });
    expect(renderLabel({ ...BASE, activity: 'unfinished' })).toEqual({ text: 'Work remains', tone: 'p-warning' });
  });

  test('unfinished work is never settled by a completed last run', () => {
    const label = renderLabel({ ...BASE, activity: 'unfinished', latestRun: { status: 'completed', task: null } });

    expect(label.text).toBe('Work remains');
    expect(label.tone).not.toBe('p-success');
  });

  test('green is reserved for a run the log sealed completed', () => {
    expect(renderLabel(withRun('completed'))).toEqual({ text: 'Last run completed', tone: 'p-success' });

    for (const status of ['error', 'aborted', 'cancelled', null] as const) {
      const label = renderLabel(withRun(status));

      expect(label.tone).not.toBe('p-success');
      expect(label.text).not.toContain('completed');
    }
  });

  test('failed and cancelled ends are named, not lumped', () => {
    expect(renderLabel(withRun('error')).text).toBe('Last run failed');
    expect(renderLabel(withRun('error')).tone).toBe('p-danger');
    expect(renderLabel(withRun('cancelled')).text).toBe('Last run cancelled');
    expect(renderLabel(withRun(null)).text).toBe('Last run unfinished');
  });

  test('no run at all is a quiet "No active work"', () => {
    expect(renderLabel(BASE)).toEqual({ text: 'No active work', tone: 'p-text-4' });
  });

  test('a stale answer keeps its words but speaks in the quiet token', () => {
    const label = renderLabel({ ...BASE, decisionsWaiting: 2 }, true);

    expect(label.text).toBe('Needs you · 2');
    expect(label.tone).toBe('p-text-4');
  });
});

/**
 * The surface-focus policy without the React shell: a passive previewFocus
 * arrival raises the ready chip where the reader is, an explicit navigate
 * consumes it only when it lands on the surface the arrival named, and a
 * dismissal survives until a different arrival. `useSurfaceFocus` itself is
 * one `useState` over these seams; the strip chrome is covered by the browser
 * rows in scripts/chat-and-files-ux.test.ts and scripts/slate-preview-ux.test.ts.
 */
import { describe, expect, test } from 'bun:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  focusSurfaceOf, readyChipSurface, readyChipTitle, dismissalAfter, useSurfaceFocus,
  type SurfaceFocus,
} from '../src/components/surfaces/use-surface-focus';
import type { SurfaceKind } from '../src/components/surfaces/WorkSurface';
import type { SlateSummary } from '@kinu.run/core';
import type { PinnedPreviewPort as PinnedPort } from '../src/lib/preview-ports';

const slate = (id: string, title: string): SlateSummary => ({ id, title, bindings: [] });

const port = (executor: string, portNumber: number, name: string): PinnedPort =>
  ({ executor, port: portNumber, url: `http://localhost:${String(portNumber)}`, name });

describe('focusSurfaceOf', () => {
  test('a slate arrival names its strip surface; a port arrival names its preview tab', () => {
    expect(focusSurfaceOf('slate:abc')).toBe('slate:abc');
    expect(focusSurfaceOf('preview:workspace:3000')).toBe('preview:workspace:3000');
    expect(focusSurfaceOf(null)).toBeNull();
    expect(focusSurfaceOf('something-else')).toBeNull();
  });
});

describe('the ready chip', () => {
  test('a passive arrival chips while another surface is open', () => {
    expect(readyChipSurface('slate:abc', 'Work', null)).toBe('slate:abc');
  });

  test('an arrival already on screen chips nothing', () => {
    expect(readyChipSurface('slate:abc', 'slate:abc', null)).toBeNull();
  });

  test('a dismissed arrival stays down; a different arrival raises it again', () => {
    expect(readyChipSurface('slate:abc', 'Work', 'slate:abc')).toBeNull();
    expect(readyChipSurface('slate:def', 'Work', 'slate:abc')).toBe('slate:def');
  });

  test('the chip titles the slate by name and the port by its pinned name', () => {
    const slates = [slate('abc', 'Dashboard')];
    const ports = [port('workspace', 3000, 'Arrived app')];

    expect(readyChipTitle('slate:abc', slates, ports)).toBe('Dashboard');
    expect(readyChipTitle('preview:workspace:3000', slates, ports)).toBe('Arrived app');
    // An arrival nobody listed still gets its id tail, not a blank chip.
    expect(readyChipTitle('slate:xyz', slates, ports)).toBe('xyz');
  });
});

describe('navigating consumes the arrival', () => {
  test('landing on the surface the arrival named dismisses it', () => {
    expect(dismissalAfter('slate:abc', 'slate:abc', null)).toBe('slate:abc');
    expect(readyChipSurface('slate:abc', 'slate:abc', 'slate:abc')).toBeNull();
  });

  test('landing anywhere else leaves the arrival live — the chip is still owed', () => {
    expect(dismissalAfter('slate:abc', 'Files', null)).toBeNull();
    expect(readyChipSurface('slate:abc', 'Files', null)).toBe('slate:abc');
  });

  test('an earlier dismissal is untouched by unrelated navigation', () => {
    expect(dismissalAfter('slate:def', 'Files', 'slate:abc')).toBe('slate:abc');
  });
});

/** A static render captures the hook's return; effects do not run, and the
 *  decisions under test do not live in them. */
function capture(input: {
  surface: SurfaceKind;
  previewFocus?: string | null;
  slates?: SlateSummary[];
  pinnedPorts?: PinnedPort[];
  onSurface: (surface: SurfaceKind) => void;
}): SurfaceFocus {
  let captured: SurfaceFocus | undefined;

  function Probe() {
    captured = useSurfaceFocus({
      surface: input.surface,
      previewFocus: input.previewFocus ?? null,
      slates: input.slates,
      pinnedPorts: input.pinnedPorts ?? [],
      onSurface: input.onSurface,
    });

    return null;
  }

  renderToStaticMarkup(createElement(Probe));

  if (captured === undefined) throw new Error('the hook never produced a value');

  return captured;
}

describe('useSurfaceFocus', () => {
  test('a passive arrival surfaces a chip on the surface already open', () => {
    const focus = capture({
      surface: 'Work',
      previewFocus: 'slate:abc',
      slates: [slate('abc', 'Dashboard')],
      onSurface: () => {},
    });

    expect(focus.surface).toBe('Work');
    expect(focus.readyChip).toEqual({ surface: 'slate:abc', title: 'Dashboard' });
  });

  test('explicit navigate goes to the surface it was given', () => {
    const seen: SurfaceKind[] = [];

    const focus = capture({
      surface: 'Work',
      previewFocus: 'preview:workspace:3000',
      pinnedPorts: [port('workspace', 3000, 'Arrived app')],
      onSurface: (next) => { seen.push(next); },
    });

    focus.navigate('preview:workspace:3000');
    expect(seen).toEqual(['preview:workspace:3000']);
  });

  test('the chip click is the same navigate: onto the surface it announced', () => {
    const seen: SurfaceKind[] = [];

    const focus = capture({
      surface: 'Work',
      previewFocus: 'preview:workspace:3000',
      pinnedPorts: [port('workspace', 3000, 'Arrived app')],
      onSurface: (next) => { seen.push(next); },
    });

    const chip = focus.readyChip;

    if (chip === null) throw new Error('a passive arrival owed a chip');
    focus.navigate(chip.surface);
    expect(seen).toEqual(['preview:workspace:3000']);
  });
});

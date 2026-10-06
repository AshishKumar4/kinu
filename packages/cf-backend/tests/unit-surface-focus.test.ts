/**
 * The surface strip's focus policy through `useSurfaceFocus`. Strip chrome is covered in
 * tests/browser/chat-and-files-ux.test.ts and tests/browser/slate-preview-ux.test.ts.
 */
import { describe, expect, test } from 'bun:test';
import { createElement, useState } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { useSurfaceFocus, type SurfaceFocus } from '../src/components/surfaces/use-surface-focus';
import type { SurfaceKind } from '@kinu.run/core';
import type { SlateSummary } from '@kinu.run/core';
import type { PinnedPreviewPort as PinnedPort } from '@kinu.run/core';

const slate = (id: string, title: string): SlateSummary => ({ id, title, bindings: [] });

const port = (executor: string, portNumber: number, name: string): PinnedPort =>
  ({ executor, port: portNumber, url: `http://localhost:${String(portNumber)}`, name });

interface Pass {
  readonly surface: SurfaceKind | null;
  readonly chip: { readonly surface: SurfaceKind; readonly title: string } | null;
}

interface StripProps {
  surface: SurfaceKind;
  previewFocus: string | null;
}

interface Controls {
  setProps(next: Partial<StripProps>): void;
}

interface Mounted {
  readonly passes: Pass[];
  readonly shown: Pass;
}

/** SSR runs no effects, and the hook holds none; each step runs once per pass. */
function mount(input: {
  surface: SurfaceKind;
  previewFocus?: string | null;
  slates?: SlateSummary[];
  pinnedPorts?: PinnedPort[];
  onSurface?: (surface: SurfaceKind) => void;
  steps?: readonly ((focus: SurfaceFocus, controls: Controls) => void)[];
}): Mounted {
  const passes: Pass[] = [];

  function Strip() {
    const [props, setProps] = useState<StripProps>({
      surface: input.surface,
      previewFocus: input.previewFocus ?? null,
    });

    const focus = useSurfaceFocus({
      surface: props.surface,
      previewFocus: props.previewFocus,
      slates: input.slates,
      pinnedPorts: input.pinnedPorts ?? [],
      onSurface: input.onSurface ?? (() => {}),
    });

    const chip = focus.readyChip;
    passes.push({ surface: focus.surface, chip: chip === null ? null : { surface: chip.surface, title: chip.title } });
    input.steps?.[passes.length - 1]?.(focus, {
      setProps: (next) => { setProps((prev) => ({ ...prev, ...next })); },
    });

    return null;
  }

  renderToStaticMarkup(createElement(Strip));

  if (input.steps !== undefined && passes.length < input.steps.length) {
    throw new Error(`a scripted step never ran: ${String(passes.length)} pass(es) for ${String(input.steps.length)} step(s)`);
  }

  return { passes, shown: passes[passes.length - 1] ?? { surface: input.surface, chip: null } };
}

const chipOf = (mounted: Mounted): SurfaceKind | null => mounted.shown.chip?.surface ?? null;

describe('a passive arrival, through the strip', () => {
  test('a slate arrival chips the surface it names; a port arrival chips its preview tab', () => {
    expect(chipOf(mount({ surface: 'Work', previewFocus: 'slate:abc' }))).toBe('slate:abc');
    expect(chipOf(mount({ surface: 'Work', previewFocus: 'preview:workspace:3000' }))).toBe('preview:workspace:3000');
    expect(chipOf(mount({ surface: 'Work' }))).toBeNull();
    expect(chipOf(mount({ surface: 'Work', previewFocus: 'something-else' }))).toBeNull();
  });

  test('an arrival already on screen chips nothing', () => {
    expect(chipOf(mount({ surface: 'slate:abc', previewFocus: 'slate:abc' }))).toBeNull();
  });

  test('the chip titles the slate by name and the port by its pinned name', () => {
    const slates = [slate('abc', 'Dashboard')];
    const ports = [port('workspace', 3000, 'Arrived app')];

    expect(mount({ surface: 'Work', previewFocus: 'slate:abc', slates }).shown.chip?.title).toBe('Dashboard');
    expect(mount({ surface: 'Work', previewFocus: 'preview:workspace:3000', pinnedPorts: ports }).shown.chip?.title).toBe('Arrived app');
    expect(mount({ surface: 'Work', previewFocus: 'slate:xyz', slates }).shown.chip?.title).toBe('xyz');
  });
});

describe('dismissal, through the strip', () => {
  test('dismissChip puts the current arrival down without navigating', () => {
    const seen: SurfaceKind[] = [];

    const { passes } = mount({
      surface: 'Work',
      previewFocus: 'slate:abc',
      onSurface: (next) => { seen.push(next); },
      steps: [(focus) => { focus.dismissChip(); }],
    });

    expect(passes).toHaveLength(2);
    expect(passes[1]?.chip).toBeNull();
    expect(seen).toEqual([]);
  });

  test('a dismissed arrival stays down; a different arrival raises it again', () => {
    const { passes } = mount({
      surface: 'Work',
      previewFocus: 'slate:abc',
      steps: [
        (focus) => { focus.dismissChip(); },
        (_focus, controls) => { controls.setProps({ previewFocus: 'slate:def' }); },
      ],
    });

    expect(passes).toHaveLength(3);
    expect(passes[1]?.chip).toBeNull();
    expect(passes[2]?.chip?.surface).toBe('slate:def');
  });
});

describe('navigating consumes the arrival, through the strip', () => {
  test('explicit navigate goes to the surface it was given', () => {
    const seen: SurfaceKind[] = [];

    mount({
      surface: 'Work',
      previewFocus: 'preview:workspace:3000',
      pinnedPorts: [port('workspace', 3000, 'Arrived app')],
      onSurface: (next) => { seen.push(next); },
      steps: [(focus) => { focus.navigate('preview:workspace:3000'); }],
    });

    expect(seen).toEqual(['preview:workspace:3000']);
  });

  test('landing on the surface the arrival named consumes it — the chip is gone', () => {
    const seen: SurfaceKind[] = [];

    const { passes } = mount({
      surface: 'Work',
      previewFocus: 'slate:abc',
      onSurface: (next) => { seen.push(next); },
      steps: [(focus) => { focus.navigate('slate:abc'); }],
    });

    expect(passes).toHaveLength(2);
    expect(passes[1]?.chip).toBeNull();
    expect(seen).toEqual(['slate:abc']);
  });

  test('landing anywhere else leaves the arrival live — the chip is still owed', () => {
    const { passes } = mount({
      surface: 'Work',
      previewFocus: 'slate:abc',
      steps: [
        (focus, controls) => {
          focus.navigate('Files');
          controls.setProps({ surface: 'Files' });
        },
      ],
    });

    expect(passes).toHaveLength(2);
    expect(passes[1]).toEqual({ surface: 'Files', chip: { surface: 'slate:abc', title: 'abc' } });
  });

  test('an earlier dismissal is untouched by unrelated navigation', () => {
    const { passes } = mount({
      surface: 'Work',
      previewFocus: 'slate:abc',
      steps: [
        (focus) => { focus.dismissChip(); },
        (focus, controls) => {
          focus.navigate('Files');
          controls.setProps({ previewFocus: 'slate:def', surface: 'Files' });
        },
        (_focus, controls) => { controls.setProps({ previewFocus: 'slate:abc' }); },
      ],
    });

    expect(passes).toHaveLength(4);
    expect(passes[2]?.chip?.surface).toBe('slate:def');
    expect(passes[3]?.chip).toBeNull();
  });

  test('the chip click is the same navigate: onto the surface it announced', () => {
    const seen: SurfaceKind[] = [];

    const { passes } = mount({
      surface: 'Work',
      previewFocus: 'preview:workspace:3000',
      pinnedPorts: [port('workspace', 3000, 'Arrived app')],
      onSurface: (next) => { seen.push(next); },
      steps: [
        (focus) => {
          const chip = focus.readyChip;

          if (chip === null) throw new Error('a passive arrival owed a chip');
          focus.navigate(chip.surface);
        },
      ],
    });

    expect(seen).toEqual(['preview:workspace:3000']);
    expect(passes[1]?.chip).toBeNull();
  });
});

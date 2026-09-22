/**
 * The surface strip's focus policy through `useSurfaceFocus`. Strip chrome is covered in
 * scripts/chat-and-files-ux.test.ts and scripts/slate-preview-ux.test.ts.
 */
import { describe, expect, test } from 'bun:test';
import { createElement, useState } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { useSurfaceFocus, type SurfaceFocus } from '../src/components/surfaces/use-surface-focus';
import type { SurfaceKind } from '../src/components/surfaces/WorkSurface';
import type { SlateSummary } from '@kinu.run/core';
import type { PinnedPreviewPort as PinnedPort } from '@kinu.run/core';

const slate = (id: string, title: string): SlateSummary => ({ id, title, bindings: [] });

const port = (executor: string, portNumber: number, name: string): PinnedPort =>
  ({ executor, port: portNumber, url: `http://localhost:${String(portNumber)}`, name });

interface Pass {
  readonly attrs: string;
  readonly focus: SurfaceFocus;
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
  readonly html: string;
}

/** `renderToStaticMarkup` skips effects, and `useSurfaceFocus` holds none; each step runs once per render pass. */
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

    const attrs = `data-surface="${focus.surface}" `
      + `data-chip-surface="${focus.readyChip?.surface ?? ''}" `
      + `data-chip-title="${focus.readyChip?.title ?? ''}"`;

    passes.push({ attrs, focus });
    input.steps?.[passes.length - 1]?.(focus, {
      setProps: (next) => { setProps((prev) => ({ ...prev, ...next })); },
    });

    return createElement('div', {
      'data-surface': focus.surface,
      'data-chip-surface': focus.readyChip?.surface ?? '',
      'data-chip-title': focus.readyChip?.title ?? '',
    });
  }

  const html = renderToStaticMarkup(createElement(Strip));

  if (input.steps !== undefined && passes.length < input.steps.length) {
    throw new Error(`a scripted step never ran: ${String(passes.length)} pass(es) for ${String(input.steps.length)} step(s)`);
  }

  return { passes, html };
}

describe('a passive arrival, through the strip', () => {
  test('a slate arrival chips the surface it names; a port arrival chips its preview tab', () => {
    expect(mount({ surface: 'Work', previewFocus: 'slate:abc' }).html)
      .toContain('data-chip-surface="slate:abc"');
    expect(mount({ surface: 'Work', previewFocus: 'preview:workspace:3000' }).html)
      .toContain('data-chip-surface="preview:workspace:3000"');
    expect(mount({ surface: 'Work' }).html).toContain('data-chip-surface=""');
    expect(mount({ surface: 'Work', previewFocus: 'something-else' }).html)
      .toContain('data-chip-surface=""');
  });

  test('an arrival already on screen chips nothing', () => {
    expect(mount({ surface: 'slate:abc', previewFocus: 'slate:abc' }).html)
      .toContain('data-chip-surface=""');
  });

  test('the chip titles the slate by name and the port by its pinned name', () => {
    const slates = [slate('abc', 'Dashboard')];
    const ports = [port('workspace', 3000, 'Arrived app')];

    expect(mount({ surface: 'Work', previewFocus: 'slate:abc', slates }).html)
      .toContain('data-chip-title="Dashboard"');
    expect(mount({ surface: 'Work', previewFocus: 'preview:workspace:3000', pinnedPorts: ports }).html)
      .toContain('data-chip-title="Arrived app"');
    expect(mount({ surface: 'Work', previewFocus: 'slate:xyz', slates }).html)
      .toContain('data-chip-title="xyz"');
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
    expect(passes[1]?.attrs).toContain('data-chip-surface=""');
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
    expect(passes[1]?.attrs).toContain('data-chip-surface=""');
    expect(passes[2]?.attrs).toContain('data-chip-surface="slate:def"');
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
    expect(passes[1]?.attrs).toContain('data-chip-surface=""');
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
    expect(passes[1]?.attrs).toContain('data-surface="Files"');
    expect(passes[1]?.attrs).toContain('data-chip-surface="slate:abc"');
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
    expect(passes[2]?.attrs).toContain('data-chip-surface="slate:def"');
    expect(passes[3]?.attrs).toContain('data-chip-surface=""');
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
    expect(passes[1]?.attrs).toContain('data-chip-surface=""');
  });
});

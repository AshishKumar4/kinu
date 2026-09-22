/** Host↔client contract for slate UI surfaces. Browser-safe: strings, numbers and a valibot schema only. */

import * as v from 'valibot';
import { SlateDirectoryName } from './rpc';

/** Mirrored onto the iframe document so a slate matches the workspace theme. */
export const SLATE_THEME_TOKENS = [
  '--c-bg', '--c-text', '--c-text-2', '--c-text-3', '--c-accent', '--c-accent-fg',
  '--c-border', '--c-surface', '--c-fill', '--c-elevated', '--c-recessed',
  '--c-danger', '--c-success', '--c-warning', '--c-info',
] as const;

export interface SlateHostContext {
  readonly theme: 'dark' | 'light';
  readonly styles: { readonly variables: Readonly<Record<string, string>> };
  readonly containerDimensions: { readonly width: number; readonly height?: number };
  readonly display: 'inline' | 'pane';
  readonly origin: string;
}

const SlateHostContextSchema = v.strictObject({
  theme: v.picklist(['dark', 'light']),
  styles: v.strictObject({ variables: v.record(v.string(), v.string()) }),
  containerDimensions: v.strictObject({
    width: v.number(),
    height: v.optional(v.number()),
  }),
  display: v.picklist(['inline', 'pane']),
  origin: v.string(),
});

export const SLATE_HOST_CONTEXT_MESSAGE = 'host-context';

export const SLATE_SIZE_CHANGED_MESSAGE = 'size-changed';

export const SLATE_QUERY_PARAM = 'kinu';

export const SlateFrameMessageSchema = v.strictObject({
  kinu: v.literal(SLATE_SIZE_CHANGED_MESSAGE),
  height: v.number(),
});

/** `project.ts`'s `slate.inline` schema reads its bounds from these. */
export const SLATE_INLINE_HEIGHT = { min: 120, default: 320, max: 720 } as const;

export function slateInlineHeight(height: number): number {
  return Math.min(SLATE_INLINE_HEIGHT.max, Math.max(SLATE_INLINE_HEIGHT.min, height));
}

/** Accepted only from the slate's own window (identity check on `event.source`) and when it parses as the envelope. */
export function isSlateFrameMessage(
  event: { readonly source: unknown; readonly origin: string; readonly data: unknown },
  source: Window | MessagePort | null | undefined,
  origin: string,
): boolean {
  return event.source === source && event.origin === origin && v.safeParse(SlateFrameMessageSchema, event.data).success;
}

export function buildSlateHostContext(input: {
  readonly theme: 'dark' | 'light';
  readonly variables: Record<string, string>;
  readonly width: number;
  readonly height?: number;
  readonly display: 'inline' | 'pane';
  readonly origin: string;
}): SlateHostContext {
  const context: SlateHostContext = {
    theme: input.theme,
    styles: { variables: input.variables },
    containerDimensions: input.height === undefined
      ? { width: input.width }
      : { width: input.width, height: input.height },
    display: input.display,
    origin: input.origin,
  };

  return context;
}

/** The query carries context before the first postMessage can arrive; malformed context fails here, not in the frame. */
export function slateFrameSrc(url: string, context: SlateHostContext): string {
  const base = new URL(url);
  base.searchParams.set(SLATE_QUERY_PARAM, JSON.stringify(v.parse(SlateHostContextSchema, context)));

  return base.toString();
}

/** Any other href renders as ordinary markdown. */
export function slateLinkId(href: string): string | null {
  if (!href.startsWith('slate://')) return null;

  const id = href.slice('slate://'.length);

  return v.safeParse(SlateDirectoryName, id).success ? id : null;
}

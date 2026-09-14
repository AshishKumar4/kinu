/**
 * The host↔client contract every slate UI surface speaks, named ONCE here so
 * the chat card, the pane frame, the generated client module and the gallery
 * fixture all read the same vocabulary. This file is browser-safe by
 * declaration: the `@kinu.run/core/slates` barrel it exports through is
 * worker-only for its STORAGE modules, but these names are strings, numbers
 * and a valibot schema — the web bundle may import them freely.
 */

import * as v from 'valibot';
import { SlateDirectoryName } from './rpc';

/** The CSS custom properties a slate's chrome reads, mirrored onto the
 *  iframe's document so an authored slate matches the workspace theme it
 *  renders inside. Listed once: the host reads exactly this set off
 *  `document.documentElement` and the client applies exactly this set. */
export const SLATE_THEME_TOKENS = [
  '--c-bg', '--c-text', '--c-text-2', '--c-text-3', '--c-accent', '--c-accent-fg',
  '--c-border', '--c-surface', '--c-fill', '--c-elevated', '--c-recessed',
  '--c-danger', '--c-success', '--c-warning', '--c-info',
] as const;

/** What the host knows about the surface a slate renders into: theme, the
 *  theme tokens' live values, the card's measured size, which surface it is
 *  (`inline` chat card or full `pane`), and the origin postMessage targets. */
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

/** `postMessage` envelope names: the host pushes context under this `kinu`
 *  member, and the slate reports its content height under the other. */
export const SLATE_HOST_CONTEXT_MESSAGE = 'host-context';

export const SLATE_SIZE_CHANGED_MESSAGE = 'size-changed';

/** The query parameter a slate's iframe URL carries its first context in. */
export const SLATE_QUERY_PARAM = 'kinu';

/** The one size-changed message a slate's window may send its host. */
export const SlateFrameMessageSchema = v.strictObject({
  kinu: v.literal(SLATE_SIZE_CHANGED_MESSAGE),
  height: v.number(),
});

/** The chat card's height contract — `project.ts`'s `slate.inline` schema
 *  reads its bounds from these, so the schema and the card cannot drift. */
export const SLATE_INLINE_HEIGHT = { min: 120, default: 320, max: 720 } as const;

/** A slate's own height report, clamped to the card's legal band. Exported
 *  so the card's clamp and every test of it read the same bounds. */
export function slateInlineHeight(height: number): number {
  return Math.min(SLATE_INLINE_HEIGHT.max, Math.max(SLATE_INLINE_HEIGHT.min, height));
}

/** A `message` event counts as a slate's size report only when it came from
 *  that slate's own window on the preview origin and parses as the one
 *  envelope the contract publishes. `source` is what `event.source` carries
 *  for an iframe's postMessage — its contentWindow; the check is identity. */
export function isSlateFrameMessage(
  event: { readonly source: unknown; readonly origin: string; readonly data: unknown },
  source: Window | MessagePort | null | undefined,
  origin: string,
): boolean {
  return event.source === source && event.origin === origin && v.safeParse(SlateFrameMessageSchema, event.data).success;
}

/** The context a slate's first paint reads off its `?kinu=` query parameter.
 *  Pure: everything the card measures on the host page is an argument, so the
 *  unit test builds the same object the component does. */
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

/** The iframe URL with its one-time context attached. The query carries the
 *  context the slate reads BEFORE the first postMessage can arrive; later
 *  changes are messages, so this string is computed once per preview. The
 *  context is parsed through the schema it claims to satisfy — a malformed
 *  one fails here, not inside the frame. */
export function slateFrameSrc(url: string, context: SlateHostContext): string {
  const base = new URL(url);
  base.searchParams.set(SLATE_QUERY_PARAM, JSON.stringify(v.parse(SlateHostContextSchema, context)));

  return base.toString();
}

/** A `slate://<id>` link names one legal slate directory name or it is not a
 *  slate link at all — every other href renders as ordinary markdown. */
export function slateLinkId(href: string): string | null {
  if (!href.startsWith('slate://')) return null;

  const id = href.slice('slate://'.length);

  return v.safeParse(SlateDirectoryName, id).success ? id : null;
}

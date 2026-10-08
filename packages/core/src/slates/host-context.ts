/** Host↔client contract for slate UI surfaces. Browser-safe: strings, numbers and a valibot schema only. */

import * as v from 'valibot';
import { SlateDirectoryName } from './rpc';

/**
 * Mirrored onto the iframe document so a slate matches the workspace theme and the chat's type: the palette the page
 * already inlines (`THEME_CSS`) as the app has it now, the app's own tokens beside it, and its type stacks.
 */
export const SLATE_THEME_TOKENS = [
  '--c-bg', '--c-text', '--c-text-2', '--c-text-3', '--c-text-4', '--c-accent', '--c-accent-fg', '--c-accent-mark', '--c-accent-subtle',
  '--c-border', '--c-border-strong', '--c-surface', '--c-fill', '--c-elevated', '--c-recessed', '--c-input-bg', '--c-neutral-tint', '--c-code-bg',
  '--c-danger', '--c-success', '--c-warning', '--c-info',
  '--font-ui', '--font-display', '--font-serif', '--font-mono',
] as const;

export interface SlateHostContext {
  readonly theme: 'dark' | 'light';
  /** `fonts` is the app's `@font-face` rules with absolute URLs, so a slate sets its text in the chat's own faces. */
  readonly styles: { readonly variables: Readonly<Record<string, string>>; readonly fonts?: string };
  readonly containerDimensions: { readonly width: number; readonly height?: number };
  readonly display: 'inline' | 'pane';
  readonly origin: string;
}

export const SLATE_HOST_CONTEXT_MESSAGE = 'host-context';

export const SLATE_SIZE_CHANGED_MESSAGE = 'size-changed';

export const SLATE_QUERY_PARAM = 'kinu';

export const SlateFrameMessageSchema = v.strictObject({
  kinu: v.literal(SLATE_SIZE_CHANGED_MESSAGE),
  height: v.number(),
});

/**
 * An in-chat slate is as tall as its document, like the rest of the answer. This bounds only a page sized to its own
 * frame plus a margin, which would otherwise grow on every round of measuring.
 */
export const SLATE_INLINE_HEIGHT_LIMIT = 8000;

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
  readonly fonts?: string;
  readonly width: number;
  readonly height?: number;
  readonly display: 'inline' | 'pane';
  readonly origin: string;
}): SlateHostContext {
  const context: SlateHostContext = {
    theme: input.theme,
    styles: input.fonts === undefined || input.fonts === '' ? { variables: input.variables } : { variables: input.variables, fonts: input.fonts },
    containerDimensions: input.height === undefined
      ? { width: input.width }
      : { width: input.width, height: input.height },
    display: input.display,
    origin: input.origin,
  };

  return context;
}

/** The query carries context before the first postMessage can arrive. */
export function slateFrameSrc(url: string, context: SlateHostContext): string {
  const base = new URL(url);
  base.searchParams.set(SLATE_QUERY_PARAM, JSON.stringify(context));

  return base.toString();
}

/** Any other href renders as ordinary markdown. */
export function slateLinkId(href: string): string | null {
  if (!href.startsWith('slate://')) return null;

  const id = href.slice('slate://'.length);

  return v.safeParse(SlateDirectoryName, id).success ? id : null;
}

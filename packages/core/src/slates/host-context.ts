/** Host↔client contract for slate UI surfaces. Browser-safe: strings, numbers and a valibot schema only. */

import * as v from 'valibot';
import { SlateDirectoryName } from './rpc';

/**
 * Mirrored onto the iframe document so a slate matches the workspace theme and the chat's type: the palette the page
 * already inlines (`THEME_CSS`) as the app has it now, the app's own tokens beside it, and its type stacks.
 */
export const SLATE_THEME_TOKENS = [
  '--c-bg', '--c-text', '--c-text-2', '--c-text-3', '--c-accent', '--c-accent-fg', '--c-accent-mark', '--c-selected',
  '--c-border', '--c-border-strong', '--c-field-border', '--c-surface', '--c-fill', '--c-sunken', '--c-field', '--c-hover', '--c-code-bg',
  '--c-danger', '--c-success', '--c-warning', '--c-info',
  '--font-ui', '--font-display', '--font-serif', '--font-mono',
] as const;

/**
 * The names slates were written against before the design system renamed the palette (2026-10-21): a slate is the
 * person's own page, kept in their workspace, so the names it already uses keep meaning what they meant. Each reads the
 * role that took its place, on the slate page alone; the app itself knows only the new names.
 */
export const SLATE_LEGACY_TOKEN_CSS = `:root{${Object.entries({
  '--c-text-4': '--c-text-3', '--c-elevated': '--c-fill', '--c-recessed': '--c-sunken', '--c-input-bg': '--c-field',
  '--c-input-border': '--c-field-border', '--c-neutral-tint': '--c-hover', '--c-accent-subtle': '--c-selected', '--c-code': '--c-accent-fg',
}).map(([legacy, role]) => `${legacy}:var(${role})`).join(';')}}`;

export interface SlateHostContext {
  readonly theme: 'dark' | 'light';
  readonly styles: { readonly variables: Readonly<Record<string, string>> };
  readonly containerDimensions: { readonly width: number; readonly height?: number };
  readonly display: 'inline' | 'pane';
  readonly origin: string;
}

export const SLATE_HOST_CONTEXT_MESSAGE = 'host-context';

export const SLATE_SIZE_CHANGED_MESSAGE = 'size-changed';

/** The root attribute of a page the chat draws itself, whose `kinu:slate` session its host carries over a port: its
 *  value is the host's context (`SlateHostContext`), as a served page reads it from its address. */
export const SLATE_BRIDGE_ATTRIBUTE = 'data-slate-bridge';

/** What such a page sends its host with the port its session runs on. */
export const SLATE_BRIDGE_MESSAGE = 'bridge';

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

/** The query carries context before the first postMessage can arrive. */
export function slateFrameSrc(url: string, context: SlateHostContext): string {
  const base = new URL(url);
  base.searchParams.set(SLATE_QUERY_PARAM, JSON.stringify(context));

  return base.toString();
}

/**
 * What of a request to a share's host its viewer exchange keeps where it sends its visitor on: the host context the
 * slate's page was framed with (`?kinu=`), as a query, or ''. A ticket or consent exchange that dropped it would land the
 * slate's page knowing no app to answer to or frame its parts from.
 */
export function keptSlateContext(url: URL): string {
  const context = url.searchParams.get(SLATE_QUERY_PARAM);

  return context === null ? '' : new URLSearchParams({ [SLATE_QUERY_PARAM]: context }).toString();
}

/** Any other href renders as ordinary markdown. */
export function slateLinkId(href: string): string | null {
  if (!href.startsWith('slate://')) return null;

  const id = href.slice('slate://'.length);

  return v.safeParse(SlateDirectoryName, id).success ? id : null;
}

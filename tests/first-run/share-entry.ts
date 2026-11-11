/**
 * Where the app's page for a share frames it (`LIVE_SHARE_OPEN_PATH`): a share's link is that page, and its bare host
 * is handed to nothing else. A row that drives the host the way the page's frame does asks here, signed out for a
 * public share, or as a named person for their signed entry.
 */
import * as v from 'valibot';
import { consentToShare } from '@kinu.run/test-utils';
import { LIVE_SHARE_OPEN_PATH, LiveShareOpenSchema, type LiveShareOpen } from '@kinu.run/core';

export async function openShare(input: {
  readonly origin: string;
  readonly workspace: string;
  readonly share: string;
  readonly headers?: Readonly<Record<string, string>>;
}): Promise<LiveShareOpen | null> {
  const opened = await fetch(`${input.origin}${LIVE_SHARE_OPEN_PATH}`, {
    method: 'POST', headers: { ...input.headers, 'content-type': 'application/json' },
    body: JSON.stringify({ workspace: input.workspace, share: input.share }),
  });

  return opened.ok ? v.parse(LiveShareOpenSchema, await opened.json()) : null;
}

/** A public share's bare host as its page is told it signed out (null for no share, or one that would not open), and
 *  entering it as Kinu's page enters it for a visitor with no account (`consentToShare`): their viewer cookie. */
export interface SharedEntry {
  readonly url: string | null;
  enter(): Promise<string>;
}

export async function shareEntry(origin: string, workspace: string, share: string | undefined): Promise<SharedEntry> {
  const none: SharedEntry = { url: null, enter: async () => Promise.reject(new Error('no share to enter')) };

  if (share === undefined) return none;
  const id = share;
  const opened = await openShare({ origin, workspace, share: id });

  if (opened === null) return none;

  // What it reaches is read as the visitor enters, as Kinu's page reads it when they accept: a share lent since it was
  // first opened asks for that.
  return {
    url: opened.url,
    enter: async () => consentToShare({ url: opened.url, origin, binding: (await openShare({ origin, workspace, share: id }))?.consent?.binding ?? null }),
  };
}

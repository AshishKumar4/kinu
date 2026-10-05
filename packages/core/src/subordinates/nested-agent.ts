import { codenameFor } from '../identity/naming';
import type { Rpc, SubordinateRosterEntry } from '../protocol';
import type { SeekCursor } from '../session/page';
import type { SubordinateChild, SubordinateInspectionResult } from './inspection';

/** How the web UI reaches an agent below a direct child: its row in its parent's roster, kept or live. */

/** A blank name is a pre-codename row; it shows the word pair it would have been born with. */
export function agentTitle(entry: Pick<SubordinateRosterEntry, "name" | "displayName">): string {
  return entry.displayName.trim() || codenameFor(entry.name);
}

async function rosterRow(rpc: Rpc, roster: { path: string[]; actor?: string }, name: string): Promise<SubordinateChild | null> {
  let cursor: SeekCursor | undefined;

  do {
    const read = await rpc<SubordinateInspectionResult>('inspectSubordinate', [{ ...roster, view: 'children', page: cursor === undefined ? {} : { cursor } }]);

    if (read.view !== 'children') return null;
    const found = read.page.items.find((entry) => entry.name === name);

    if (found !== undefined) return found;
    cursor = read.page.status === 'more' ? read.page.next : undefined;
  } while (cursor !== undefined);

  return null;
}

export interface AgentLinkIds {
  readonly actor: string | null;
  readonly parent: string | null;
}

type NestedAgent = { readonly live: boolean; readonly title: string; readonly actorId: string | null };

export async function nestedAgent(rpc: Rpc, path: string, ids: AgentLinkIds): Promise<NestedAgent | null> {
  const names = path.split('/');
  const name = names.at(-1) ?? path;

  const live = await rosterRow(rpc, { path: names.slice(0, -1) }, name);

  if (live !== null) return { live: live.status !== 'dismissed', title: agentTitle(live), actorId: live.actorReference?.actorId ?? null };

  const kept = ids.parent === null ? null : await rosterRow(rpc, { path: [], actor: ids.parent }, name);

  if (kept !== null) return { live: false, title: agentTitle(kept), actorId: kept.actorReference?.actorId ?? null };

  return ids.actor === null ? null : { live: false, title: name, actorId: ids.actor };
}


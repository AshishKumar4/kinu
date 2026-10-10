/** The conversation of the helper the TUI has open: read whole when it opens, and only the open helper's answer shown. */
import { useEffect, useState } from 'react';
import { Effect } from 'effect';
import type { PositionCursor } from '@kinu.run/core';
import { detach, renderThrownChain } from '@kinu.run/core/obs';
import type { AgentClient } from '../agent-client';
import type { TuiSubagentChat } from './hubs';
import type { DisplayMessage } from './messages';

/** The helper an open surface names: by its path, or by its actor once it has one. */
export interface SubagentTarget {
  readonly path: readonly string[];
  readonly label: string;
  readonly actorId: string | null;
}

/** Null until the open helper's read has started; a read for a helper no longer open is never shown. */
export function useSubagentChat(client: AgentClient, target: SubagentTarget | null): TuiSubagentChat | null {
  const [chat, setChat] = useState<TuiSubagentChat | null>(null);

  useEffect(() => {
    if (target === null) return;
    const { path, label, actorId } = target;
    const name = path.join('/');
    let live = true;
    setChat({ name, label, messages: null, error: null });

    detach(Effect.promise(async () => {
      try {
        const conversation = await readConversation(client, actorId === null ? { path: [...path] } : { path: [], actor: actorId });

        if (live) setChat({ name, label, messages: conversation, error: null });
      } catch (cause) {
        if (live) setChat({ name, label, messages: null, error: `Its conversation could not be read: ${renderThrownChain({ cause })}` });
      }
    }));

    return () => { live = false; };
  }, [client, target]);

  return target !== null && chat?.name === target.path.join('/') ? chat : null;
}

/** Pages arrive newest first. */
async function readConversation(client: AgentClient, target: { path: string[]; actor?: string }): Promise<DisplayMessage[]> {
  const pages: DisplayMessage[][] = [];
  let cursor: PositionCursor | undefined;

  do {
    const result = await client.inspectSubordinate({ ...target, view: 'history', page: cursor === undefined ? {} : { cursor } });

    if (result.view === 'missing') throw new Error(result.error);

    if (result.view !== 'history') throw new Error(`the conversation read answered "${result.view}"`);
    pages.unshift(result.page.items.map((item) => ({ id: item.id, role: item.role, content: item.content })));
    cursor = result.page.status === 'more' ? result.page.next : undefined;
  } while (cursor !== undefined);

  return pages.flat();
}

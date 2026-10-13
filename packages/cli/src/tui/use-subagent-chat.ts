/** The conversation of the helper the TUI has open: read whole when it opens, and only the open helper's answer shown. */
import { useEffect, useState } from 'react';
import { Effect } from 'effect';
import { detach, renderThrownChain } from '@kinu.run/core/obs';
import { readConversation, type AgentClient } from '../agent-client';
import type { TuiSubagentChat } from './hubs';

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
        const helper = actorId === null ? { path: [...path] } : { path: [], actor: actorId };

        const conversation = await readConversation(async (page) => {
          const result = await client.inspectSubordinate({ ...helper, view: 'history', page });

          if (result.view === 'missing') throw new Error(result.error);

          if (result.view !== 'history') throw new Error(`the conversation read answered "${result.view}"`);

          return result.page;
        });

        if (live) setChat({ name, label, messages: conversation, error: null });
      } catch (cause) {
        if (live) setChat({ name, label, messages: null, error: `Its conversation could not be read: ${renderThrownChain({ cause })}` });
      }
    }));

    return () => { live = false; };
  }, [client, target]);

  return target !== null && chat?.name === target.path.join('/') ? chat : null;
}

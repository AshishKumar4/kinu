/** The conversation of the subagent the TUI has open: read whole when it opens, and only the open subagent's answer shown. */
import { useEffect, useState } from 'react';
import { Effect } from 'effect';
import { KinuError, detach, renderThrownChain, settle } from '@kinu.run/core/obs';
import { readConversation } from '@kinu.run/core';
import type { AgentClient } from '../agent-client';
import type { TuiSubagentChat } from './hubs';

/** The subagent an open surface names: by its path, or by its actor once it has one. */
export interface SubagentTarget {
  readonly path: readonly string[];
  readonly label: string;
  readonly actorId: string | null;
}

/** Null until the open subagent's read has started; a read for a subagent no longer open is never shown. */
export function useSubagentChat(client: AgentClient, target: SubagentTarget | null): TuiSubagentChat | null {
  const [chat, setChat] = useState<TuiSubagentChat | null>(null);

  useEffect(() => {
    if (target === null) return;
    const { path, label, actorId } = target;
    const name = path.join('/');
    let live = true;
    setChat({ name, label, messages: null, error: null });

    const subagent = actorId === null ? { path: [...path] } : { path: [], actor: actorId };

    // A page that is not the conversation's fails the read, said where the conversation would show.
    detach(Effect.match(Effect.tryPromise({ try: () => readConversation((at) => settle(Effect.gen(function* () {
      const result = yield* Effect.promise(() => client.inspectSubagent({ ...subagent, view: 'history', page: at }));

      if (result.view === 'missing') return yield* Effect.fail(new KinuError('missing', result.error));

      if (result.view !== 'history') return yield* Effect.fail(new KinuError('unavailable', `the conversation read answered "${result.view}"`));

      return result.page;
    }))), catch: (cause) => ({ cause }) }), {
      onSuccess: (conversation) => { if (live) setChat({ name, label, messages: conversation, error: null }); },
      onFailure: (failed) => { if (live) setChat({ name, label, messages: null, error: `Its conversation could not be read: ${renderThrownChain(failed)}` }); },
    }));

    return () => { live = false; };
  }, [client, target]);

  return target !== null && chat?.name === target.path.join('/') ? chat : null;
}

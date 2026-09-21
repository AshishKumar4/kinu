import * as v from 'valibot';
import { KinuError } from '../obs/error';

interface PairingMessage {
  readonly role: string;
  readonly content: string | readonly { readonly type: string; readonly toolCallId?: string }[];
}

const Text = v.string();

/** Pairing is ordered and includes provider-executed results carried by an assistant message. */
export interface ToolPairingGaps {
  readonly calls: ReadonlySet<string>;
  readonly results: ReadonlySet<string>;
}

export function toolPairingGaps(messages: readonly PairingMessage[]): ToolPairingGaps {
  const calls = new Set<string>();
  const results = new Set<string>();

  for (const message of messages) {
    if ((message.role !== 'assistant' && message.role !== 'tool') || v.is(Text, message.content)) continue;

    for (const part of message.content) {
      if (part.type !== 'tool-call' && part.type !== 'tool-result') continue;

      if (part.toolCallId === undefined) throw new KinuError('bad_input', 'tool history part has no call identity');

      if (part.type === 'tool-call') calls.add(part.toolCallId);
      else if (!calls.delete(part.toolCallId)) results.add(part.toolCallId);
    }
  }

  return { calls, results };
}

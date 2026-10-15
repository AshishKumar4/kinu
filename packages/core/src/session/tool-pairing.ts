import { Effect } from 'effect';
import { settleSync } from '../obs/effect';
import * as v from 'valibot';
import { KinuError } from '../obs/error';

interface PairingPart {
  readonly type: string;
  readonly toolCallId?: string;
}

interface PairingMessage<P extends PairingPart> {
  readonly role: string;
  readonly content: string | readonly P[];
}

const Text = v.string();

/** One call or result of a history, in order: the part as written, and the index and role of the message it rides. */
export interface ToolPairingPart<P extends PairingPart> {
  readonly at: number;
  readonly role: 'assistant' | 'tool';
  readonly part: P & { readonly type: 'tool-call' | 'tool-result'; readonly toolCallId: string };
}

/**
 * Every call and result an assistant or tool message carries, in order: provider-executed results an assistant message
 * carries among them. The one scan each pairing question projects: a part with no call identity is refused here.
 */
export function toolPairingParts<P extends PairingPart>(messages: readonly PairingMessage<P>[]): ToolPairingPart<P>[] {
  return settleSync(Effect.gen(function* () {
    const parts: ToolPairingPart<P>[] = [];

    for (const [at, message] of messages.entries()) {
      if ((message.role !== 'assistant' && message.role !== 'tool') || v.is(Text, message.content)) continue;

      for (const part of message.content) {
        if (part.type !== 'tool-call' && part.type !== 'tool-result') continue;

        if (part.toolCallId === undefined) return yield* new KinuError('bad_input', 'tool history part has no call identity');
        parts.push({ at, role: message.role, part: { ...part, type: part.type, toolCallId: part.toolCallId } });
      }
    }

    return parts;
  }));
}

/** Pairing is ordered and includes provider-executed results carried by an assistant message. */
export interface ToolPairingGaps {
  readonly calls: ReadonlySet<string>;
  readonly results: ReadonlySet<string>;
}

export function toolPairingGaps(messages: readonly PairingMessage<PairingPart>[]): ToolPairingGaps {
  const calls = new Set<string>();
  const results = new Set<string>();

  for (const { part } of toolPairingParts(messages)) {
    if (part.type === 'tool-call') calls.add(part.toolCallId);
    else if (!calls.delete(part.toolCallId)) results.add(part.toolCallId);
  }

  return { calls, results };
}

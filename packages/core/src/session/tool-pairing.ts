import { KinuError } from '../obs/error';

interface PairingPart {
  readonly type: string;
  readonly toolCallId?: string;
}

interface PairingMessage<P extends PairingPart> {
  readonly role: string;
  readonly content: string | readonly P[];
}

type CallOrResult<P extends PairingPart> = P & { readonly type: 'tool-call' | 'tool-result'; readonly toolCallId: string };

/** One call or result of a history, in order: the part as written, and the index and role of the message it rides. */
export interface ToolPairingPart<P extends PairingPart> {
  readonly at: number;
  readonly role: 'assistant' | 'tool';
  readonly part: CallOrResult<P>;
}

function callOrResult<P extends PairingPart>(part: P): part is CallOrResult<P> {
  if (part.type !== 'tool-call' && part.type !== 'tool-result') return false;

  if (part.toolCallId === undefined) throw new KinuError('bad_input', 'tool history part has no call identity');

  return true;
}

/**
 * Every call and result an assistant or tool message carries, in order: provider-executed results an assistant message
 * carries among them. The one scan each pairing question projects: a part with no call identity is refused here. Each
 * step asks it of the whole history, so it builds one entry per call or result and nothing per message (#m2180e).
 */
export function toolPairingParts<P extends PairingPart>(messages: readonly PairingMessage<P>[]): ToolPairingPart<P>[] {
  const parts: ToolPairingPart<P>[] = [];

  for (let at = 0; at < messages.length; at++) {
    const { role, content } = messages[at];

    if ((role !== 'assistant' && role !== 'tool') || typeof content === 'string') continue;

    for (let index = 0; index < content.length; index++) {
      const part = content[index];

      if (callOrResult(part)) parts.push({ at, role, part });
    }
  }

  return parts;
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

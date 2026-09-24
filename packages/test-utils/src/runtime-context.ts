import { DYNAMIC_CONTEXT_OPEN_TAG, TURN_CONTEXT_HEADER } from '@kinu.run/core';

/** A user-role message Kinu adds to a request for one step or turn (live state, turn-local context): never
 *  conversation, and never what a person or a parent wrote. */
export function isRuntimeContext(text: string): boolean {
  return text.startsWith(DYNAMIC_CONTEXT_OPEN_TAG) || text.startsWith(TURN_CONTEXT_HEADER);
}

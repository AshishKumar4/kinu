import { DYNAMIC_CONTEXT_OPEN_TAG, WORKSPACE_INSTRUCTIONS_TAG } from '@kinu.run/core';

/** A user-role message Kinu weaves into a request (live state, the unapproved workspace files): never
 *  conversation, and never what a person or a parent wrote. */
export function isRuntimeContext(text: string): boolean {
  return text.startsWith(DYNAMIC_CONTEXT_OPEN_TAG) || text.startsWith(`<${WORKSPACE_INSTRUCTIONS_TAG}>`);
}

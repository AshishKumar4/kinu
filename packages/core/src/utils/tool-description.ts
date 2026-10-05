import type { Tool } from 'ai';
import * as v from 'valibot';

/** A tool's description as a request carries it. ai 7 lets it be a function of the tool's context; Kinu gives a tool
 *  none, as the SDK does when no context is set. */
export function toolDescription(tool: Tool): string | undefined {
  const { description } = tool;

  if (description === undefined || v.is(v.string(), description)) return description;

  return description({ context: undefined });
}

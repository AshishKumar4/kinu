/**
 * What a grant of a tool is, decided once for every way a grant is made: whether calling the tool is an effect, and who
 * besides its holder observes what a call sends (the model's `Cap.effect` and `Cap.sink`). An MCP tool is judged by its
 * own server's read-only mark; the workspace's own surface by what each member does (`slateAddressImpact`).
 */
import { slateAddressImpact } from '../members';
import type { Audience } from './labels';

export interface GrantTerms {
  readonly effect: boolean;
  readonly sink: Audience;
}

const READS: GrantTerms = { effect: false, sink: [] };

/**
 * The terms of a grant of `tool` on `server`: an MCP tool its server marks read-only only reads; any other MCP tool may
 * send anywhere. Null for a member no slate reaches.
 */
export function toolTerms(server: string, tool: string, readOnlyMark: boolean): GrantTerms | null {
  if (server === 'ai') return READS;

  if (server.startsWith('mcp.')) return readOnlyMark ? READS : { effect: true, sink: 'anyone' };

  const impact = slateAddressImpact({ namespace: server, member: tool });

  if (impact === null) return null;

  if (impact === 'observe') return READS;

  return { effect: true, sink: impact === 'externalSend' || impact === 'execute' ? 'anyone' : [] };
}

/** One grant holding several tools: an effect if any is, observed by everyone any of them sends to. */
export function joinTerms(a: GrantTerms, b: GrantTerms): GrantTerms {
  const sink: Audience = a.sink === 'anyone' || b.sink === 'anyone' ? 'anyone' : [...new Set([...a.sink, ...b.sink])];

  return { effect: a.effect || b.effect, sink };
}

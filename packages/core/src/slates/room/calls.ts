/**
 * A call of a slate's code as its room keeps it: the part its output belongs to, and what it needed of its requester
 * that it did not hold, which the room asks for on the part and admits once allowed.
 */
import { sha256Hex } from '../../safety/argument-digest';
import type { JsonValue } from '../../utils/json';
import type { Session } from './caretaker';

/** What a call of the slate's code needed and did not hold: a connection of the requester's, for one function. */
export interface Need {
  readonly fn: string;
  readonly server: string;
  readonly tool: string;
  readonly root: Readonly<Record<string, string>>;
  readonly requester: string | null;
  /** The call that needed it, as it was asked: admitted once more when its requester allows the connection. */
  readonly call: { readonly session: Session | null; readonly args: readonly JsonValue[] };
}

/** A part's key: one function on one input, for one person when what it reads is theirs. */
export function partKey(fn: string, args: readonly JsonValue[], requester: string | null): string {
  return `${fn}.${sha256Hex(JSON.stringify(args), 16)}.${requester === null ? 'all' : sha256Hex(requester, 12)}`;
}

/** The function a part's key names. */
export function partFn(key: string): string {
  return key.slice(0, key.indexOf('.'));
}

/** The fixed arguments a grant is made for: a GitHub call's repository, nothing for any other. */
export function rootOf(server: string, args: JsonValue): Record<string, string> {
  if (!server.startsWith('mcp.') || args === null || typeof args !== 'object' || Array.isArray(args)) return {};
  const { owner, repo } = args;

  return typeof owner === 'string' && typeof repo === 'string' ? { owner, repo } : {};
}

/** A tool call's one argument, as its slate passed it: one argument itself, and several as their list. */
export function callArgument(args: readonly JsonValue[]): JsonValue {
  return args.length === 1 ? args[0] ?? null : [...args];
}

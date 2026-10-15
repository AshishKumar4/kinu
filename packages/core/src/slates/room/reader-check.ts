/**
 * The GitHub reader check (docs/SLATE-SHARING-SECURITY.md §2.1), decided by what a connection is and never by what it
 * is called. Anyone can add a server and name it GitHub; only the GitHub preset's endpoint is fixed by the preset, so
 * only a connection added from it, on the holder's side and on the reader's, takes part in a check.
 */
import * as v from 'valibot';
import { safeJsonParse } from '../../utils/json';
import type { Tag } from './labels';

/** The GitHub tool a reader check asks with the reader's own connection: a repository it finds is one they read. */
const READER_CHECK_TOOL = 'search_repositories';

/** How long a check's yes holds: a reader who lost the repository since is hidden again once it lapses. */
export const READER_CHECK_TTL_MS = 60 * 60 * 1000;

const GITHUB_PRESET = 'github';

/** A person's MCP tool as their account describes it: the server by its name and by the preset it was added from. */
export interface ConnectionTool {
  readonly serverName: string;
  readonly name: string;
  readonly presetId?: string;
}

/** What a check of one source asks: the reader's own GitHub search for the repository, or why there is nothing to ask. */
export type ReaderCheckPlan<Tool extends ConnectionTool> =
  | { readonly kind: 'ask'; readonly tool: Tool; readonly owner: string; readonly repo: string }
  | { readonly kind: 'unsupported' }
  | { readonly kind: 'no-connection' };

/**
 * A check of the source `tag` names, by the holder's and the reader's own connections. The holder's server must be
 * their GitHub connection and its root a repository; the reader asks with their own GitHub connection's search.
 */
export function planReaderCheck<Tool extends ConnectionTool>(
  tag: Pick<Tag, 'server' | 'root'>, holder: readonly ConnectionTool[], reader: readonly Tool[],
): ReaderCheckPlan<Tool> {
  const root = v.safeParse(v.object({ owner: v.string(), repo: v.string() }), safeJsonParse(tag.root));

  if (!tag.server.startsWith('mcp.') || !isGitHubConnection(holder, tag.server.slice('mcp.'.length)) || !root.success) return { kind: 'unsupported' };
  const tool = readerCheckTool(reader);

  return tool === null ? { kind: 'no-connection' } : { kind: 'ask', tool, owner: root.output.owner, repo: root.output.repo };
}

/** The reader's own GitHub search, or null when they have no GitHub connection: a namesake server is not one. */
function readerCheckTool<Tool extends ConnectionTool>(descriptors: readonly Tool[]): Tool | null {
  return descriptors.find((descriptor) => descriptor.presetId === GITHUB_PRESET && descriptor.name === READER_CHECK_TOOL) ?? null;
}

/** Whether a holder's server, by the name their grant calls it, is their GitHub connection: only then is its root a repository. */
function isGitHubConnection(descriptors: readonly ConnectionTool[], serverName: string): boolean {
  return descriptors.some((descriptor) => descriptor.serverName === serverName && descriptor.presetId === GITHUB_PRESET);
}

const SearchAnswerSchema = v.object({ items: v.array(v.object({ full_name: v.string() })) });

/** Whether a search answer lists the repository itself, by its exact full name; an error that echoes the query does not. */
export function searchFindsRepository(answer: string, owner: string, repo: string): boolean {
  const parsed = v.safeParse(SearchAnswerSchema, safeJsonParse(answer));
  const name = `${owner}/${repo}`.toLowerCase();

  return parsed.success && parsed.output.items.some((item) => item.full_name.toLowerCase() === name);
}

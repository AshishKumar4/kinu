// Imports nothing but its JSON, so a workerd test project can host it.
import catalog from '../fixtures/github-mcp-tools.json';

/**
 * GitHub's MCP server's own catalog as its `tools/list` answers: 131 tools, from github/github-mcp-server's tool
 * snapshots at e3809fe9. Real descriptions and schemas, bounds and patterns among them, where a synthetic catalog
 * would carry only what its test thought to put in it.
 */
export const GITHUB_MCP_TOOLS = catalog;

/**
 * Intents, and the tool each means, that codemode's search ranks first over this catalog. Chosen from a ten-query table
 * whose misses were measured, not pinned (2026-10-20): representative retrieval, not a benchmark of it.
 */
export const GITHUB_MCP_INTENTS = [
  ['merge pull request', 'merge_pull_request'],
  ['search code', 'search_code'],
  ['star a repository', 'star_repository'],
  ['close an issue', 'update_issue_state'],
  ['failed workflow logs', 'get_job_logs'],
  ['create a new branch', 'create_branch'],
] as const;

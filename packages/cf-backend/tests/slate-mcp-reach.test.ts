// A slate reaches its account's MCP tools by the server names its code calls.
import { expect, test } from 'bun:test';
import { mcpToolKey } from '@kinu.run/core';
import { writeText } from '@nimbus-sh/core/vfs/vfs.js';
import { orchestratorHarness, workspaceFiles, type RecordedUserPlaneCalls } from './helpers/actor-harness';
import { ROOT_SLATE_CALLER } from '@kinu.run/core/slates';

const KEY = mcpToolKey('tracker', 'find_issue');

// The owner's question (ledger 1015-n1): a fork reaches its forker's own server of the name its code calls, never the
// original owner's; one the forker has not connected is refused before anything is sent, saying to connect it.
test("a slate's call to a server this account has not connected says to connect it, and sends nothing", async () => {
  const mcp: NonNullable<RecordedUserPlaneCalls['mcp']> = {
    descriptors: [{ serverId: 'srv-1', serverName: 'tracker', name: 'find_issue', toolKey: KEY, readOnly: true, inputSchema: { type: 'object' } }],
    calls: [],
    answer: { id: 'ISSUE-7' },
  };

  const workspace = orchestratorHarness({ titles: [], mcp });

  workspace.agent.harnessHoldsCapability('harness-token');
  const files = workspaceFiles(workspace.agent);

  await files.mkdir('/slates/board', { recursive: true });
  await writeText(files, '/slates/board/package.json', JSON.stringify({ main: 'server.ts' }));

  const call = (path: string[]) => workspace.agent.slateCallAs({ caller: ROOT_SLATE_CALLER, id: 'board', name: 'workspace', lineage: { incarnation: 'test', generation: 0, ancestors: {} } }, {
    path, args: [{}], invocation: null,
  });

  expect(JSON.stringify(await call(['mcp', 'GitHub', 'issue_read']))).toContain('No MCP server named GitHub is connected to this account. Connect one in Settings > MCP servers');
  expect(JSON.stringify(await call(['mcp', 'tracker', 'close_issue']))).toContain('tracker offers no tool close_issue');
  expect(mcp.calls).toEqual([]);
});

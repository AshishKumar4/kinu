/**
 * A workspace object's tables exist from its constructor, whatever event reaches it first: a native RPC does not run
 * `onStart` (the Agents SDK starts only for fetch, alarm and its own RPCs), so schema that waited for a start was
 * missing on that path. A Nimbus sibling object, reached by an `nbf:` name, is not a workspace and gets none.
 */
import { describe, expect, test } from 'bun:test';
import { unstartedOrchestratorHarness } from './helpers/actor-harness';

describe('a workspace object is whole from its constructor', () => {
  test('a native RPC that is the object\u2019s first event reads the workspace\u2019s tables', async () => {
    const { agent } = unstartedOrchestratorHarness({ workspace: 'first-rpc' });

    expect(await agent.accountSpend()).toEqual([]);
  });

  test('a Nimbus sibling object holds no Kinu workspace', () => {
    const sibling = unstartedOrchestratorHarness(undefined, 'nbf:npm-resolve-fanout:0123abcd:0');

    expect(sibling.tableNames()).not.toContain('workspace_identity');
    expect(sibling.tableNames()).not.toContain('run_events');
  });
});

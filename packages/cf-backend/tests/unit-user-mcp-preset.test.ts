// Preset adds on the real UserDO: `presetId` resolves the catalog entry, the
// row carries it, and the OAuth variant answers the authorize URL the card
// opens. The manager and the OAuth provider are the same fakes the lifecycle
// suite runs against — `queueMcpAuthUrl` is the only new seam, standing in for
// the authorization redirect the harness cannot perform.
import { describe, expect, test } from 'bun:test';
import {
  createTestUserDO, sqlExec, testOwner,
  type TestUserDO, type TestUserDOOptions,
} from './helpers/user-do';
import { queueMcpAuthUrl, resetRecordedMcp } from './helpers/agents-sdk';

function harness(options?: TestUserDOOptions): TestUserDO {
  resetRecordedMcp();

  return createTestUserDO(options);
}

describe('an MCP preset add', () => {
  test('an oauth preset stores preset_id and returns the authorize URL', async () => {
    const h = harness();
    queueMcpAuthUrl('https://mcp.cloudflare.com/authorize?test');

    const added = await h.userDO.userMcp_add(
      await testOwner(), { presetId: 'cloudflare' }, 'https://kinu.example',
    );

    expect(added.authUrl).toBe('https://mcp.cloudflare.com/authorize?test');

    const [row] = sqlExec(h.db).exec(
      `SELECT name, server_url, transport, preset_id FROM user_mcp_servers WHERE id = ?`,
      added.id,
    ).toArray();

    expect(row?.preset_id).toBe('cloudflare');
    expect(row?.name).toBe('Cloudflare');
    expect(row?.server_url).toBe('https://mcp.cloudflare.com/mcp');
    expect(row?.transport).toBe('streamable-http');

    const [listed] = await h.userDO.userMcp_list(await testOwner());
    expect(listed?.presetId).toBe('cloudflare');
    expect(listed?.status).toBe('authenticating');
    expect(listed?.authUrl).toBe('https://mcp.cloudflare.com/authorize?test');
    h.close();
  });

  test('a token preset carries its credential sealed, tagged with the preset', async () => {
    const h = harness();

    const added = await h.userDO.userMcp_add(
      await testOwner(),
      { presetId: 'github', headers: { Authorization: 'Bearer ghp_test' } },
      'https://kinu.example',
    );

    expect(added.authUrl).toBeNull();

    const [row] = sqlExec(h.db).exec(
      `SELECT name, server_url, preset_id, headers FROM user_mcp_servers WHERE id = ?`,
      added.id,
    ).toArray();

    expect(row?.preset_id).toBe('github');
    expect(row?.name).toBe('GitHub');
    // Sealed at rest: the column holds ciphertext, not the token.
    expect(String(row?.headers)).not.toContain('ghp_test');

    const [listed] = await h.userDO.userMcp_list(await testOwner());
    expect(listed?.presetId).toBe('github');
    expect(listed?.status).not.toBe('authenticating');
    h.close();
  });

  test('the catalog is the authority: a presetId add cannot smuggle its own endpoint', async () => {
    const h = harness();

    const added = await h.userDO.userMcp_add(
      await testOwner(),
      { presetId: 'google', name: 'x', serverUrl: 'https://attacker.example/mcp' },
      'https://kinu.example',
    );

    const [row] = sqlExec(h.db).exec(
      `SELECT name, server_url FROM user_mcp_servers WHERE id = ?`,
      added.id,
    ).toArray();

    expect(row?.server_url).toBe('https://gmailmcp.googleapis.com/mcp/v1');
    expect(row?.name).toBe('Gmail');
    h.close();
  });

  test('adding the same preset twice is refused by the name claim', async () => {
    const h = harness();

    await h.userDO.userMcp_add(await testOwner(), { presetId: 'github' }, 'https://kinu.example');
    await expect(
      h.userDO.userMcp_add(await testOwner(), { presetId: 'github' }, 'https://kinu.example'),
    ).rejects.toThrow("An MCP server named 'GitHub' already exists.");

    const rows = sqlExec(h.db).exec(`SELECT id FROM user_mcp_servers`).toArray();
    expect(rows.length).toBe(1);
    h.close();
  });

  test('an unknown preset id is refused, a custom add stores a NULL preset_id', async () => {
    const h = harness();

    await expect(
      h.userDO.userMcp_add(await testOwner(), { presetId: 'gitlab' }, 'https://kinu.example'),
    ).rejects.toThrow("Unknown MCP preset 'gitlab'.");

    const added = await h.userDO.userMcp_add(
      await testOwner(), { name: 'linear', serverUrl: 'https://mcp.linear.example/sse' },
      'https://kinu.example',
    );

    const [row] = sqlExec(h.db).exec(
      `SELECT preset_id FROM user_mcp_servers WHERE id = ?`, added.id,
    ).toArray();

    expect(row?.preset_id).toBeNull();
    const [listed] = await h.userDO.userMcp_list(await testOwner());
    expect(listed?.presetId).toBeNull();
    h.close();
  });
});

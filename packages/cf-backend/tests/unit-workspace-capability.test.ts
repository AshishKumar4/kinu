// Workspace capability tokens + the taint registry — store-level behavior:
// hashed at rest, identity separate from tier, fail closed on every unknown.
// Run against real SQLite through the same SqlExec seam the UserDO provides.
import { describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import {
  CapabilityDeniedError,
  OWNER_SESSION,
  WORKSPACE_CAPABILITY_TIERS,
  getWorkspaceTier,
  initWorkspaceCapabilityTables,
  mintWorkspaceCapability,
  requireTier,
  revokeWorkspaceCapability,
  setWorkspaceTier,
  type WorkspaceCapability,
} from '../src/user/workspace-capability.js';
import { isModelInferenceCredentialKey } from '../src/user/credential-headers.js';
import { sqlExec } from './helpers/user-do.js';

function setup() {
  const db = new Database(':memory:');
  const sql = sqlExec(db);
  initWorkspaceCapabilityTables(sql);
  return { db, sql };
}

const CAPABILITIES = Object.keys(WORKSPACE_CAPABILITY_TIERS) as WorkspaceCapability[];

describe('capability token mint', () => {
  test('stores only the hash — the raw token never lands in SQLite', async () => {
    const { db, sql } = setup();
    const minted = await mintWorkspaceCapability(sql, 'workspace-a');

    const rows = db.prepare('SELECT * FROM workspace_capability_tokens').all() as Array<Record<string, unknown>>;
    expect(rows).toHaveLength(1);
    expect(JSON.stringify(rows[0])).not.toContain(minted.token);
    expect(rows[0]!.token_hash).toBe(minted.tokenHash);
    db.close();
  });

  test('registers the workspace as full — Wave B1 taints nothing', async () => {
    const { db, sql } = setup();
    await mintWorkspaceCapability(sql, 'workspace-a');
    expect(getWorkspaceTier(sql, 'workspace-a')).toBe('full');
    db.close();
  });

  test('re-minting replaces the secret but never launders the tier', async () => {
    const { db, sql } = setup();
    const first = await mintWorkspaceCapability(sql, 'workspace-a');
    setWorkspaceTier(sql, 'workspace-a', 'shared');

    const second = await mintWorkspaceCapability(sql, 'workspace-a');
    expect(second.token).not.toBe(first.token);
    expect(getWorkspaceTier(sql, 'workspace-a')).toBe('shared');

    // The superseded token is dead; only one identity row per workspace exists.
    await expect(requireTier(sql, { workspaceToken: first.token }, 'credentials.model')).rejects.toThrow(CapabilityDeniedError);
    expect(db.prepare('SELECT COUNT(*) AS n FROM workspace_capability_tokens').get<{ n: number }>()!.n).toBe(1);
    db.close();
  });

  test('revoke drops both identity and tier so a same-name recreate starts clean', async () => {
    const { db, sql } = setup();
    const minted = await mintWorkspaceCapability(sql, 'workspace-a');
    revokeWorkspaceCapability(sql, 'workspace-a');

    expect(getWorkspaceTier(sql, 'workspace-a')).toBeNull();
    await expect(requireTier(sql, { workspaceToken: minted.token }, 'credentials.model')).rejects.toThrow(CapabilityDeniedError);
    db.close();
  });
});

describe('requireTier fails closed', () => {
  test('denies a caller that presents nothing', async () => {
    const { db, sql } = setup();
    for (const bogus of [undefined, null, '', 'owner', {}, { workspaceToken: '' }, { workspaceToken: 7 }]) {
      await expect(requireTier(sql, bogus as never, 'credentials.model')).rejects.toThrow(CapabilityDeniedError);
    }
    db.close();
  });

  test('denies an unknown token', async () => {
    const { db, sql } = setup();
    await mintWorkspaceCapability(sql, 'workspace-a');
    await expect(requireTier(sql, { workspaceToken: 'pwc_nope' }, 'credentials.model'))
      .rejects.toThrow(/Unrecognized workspace capability token/);
    db.close();
  });

  test('denies a valid token whose workspace lost its registry row', async () => {
    const { db, sql } = setup();
    const minted = await mintWorkspaceCapability(sql, 'workspace-a');
    db.prepare('DELETE FROM workspace_tiers WHERE workspace_name = ?').run('workspace-a');

    await expect(requireTier(sql, { workspaceToken: minted.token }, 'credentials.model'))
      .rejects.toThrow(/no capability tier registered/);
    db.close();
  });

  test('denies a tier value the registry should never hold', async () => {
    const { db, sql } = setup();
    const minted = await mintWorkspaceCapability(sql, 'workspace-a');
    // CHECK constraint blocks the normal path, so corrupt the row the only way
    // a damaged database could.
    db.exec(`
      DROP TABLE workspace_tiers;
      CREATE TABLE workspace_tiers (workspace_name TEXT PRIMARY KEY, tier TEXT NOT NULL, updated_at INTEGER NOT NULL);
      INSERT INTO workspace_tiers VALUES ('workspace-a', 'admin', 1);
    `);
    await expect(requireTier(sql, { workspaceToken: minted.token }, 'credentials.model'))
      .rejects.toThrow(CapabilityDeniedError);
    db.close();
  });
});

describe('the attenuation matrix', () => {
  test('a full workspace reaches every capability', async () => {
    const { db, sql } = setup();
    const minted = await mintWorkspaceCapability(sql, 'workspace-a');
    for (const capability of CAPABILITIES) {
      expect(await requireTier(sql, { workspaceToken: minted.token }, capability))
        .toEqual({ kind: 'workspace', workspace: 'workspace-a', tier: 'full' });
    }
    db.close();
  });

  test('a shared workspace keeps exactly the shared-tier capabilities', async () => {
    const { db, sql } = setup();
    const minted = await mintWorkspaceCapability(sql, 'workspace-a');
    setWorkspaceTier(sql, 'workspace-a', 'shared');

    for (const capability of CAPABILITIES) {
      const call = requireTier(sql, { workspaceToken: minted.token }, capability);
      if (WORKSPACE_CAPABILITY_TIERS[capability] === 'shared') {
        expect(await call).toEqual({ kind: 'workspace', workspace: 'workspace-a', tier: 'shared' });
      } else {
        await expect(call).rejects.toThrow(CapabilityDeniedError);
      }
    }
    db.close();
  });

  test('the surviving capabilities are only the agent-function ones', () => {
    const kept = CAPABILITIES.filter((c) => WORKSPACE_CAPABILITY_TIERS[c] === 'shared');
    expect(kept.sort()).toEqual(['credentials.model', 'workspaces.rename_self']);
  });

  test('an owner session is never attenuated', async () => {
    const { db, sql } = setup();
    for (const capability of CAPABILITIES) {
      expect(await requireTier(sql, OWNER_SESSION, capability)).toEqual({ kind: 'owner_session' });
    }
    db.close();
  });

  test('one workspace token never resolves as another workspace', async () => {
    const { db, sql } = setup();
    const a = await mintWorkspaceCapability(sql, 'workspace-a');
    await mintWorkspaceCapability(sql, 'workspace-b');
    setWorkspaceTier(sql, 'workspace-a', 'shared');

    // b stays full; a's token must not inherit b's tier.
    await expect(requireTier(sql, { workspaceToken: a.token }, 'device.rpc')).rejects.toThrow(CapabilityDeniedError);
    const resolved = await requireTier(sql, { workspaceToken: a.token }, 'credentials.model');
    expect(resolved).toEqual({ kind: 'workspace', workspace: 'workspace-a', tier: 'shared' });
    db.close();
  });
});

describe('model-inference credential keys', () => {
  test('accepts every provider key shape the model picker derives from', () => {
    for (const key of [
      'codex.oauth', 'cloudflare.oauth', 'cloudflare.ai-gateway',
      'openai.bearer', 'anthropic.bearer', 'openrouter.bearer', 'deepseek-v3.bearer',
      'openai-compat.mybox',
    ]) {
      expect(isModelInferenceCredentialKey(key)).toBe(true);
    }
  });

  test('rejects non-model keys — an unrecognized shape is never a model key', () => {
    for (const key of ['github', 'gateway-admin', 'bearer', '.bearer', 'openai-compat.', 'GITHUB.BEARER']) {
      expect(isModelInferenceCredentialKey(key)).toBe(false);
    }
  });
});

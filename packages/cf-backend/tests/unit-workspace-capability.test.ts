// Workspace capability tokens + the taint registry — store-level behavior:
// hashed at rest, identity separate from tier, fail closed on every unknown.
// Run against real SQLite through the same SqlExec seam the UserDO provides.
import { describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import * as v from 'valibot';
import type { SqlExec } from '@kinu.run/core';
import {
  CapabilityDeniedError,
  WORKSPACE_CAPABILITY_TIERS,
  ownerCaller,
  getWorkspaceTier,
  initWorkspaceCapabilityTables,
  commitWorkspaceCapability,
  freshWorkspaceCapability,
  requireTier,
  revokeWorkspaceCapability,
  setWorkspaceTier,
  type WorkspaceCapability,
} from '../src/user/workspace-capability';
import { isModelInferenceCredentialKey } from '../src/user/credential-headers';
import { TEST_USER_ENV, sqlExec, testOwner } from './helpers/user-do';

function setup() {
  const db = new Database(':memory:');
  const sql = sqlExec(db);
  initWorkspaceCapabilityTables(sql);
  return { db, sql };
}

/** The two phases the UserDO drives, composed. These tests are about what the
 *  store holds; the fence the UserDO puts BETWEEN them — its re-check that the
 *  workspace is still mintable — is exercised where that fence lives, in
 *  unit-user-authority-races.test.ts. */
async function mintWorkspaceCapability(
  sql: SqlExec, workspaceName: string,
): Promise<{ token: string; tokenHash: string }> {
  const fresh = await freshWorkspaceCapability();
  commitWorkspaceCapability(sql, workspaceName, fresh.tokenHash);
  return fresh;
}

function isWorkspaceCapability(value: string): value is WorkspaceCapability {
  return Object.hasOwn(WORKSPACE_CAPABILITY_TIERS, value);
}

const CAPABILITIES = Object.keys(WORKSPACE_CAPABILITY_TIERS).filter(isWorkspaceCapability);

describe('capability token mint', () => {
  test('stores only the hash — the raw token never lands in SQLite', async () => {
    const { db, sql } = setup();
    const minted = await mintWorkspaceCapability(sql, 'workspace-a');

    const CapabilityTokenRowSchema = v.object({
      workspace_name: v.string(),
      token_hash: v.string(),
      created_at: v.number(),
    });
    const rows = v.parse(
      v.array(CapabilityTokenRowSchema),
      db.prepare('SELECT workspace_name, token_hash, created_at FROM workspace_capability_tokens').all(),
    );
    expect(rows).toHaveLength(1);
    expect(JSON.stringify(rows[0])).not.toContain(minted.token);
    expect(rows[0]?.token_hash).toBe(minted.tokenHash);
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
    await expect(requireTier(sql, TEST_USER_ENV, { workspaceToken: first.token }, 'credentials.model')).rejects.toThrow(CapabilityDeniedError);
    const count = v.parse(
      v.object({ n: v.number() }),
      db.prepare('SELECT COUNT(*) AS n FROM workspace_capability_tokens').get(),
    );
    expect(count.n).toBe(1);
    db.close();
  });

  test('revoke drops both identity and tier so a same-name recreate starts clean', async () => {
    const { db, sql } = setup();
    const minted = await mintWorkspaceCapability(sql, 'workspace-a');
    revokeWorkspaceCapability(sql, 'workspace-a');

    expect(getWorkspaceTier(sql, 'workspace-a')).toBeNull();
    await expect(requireTier(sql, TEST_USER_ENV, { workspaceToken: minted.token }, 'credentials.model')).rejects.toThrow(CapabilityDeniedError);
    db.close();
  });
});

describe('requireTier fails closed', () => {
  test('denies a caller that presents nothing', async () => {
    const { db, sql } = setup();
    for (const bogus of [undefined, null, '', 'owner', {}, { workspaceToken: '' }, { workspaceToken: 7 }]) {
      await expect(requireTier(sql, TEST_USER_ENV, bogus, 'credentials.model')).rejects.toThrow(CapabilityDeniedError);
    }
    db.close();
  });

  test('owner authority is a derived secret, not a string anyone can type', async () => {
    const { db, sql } = setup();
    const owner = await testOwner();
    expect(await requireTier(sql, TEST_USER_ENV, owner, 'credentials.other')).toEqual({ kind: 'owner_session' });

    // The sentinel this replaced, and a guess at the token itself.
    for (const bogus of ['owner_session', { ownerToken: 'owner_session' }, { ownerToken: 'a'.repeat(64) }]) {
      await expect(requireTier(sql, TEST_USER_ENV, bogus, 'credentials.other'))
        .rejects.toThrow(CapabilityDeniedError);
    }

    // A deployment holding a different secret derives a different capability,
    // so an owner token cannot be lifted from one deployment to another.
    const foreign = await ownerCaller({ CREDENTIAL_ENCRYPTION_KEY: 'a-completely-different-root-secret-value' });
    await expect(requireTier(sql, TEST_USER_ENV, foreign, 'credentials.other'))
      .rejects.toThrow(/Unrecognized owner capability/);
    db.close();
  });

  test('without the secret there is no owner capability to present', async () => {
    const { db, sql } = setup();
    await expect(ownerCaller({})).rejects.toThrow(/CREDENTIAL_ENCRYPTION_KEY/);
    await expect(requireTier(sql, {}, await testOwner(), 'credentials.other'))
      .rejects.toThrow(/CREDENTIAL_ENCRYPTION_KEY/);
    db.close();
  });

  test('denies an unknown token', async () => {
    const { db, sql } = setup();
    await mintWorkspaceCapability(sql, 'workspace-a');
    await expect(requireTier(sql, TEST_USER_ENV, { workspaceToken: 'pwc_nope' }, 'credentials.model'))
      .rejects.toThrow(/Unrecognized workspace capability token/);
    db.close();
  });

  test('denies a valid token whose workspace lost its registry row', async () => {
    const { db, sql } = setup();
    const minted = await mintWorkspaceCapability(sql, 'workspace-a');
    db.prepare('DELETE FROM workspace_tiers WHERE workspace_name = ?').run('workspace-a');

    await expect(requireTier(sql, TEST_USER_ENV, { workspaceToken: minted.token }, 'credentials.model'))
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
    await expect(requireTier(sql, TEST_USER_ENV, { workspaceToken: minted.token }, 'credentials.model'))
      .rejects.toThrow(CapabilityDeniedError);
    db.close();
  });
});

describe('the attenuation matrix', () => {
  test('a full workspace reaches every workspace capability, and no owner-only one', async () => {
    const { db, sql } = setup();
    const minted = await mintWorkspaceCapability(sql, 'workspace-a');
    for (const capability of CAPABILITIES) {
      const call = requireTier(sql, TEST_USER_ENV, { workspaceToken: minted.token }, capability);
      if (WORKSPACE_CAPABILITY_TIERS[capability] === 'owner_only') {
        // `owner_only` is a FLOOR, not a tier: `full` is the top workspace
        // tier and is refused anyway, which is why the third value exists
        // instead of a fourth rank above `full`.
        await expect(call).rejects.toThrow(CapabilityDeniedError);
      } else {
        expect(await call).toEqual({ kind: 'workspace', workspace: 'workspace-a', tier: 'full' });
      }
    }
    db.close();
  });

  test('a shared workspace keeps exactly the shared-tier capabilities', async () => {
    const { db, sql } = setup();
    const minted = await mintWorkspaceCapability(sql, 'workspace-a');
    setWorkspaceTier(sql, 'workspace-a', 'shared');

    for (const capability of CAPABILITIES) {
      const call = requireTier(sql, TEST_USER_ENV, { workspaceToken: minted.token }, capability);
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
    // `auth_tokens.socket` is not an exception to that rule: it grants a
    // workspace nothing except the ability to close a socket ON ITSELF, and a
    // tainted workspace that could not ask would be the one place a revocation
    // could not be enforced.
    expect(kept.sort()).toEqual([
      'auth_tokens.socket', 'credentials.model', 'profile.resolve', 'workspaces.rename_self',
    ]);
  });

  test('an owner session is never attenuated', async () => {
    const { db, sql } = setup();
    for (const capability of CAPABILITIES) {
      expect(await requireTier(sql, TEST_USER_ENV, await testOwner(), capability)).toEqual({ kind: 'owner_session' });
    }
    db.close();
  });

  test('one workspace token never resolves as another workspace', async () => {
    const { db, sql } = setup();
    const a = await mintWorkspaceCapability(sql, 'workspace-a');
    await mintWorkspaceCapability(sql, 'workspace-b');
    setWorkspaceTier(sql, 'workspace-a', 'shared');

    // b stays full; a's token must not inherit b's tier.
    await expect(requireTier(sql, TEST_USER_ENV, { workspaceToken: a.token }, 'device.rpc')).rejects.toThrow(CapabilityDeniedError);
    const resolved = await requireTier(sql, TEST_USER_ENV, { workspaceToken: a.token }, 'credentials.model');
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

// Workspace capability tokens — store-level behavior: hashed at rest, identity
// separate from admission, fail closed on every unknown. Run against real
// SQLite through the same SqlExec seam the UserDO provides.
import { describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import * as v from 'valibot';
import type { SqlExec } from '@kinu.run/core';
import {
  CapabilityDeniedError,
  ownerCaller,
  initWorkspaceCapabilityTables,
  commitWorkspaceCapability,
  freshWorkspaceCapability,
  requireTier,
  revokeWorkspaceCapability,
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

/** One capability per floor, by public name. The gate holds no per-capability
 *  logic beyond the floor, so representatives carry the behavior and no test
 *  duplicates the matrix. */
const WORKSPACE_CAPABILITIES: WorkspaceCapability[] = [
  'credentials.model', 'device.rpc', 'workspaces.rename_self',
];
const OWNER_ONLY_CAPABILITIES: WorkspaceCapability[] = ['device.consent', 'device.manage'];

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

  test('a minted workspace is admitted', async () => {
    const { db, sql } = setup();
    const minted = await mintWorkspaceCapability(sql, 'workspace-a');
    expect(await requireTier(sql, TEST_USER_ENV, { workspaceToken: minted.token }, 'credentials.model'))
      .toEqual({ kind: 'workspace', workspace: 'workspace-a' });
    db.close();
  });

  test('re-minting replaces the secret and keeps admission', async () => {
    const { db, sql } = setup();
    const first = await mintWorkspaceCapability(sql, 'workspace-a');

    const second = await mintWorkspaceCapability(sql, 'workspace-a');
    expect(second.token).not.toBe(first.token);
    expect(await requireTier(sql, TEST_USER_ENV, { workspaceToken: second.token }, 'credentials.model'))
      .toEqual({ kind: 'workspace', workspace: 'workspace-a' });

    // The superseded token is dead; only one identity row per workspace exists.
    await expect(requireTier(sql, TEST_USER_ENV, { workspaceToken: first.token }, 'credentials.model')).rejects.toThrow(CapabilityDeniedError);
    const count = v.parse(
      v.object({ n: v.number() }),
      db.prepare('SELECT COUNT(*) AS n FROM workspace_capability_tokens').get(),
    );
    expect(count.n).toBe(1);
    db.close();
  });

  test('revoke drops the identity so a same-name recreate starts clean', async () => {
    const { db, sql } = setup();
    const minted = await mintWorkspaceCapability(sql, 'workspace-a');
    revokeWorkspaceCapability(sql, 'workspace-a');

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

});

describe('the attenuation matrix', () => {
  test('a registered workspace reaches workspace capabilities, and no owner-only one', async () => {
    const { db, sql } = setup();
    const minted = await mintWorkspaceCapability(sql, 'workspace-a');
    for (const capability of WORKSPACE_CAPABILITIES) {
      expect(await requireTier(sql, TEST_USER_ENV, { workspaceToken: minted.token }, capability))
        .toEqual({ kind: 'workspace', workspace: 'workspace-a' });
    }
    for (const capability of OWNER_ONLY_CAPABILITIES) {
      await expect(requireTier(sql, TEST_USER_ENV, { workspaceToken: minted.token }, capability))
        .rejects.toThrow(CapabilityDeniedError);
    }
    db.close();
  });

  test('an owner session is never attenuated', async () => {
    const { db, sql } = setup();
    for (const capability of [...WORKSPACE_CAPABILITIES, ...OWNER_ONLY_CAPABILITIES]) {
      expect(await requireTier(sql, TEST_USER_ENV, await testOwner(), capability)).toEqual({ kind: 'owner_session' });
    }
    db.close();
  });

  test('one workspace token never resolves as another workspace', async () => {
    const { db, sql } = setup();
    const a = await mintWorkspaceCapability(sql, 'workspace-a');
    await mintWorkspaceCapability(sql, 'workspace-b');

    const resolved = await requireTier(sql, TEST_USER_ENV, { workspaceToken: a.token }, 'credentials.model');
    expect(resolved).toEqual({ kind: 'workspace', workspace: 'workspace-a' });
    await expect(requireTier(sql, TEST_USER_ENV, { workspaceToken: a.token }, 'device.consent'))
      .rejects.toThrow(CapabilityDeniedError);
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

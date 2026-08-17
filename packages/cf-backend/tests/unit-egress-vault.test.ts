// The egress secret vault: what it stores, what it will hand back, and what it
// refuses. Run against a real bun:sqlite table and the real AES-GCM envelope,
// so the encryption and the AAD binding are exercised rather than faked.
import { describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { EGRESS_PLACEHOLDER_PREFIX, isEgressPlaceholder } from '@proteus/core';
import { createCredentialCipher } from '../src/user/credential-envelope.js';
import {
  initEgressVaultTables, listEgressSecrets, putEgressSecret,
  resolveEgressInjection, revokeEgressSecret, rewrapEgressSecrets,
  type EgressVaultDeps,
} from '../src/user/egress-vault.js';
import { USER_DO_RPC_SURFACE } from '../src/rpc-surface.js';
import {
  TEST_CREDENTIAL_ENCRYPTION_KEY, TEST_USER_ENV, sqlExec,
} from './helpers/user-do.js';

const SECRET = 'sk_live_0123456789abcdefghij';

async function vault(): Promise<EgressVaultDeps & { db: Database }> {
  const db = new Database(':memory:');
  const sql = sqlExec(db);
  initEgressVaultTables(sql);
  const cipher = await createCredentialCipher(TEST_USER_ENV);
  return { db, sql, cipher, aad: (id) => `test-user-do:egress:${id}` };
}

const STRIPE = { id: 'stripe', label: 'Stripe live', host: 'api.stripe.com', secret: SECRET };

describe('the vault stores a secret without ever handing it back', () => {
  test('a placeholder is minted, and it is not derived from the secret', async () => {
    const deps = await vault();
    const binding = await putEgressSecret(deps, STRIPE);
    expect(isEgressPlaceholder(binding.placeholder)).toBe(true);
    expect(binding.placeholder.startsWith(EGRESS_PLACEHOLDER_PREFIX)).toBe(true);
    // No transform of the secret appears in the placeholder, and the secret
    // does not appear in it: the placeholder is fresh randomness.
    expect(binding.placeholder).not.toContain(SECRET);
    expect(binding.placeholder).not.toContain(SECRET.slice(0, 8));

    // Two bindings holding the SAME secret get different placeholders, so a
    // container cannot learn that two of its dummies stand for one value.
    const other = await putEgressSecret(deps, { ...STRIPE, id: 'stripe-2' });
    expect(other.placeholder).not.toBe(binding.placeholder);
  });

  test('the listing surfaces carry no secret material at all', async () => {
    const deps = await vault();
    await putEgressSecret(deps, STRIPE);
    const serialized = JSON.stringify(listEgressSecrets(deps.sql));
    expect(serialized).not.toContain(SECRET);
    expect(serialized).toContain('api.stripe.com');
  });

  test('the stored column is sealed, not plaintext', async () => {
    const deps = await vault();
    await putEgressSecret(deps, STRIPE);
    const stored = String(deps.sql.exec(`SELECT secret FROM user_egress_secrets`).toArray()[0]!.secret);
    expect(stored.startsWith('pce1.')).toBe(true);
    expect(stored).not.toContain(SECRET);
  });

  test('a secret sealed for one binding cannot be opened as another', async () => {
    const deps = await vault();
    await putEgressSecret(deps, STRIPE);
    const stored = String(deps.sql.exec(`SELECT secret FROM user_egress_secrets`).toArray()[0]!.secret);
    await expect(deps.cipher.open(deps.aad('some-other-binding'), stored)).rejects.toThrow();
  });
});

describe('add, rotate, revoke', () => {
  test('rotating a secret keeps its placeholder, so the container needs no change', async () => {
    const deps = await vault();
    const first = await putEgressSecret(deps, STRIPE);
    const rotated = await putEgressSecret(deps, { ...STRIPE, secret: 'sk_live_rotated_value_here' });
    expect(rotated.placeholder).toBe(first.placeholder);
    const resolved = await resolveEgressInjection(
      deps,
      { host: 'api.stripe.com', url: 'https://api.stripe.com/v1/charges', headers: [['authorization', `Bearer ${first.placeholder}`]] },
      [rotated],
    );
    expect(resolved.kind).toBe('forward');
    expect(resolved.kind === 'forward' && resolved.substitutions[0]!.secret).toBe('sk_live_rotated_value_here');
  });

  test('revoke reports whether anything went away', async () => {
    const deps = await vault();
    await putEgressSecret(deps, STRIPE);
    expect(revokeEgressSecret(deps.sql, 'stripe')).toBe(true);
    expect(revokeEgressSecret(deps.sql, 'stripe')).toBe(false);
    expect(listEgressSecrets(deps.sql)).toEqual([]);
  });

  test('a revoked secret is refused, not forwarded as a dummy', async () => {
    const deps = await vault();
    const binding = await putEgressSecret(deps, STRIPE);
    revokeEgressSecret(deps.sql, 'stripe');
    // The handler still holds its configured view — this is the window between
    // revocation and reconfiguration, and it must fail closed.
    const resolved = await resolveEgressInjection(
      deps,
      { host: 'api.stripe.com', url: 'https://api.stripe.com/', headers: [['authorization', `Bearer ${binding.placeholder}`]] },
      [binding],
    );
    expect(resolved.kind).toBe('refuse');
    expect(resolved.kind === 'refuse' && resolved.status).toBe(403);
  });

  test('a host with no scheme, port or space is required', async () => {
    const deps = await vault();
    await expect(putEgressSecret(deps, { ...STRIPE, host: 'https://api.stripe.com' })).rejects.toThrow(/Invalid egress host/);
    await expect(putEgressSecret(deps, { ...STRIPE, host: 'api.stripe.com:443' })).rejects.toThrow(/Invalid egress host/);
  });

  test('a placeholder cannot be stored AS a secret', async () => {
    const deps = await vault();
    const binding = await putEgressSecret(deps, STRIPE);
    await expect(putEgressSecret(deps, { ...STRIPE, id: 'x', secret: binding.placeholder }))
      .rejects.toThrow(/placeholder, not a secret/);
  });
});

describe('destination is re-checked on every request', () => {
  test('the same placeholder is substituted for its host and refused for another', async () => {
    const deps = await vault();
    const binding = await putEgressSecret(deps, STRIPE);
    const headers: readonly (readonly [string, string])[] = [['authorization', `Bearer ${binding.placeholder}`]];

    const allowed = await resolveEgressInjection(
      deps, { host: 'api.stripe.com', url: 'https://api.stripe.com/v1', headers }, [binding],
    );
    expect(allowed.kind).toBe('forward');
    expect(allowed.kind === 'forward' && allowed.substitutions[0]!.secret).toBe(SECRET);

    const denied = await resolveEgressInjection(
      deps, { host: 'attacker.test', url: 'https://attacker.test/collect', headers }, [binding],
    );
    expect(denied.kind).toBe('refuse');
    // The refusal must not leak the secret it declined to substitute.
    expect(JSON.stringify(denied)).not.toContain(SECRET);
  });

  test('traffic with no placeholder never opens anything', async () => {
    const deps = await vault();
    const binding = await putEgressSecret(deps, STRIPE);
    const resolved = await resolveEgressInjection(
      deps, { host: 'example.com', url: 'https://example.com/', headers: [] }, [binding],
    );
    expect(resolved).toEqual({ kind: 'forward', substitutions: [] });
  });
});

describe('key rotation', () => {
  test('the vault re-seals under a new key and the secret survives', async () => {
    const deps = await vault();
    await putEgressSecret(deps, STRIPE);
    const next = await createCredentialCipher({
      CREDENTIAL_ENCRYPTION_KEY: 'a-second-credential-encryption-key-9876543210',
      CREDENTIAL_ENCRYPTION_KEY_PREVIOUS: TEST_CREDENTIAL_ENCRYPTION_KEY,
    });
    const rotated: EgressVaultDeps = { sql: deps.sql, cipher: next, aad: deps.aad };
    expect(await rewrapEgressSecrets(rotated)).toBe(true);
    const stored = String(deps.sql.exec(`SELECT secret FROM user_egress_secrets`).toArray()[0]!.secret);
    expect(stored.startsWith(`pce1.${next.keyId}.`)).toBe(true);
    expect(await next.open(deps.aad('stripe'), stored)).toBe(SECRET);
  });

  test('a row that cannot be re-sealed withholds the clean signal', async () => {
    // The marker asserts the WHOLE store is current, and the documented
    // rotation drops the retired key on the strength of it.
    const deps = await vault();
    await putEgressSecret(deps, STRIPE);
    const stranger = await createCredentialCipher({
      CREDENTIAL_ENCRYPTION_KEY: 'an-unrelated-encryption-key-000000000000000',
    });
    expect(await rewrapEgressSecrets({ sql: deps.sql, cipher: stranger, aad: deps.aad })).toBe(false);
  });
});

describe('reachability', () => {
  // A UserDO method absent from USER_DO_METHODS is silently unreachable over a
  // stub. The outbound handler's SAFETY comment rests on this assertion.
  test('every vault method the egress path calls is on the RPC surface', () => {
    const called = ['resolveEgressInjection', 'listEgressSecrets', 'putEgressSecret', 'revokeEgressSecret'];
    expect(called.length).toBeGreaterThan(0);
    expect(called.filter((name) => !USER_DO_RPC_SURFACE.includes(name))).toEqual([]);
  });
});

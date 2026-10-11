// The egress secret vault against real bun:sqlite and the real AES-GCM envelope, so encryption and AAD binding are exercised.
import { describe, expect, test } from 'bun:test';
import * as v from 'valibot';
import { Database } from 'bun:sqlite';
import { EGRESS_PLACEHOLDER_PREFIX, isEgressPlaceholder } from '@kinu.run/core';
import { createCredentialCipher } from '@kinu.run/core';
import {
  initEgressVaultTables, listEgressSecrets, putEgressSecret,
  resolveEgressInjection, revokeEgressSecret,
  type EgressVaultDeps,
} from '@kinu.run/core';
import { USER_DO_RPC_SURFACE } from '../src/rpc-surface';
import {
  TEST_USER_ENV, createTestUserDO, sqlExec, testOwner,
} from './helpers/user-do';

const SECRET = ['sk_live_', '0123456789abcdefghij'].join('');

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
    // The placeholder is fresh randomness, not a transform of the secret.
    expect(binding.placeholder).not.toContain(SECRET);
    expect(binding.placeholder).not.toContain(SECRET.slice(0, 8));

    // A container cannot learn that two of its dummies stand for one value.
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
    const stored = v.parse(v.string(), deps.sql.exec(`SELECT secret FROM user_egress_secrets`).toArray()[0].secret);
    expect(stored.startsWith('pce1.')).toBe(true);
    expect(stored).not.toContain(SECRET);
  });

  test('a secret sealed for one binding cannot be opened as another', async () => {
    const deps = await vault();
    await putEgressSecret(deps, STRIPE);
    const stored = v.parse(v.string(), deps.sql.exec(`SELECT secret FROM user_egress_secrets`).toArray()[0].secret);
    await expect(deps.cipher.open(deps.aad('some-other-binding'), stored))
      .rejects.toThrow('Record "test-user-do:egress:some-other-binding" failed to decrypt');
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
    expect(resolved.kind === 'forward' && resolved.substitutions[0].secret).toBe('sk_live_rotated_value_here');
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

    // The window between revocation and reconfiguration must fail closed.
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
    await expect(putEgressSecret(deps, { ...STRIPE, host: 'https://api.stripe.com' }))
      .rejects.toThrow('Invalid egress host "https://api.stripe.com": a hostname or a * glob, with no scheme, port, path or space.');
    await expect(putEgressSecret(deps, { ...STRIPE, host: 'api.stripe.com:443' }))
      .rejects.toThrow('Invalid egress host "api.stripe.com:443": a hostname or a * glob, with no scheme, port, path or space.');
  });

  test('a placeholder cannot be stored AS a secret', async () => {
    const deps = await vault();
    const binding = await putEgressSecret(deps, STRIPE);
    await expect(putEgressSecret(deps, { ...STRIPE, id: 'x', secret: binding.placeholder }))
      .rejects.toThrow('That value is a placeholder, not a secret.');
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
    expect(allowed.kind === 'forward' && allowed.substitutions[0].secret).toBe(SECRET);

    const denied = await resolveEgressInjection(
      deps, { host: 'attacker.test', url: 'https://attacker.test/collect', headers }, [binding],
    );

    expect(denied.kind).toBe('refuse');
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

describe('the owner object reads its vault against the grants a request carries', () => {
  test('a granted secret is spent, and the same request without its grant is refused', async () => {
    const { userDO } = createTestUserDO();
    const owner = await testOwner();
    const binding = await userDO.putEgressSecret(owner, STRIPE);
    const facts = { host: 'api.stripe.com', url: 'https://api.stripe.com/v1/charges', headers: [['authorization', `Bearer ${binding.placeholder}`]] as const };

    expect(await userDO.resolveEgressInjection(owner, facts, [{ rule: 'egress-secret:stripe', executor: 'sandbox' }]))
      .toEqual({ kind: 'forward', substitutions: [{ placeholder: binding.placeholder, secret: SECRET }] });
    expect(await userDO.resolveEgressInjection(owner, facts, [{ rule: 'egress-secret:stripe', executor: 'device' }]))
      .toMatchObject({ kind: 'refuse' });
  });
});

describe('reachability', () => {
  // A UserDO method absent from USER_DO_METHODS is silently unreachable over a stub; the outbound handler's
  // SAFETY comment rests on this.
  test('every vault method the egress path calls is on the RPC surface', () => {
    const called = ['resolveEgressInjection', 'listEgressSecrets', 'putEgressSecret', 'revokeEgressSecret'];
    expect(called.length).toBeGreaterThan(0);
    expect(called.filter((name) => !USER_DO_RPC_SURFACE.includes(name))).toEqual([]);
  });
});

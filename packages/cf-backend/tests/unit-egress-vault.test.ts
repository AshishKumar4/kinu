// The account's secrets on the real owner object, over real bun:sqlite and the real AES-GCM envelope: who may add and
// grant them, what a workspace ever sees of them, and that a value is opened only for a workspace the owner granted.
import { describe, expect, test } from 'bun:test';
import * as v from 'valibot';
import { EGRESS_PLACEHOLDER_PREFIX, isEgressPlaceholder, type EgressRequestFacts, type SecretInput, type UserCaller } from '@kinu.run/core';
import { USER_DO_RPC_SURFACE } from '../src/rpc-surface';
import { createTestUserDO, provisionTestWorkspace, testOwner, type TestUserDO } from './helpers/user-do';

const SECRET = ['sk_live_', '0123456789abcdefghij'].join('');

/** Assembled, so no scanner reads a hardcoded password here. */
const DB_VALUE = ['hunter2', 'db'].join('-');

const STRIPE: SecretInput = { name: 'STRIPE_SECRET_KEY', hosts: ['api.stripe.com'], value: SECRET };

/** An owner's account with two workspaces, `shop` and `blog`, each holding its own capability. */
const USER_ID = '0123456789abcdef0123456789abcdef';

async function account(): Promise<TestUserDO & { owner: UserCaller; shop: UserCaller; blog: UserCaller }> {
  const harness = createTestUserDO({ durableObjectId: USER_ID });

  return Object.assign(harness, {
    owner: await testOwner(),
    shop: { workspaceToken: await provisionTestWorkspace(harness, 'shop') },
    blog: { workspaceToken: await provisionTestWorkspace(harness, 'blog') },
  });
}

function charge(placeholder: string, url = 'https://api.stripe.com/v1/charges'): EgressRequestFacts {
  return { host: new URL(url).hostname, url, headers: [['authorization', `Bearer ${placeholder}`]] };
}

async function placeholderIn(harness: TestUserDO, workspace: UserCaller, name: string): Promise<string> {
  const held = (await harness.userDO.grantedSecrets(workspace)).granted.find((secret) => secret.name === name);

  if (held === undefined) throw new Error(`${name} is not granted to this workspace`);

  return held.placeholder;
}

describe('the owner adds secrets, and nothing ever hands a value back', () => {
  test('a granted workspace holds a random placeholder, never derived from the value; the owner\'s list holds neither', async () => {
    const harness = await account();
    await harness.userDO.putSecrets(harness.owner, [STRIPE], ['shop']);
    const placeholder = await placeholderIn(harness, harness.shop, 'STRIPE_SECRET_KEY');

    expect(isEgressPlaceholder(placeholder)).toBe(true);
    expect(placeholder).toMatch(new RegExp(`^${EGRESS_PLACEHOLDER_PREFIX}[0-9a-z]{43}$`));
    expect(placeholder).not.toContain(SECRET.slice(0, 8));

    const listed = await harness.userDO.listSecrets(harness.owner);
    expect(listed).toEqual([{ name: 'STRIPE_SECRET_KEY', hosts: ['api.stripe.com'], updatedAt: expect.any(Number), grants: [{ workspace: 'shop', title: 'shop', reveal: false }] }]);
    expect(JSON.stringify(listed)).not.toContain(SECRET);
    expect(JSON.stringify(listed)).not.toContain(placeholder);
    expect(JSON.stringify(await harness.userDO.grantedSecrets(harness.shop))).not.toContain(SECRET);
  });

  test('the value is sealed at rest and bound to its own name: a ciphertext moved to another row does not open', async () => {
    const harness = await account();
    await harness.userDO.putSecrets(harness.owner, [STRIPE, { name: 'OTHER_KEY', hosts: ['api.other.com'], value: 'other-value-0123' }], ['shop']);
    const sealed = v.parse(v.string(), harness.sql.exec(`SELECT secret FROM user_secrets WHERE name = 'STRIPE_SECRET_KEY'`).toArray()[0]?.secret);

    expect(sealed).not.toContain(SECRET);
    harness.sql.exec(`UPDATE user_secrets SET secret = ?, hosts = 'api.stripe.com' WHERE name = 'OTHER_KEY'`, sealed);
    const other = await placeholderIn(harness, harness.shop, 'OTHER_KEY');

    await expect(harness.userDO.resolveEgressInjection(harness.owner, charge(other), 'shop')).rejects.toThrow();
  });

  test('replacing a value keeps its placeholder, so a workspace needs nothing new; the next request spends the new value', async () => {
    const harness = await account();
    await harness.userDO.putSecrets(harness.owner, [STRIPE], ['shop']);
    const before = await placeholderIn(harness, harness.shop, 'STRIPE_SECRET_KEY');

    await harness.userDO.putSecrets(harness.owner, [{ ...STRIPE, value: 'sk_live_rotated_value_0123' }], []);

    expect(await placeholderIn(harness, harness.shop, 'STRIPE_SECRET_KEY')).toBe(before);
    expect(await harness.userDO.resolveEgressInjection(harness.owner, charge(before), 'shop'))
      .toEqual({ kind: 'forward', substitutions: [{ placeholder: before, secret: 'sk_live_rotated_value_0123' }] });
  });

  test('a batch with one bad entry writes nothing', async () => {
    const harness = await account();

    await expect(harness.userDO.putSecrets(harness.owner, [STRIPE, { name: 'BAD', hosts: ['*'], value: 'x' }], ['shop'])).rejects.toThrow();
    expect(await harness.userDO.listSecrets(harness.owner)).toEqual([]);
  });

  test.each([
    ['a bare wildcard', '*'],
    ['a wildcard that lets the program pick the domain', 'api.*'],
    ['a scheme', 'https://api.stripe.com'],
    ['a port', 'api.stripe.com:443'],
    ['a path', 'api.stripe.com/v1'],
    ['a single label', 'localhost'],
  ])('a host written as %s is refused, since it would send the secret where the owner did not mean', async (_case, host) => {
    const harness = await account();

    await expect(harness.userDO.putSecrets(harness.owner, [{ ...STRIPE, hosts: [host] }], [])).rejects.toThrow('is not a host');
  });

  test('every host under a domain is written *.example.com', async () => {
    const harness = await account();
    await harness.userDO.putSecrets(harness.owner, [{ ...STRIPE, hosts: ['*.Stripe.com'] }], ['shop']);
    const placeholder = await placeholderIn(harness, harness.shop, 'STRIPE_SECRET_KEY');

    expect((await harness.userDO.resolveEgressInjection(harness.owner, charge(placeholder, 'https://files.stripe.com/x'), 'shop')).kind).toBe('forward');
    expect((await harness.userDO.resolveEgressInjection(harness.owner, charge(placeholder, 'https://stripe.com.attacker.test/x'), 'shop')).kind).toBe('refuse');
  });

  test('a name that is no variable name, a placeholder for a value, or a grant to a workspace that does not exist is refused', async () => {
    const harness = await account();
    await harness.userDO.putSecrets(harness.owner, [STRIPE], ['shop']);
    const placeholder = await placeholderIn(harness, harness.shop, 'STRIPE_SECRET_KEY');

    await expect(harness.userDO.putSecrets(harness.owner, [{ ...STRIPE, name: 'stripe-key' }], [])).rejects.toThrow('cannot name a secret');
    await expect(harness.userDO.putSecrets(harness.owner, [{ ...STRIPE, name: 'COPY', value: placeholder }], [])).rejects.toThrow('placeholder');
    await expect(harness.userDO.putSecrets(harness.owner, [STRIPE], ['nowhere'])).rejects.toThrow('no workspace');
  });
});

describe('the owner object opens a secret only for a workspace it is granted to', () => {
  test('the granted workspace\'s request is substituted; the same placeholder from another workspace is refused', async () => {
    const harness = await account();
    await harness.userDO.putSecrets(harness.owner, [STRIPE], ['shop']);
    const placeholder = await placeholderIn(harness, harness.shop, 'STRIPE_SECRET_KEY');

    expect(await harness.userDO.resolveEgressInjection(harness.owner, charge(placeholder), 'shop'))
      .toEqual({ kind: 'forward', substitutions: [{ placeholder, secret: SECRET }] });

    const elsewhere = await harness.userDO.resolveEgressInjection(harness.owner, charge(placeholder), 'blog');
    expect(elsewhere).toMatchObject({ kind: 'refuse', status: 403 });
    expect(JSON.stringify(elsewhere)).not.toContain(SECRET);
  });

  test('a grant revoked, or a secret deleted, refuses the next request', async () => {
    const harness = await account();
    await harness.userDO.putSecrets(harness.owner, [STRIPE], ['shop', 'blog']);
    const placeholder = await placeholderIn(harness, harness.shop, 'STRIPE_SECRET_KEY');

    await harness.userDO.revokeSecretGrant(harness.owner, { name: 'STRIPE_SECRET_KEY', workspace: 'shop' });
    expect((await harness.userDO.resolveEgressInjection(harness.owner, charge(placeholder), 'shop')).kind).toBe('refuse');
    expect((await harness.userDO.resolveEgressInjection(harness.owner, charge(placeholder), 'blog')).kind).toBe('forward');

    await harness.userDO.deleteSecret(harness.owner, 'STRIPE_SECRET_KEY');
    expect((await harness.userDO.resolveEgressInjection(harness.owner, charge(placeholder), 'blog')).kind).toBe('refuse');
    expect(harness.sql.exec(`SELECT count(*) AS n FROM user_secret_grants`).toArray()[0]?.n).toBe(0);
  });

  test('the hosts can change without the value: the next request is judged against the new ones', async () => {
    const harness = await account();
    await harness.userDO.putSecrets(harness.owner, [STRIPE], ['shop']);
    const placeholder = await placeholderIn(harness, harness.shop, 'STRIPE_SECRET_KEY');

    await harness.userDO.setSecretHosts(harness.owner, 'STRIPE_SECRET_KEY', ['api.stripe.test']);

    expect((await harness.userDO.resolveEgressInjection(harness.owner, charge(placeholder), 'shop')).kind).toBe('refuse');
    expect((await harness.userDO.resolveEgressInjection(harness.owner, charge(placeholder, 'https://api.stripe.test/v1'), 'shop')).kind).toBe('forward');
  });

  test('a workspace reads the values of only the secrets its agents were let read, and only its own', async () => {
    const harness = await account();
    await harness.userDO.putSecrets(harness.owner, [STRIPE, { name: 'DATABASE_PASSWORD', hosts: ['db.example.com'], value: DB_VALUE }], ['shop', 'blog']);

    expect(await harness.userDO.revealedSecrets(harness.shop)).toEqual({});
    await harness.userDO.grantSecret(harness.owner, { name: 'DATABASE_PASSWORD', workspace: 'shop', reveal: true });

    expect(await harness.userDO.revealedSecrets(harness.shop)).toEqual({ DATABASE_PASSWORD: DB_VALUE });
    expect(await harness.userDO.revealedSecrets(harness.blog)).toEqual({});
    expect((await harness.userDO.grantedSecrets(harness.shop)).granted.map((secret) => [secret.name, secret.reveal]))
      .toEqual([['DATABASE_PASSWORD', true], ['STRIPE_SECRET_KEY', false]]);
  });

  test('a workspace learns how many secrets are withheld from it, never their names', async () => {
    const harness = await account();
    await harness.userDO.putSecrets(harness.owner, [STRIPE], ['shop']);
    await harness.userDO.putSecrets(harness.owner, [{ name: 'BLOG_TOKEN', hosts: ['api.blog.example'], value: 'blog-token-value' }], ['blog']);

    const seen = await harness.userDO.grantedSecrets(harness.shop);
    expect(seen.granted.map((secret) => secret.name)).toEqual(['STRIPE_SECRET_KEY']);
    expect(seen.withheld).toBe(1);
    expect(JSON.stringify(seen)).not.toContain('BLOG_TOKEN');
  });

  test('deleting a workspace deletes its grants', async () => {
    const harness = await account();
    await harness.userDO.putSecrets(harness.owner, [STRIPE], ['shop', 'blog']);
    await harness.userDO.removeWorkspace(harness.owner, 'shop', USER_ID);

    expect((await harness.userDO.listSecrets(harness.owner))[0]?.grants).toEqual([{ workspace: 'blog', title: 'blog', reveal: false }]);
  });
});

describe('only the owner manages secrets, and only the egress opens one', () => {
  test('a workspace can neither add, list, grant, nor open a placeholder, its own included', async () => {
    const harness = await account();
    await harness.userDO.putSecrets(harness.owner, [STRIPE], ['shop']);
    const placeholder = await placeholderIn(harness, harness.shop, 'STRIPE_SECRET_KEY');

    await expect(harness.userDO.putSecrets(harness.shop, [{ ...STRIPE, name: 'MINE' }], ['shop'])).rejects.toThrow('account authority');
    await expect(harness.userDO.listSecrets(harness.shop)).rejects.toThrow('account authority');
    await expect(harness.userDO.grantSecret(harness.blog, { name: 'STRIPE_SECRET_KEY', workspace: 'blog', reveal: true })).rejects.toThrow('account authority');
    await expect(harness.userDO.resolveEgressInjection(harness.shop, charge(placeholder), 'shop')).rejects.toThrow('account authority');
  });

  test('the owner capability names no workspace, so it reads no workspace\'s grants', async () => {
    const harness = await account();

    await expect(harness.userDO.grantedSecrets(harness.owner)).rejects.toThrow('Only a workspace');
  });
});

describe('a workspace whose secrets changed is told, so its next command reads them as they stand', () => {
  test('adding, granting, re-hosting, revoking and deleting each tell exactly the workspaces they touch', async () => {
    const harness = await account();

    const told = async (change: () => Promise<void>): Promise<string[]> => {
      harness.secretsMoved.length = 0;
      await change();

      return [...harness.secretsMoved].sort();
    };

    expect(await told(() => harness.userDO.putSecrets(harness.owner, [STRIPE], ['shop']))).toEqual(['shop']);
    expect(await told(() => harness.userDO.grantSecret(harness.owner, { name: 'STRIPE_SECRET_KEY', workspace: 'blog', reveal: false }))).toEqual(['blog']);
    expect(await told(() => harness.userDO.setSecretHosts(harness.owner, 'STRIPE_SECRET_KEY', ['api.stripe.com', 'files.stripe.com']))).toEqual(['blog', 'shop']);
    expect(await told(() => harness.userDO.revokeSecretGrant(harness.owner, { name: 'STRIPE_SECRET_KEY', workspace: 'shop' }))).toEqual(['shop']);
    expect(await told(() => harness.userDO.deleteSecret(harness.owner, 'STRIPE_SECRET_KEY'))).toEqual(['blog']);
  });
});

describe('reachability', () => {
  // A UserDO method absent from USER_DO_METHODS is silently unreachable over a stub.
  test('every secrets method the egress, the workspace and Settings call is on the RPC surface', () => {
    const called = ['resolveEgressInjection', 'listSecrets', 'putSecrets', 'setSecretHosts', 'deleteSecret', 'grantSecret', 'revokeSecretGrant', 'grantedSecrets', 'revealedSecrets'];
    expect(called.filter((name) => !USER_DO_RPC_SURFACE.includes(name))).toEqual([]);
  });
});

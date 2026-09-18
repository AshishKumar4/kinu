/**
 * The release manifest is the deployed shape, or it is a lie a stranger's
 * account pays for.
 *
 * Every row here is red in both directions on purpose. The manifest's binding
 * set is held equal to the set `deriveInfrastructure()` reads out of the same
 * `wrangler.jsonc` — two readers, one config — so a binding block one of them
 * learns about and the other does not fails here rather than in somebody's
 * half-bound deployment. The var classification is pinned the same way: a new
 * var is unclassified until somebody says whether a stranger's Worker gets our
 * value, computes its own, or must never see it.
 */
import { describe, expect, test } from 'bun:test';
import * as v from 'valibot';
import { deriveInfrastructure, SUPPLY, type Supply } from './infra-manifest';
import {
  VAR_POLICY, buildReleaseManifest, readWranglerConfig, releaseBindings, releaseSecrets, releaseVars,
} from './release-manifest';
import { ReleaseManifestSchema } from '../packages/core/src/deploy/manifest';

const CONFIG = readWranglerConfig();

const PRODUCTION = deriveInfrastructure().environments[0];

const MANIFEST = buildReleaseManifest({
  version: '0.1.0+abcdef1',
  sha: 'abcdef1',
  builtAt: '2026-09-17T00:00:00.000Z',
  files: [{ path: 'worker/index.js', sha256: 'a'.repeat(64), size: 10, assetHash: null }],
  modules: ['index.js'],
  seed: null,
});

describe('the manifest is the config', () => {
  test('its bindings are exactly the ones the deployed environment declares', () => {
    const declared = [...(PRODUCTION?.bindings ?? [])].sort();
    const carried = MANIFEST.bindings.map((binding) => binding.binding).sort();

    expect(carried).toEqual(declared);
  });

  test('a binding block the manifest reader does not know about is a failure, not an omission', () => {
    // The red direction that matters: a future `queues` or `hyperdrive` block
    // reaches the environment's binding list through infra-manifest and must
    // not reach a deployment as silence.
    const withQueue = { ...CONFIG, kv_namespaces: [...(CONFIG.kv_namespaces ?? []), { binding: 'SESSION_KV' }] };
    const carried = releaseBindings(withQueue, new Set()).map((binding) => binding.binding);

    expect(carried).toContain('SESSION_KV');
    expect(releaseBindings(CONFIG, new Set()).map((binding) => binding.binding)).not.toContain('SESSION_KV');
  });

  test('a binding the Worker tolerates the absence of is not required', () => {
    const optional = releaseBindings(CONFIG, new Set(['BACKUP_BUCKET']));

    expect(optional.find((binding) => binding.binding === 'BACKUP_BUCKET')?.required).toBe(false);
    expect(optional.find((binding) => binding.binding === 'ASSETS')?.required).toBe(true);
  });

  test('every Durable Object class and migration travels with the release', () => {
    const classes = (CONFIG.durable_objects?.bindings ?? []).map((binding) => binding.class_name).sort();

    expect(MANIFEST.bindings.filter((binding) => binding.kind === 'durable-object')
      .map((binding) => binding.resource).sort()).toEqual(classes);
    expect(MANIFEST.migrations.flatMap((migration) => migration.newSqliteClasses).sort())
      .toEqual((CONFIG.migrations ?? []).flatMap((migration) => migration.new_sqlite_classes ?? []).sort());
  });

  test('the Vectorize geometry is the embedder\'s, not a number retyped here', () => {
    // A wrong width binds and then rejects every insert, which is why the
    // release carries it at all.
    expect(MANIFEST.vectorIndexes.every((index) => index.dimensions === 384 && index.metric === 'cosine')).toBe(true);
    expect(MANIFEST.vectorIndexes.map((index) => index.name))
      .toEqual((CONFIG.vectorize ?? []).map((index) => index.index_name));
  });

  test('it parses as a release manifest', () => {
    expect(v.is(ReleaseManifestSchema, MANIFEST)).toBe(true);
  });
});

describe('what a stranger\'s deployment is given', () => {
  test('every var is classified, and an unclassified one refuses to build', () => {
    expect(releaseVars(CONFIG).map((entry) => entry.name).sort())
      .toEqual(Object.keys(CONFIG.vars ?? {}).sort());

    expect(() => releaseVars({ ...CONFIG, vars: { ...CONFIG.vars, NEW_KNOB: 'x' } }))
      .toThrow(/NEW_KNOB/u);
  });

  test('VAR_POLICY holds no name the config no longer sets', () => {
    const configured = new Set(Object.keys(CONFIG.vars ?? {}));

    expect(Object.keys(VAR_POLICY).filter((name) => !configured.has(name))).toEqual([]);
  });

  test('kinu.run\'s own identity never travels', () => {
    const ours = MANIFEST.vars.filter((entry) => entry.policy === 'ours').map((entry) => entry.name);

    // The eval bypass address, the owner's mailbox and the control plane's
    // Access pins are the four that would hand a stranger our identity.
    expect(ours).toContain('DEV_USER_EMAIL');
    expect(ours).toContain('OPS_ALERT_EMAIL');
    expect(ours).toContain('CONTROL_PLANE_ACCESS_AUD');
    expect(ours).toContain('CONTROL_PLANE_ACCESS_TEAM_DOMAIN');
    expect(MANIFEST.vars.filter((entry) => entry.policy === 'ours').every((entry) => entry.value === undefined)).toBe(true);
  });

  test('a carried var carries its value and a derived one carries none', () => {
    const carried = MANIFEST.vars.filter((entry) => entry.policy === 'carried');
    const derived = MANIFEST.vars.filter((entry) => entry.policy === 'derived');

    expect(carried.every((entry) => entry.value !== undefined)).toBe(true);
    expect(derived.every((entry) => entry.value === undefined)).toBe(true);
    expect(derived.map((entry) => entry.name)).toContain('CLI_PUBLIC_ORIGIN');
  });

  test('the secrets census is SUPPLY\'s, with the prompt text a person is shown', () => {
    const secrets = releaseSecrets(MANIFEST.vars);
    const expected = [...SUPPLY].filter(([, entry]) => entry.handling !== 'config-var').map(([name]) => name).sort();

    expect(secrets.map((secret) => secret.name)).toEqual(expected);
    expect(secrets.find((secret) => secret.name === 'CREDENTIAL_ENCRYPTION_KEY')?.required).toBe(true);
    expect(secrets.find((secret) => secret.name === 'CREDENTIAL_ENCRYPTION_KEY')?.prompt)
      .toMatch(/32 random bytes/u);
  });

  test('a secret whose var this release does not send is offered, never demanded', () => {
    // kinu.run's Cloudflare OAuth client id is ours and never travels, so a
    // person deploying their own Kinu must not be blocked on its secret.
    const secret = releaseSecrets(MANIFEST.vars).find((row) => row.name === 'CLOUDFLARE_OAUTH_CLIENT_SECRET');

    expect(secret).toMatchObject({ handling: 'optional', required: false });
    expect(SUPPLY.get('CLOUDFLARE_OAUTH_CLIENT_SECRET')?.required).toBe(true);

    const sent = releaseSecrets([{ name: 'CLOUDFLARE_OAUTH_CLIENT_ID', policy: 'derived' }]);

    expect(sent.find((row) => row.name === 'CLOUDFLARE_OAUTH_CLIENT_SECRET'))
      .toMatchObject({ handling: 'prompted', required: true });
  });

  test('an out-of-band secret is never presented as a prompt', () => {
    const supply = new Map<string, Supply>([
      ['SOME_KEY', { handling: 'out-of-band', required: false, absent: 'nothing', source: 'another website' }],
    ]);

    expect(releaseSecrets([], supply)).toEqual([
      { name: 'SOME_KEY', handling: 'out-of-band', required: false, prompt: 'another website' },
    ]);
  });
});

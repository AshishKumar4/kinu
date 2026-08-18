/**
 * The infrastructure gate's own decision boundary.
 *
 * A gate is only worth what its red directions are worth, and two of the three
 * programs here are unrunnable in CI by construction (they need a Cloudflare
 * session) — so the parts that CAN be proved have to be proved hard: the
 * derivation, the three-state verdict, the idempotence rule, and teardown's
 * refusal. Everything below drives a pure function against a fixture, so none of
 * it touches an account.
 *
 * What it does NOT prove: that a `wrangler d1 create` actually creates a
 * database. That needs an account and is what `bun run gate:infra` is for.
 */

import { describe, expect, test } from 'bun:test';
import {
  SUPPLY, UNCAPTURED, UNOBSERVABLE, deriveInfrastructure, envFields, exclusiveTo, readSites,
  requiredIn, supplyCensus, vectorizeGeometry,
} from './infra-manifest';
import { type Row, audit, supplyDrift, unobservableDrift } from './infra-verify';
import { confirmationPhrase, partition } from './infra-teardown';
import { plan } from './infra-provision';
import { isProductSource, readMatching } from './sources';

const infrastructure = deriveInfrastructure();

function row(id: string, verdict: Row['verdict'], required: boolean): Row {
  return { id, verdict, detail: 'fixture', required, purpose: 'fixture' };
}

describe('the inventory is derived from the manifest, not written beside it', () => {
  test('every resource the live account holds appears, keyed and non-empty', () => {
    // A derivation that produced nothing would make every assertion below
    // vacuous — the exact shape this repository's ladder exists to refuse.
    expect(infrastructure.resources.length).toBeGreaterThan(20);
    expect(infrastructure.environments.map((environment) => environment.key)).toEqual([
      'production', 'staging',
    ]);
    expect(infrastructure.accountId).not.toBe('');

    const ids = infrastructure.resources.map((resource) => resource.id);
    // Named, not counted: a count cannot say WHICH resource the manifest lost.
    // These are the ones whose absence breaks a specific, named thing.
    expect(ids).toContain('d1.proteus-auth');
    expect(ids).toContain('d1.proteus-auth-staging');
    expect(ids).toContain('r2.proteus-backups');
    expect(ids).toContain('r2.nimbus-runtime-cache');
    expect(ids).toContain('vectorize.proteus-memory');
    expect(ids).toContain('ai-gateway.proteus-ai-gateway');
    expect(ids).toContain('wildcard-dns.*.proteus.ashishkumarsingh.com');
    expect(ids).toContain('custom-domain.proteus.ashishkumarsingh.com');
    expect(ids).toContain('durable-object.proteus:ProteusSandbox');
    expect(new Set(ids).size).toBe(ids.length);
  });

  test('a resource two environments bind is one resource with two holders', () => {
    // The property teardown safety rests on. Both environments declare
    // `nimbus-runtime-cache`, and a per-environment inventory would have made
    // tearing down production delete staging's runtime store.
    const shared = infrastructure.resources.find((resource) => resource.id === 'r2.nimbus-runtime-cache');
    expect(shared?.environments).toEqual(['production', 'staging']);
    expect(shared?.boundBy.map((ref) => ref.environment)).toEqual(['production', 'staging']);

    const exclusive = exclusiveTo(infrastructure, 'production').map((resource) => resource.id);
    expect(exclusive).toContain('d1.proteus-auth');
    expect(exclusive).not.toContain('r2.nimbus-runtime-cache');
    expect(exclusive).not.toContain('r2.proteus-backups');
  });

  test('requiredness comes from `Env`, not from an opinion here', () => {
    const required = (id: string): boolean | undefined =>
      infrastructure.resources.find((resource) => resource.id === id)?.required;
    // AUTH_DB is not optional in Env; BACKUP_BUCKET and MEMORY_VECTORS are.
    expect(required('d1.proteus-auth')).toBe(true);
    expect(required('r2.proteus-backups')).toBe(false);
    expect(required('vectorize.proteus-memory')).toBe(false);
    // And the derivation actually consulted Env rather than defaulting: the
    // optional set is non-empty and is a strict subset.
    const optional = infrastructure.resources.filter((resource) => !resource.required);
    expect(optional.length).toBeGreaterThan(0);
    expect(optional.length).toBeLessThan(infrastructure.resources.length);
  });

  test('the Vectorize geometry is read out of the embedder, and disagreement throws', () => {
    expect(vectorizeGeometry().dimensions).toBe(384);
    expect(() => vectorizeGeometry('createWorkersAIEmbedder({ dimensions: 384 })\n'
      + 'createWorkersAIEmbedder({ dimensions: 768 })')).toThrow(/two dimensions/u);
    expect(() => vectorizeGeometry('no embedder here')).toThrow(/exactly one embedder width/u);
  });

  test('`Env` parses, and a member it cannot read is a throw rather than a skip', () => {
    const fields = envFields();
    expect(fields.length).toBeGreaterThan(30);
    expect(fields.find((field) => field.name === 'AUTH_DB')?.optional).toBe(false);
    expect(fields.find((field) => field.name === 'BACKUP_BUCKET')?.optional).toBe(true);
    // A census that silently dropped the line it could not read would report the
    // healthiest possible number about a population nobody looked at.
    expect(() => envFields('declare global {\n interface Env {\n  BROKEN\n }\n}')).toThrow(/cannot read Env member/u);
    expect(() => envFields('nothing here')).toThrow(/no denominator/u);
  });
});

describe('the secret census is pinned to `Env`', () => {
  test('SUPPLY classifies exactly the values no binding and no var supplies', () => {
    expect(supplyDrift(infrastructure)).toEqual([]);
    expect(supplyCensus(infrastructure).length).toBeGreaterThan(5);
  });

  test('an unclassified new field and a stale entry are both findings', () => {
    const withExtra = {
      ...infrastructure,
      environments: infrastructure.environments.map((environment) => ({
        ...environment,
        // Drop a var that SUPPLY does not classify, so the census gains a name.
        vars: new Map([...environment.vars].filter(([key]) => key !== 'EMAIL_DOMAIN')),
      })),
    };
    const drift = supplyDrift(withExtra);
    expect(drift.some((entry) => entry.startsWith('EMAIL_DOMAIN'))).toBe(true);
  });

  test('OAuth secrets are required exactly where their client id var is set', () => {
    const production = infrastructure.environments[0];
    const staging = infrastructure.environments[1];
    if (production === undefined || staging === undefined) throw new Error('fixture lost an environment');
    // Production configures the Cloudflare provider; staging configures none and
    // runs on DEV_USER_EMAIL. Demanding production's OAuth secrets of staging
    // would report a hole in a deployment shaped that way on purpose.
    expect(requiredIn('CLOUDFLARE_OAUTH_CLIENT_SECRET', production)).toBe(true);
    expect(requiredIn('CLOUDFLARE_OAUTH_CLIENT_SECRET', staging)).toBe(false);
    expect(requiredIn('GOOGLE_OAUTH_CLIENT_SECRET', production)).toBe(false);
    // The root secret is unconditional: it seals the credential store whatever
    // identity the environment synthesises.
    expect(requiredIn('CREDENTIAL_ENCRYPTION_KEY', production)).toBe(true);
    expect(requiredIn('CREDENTIAL_ENCRYPTION_KEY', staging)).toBe(true);
  });

  test('every classified value is read by some product source', () => {
    const sources = readMatching(isProductSource);
    expect(sources.size).toBeGreaterThan(100);
    const unread = [...SUPPLY.keys()].filter((name) => readSites(name, sources).length === 0);
    expect(unread).toEqual([]);
  });
});

describe('the verdict keeps absent, unknown and unobservable apart', () => {
  // Every declared blind spot appears, because UNOBSERVABLE is pinned by
  // equality in both directions: a fixture that omitted one would be red for
  // the stale-declaration reason and every count below would be off by one.
  const clean: readonly Row[] = [
    row('d1.proteus-auth', 'present', true),
    ...[...UNOBSERVABLE.keys()].map((id) => row(id, 'unobservable', true)),
  ];

  test('a clean inventory produces no findings', () => {
    expect(audit(infrastructure, clean, [], []).findings).toEqual([]);
  });

  test('a required absent resource fails and an optional one does not', () => {
    const missing = audit(infrastructure, [...clean, row('r2.x', 'absent', true)], [], []);
    expect(missing.findings.length).toBe(1);
    expect(missing.findings[0]).toContain('r2.x');

    const optional = audit(infrastructure, [...clean, row('r2.x', 'absent', false)], [], []);
    expect(optional.findings).toEqual([]);
  });

  test('a failed lookup fails even though nothing was observed missing', () => {
    // The whole reason for the third state. `unknown` on an OPTIONAL resource
    // still fails: "we could not look" is not softened by the resource being
    // one the Worker tolerates losing.
    const unreadable = audit(infrastructure, [...clean, row('r2.x', 'unknown', false)], [], []);
    expect(unreadable.findings.length).toBe(1);
    expect(unreadable.findings[0]).toContain('lookup failed');
  });

  test('an undeclared blind spot fails, and a stale declaration fails too', () => {
    const undeclared = audit(infrastructure, [...clean, row('cron.whatever', 'unobservable', true)], [], []);
    expect(undeclared.findings.length).toBe(1);
    expect(undeclared.findings[0]).toContain('nothing declares that');

    // UNOBSERVABLE names rows that did not come back unobservable.
    const stale = audit(infrastructure, [row('d1.proteus-auth', 'present', true)], [], []);
    expect(stale.findings.length).toBe(UNOBSERVABLE.size);
    expect(stale.findings.join('\n')).toContain('ai-gateway.proteus-ai-gateway');
  });

  test('the declared blind spots are exactly the ones observation reports', () => {
    expect(unobservableDrift(clean)).toEqual([]);
    expect(UNOBSERVABLE.size).toBeGreaterThan(0);
  });

  test('a missing required secret fails and a missing optional one is reported only', () => {
    const secret = (required: boolean) => [{
      environment: 'production', name: 'CREDENTIAL_ENCRYPTION_KEY',
      verdict: 'absent' as const, required, detail: 'absent',
    }];
    expect(audit(infrastructure, clean, secret(true), []).findings.length).toBe(1);
    expect(audit(infrastructure, clean, secret(false), []).findings).toEqual([]);
  });

  test('an unreadable secret list fails rather than reading as "no secrets set"', () => {
    const unreadable = audit(infrastructure, clean, [{
      environment: 'production', name: '(all)', verdict: 'unknown', required: true,
      detail: 'token expired',
    }], []);
    expect(unreadable.findings.length).toBe(1);
    expect(unreadable.findings[0]).toContain('token expired');
  });
});

describe('provisioning is idempotent, and refuses what it cannot see', () => {
  const bucket = infrastructure.resources.find((resource) => resource.id === 'r2.proteus-backups');
  if (bucket === undefined) throw new Error('fixture lost r2.proteus-backups');

  test('a resource that exists is a no-op that says so', () => {
    const second = plan(bucket, { state: 'present', detail: 'proteus-backups' }, undefined);
    expect(second.action).toBe('skip');
    // The whole of idempotence: a second run issues no argv at all, so it cannot
    // create a duplicate and cannot fail on "already exists".
    expect('argv' in second).toBe(false);
  });

  test('a resource that does not exist is created, once, with the manifest argv', () => {
    const first = plan(bucket, { state: 'absent' }, undefined);
    expect(first).toEqual({ action: 'create', argv: ['r2', 'bucket', 'create', 'proteus-backups'] });
    expect(plan(bucket, { state: 'absent' }, 'staging')).toEqual({
      action: 'create',
      argv: ['r2', 'bucket', 'create', 'proteus-backups', '--env', 'staging'],
    });
  });

  test('a lookup that FAILED creates nothing — the defect the third state exists for', () => {
    const refused = plan(bucket, { state: 'unknown', reason: 'token expired' }, undefined);
    expect(refused.action).toBe('refuse');
    expect('argv' in refused).toBe(false);
    expect(refused.action === 'refuse' && refused.detail).toContain('token expired');
  });

  test('a resource no wrangler command creates is refused, not skipped silently', () => {
    // A silently-skipped resource is how the assetless deploy shipped.
    const gateway = infrastructure.resources.find((resource) => resource.id === 'ai-gateway.proteus-ai-gateway');
    if (gateway === undefined) throw new Error('fixture lost the AI Gateway');
    const refused = plan(gateway, { state: 'absent' }, undefined);
    expect(refused.action).toBe('refuse');
    expect(refused.action === 'refuse' && refused.detail).toContain('no wrangler command creates it');
  });
});

describe('teardown refuses by default and never takes a shared resource', () => {
  test('the confirmation names the worker and the environment', () => {
    // A `-y` can be produced by a shell that answers yes to everything, and a
    // generic "yes, delete" can be pasted from a runbook for another deployment.
    expect(confirmationPhrase('proteus', 'production')).toBe('destroy proteus production');
    expect(confirmationPhrase('proteus-staging', 'staging')).toBe('destroy proteus-staging staging');
    expect(confirmationPhrase('proteus', 'production'))
      .not.toBe(confirmationPhrase('proteus-staging', 'staging'));
  });

  test('the order is worker first, database last, and only deletable resources', () => {
    const kinds = partition(exclusiveTo(infrastructure, 'production')).deleted
      .map((resource) => resource.kind);
    expect(kinds[0]).toBe('worker');
    expect(kinds.at(-1)).toBe('d1');
    // A Durable Object namespace has no delete command; it goes away with its
    // Worker. Anything with no `destroy` must not appear here at all, or the run
    // reports a deletion it never attempted.
    expect(kinds).not.toContain('durable-object');
  });

  test('every resource lands in exactly one fate, and the storage is in the loud one', () => {
    // Totality is the property the confirmation prompt rests on: a resource in
    // no group is a loss nobody was warned about. The first draft put five
    // Durable Object namespaces — every UserDO profile, every agent's state —
    // under a heading that said they OUTLIVE the teardown, which is the exact
    // opposite of what `wrangler delete` does to them.
    const mine = exclusiveTo(infrastructure, 'production');
    const fate = partition(mine);
    const covered = [...fate.deleted, ...fate.swept, ...fate.outlives].map((resource) => resource.id);
    expect(covered.length).toBe(mine.length);
    expect(new Set(covered).size).toBe(mine.length);

    const sweptIds = fate.swept.map((resource) => resource.id);
    expect(sweptIds).toContain('durable-object.proteus:UserDO');
    for (const resource of fate.swept) {
      if (resource.kind !== 'durable-object') continue;
      expect(resource.holds).toContain('SQLite storage');
    }
    // And nothing that carries data is filed under "survives".
    expect(fate.outlives.every((resource) => resource.holds === undefined)).toBe(true);
  });

  test('a shared resource is in no environment fate at all', () => {
    for (const key of ['production', 'staging']) {
      const fate = partition(exclusiveTo(infrastructure, key));
      const ids = [...fate.deleted, ...fate.swept, ...fate.outlives].map((resource) => resource.id);
      expect(ids).not.toContain('r2.nimbus-runtime-cache');
      expect(ids).not.toContain('r2.proteus-backups');
    }
  });

  test('every data-bearing resource states what is inside it', () => {
    // The prompt names contents, not names. A resource that can lose data and
    // cannot say what would be lost makes the confirmation decorative.
    const bearing = infrastructure.resources.filter((resource) => resource.holds !== undefined);
    expect(bearing.length).toBeGreaterThan(4);
    for (const resource of bearing) expect((resource.holds ?? '').length).toBeGreaterThan(40);
    for (const kind of ['d1', 'r2', 'vectorize', 'durable-object']) {
      expect(bearing.some((resource) => resource.kind === kind)).toBe(true);
    }
  });
});

describe('what the manifest cannot express is recorded rather than assumed', () => {
  test('every uncaptured dependency carries evidence and a re-check', () => {
    expect(UNCAPTURED.length).toBeGreaterThan(5);
    for (const item of UNCAPTURED) {
      expect(item.what.length).toBeGreaterThan(40);
      expect(item.evidence.length).toBeGreaterThan(40);
      expect(item.check.length).toBeGreaterThan(5);
    }
  });

  test('every manual resource says what a human must do', () => {
    const manual = infrastructure.resources.filter((resource) => resource.origin === 'manual');
    expect(manual.length).toBeGreaterThan(0);
    for (const resource of manual) expect((resource.manual ?? '').length).toBeGreaterThan(30);
  });

  test('every wrangler-creatable resource carries the argv that creates it', () => {
    const creatable = infrastructure.resources.filter((resource) => resource.origin === 'wrangler-cli');
    expect(creatable.length).toBeGreaterThan(3);
    for (const resource of creatable) {
      expect((resource.create ?? []).length).toBeGreaterThan(1);
      // No shell, so no quoting: a name reaches wrangler as one argv element.
      for (const word of resource.create ?? []) expect(word).not.toContain(' ');
    }
  });
});

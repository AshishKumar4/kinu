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
 * What it does NOT prove: that a `wrangler r2 bucket create` actually creates a
 * bucket. That needs an account and is what `bun run gate:infra` is for.
 */

import { describe, expect, test } from 'bun:test';
import {
  type InfraEnvironment, type Infrastructure, type Resource, SUPPLY, UNCAPTURED, UNOBSERVABLE,
  deriveInfrastructure, envFields, exclusiveTo, readSites, requiredIn, supplyCensus,
  vectorizeGeometry,
} from './infra-manifest';
import {
  type Row, audit, supplyDrift, supplyRows, supplySummary, unobservableDrift,
} from './infra-verify';
import { confirmationPhrase, partition } from './infra-teardown';
import { plan } from './infra-provision';
import { isProductSource, readMatching } from './sources';

const infrastructure = deriveInfrastructure();

/** The auth store for one environment. Named by NAMESPACE ID, the way the
 *  manifest names it: `kv_namespaces` carries no title (see UNCAPTURED) and both
 *  environments bind the same AUTH_KV, so the id is the only thing that keeps
 *  production's sessions and staging's apart. */
function authStore(environment: string): Resource {
  const found = infrastructure.resources.find((resource) =>
    resource.kind === 'kv' && resource.environments.includes(environment));
  if (found === undefined) throw new Error(`fixture lost ${environment}'s auth store`);
  return found;
}

function row(id: string, verdict: Row['verdict'], required: boolean, origin: Row['origin'] = 'manual'): Row {
  return { id, verdict, detail: 'fixture', required, purpose: 'fixture', origin };
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
    expect(ids).toContain('r2.kinu-backups');
    expect(ids).toContain('r2.kinu-backups-staging');
    expect(ids).toContain('r2.nimbus-runtime-cache');
    expect(ids).toContain('vectorize.kinu-memory');
    expect(ids).toContain('vectorize.kinu-memory-staging');
    expect(ids).toContain('ai-gateway.kinu-ai-gateway');
    expect(ids).toContain('custom-domain.kinu.run');
    expect(ids).toContain('wildcard-dns.*.kinu.run');
    // Staging takes its hostname as a route, which matches a request and does
    // not make the name resolve — so the record is its own row.
    expect(ids).toContain('dns-record.staging.kinu.run');
    expect(ids).toContain('email-routing.kinu.run');
    expect(ids).toContain('durable-object.kinu:KinuSandbox');
    // One auth store per environment, each keyed by its own namespace id.
    expect(authStore('production').environments).toEqual(['production']);
    expect(authStore('staging').environments).toEqual(['staging']);
    expect(authStore('production').id).not.toBe(authStore('staging').id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  test('a resource two environments bind is one resource with two holders', () => {
    // The property teardown safety rests on. `nimbus-runtime-cache` is the one
    // resource both environments declare — its blobs are content-addressed and
    // immutable, so reading the same ones is the point — and a per-environment
    // inventory would have made tearing down production delete staging's
    // runtime store.
    const shared = infrastructure.resources.find((resource) => resource.id === 'r2.nimbus-runtime-cache');
    expect(shared?.environments).toEqual(['production', 'staging']);
    expect(shared?.boundBy.map((ref) => ref.environment)).toEqual(['production', 'staging']);

    // Everything else is one environment's own, snapshots and memory included:
    // staging writing eval snapshots into production's bucket is the shape this
    // separation exists to refuse.
    const exclusive = exclusiveTo(infrastructure, 'production').map((resource) => resource.id);
    expect(exclusive).toContain(authStore('production').id);
    expect(exclusive).toContain('r2.kinu-backups');
    expect(exclusive).toContain('vectorize.kinu-memory');
    expect(exclusive).not.toContain('r2.nimbus-runtime-cache');
    expect(exclusive).not.toContain('r2.kinu-backups-staging');
    const staging = exclusiveTo(infrastructure, 'staging').map((resource) => resource.id);
    expect(staging).toContain('r2.kinu-backups-staging');
    expect(staging).toContain('vectorize.kinu-memory-staging');
    expect(staging).not.toContain('r2.nimbus-runtime-cache');
  });

  test('requiredness comes from `Env`, not from an opinion here', () => {
    const required = (id: string): boolean | undefined =>
      infrastructure.resources.find((resource) => resource.id === id)?.required;
    // AUTH_KV is not optional in Env; BACKUP_BUCKET and MEMORY_VECTORS are.
    expect(authStore('production').required).toBe(true);
    expect(required('r2.kinu-backups')).toBe(false);
    expect(required('vectorize.kinu-memory')).toBe(false);
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
    expect(fields.find((field) => field.name === 'AUTH_KV')?.optional).toBe(false);
    expect(fields.find((field) => field.name === 'BACKUP_BUCKET')?.optional).toBe(true);
    // A census that silently dropped the line it could not read would report the
    // healthiest possible number about a population nobody looked at.
    expect(() => envFields('declare global {\n interface Env {\n  BROKEN\n }\n}')).toThrow(/cannot read Env member/u);
    expect(() => envFields('nothing here')).toThrow(/no denominator/u);
  });
});

describe('the supply census is pinned to `Env`, one environment at a time', () => {
  function environmentNamed(key: string): InfraEnvironment {
    const found = infrastructure.environments.find((entry) => entry.key === key);
    if (found === undefined) throw new Error(`fixture lost the ${key} environment`);
    return found;
  }

  const production = environmentNamed('production');
  const staging = environmentNamed('staging');
  const names = (fields: readonly { readonly name: string }[]): readonly string[] =>
    fields.map((field) => field.name);

  /** The same manifest with one environment's `vars` edited — the whole fixture
   *  the union defect needs, because a per-environment census is exactly what a
   *  one-environment omission is invisible to otherwise. */
  function withVars(
    edit: (environment: InfraEnvironment) => ReadonlyMap<string, string>,
    only?: string,
  ): Infrastructure {
    return {
      ...infrastructure,
      environments: infrastructure.environments.map((environment) =>
        only === undefined || environment.key === only
          ? { ...environment, vars: new Map(edit(environment)) }
          : environment),
    };
  }

  test('SUPPLY classifies exactly the values no binding and no var supplies', () => {
    expect(supplyDrift(infrastructure)).toEqual([]);
    expect(supplyCensus(production).length).toBeGreaterThan(5);
    expect(supplyCensus(staging).length).toBeGreaterThan(5);
  });

  test('one environment does not answer for another', () => {
    // The union defect, named in both directions so it is not one lucky
    // asymmetry. EMAIL_DOMAIN is production's var and staging has none;
    // DEV_USER_EMAIL is staging's and production must not have one.
    expect(production.vars.has('EMAIL_DOMAIN')).toBe(true);
    expect(staging.vars.has('EMAIL_DOMAIN')).toBe(false);
    expect(names(supplyCensus(production))).not.toContain('EMAIL_DOMAIN');
    expect(names(supplyCensus(staging))).toContain('EMAIL_DOMAIN');

    expect(staging.vars.has('DEV_USER_EMAIL')).toBe(true);
    expect(production.vars.has('DEV_USER_EMAIL')).toBe(false);
    expect(names(supplyCensus(production))).toContain('DEV_USER_EMAIL');
    expect(names(supplyCensus(staging))).not.toContain('DEV_USER_EMAIL');
  });

  test('a var dropped from ONE environment is a finding naming that environment', () => {
    // The regression fixture for the union. CLI_PUBLIC_ORIGIN is declared by
    // both environments, so a census that unions them first reports nothing
    // when one of them loses it — which is how a deployment tier ships without
    // a value every other tier has.
    const dropped = (only?: string): Infrastructure => withVars(
      (environment) => new Map([...environment.vars].filter(([key]) => key !== 'CLI_PUBLIC_ORIGIN')),
      only,
    );

    const one = supplyDrift(dropped('staging'));
    expect(one).toHaveLength(1);
    expect(one[0]).toContain('CLI_PUBLIC_ORIGIN');
    expect(one[0]).toContain('staging');
    expect(one[0]).not.toContain('production');

    // Both environments losing it names both, in one finding rather than two:
    // it is one unclassified name.
    const both = supplyDrift(dropped());
    expect(both).toHaveLength(1);
    expect(both[0]).toContain('production and staging');
  });

  test('a classified value that every environment supplies is a stale entry', () => {
    const everywhere = withVars((environment) =>
      new Map([...environment.vars, ['ANALYTICS_SQL_API_TOKEN', 'set-as-a-var']]));
    const drift = supplyDrift(everywhere);
    expect(drift).toHaveLength(1);
    expect(drift[0]).toStartWith('ANALYTICS_SQL_API_TOKEN');
    expect(drift[0]).toContain('every environment');
  });

  test('ordinary config vars are checked, per environment, against that environment', () => {
    // They used to be skipped outright: the loop `continue`d on every
    // `config-var` entry while its own comment said they were checked against
    // `vars`. Nothing checked them at all, in any environment.
    const listed = { state: 'present', detail: 'fixture', names: [] } as const;
    const verdictOf = (environment: InfraEnvironment, name: string): string | undefined =>
      supplyRows(environment, listed).find((entry) => entry.name === name)?.verdict;

    expect(verdictOf(production, 'EMAIL_DOMAIN')).toBe('present');
    expect(verdictOf(staging, 'EMAIL_DOMAIN')).toBe('absent');
    expect(verdictOf(staging, 'DEV_USER_EMAIL')).toBe('present');
    expect(verdictOf(production, 'DEV_USER_EMAIL')).toBe('absent');
    // A secret is never satisfied by a var: a plaintext secret in the config is
    // a misconfiguration, not a pass.
    expect(verdictOf(production, 'CREDENTIAL_ENCRYPTION_KEY')).toBe('absent');
  });

  test('a required value missing from one environment fails that environment by name', () => {
    const held = (names: readonly string[]) => ({ state: 'present', detail: 'fixture', names } as const);
    for (const environment of [production, staging]) {
      const missing = audit(infrastructure, [], supplyRows(environment, held([])), []);
      expect(missing.findings.some((entry) =>
        entry.includes(`${environment.key}/CREDENTIAL_ENCRYPTION_KEY`))).toBe(true);

      // The negative control for the same environment: set it, and the finding
      // is gone rather than merely reworded.
      const set = audit(infrastructure, [], supplyRows(environment, held(['CREDENTIAL_ENCRYPTION_KEY'])), []);
      expect(set.findings.some((entry) =>
        entry.includes(`${environment.key}/CREDENTIAL_ENCRYPTION_KEY`))).toBe(false);
    }
  });

  test('the green path prints the set it measured, per environment', () => {
    // A gate that says "ok" without naming what it looked at is a gate nobody
    // can tell from a gate that looked at nothing.
    const fields = envFields();
    for (const environment of [production, staging]) {
      const summary = supplySummary(environment, fields);
      expect(summary).toStartWith(`${environment.key} supplies `);
      expect(summary).toContain(`of ${String(fields.length)} \`Env\` fields`);
      for (const field of supplyCensus(environment, fields)) {
        expect(summary).toContain(field.name);
      }
    }
    // And the two environments' governed sets genuinely differ, which is the
    // property a union destroyed.
    expect(supplySummary(staging, fields)).toContain('EMAIL_DOMAIN');
    expect(supplySummary(production, fields)).not.toContain('EMAIL_DOMAIN');
  });

  test('OAuth secrets are required exactly where their client id var is set', () => {
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
    row(authStore('production').id, 'present', true),
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

  test('a deploy-created absence is tolerated only before the Worker exists', () => {
    const missing = row('durable-object.x:New', 'absent', true, 'wrangler-deploy');
    const preDeploy = audit(infrastructure, [
      ...clean,
      row('worker.kinu', 'absent', true, 'wrangler-deploy'),
      missing,
    ], [], []);
    expect(preDeploy.findings).toEqual([]);
    expect(preDeploy.notes.map((note) => note.includes('created by the deploy itself')))
      .toEqual([true, true]);

    const deployed = audit(infrastructure, [
      ...clean,
      row('worker.kinu', 'present', true, 'wrangler-deploy'),
      missing,
    ], [], []);
    expect(deployed.notes).toEqual([]);
    expect(deployed.findings).toHaveLength(1);
    expect(deployed.findings[0]).toContain('durable-object.x:New');
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

    // UNOBSERVABLE names rows that did not come back unobservable. Scoped to
    // the rows THIS run declared: an entry owned by another environment's
    // resource must NOT fail a run that never declares that row (staging runs
    // failed on production's cron entry), while an entry whose row IS declared
    // and observable is stale and fails.
    const gatewayId = [...UNOBSERVABLE.keys()].find((id) => id.startsWith('ai-gateway.'));
    if (gatewayId === undefined) throw new Error('fixture expects the ai-gateway blind entry');
    const stale = audit(infrastructure, [row(gatewayId, 'present', true)], [], []);
    expect(stale.findings.length).toBe(1);
    expect(stale.findings.join('\n')).toContain('ai-gateway.kinu-ai-gateway');

    // Out of scope, out of verdict: the same entry with its row undeclared.
    const scoped = audit(infrastructure, [row(authStore('production').id, 'present', true)], [], []);
    expect(scoped.findings).toEqual([]);
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
      environment: 'production', name: '(all secrets)', verdict: 'unknown', required: true,
      detail: 'token expired',
    }], []);
    expect(unreadable.findings.length).toBe(1);
    expect(unreadable.findings[0]).toContain('token expired');
  });
});

describe('provisioning is idempotent, and refuses what it cannot see', () => {
  const bucket = infrastructure.resources.find((resource) => resource.id === 'r2.kinu-backups');
  if (bucket === undefined) throw new Error('fixture lost r2.kinu-backups');

  test('a resource that exists is a no-op that says so', () => {
    const second = plan(bucket, { state: 'present', detail: 'kinu-backups' }, undefined);
    expect(second.action).toBe('skip');
    // The whole of idempotence: a second run issues no argv at all, so it cannot
    // create a duplicate and cannot fail on "already exists".
    expect('argv' in second).toBe(false);
  });

  test('a resource that does not exist is created, once, with the manifest argv', () => {
    const first = plan(bucket, { state: 'absent' }, undefined);
    expect(first).toEqual({ action: 'create', argv: ['r2', 'bucket', 'create', 'kinu-backups'] });
    expect(plan(bucket, { state: 'absent' }, 'staging')).toEqual({
      action: 'create',
      argv: ['r2', 'bucket', 'create', 'kinu-backups', '--env', 'staging'],
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
    const gateway = infrastructure.resources.find((resource) => resource.id === 'ai-gateway.kinu-ai-gateway');
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
    expect(confirmationPhrase('kinu', 'production')).toBe('destroy kinu production');
    expect(confirmationPhrase('kinu-staging', 'staging')).toBe('destroy kinu-staging staging');
    expect(confirmationPhrase('kinu', 'production'))
      .not.toBe(confirmationPhrase('kinu-staging', 'staging'));
  });

  test('the order is worker first, session store last, and only deletable resources', () => {
    const deleted = partition(exclusiveTo(infrastructure, 'production')).deleted;
    const kinds = deleted.map((resource) => resource.kind);
    expect(kinds[0]).toBe('worker');
    expect(kinds.at(-1)).toBe('kv');
    // Production's own bucket and index go with it; the shared one does not
    // reach here at all.
    expect(deleted.map((resource) => resource.id)).toContain('r2.kinu-backups');
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
    expect(sweptIds).toContain('durable-object.kinu:UserDO');
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
    }
  });

  test('every data-bearing resource states what is inside it', () => {
    // The prompt names contents, not names. A resource that can lose data and
    // cannot say what would be lost makes the confirmation decorative.
    const bearing = infrastructure.resources.filter((resource) => resource.holds !== undefined);
    expect(bearing.length).toBeGreaterThan(4);
    for (const resource of bearing) expect((resource.holds ?? '').length).toBeGreaterThan(40);
    for (const kind of ['kv', 'r2', 'vectorize', 'durable-object']) {
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
    // Named rather than counted, and this is the whole set: the KV namespace is
    // NOT here, because `wrangler kv namespace create` makes a second namespace
    // instead of finding the first one — see the manifest's `manual` note.
    expect(creatable.map((resource) => resource.id).sort()).toEqual([
      'r2.kinu-backups', 'r2.kinu-backups-staging',
      'r2.kinu-feedback', 'r2.kinu-feedback-staging', 'r2.nimbus-runtime-cache',
      'vectorize.kinu-memory', 'vectorize.kinu-memory-staging',
    ]);
    for (const resource of creatable) {
      expect((resource.create ?? []).length).toBeGreaterThan(1);
      // No shell, so no quoting: a name reaches wrangler as one argv element.
      for (const word of resource.create ?? []) expect(word).not.toContain(' ');
    }
  });
});

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
  CONTROL_PLANE_ACCESS_PATHS, type InfraEnvironment, type Infrastructure, type Resource, SUPPLY,
  UNCAPTURED, UNOBSERVABLE, claimedHosts, deriveInfrastructure, envFields, exclusiveTo, readSites,
  requiredIn, supplyCensus, vectorizeGeometry,
} from './infra-manifest';
import {
  type AccessApplicationView, accessCovering, accessDestinations, accessOverreach, routeAnswer,
} from './infra-cloudflare';
import {
  type Phase, type Row, PHASES, audit, observedRow, phaseFrom, supplyDrift, supplyRows,
  supplySummary, unobservableDrift,
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

describe('the control plane\'s outer Access gate is declared and proved, not assumed', () => {
  function environmentNamed(key: string): InfraEnvironment {
    const found = infrastructure.environments.find((entry) => entry.key === key);
    if (found === undefined) throw new Error(`fixture lost the ${key} environment`);
    return found;
  }
  const production = environmentNamed('production');
  const staging = environmentNamed('staging');
  const ids = infrastructure.resources.map((resource) => resource.id);

  /** The Access application this deployment is supposed to have, as the API
   *  returns it. Two destinations, one AUD, `self_hosted`. */
  const CORRECT: readonly AccessApplicationView[] = [{
    id: 'app-1', name: 'Kinu control plane', aud: 'a'.repeat(64), type: 'self_hosted',
    destinations: [
      { type: 'public', uri: 'kinu.run/control*' },
      { type: 'public', uri: 'kinu.run/api/control*' },
    ],
  }];

  test('production declares the organization, the application, the policy and the scope', () => {
    // Four rows, because an operator's next move differs for each: a missing
    // policy is one dashboard field, a missing application is the whole setup, a
    // mismatched organization is a var this repository holds, and an over-broad
    // application is a deletion.
    expect(ids).toContain('access-organization.kinu.run');
    expect(ids).toContain('access-application.kinu.run');
    expect(ids).toContain('access-policy.kinu.run');
    expect(ids).toContain('access-scope.kinu.run');
    for (const id of ['access-organization', 'access-application', 'access-policy', 'access-scope']) {
      const resource = infrastructure.resources.find((entry) => entry.id === `${id}.kinu.run`);
      expect(resource?.required).toBe(true);
      expect(resource?.environments).toEqual(['production']);
      // Nothing here can be created by a program, so every row has to say what a
      // human does — an absent row whose detail is "does not exist" is unusable.
      expect((resource?.manual ?? '').length).toBeGreaterThan(60);
      expect(resource?.create).toBe(undefined);
      expect(resource?.destroy).toBe(undefined);
    }
  });

  test('staging declares the scope row and NO application: it admits no operators', () => {
    // The whole reason `requiredIn` pairs the two vars with a NON-EMPTY
    // CONTROL_PLANE_ADMINS. Staging runs on DEV_USER_EMAIL and admits nobody, so
    // demanding a Zero Trust application there would be a gate complaining about
    // a deployment shaped that way on purpose.
    expect(staging.vars.get('CONTROL_PLANE_ADMINS')).toBe('');
    expect(ids).not.toContain('access-application.staging.kinu.run');
    expect(ids).not.toContain('access-organization.staging.kinu.run');
    expect(ids).not.toContain('access-policy.staging.kinu.run');
    // But the NEGATIVE row is declared for staging too: an over-broad Access
    // application would break staging exactly as it breaks production.
    expect(ids).toContain('access-scope.staging.kinu.run');
  });

  test('the hostnames each environment claims are read from its routes', () => {
    expect(claimedHosts(production)).toEqual({ app: 'kinu.run', wildcards: ['kinu.run'] });
    expect(claimedHosts(staging)).toEqual({ app: 'staging.kinu.run', wildcards: [] });
  });

  test('the two Access vars are required in production and not in staging', () => {
    for (const name of ['CONTROL_PLANE_ACCESS_TEAM_DOMAIN', 'CONTROL_PLANE_ACCESS_AUD']) {
      expect(SUPPLY.has(name)).toBe(true);
      expect(SUPPLY.get(name)?.handling).toBe('config-var');
      expect(requiredIn(name, production)).toBe(true);
      expect(requiredIn(name, staging)).toBe(false);
    }
  });

  test('a paired var set to the empty string supplies nothing', () => {
    // The rule staging depends on, and the reason `.has()` was not enough:
    // `CONTROL_PLANE_ADMINS: ""` is the line that means NOBODY, and keying on
    // whether the KEY was typed made a feature explicitly turned off drag in
    // every value its enabled form needs.
    const emptied: InfraEnvironment = { ...production, vars: new Map([['CONTROL_PLANE_ADMINS', '  ']]) };
    expect(requiredIn('CONTROL_PLANE_ACCESS_AUD', emptied)).toBe(false);
    const filled: InfraEnvironment = { ...staging, vars: new Map([['CONTROL_PLANE_ADMINS', 'a@b.c']]) };
    expect(requiredIn('CONTROL_PLANE_ACCESS_AUD', filled)).toBe(true);
  });

  test('destinations are normalized, and a private one is neither coverage nor overreach', () => {
    expect(accessDestinations({
      domain: 'https://legacy.kinu.run/control*',
      destinations: [
        { type: 'public', uri: 'https://kinu.run/control*' },
        { type: 'public', hostname: 'kinu.run/api/control*' },
        // A network destination protects an IP range and cannot cover an HTTP
        // path on our host.
        { type: 'private', uri: '10.0.0.0/8' },
        { type: 'public', uri: '' },
      ],
    })).toEqual(['kinu.run/control*', 'kinu.run/api/control*', 'legacy.kinu.run/control*']);
    expect(accessDestinations({})).toEqual([]);
  });

  test('ONE application must cover BOTH control-plane paths', () => {
    const aud = 'a'.repeat(64);
    const covered = accessCovering(CORRECT, 'kinu.run', aud, CONTROL_PLANE_ACCESS_PATHS);
    expect(covered.covering?.id).toBe('app-1');

    // Split across two applications: each is fine on its own and the pair is
    // useless, because the Worker pins ONE aud and would answer 404 on whichever
    // path belongs to the other application.
    const split: readonly AccessApplicationView[] = [
      { id: 'ui', aud, destinations: [{ uri: 'kinu.run/control*' }] },
      { id: 'api', aud: 'c'.repeat(64), destinations: [{ uri: 'kinu.run/api/control*' }] },
    ];
    expect(accessCovering(split, 'kinu.run', aud, CONTROL_PLANE_ACCESS_PATHS).covering).toBe(undefined);
    // The failure still reports what the matching aud DOES cover, which is the
    // only thing that tells an operator which half is missing.
    expect(accessCovering(split, 'kinu.run', aud, CONTROL_PLANE_ACCESS_PATHS).destinations)
      .toEqual(['kinu.run/control*']);

    // A destination with no trailing star covers the exact path only, so
    // /control/users/x — a real SPA route — would be unprotected.
    const exact: readonly AccessApplicationView[] = [{
      id: 'narrow', aud,
      destinations: [{ uri: 'kinu.run/control' }, { uri: 'kinu.run/api/control' }],
    }];
    expect(accessCovering(exact, 'kinu.run', aud, CONTROL_PLANE_ACCESS_PATHS).covering).toBe(undefined);

    // An application on a different aud is not ours, however well it covers.
    expect(accessCovering(CORRECT, 'kinu.run', 'd'.repeat(64), CONTROL_PLANE_ACCESS_PATHS).covering)
      .toBe(undefined);
  });

  test('the correct configuration is NOT reported as overreach', () => {
    // The negative assertion's negative control. Without this the whole row could
    // be a permanent red that nobody can clear, which is a gate people delete.
    expect(accessOverreach(CORRECT, 'kinu.run', ['kinu.run'], CONTROL_PLANE_ACCESS_PATHS))
      .toEqual([]);
    expect(accessOverreach([], 'kinu.run', ['kinu.run'], CONTROL_PLANE_ACCESS_PATHS)).toEqual([]);
  });

  test('an application covering the app host at large IS overreach, and is named', () => {
    // The exact mistake: "protect kinu.run with Access" in one dashboard click.
    // Every positive check still passes — the admin plane works perfectly — while
    // the public landing page, /api/feedback and /api/client-errors are behind a
    // corporate login.
    for (const destination of ['kinu.run', 'kinu.run/', 'kinu.run/*', 'kinu.run/api/feedback']) {
      const found = accessOverreach(
        [{ name: 'Everything', aud: 'z', destinations: [{ uri: destination }] }],
        'kinu.run', ['kinu.run'], CONTROL_PLANE_ACCESS_PATHS,
      );
      expect(found).toHaveLength(1);
      expect(found[0]).toContain('Everything');
      expect(found[0]).toContain(destination);
    }
  });

  test('an application covering a preview wildcard IS overreach whatever its path', () => {
    // A preview URL is an arbitrary path on an arbitrary label, so there is no
    // narrowing of an Access destination that makes gating *.kinu.run safe: it
    // would put a login in front of every preview an agent hands out.
    for (const destination of ['*.kinu.run', '*.kinu.run/*', '*.kinu.run/control*']) {
      const found = accessOverreach(
        [{ name: 'Previews', destinations: [{ uri: destination }] }],
        'kinu.run', ['kinu.run'], CONTROL_PLANE_ACCESS_PATHS,
      );
      expect(found).toHaveLength(1);
      expect(found[0]).toContain('Previews');
    }
  });

  test('an application on somebody else\'s hostname is not our business', () => {
    // The gate must not fail because the account also protects an unrelated
    // internal tool. A negative assertion that fires on everything is one people
    // learn to acknowledge past.
    expect(accessOverreach(
      [
        { name: 'Grafana', destinations: [{ uri: 'grafana.example.com' }] },
        { name: 'Other zone previews', destinations: [{ uri: '*.example.com/*' }] },
        { name: 'Staging', destinations: [{ uri: 'staging.kinu.run/control*' }] },
      ],
      'kinu.run', ['kinu.run'], CONTROL_PLANE_ACCESS_PATHS,
    )).toEqual([]);
  });

  test('an absent or unreadable Access row BLOCKS the deploy', () => {
    // The point of declaring them at all. `absent` + required is a finding; and
    // `unknown` — nobody could look, typically a missing API token — is a
    // finding too, because a check that could not look is not a check that
    // passed and the alternative is shipping an unprotected admin plane from a
    // machine that had no credential.
    const deployed = row('worker.kinu', 'present', true, 'wrangler-deploy');
    for (const id of ['access-organization.kinu.run', 'access-application.kinu.run',
      'access-policy.kinu.run', 'access-scope.kinu.run']) {
      const missing = audit(infrastructure, [deployed, row(id, 'absent', true)], [], []);
      expect(missing.findings.some((entry) => entry.includes(id))).toBe(true);

      const unreadable = audit(infrastructure, [deployed, row(id, 'unknown', true)], [], []);
      expect(unreadable.findings.some((entry) => entry.includes(id))).toBe(true);

      // The negative control: present is silent, so the findings above are about
      // the verdict rather than about the row existing.
      const present = audit(infrastructure, [deployed, row(id, 'present', true)], [], []);
      expect(present.findings).toEqual([]);
    }
  });

  test('an absent Access row keeps the observation\'s own detail, not a static step', () => {
    // Which application is over-broad is the entire actionable content of the
    // scope finding, and a string written before the run cannot say it.
    const scope = infrastructure.resources.find((entry) => entry.id === 'access-scope.kinu.run');
    const manual = scope?.manual;
    if (scope === undefined || manual === undefined) {
      throw new Error('fixture lost the scope resource or its manual step');
    }
    expect(observedRow(scope, { state: 'absent', detail: '"Everything" → kinu.run/*' }).detail)
      .toBe('"Everything" → kinu.run/*');
    // With no detail it falls back to the manual step, exactly as every other
    // resource does.
    expect(observedRow(scope, { state: 'absent' }).detail).toBe(manual);
  });
});

describe('what a hostname says about its own route', () => {
  const url = 'https://staging.kinu.run/api/health';

  test('a health stamp is this Worker; a 5xx is wired and unwell', () => {
    expect(routeAnswer(url, 200, { build: { sha: 'abc' } }).state).toBe('present');
    expect(routeAnswer(url, 503, {}).state).toBe('unknown');
  });

  test('a Kinu preview refusal means the wildcard caught it, so this route is absent', () => {
    // Measured 2026-09-05: with kinu-staging deleted, staging.kinu.run answered
    // 404 {code:"NOT_A_PREVIEW"} from production's `*.kinu.run/*` route. That
    // is a positive observation of the specific route being gone, which the
    // bootstrap phase defers because the deploy creates it; an `unknown` here
    // refused the deploy that would have restored the route.
    const caught = routeAnswer(url, 404, { error: 'This host serves sandbox previews only.', code: 'NOT_A_PREVIEW' });
    expect(caught.state).toBe('absent');
    expect(caught.state === 'absent' ? caught.detail : '').toContain('NOT_A_PREVIEW');
  });

  test('any other document is something else answering, which stays unknown', () => {
    expect(routeAnswer(url, 404, { error: 'not found' }).state).toBe('unknown');
    expect(routeAnswer(url, 200, 'text').state).toBe('unknown');
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

/**
 * THE PHASE SPLIT, which is the difference between a deploy that can bootstrap
 * what it declares and a deploy that refuses itself.
 *
 * The red case is real and is this repository's: `ControlPlaneDO` was added to
 * `migrations`, staging's 55 source gates passed, and the pre-deploy
 * infrastructure gate then refused the only command that could have created the
 * namespace — no wrangler verb creates one, and provisioning is forbidden from
 * trying. The tolerance that answers it has to be narrow in three directions at
 * once, so each is a case below: narrow by OWNERSHIP (a secret or a bucket is
 * never deferred), narrow by PHASE (post-deploy tolerates nothing), and narrow by
 * VERDICT (a lookup that failed is not an absence and is never deferred).
 */
describe('the phases differ in exactly one tolerance, and only one direction', () => {
  const clean: readonly Row[] = [
    row(authStore('staging').id, 'present', true),
    ...[...UNOBSERVABLE.keys()].map((id) => row(id, 'unobservable', true)),
  ];
  /** Staging's Worker EXISTS. That is what makes this the red case rather than
   *  the first-deploy case the `full` phase already tolerated: the Worker has
   *  been deployed for months and the namespace is new. */
  const deployedWorker = row('worker.kinu-staging', 'present', true, 'wrangler-deploy');
  const absentNamespace = row(
    'durable-object.kinu-staging:ControlPlaneDO', 'absent', true, 'wrangler-deploy',
  );
  const at = (phase: Phase, rows: readonly Row[], supplied: Parameters<typeof audit>[2] = []) =>
    audit(infrastructure, rows, supplied, [], phase);

  test('the tolerance is exactly the three phases, and a mistyped one is refused', () => {
    expect([...PHASES]).toEqual(['full', 'bootstrap', 'post-deploy']);
    // An explicit argv wins over the variable the deploy script exports, which is
    // what lets step 5 spell `--phase=post-deploy` inside a bootstrap deploy.
    expect(phaseFrom(['staging', '--phase=post-deploy'], { KINU_INFRA_PHASE: 'bootstrap' }))
      .toBe('post-deploy');
    expect(phaseFrom([], { KINU_INFRA_PHASE: 'bootstrap' })).toBe('bootstrap');
    expect(phaseFrom(['staging'], {})).toBe('full');
    // Refused, never defaulted: a mistyped phase that fell back to `full` would
    // turn step 5 into a weaker check nobody asked for and would fail a bootstrap
    // deploy for a reason no output explains.
    expect(phaseFrom(['--phase=post-deply'], {})).toBeUndefined();
    expect(phaseFrom(['--phase='], { KINU_INFRA_PHASE: 'bootstrap' })).toBeUndefined();
  });

  test('a newly declared namespace is deferred before the upload and rejected after', () => {
    const rows = [...clean, deployedWorker, absentNamespace];

    const bootstrap = at('bootstrap', rows);
    expect(bootstrap.findings).toEqual([]);
    expect(bootstrap.notes).toHaveLength(1);
    expect(bootstrap.notes[0]).toContain('ControlPlaneDO');
    // The deferral names what collects it. A note that said only "expected" would
    // be a skip wearing a note's clothes.
    expect(bootstrap.notes[0]).toContain('post-deploy');

    const post = at('post-deploy', rows);
    expect(post.notes).toEqual([]);
    expect(post.findings).toHaveLength(1);
    expect(post.findings[0]).toContain('ControlPlaneDO');

    // And the gate itself is unmoved: a deployed Worker missing a namespace it
    // declares is a finding for a direct `bun run gate:infra` too.
    expect(at('full', rows).findings).toHaveLength(1);
  });

  test('post-deploy tolerates nothing at all, not even the Worker', () => {
    // `full` tolerates an absent Worker and everything bound to it, because
    // before the first deploy that is the true state of a correct account. After
    // an upload it is not a state anything can excuse: the deploy either
    // published the Worker or it did not.
    const rows = [
      ...clean,
      row('worker.kinu-staging', 'absent', true, 'wrangler-deploy'),
      absentNamespace,
    ];

    expect(at('full', rows).findings).toEqual([]);
    expect(at('full', rows).notes).toHaveLength(2);
    expect(at('bootstrap', rows).findings).toEqual([]);

    const post = at('post-deploy', rows);
    expect(post.notes).toEqual([]);
    expect(post.findings).toHaveLength(2);
    expect(post.findings.join('\n')).toContain('worker.kinu-staging');
  });

  test('an external prerequisite is refused in every phase, deploy or no deploy', () => {
    // The other half of the staging case: the two secrets nobody but a human can
    // supply. A bootstrap deploy must still refuse to upload without them, and
    // the fixture below is exactly the shape `supplyRows` produces for one.
    const external: readonly Row[] = [
      // Provisioned by hand; a deploy has never created a KV namespace.
      row(authStore('staging').id, 'absent', true, 'manual'),
      // `wrangler r2 bucket create` creates it; `bun run deploy` does not.
      row('r2.kinu-backups-staging', 'absent', true, 'wrangler-cli'),
      // Nothing here can create it at all.
      row('dns-record.staging.kinu.run', 'absent', true, 'manual'),
    ];
    const secrets = ['WEBHOOK_ROUTE_SECRET', 'DEV_IDENTITY_SECRET'].map((name) => ({
      environment: 'staging', name, verdict: 'absent' as const, required: true,
      detail: 'prompt — absent ⇒ the feature it names is off',
    }));

    for (const phase of PHASES) {
      const resources = at(phase, [...clean, deployedWorker, ...external]);
      expect(resources.notes, `${phase} deferred an external prerequisite`).toEqual([]);
      expect(resources.findings, `${phase} tolerated an external prerequisite`)
        .toHaveLength(external.length);

      const supplied = at(phase, [...clean, deployedWorker], secrets);
      expect(supplied.findings, `${phase} tolerated a missing secret`).toHaveLength(2);
      expect(supplied.findings.join('\n')).toContain('WEBHOOK_ROUTE_SECRET');
      expect(supplied.findings.join('\n')).toContain('DEV_IDENTITY_SECRET');
    }
  });

  test('a lookup that failed is never deferred, whatever owns the resource', () => {
    // `unknown` on a deploy-owned resource in the bootstrap phase is the hole
    // this closes: "the deploy will create it" is an answer about an ABSENCE, and
    // a failed lookup did not observe one. Deferring it would turn an expired
    // token into a green pre-deploy phase.
    for (const phase of PHASES) {
      const verdict = at(phase, [
        ...clean,
        deployedWorker,
        row('durable-object.kinu-staging:ControlPlaneDO', 'unknown', true, 'wrangler-deploy'),
      ]);
      expect(verdict.notes, `${phase} deferred a failed lookup`).toEqual([]);
      expect(verdict.findings, `${phase} tolerated a failed lookup`).toHaveLength(1);
      expect(verdict.findings[0]).toContain('lookup failed');
    }
  });

  test('an optional deploy-owned absence stays a capability loss, not a deferral', () => {
    // Optionality is `env.d.ts`'s statement and phases do not touch it. Reported
    // by `print`, never a finding and never a note — a deferral list padded with
    // things nobody is waiting for is a deferral list nobody reads.
    for (const phase of PHASES) {
      const verdict = at(phase, [
        ...clean,
        deployedWorker,
        row('binding.kinu-staging:EMAIL', 'absent', false, 'wrangler-deploy'),
      ]);
      expect(verdict.findings, `${phase} failed on an optional resource`).toEqual([]);
      expect(verdict.notes, `${phase} deferred an optional resource`).toEqual([]);
    }
  });

  test('the fix for a deploy-owned absence never names provisioning', () => {
    // The diagnostic that made the red unactionable. `bun run infra:provision`
    // cannot create a Durable Object namespace and is forbidden from touching
    // what the upload owns, so naming it sends the operator to a command that
    // exits 0 having done nothing — after which the gate refuses again.
    const rows = [...clean, deployedWorker, absentNamespace];

    const full = at('full', rows).findings.join('\n');
    expect(full).not.toContain('infra:provision —');
    expect(full).toContain('--bootstrap');

    const post = at('post-deploy', rows).findings.join('\n');
    expect(post).not.toContain('infra:provision —');
    expect(post).toContain('migrations');

    // The instruction is still there for a resource provisioning really does
    // create, which is what keeps the check above from passing vacuously.
    const bucket = at('full', [...clean, deployedWorker,
      row('r2.kinu-backups-staging', 'absent', true, 'wrangler-cli')]).findings.join('\n');
    expect(bucket).toContain('bun run infra:provision');
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
      .not.toBe('destroy kinu-staging staging');
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

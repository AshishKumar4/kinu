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
  CONTROL_PLANE_ACCESS_PATHS, type InfraWorker, type Infrastructure, type Resource, SUPPLY,
  UNCAPTURED, UNOBSERVABLE, claimedHosts, deriveInfrastructure, envFields, readSites,
  requiredIn, supplyCensus, vectorizeGeometry,
} from './infra-manifest';
import {
  type AccessApplicationView, accessCovering, accessDestinations, accessOverreach, routeAnswer,
} from './infra-cloudflare';
import {
  type AuditRequest, type Phase, type Row, PHASES, audit, observedRow, phaseFrom, supplyDrift,
  supplyRows, supplySummary, unobservableDrift,
} from './infra-verify';
import { confirmationPhrase, partition } from './infra-teardown';
import { plan } from './infra-provision';
import { isProductSource, readMatching } from './sources';

const infrastructure = deriveInfrastructure();

const { worker } = infrastructure;

/** The auth store. Named by NAMESPACE ID, the way the manifest names it:
 *  `kv_namespaces` carries no title (see UNCAPTURED). */
function authStore(): Resource {
  const found = infrastructure.resources.find((resource) => resource.kind === 'kv');

  if (found === undefined) throw new Error('fixture lost the auth store');

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
    expect(worker.workerName).toBe('kinu');
    expect(infrastructure.accountId).not.toBe('');

    const ids = infrastructure.resources.map((resource) => resource.id);
    // Named, not counted: a count cannot say WHICH resource the manifest lost.
    // These are the ones whose absence breaks a specific, named thing.
    expect(ids).toContain('r2.kinu-backups');
    expect(ids).toContain('r2.nimbus-runtime-cache');
    expect(ids).toContain('vectorize.kinu-memory');
    expect(ids).toContain('ai-gateway.kinu-ai-gateway');
    expect(ids).toContain('custom-domain.kinu.run');
    expect(ids).toContain('wildcard-dns.*.kinu.run');
    expect(ids).toContain('email-routing.kinu.run');
    expect(ids).toContain('durable-object.kinu:KinuSandbox');
    expect(authStore().binding).toBe('AUTH_KV');
    expect(new Set(ids).size).toBe(ids.length);
  });


  test('requiredness comes from `Env`, not from an opinion here', () => {
    const required = (id: string): boolean | undefined =>
      infrastructure.resources.find((resource) => resource.id === id)?.required;

    // AUTH_KV is not optional in Env; BACKUP_BUCKET and MEMORY_VECTORS are.
    expect(authStore().required).toBe(true);
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

describe('the supply census is pinned to `Env`', () => {
  /** The same manifest with the Worker's `vars` edited. */
  function withVars(edit: (vars: ReadonlyMap<string, string>) => ReadonlyMap<string, string>): Infrastructure {
    return { ...infrastructure, worker: { ...worker, vars: new Map(edit(worker.vars)) } };
  }

  test('SUPPLY classifies exactly the values no binding and no var supplies', () => {
    expect(supplyDrift(infrastructure)).toEqual([]);
    expect(supplyCensus(worker).length).toBeGreaterThan(5);
  });

  test('a classified value the Worker supplies itself is a stale entry', () => {
    const supplied = withVars((vars) => new Map([...vars, ['ANALYTICS_SQL_API_TOKEN', 'set-as-a-var']]));

    const drift = supplyDrift(supplied);
    expect(drift).toHaveLength(1);
    expect(drift[0]).toStartWith('ANALYTICS_SQL_API_TOKEN');
    expect(drift[0]).toContain('supplied by a binding or a var');
  });

  test('an unclassified value nothing supplies is drift', () => {
    const removed = withVars((vars) => new Map([...vars].filter(([name]) => name !== 'EMAIL_DOMAIN')));

    const drift = supplyDrift(removed);
    expect(drift).toHaveLength(1);
    expect(drift[0]).toStartWith('EMAIL_DOMAIN');
    expect(drift[0]).toContain('classified in no SUPPLY entry');
  });

  test('ordinary config vars are checked against the Worker\'s vars', () => {
    // `continue`ing the loop on every `config-var` entry would leave nothing
    // checking them at all.
    const listed = { state: 'present', detail: 'fixture', names: [] } as const;

    const verdictOf = (name: string): string | undefined =>
      supplyRows(worker, listed).find((entry) => entry.name === name)?.verdict;

    // A var the deployment sets is supplied, so it is not in the census at all;
    // a governed config-var it leaves unset is checked and reads absent.
    expect(verdictOf('EMAIL_DOMAIN')).toBeUndefined();
    expect(verdictOf('GOOGLE_OAUTH_CLIENT_ID')).toBe('absent');
    // A secret is never satisfied by a var: a plaintext secret in the config is
    // a misconfiguration, not a pass.
    expect(verdictOf('CREDENTIAL_ENCRYPTION_KEY')).toBe('absent');
  });

  test('a required value missing fails by name', () => {
    const held = (names: readonly string[]) => ({ state: 'present', detail: 'fixture', names } as const);
    const named = (entry: string): boolean => entry.startsWith('  CREDENTIAL_ENCRYPTION_KEY\n');

    const missing = audit({ infrastructure, rows: [], supplied: supplyRows(worker, held([])), unreadFields: [] });
    expect(missing.findings.some(named)).toBe(true);

    // The negative control: set it, and the finding is gone rather than merely
    // reworded.
    const set = audit({
      infrastructure, rows: [], supplied: supplyRows(worker, held(['CREDENTIAL_ENCRYPTION_KEY'])), unreadFields: [],
    });

    expect(set.findings.some(named)).toBe(false);
  });

  test('the green path prints the set it measured', () => {
    // A gate that says "ok" without naming what it looked at is a gate nobody
    // can tell from a gate that looked at nothing.
    const fields = envFields();
    const summary = supplySummary(worker, fields);
    expect(summary).toStartWith('kinu supplies ');
    expect(summary).toContain(`of ${String(fields.length)} \`Env\` fields`);

    for (const field of supplyCensus(worker, fields)) {
      expect(summary).toContain(field.name);
    }

    // EMAIL_DOMAIN is a var here, so it is supplied, not governed.
    expect(summary).not.toContain('EMAIL_DOMAIN');
  });

  test('a paired secret is required exactly where its var is set', () => {
    // The Cloudflare provider is configured, so its secret is owed; Google's
    // client id is unset, so its secret is not. The eval identity's secret is
    // owed because DEV_USER_EMAIL is set.
    expect(requiredIn('CLOUDFLARE_OAUTH_CLIENT_SECRET', worker)).toBe(true);
    expect(requiredIn('GOOGLE_OAUTH_CLIENT_SECRET', worker)).toBe(false);
    expect(requiredIn('DEV_IDENTITY_SECRET', worker)).toBe(true);
    // A paired var set to the empty string supplies nothing, so its secret is not owed.
    const unset: InfraWorker = { ...worker, vars: new Map([...worker.vars, ['DEV_USER_EMAIL', '']]) };
    expect(requiredIn('DEV_IDENTITY_SECRET', unset)).toBe(false);
    // The root secret is unconditional: it seals the credential store.
    expect(requiredIn('CREDENTIAL_ENCRYPTION_KEY', worker)).toBe(true);
  });

  test('every classified value is read by some product source', () => {
    const sources = readMatching(isProductSource);
    expect(sources.size).toBeGreaterThan(100);
    const unread = [...SUPPLY.keys()].filter((name) => readSites(name, sources).length === 0);
    expect(unread).toEqual([]);
  });
});

describe('the control plane\'s outer Access gate is declared and proved, not assumed', () => {
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
      // Nothing here can be created by a program, so every row has to say what a
      // human does — an absent row whose detail is "does not exist" is unusable.
      expect((resource?.manual ?? '').length).toBeGreaterThan(60);
      expect(resource?.create).toBe(undefined);
      expect(resource?.destroy).toBe(undefined);
    }
  });


  test('the hostnames the deployment claims are read from its routes', () => {
    expect(claimedHosts(worker)).toEqual({ app: 'kinu.run', wildcards: ['kinu.run'] });
  });


  test('a paired var set to the empty string supplies nothing', () => {
    // The rule the empty allowlist depends on, and the reason `.has()` was not enough:
    // `CONTROL_PLANE_ADMINS: ""` is the line that means NOBODY, and keying on
    // whether the KEY was typed made a feature explicitly turned off drag in
    // every value its enabled form needs.
    const emptied: InfraWorker = { ...worker, vars: new Map([['DEV_USER_EMAIL', '  ']]) };
    expect(requiredIn('DEV_IDENTITY_SECRET', emptied)).toBe(false);
    const filled: InfraWorker = { ...worker, vars: new Map([['DEV_USER_EMAIL', 'eval-service@kinu.run']]) };
    expect(requiredIn('DEV_IDENTITY_SECRET', filled)).toBe(true);
  });

  test('destinations are normalized, and a private one is neither coverage nor overreach', () => {
    expect(accessDestinations({
      domain: 'https://domain-only.kinu.run/control*',
      destinations: [
        { type: 'public', uri: 'https://kinu.run/control*' },
        { type: 'public', hostname: 'kinu.run/api/control*' },
        // A network destination protects an IP range and cannot cover an HTTP
        // path on our host.
        { type: 'private', uri: '10.0.0.0/8' },
        { type: 'public', uri: '' },
      ],
    })).toEqual(['kinu.run/control*', 'kinu.run/api/control*', 'domain-only.kinu.run/control*']);
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
        { name: 'Another deployment', destinations: [{ uri: 'other.example/control*' }] },
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
      const missing = audit({ infrastructure, rows: [deployed, row(id, 'absent', true)], supplied: [], unreadFields: [] });
      expect(missing.findings.some((entry) => entry.includes(id))).toBe(true);

      const unreadable = audit({ infrastructure, rows: [deployed, row(id, 'unknown', true)], supplied: [], unreadFields: [] });
      expect(unreadable.findings.some((entry) => entry.includes(id))).toBe(true);

      // The negative control: present is silent, so the findings above are about
      // the verdict rather than about the row existing.
      const present = audit({ infrastructure, rows: [deployed, row(id, 'present', true)], supplied: [], unreadFields: [] });
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
  const url = 'https://probe.kinu.run/api/health';

  test('a health stamp is this Worker; a 5xx is wired and unwell', () => {
    expect(routeAnswer(url, 200, { build: { sha: 'abc' } }).state).toBe('present');
    expect(routeAnswer(url, 503, {}).state).toBe('unknown');
  });

  test('a Kinu preview refusal means the wildcard caught it, so this route is absent', () => {
    // Measured 2026-09-05 (when a staging sub-route existed): with its worker deleted, it answered
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
    row(authStore().id, 'present', true),
    ...[...UNOBSERVABLE.keys()].map((id) => row(id, 'unobservable', true)),
  ];

  test('a clean inventory produces no findings', () => {
    expect(audit({ infrastructure, rows: clean, supplied: [], unreadFields: [] }).findings).toEqual([]);
  });

  test('a required absent resource fails and an optional one does not', () => {
    const missing = audit({ infrastructure, rows: [...clean, row('r2.x', 'absent', true)], supplied: [], unreadFields: [] });
    expect(missing.findings.length).toBe(1);
    expect(missing.findings[0]).toContain('r2.x');

    const optional = audit({ infrastructure, rows: [...clean, row('r2.x', 'absent', false)], supplied: [], unreadFields: [] });
    expect(optional.findings).toEqual([]);
  });

  test('a deploy-created absence is tolerated only before the Worker exists', () => {
    const missing = row('durable-object.x:New', 'absent', true, 'wrangler-deploy');

    const preDeploy = audit({
      infrastructure,
      rows: [...clean, row('worker.kinu', 'absent', true, 'wrangler-deploy'), missing],
      supplied: [],
      unreadFields: [],
    });

    expect(preDeploy.findings).toEqual([]);
    expect(preDeploy.notes.map((note) => note.includes('created by the deploy itself')))
      .toEqual([true, true]);

    const deployed = audit({
      infrastructure,
      rows: [...clean, row('worker.kinu', 'present', true, 'wrangler-deploy'), missing],
      supplied: [],
      unreadFields: [],
    });

    expect(deployed.notes).toEqual([]);
    expect(deployed.findings).toHaveLength(1);
    expect(deployed.findings[0]).toContain('durable-object.x:New');
  });

  test('a failed lookup fails even though nothing was observed missing', () => {
    // The whole reason for the third state. `unknown` on an OPTIONAL resource
    // still fails: "we could not look" is not softened by the resource being
    // one the Worker tolerates losing.
    const unreadable = audit({ infrastructure, rows: [...clean, row('r2.x', 'unknown', false)], supplied: [], unreadFields: [] });
    expect(unreadable.findings.length).toBe(1);
    expect(unreadable.findings[0]).toContain('lookup failed');
  });

  test('an undeclared blind spot fails, and a stale declaration fails too', () => {
    const undeclared = audit({
      infrastructure, rows: [...clean, row('cron.whatever', 'unobservable', true)], supplied: [], unreadFields: [],
    });

    expect(undeclared.findings.length).toBe(1);
    expect(undeclared.findings[0]).toContain('nothing declares that');

    // UNOBSERVABLE names rows that did not come back unobservable. Scoped to
    // the rows THIS run declared: an entry whose row IS declared and observable
    // is stale and fails, while one whose row this run never declared is left
    // to the self-test that audits UNOBSERVABLE against the manifest.
    const gatewayId = [...UNOBSERVABLE.keys()].find((id) => id.startsWith('ai-gateway.'));

    if (gatewayId === undefined) throw new Error('fixture expects the ai-gateway blind entry');
    const stale = audit({ infrastructure, rows: [row(gatewayId, 'present', true)], supplied: [], unreadFields: [] });
    expect(stale.findings.length).toBe(1);
    expect(stale.findings.join('\n')).toContain('ai-gateway.kinu-ai-gateway');

    // Out of scope, out of verdict: the same entry with its row undeclared.
    const scoped = audit({
      infrastructure, rows: [row(authStore().id, 'present', true)], supplied: [], unreadFields: [],
    });

    expect(scoped.findings).toEqual([]);
  });

  test('the declared blind spots are exactly the ones observation reports', () => {
    expect(unobservableDrift(clean)).toEqual([]);
    expect(UNOBSERVABLE.size).toBeGreaterThan(0);
  });

  test('a missing required secret fails and a missing optional one is reported only', () => {
    const secret = (required: boolean) => [{
      name: 'CREDENTIAL_ENCRYPTION_KEY',
      verdict: 'absent' as const, required, detail: 'absent',
    }];

    expect(audit({ infrastructure, rows: clean, supplied: secret(true), unreadFields: [] }).findings.length).toBe(1);
    expect(audit({ infrastructure, rows: clean, supplied: secret(false), unreadFields: [] }).findings).toEqual([]);
  });

  test('an unreadable secret list fails rather than reading as "no secrets set"', () => {
    const unreadable = audit({
      infrastructure,
      rows: clean,
      supplied: [{
        name: '(all secrets)', verdict: 'unknown', required: true,
        detail: 'token expired',
      }],
      unreadFields: [],
    });

    expect(unreadable.findings.length).toBe(1);
    expect(unreadable.findings[0]).toContain('token expired');
  });
});

/**
 * THE PHASE SPLIT, which is the difference between a deploy that can bootstrap
 * what it declares and a deploy that refuses itself.
 *
 * The red case is real and is this repository's: with `ControlPlaneDO` in
 * `migrations` and the 55 source gates green, the pre-deploy
 * infrastructure gate refuses the only command that could create the
 * namespace — no wrangler verb creates one, and provisioning is forbidden from
 * trying. The tolerance that answers it has to be narrow in three directions at
 * once, so each is a case below: narrow by OWNERSHIP (a secret or a bucket is
 * never deferred), narrow by PHASE (post-deploy tolerates nothing), and narrow by
 * VERDICT (a lookup that failed is not an absence and is never deferred).
 */
describe('the phases differ in exactly one tolerance, and only one direction', () => {
  const clean: readonly Row[] = [
    row(authStore().id, 'present', true),
    ...[...UNOBSERVABLE.keys()].map((id) => row(id, 'unobservable', true)),
  ];

  /** The Worker EXISTS. That is what makes this the red case rather than the
   *  first-deploy case the `full` phase already tolerates: the Worker has been
   *  deployed for months and the namespace is new. */
  const deployedWorker = row('worker.kinu', 'present', true, 'wrangler-deploy');

  const absentNamespace = row(
    'durable-object.kinu:ControlPlaneDO', 'absent', true, 'wrangler-deploy',
  );

  const at = (phase: Phase, rows: readonly Row[], supplied: AuditRequest['supplied'] = []) =>
    audit({ infrastructure, rows, supplied, unreadFields: [], phase });

  test('the tolerance is exactly the three phases, and a mistyped one is refused', () => {
    expect([...PHASES]).toEqual(['full', 'bootstrap', 'post-deploy']);
    // An explicit argv wins over the variable the deploy script exports, which is
    // what lets step 5 spell `--phase=post-deploy` inside a bootstrap deploy.
    expect(phaseFrom(['--phase=post-deploy'], { KINU_INFRA_PHASE: 'bootstrap' }))
      .toBe('post-deploy');
    expect(phaseFrom([], { KINU_INFRA_PHASE: 'bootstrap' })).toBe('bootstrap');
    expect(phaseFrom([], {})).toBe('full');
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
      row('worker.kinu', 'absent', true, 'wrangler-deploy'),
      absentNamespace,
    ];

    expect(at('full', rows).findings).toEqual([]);
    expect(at('full', rows).notes).toHaveLength(2);
    expect(at('bootstrap', rows).findings).toEqual([]);

    const post = at('post-deploy', rows);
    expect(post.notes).toEqual([]);
    expect(post.findings).toHaveLength(2);
    expect(post.findings.join('\n')).toContain('worker.kinu');
  });

  test('an external prerequisite is refused in every phase, deploy or no deploy', () => {
    // The other half: the two secrets nobody but a human can
    // supply. A bootstrap deploy must still refuse to upload without them, and
    // the fixture below is exactly the shape `supplyRows` produces for one.
    const external: readonly Row[] = [
      // Provisioned by hand; a deploy has never created a KV namespace.
      row(authStore().id, 'absent', true, 'manual'),
      // `wrangler r2 bucket create` creates it; `bun run deploy` does not.
      row('r2.kinu-backups', 'absent', true, 'wrangler-cli'),
      // Nothing here can create it at all.
      row('custom-domain.kinu.run', 'absent', true, 'manual'),
    ];

    const secrets = ['WEBHOOK_ROUTE_SECRET', 'DEV_IDENTITY_SECRET'].map((name) => ({
      name, verdict: 'absent' as const, required: true,
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
        row('durable-object.kinu:ControlPlaneDO', 'unknown', true, 'wrangler-deploy'),
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
        row('binding.kinu:EMAIL', 'absent', false, 'wrangler-deploy'),
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
      row('r2.kinu-backups', 'absent', true, 'wrangler-cli')]).findings.join('\n');

    expect(bucket).toContain('bun run infra:provision');
  });
});

describe('provisioning is idempotent, and refuses what it cannot see', () => {
  const bucket = infrastructure.resources.find((resource) => resource.id === 'r2.kinu-backups');

  if (bucket === undefined) throw new Error('fixture lost r2.kinu-backups');

  test('a resource that exists is a no-op that says so', () => {
    const second = plan(bucket, { state: 'present', detail: 'kinu-backups' });
    expect(second.action).toBe('skip');
    // The whole of idempotence: a second run issues no argv at all, so it cannot
    // create a duplicate and cannot fail on "already exists".
    expect('argv' in second).toBe(false);
  });

  test('a resource that does not exist is created, once, with the manifest argv', () => {
    const first = plan(bucket, { state: 'absent' });
    expect(first).toEqual({ action: 'create', argv: ['r2', 'bucket', 'create', 'kinu-backups'] });
  });

  test('a lookup that FAILED creates nothing — the defect the third state exists for', () => {
    const refused = plan(bucket, { state: 'unknown', reason: 'token expired' });
    expect(refused.action).toBe('refuse');
    expect('argv' in refused).toBe(false);
    expect(refused.action === 'refuse' && refused.detail).toContain('token expired');
  });

  test('a resource no wrangler command creates is refused, not skipped silently', () => {
    // A silently-skipped resource is how the assetless deploy shipped.
    const gateway = infrastructure.resources.find((resource) => resource.id === 'ai-gateway.kinu-ai-gateway');

    if (gateway === undefined) throw new Error('fixture lost the AI Gateway');
    const refused = plan(gateway, { state: 'absent' });
    expect(refused.action).toBe('refuse');
    expect(refused.action === 'refuse' && refused.detail).toContain('no wrangler command creates it');
  });
});

describe('teardown refuses by default', () => {
  test('the confirmation names the worker', () => {
    // A `-y` can be produced by a shell that answers yes to everything, and a
    // generic "yes, delete" can be pasted from a runbook for another deployment.
    expect(confirmationPhrase('kinu')).toContain('kinu');
    expect(confirmationPhrase('kinu')).not.toBe(confirmationPhrase('kinu-fork'));
  });

  test('the order is worker first, session store last, and only deletable resources', () => {
    const deleted = partition(infrastructure.resources).deleted;
    const kinds = deleted.map((resource) => resource.kind);
    expect(kinds[0]).toBe('worker');
    expect(kinds.at(-1)).toBe('kv');
    // The buckets and the index go with it.
    expect(deleted.map((resource) => resource.id)).toContain('r2.kinu-backups');
    // A Durable Object namespace has no delete command; it goes away with its
    // Worker. Anything with no `destroy` must not appear here at all, or the run
    // reports a deletion it never attempted.
    expect(kinds).not.toContain('durable-object');
  });

  test('every resource lands in exactly one fate, and the storage is in the loud one', () => {
    // Totality is the property the confirmation prompt rests on: a resource in
    // no group is a loss nobody was warned about. Filing the five Durable Object
    // namespaces — every UserDO profile, every agent's state — under a heading
    // that says they OUTLIVE the teardown is the exact opposite of what
    // `wrangler delete` does to them, so they belong in the swept group.
    const mine = infrastructure.resources;
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
      'r2.kinu-backups', 'r2.kinu-feedback', 'r2.kinu-releases', 'r2.kinu-slate-pictures', 'r2.nimbus-runtime-cache',
      'vectorize.kinu-memory',
    ]);

    for (const resource of creatable) {
      expect((resource.create ?? []).length).toBeGreaterThan(1);

      // No shell, so no quoting: a name reaches wrangler as one argv element.
      for (const word of resource.create ?? []) expect(word).not.toContain(' ');
    }
  });
});

/**
 * The infrastructure gate: every resource the binding manifest declares exists,
 * and the deployed Worker is actually bound to it.
 *
 * WHY IT IS EXHAUSTIVE RATHER THAN FAIL-FAST. "Provisioning failed" is not an
 * answer anybody can act on. This names every missing resource, because the
 * operator's next move depends on WHICH one is missing, and because a fail-fast
 * check run against a fresh account reports the first missing thing over and
 * over while other things are also missing.
 *
 * THE FOUR VERDICTS, and why there are four rather than two:
 *
 *   present       observed to exist.
 *   absent        observed NOT to exist. Fails when the resource is required —
 *                 requiredness derived from `env.d.ts`'s `?`, which is the
 *                 Worker's own statement about what it tolerates losing. An
 *                 optional one is a reported capability loss, printed on the
 *                 GREEN path, because a degradation visible only in red output
 *                 is invisible exactly when the tree is clean.
 *   unknown       the lookup failed. ALWAYS a failure. A check that could not
 *                 look is not a check that passed, and this repository has
 *                 produced four defects from treating the two as one.
 *   unobservable  no CLI path can confirm it, ever. Declared in `UNOBSERVABLE`
 *                 with the manual check, PINNED BY EQUALITY: an unobservable
 *                 resource missing from that map fails, and an entry that turns
 *                 out to be observable fails too, so the blind spot can only
 *                 shrink and can only shrink deliberately.
 *
 * ONE ROW IS A NEGATIVE ASSERTION, AND IT IS READ THE SAME WAY AS ALL THE
 * OTHERS. `access-scope.<host>` says "Cloudflare Access covers the two
 * control-plane paths and nothing else on this deployment". `present` means that
 * property HOLDS; `absent` means an Access application covers more — the app
 * host at large or a preview wildcard — and names which one. That failure is
 * invisible to every positive check, because in that state the admin plane works
 * perfectly while every preview URL an agent hands out has an interactive
 * corporate login in front of it, so the only way it is ever noticed is by being
 * observed on purpose.
 *
 * THE ACCESS ROWS NEED AN API TOKEN, NOT THE WRANGLER LOGIN. wrangler has no
 * `access` command at all, so those four rows go to the REST API and need
 * CLOUDFLARE_API_TOKEN (or CF_API_TOKEN) with `Access: Apps and Policies Read`.
 * Without one they come back `unknown`, which FAILS — deliberately. A deploy that
 * could not look at the admin plane's outer gate has not verified it, and the
 * failure names the token to mint. The alternative, reporting them as absent,
 * would let a machine with no token ship an unprotected admin plane.
 *
 * SUPPLIED VALUES ARE CHECKED BY PRESENCE, NEVER BY VALUE, AND PER ENVIRONMENT.
 * `wrangler secret list` returns names; Cloudflare will not return a value and
 * nothing here asks for one. An ordinary config var is checked the same way
 * against that environment's own `vars`. Per environment is the load-bearing
 * half: the census used to union every environment's bindings and vars before
 * comparing, so production's `EMAIL_DOMAIN` answered for staging, which has
 * none, and every `config-var` entry was skipped outright. A missing required
 * value fails loudly — `NIMBUS_RUNTIME_CACHE` was declared a `string` for months
 * while being an R2 bucket, and the reason that survived is that no program ever
 * asked whether the names in `Env` were satisfied by anything.
 *
 * THREE PHASES, AND ONLY ONE OF THEM IS EVER RELAXED — see {@link PHASES}. The
 * split exists because "does this resource exist" has two different answers
 * depending on who creates it, and the manifest already says which: a bucket, an
 * index or a DNS record is an EXTERNAL PREREQUISITE that exists before a deploy
 * or does not exist at all, while a Durable Object namespace, a container
 * application, a route and the Worker itself are created BY the deploy. Demanding
 * the second kind BEFORE the upload refuses the only command that could satisfy
 * it — which is what happened to staging when `ControlPlaneDO` was added to
 * `migrations`: the pre-deploy gate refused the deploy that would have created
 * the namespace, and printed `bun run infra:provision` as the fix, a command
 * that cannot create a Durable Object namespace and is forbidden from trying.
 *
 * It needs a Cloudflare session, so it runs at the deploy tier and carries a
 * `CI_EXEMPT` entry. Without a session the whole assertion is unreachable, which
 * is `blocked()`: non-zero by default, because a gate that prints "skipped" and
 * exits 0 is read as a pass by every human and every CI badge that sees it.
 */

import { assertMeasured, blocked, finding } from './gate-ratchet';
import {
  type Deployment, type Observation, PROBE_LABEL, accessApplication, accessOrganization,
  accessPolicies, accessScope, authenticated, container, deployment, edgeResponds,
  emailRoutingToWorker, hostResolves, kvNamespace, r2, secretNames, servesWorker, vectorize,
  wildcardDns,
} from './infra-cloudflare';
import {
  CONTROL_PLANE_ACCESS_PATHS, type InfraEnvironment, type Infrastructure, type Resource, SUPPLY,
  UNCAPTURED, UNOBSERVABLE, WRANGLER_CONFIG, claimedHosts, deriveInfrastructure, envFields,
  readSites, requiredIn, supplyCensus, vectorizeGeometry,
} from './infra-manifest';
import { isProductSource, readMatching } from './sources';

const GATE = 'infra';
const ACK = 'KINU_INFRA_ACK';

export type Verdict = 'present' | 'absent' | 'unknown' | 'unobservable';

export interface Row {
  readonly id: string;
  readonly verdict: Verdict;
  /** Present ⇒ the observation's detail; unknown ⇒ why; unobservable ⇒ the
   *  manual check. Never empty: a row nobody can read is a row nobody acts on. */
  readonly detail: string;
  readonly required: boolean;
  readonly purpose: string;
  /** How the resource comes to exist — 'wrangler-deploy' means the deploy
   *  itself creates it, which is what lets the audit tell a pre-first-deploy
   *  absence from a provisioning gap. */
  readonly origin: Resource['origin'];
}

/**
 * WHICH RUN THIS IS. Exactly one thing changes between phases: whether an absent
 * resource THE DEPLOY ITSELF CREATES is a finding or a deferral. Nothing else is
 * ever softened — an unreadable lookup, an undeclared blind spot, a missing
 * secret, a missing bucket, index, namespace-id or DNS record fails in every
 * phase, because none of those is anything a deploy could have created.
 *
 *   full         the gate. `bun run gate:infra`, and any direct call. The only
 *                tolerance in it is the one the manifest itself implies: before
 *                the FIRST deploy there is no Worker, so nothing bound to one can
 *                exist either.
 *   bootstrap    the pre-deploy half of a deploy that is itself the provisioner
 *                of something newly declared — a Durable Object class added to
 *                `migrations`, a new container, a new route. Those are DEFERRED,
 *                because no command in this repository can create one and the
 *                only thing that does is the upload this phase gates. Reachable
 *                only by asking for it (`--phase=bootstrap`, or the variable
 *                `scripts/deploy.sh` exports when the operator passes
 *                `--bootstrap`), and useful only inside a deploy, which runs
 *                `post-deploy` afterwards whether anything was deferred or not.
 *   post-deploy  after the upload, and the whole reason `bootstrap` is allowed to
 *                exist. NO tolerance at all: the deploy has run, so a resource it
 *                owns is present or the deployment failed. STRICTER than `full`,
 *                which still tolerates an absent Worker — a statement about a
 *                deploy that has not happened yet, and one this phase can never
 *                truthfully make.
 *
 * A deferral is therefore never a skip: it names a row and hands it to a run that
 * cannot tolerate it, and `scripts/deploy.sh` performs that run unconditionally
 * in both environments. There is no value of anything — argv, environment, or
 * both — that reaches an upload without `post-deploy` behind it.
 */
export const PHASES = ['full', 'bootstrap', 'post-deploy'] as const;
export type Phase = (typeof PHASES)[number];

/** Resources THIS DEPLOY creates, from the manifest's own `origin` rather than a
 *  list of names here: `wrangler-deploy` is already the manifest's word for "the
 *  upload creates it, and provisioning must not". A name list would be correct
 *  until the next class lands in `migrations`, which is precisely the event this
 *  distinction exists for. */
const deployOwned = (origin: Row['origin']): boolean => origin === 'wrangler-deploy';

/** Which binding types on the deployed Worker satisfy which manifest kind. The
 *  Workers API spells them its own way and this is the only place the two
 *  vocabularies meet. */
const DEPLOYED_TYPE = new Map<string, string>([
  ['ai', 'Workers AI'],
  ['assets', 'static assets'],
  ['durable_object_namespace', 'Durable Object'],
  ['kv_namespace', 'KV'],
  ['r2_bucket', 'R2'],
  ['send_email', 'Email Sending'],
  ['vectorize', 'Vectorize'],
  ['worker_loader', 'Worker Loader'],
]);

/** One resource's row, from what was observed of it. Exported for the self-test:
 *  the absent branch's precedence — the observation's own detail over the
 *  resource's static manual step — is what makes a NEGATIVE assertion actionable,
 *  and it is decided here rather than at any call site. */
export function observedRow(resource: Resource, observation: Observation): Row {
  const base = { id: resource.id, required: resource.required, purpose: resource.purpose, origin: resource.origin };
  if (observation.state === 'present') return { ...base, verdict: 'present', detail: observation.detail };
  if (observation.state === 'unknown') return { ...base, verdict: 'unknown', detail: observation.reason };
  // An absent row is the one an operator acts on, so it carries the action: the
  // observation's own detail where it has one, then the manual step for a
  // resource nothing can create, and otherwise the fact that provisioning is what
  // creates it. The observation wins because it is the only one of the three that
  // saw the account: a negative assertion fails because something EXISTS, and
  // naming which thing cannot be done by a string written before the run.
  return {
    ...base,
    verdict: 'absent',
    detail: observation.detail ?? resource.manual ?? `does not exist. ${resource.origin === 'wrangler-deploy'
      ? '`bun run deploy` creates it' : '`bun run infra:provision` creates it'}`,
  };
}

/** A resource nothing can look at. The manual check comes from the pinned map;
 *  a resource that reaches here without an entry gets a row saying exactly that,
 *  which is what makes the pin an assertion rather than a courtesy. */
function unobservableRow(resource: Resource): Row {
  const check = UNOBSERVABLE.get(resource.id);
  return {
    id: resource.id,
    verdict: 'unobservable',
    detail: check ?? 'UNDECLARED: nothing here can observe this resource and no entry in '
      + 'UNOBSERVABLE says why or how a human should check it',
    required: resource.required,
    purpose: resource.purpose,
    origin: resource.origin,
  };
}

/** The hostname a route pattern claims, without the wildcard label and without
 *  the path — neither of which DNS or an HTTP probe can be given. */
const routeHost = (pattern: string): string =>
  pattern.replace(/^\*\./u, '').replace(/\/.*$/u, '');

/**
 * One resource, observed.
 *
 * The `deployment` argument is the live binding set for the environment that
 * declares this resource; it is what answers "and is it BOUND", which no
 * account-level catalogue can. A bucket that exists while nothing references it
 * is not a provisioned bucket.
 */
async function observe(
  resource: Resource,
  environment: InfraEnvironment,
  live: Deployment,
): Promise<Row> {
  const bound = (name: string, expect: string | undefined): Observation => {
    if (live.state === 'unknown') return { state: 'unknown', reason: live.reason };
    if (live.state === 'absent') {
      return { state: 'unknown', reason: `${environment.workerName} is not deployed, so nothing can say whether ${name} is bound` };
    }
    const binding = live.bindings.find((entry) => entry.name === name);
    if (binding === undefined) return { state: 'absent' };
    const kind = DEPLOYED_TYPE.get(binding.type) ?? binding.type;
    return {
      state: 'present',
      detail: `bound as ${kind}${binding.target === undefined ? '' : ` → ${binding.target}`}`
        + (expect === undefined || kind === expect ? '' : ` — MANIFEST DECLARES ${expect}`),
    };
  };

  switch (resource.kind) {
    case 'kv':
      return observedRow(resource, kvNamespace(resource.name));
    case 'r2':
      return observedRow(resource, r2(resource.name));
    case 'vectorize': {
      const geometry = vectorizeGeometry();
      return observedRow(resource, vectorize(resource.name, geometry.dimensions, geometry.metric));
    }
    case 'container': {
      const image = /image (\S+)$/u.exec(resource.purpose)?.[1] ?? '';
      return observedRow(resource, container(resource.name, image));
    }
    case 'worker':
      if (live.state === 'deployed') return observedRow(resource, { state: 'present', detail: `version ${live.versionId}` });
      return observedRow(resource, live.state === 'absent' ? { state: 'absent' } : { state: 'unknown', reason: live.reason });
    case 'durable-object':
      return observedRow(resource, bound(resource.boundBy[0]?.binding ?? '', 'Durable Object'));
    case 'binding':
      return observedRow(resource, bound(resource.boundBy[0]?.binding ?? '', undefined));
    case 'custom-domain':
      return observedRow(resource, await servesWorker(resource.name));
    case 'zone-route': {
      const host = routeHost(resource.name);
      // A wildcard route is asked whether ANYTHING answers under it, because a
      // preview host with no live preview answers 404 on purpose. An exact route
      // claims one origin, so it is asked the stronger question the custom
      // domain is asked: does this hostname reach THIS Worker.
      return observedRow(resource, resource.name.startsWith('*.')
        ? await edgeResponds(`${PROBE_LABEL}.${host}`)
        : await servesWorker(host));
    }
    case 'wildcard-dns':
      return observedRow(resource, await wildcardDns(routeHost(resource.name)));
    case 'dns-record':
      return observedRow(resource, await hostResolves(resource.name));
    case 'email-routing':
      return observedRow(resource, emailRoutingToWorker(resource.name, environment.workerName));
    // ── Cloudflare Access ───────────────────────────────────────────────
    //
    // The two vars come from the ENVIRONMENT rather than from the resource,
    // because they are configuration this repository holds and the resource is
    // the account-side object they point at. `resource.name` is the app host, so
    // one row per environment stays readable across an AUD rotation.
    case 'access-organization':
      return observedRow(resource, await accessOrganization(
        (environment.vars.get('CONTROL_PLANE_ACCESS_TEAM_DOMAIN') ?? '').trim(),
      ));
    case 'access-application':
      return observedRow(resource, await accessApplication(
        resource.name,
        (environment.vars.get('CONTROL_PLANE_ACCESS_AUD') ?? '').trim(),
        CONTROL_PLANE_ACCESS_PATHS,
      ));
    case 'access-policy':
      return observedRow(resource, await accessPolicies(
        resource.name,
        (environment.vars.get('CONTROL_PLANE_ACCESS_AUD') ?? '').trim(),
      ));
    // The negative assertion. `present` means the property HOLDS — Access covers
    // nothing outside the control plane — so a passing account reads as a ✓ row
    // rather than as a missing resource.
    case 'access-scope':
      return observedRow(resource, await accessScope(
        resource.name, claimedHosts(environment).wildcards, CONTROL_PLANE_ACCESS_PATHS,
      ));
    default:
      return unobservableRow(resource);
  }
}

/* ── Supplied values ──────────────────────────────────────────────────── */

export interface SupplyRow {
  readonly environment: string;
  readonly name: string;
  readonly verdict: Verdict;
  readonly required: boolean;
  readonly detail: string;
}

/**
 * What `SUPPLY` says must exist IN THIS ENVIRONMENT, against what this
 * environment actually carries: secrets against the Worker's secret names,
 * ordinary config vars against that environment's `vars`.
 *
 * A `config-var` entry used to be skipped here entirely, while the comment said
 * it was checked against `vars` — so an ordinary variable present in production
 * and missing from staging was checked by nothing at all. A plain value put in
 * the secret store still works, so both stores count for one.
 */
export function supplyRows(
  environment: InfraEnvironment,
  observed: Observation & { readonly names?: readonly string[] },
): readonly SupplyRow[] {
  const rows: SupplyRow[] = [];
  const secretsReadable = observed.state !== 'unknown';
  if (!secretsReadable) {
    rows.push({
      environment: environment.key,
      name: '(all secrets)',
      verdict: 'unknown',
      required: true,
      detail: observed.reason,
    });
  }
  const held = new Set(observed.state === 'present' ? observed.names ?? [] : []);
  for (const [name, supply] of SUPPLY) {
    const configVar = supply.handling === 'config-var';
    // A secret whose names could not be listed is already reported once, above.
    // A config var is read from the config this run derived, so it is checkable
    // whatever the session can see.
    if (!configVar && !secretsReadable) continue;
    const inVars = configVar && environment.vars.has(name);
    const present = inVars || held.has(name);
    rows.push({
      environment: environment.key,
      name,
      verdict: present ? 'present' : 'absent',
      required: requiredIn(name, environment),
      detail: present
        ? `${inVars ? "declared in this environment's `vars`" : 'set on the Worker'} (${supply.handling})`
        : `${supply.handling} — absent ⇒ ${supply.absent}`,
    });
  }
  // A secret set on the Worker that `Env` never declares is stale configuration:
  // it is not a hole, so it does not fail, but nothing reads it and nobody knows
  // it is there.
  const declared = new Set(envFields().map((field) => field.name));
  for (const name of held) {
    if (declared.has(name)) continue;
    rows.push({
      environment: environment.key,
      name,
      verdict: 'present',
      required: false,
      detail: 'set on the Worker and declared nowhere in Env — nothing reads it',
    });
  }
  return rows;
}

/* ── Pins ─────────────────────────────────────────────────────────────── */

/**
 * `SUPPLY` must describe exactly the `Env` fields the manifest does not supply,
 * in every environment separately.
 *
 * Equality in both directions: an unclassified field is a value nobody decided
 * how to obtain, and a stale entry reads as a considered decision about a name
 * that no longer exists. The census used to be unioned across environments
 * first, which made "supplied" mean "supplied somewhere" — production's
 * `EMAIL_DOMAIN` var answered for staging, which has none.
 */
export function supplyDrift(infrastructure: Infrastructure): readonly string[] {
  const fields = envFields();
  const unsuppliedIn = new Map<string, string[]>();
  for (const environment of infrastructure.environments) {
    for (const field of supplyCensus(environment, fields)) {
      unsuppliedIn.set(field.name, [...unsuppliedIn.get(field.name) ?? [], environment.key]);
    }
  }
  const classified = [...SUPPLY.keys()];
  return [
    ...[...unsuppliedIn].filter(([name]) => !classified.includes(name)).map(([name, environments]) =>
      `${name} is read from \`Env\`, supplied by no binding and no var in `
      + `${environments.join(' and ')}, and classified in no SUPPLY entry. Say whether `
      + 'provisioning prompts for it, whether it comes from outside, or whether it is a plain '
      + 'var — a value nobody decided how to obtain is a value nobody sets'),
    ...classified.filter((name) => !unsuppliedIn.has(name)).map((name) =>
      `${name} has a SUPPLY entry and is supplied by a binding or a var in every environment. `
      + 'Remove it: a stale entry excuses the next name that happens to be spelled the same way'),
  ];
}

/** Stale blind-spot entries, scoped to the rows THIS run declared. Runs are
 *  one-environment (see main), so an entry owned by another environment's
 *  resource is that run's business — demanding it here failed every staging
 *  run on production's cron entry. An entry matching NO declared resource in
 *  any run is caught by the run that owns its environment prefix going stale;
 *  entries for resources deleted from the manifest entirely are caught by the
 *  self-test, which audits UNOBSERVABLE against the derived manifest. */
export function unobservableDrift(rows: readonly Row[]): readonly string[] {
  const seen = rows.filter((entry) => entry.verdict === 'unobservable').map((entry) => entry.id);
  const declared = new Set(rows.map((entry) => entry.id));
  return [...UNOBSERVABLE.keys()]
    .filter((id) => declared.has(id))
    .filter((id) => !seen.includes(id))
    .map((id) =>
      `${id} is declared UNOBSERVABLE and was not reported as one — either it is now observable `
      + '(delete the entry and check it) or the resource is gone (delete the entry). A blind spot '
      + 'nobody can reach is still a blind spot somebody trusts');
}

/* ── The verdict ──────────────────────────────────────────────────────── */

export interface Audit {
  readonly rows: readonly Row[];
  readonly supplied: readonly SupplyRow[];
  readonly findings: readonly string[];
  /** True statements the verdict tolerates but must not swallow — printed on
   *  the success path so a pass never reads as "nothing to say". */
  readonly notes: readonly string[];
}

/**
 * What CREATES the absent thing, for the fix line.
 *
 * It used to say `bun run infra:provision` for every absence, and for a resource
 * the manifest marks `wrangler-deploy` that instruction cannot work and must not:
 * there is no wrangler verb that creates a Durable Object namespace, and
 * provisioning is explicitly forbidden from touching what the upload owns. That
 * is not hypothetical — `ControlPlaneDO` landed in `migrations`, this gate refused
 * staging's deploy, and the one command it named could never have fixed it. A fix
 * line that cannot work is how a real red gets bypassed instead of read.
 */
function remedy(entry: Row, phase: Phase): string {
  if (!deployOwned(entry.origin)) {
    return 'bun run infra:provision — or, for a resource provisioning cannot create, the manual '
      + 'step it prints.';
  }
  if (phase === 'post-deploy') {
    return 'nothing is left to run: the upload carried the config that declares this and the '
      + 'account does not hold it. Read the `wrangler deploy` output above. A Durable Object '
      + 'namespace needs a `migrations` entry naming its class IN THE ENVIRONMENT BEING DEPLOYED '
      + '(a named `env.*` block inherits none), and a container, a route and a cron each need '
      + 'their own block there. Provisioning can create none of them.';
  }
  return 'the deploy creates this one; `bun run infra:provision` neither can nor may. If THIS '
    + 'deploy is the one that declares it — a class new to `migrations`, a new container or a new '
    + 'route — say so: `bash scripts/deploy.sh <environment> --bootstrap` defers exactly this row '
    + 'before the upload and rejects it after, when the deploy has had its chance to create it.';
}

/** Pure, so the self-test drives every branch without a Cloudflare account. The
 *  `phase` default is the strict one: a caller that has not thought about phases
 *  gets the gate. */
export function audit(
  infrastructure: Infrastructure,
  rows: readonly Row[],
  supplied: readonly SupplyRow[],
  unreadFields: readonly string[],
  phase: Phase = 'full',
): Audit {
  const findings: string[] = [];
  const notes: string[] = [];
  const workerDeployed = rows.some(
    (entry) => entry.id.startsWith('worker.') && entry.verdict === 'present',
  );

  for (const entry of rows) {
    if (entry.verdict === 'unknown') {
      findings.push(finding({
        at: entry.id,
        invariant: 'every declared resource is either observed to exist or observed not to. A '
          + 'lookup that failed is neither, and the two actions those states imply are each '
          + 'wrong for the other one.',
        found: `the lookup failed — ${entry.detail}`,
        silently: 'provisioning creates a second copy of something that already exists, or the '
          + 'report reads as a complete account while nothing was ever checked.',
        fix: 'restore the credential or the network and re-run. Do not guess which state it was.',
      }));
      continue;
    }
    if (entry.verdict === 'unobservable' && !UNOBSERVABLE.has(entry.id)) {
      findings.push(finding({
        at: entry.id,
        invariant: 'a resource nothing can observe is DECLARED unobservable, with the manual '
          + 'check. A blind spot that is not written down is indistinguishable from a pass.',
        found: 'nothing here can observe it and nothing declares that',
        silently: 'the report reads as complete while a required resource is unchecked.',
        fix: 'add an UNOBSERVABLE entry in scripts/infra-manifest.ts naming the manual check, or '
          + 'give the resource an observation in scripts/infra-cloudflare.ts.',
      }));
      continue;
    }
    if (
      entry.verdict === 'absent'
      && entry.required
      && deployOwned(entry.origin)
      // THE ONE TOLERANCE, and the whole behavioural difference between the three
      // phases. `post-deploy` has none: the upload has run. `bootstrap` defers
      // every deploy-owned absence, because a class new to `migrations` cannot
      // exist before the deploy that declares it. `full` defers one only while
      // the Worker itself is absent — the pre-first-deploy state, in which
      // nothing bound to a Worker could exist either.
      && phase !== 'post-deploy'
      && (phase === 'bootstrap' || !workerDeployed)
    ) {
      // Deferred, never skipped: nothing reachable from here can create it, and
      // the run that collects it tolerates nothing.
      notes.push(`${entry.id} is absent and is created by the deploy itself — ${phase === 'bootstrap'
        ? 'deferred by the bootstrap phase, which is why that phase exists; the post-deploy run '
          + 'rejects it if the upload does not create it'
        : 'expected before the first deploy carrying its migration; verify it exists after this '
          + 'deploy lands'}`);
      continue;
    }
    if (entry.verdict === 'absent' && entry.required) {
      findings.push(finding({
        at: entry.id,
        invariant: `it exists and is bound: ${entry.purpose}. The manifest binds it and `
          + '`env.d.ts` does not mark it optional, so the Worker has stated it needs this.',
        found: phase === 'post-deploy' && deployOwned(entry.origin)
          ? 'not present AFTER the upload that creates it — the new version is live and this is not'
          : 'not present in this account',
        silently: 'the Worker deploys, the site answers 200, and the first request down this path '
          + 'throws at runtime.',
        fix: remedy(entry, phase),
      }));
    }
  }

  for (const value of supplied) {
    if (value.verdict === 'unknown') {
      findings.push(finding({
        at: `${value.environment} secrets`,
        invariant: 'the secret NAMES set on the Worker are readable. Presence is the only '
          + 'property of a secret anything can check, and this could not check it.',
        found: value.detail,
        silently: 'a deployment with no root secret answers 503 on every signed-in surface while '
          + 'public routes answer 200, so the site looks healthy.',
        fix: 'restore the wrangler session and re-run.',
      }));
      continue;
    }
    if (value.verdict === 'absent' && value.required) {
      const configVar = SUPPLY.get(value.name)?.handling === 'config-var';
      findings.push(finding({
        at: `${value.environment}/${value.name}`,
        invariant: `it is supplied in ${value.environment}. ${value.detail}`,
        found: configVar
          ? `absent from the \`vars\` block for ${value.environment} and from its secret store`
          : 'absent from `wrangler secret list`',
        silently: 'nothing at deploy time. The Worker uploads, the smoke gate passes on public '
          + 'routes, and the signed-in half of the product is gone.',
        fix: configVar
          ? `add it to the \`vars\` block for ${value.environment} in ${WRANGLER_CONFIG}. An `
            + 'environment inherits no vars from another one.'
          : 'bun run infra:provision — it prompts for this one, because a secret the program '
            + 'invents and never shows anyone cannot be restored.',
      }));
    }
  }

  findings.push(...supplyDrift(infrastructure).map((detail) => finding({
    at: 'scripts/infra-manifest.ts SUPPLY',
    invariant: 'SUPPLY classifies exactly the `Env` fields no binding and no var supplies, in '
      + 'every environment separately. The census is derived; the handling of each name is a '
      + 'judgement that must not be guessed.',
    found: detail,
    silently: 'a new secret ships undocumented and unset, and the feature that needs it is off '
      + 'with no error anywhere.',
    fix: 'classify it in SUPPLY in scripts/infra-manifest.ts, or delete the stale entry.',
  })));

  findings.push(...unobservableDrift(rows).map((detail) => finding({
    at: 'scripts/infra-manifest.ts UNOBSERVABLE',
    invariant: 'the blind-spot list names exactly the rows that came back unobservable, so it can '
      + 'only shrink and only on purpose.',
    found: detail,
    silently: 'a stale entry excuses whatever resource is next given the same id.',
    fix: 'delete the entry in scripts/infra-manifest.ts UNOBSERVABLE.',
  })));

  for (const name of unreadFields) {
    findings.push(finding({
      at: `scripts/infra-manifest.ts SUPPLY / ${name}`,
      invariant: 'every value an operator is told to obtain, install and rotate is read by some '
        + 'product source.',
      found: `no product source reads \`env.${name}\``,
      silently: 'operators keep setting it, and a reader keeps assuming the feature it names '
        + 'exists.',
      fix: 'delete the SUPPLY entry and the `Env` field, or wire the reader.',
    }));
  }

  return { rows, supplied, findings, notes };
}

/* ── Reporting ────────────────────────────────────────────────────────── */

const SYMBOL = {
  present: '  ok  ',
  absent: 'ABSENT',
  unknown: 'UNKNWN',
  unobservable: ' blind',
} satisfies Record<Verdict, string>;

function print(
  environments: readonly InfraEnvironment[],
  rows: readonly Row[],
  supplied: readonly SupplyRow[],
): void {
  console.log('\nResources');
  for (const entry of rows) {
    const flag = entry.required ? '' : ' (optional)';
    console.log(`  [${SYMBOL[entry.verdict]}] ${entry.id}${flag}\n           ${entry.detail}`);
  }
  console.log('\nSupplied values — presence only; no value is ever requested or printed');
  for (const value of supplied) {
    const flag = value.required ? 'required' : 'optional';
    console.log(`  [${SYMBOL[value.verdict]}] ${value.environment}/${value.name} (${flag})\n           ${value.detail}`);
  }
  const fields = envFields();
  for (const environment of environments) console.log(`\n${supplySummary(environment, fields)}`);
  console.log('\nDeclared by nothing the manifest can express — check these by hand:');
  for (const item of UNCAPTURED) console.log(`  · ${item.what}\n      evidence: ${item.evidence}\n      check:    ${item.check}`);
}

/**
 * One environment's measured supply, on the success path, named rather than
 * counted: a reader who cannot see WHICH fields an environment supplies itself
 * and which ones `SUPPLY` answers for cannot tell a complete pass from a pass
 * over an empty set — and the set was, for every ordinary config var, empty.
 */
export function supplySummary(environment: InfraEnvironment, fields = envFields()): string {
  const census = supplyCensus(environment, fields);
  return `${environment.key} supplies ${String(fields.length - census.length)} of `
    + `${String(fields.length)} \`Env\` fields from its own ${String(environment.bindings.length)} `
    + `bindings and ${String(environment.vars.size)} vars. SUPPLY governs the other `
    + `${String(census.length)}:\n  ${census.map((field) => field.name).join(', ')}`;
}

/** How a phase is asked for on the command line, and the variable
 *  `scripts/deploy.sh` carries it in. Both spellings exist for the same reason
 *  the environment already has both: the deploy's gate line has to stay ONE
 *  string for `scripts/ladder.ts` to parse and match against LADDER, so anything
 *  that varies per run travels beside the command rather than inside it. */
const PHASE_FLAG = '--phase=';
const PHASE_ENV = 'KINU_INFRA_PHASE';

/**
 * The phase this run is, from an explicit flag or from the variable the deploy
 * script exports. Neither ⇒ `full`, the gate.
 *
 * `undefined` means a phase was NAMED and is not one this program has, which is
 * refused rather than defaulted. Defaulting would be the dangerous direction in
 * the readable case and the confusing one in the other: a mistyped
 * `--phase=post-deply` silently running the full gate turns a post-deploy
 * verification into a weaker check nobody asked for, and a mistyped bootstrap
 * fails a deploy for a reason no output explains.
 */
export function phaseFrom(
  argv: readonly string[],
  environment: Readonly<Record<string, string | undefined>>,
): Phase | undefined {
  const flag = argv.find((argument) => argument.startsWith(PHASE_FLAG));
  const named = flag?.slice(PHASE_FLAG.length) ?? environment[PHASE_ENV] ?? 'full';
  return PHASES.find((candidate) => candidate === named);
}

/**
 * ONE ENVIRONMENT PER RUN. An explicit argv wins; failing that the environment
 * being deployed, which `scripts/deploy.sh` exports as KINU_DEPLOY_ENV; failing
 * that production. The deploy path needs its gate line to stay ONE string —
 * `scripts/ladder.ts` parses those lines and matches them against LADDER — so the
 * environment travels beside the command rather than inside it.
 *
 * The alternative — every environment, one verdict — was measured on the live
 * account and is the wrong shape: staging's deployed version predates the
 * MonitorDO migration and staging has no root secret, both real defects and
 * neither one a reason to refuse a production deploy. A gate that blocks the
 * thing you are shipping on the state of a thing you are not is a gate people
 * learn to bypass.
 *
 * The environments NOT checked are named on every run with the command that
 * checks them, so this is a scope and not a silent skip.
 *
 * ONE PHASE PER RUN too, and it is named in every line this prints: a `bootstrap`
 * run is not the gate and must not be readable as one.
 */
async function main(): Promise<number> {
  const argv = process.argv.slice(2);
  const phase = phaseFrom(argv, process.env);
  if (phase === undefined) {
    console.error(`${GATE}: usage: bun scripts/infra-verify.ts [environment] `
      + `[${PHASE_FLAG}${PHASES.join('|')}]`);
    return 2;
  }
  // Every line this run prints says which phase produced it. `infra: ok` from a
  // bootstrap run would be read as the gate passing, and the whole point of the
  // phase is that it has not.
  const label = phase === 'full' ? GATE : `${GATE} ${phase}`;

  const session = authenticated();
  if (session.state !== 'present') {
    return blocked(label, `no Cloudflare session — ${session.state === 'unknown' ? session.reason : 'wrangler is logged out'}`, ACK);
  }

  const infrastructure = deriveInfrastructure();
  const requested = argv.find((argument) => !argument.startsWith('--'))
    ?? process.env.KINU_DEPLOY_ENV ?? 'production';
  const selected = infrastructure.environments.filter((entry) => entry.key === requested);
  if (selected.length === 0) {
    console.error(`${label}: no environment named \`${requested}\` in the manifest. `
      + `Declared: ${infrastructure.environments.map((entry) => entry.key).join(', ')}`);
    return 1;
  }

  const rows: Row[] = [];
  const supplied: SupplyRow[] = [];
  for (const environment of selected) {
    const live = deployment(environment.wranglerEnv);
    const owned = infrastructure.resources.filter((resource) =>
      resource.environments.includes(environment.key));
    for (const resource of owned) {
      // A resource two environments share is observed once, under the first.
      if (rows.some((entry) => entry.id === resource.id)) continue;
      // Manual ORIGIN says how a resource was created, not whether it can be
      // observed: AUTH_KV is provisioned by hand and read by `kv namespace
      // list`, and routing it here as unobservable reported a checked resource
      // as unchecked. observe() sends kinds with no observer to
      // unobservableRow, so a genuinely blind resource still demands its
      // UNOBSERVABLE entry.
      rows.push(await observe(resource, environment, live));
    }
    supplied.push(...supplyRows(environment, secretNames(environment.wranglerEnv)));
  }

  const sources = readMatching(isProductSource);
  const unread = [...SUPPLY.keys()].filter((name) => readSites(name, sources).length === 0);
  const verdict = audit(infrastructure, rows, supplied, unread, phase);

  const fields = envFields();
  const measured = assertMeasured(label, [
    ['environments checked', selected.length],
    ['resources declared', rows.length],
    ['resources observed present', rows.filter((entry) => entry.verdict === 'present').length],
    ['secrets and supplied values classified', SUPPLY.size],
    ['`Env` fields this run measured supply for', fields.length],
    // Per environment, and never a union: the count below is what SUPPLY has to
    // answer for in THIS environment, whatever another one declares.
    ['`Env` fields SUPPLY governs here', selected.reduce(
      (total, environment) => total + supplyCensus(environment, fields).length, 0,
    )],
    ['supplied values checked against this environment', supplied.length],
    ['product sources read for `env.` sites', sources.size],
  ]);

  print(selected, rows, supplied);

  const unchecked = infrastructure.environments.filter((entry) => !selected.includes(entry));
  if (unchecked.length > 0) {
    console.log(`\nNOT CHECKED by this run — named rather than skipped:`);
    for (const entry of unchecked) {
      console.log(`  ${entry.key} (${entry.workerName}) — bun scripts/infra-verify.ts ${entry.key}`);
    }
  }

  const present = rows.filter((entry) => entry.verdict === 'present').length;
  console.log(
    `\n${label}: ${requested} declares ${String(rows.length)} resources; `
    + `${String(present)} observed present, `
    + `${String(rows.filter((entry) => entry.verdict === 'absent').length)} absent, `
    + `${String(rows.filter((entry) => entry.verdict === 'unknown').length)} unreadable, `
    + `${String(rows.filter((entry) => entry.verdict === 'unobservable').length)} unobservable by any CLI.`,
  );

  for (const note of verdict.notes) console.log(`${label}: NOTE — ${note}`);

  // WHAT THIS RUN IS AND IS NOT, on both the red and the green path, because the
  // difference between the phases is exactly the difference between "verified"
  // and "verified except for the part something else has to check".
  if (phase === 'bootstrap') {
    console.log(
      `${label}: THIS RUN IS NOT THE GATE. It deferred `
      + `${String(verdict.notes.length)} resource(s) the manifest says the upload creates, and `
      + 'reported everything else exactly as the gate does — every secret, bucket, index, '
      + 'namespace id and DNS record was required to exist here and now. The deferrals are owed '
      + `to \`bun scripts/infra-verify.ts ${requested} ${PHASE_FLAG}post-deploy\`, which `
      + 'scripts/deploy.sh runs after the upload and which tolerates none of them.',
    );
  }
  if (phase === 'post-deploy') {
    console.log(
      `${label}: no absence is tolerated in this phase — the upload that owns these resources has `
      + 'already run, so every one of them exists or this deployment failed.',
    );
  }

  if (verdict.findings.length > 0) {
    console.error(`\n${label}: ${String(verdict.findings.length)} finding(s)\n`);
    for (const entry of verdict.findings) console.error(entry);
    console.error(`\n${label}: measured ${measured}`);
    return 1;
  }
  console.log(`${label}: ok — ${measured}`);
  return 0;
}

if (import.meta.main) process.exit(await main());

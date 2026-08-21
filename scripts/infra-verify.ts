/**
 * The infrastructure gate: every resource the binding manifest declares exists,
 * and the deployed Worker is actually bound to it.
 *
 * WHY IT IS EXHAUSTIVE RATHER THAN FAIL-FAST. "Provisioning failed" is not an
 * answer anybody can act on. This says "the manifest declares 31 resources, 30
 * exist, here is the one that does not" — because the operator's next move
 * depends on WHICH one, and because a fail-fast check run against a fresh
 * account reports the first missing thing thirty times in a row while thirty
 * other things are also missing.
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
 * SECRETS ARE CHECKED BY PRESENCE, NEVER BY VALUE. `wrangler secret list`
 * returns names; Cloudflare will not return a value and nothing here asks for
 * one. A missing required secret fails loudly — `NIMBUS_RUNTIME_CACHE` was
 * declared a `string` for months while being an R2 bucket, and the reason that
 * survived is that no program ever asked whether the names in `Env` were
 * satisfied by anything.
 *
 * It needs a Cloudflare session, so it runs at the deploy tier and carries a
 * `CI_EXEMPT` entry. Without a session the whole assertion is unreachable, which
 * is `blocked()`: non-zero by default, because a gate that prints "skipped" and
 * exits 0 is read as a pass by every human and every CI badge that sees it.
 */

import { assertMeasured, blocked, finding } from './gate-ratchet';
import {
  type Deployment, type Observation, PROBE_LABEL, authenticated, container, deployment,
  edgeResponds, emailRoutingToWorker, hostResolves, kvNamespace, r2, secretNames, servesWorker,
  vectorize, wildcardDns,
} from './infra-cloudflare';
import {
  type InfraEnvironment, type Infrastructure, type Resource, SUPPLY, UNCAPTURED, UNOBSERVABLE,
  deriveInfrastructure, envFields, readSites, requiredIn, supplyCensus, vectorizeGeometry,
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
}

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

function row(resource: Resource, observation: Observation): Row {
  const base = { id: resource.id, required: resource.required, purpose: resource.purpose };
  if (observation.state === 'present') return { ...base, verdict: 'present', detail: observation.detail };
  if (observation.state === 'unknown') return { ...base, verdict: 'unknown', detail: observation.reason };
  // An absent row is the one an operator acts on, so it carries the action: the
  // manual step for a resource nothing can create, and otherwise the fact that
  // provisioning is what creates it.
  return {
    ...base,
    verdict: 'absent',
    detail: resource.manual ?? `does not exist. ${resource.origin === 'wrangler-deploy'
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
      return row(resource, kvNamespace(resource.name));
    case 'r2':
      return row(resource, r2(resource.name));
    case 'vectorize': {
      const geometry = vectorizeGeometry();
      return row(resource, vectorize(resource.name, geometry.dimensions, geometry.metric));
    }
    case 'container': {
      const image = /image (\S+)$/u.exec(resource.purpose)?.[1] ?? '';
      return row(resource, container(resource.name, image));
    }
    case 'worker':
      if (live.state === 'deployed') return row(resource, { state: 'present', detail: `version ${live.versionId}` });
      return row(resource, live.state === 'absent' ? { state: 'absent' } : { state: 'unknown', reason: live.reason });
    case 'durable-object':
      return row(resource, bound(resource.boundBy[0]?.binding ?? '', 'Durable Object'));
    case 'binding':
      return row(resource, bound(resource.boundBy[0]?.binding ?? '', undefined));
    case 'custom-domain':
      return row(resource, await servesWorker(resource.name));
    case 'zone-route': {
      const host = routeHost(resource.name);
      // A wildcard route is asked whether ANYTHING answers under it, because a
      // preview host with no live preview answers 404 on purpose. An exact route
      // claims one origin, so it is asked the stronger question the custom
      // domain is asked: does this hostname reach THIS Worker.
      return row(resource, resource.name.startsWith('*.')
        ? await edgeResponds(`${PROBE_LABEL}.${host}`)
        : await servesWorker(host));
    }
    case 'wildcard-dns':
      return row(resource, await wildcardDns(routeHost(resource.name)));
    case 'dns-record':
      return row(resource, await hostResolves(resource.name));
    case 'email-routing':
      return row(resource, emailRoutingToWorker(resource.name, environment.workerName));
    default:
      return unobservableRow(resource);
  }
}

/* ── Secrets ──────────────────────────────────────────────────────────── */

export interface SecretRow {
  readonly environment: string;
  readonly name: string;
  readonly verdict: Verdict;
  readonly required: boolean;
  readonly detail: string;
}

/** What `SUPPLY` says must exist, checked against what the Worker actually
 *  carries. `config-var` entries are not secrets and are checked against the
 *  environment's `vars` instead — a plain value put in the secret store still
 *  works, so both stores count. */
function secretRows(environment: InfraEnvironment, observed: Observation & { readonly names?: readonly string[] }): readonly SecretRow[] {
  if (observed.state === 'unknown') {
    return [{
      environment: environment.key,
      name: '(all)',
      verdict: 'unknown',
      required: true,
      detail: observed.reason,
    }];
  }
  const held = new Set(observed.state === 'present' ? observed.names ?? [] : []);
  const rows: SecretRow[] = [];
  for (const [name, supply] of SUPPLY) {
    if (supply.handling === 'config-var') continue;
    rows.push({
      environment: environment.key,
      name,
      verdict: held.has(name) ? 'present' : 'absent',
      required: requiredIn(name, environment),
      detail: held.has(name)
        ? `set (${supply.handling})`
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

/** `SUPPLY` must describe exactly the Env fields the manifest does not supply.
 *  Equality in both directions: an unclassified field is a value nobody decided
 *  how to obtain, and a stale entry reads as a considered decision about a name
 *  that no longer exists. */
export function supplyDrift(infrastructure: Infrastructure): readonly string[] {
  const census = supplyCensus(infrastructure).map((field) => field.name);
  const classified = [...SUPPLY.keys()];
  return [
    ...census.filter((name) => !classified.includes(name)).map((name) =>
      `${name} is read from \`Env\`, supplied by no binding and no var, and classified in no `
      + 'SUPPLY entry. Say whether provisioning prompts for it, whether it comes from outside, '
      + 'or whether it is a plain var — a value nobody decided how to obtain is a value nobody '
      + 'sets'),
    ...classified.filter((name) => !census.includes(name)).map((name) =>
      `${name} has a SUPPLY entry and is no longer an unsupplied \`Env\` field. Remove it: a `
      + 'stale entry excuses the next name that happens to be spelled the same way'),
  ];
}

/** `UNOBSERVABLE` must name exactly the rows that came back unobservable. */
export function unobservableDrift(rows: readonly Row[]): readonly string[] {
  const seen = rows.filter((entry) => entry.verdict === 'unobservable').map((entry) => entry.id);
  return [...UNOBSERVABLE.keys()]
    .filter((id) => !seen.includes(id))
    .map((id) =>
      `${id} is declared UNOBSERVABLE and was not reported as one — either it is now observable `
      + '(delete the entry and check it) or the resource is gone (delete the entry). A blind spot '
      + 'nobody can reach is still a blind spot somebody trusts');
}

/* ── The verdict ──────────────────────────────────────────────────────── */

export interface Audit {
  readonly rows: readonly Row[];
  readonly secrets: readonly SecretRow[];
  readonly findings: readonly string[];
}

/** Pure, so the self-test drives every branch without a Cloudflare account. */
export function audit(
  infrastructure: Infrastructure,
  rows: readonly Row[],
  secrets: readonly SecretRow[],
  unreadFields: readonly string[],
): Audit {
  const findings: string[] = [];

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
    if (entry.verdict === 'absent' && entry.required) {
      findings.push(finding({
        at: entry.id,
        invariant: `it exists and is bound: ${entry.purpose}. The manifest binds it and `
          + '`env.d.ts` does not mark it optional, so the Worker has stated it needs this.',
        found: 'not present in this account',
        silently: 'the Worker deploys, the site answers 200, and the first request down this path '
          + 'throws at runtime.',
        fix: 'bun run infra:provision — or, for a resource provisioning cannot create, the manual '
          + 'step it prints.',
      }));
    }
  }

  for (const secret of secrets) {
    if (secret.verdict === 'unknown') {
      findings.push(finding({
        at: `${secret.environment} secrets`,
        invariant: 'the secret NAMES set on the Worker are readable. Presence is the only '
          + 'property of a secret anything can check, and this could not check it.',
        found: secret.detail,
        silently: 'a deployment with no root secret answers 503 on every signed-in surface while '
          + 'public routes answer 200, so the site looks healthy.',
        fix: 'restore the wrangler session and re-run.',
      }));
      continue;
    }
    if (secret.verdict === 'absent' && secret.required) {
      findings.push(finding({
        at: `${secret.environment}/${secret.name}`,
        invariant: `it is set on the Worker. ${secret.detail}`,
        found: 'absent from `wrangler secret list`',
        silently: 'nothing at deploy time. The Worker uploads, the smoke gate passes on public '
          + 'routes, and the signed-in half of the product is gone.',
        fix: 'bun run infra:provision — it prompts for this one, because a secret the program '
          + 'invents and never shows anyone cannot be restored.',
      }));
    }
  }

  findings.push(...supplyDrift(infrastructure).map((detail) => finding({
    at: 'scripts/infra-manifest.ts SUPPLY',
    invariant: 'SUPPLY classifies exactly the `Env` fields no binding and no var supplies. The '
      + 'census is derived; the handling of each name is a judgement that must not be guessed.',
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

  return { rows, secrets, findings };
}

/* ── Reporting ────────────────────────────────────────────────────────── */

const SYMBOL = {
  present: '  ok  ',
  absent: 'ABSENT',
  unknown: 'UNKNWN',
  unobservable: ' blind',
} satisfies Record<Verdict, string>;

function print(rows: readonly Row[], secrets: readonly SecretRow[]): void {
  console.log('\nResources');
  for (const entry of rows) {
    const flag = entry.required ? '' : ' (optional)';
    console.log(`  [${SYMBOL[entry.verdict]}] ${entry.id}${flag}\n           ${entry.detail}`);
  }
  console.log('\nSecrets — presence only; no value is ever requested or printed');
  for (const secret of secrets) {
    const flag = secret.required ? 'required' : 'optional';
    console.log(`  [${SYMBOL[secret.verdict]}] ${secret.environment}/${secret.name} (${flag})\n           ${secret.detail}`);
  }
  console.log('\nDeclared by nothing the manifest can express — check these by hand:');
  for (const item of UNCAPTURED) console.log(`  · ${item.what}\n      evidence: ${item.evidence}\n      check:    ${item.check}`);
}

/**
 * ONE ENVIRONMENT PER RUN, defaulting to production.
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
 */
async function main(): Promise<number> {
  const session = authenticated();
  if (session.state !== 'present') {
    return blocked(GATE, `no Cloudflare session — ${session.state === 'unknown' ? session.reason : 'wrangler is logged out'}`, ACK);
  }

  const infrastructure = deriveInfrastructure();
  const requested = process.argv[2] ?? 'production';
  const selected = infrastructure.environments.filter((entry) => entry.key === requested);
  if (selected.length === 0) {
    console.error(`${GATE}: no environment named \`${requested}\` in the manifest. `
      + `Declared: ${infrastructure.environments.map((entry) => entry.key).join(', ')}`);
    return 1;
  }

  const rows: Row[] = [];
  const secrets: SecretRow[] = [];
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
    secrets.push(...secretRows(environment, secretNames(environment.wranglerEnv)));
  }

  const sources = readMatching(isProductSource);
  const unread = [...SUPPLY.keys()].filter((name) => readSites(name, sources).length === 0);
  const verdict = audit(infrastructure, rows, secrets, unread);

  const measured = assertMeasured(GATE, [
    ['environments checked', selected.length],
    ['resources declared', rows.length],
    ['resources observed present', rows.filter((entry) => entry.verdict === 'present').length],
    ['secrets and supplied values classified', SUPPLY.size],
    ['product sources read for `env.` sites', sources.size],
  ]);

  print(rows, secrets);

  const unchecked = infrastructure.environments.filter((entry) => !selected.includes(entry));
  if (unchecked.length > 0) {
    console.log(`\nNOT CHECKED by this run — named rather than skipped:`);
    for (const entry of unchecked) {
      console.log(`  ${entry.key} (${entry.workerName}) — bun scripts/infra-verify.ts ${entry.key}`);
    }
  }

  const present = rows.filter((entry) => entry.verdict === 'present').length;
  console.log(
    `\n${GATE}: ${requested} declares ${String(rows.length)} resources; `
    + `${String(present)} observed present, `
    + `${String(rows.filter((entry) => entry.verdict === 'absent').length)} absent, `
    + `${String(rows.filter((entry) => entry.verdict === 'unknown').length)} unreadable, `
    + `${String(rows.filter((entry) => entry.verdict === 'unobservable').length)} unobservable by any CLI.`,
  );

  if (verdict.findings.length > 0) {
    console.error(`\n${GATE}: ${String(verdict.findings.length)} finding(s)\n`);
    for (const entry of verdict.findings) console.error(entry);
    console.error(`\n${GATE}: measured ${measured}`);
    return 1;
  }
  console.log(`${GATE}: ok — ${measured}`);
  return 0;
}

if (import.meta.main) process.exit(await main());

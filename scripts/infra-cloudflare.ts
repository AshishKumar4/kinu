/**
 * The wrangler seam: everything this repository knows how to ask Cloudflare, and
 * the one distinction the answers have to preserve.
 *
 * ABSENT IS NOT UNKNOWN. A resource that does not exist yet and a resource whose
 * lookup failed are different states, and this repository has produced four
 * defects from conflating them — `workspace_capability` reading `null` for both
 * "table absent" and "holds no token" is the one the `no-sentinel-catch` rule was
 * written for. Provisioning is exactly where that conflation is most expensive:
 * "absent" makes provision create the thing, and creating a bucket because the
 * network was down is how you get two answers to "which bucket holds the
 * snapshots". So every lookup returns a three-state `Observation`, `unknown`
 * carries the reason it is unknown, and nothing in this file ever collapses one
 * into the other.
 *
 * ONE LIST CALL PER FAMILY, not one probe per resource. `wrangler vectorize info
 * <name>` exits non-zero both for "no such index" and for "your token expired",
 * and separating those means reading error prose. A single `list` either
 * succeeds — in which case membership is decided, present or absent, with no
 * ambiguity — or fails, in which case EVERY resource of that family is `unknown`
 * and says so. The list is memoised, so an inventory of twenty resources costs
 * five calls.
 */

import { spawnSync } from 'node:child_process';
import { resolve as resolveHostname } from 'node:dns/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import * as v from 'valibot';

const REPO = new URL('..', import.meta.url).pathname;
/** wrangler resolves `wrangler.jsonc`, `.dev.vars` and the account from its cwd. */
const CF_BACKEND = `${REPO}packages/cf-backend`;

export type Observation =
  | { readonly state: 'present'; readonly detail: string }
  /** `detail` is optional, and where it is supplied it WINS over the resource's
   *  static manual step. Most absences need no detail: "the bucket is not there"
   *  plus "provisioning creates it" is the whole story. A NEGATIVE assertion is
   *  the case that does — `access-scope` fails because something exists, and
   *  WHICH application is over-broad is the entire actionable content, which a
   *  string written before the run cannot carry. */
  | { readonly state: 'absent'; readonly detail?: string }
  | { readonly state: 'unknown'; readonly reason: string };

export const absent: Observation = { state: 'absent' };
export const present = (detail: string): Observation => ({ state: 'present', detail });
export const unknown = (reason: string): Observation => ({ state: 'unknown', reason });

export interface Run {
  readonly ok: boolean;
  readonly stdout: string;
  readonly stderr: string;
  readonly code: number;
}

/**
 * One wrangler invocation. `spawnSync` with an argv array and no shell, so a
 * resource name can never be word-split or interpreted — the names here come out
 * of a config file and go straight to a mutating command.
 *
 * `stdin` is how a secret VALUE reaches wrangler: `wrangler secret put` reads
 * one from standard input, which keeps it out of the process table, out of the
 * shell history and out of any argv this program logs. Nothing here ever puts a
 * secret in `argv`.
 *
 * The environment is passed through unchanged: wrangler needs its own OAuth
 * store, and stripping it to a curated list is how a program stops working the
 * moment somebody uses CLOUDFLARE_API_TOKEN instead of a login.
 */
/** The account `wrangler.jsonc` declares, so a subcommand that does not read that
 *  file still addresses the same account `wrangler deploy` does. Without it,
 *  `wrangler r2 bucket list` fails on an owner who belongs to two accounts and
 *  asks the caller to choose — measured 2026-08-19: this gate failed standalone
 *  and passed inside `scripts/deploy.sh`, which exports the id itself. A gate that
 *  runs only inside one script is a gate nobody checks. An ambient
 *  CLOUDFLARE_ACCOUNT_ID still wins, because that is how a second account is
 *  addressed deliberately. */
const DeclaredAccount = v.object({ account_id: v.optional(v.string()) });

function declaredAccountId(): string | undefined {
  const config = join(CF_BACKEND, 'wrangler.jsonc');
  if (!existsSync(config)) return undefined;
  // Bun decodes JSONC natively on `require` — structural, where the regex this
  // replaces read the raw text and would have matched a commented-out id. The
  // hex pin is the same contract the regex carried: an account id is 32 hex
  // digits, and a placeholder must lose to the ambient variable, not win.
  const declared = v.parse(DeclaredAccount, require(config)).account_id;
  return declared !== undefined && /^[0-9a-f]+$/.test(declared) ? declared : undefined;
}

export function wrangler(argv: readonly string[], timeoutMs = 120_000, stdin?: string): Run {
  const env = {
    ...process.env,
    WRANGLER_SEND_METRICS: 'false',
    // `undefined` is a legal value here and `spawnSync` omits the entry, so an
    // owner with one account and no declared id is unaffected.
    CLOUDFLARE_ACCOUNT_ID: process.env.CLOUDFLARE_ACCOUNT_ID ?? declaredAccountId(),
  };
  const result = spawnSync('npx', ['wrangler', ...argv], {
    cwd: CF_BACKEND,
    encoding: 'utf8',
    timeout: timeoutMs,
    env,
    input: stdin,
  });
  if (result.error !== undefined) {
    return { ok: false, stdout: '', stderr: `spawn failed: ${result.error.message}`, code: -1 };
  }
  return {
    ok: result.status === 0,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    code: result.status ?? -1,
  };
}

/** Built rather than written as a literal: an escape character inside a regex
 *  literal is a control character, which `no-control-regex` rejects — correctly,
 *  since it is invisible in the source. */
const ANSI = new RegExp(`${String.fromCodePoint(0x1B)}\\[[0-9;]*m`, 'gu');

/** The last few lines of wrangler's complaint, for an `unknown` reason. Trimmed
 *  because wrangler prints a banner, an update notice and a bug-report URL on
 *  every failure and none of that names the problem. */
export function why(run: Run): string {
  const lines = `${run.stderr}\n${run.stdout}`
    .split('\n')
    .map((line) => line.replace(ANSI, '').trim())
    .filter((line) => line.length > 0
      && !line.startsWith('⛅')
      && !line.startsWith('─')
      && !line.includes('workers-sdk/issues'));
  return lines.slice(-3).join(' / ') || `exit ${String(run.code)}`;
}

/** wrangler prefixes JSON output with a banner. The payload starts at the first
 *  bracket that opens the value the caller asked for. */
function jsonBody(stdout: string, open: '[' | '{'): string | undefined {
  const at = stdout.indexOf(open);
  return at === -1 ? undefined : stdout.slice(at);
}

/**
 * A memoised `wrangler … --json` list, parsed at this boundary.
 *
 * A parse failure is `unknown`, never an empty list: an empty list would say
 * "none of your resources exist", which reads as a complete and confident answer
 * and would make provision recreate the account.
 */
class Catalog<TSchema extends v.GenericSchema> {
  private cached: { readonly rows: v.InferOutput<TSchema> } | { readonly failure: string } | undefined;

  constructor(
    private readonly label: string,
    private readonly argv: readonly string[],
    private readonly schema: TSchema,
  ) {}

  load(): { readonly rows: v.InferOutput<TSchema> } | { readonly failure: string } {
    if (this.cached !== undefined) return this.cached;
    const run = wrangler(this.argv);
    if (!run.ok) {
      this.cached = { failure: `\`wrangler ${this.argv.join(' ')}\` failed: ${why(run)}` };
      return this.cached;
    }
    const body = jsonBody(run.stdout, '[');
    if (body === undefined) {
      this.cached = { failure: `\`wrangler ${this.argv.join(' ')}\` printed no JSON array` };
      return this.cached;
    }
    try {
      this.cached = { rows: v.parse(this.schema, JSON.parse(body)) };
    } catch (error) {
      // Not a sentinel: the reason travels with the verdict, because "this
      // program could not read the answer" and "the answer was no" have to stay
      // apart all the way to the report.
      this.cached = {
        failure: `${this.label}: could not read \`wrangler ${this.argv.join(' ')}\` — `
          + (error instanceof Error ? error.message : String(error)),
      };
    }
    return this.cached;
  }
}

const NamedRows = v.array(v.object({ name: v.string() }));
const KvRows = v.array(v.object({ id: v.string(), title: v.string() }));
const VectorizeRows = v.array(v.object({
  name: v.string(),
  config: v.object({ dimensions: v.number(), metric: v.string() }),
}));
const ContainerRows = v.array(v.object({ name: v.string(), image: v.string(), id: v.string() }));

const kvCatalog = new Catalog('KV', ['kv', 'namespace', 'list'], KvRows);
const vectorizeCatalog = new Catalog('Vectorize', ['vectorize', 'list', '--json'], VectorizeRows);
const containerCatalog = new Catalog('Containers', ['containers', 'list', '--json'], ContainerRows);

/** Observed KV namespaces, or the reason the catalogue could not be read.
 *  Matched on the namespace id, because that is the only thing wrangler.jsonc
 *  names — KV titles are not unique and two of them can answer to one name. */
export function kvNamespace(id: string): Observation {
  const loaded = kvCatalog.load();
  if ('failure' in loaded) return unknown(loaded.failure);
  const row = loaded.rows.find((entry) => entry.id === id);
  return row === undefined ? absent : present(row.title);
}

export function vectorize(name: string, dimensions: number, metric: string): Observation {
  const loaded = vectorizeCatalog.load();
  if ('failure' in loaded) return unknown(loaded.failure);
  const row = loaded.rows.find((entry) => entry.name === name);
  if (row === undefined) return absent;
  const geometry = `${String(row.config.dimensions)}-dim ${row.config.metric}`;
  // Present but the wrong shape is worse than absent: the binding resolves and
  // every insert is rejected. Reported as a live index with its real geometry so
  // the caller can compare, rather than silently as "exists".
  return present(row.config.dimensions === dimensions && row.config.metric === metric
    ? geometry
    : `${geometry} — DOES NOT MATCH the ${String(dimensions)}-dim ${metric} the embedder produces`);
}

export function container(name: string, image: string): Observation {
  const loaded = containerCatalog.load();
  if ('failure' in loaded) return unknown(loaded.failure);
  const row = loaded.rows.find((entry) => entry.name === name);
  if (row === undefined) return absent;
  return present(row.image === image
    ? `${row.id} running ${row.image}`
    : `${row.id} running ${row.image} — MANIFEST DECLARES ${image}; the SDK logs a version `
      + 'mismatch on every container start until that environment is redeployed');
}

/**
 * R2 buckets. `wrangler r2 bucket list` is the one list command in this family
 * with no `--json` flag in wrangler 4.97, so its field-per-line output is read
 * instead — verified against the live account: each bucket is a `name:` line
 * followed by a `creation_date:` line.
 */
let r2Cache: { readonly names: readonly string[] } | { readonly failure: string } | undefined;

export function r2(name: string): Observation {
  if (r2Cache === undefined) {
    const run = wrangler(['r2', 'bucket', 'list']);
    r2Cache = run.ok
      ? {
        names: run.stdout.split('\n')
          .map((line) => /^name:\s+(\S+)$/u.exec(line.trim())?.[1])
          .filter((found): found is string => found !== undefined),
      }
      : { failure: `\`wrangler r2 bucket list\` failed: ${why(run)}` };
  }
  if ('failure' in r2Cache) return unknown(r2Cache.failure);
  // A parse that found nothing at all is not "the account has no buckets" — it
  // is a format this reader no longer understands, and saying "absent" there
  // would make provision create a bucket that already exists.
  if (r2Cache.names.length === 0) {
    return unknown('`wrangler r2 bucket list` succeeded and no `name:` line was recognised — '
      + 'its output format changed');
  }
  return r2Cache.names.includes(name) ? present(name) : absent;
}

/* ── The deployed Worker ──────────────────────────────────────────────── */

const DeploymentStatus = v.object({ versions: v.array(v.object({ version_id: v.string() })) });
const VersionView = v.object({
  id: v.string(),
  resources: v.object({
    bindings: v.array(v.object({
      name: v.string(),
      type: v.string(),
      class_name: v.optional(v.string()),
      bucket_name: v.optional(v.string()),
      index_name: v.optional(v.string()),
      namespace_id: v.optional(v.string()),
    })),
  }),
});

export interface DeployedBinding {
  readonly name: string;
  readonly type: string;
  /** The thing the binding points at — a class, a bucket, an index, a namespace.
   *  Explicitly `| undefined` rather than optional: a binding that names nothing
   *  is a real, common case (`AI`, `ASSETS`), not an absent field. */
  readonly target: string | undefined;
}

export type Deployment =
  | { readonly state: 'deployed'; readonly versionId: string; readonly bindings: readonly DeployedBinding[] }
  | { readonly state: 'absent' }
  | { readonly state: 'unknown'; readonly reason: string };

/**
 * What the live Worker is actually bound to.
 *
 * This is the half of verification that answers "and is it BOUND", which the
 * account-level catalogues cannot: a bucket can exist while nothing references
 * it, which is the state `NIMBUS_RUNTIME_CACHE` was effectively in when it was
 * typed as a `string`. The active deployment names a version and the version
 * carries the complete binding set, both through wrangler's own commands.
 */
export function deployment(environment: string | undefined): Deployment {
  const flag = environment === undefined ? [] : ['--env', environment];
  const status = wrangler(['deployments', 'status', '--json', ...flag]);
  if (!status.ok) {
    const complaint = why(status);
    // wrangler says this in prose and there is no exit code that distinguishes
    // it, so the one string it uses is matched deliberately and narrowly.
    return /not found|does not exist|no deployments/iu.test(complaint)
      ? { state: 'absent' }
      : { state: 'unknown', reason: `\`wrangler deployments status\` failed: ${complaint}` };
  }
  const statusBody = jsonBody(status.stdout, '{');
  if (statusBody === undefined) {
    return { state: 'unknown', reason: '`wrangler deployments status --json` printed no JSON' };
  }
  let versionId: string;
  try {
    versionId = v.parse(DeploymentStatus, JSON.parse(statusBody)).versions[0]?.version_id ?? '';
  } catch (error) {
    return {
      state: 'unknown',
      reason: `could not read \`wrangler deployments status --json\` — ${error instanceof Error ? error.message : String(error)}`,
    };
  }
  if (versionId.length === 0) return { state: 'absent' };

  const view = wrangler(['versions', 'view', versionId, '--json', ...flag]);
  if (!view.ok) {
    return { state: 'unknown', reason: `\`wrangler versions view\` failed: ${why(view)}` };
  }
  const viewBody = jsonBody(view.stdout, '{');
  if (viewBody === undefined) {
    return { state: 'unknown', reason: '`wrangler versions view --json` printed no JSON' };
  }
  try {
    const parsed = v.parse(VersionView, JSON.parse(viewBody));
    return {
      state: 'deployed',
      versionId: parsed.id,
      bindings: parsed.resources.bindings.map((binding) => {
        return {
          name: binding.name,
          type: binding.type,
          target: binding.class_name ?? binding.bucket_name ?? binding.index_name
            ?? binding.namespace_id,
        };
      }),
    };
  } catch (error) {
    return {
      state: 'unknown',
      reason: `could not read \`wrangler versions view --json\` — ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

/**
 * The secret NAMES set on a Worker. Values are never requested and cannot be:
 * Cloudflare does not return them, which is also why provisioning displays a
 * generated root secret exactly once.
 */
export function secretNames(environment: string | undefined): Observation & { readonly names?: readonly string[] } {
  const flag = environment === undefined ? [] : ['--env', environment];
  const run = wrangler(['secret', 'list', '--format', 'json', ...flag]);
  if (!run.ok) {
    const complaint = why(run);
    return /not found|does not exist/iu.test(complaint)
      ? absent
      : unknown(`\`wrangler secret list\` failed: ${complaint}`);
  }
  const body = jsonBody(run.stdout, '[');
  if (body === undefined) return unknown('`wrangler secret list --format json` printed no JSON array');
  try {
    const rows = v.parse(NamedRows, JSON.parse(body));
    return { state: 'present', detail: `${String(rows.length)} secret(s)`, names: rows.map((row) => row.name) };
  } catch (error) {
    return unknown(`could not read \`wrangler secret list\` — ${error instanceof Error ? error.message : String(error)}`);
  }
}

/* ── Routes, domains and DNS ──────────────────────────────────────────── */

/** `/api/health`'s build stamp. Only the field that identifies the Worker. */
// `build` is null until the first FULL deploy stamps the assets — a stampless
// Kinu is still THIS Worker (the smoke gate owns sha equality, deploy.sh:315),
// and refusing it made the first gated deploy impossible: the gate demanded a
// stamp only the deploy it was blocking could create.
const HealthStamp = v.object({ build: v.nullable(v.object({ sha: v.string() })) });

/**
 * Whether a hostname reaches THIS Worker, asked of the internet rather than of
 * the API.
 *
 * wrangler 4.97 has no read command for Workers custom domains — `wrangler
 * triggers` only writes, and the version view carries bindings but no routes.
 * The account API does have one, and reaching it would mean prising wrangler's
 * OAuth token out of its credential store or demanding a second token the deploy
 * path does not have; a verification step that needs a credential nobody has is
 * a verification step nobody runs.
 *
 * So the check is the property that actually matters: `GET /api/health` on the
 * hostname answers with this Worker's build stamp, a shape no other service
 * serves. That proves routing end to end. It deliberately does NOT compare the
 * sha to anything — "is this hostname wired to a Kinu Worker" is a different
 * question from "did my deploy land", and the second belongs to the deploy smoke
 * gate.
 *
 * NXDOMAIN or a refused connection is `absent`: the route is not there. A
 * timeout or a 5xx is `unknown`, because a hostname that is wired and unwell is
 * not a hostname that is unwired.
 */
export async function servesWorker(hostname: string): Promise<Observation> {
  const url = `https://${hostname}/api/health`;
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(20_000) });
    if (response.status >= 500) {
      return unknown(`${url} answered ${String(response.status)} — reachable but unwell`);
    }
    const stamp = v.safeParse(HealthStamp, await response.json());
    if (!stamp.success) {
      return unknown(`${url} answered ${String(response.status)} without the health document — `
        + 'the hostname resolves and something other than this Worker is answering');
    }
    return present(stamp.output.build === null
      ? `${hostname} → a Kinu Worker, stampless (no full deploy has landed yet)`
      : `${hostname} → a Kinu Worker, build ${stamp.output.build.sha}`);
  } catch (error) {
    const code = error instanceof Error && 'code' in error ? String(error.code) : '';
    if (code === 'ENOTFOUND' || code === 'ECONNREFUSED') return absent;
    return unknown(`${url}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/** The label prepended to a suffix to ask a wildcard record whether it exists.
 *  Exported because verification also asks the same synthetic host over HTTP,
 *  and the two probes have to name one host. */
export const PROBE_LABEL = 'infra-verify-probe';

/**
 * Whether a hostname resolves at all.
 *
 * The `pattern + zone_name` route form needs a proxied DNS record that wrangler
 * can neither create nor read — the zone DNS API answers 403 under the wrangler
 * OAuth token. DNS itself is the check that needs no credential at all: the name
 * either resolves or the record is not there. NXDOMAIN is `absent`; any other
 * resolver failure is `unknown`, because "the resolver timed out" is not "the
 * record does not exist".
 */
export async function hostResolves(hostname: string): Promise<Observation> {
  try {
    const addresses = await resolveHostname(hostname, 'A');
    return addresses.length > 0
      ? present(`${hostname} → ${addresses.join(', ')}`)
      : unknown(`${hostname} resolved to no address`);
  } catch (error) {
    const code = error instanceof Error && 'code' in error ? String(error.code) : '';
    if (code === 'ENOTFOUND' || code === 'NXDOMAIN') return absent;
    return unknown(`${hostname}: ${code.length > 0 ? code : String(error)}`);
  }
}

/** A wildcard record cannot be resolved by its own name, so an arbitrary child
 *  of the suffix is asked instead. Any name under it answers iff the record is
 *  there, which is the whole property. */
export const wildcardDns = async (suffix: string): Promise<Observation> =>
  hostResolves(`${PROBE_LABEL}.${suffix}`);

/**
 * Whether anything at all answers on a hostname under the preview suffix.
 *
 * Separate from `hostResolves` because the two failures are separate and look
 * identical from the outside otherwise: no DNS record is NXDOMAIN, while a
 * record with no route reaching it is a Cloudflare error page. Any HTTP status
 * counts as present — a preview host with no live preview answers 404 on
 * purpose, and demanding a 200 here would report the route missing whenever no
 * sandbox happens to be running.
 */
export async function edgeResponds(hostname: string): Promise<Observation> {
  try {
    const response = await fetch(`https://${hostname}/`, { signal: AbortSignal.timeout(20_000) });
    return present(`HTTP ${String(response.status)} from the edge`);
  } catch (error) {
    const code = error instanceof Error && 'code' in error ? String(error.code) : '';
    if (code === 'ENOTFOUND' || code === 'ECONNREFUSED') return absent;
    return unknown(`https://${hostname}/: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/* ── Cloudflare Access ────────────────────────────────────────────────── */

/**
 * THE ONE FAMILY WRANGLER CANNOT ASK ABOUT. `wrangler --help` carries no `access`
 * command in any version this repository has run, so the Zero Trust objects the
 * admin plane's outer gate depends on are invisible to the credential a deploy
 * normally holds. They are asked of the REST API instead, which means an API
 * TOKEN and not the OAuth login: measured against the live account, the wrangler
 * OAuth session carries no Access scope and answers 403 code 10000 here, exactly
 * as it does for AI Gateway and zone DNS.
 *
 * A MISSING TOKEN IS `unknown`, NEVER `absent`, and the whole doctrine of this
 * file turns on that: "no application protects the admin plane" and "nobody asked"
 * are different states, the first is a deploy-blocking hole and the second is a
 * credential problem, and `unknown` fails the gate for the second reason with the
 * fix named. Treating them as one would let a deploy ship an unprotected admin
 * plane on a machine that simply had no token.
 *
 * ONE LIST CALL FOR THE WHOLE FAMILY, memoised, for the same reason every other
 * family here takes one: membership out of a successful list is decided, and a
 * failed list makes every Access row `unknown` together instead of four rows
 * disagreeing about whether the lookup worked.
 */
const ACCESS_TOKEN_HELP =
  'Access is readable only with an API token: mint one at '
  + 'https://dash.cloudflare.com/profile/api-tokens with `Access: Apps and Policies Read` '
  + 'scoped to this account, and export it as KINU_ACCESS_API_TOKEN — a name wrangler never '
  + 'reads, so the deploy\'s own OAuth login keeps serving every other subcommand. The '
  + 'wrangler OAuth login carries no Access scope and answers 403 there.';

/** An Access application, in the only shape this file reads it. `destinations` is
 *  the current field and `domain` the legacy single-destination one; both are
 *  optional in the API response and BOTH are read, because an application
 *  created before destinations existed still protects what it protects. */
const AccessApp = v.object({
  id: v.optional(v.string()),
  name: v.optional(v.string()),
  aud: v.optional(v.string()),
  type: v.optional(v.string()),
  domain: v.optional(v.string()),
  destinations: v.optional(v.array(v.object({
    type: v.optional(v.string()),
    uri: v.optional(v.string()),
    hostname: v.optional(v.string()),
  }))),
});

const AccessEnvelope = v.object({
  success: v.optional(v.boolean()),
  result: v.optional(v.nullable(v.array(AccessApp))),
  errors: v.optional(v.array(v.object({ message: v.optional(v.string()) }))),
});

const AccessPolicy = v.object({
  decision: v.optional(v.string()),
  include: v.optional(v.array(v.record(v.string(), v.unknown()))),
});

const AccessPolicyEnvelope = v.object({
  success: v.optional(v.boolean()),
  result: v.optional(v.nullable(v.array(AccessPolicy))),
  errors: v.optional(v.array(v.object({ message: v.optional(v.string()) }))),
});

const AccessOrganization = v.object({
  auth_domain: v.optional(v.string()),
});

const AccessOrganizationEnvelope = v.object({
  success: v.optional(v.boolean()),
  result: v.optional(v.nullable(AccessOrganization)),
  errors: v.optional(v.array(v.object({ message: v.optional(v.string()) }))),
});

/**
 * An Access application, in the only shape this file reads it.
 *
 * A named interface rather than an inferred one because it is the argument type
 * of the three exported RULES below, and those rules are the part of this file
 * with a test: the shape they take is a contract, and a contract spelled
 * `v.InferOutput<typeof …>` couples every caller to a parser's local name.
 */
export interface AccessApplicationView {
  readonly id?: string;
  readonly name?: string;
  readonly aud?: string;
  readonly type?: string;
  readonly domain?: string;
  readonly destinations?: readonly {
    readonly type?: string;
    readonly uri?: string;
    readonly hostname?: string;
  }[];
}

/** Every destination an application protects, normalized to `host/path`. An
 *  application with neither field protects nothing nameable, and saying so beats
 *  reading it as covering everything or nothing. */
export function accessDestinations(app: AccessApplicationView): readonly string[] {
  const fromList = (app.destinations ?? [])
    // `type` is `public` for an internet-facing hostname and `private` for a
    // network destination. A private destination protects an IP range and cannot
    // cover an HTTP path on our host, so it is neither our coverage nor our
    // overreach.
    .filter((entry) => (entry.type ?? 'public') === 'public')
    .map((entry) => entry.uri ?? entry.hostname ?? '')
    .filter((uri) => uri.length > 0);
  const legacy = (app.domain ?? '').length > 0 ? [app.domain ?? ''] : [];
  return [...new Set([...fromList, ...legacy])].map((uri) => uri.replace(/^https?:\/\//u, ''));
}

/** The covering application, if any, and everything the AUD's applications
 *  actually cover — so a refusal can print what WAS protected. */
export interface AccessCoverage {
  readonly covering: AccessApplicationView | undefined;
  readonly destinations: readonly string[];
}

/**
 * Which application with `aud` covers every path in `paths` on `host`, and what
 * the applications with that AUD actually cover.
 *
 * A PURE RULE, separated from the fetch, because this is the part with a wrong
 * answer worth testing: Access destination semantics are prefix-based on the
 * pattern minus its trailing `*`, so a destination spelled `kinu.run/control`
 * with no star covers ONLY the exact path and leaves the SPA's own
 * `/control/users/x` unprotected. That distinction is one character wide and the
 * network cannot help decide it.
 */
export function accessCovering(
  apps: readonly AccessApplicationView[],
  host: string,
  aud: string,
  paths: readonly string[],
): AccessCoverage {
  const matches = apps.filter((app) => (app.aud ?? '') === aud);
  const covering = matches.find((app) => {
    const destinations = accessDestinations(app);
    return paths.every((path) => destinations.some((destination) =>
      destination.startsWith(`${host}${path.replace(/\*$/u, '')}`)
      && destination.endsWith('*')));
  });
  return { covering, destinations: matches.flatMap((app) => accessDestinations(app)) };
}

/**
 * Every Access destination that reaches beyond the control plane on this
 * deployment, named as `"<app>" → <destination>`.
 *
 * Empty means the negative assertion HOLDS. A PURE RULE for the same reason as
 * `accessCovering`, and a more important one: this is the check whose failure is
 * invisible in production — the admin plane works perfectly while every preview
 * URL has a corporate login in front of it — so it is the check that most needs
 * to be exercised somewhere other than a live account.
 *
 * A WILDCARD HOSTNAME IS OVERREACH WHATEVER ITS PATH. A preview URL is an
 * arbitrary path on an arbitrary label, so there is no narrowing of an Access
 * destination that makes gating `*.kinu.run` safe.
 */
export function accessOverreach(
  apps: readonly AccessApplicationView[],
  host: string,
  wildcards: readonly string[],
  paths: readonly string[],
): readonly string[] {
  const allowed = paths.map((path) => `${host}${path.replace(/\*$/u, '')}`);
  const found: string[] = [];
  for (const app of apps) {
    for (const destination of accessDestinations(app)) {
      const claimed = destination.replace(/\/.*$/u, '');
      const overreaching = claimed.startsWith('*.')
        ? wildcards.includes(claimed.slice(2))
        : claimed === host && !allowed.some((prefix) => destination.startsWith(prefix));
      if (overreaching) found.push(`"${app.name ?? app.id ?? '(unnamed)'}" → ${destination}`);
    }
  }
  return found;
}

/** One Access REST GET, parsed at this boundary. Returns the parsed envelope or
 *  the reason nothing could be read — never a partially-trusted body: a response
 *  this cannot parse is a response it must not draw a membership conclusion
 *  from. */
async function accessGet<TSchema extends v.GenericSchema>(
  path: string,
  schema: TSchema,
): Promise<{ readonly body: v.InferOutput<TSchema> } | { readonly failure: string }> {
  // KINU_ACCESS_API_TOKEN first, ON PURPOSE: wrangler honours BOTH generic
  // names (CLOUDFLARE_API_TOKEN and the legacy CF_API_TOKEN), so exporting the
  // Access-scoped token under either hijacks every wrangler subcommand this
  // verification also runs — measured: `wrangler vectorize list` refusing
  // under an Access-only token. A name wrangler never reads keeps the two
  // credentials apart.
  const token = (process.env['KINU_ACCESS_API_TOKEN']
    ?? process.env['CLOUDFLARE_API_TOKEN'] ?? process.env['CF_API_TOKEN'] ?? '').trim();
  if (token.length === 0) return { failure: ACCESS_TOKEN_HELP };
  const account = process.env['CLOUDFLARE_ACCOUNT_ID'] ?? declaredAccountId();
  if (account === undefined) {
    return { failure: 'no account id: neither CLOUDFLARE_ACCOUNT_ID nor `account_id` in wrangler.jsonc' };
  }
  let response: Response;
  try {
    response = await fetch(`https://api.cloudflare.com/client/v4/accounts/${account}${path}`, {
      headers: { authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(20_000),
    });
  } catch (error) {
    // A network failure and a timeout are both "nobody asked", which is `unknown`
    // upstream. Neither may be read as "the application does not exist".
    return { failure: `GET ${path} did not complete: ${error instanceof Error ? error.message : String(error)}` };
  }
  const text = await response.text();
  if (response.status === 403 || response.status === 401) {
    return { failure: `GET ${path} answered ${String(response.status)}. ${ACCESS_TOKEN_HELP}` };
  }
  if (!response.ok) return { failure: `GET ${path} answered ${String(response.status)}: ${text.slice(0, 200)}` };
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (error) {
    if (!(error instanceof SyntaxError)) throw error; // JSON.parse's only throw
    return { failure: `GET ${path} answered 200 with a body that is not JSON` };
  }
  const parsed = v.safeParse(schema, raw);
  return parsed.success
    ? { body: parsed.output }
    : { failure: `GET ${path} answered a body this cannot read: ${parsed.issues[0]?.message ?? 'unknown shape'}` };
}

/** Every Access application on the account, or the reason none could be read.
 *  Memoised for the run: four rows ask about the same list. */
let accessAppCache:
  | { readonly apps: readonly AccessApplicationView[] }
  | { readonly failure: string }
  | undefined;

async function accessApps(): Promise<
  { readonly apps: readonly AccessApplicationView[] } | { readonly failure: string }
> {
  if (accessAppCache !== undefined) return accessAppCache;
  const answer = await accessGet('/access/apps?per_page=1000', AccessEnvelope);
  accessAppCache = 'failure' in answer
    ? { failure: answer.failure }
    : { apps: answer.body.result ?? [] };
  return accessAppCache;
}

/**
 * Whether the account's Zero Trust organization is the one `teamDomain` names.
 *
 * The team domain is what this Worker pins as the token's `iss` and as the JWKS
 * origin, so an organization whose `auth_domain` is something else means the
 * Worker is pinned to an issuer that does not guard it — every assertion the real
 * gate mints would be rejected, and the admin plane would 404 its own operators.
 * A 404 from this endpoint is a real `absent`: the account has no organization.
 */
export async function accessOrganization(teamDomain: string): Promise<Observation> {
  if (teamDomain.length === 0) {
    return absent;
  }
  const answer = await accessGet('/access/organizations', AccessOrganizationEnvelope);
  if ('failure' in answer) {
    return answer.failure.includes('answered 404') ? absent : unknown(answer.failure);
  }
  const observed = (answer.body.result?.auth_domain ?? '').trim().toLowerCase();
  if (observed.length === 0) return absent;
  const wanted = teamDomain.replace(/^https?:\/\//u, '').replace(/\/+$/u, '').toLowerCase();
  return observed === wanted
    ? present(`Zero Trust organization ${observed}`)
    : { state: 'absent', detail: `the account's Zero Trust organization is ${observed}, but `
        + `CONTROL_PLANE_ACCESS_TEAM_DOMAIN names ${wanted}. The Worker pins the var as the `
        + 'token issuer, so as configured it would reject every assertion Access mints.' };
}

/**
 * Whether ONE Access application with `aud` covers every path in `paths` on
 * `host`.
 *
 * ONE application, not a set, and that is a property of Access rather than a
 * preference: the AUD is per application, the Worker pins exactly one AUD, and
 * two applications splitting the two paths would leave the Worker able to verify
 * tokens for one path and answering 404 on the other. The coverage rule itself is
 * `accessCovering` above, which has a test; this is the fetch and the wording.
 */
export async function accessApplication(
  host: string,
  aud: string,
  paths: readonly string[],
): Promise<Observation> {
  if (aud.length === 0) {
    return { state: 'absent', detail: 'CONTROL_PLANE_ACCESS_AUD is empty in this environment, so '
      + 'no Access application is named and the Worker can verify nothing' };
  }
  const listed = await accessApps();
  if ('failure' in listed) return unknown(listed.failure);
  const { covering, destinations } = accessCovering(listed.apps, host, aud, paths);
  if (covering !== undefined) {
    return present(`${covering.type ?? 'unknown type'} application `
      + `"${covering.name ?? covering.id ?? aud}" covers ${accessDestinations(covering).join(', ')}`);
  }
  if (destinations.length === 0) {
    return { state: 'absent', detail: `no Access application on this account has aud ${aud}` };
  }
  return { state: 'absent', detail: `the application(s) with aud ${aud} cover `
    + `${destinations.join(', ')} — one of them must cover `
    + `${paths.map((path) => `${host}${path}`).join(' and ')}, both in the SAME application, `
    + 'because the Worker pins one AUD' };
}

/**
 * Whether that application has an Allow policy that names somebody.
 *
 * BOTH DEGENERATE SHAPES FAIL, and they fail for opposite reasons. No Allow
 * policy at all: Access applications are deny-by-default, so the application
 * admits nobody and the admin plane is unreachable. An Allow policy whose
 * `include` list is empty: it matches every identity the organization can
 * authenticate, so the outer gate admits everyone and the only thing left
 * standing is the allowlist this change exists to stop relying on alone.
 */
export async function accessPolicies(host: string, aud: string): Promise<Observation> {
  if (aud.length === 0) return absent;
  const listed = await accessApps();
  if ('failure' in listed) return unknown(listed.failure);
  const app = listed.apps.find((entry) => (entry.aud ?? '') === aud);
  if (app?.id === undefined) {
    return { state: 'absent', detail: `no Access application with aud ${aud} to read policies from` };
  }
  const answer = await accessGet(`/access/apps/${app.id}/policies`, AccessPolicyEnvelope);
  if ('failure' in answer) return unknown(answer.failure);
  const policies = answer.body.result ?? [];
  const allows = policies.filter((policy) => (policy.decision ?? '') === 'allow');
  if (allows.length === 0) {
    return { state: 'absent', detail: `the application protecting ${host} has `
      + `${String(policies.length)} policy/policies and none of them is an Allow — Access is `
      + 'deny-by-default, so it admits nobody' };
  }
  const named = allows.filter((policy) => (policy.include ?? []).length > 0);
  if (named.length === 0) {
    return { state: 'absent', detail: 'every Allow policy on this application has an EMPTY '
      + 'include rule, which matches every identity the organization can authenticate — the '
      + 'outer gate would admit everyone' };
  }
  return present(`${String(named.length)} Allow policy/policies naming identities`);
}

/**
 * Whether Access is confined to the control-plane paths — the NEGATIVE assertion.
 *
 * `present` means the property HOLDS: no application on the account covers this
 * environment's app host beyond `paths`, and none covers any of its wildcard
 * hostnames at all. `absent` means one does, and NAMES it, because which
 * application is over-broad is the entire actionable content of the finding — a
 * static manual step written before the run cannot say it. The rule is
 * `accessOverreach` above, which has a test; this is the fetch and the wording.
 */
export async function accessScope(
  host: string,
  wildcards: readonly string[],
  paths: readonly string[],
): Promise<Observation> {
  const listed = await accessApps();
  if ('failure' in listed) return unknown(listed.failure);
  const overreaching = accessOverreach(listed.apps, host, wildcards, paths);
  if (overreaching.length > 0) {
    return { state: 'absent', detail: 'Access covers more than the control plane: '
      + `${overreaching.join('; ')}. Every request to those paths is redirected to an `
      + 'interactive Access login before this Worker sees it.' };
  }
  return present(`${String(listed.apps.length)} Access application(s) on the account, none `
    + `covering ${host} outside ${paths.join(' / ')}`
    + (wildcards.length === 0 ? '' : ` and none covering ${wildcards.map((w) => `*.${w}`).join(' or ')}`));
}

/* ── Email routing ────────────────────────────────────────────────────── */

/**
 * Whether any Email Routing rule on `zone` delivers to `workerName`.
 *
 * `wrangler email routing rules list` prints a human table, not JSON, so the
 * `Actions:  worker:<name>` line is read directly. Measured against the live
 * zone on 2026-08-18: three rules, all pointing at a different Worker, and a
 * catch-all that forwards to a mailbox — which is why the Mission Inbox receives
 * nothing today while every binding it needs is present.
 */
export function emailRoutingToWorker(zone: string, workerName: string): Observation {
  const run = wrangler(['email', 'routing', 'rules', 'list', zone]);
  if (!run.ok) {
    const complaint = why(run);
    return /not enabled|not found|Email Routing/iu.test(complaint) && /not/iu.test(complaint)
      ? absent
      : unknown(`\`wrangler email routing rules list ${zone}\` failed: ${complaint}`);
  }
  const matchers = run.stdout
    .split('\n')
    .filter((line) => line.includes(`worker:${workerName}`));
  return matchers.length > 0
    ? present(`${String(matchers.length)} rule(s) deliver to ${workerName}`)
    : absent;
}

/** Whether wrangler holds a usable session at all. Every other observation here
 *  is meaningless without one, so it is asked first and separately. */
export function authenticated(): Observation {
  const run = wrangler(['whoami'], 60_000);
  return run.ok ? present('wrangler session valid') : unknown(`\`wrangler whoami\` failed: ${why(run)}`);
}

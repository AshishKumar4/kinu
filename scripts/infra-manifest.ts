/**
 * The infrastructure inventory, DERIVED from `packages/cf-backend/wrangler.jsonc`
 * and `packages/cf-backend/env.d.ts`.
 *
 * WHY IT IS DERIVED AND NOT WRITTEN DOWN. Every hand-maintained mirror in this
 * repository has drifted from the thing it mirrors — the ladder's rule count, the
 * skip list, the CI suite list, `SCRATCH_PREFIXES`. A second list of "what
 * production is made of", typed beside the binding manifest that already declares
 * it, would drift the same way and would drift silently, because nothing fails
 * when an inventory is short by one bucket. So there is one list: wrangler.jsonc,
 * read here.
 *
 * WHAT IS DECLARED RATHER THAN DERIVED, and why each one has to be:
 *
 *   - `UNCAPTURED`. Dependencies production has that the binding manifest cannot
 *     express at all — an AI Gateway that exists only as a substring of a URL, a
 *     DNS record wrangler cannot even read, an OAuth application on somebody
 *     else's website. These are the ones that make a fresh account fail, and no
 *     amount of parsing finds them. Each entry carries the evidence it was
 *     established with and the command that re-checks it.
 *   - `SUPPLY`. What must happen for each value the Worker reads that the
 *     manifest does NOT supply: generate it, prompt for it, or get it out of
 *     band. That is a judgement about a secret and it must not be guessed, so it
 *     is written down and PINNED BY EQUALITY against the derived census — a new
 *     field in `Env` fails the gate until somebody classifies it.
 *   - `UNOBSERVABLE`. Resources no CLI path can confirm. Also pinned: an
 *     unobservable resource missing from this map fails the gate, and an entry
 *     here that turns out to be observable fails it too, so the list can only
 *     shrink.
 *
 * REQUIREDNESS is derived where it can be. `env.d.ts` marks the bindings the
 * Worker tolerates the absence of with a `?`, and that is the Worker's own
 * statement about what it needs, so a resource's requiredness comes from its
 * binding's optionality. Resources with no binding — a route, a cron trigger —
 * are required exactly where the manifest declares them, because nobody declares
 * a route they do not want. Secrets are the exception and take their requiredness
 * from `SUPPLY`: `CREDENTIAL_ENCRYPTION_KEY` is `?` in `Env` (the Worker answers
 * 503 rather than crashing) while a deployment without it cannot serve a
 * signed-in user at all.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import * as v from 'valibot';
import { parseJsonc } from './jsonc';

const REPO = new URL('..', import.meta.url).pathname;

export const WRANGLER_CONFIG = 'packages/cf-backend/wrangler.jsonc';
export const ENV_TYPES = 'packages/cf-backend/env.d.ts';
/** Where the Vectorize index's geometry actually lives — see `vectorizeGeometry`. */
export const EMBEDDER_SOURCE = 'packages/cf-backend/src/runtime.ts';

/* ── The binding manifest ─────────────────────────────────────────────── */

/** Only the keys the inventory is built from. `v.object` ignores the rest, and a
 *  key present but wrongly shaped fails the parse rather than being read as
 *  absent — a config this cannot read is not a config it may certify. */
const EnvironmentSchema = v.object({
  name: v.optional(v.string()),
  account_id: v.optional(v.string()),
  routes: v.optional(v.array(v.object({
    pattern: v.string(),
    custom_domain: v.optional(v.boolean()),
    zone_name: v.optional(v.string()),
    zone_id: v.optional(v.string()),
  }))),
  assets: v.optional(v.object({ binding: v.string(), directory: v.string() })),
  durable_objects: v.optional(v.object({
    bindings: v.array(v.object({ name: v.string(), class_name: v.string() })),
  })),
  containers: v.optional(v.array(v.object({
    class_name: v.string(),
    image: v.string(),
    max_instances: v.optional(v.number()),
  }))),
  migrations: v.optional(v.array(v.object({
    tag: v.string(),
    new_sqlite_classes: v.optional(v.array(v.string())),
    new_classes: v.optional(v.array(v.string())),
    deleted_classes: v.optional(v.array(v.string())),
  }))),
  triggers: v.optional(v.object({ crons: v.array(v.string()) })),
  vars: v.optional(v.record(v.string(), v.string())),
  send_email: v.optional(v.array(v.object({ name: v.string() }))),
  ai: v.optional(v.object({ binding: v.string() })),
  worker_loaders: v.optional(v.array(v.object({ binding: v.string() }))),
  r2_buckets: v.optional(v.array(v.object({ binding: v.string(), bucket_name: v.string() }))),
  kv_namespaces: v.optional(v.array(v.object({
    binding: v.string(),
    id: v.string(),
  }))),
  vectorize: v.optional(v.array(v.object({ binding: v.string(), index_name: v.string() }))),
});

const WranglerConfigSchema = v.object({
  ...EnvironmentSchema.entries,
  env: v.optional(v.record(v.string(), EnvironmentSchema)),
});

type WranglerEnvironment = v.InferOutput<typeof EnvironmentSchema>;

/* ── The shapes ───────────────────────────────────────────────────────── */

export type ResourceKind =
  | 'account' | 'kv' | 'r2' | 'vectorize' | 'ai-gateway'
  | 'worker' | 'durable-object' | 'container' | 'custom-domain' | 'zone-route'
  | 'wildcard-dns' | 'dns-record' | 'cron' | 'binding' | 'email-routing';

/** How a resource comes into existence. This is the whole of provision's plan
 *  and the whole of teardown's: `wrangler-cli` is what provision creates,
 *  `wrangler-deploy` is what `bun run deploy` creates and provision must NOT,
 *  and `manual` is what no program here can do and must therefore be said out
 *  loud rather than skipped — a silently-skipped resource is how the assetless
 *  deploy shipped. */
export type Origin = 'precondition' | 'wrangler-cli' | 'wrangler-deploy' | 'manual';

export interface BindingRef {
  readonly environment: string;
  readonly binding: string;
}

export interface Resource {
  /** Stable and dotted: `r2.kinu-backups`. The id every report keys on. */
  readonly id: string;
  readonly kind: ResourceKind;
  /** The cloud-side name, as the platform knows it. */
  readonly name: string;
  readonly origin: Origin;
  /** WHAT IS INSIDE IT. Defined ⇒ data-bearing ⇒ named in teardown's prompt.
   *  `undefined` ⇒ deleting it loses no state. Spelled `| undefined` rather than
   *  optional throughout this interface: "this resource holds nothing" is a real
   *  answer and every construction site has to give one. */
  readonly holds: string | undefined;
  /** wrangler argv (without the `wrangler` word) that creates it. */
  readonly create: readonly string[] | undefined;
  /** wrangler argv that destroys it. `undefined` ⇒ teardown must not try. */
  readonly destroy: readonly string[] | undefined;
  /** What a human must do, for `manual` origins. */
  readonly manual: string | undefined;
  /** Every environment/binding pair that references it. Empty for routes, crons
   *  and the account. A resource referenced by two environments must not be
   *  torn down with one of them — see `exclusiveTo`. */
  readonly boundBy: readonly BindingRef[];
  readonly environments: readonly string[];
  /** False ⇒ the Worker states it tolerates the absence (a `?` in `Env`), so a
   *  missing one is a reported capability loss rather than a gate failure. */
  readonly required: boolean;
  /** Why it matters, in one line, for the report. */
  readonly purpose: string;
}

export interface InfraEnvironment {
  /** `production` for the top-level (unnamed) section, else the `env.*` key. */
  readonly key: string;
  readonly workerName: string;
  /** The `--env` flag value wrangler needs, `undefined` for the top-level
   *  section — which is what wrangler itself means by no flag at all. */
  readonly wranglerEnv: string | undefined;
  readonly vars: ReadonlyMap<string, string>;
  readonly migrationTags: readonly string[];
  /** Every binding name this environment declares, whatever its kind. */
  readonly bindings: readonly string[];
}

export interface Infrastructure {
  readonly accountId: string;
  readonly environments: readonly InfraEnvironment[];
  readonly resources: readonly Resource[];
}

/* ── env.d.ts ─────────────────────────────────────────────────────────── */

export interface EnvField {
  readonly name: string;
  /** `?` in the declaration: the Worker states it can run without this. */
  readonly optional: boolean;
  readonly type: string;
}

/**
 * The `Env` members, read out of `env.d.ts`.
 *
 * A brace-counted slice of `interface Env {` rather than a full parse: the file
 * is one interface inside one `declare global`, and the members are one per line.
 * A member line that does not parse is a THROW, not a skip — this list is the
 * denominator for "every secret the Worker reads", and a census that quietly
 * drops the line it could not read reports the healthiest possible number.
 */
export function envFields(source = readFileSync(join(REPO, ENV_TYPES), 'utf8')): readonly EnvField[] {
  const start = source.indexOf('interface Env {');
  if (start === -1) throw new Error(`${ENV_TYPES}: no \`interface Env {\` — the Env census has no denominator`);
  let depth = 0;
  let end = start;
  for (let i = source.indexOf('{', start); i < source.length; i += 1) {
    const char = source[i];
    if (char === '{') depth += 1;
    else if (char === '}') {
      depth -= 1;
      if (depth === 0) { end = i; break; }
    }
  }
  const body = source.slice(source.indexOf('{', start) + 1, end);
  const fields: EnvField[] = [];
  let inComment = false;
  for (const raw of body.split('\n')) {
    const line = raw.trim();
    if (inComment) {
      if (line.includes('*/')) inComment = false;
      continue;
    }
    if (line.startsWith('/*')) {
      if (!line.includes('*/')) inComment = true;
      continue;
    }
    if (line.length === 0 || line.startsWith('//') || line.startsWith('*')) continue;
    const member = /^(\w+)(\??):\s*(.+);$/u.exec(line);
    if (member === null) throw new Error(`${ENV_TYPES}: cannot read Env member \`${line}\``);
    fields.push({ name: member[1] ?? '', optional: member[2] === '?', type: member[3] ?? '' });
  }
  return fields;
}

/* ── What the manifest cannot express ─────────────────────────────────── */

export interface Uncaptured {
  readonly what: string;
  /** How this was established. Everything here was measured against the live
   *  account on 2026-08-18, because a list of invisible dependencies compiled
   *  from reading alone is a list of guesses. */
  readonly evidence: string;
  /** The command that re-checks it. */
  readonly check: string;
}

/**
 * Dependencies production has that `wrangler.jsonc` does not and cannot declare.
 *
 * This is the most valuable half of the inventory and the reason a fresh account
 * cannot be stood up from the manifest alone. Every entry was verified against
 * the live account rather than inferred.
 */
export const UNCAPTURED: readonly Uncaptured[] = [
  {
    what: 'The Cloudflare account itself, and a Workers PAID plan. Durable Objects with '
      + 'SQLite storage, Containers, `worker_loaders` and 7-day Workers Logs retention are all '
      + 'plan-gated; `account_id` names an account the manifest assumes already exists and '
      + 'already pays.',
    evidence: 'no field in wrangler.jsonc states a plan, and no wrangler command reports or '
      + 'changes one.',
    check: 'npx wrangler whoami',
  },
  {
    what: 'The AI Gateway named `kinu-ai-gateway`. It exists only as a substring of the '
      + '`AI_GATEWAY_URL` var — no binding, no config key, nothing typed.',
    evidence: 'wrangler 4.97 has no `ai-gateway` command (measured against `wrangler --help`), '
      + 'and the wrangler OAuth session carries no `aig` scope, so '
      + '`GET /accounts/<id>/ai-gateway/gateways` answers 403 code 10000 — the gateway can be '
      + 'neither created nor read by anything in this repository.',
    check: 'https://dash.cloudflare.com/?to=/:account/ai/ai-gateway',
  },
  {
    what: "The Vectorize indexes' GEOMETRY. `wrangler.jsonc` names `kinu-memory` and "
      + '`kinu-memory-staging` and stops there; creating an index needs `--dimensions` and '
      + '`--metric`, and one created at the wrong dimension count accepts the binding and '
      + 'rejects every insert.',
    evidence: 'the dimension is a literal in the embedder construction in '
      + `${EMBEDDER_SOURCE} and the metric appears only in a wrangler.jsonc COMMENT. `
      + '`vectorizeGeometry()` reads the dimension back out of the embedder rather than '
      + 'restating it, so the two cannot drift.',
    check: 'npx wrangler vectorize list',
  },
  {
    what: 'The proxied DNS records the `pattern + zone_name` routes need. Production takes a '
      + 'wildcard `*` record for every preview hostname; staging takes a single `staging` '
      + 'record for its own origin. A route matches a request that arrives — it does not make '
      + 'the hostname resolve, so without the records every preview URL and the whole staging '
      + 'deployment are NXDOMAIN while both routes read as present.',
    evidence: 'wrangler has no DNS command at all, and the zone DNS API answers 403 code 10000 '
      + 'under the wrangler OAuth token — so this is invisible to every credential a deploy has. '
      + 'Verification here resolves a hostname against each record instead.',
    check: 'dig +short probe.kinu.run staging.kinu.run',
  },
  {
    what: 'The ZONE. `zone_name: "kinu.run"` assumes a zone already on the account, already '
      + 'active, and already the one the custom domain lands in. Nothing here creates it and '
      + 'nothing checks it is the right one.',
    evidence: 'verified against the API on 2026-08-20 — zone 6c181c0cb19bef416fcc7f1fef7f6993, '
      + 'active since 2026-08-18, on the same account as the Worker '
      + '(f44999d1ddda7012e9a87729eba250f1), which a custom domain requires rather than merely '
      + 'prefers, and holding ZERO DNS records, so every record this deployment needs is '
      + 'created rather than contended. Universal SSL covers `kinu.run` and `*.kinu.run` — the '
      + 'app host, every preview host and staging — so no Advanced Certificate Manager is '
      + 'needed. A preview suffix one label deeper would need one.',
    check: 'npx wrangler email routing list',
  },
  {
    what: 'Email Routing onboarding for the Mission Inbox: MX records, a verified destination '
      + 'address, and a rule that delivers mail for `EMAIL_DOMAIN` to this Worker. The '
      + '`send_email` binding covers OUTBOUND only, and Email Sending is a separate onboarding '
      + 'step on the same zone.',
    evidence: 'measured 2026-08-20 — `kinu.run` carries this product and nothing else, and held '
      + 'no DNS records at all, so there are no MX records, no destination address and no '
      + 'rules: inbound agent mail does not arrive today even though the binding, the var and '
      + 'the `email()` handler are all present and correct. Nothing else on the zone competes '
      + 'for its mail, so the catch-all is free to deliver everything to this Worker.',
    check: 'npx wrangler email routing rules list kinu.run',
  },
  {
    what: 'The OAuth applications at Google, GitHub and Cloudflare — client ids, client secrets '
      + 'and the exact redirect URLs, which name `https://kinu.run`. Created on three other '
      + 'websites, outside Cloudflare entirely.',
    evidence: 'docs/DEPLOYMENT.md § OAuth Setup lists the redirect URLs and the Cloudflare '
      + 'scope set. Secrets are per-Worker and this Worker name has never been deployed, so it '
      + 'carries none: /login offers no provider at all until the Cloudflare client secret is '
      + 'installed.',
    check: 'npx wrangler secret list --format json',
  },
  {
    what: 'The sandbox container image being pullable, and equal to the `@cloudflare/sandbox` '
      + 'version in packages/cf-backend/package.json. The SDK asks the container for its own '
      + 'SANDBOX_VERSION on every start.',
    evidence: 'a container application is named after its Worker and class — '
      + '`kinu-kinusandbox` and `kinu-staging-kinusandbox-staging` — and neither exists '
      + 'until that environment is deployed. The image is reconciled only by a deploy OF THAT '
      + 'ENVIRONMENT, so a version bump lands in one environment and not the other until both '
      + 'are deployed, and Sandbox.checkVersionCompatibility logs the mismatch at container '
      + 'start rather than failing the deploy.',
    check: 'npx wrangler containers list --json',
  },
  {
    what: 'An R2 lifecycle rule on the `backups/` prefix of each backup bucket. The '
      + 'wrangler.jsonc comment asks for one; the Sandbox SDK enforces snapshot TTL at restore '
      + 'time only and never deletes anything, so without the rule a bucket grows without bound.',
    evidence: 'lifecycle rules are not expressible in wrangler.jsonc — they are a per-bucket '
      + 'setting reached through `wrangler r2 bucket lifecycle`.',
    check: 'npx wrangler r2 bucket lifecycle list kinu-backups',
  },
  {
    what: 'The KV namespace TITLES. `wrangler.jsonc` binds AUTH_KV by namespace id, and the '
      + '`kv_namespaces` block has no title field at all — so `kinu-auth` and '
      + '`kinu-auth-staging`, the names an operator reads and types, exist only in the account '
      + 'and in the command that created them.',
    evidence: 'a `kv_namespaces` entry carries `binding`, `id`, `preview_id` and `remote` and '
      + 'nothing else (wrangler/config-schema.json), while `wrangler kv namespace list` returns '
      + 'id and title together — which is how verification reports a title for a namespace the '
      + 'manifest can only name by id. Titles are also not unique per account, so a title is '
      + 'not a thing anything may key on.',
    check: 'npx wrangler kv namespace list',
  },
];

/* ── What no CLI path can confirm ─────────────────────────────────────── */

/**
 * Resources verification cannot observe, by resource id, each with the manual
 * check. PINNED BY EQUALITY: an unobservable resource absent from this map fails
 * the gate, and an entry that becomes observable fails it too. A blind spot that
 * is not in a list is indistinguishable from a pass.
 */
export const UNOBSERVABLE = new Map<string, string>([
  ['cron.kinu */15 * * * *',
    'wrangler 4.97 can WRITE a Worker\'s triggers (`wrangler triggers deploy`) and has no command '
    + 'that reads them back; `deployments status` and `versions view` carry bindings and no '
    + 'schedule. `wrangler deploy` sets it from `triggers.crons` on every deploy, so it is '
    + 'reconciled rather than drifting — but nothing here can say so. Check it in the dashboard '
    + 'under the Worker\'s Settings → Triggers, or by watching for a MonitorDO probe within 15 '
    + 'minutes of a deploy.'],
  ['ai-gateway.kinu-ai-gateway',
    'wrangler 4.97 exposes no `ai-gateway` command and the wrangler OAuth session has no `aig` '
    + 'scope (403 code 10000 against the REST API, measured 2026-08-18). Check it in the '
    + 'dashboard: https://dash.cloudflare.com/?to=/:account/ai/ai-gateway'],
]);

/* ── Supplying what the manifest does not ─────────────────────────────── */

/**
 * There is deliberately no `generate` arm. The only value this repository could
 * mint unattended is CREDENTIAL_ENCRYPTION_KEY, and a root secret the program
 * invents and never shows anyone is a secret nobody can restore from — losing it
 * means every user reconnects every provider. So minting it is a `prompt`: the
 * operator is present, and the value is displayed exactly once.
 */
export type Handling =
  /** provision must ask a human, at a terminal, and cannot proceed without one. */
  | 'prompt'
  /** it exists somewhere else entirely and has to be fetched before starting. */
  | 'out-of-band'
  /** not a secret: a plain value that belongs in `vars`, whose absence turns a
   *  feature off rather than breaking the Worker. */
  | 'config-var';

export interface Supply {
  readonly handling: Handling;
  /** True ⇒ a deployment without it is broken, whatever `Env`'s `?` says. */
  readonly required: boolean;
  /** When present, requiredness is DERIVED per environment instead: this value
   *  is required exactly where that `vars` key is set. It is the rule
   *  wrangler.jsonc already states — a provider appears on /login only when both
   *  its CLIENT_ID var and its CLIENT_SECRET secret exist — so staging, which
   *  configures no OAuth provider, is not held to production's secret set. */
  readonly pairedWith?: string;
  /** What happens when it is absent. The sentence the report prints. */
  readonly absent: string;
  /** Where the value comes from, for `prompt` and `out-of-band`. */
  readonly source?: string;
}

/**
 * Every value the Worker reads that neither a binding nor a `vars` entry
 * supplies, and what has to happen for it to exist.
 *
 * PINNED BY EQUALITY against `supplyCensus()`. A new field in `Env` that the
 * manifest does not supply fails the gate until it is classified here, which is
 * the whole point: `NIMBUS_RUNTIME_CACHE` was declared a `string` for months
 * while being an R2 bucket, and the way that survives is by nobody ever having
 * to write down what supplies a name.
 */
export const SUPPLY = new Map<string, Supply>([
  ['CREDENTIAL_ENCRYPTION_KEY', {
    handling: 'prompt',
    required: true,
    absent: 'no sign-in, no CLI, no stored credential — every signed-in surface answers 503 '
      + 'while public routes keep answering 200, so the site looks healthy. `Env` marks it `?` '
      + 'because the Worker degrades instead of crashing; a deployment without it is broken.',
    source: 'generated at the prompt (32 random bytes, base64) or pasted from the operator\'s '
      + 'password manager. It is displayed exactly once, because Cloudflare cannot show it '
      + 'again and losing it means every user reconnects every provider.',
  }],
  ['CREDENTIAL_ENCRYPTION_KEY_PREVIOUS', {
    handling: 'out-of-band',
    required: false,
    absent: 'nothing — this is the read-only side of a key rotation and is set only during one.',
    source: 'the outgoing CREDENTIAL_ENCRYPTION_KEY, during a rotation. See docs/DEPLOYMENT.md.',
  }],
  ['GOOGLE_OAUTH_CLIENT_SECRET', {
    handling: 'prompt',
    pairedWith: 'GOOGLE_OAUTH_CLIENT_ID',
    required: false,
    absent: 'Google does not appear on /login. Absent on production today.',
    source: 'https://console.cloud.google.com — OAuth 2.0 Client ID, redirect '
      + '`<origin>/auth/google/callback`.',
  }],
  ['GITHUB_OAUTH_CLIENT_SECRET', {
    handling: 'prompt',
    pairedWith: 'GITHUB_OAUTH_CLIENT_ID',
    required: false,
    absent: 'GitHub does not appear on /login. Absent on production today.',
    source: 'https://github.com/settings/developers — OAuth App, callback '
      + '`<origin>/auth/github/callback`.',
  }],
  ['CLOUDFLARE_OAUTH_CLIENT_SECRET', {
    handling: 'prompt',
    pairedWith: 'CLOUDFLARE_OAUTH_CLIENT_ID',
    required: true,
    absent: 'the primary model path is gone: `workers-ai` and `my-gateway` both ride the '
      + "signed-in user's own Cloudflare OAuth token, so without this every user's chat falls "
      + 'back to the platform `ai-gateway` provider and bills the PLATFORM account.',
    source: 'https://dash.cloudflare.com/?to=/:account/api-tokens — OAuth client with grant '
      + 'types `Authorization Code, Refresh Token` and the scope set in docs/DEPLOYMENT.md.',
  }],
  ['GOOGLE_OAUTH_CLIENT_ID', {
    handling: 'config-var',
    required: false,
    absent: 'Google does not appear on /login. Belongs in `vars`, beside its secret.',
    source: 'the same Google OAuth client as the secret above.',
  }],
  ['GOOGLE_OAUTH_SCOPES', {
    handling: 'config-var',
    required: false,
    absent: 'nothing — an override for the provider default.',
  }],
  ['GITHUB_OAUTH_CLIENT_ID', {
    handling: 'config-var',
    required: false,
    absent: 'GitHub does not appear on /login. Belongs in `vars`, beside its secret.',
    source: 'the same GitHub OAuth app as the secret above.',
  }],
  ['GITHUB_OAUTH_SCOPES', {
    handling: 'config-var',
    required: false,
    absent: 'nothing — an override for the provider default.',
  }],
  ['CLOUDFLARE_OAUTH_SCOPES', {
    handling: 'config-var',
    required: false,
    absent: 'nothing — CLOUDFLARE_WORKERS_AI_SCOPES in lib/cloudflare-oauth.ts is the one source '
      + 'of truth and this only overrides it.',
  }],
  ['R2_ACCESS_KEY_ID', {
    handling: 'out-of-band',
    required: false,
    absent: 'sandbox snapshots move through the BACKUP_BUCKET binding and restore by EXTRACTING '
      + 'the archive — correct, and a full pass over every byte. Present (all four together) '
      + 'switches to presigned URLs and a copy-on-write MOUNT.',
    source: 'an R2 API token from the Cloudflare dashboard. Not mintable by wrangler.',
  }],
  ['R2_SECRET_ACCESS_KEY', {
    handling: 'out-of-band',
    required: false,
    absent: 'see R2_ACCESS_KEY_ID — the four presigned-mode values are all-or-nothing.',
    source: 'the same R2 API token.',
  }],
  ['BACKUP_BUCKET_NAME', {
    handling: 'config-var',
    required: false,
    absent: 'see R2_ACCESS_KEY_ID. A plain var (`kinu-backups`), not a secret.',
  }],
  ['CLOUDFLARE_R2_ACCOUNT_ID', {
    handling: 'config-var',
    required: false,
    absent: 'see R2_ACCESS_KEY_ID. A plain var (the account id), not a secret.',
  }],
]);

/* ── Derivation ───────────────────────────────────────────────────────── */

/** The Vectorize dimension, read back out of the embedder that produces the
 *  vectors rather than restated here. An index created at the wrong dimension
 *  binds fine and rejects every insert, so the number has to come from the one
 *  place that decides it. Disagreeing call sites are a THROW: two embedders at
 *  different widths cannot both be right about one index. */
export interface VectorGeometry {
  readonly dimensions: number;
  readonly metric: string;
}

export function vectorizeGeometry(
  source = readFileSync(join(REPO, EMBEDDER_SOURCE), 'utf8'),
): VectorGeometry {
  const widths = new Set<string>();
  for (const [, width] of source.matchAll(/createWorkersAIEmbedder\([^)]*dimensions:\s*(\d+)/gu)) {
    widths.add(width ?? '');
  }
  if (widths.size !== 1) {
    throw new Error(
      `${EMBEDDER_SOURCE}: expected exactly one embedder width, found [${[...widths].join(', ')}]`
      + ' — the Vectorize index cannot be created at two dimensions',
    );
  }
  // `cosine` is not stated in code anywhere: bge vectors are unit-normalised, so
  // cosine and dot rank identically and the wrangler.jsonc comment settled on
  // cosine. Recorded in UNCAPTURED as a value the manifest does not carry.
  return { dimensions: Number([...widths][0]), metric: 'cosine' };
}

interface Draft {
  readonly kind: ResourceKind;
  readonly name: string;
  readonly origin: Origin;
  readonly purpose: string;
  readonly holds?: string;
  readonly create?: readonly string[];
  readonly destroy?: readonly string[];
  readonly manual?: string;
  readonly binding?: string;
  /** Overrides the `Env` optionality lookup, for resources with no binding. */
  readonly required?: boolean;
}

function environmentRow(key: string, topName: string, config: WranglerEnvironment): InfraEnvironment {
  const bindings = [
    ...(config.kv_namespaces ?? []).map((k) => k.binding),
    ...(config.r2_buckets ?? []).map((r) => r.binding),
    ...(config.vectorize ?? []).map((x) => x.binding),
    ...(config.durable_objects?.bindings ?? []).map((d) => d.name),
    ...(config.worker_loaders ?? []).map((w) => w.binding),
    ...(config.send_email ?? []).map((e) => e.name),
    ...(config.ai === undefined ? [] : [config.ai.binding]),
    ...(config.assets === undefined ? [] : [config.assets.binding]),
  ];
  return {
    key,
    workerName: config.name ?? topName,
    wranglerEnv: key === 'production' ? undefined : key,
    vars: new Map(Object.entries(config.vars ?? {})),
    migrationTags: (config.migrations ?? []).map((m) => m.tag),
    bindings,
  };
}

/** Everything one environment's section declares, before the cross-environment
 *  merge. Split out because the merge is where sharing becomes visible, and
 *  sharing is what makes a teardown dangerous. */
function draftsFor(
  environment: InfraEnvironment,
  config: WranglerEnvironment,
  geometry: VectorGeometry,
): readonly Draft[] {
  const worker = environment.workerName;
  const drafts: Draft[] = [];

  for (const namespace of config.kv_namespaces ?? []) {
    drafts.push({
      kind: 'kv',
      // The id, not the binding: both environments bind AUTH_KV, and calling
      // them one resource is how a staging teardown deletes production's.
      name: namespace.id,
      origin: 'manual',
      binding: namespace.binding,
      purpose: 'browser sessions, one-time OAuth state and CLI approval state — all of it '
        + 'expiring, none of it a source of truth',
      holds: 'every live session and every CLI approval in flight. Deleting it signs everyone '
        + 'out; it orphans nothing, because identities live in their own UserDO.',
      manual: 'run `wrangler kv namespace create <title>` and paste the id it prints into '
        + 'wrangler.jsonc. Not automated here: KV titles are not unique, so a second run makes '
        + 'a second namespace instead of finding the first. The titles this deployment uses are '
        + 'in UNCAPTURED — the config cannot carry them.',
      destroy: ['kv', 'namespace', 'delete', '--namespace-id', namespace.id, '-y'],
    });
  }

  for (const bucket of config.r2_buckets ?? []) {
    drafts.push({
      kind: 'r2',
      name: bucket.bucket_name,
      origin: 'wrangler-cli',
      binding: bucket.binding,
      purpose: bucket.binding === 'BACKUP_BUCKET'
        ? 'sandbox /workspace snapshots (squashfs archives)'
        : 'the Nimbus runtime artifact store a hosted workspace installs its toolchain from',
      holds: bucket.binding === 'BACKUP_BUCKET'
        ? 'every sandbox workspace snapshot. Deleting it makes every outstanding restore handle '
          + 'dangle.'
        : 'the seeded runtime catalog and content-addressed blobs (clang, python, ruby, bash, '
          + 'cpython). Deleting it makes every hosted `python3` exit 127.',
      create: ['r2', 'bucket', 'create', bucket.bucket_name],
      destroy: ['r2', 'bucket', 'delete', bucket.bucket_name],
    });
  }

  for (const index of config.vectorize ?? []) {
    drafts.push({
      kind: 'vectorize',
      name: index.index_name,
      origin: 'wrangler-cli',
      binding: index.binding,
      purpose: `semantic memory, ${String(geometry.dimensions)}-dim ${geometry.metric}`,
      holds: 'every embedded memory. Deleting it drops hybrid recall to FTS5-only until the '
        + 'index is rebuilt.',
      create: [
        'vectorize', 'create', index.index_name,
        `--dimensions=${String(geometry.dimensions)}`, `--metric=${geometry.metric}`,
      ],
      destroy: ['vectorize', 'delete', index.index_name, '-f'],
    });
  }

  drafts.push({
    kind: 'worker',
    name: worker,
    origin: 'wrangler-deploy',
    required: true,
    purpose: 'the Worker itself, with its assets, routes, crons and every binding above',
    holds: 'nothing of its own, but deleting it takes every Durable Object namespace below and '
      + 'ALL THEIR STORAGE with it.',
    destroy: ['delete', '--name', worker, '--force'],
  });

  for (const durable of config.durable_objects?.bindings ?? []) {
    drafts.push({
      kind: 'durable-object',
      name: `${worker}:${durable.class_name}`,
      origin: 'wrangler-deploy',
      binding: durable.name,
      purpose: `Durable Object namespace for class ${durable.class_name}`,
      holds: `every ${durable.class_name} instance's SQLite storage. There is no CLI that deletes `
        + 'one: a namespace goes away with its Worker, or with a `deleted_classes` migration.',
    });
  }

  for (const container of config.containers ?? []) {
    drafts.push({
      kind: 'container',
      name: `${worker}-${container.class_name.toLowerCase()}${environment.wranglerEnv === undefined ? '' : `-${environment.wranglerEnv}`}`,
      origin: 'wrangler-deploy',
      required: true,
      purpose: `container application for ${container.class_name}, image ${container.image}`,
    });
  }

  for (const route of config.routes ?? []) {
    if (route.custom_domain === true) {
      drafts.push({
        kind: 'custom-domain',
        name: route.pattern,
        origin: 'wrangler-deploy',
        required: true,
        purpose: 'the public origin. `custom_domain: true` makes wrangler create the DNS record '
          + 'on deploy.',
      });
      continue;
    }
    const host = route.pattern.replace(/^\*\./u, '').replace(/\/.*$/u, '');
    const wildcard = route.pattern.startsWith('*.');
    drafts.push({
      kind: 'zone-route',
      name: route.pattern,
      origin: 'wrangler-deploy',
      required: true,
      purpose: wildcard
        ? 'preview capability hostnames — one per exposed Workspace or Sandbox port'
        : `the ${host} origin, taken as a route rather than a custom domain so that an exact `
          + 'hostname outranks the wildcard route covering it',
    });
    // The route matches; it does not resolve. The record it needs is the single
    // most invisible prerequisite production has.
    if (wildcard) {
      drafts.push({
        kind: 'wildcard-dns',
        name: `*.${host}`,
        origin: 'manual',
        required: true,
        purpose: `the proxied wildcard record the ${route.pattern} route needs to resolve`,
        manual: `create a proxied wildcard DNS record for *.${host} on the zone. wrangler has no `
          + 'DNS command and cannot read the zone either — see UNCAPTURED.',
      });
      continue;
    }
    drafts.push({
      kind: 'dns-record',
      name: host,
      origin: 'manual',
      required: true,
      purpose: `the proxied record the ${route.pattern} route needs to resolve`,
      manual: `create a proxied DNS record for ${host} on the zone — any target, orange cloud `
        + 'on, because the route is what answers. `custom_domain: true` would create it and is '
        + 'deliberately not used: it would put this claim and the wildcard route on two '
        + 'mechanisms whose relative precedence Cloudflare documents only for identical '
        + 'hostnames. wrangler has no DNS command — see UNCAPTURED.',
    });
  }

  for (const cron of config.triggers?.crons ?? []) {
    drafts.push({
      kind: 'cron',
      name: `${worker} ${cron}`,
      origin: 'wrangler-deploy',
      required: true,
      purpose: 'synthetic monitoring — MonitorDO.check() probes the live origin on this schedule',
    });
  }

  const emailDomain = environment.vars.get('EMAIL_DOMAIN');
  if ((config.send_email ?? []).length > 0 && emailDomain !== undefined && emailDomain.length > 0) {
    // Email Routing is a ZONE feature and EMAIL_DOMAIN is a subdomain of one, so
    // the resource is keyed on the zone wrangler actually addresses. Taken from
    // the route's own `zone_name` when there is one — the manifest already names
    // the zone there and a second spelling would drift — and otherwise from the
    // last two labels, which is a guess and is labelled as one.
    const declaredZone = (config.routes ?? []).map((route) => route.zone_name)
      .find((zone): zone is string => zone !== undefined);
    const zone = declaredZone ?? emailDomain.split('.').slice(-2).join('.');
    drafts.push({
      kind: 'email-routing',
      name: zone,
      origin: 'manual',
      required: false,
      purpose: `Mission Inbox inbound: a rule on zone ${zone} delivering <agent>@${emailDomain} `
        + `to ${worker}`
        + (declaredZone === undefined ? ' (zone GUESSED from EMAIL_DOMAIN — no route declares one)' : ''),
      manual: `onboard ${emailDomain} to Email Routing on zone ${zone} and point a rule at worker `
        + `${worker} — see docs/EMAIL-INGRESS.md. The \`send_email\` binding is OUTBOUND only, so `
        + 'every binding can be present and correct while no mail ever arrives.',
    });
  }

  const gateway = /\/v1\/[^/]+\/([^/]+)\//u.exec(environment.vars.get('AI_GATEWAY_URL') ?? '');
  if (gateway !== null) {
    drafts.push({
      kind: 'ai-gateway',
      name: gateway[1] ?? '',
      origin: 'manual',
      required: true,
      purpose: 'the platform AI Gateway the `ai-gateway` provider transports through',
      manual: 'create the gateway in the dashboard, in the SAME account as the Worker — the AI '
        + 'binding resolves gateway names in-account only. wrangler cannot create it.',
    });
  }

  // Bindings that name no external resource: they exist iff the deployed Worker
  // carries them, which is exactly what verification reads back.
  const inert: readonly (readonly [string, string])[] = [
    ...(config.worker_loaders ?? []).map((w) => [w.binding, 'sandboxed code execution (codemode)'] as const),
    ...(config.ai === undefined ? [] : [[config.ai.binding, 'Workers AI — platform embeddings and the ai-gateway transport'] as const]),
    ...(config.assets === undefined ? [] : [[config.assets.binding, `static assets from ${config.assets.directory} — the SPA and the CLI downloads`] as const]),
    ...(config.send_email ?? []).map((e) => [e.name, 'outbound Mission Inbox replies and owner notifications'] as const),
  ];
  for (const [binding, purpose] of inert) {
    drafts.push({
      kind: 'binding',
      name: `${worker}:${binding}`,
      origin: 'wrangler-deploy',
      binding,
      purpose,
    });
  }

  return drafts;
}

/**
 * The whole inventory, merged across environments.
 *
 * Merging is the point of this function rather than a detail of it: both
 * environments bind `nimbus-runtime-cache`, so a teardown that treated resources
 * as per-environment would delete staging's runtime store along with production.
 * `boundBy` records every holder, and `exclusiveTo` is what teardown is allowed
 * to act on.
 */
export function deriveInfrastructure(
  configPath = WRANGLER_CONFIG,
  geometry = vectorizeGeometry(),
): Infrastructure {
  const config = parseJsonc(
    readFileSync(join(REPO, configPath), 'utf8'),
    WranglerConfigSchema,
    configPath,
  );
  const topName = config.name ?? 'worker';
  const environments = [
    environmentRow('production', topName, config),
    ...Object.entries(config.env ?? {}).map(([key, section]) => environmentRow(key, `${topName}-${key}`, section)),
  ];
  const sections: readonly (readonly [InfraEnvironment, WranglerEnvironment])[] = [
    [environments[0] ?? environmentRow('production', topName, config), config],
    ...Object.entries(config.env ?? {}).map(([key, section], index) =>
      [environments[index + 1] ?? environmentRow(key, `${topName}-${key}`, section), section] as const),
  ];

  const optionality = new Map(envFields().map((field) => [field.name, field.optional]));
  const merged = new Map<string, Resource>();
  for (const [environment, section] of sections) {
    for (const draft of draftsFor(environment, section, geometry)) {
      const id = `${draft.kind}.${draft.name}`;
      const previous = merged.get(id);
      const bindingRefs = draft.binding === undefined
        ? []
        : [{ environment: environment.key, binding: draft.binding }];
      merged.set(id, {
        id,
        kind: draft.kind,
        name: draft.name,
        origin: draft.origin,
        holds: draft.holds,
        create: draft.create,
        destroy: draft.destroy,
        manual: draft.manual,
        boundBy: [...(previous?.boundBy ?? []), ...bindingRefs],
        environments: [...(previous?.environments ?? []), environment.key],
        required: draft.required ?? (draft.binding === undefined
          ? true
          : optionality.get(draft.binding) !== true),
        purpose: draft.purpose,
      });
    }
  }

  return {
    accountId: config.account_id ?? '',
    environments,
    resources: [...merged.values()],
  };
}

/** Resources only `environment` references — the only ones a teardown of that
 *  environment may delete. A resource two environments bind is retained and
 *  named, never deleted with one of them. */
export function exclusiveTo(
  infrastructure: Infrastructure,
  environment: string,
): readonly Resource[] {
  return infrastructure.resources.filter((resource) =>
    resource.environments.includes(environment)
    && resource.environments.every((key) => key === environment));
}

/**
 * Whether a supplied value is required IN THIS ENVIRONMENT.
 *
 * `Supply.required` is the flat answer; `pairedWith` is the derived one, and it
 * exists because the flat answer was wrong for staging. Staging configures no
 * OAuth provider on purpose (it runs on `DEV_USER_EMAIL`), so demanding
 * production's OAuth secrets there would report a hole in a deployment that is
 * deliberately shaped that way — and a gate that cries about an intentional
 * absence teaches people to ignore it.
 */
export function requiredIn(name: string, environment: InfraEnvironment): boolean {
  const supply = SUPPLY.get(name);
  if (supply === undefined) return false;
  return supply.pairedWith === undefined
    ? supply.required
    : environment.vars.has(supply.pairedWith);
}

/** Env fields no binding and no `vars` entry supplies — the set `SUPPLY` must
 *  classify. Computed against the UNION of every environment's vars, because a
 *  value is not unsupplied merely for being absent from one of them. */
export function supplyCensus(infrastructure: Infrastructure): readonly EnvField[] {
  const supplied = new Set<string>();
  for (const environment of infrastructure.environments) {
    for (const binding of environment.bindings) supplied.add(binding);
    for (const key of environment.vars.keys()) supplied.add(key);
  }
  return envFields().filter((field) => !supplied.has(field.name));
}

/**
 * Product sources that read a supplied value. Zero means an operator is told to
 * obtain, install and rotate something nothing consumes.
 *
 * The needle is the NAME, not `env.<name>`, and that is a correction rather than
 * a shortcut: the first draft searched for `env.<name>` and reported seven live
 * values as dead, because this Worker reaches an environment value three
 * different ways — `env.CLOUDFLARE_OAUTH_CLIENT_SECRET` directly,
 * `const { R2_ACCESS_KEY_ID } = this.env` by destructuring, and
 * `providerFromEnv(env, 'google', 'GOOGLE_OAUTH_CLIENT_ID', …)` by handing the
 * key to a helper as a string. A census that knows only the first spelling
 * reports the healthiest possible number about the two it cannot see.
 */
export function readSites(name: string, sources: ReadonlyMap<string, string>): readonly string[] {
  return [...sources].filter(([, text]) => text.includes(name)).map(([file]) => file);
}

# Deployment

> Maintained by Claude (AI-edited documentation, presented as-is); verify against the code when precision matters.

## Live Instance

**Production:** https://kinu.run  
**Staging:** https://staging.kinu.run  
**Preview hosts:** one capability hostname per exposed Workspace or Sandbox port
under `<PREVIEW_HOST_SUFFIX>`

Previewed apps are agent-written HTML, so each exposed port gets a capability
hostname of its own. Sandbox uses the @cloudflare/sandbox SDK hostname. The
authoritative Workspace uses a Nimbus session capability bound into the same
preview-host trust boundary. The suffix needs a wildcard DNS record.
`PREVIEW_HOST_SUFFIX` below has the two steps, and
`packages/cf-backend/src/lib/preview-origin.ts` has the reasoning and the
remaining Public Suffix List prerequisite for complete cookie-site isolation.

### One origin per environment

Each environment has exactly one app origin. Production answers on `kinu.run`,
staging answers on `staging.kinu.run`, and `workers_dev` is false in both. So
`CLI_PUBLIC_ORIGIN` is the whole app-origin set rather than the preferred entry
in a larger one.

Transport security keys on that. The Worker redirects cleartext to HTTPS and
sends HSTS for the `CLI_PUBLIC_ORIGIN` host and for the preview subtree under
`PREVIEW_HOST_SUFFIX`. A hostname that reaches the Worker and is neither is not
an app origin, and the Worker does not serve it as one.

Production's preview suffix is `kinu.run` itself, so every preview host is a
strict subdomain of the app host. The wildcard route `*.kinu.run/*` therefore
matches previews and never the app. Staging leaves `PREVIEW_HOST_SUFFIX` empty,
because `staging.kinu.run` is not a wildcard parent, so staging serves no
previews.

Staging is bound as a ROUTE (`pattern: "staging.kinu.run"`, `zone_name:
"kinu.run"`) and not as a custom domain. Production's preview wildcard already
claims `*.kinu.run/*`, and an exact route beating a wildcard route is the only
precedence rule Cloudflare documents unambiguously.

## Local Development

### Prerequisites

- [Bun](https://bun.sh/) runtime
- Node.js 18+ (for Wrangler)
- A Cloudflare account (for AI Gateway)

### Setup

```bash
git clone https://github.com/AshishKumar4/Proteus.git
cd Proteus
bun install
```

### Web UI (Vite + Wrangler)

```bash
cd packages/cf-backend

# Create .dev.vars. The platform AI Gateway needs NO token: its transport is the
# Workers AI binding, which is pre-authenticated inside your own account.
cat > .dev.vars << EOF
AI_GATEWAY_URL=https://gateway.ai.cloudflare.com/v1/<account-id>/<gateway-name>/workers-ai/v1
CREDENTIAL_ENCRYPTION_KEY=$(openssl rand -base64 32)
EOF

# Start dev server (from repo root)
bun run dev
```

`bun run dev` runs `vite dev --host 0.0.0.0` in `packages/cf-backend`. Open
http://localhost:5173, which is Vite's default port and is not overridden. The
Vite cloudflare() plugin runs real Durable Objects locally through Miniflare.

That URL gets you the platform AI Gateway provider, billed to the account the
Worker runs in. The primary path bills models to the signed-in user's own
Cloudflare account, and for that you also need `CLOUDFLARE_OAUTH_CLIENT_ID` and
`CLOUDFLARE_OAUTH_CLIENT_SECRET` in `.dev.vars`. `DEV_USER_EMAIL` skips auth
entirely for headless work.

### CLI

```bash
curl -fsSL 'https://kinu.run/install.sh' | bash
kinu setup
kinu create jarvis --mode cloud --alias jarvis --purpose "A helpful coding assistant"
jarvis "summarize this checkout"
```

For a source checkout, use `bun run cli -- setup` and `bun run cli -- ...`.
The CLI app origin defaults to `https://kinu.run`. Use
`--origin` or `PROTEUS_ORIGIN` only for alternate deployments.

## Zero to production

Everything below assumes an EMPTY Cloudflare account. Three commands do the
work, and a fourth proves it:

```bash
bun run infra:provision      # the R2 buckets and the Vectorize indexes
bun run deploy               # the Worker, its DO namespaces, container, routes, cron
bun run infra:provision      # the secrets — `wrangler secret put` needs the Worker to exist
bun run gate:infra           # every declared resource exists and is bound
```

`wrangler secret put` refuses on a Worker that does not exist yet, so on a fresh
account the root secret can only be installed after the first deploy. That is
why provisioning runs twice. The first run says so rather than appearing to have
succeeded, and the second creates nothing the first created.

`bun run deploy` is the only supported production deploy path. Provisioning
creates the account-level resources the deploy binds, and never deploys anything
itself.

### Before you start

Provisioning cannot obtain any of these, and a fresh account fails without them.
`bun run infra:provision` prints the same list, every run, with the command that
re-checks each one.

| Prerequisite | Why nothing here can create it |
| --- | --- |
| A Cloudflare account on the **Workers Paid** plan | SQLite Durable Objects, Containers, `worker_loaders` and 7-day Workers Logs retention are all plan-gated. No wrangler command reports or changes a plan. |
| The `account_id`, in `packages/cf-backend/wrangler.jsonc` | It names the account. It does not create one. |
| A wrangler login (`npx wrangler login`) with Workers, KV, R2, Vectorize, Containers and Email scopes | Every command below rides it. `npx wrangler whoami` lists what you have. |
| The `kinu.run` **zone**, active on the account the Worker runs in | `zone_name` in `routes` assumes an active zone, and a Workers custom domain only lands in a zone that account holds. wrangler has no DNS command at all. |
| A proxied wildcard DNS record `*.kinu.run` | The `*.kinu.run/*` route matches preview requests. It does not make a preview hostname resolve. Without it every preview URL is NXDOMAIN while the route reads as present. `custom_domain: true` cannot express a wildcard, so this record is made by hand. |
| A proxied DNS record `staging.kinu.run` | Staging is bound as a route. A route matches requests to a hostname that already resolves; it does not create one. |
| Two **KV namespaces**, `kinu-auth` and `kinu-auth-staging` | The session store, one per environment. `wrangler kv namespace create <title>` prints an id you paste into `kv_namespaces`. Provisioning will not run it: KV titles are not unique, so a second run makes a second namespace instead of finding the first. |
| An **AI Gateway** in the same account, named in `AI_GATEWAY_URL` | wrangler has no `ai-gateway` command. Checked 2026-08-19 against both versions this tree installs, 4.97.0 at the root and 4.123.0 in `packages/cf-backend`: the only `ai-gateway` strings in either binary belong to the bundled REST client. The wrangler OAuth session also carries no `aig` scope, so the REST API answers 403. Dashboard only. |
| OAuth applications at Google, GitHub and/or Cloudflare | Created on three other websites. See § OAuth Setup for the exact redirect URLs and scopes. |
| Email Routing onboarding for `EMAIL_DOMAIN` | MX records, a verified destination, and a rule delivering to this Worker. The `send_email` binding is OUTBOUND only. See `docs/EMAIL-INGRESS.md`. |

Universal SSL on `kinu.run` covers `kinu.run` and `*.kinu.run`, which is the app
host, staging, and every preview host. No Advanced Certificate Manager is needed.

### What each command does

**`bun run infra:provision`** reads the inventory out of `wrangler.jsonc`. There
is no second list. It creates what is missing, in dependency order: the R2
buckets, then the Vectorize indexes. It prints `CREATED` or `existed` per
resource, so a second run is visibly a no-op. A resource whose lookup FAILED is
refused rather than created, because "the network was down" and "it does not
exist" are different states, and creating a bucket on the first one is how an
account ends up with two answers to which bucket holds the snapshots.
Everything wrangler cannot create is printed as a manual worklist, every run,
green or not.

**`bun run gate:infra`** checks that every declared resource exists **and that
the deployed Worker is bound to it**, and exits non-zero when it is not. It is
the last of the 49 required gates `scripts/deploy.sh` runs, and the only one
that talks to Cloudflare. It reports a verdict per resource rather than dying on
the first problem, because the next move depends on which resource is affected.
There are four verdicts, and `scripts/infra-verify.ts` explains why there are
four rather than two:

| Verdict | Meaning |
| --- | --- |
| `present` | observed to exist |
| `absent` | observed not to exist. Fails when `env.d.ts` declares the field required |
| `unknown` | the lookup failed. Always a failure, because a check that could not look did not pass |
| `unobservable` | no CLI path can confirm it. Declared in `UNOBSERVABLE` with its manual check, and pinned by equality so the blind spot can only shrink |

One environment per run, defaulting to production. `bun run gate:infra` checks
production and `bun scripts/infra-verify.ts staging` checks staging. Each run
names the environments it did not check, with the command that checks them.
Without a Cloudflare session the gate reports BLOCKED and exits non-zero.

**`bun run infra:teardown <environment>`** deletes what provisioning created, in
reverse dependency order, and refuses without a typed sentence naming the
environment (`destroy kinu production`). It prints WHAT IS INSIDE every
data-bearing resource before asking. It will not delete a resource another
environment binds: `nimbus-runtime-cache` is held by both, so tearing down one
environment retains it and says who still holds it. Nothing imports it and no
other command can reach it.

### Every value the Worker reads, and where it comes from

Derived from `Env` in `packages/cf-backend/env.d.ts` and pinned. A new field
that neither a binding nor a `vars` entry supplies fails `bun run gate:infra`
until somebody records how it is obtained. `wrangler secret list` returns names
only. Cloudflare never returns a value, and nothing here asks for one.

| Value | Handling | Required | Absent means |
| --- | --- | --- | --- |
| `CREDENTIAL_ENCRYPTION_KEY` | **prompt**: paste one, or press enter and provisioning generates 32 random bytes and displays them **once** | yes, everywhere | Every signed-in surface answers 503 while public routes answer 200, so the site looks healthy. |
| `CLOUDFLARE_OAUTH_CLIENT_SECRET` | **prompt** | where `CLOUDFLARE_OAUTH_CLIENT_ID` is a var | Chat falls back to the platform gateway and bills the **platform** account instead of each user's. |
| `GOOGLE_OAUTH_CLIENT_SECRET` | **prompt** | where `GOOGLE_OAUTH_CLIENT_ID` is a var | Google is not on `/login`. Unset on both environments. |
| `GITHUB_OAUTH_CLIENT_SECRET` | **prompt** | where `GITHUB_OAUTH_CLIENT_ID` is a var | GitHub is not on `/login`. Unset on both environments. |
| `CREDENTIAL_ENCRYPTION_KEY_PREVIOUS` | **out of band**: the outgoing key, during a rotation | no | Nothing. It is the read-only half of a rotation. |
| `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY` | **out of band**: an R2 API token from the dashboard; wrangler cannot mint one | no | Snapshots move through the `BACKUP_BUCKET` binding and restore by extracting rather than mounting. All four presigned-mode values are all-or-nothing. |
| `BACKUP_BUCKET_NAME`, `CLOUDFLARE_R2_ACCOUNT_ID` | **config var**: plain values in `vars`, not secrets | no | As above. |
| `GOOGLE_OAUTH_CLIENT_ID`, `GITHUB_OAUTH_CLIENT_ID` | **config var**, beside their secrets | no | That provider is not on `/login`. |
| `GOOGLE_OAUTH_SCOPES`, `GITHUB_OAUTH_SCOPES`, `CLOUDFLARE_OAUTH_SCOPES` | **config var**: overrides only | no | The provider default applies (`CLOUDFLARE_WORKERS_AI_SCOPES` in `lib/cloudflare-oauth.ts`). |
| `PROTEUS_MAX_STEPS` | **config var** | no | Core's `DEFAULT_MAX_STEPS` applies (500, `core/src/config.ts:118`). |

There is deliberately no "generate it silently" handling. The only value this
repository could mint unattended is the root secret, and a key the program
invents and never shows anyone is a key nobody can restore from. Losing it means
every user reconnects every provider. So it is a prompt, at a terminal,
displayed exactly once.

### What the binding manifest cannot express

`wrangler.jsonc` is the inventory, and these are the dependencies it has no
field for. These were verified against the live account on 2026-08-18 rather
than inferred, except where an entry names its own date, and
`scripts/infra-manifest.ts` carries the same list with the command that
re-checks each one.

- **The AI Gateway `kinu-ai-gateway`** exists only as a substring of the
  `AI_GATEWAY_URL` var. Neither creatable nor readable by anything here.
- **The Vectorize index's geometry.** The manifest names `kinu-memory` and
  stops. Creating it needs `--dimensions=384 --metric=cosine`, and an index at
  the wrong width binds fine and rejects every insert. Provisioning reads the
  dimension back out of the embedder in `packages/cf-backend/src/runtime.ts` so
  the two cannot drift. The metric appears only in a wrangler.jsonc comment.
- **The proxied DNS records** — the `*` wildcard for previews and `staging` for
  the staging route — and **the zone itself.** wrangler has no DNS command, and
  the zone DNS API answers 403 under the wrangler OAuth token. Verification
  resolves each name instead.
- **The KV namespace titles.** `kv_namespaces` binds by id and has no title
  field, so `kinu-auth` and `kinu-auth-staging` exist only in the account and in
  the command that created them. `npx wrangler kv namespace list` shows both, and
  is how verification reports a title for a namespace the manifest can only name
  by id.
- **Email Routing.** Verified 2026-08-20: the `kinu.run` zone holds zero DNS
  records, and neither Email Routing nor Email Sending is onboarded. So no
  inbound agent mail arrives and no outbound mail leaves, even though the
  binding, the var and the `email()` handler are all present and correct.
  Onboarding is a one-time owner action; `docs/EMAIL-INGRESS.md` has the steps.
- **The cron trigger.** `wrangler deploy` writes it from `triggers.crons`. No
  wrangler command reads it back. A declared blind spot.
- **The container image being pullable and matching `@cloudflare/sandbox` in
  `package.json`.** A container image is only reconciled by a deploy of that
  environment, so the two can disagree for as long as one of them has not been
  deployed since the version moved. Neither has been deployed yet.
- **An R2 lifecycle rule on the `backups/` prefix.** Not expressible in
  `wrangler.jsonc`. Without it the bucket grows without bound, since the Sandbox
  SDK enforces snapshot TTL at restore time only.
- **The Workers Paid plan**, and **the account**.

## Cloudflare Deployment

### 1. Configure wrangler.jsonc

Set your `account_id` in `packages/cf-backend/wrangler.jsonc`:

```jsonc
{
  "account_id": "<your-account-id>",
  // ...
}
```

### 2. Set Secrets

```bash
cd packages/cf-backend

# REQUIRED, and the first thing to set. This is the Worker's root secret for
# the user plane: it encrypts the credential store (every provider API key and
# OAuth token a user connects) and derives the owner capability that authorizes
# every privileged call. Without it the Worker cannot serve a signed-in user at
# all. Sign-in, the CLI, and credentials all return 503; public routes still
# answer. Keep a copy: losing it means every user reconnects every provider.
openssl rand -base64 32 | bunx wrangler secret put CREDENTIAL_ENCRYPTION_KEY

# No AI Gateway token: the platform gateway rides the Workers AI binding.

# OAuth providers appear only when both id and secret are configured.
# Client ids can live in wrangler vars; client secrets must be Wrangler secrets.
printf '<google-client-secret>' | bunx wrangler secret put GOOGLE_OAUTH_CLIENT_SECRET
printf '<github-client-secret>' | bunx wrangler secret put GITHUB_OAUTH_CLIENT_SECRET
printf '<cloudflare-client-secret>' | bunx wrangler secret put CLOUDFLARE_OAUTH_CLIENT_SECRET
```

#### Rotating CREDENTIAL_ENCRYPTION_KEY

Stored credentials name the key that sealed them, so a rotation is a two-key
window rather than a downtime:

```bash
# 1. keep the outgoing key readable, 2. install the new one
printf '<outgoing-key>' | bunx wrangler secret put CREDENTIAL_ENCRYPTION_KEY_PREVIOUS
openssl rand -base64 32 | bunx wrangler secret put CREDENTIAL_ENCRYPTION_KEY
```

Each user's UserDO re-seals its credentials under the new key on its next
credential access (`user/credential-envelope.ts`). Once every account has been
active, or after a deliberate sweep, delete
`CREDENTIAL_ENCRYPTION_KEY_PREVIOUS`. `PREVIOUS` accepts a comma-separated list,
so an interrupted rotation can be resumed rather than unwound. Losing a key with
rows still sealed under it is unrecoverable by design. Those providers must be
reconnected.

### 3. Build and Deploy

```bash
bun run deploy                # the only supported production deploy path
```

That runs `scripts/deploy.sh` (see § Deploy Script). Do not deploy production
with a bare `wrangler deploy`. It uploads a Worker without checking that the CLI
download assets were built, and production has already shipped that way once.
The site was fine while `/downloads/kinu-source.tar.gz`, its `.sha256`, and
`kinu-version.json` all answered with the SPA shell, so every fresh install
and update died on a checksum mismatch.

### 4. Custom Domain (Optional)

Use the Cloudflare Workers Custom Domains API:

```bash
curl -X PUT "https://api.cloudflare.com/client/v4/accounts/<account-id>/workers/domains" \
  -H "Authorization: Bearer <api-token>" \
  -H "Content-Type: application/json" \
  -d '{"hostname":"kinu.yourdomain.com","zone_id":"<zone-id>","service":"kinu","environment":"production"}'
```

Do not put the custom domain behind Cloudflare Access. Kinu serves a public
landing page and protects the dashboard with its own OAuth session. If an Access
application is attached to `kinu.run`, unauthenticated users
will see the Access login page before the Worker can serve `/`.

## OAuth Setup

Kinu supports Google, GitHub, and Cloudflare OAuth. A provider is shown on
`/login` only when both its client id and client secret are configured.

### Callback URLs

The Worker matches `/auth/<provider>/callback` (`auth/routes.ts:82`). Register
these exact redirect URLs on each provider:

```text
https://kinu.run/auth/google/callback
https://kinu.run/auth/github/callback
https://kinu.run/auth/cloudflare/callback
```

### Cloudflare OAuth

Use response type `Code`, grant type `Authorization Code, Refresh Token`, and
the token authentication method configured by `CLOUDFLARE_OAUTH_TOKEN_AUTH_METHOD`
(`client_secret_basic` in production). Do not request `openid` for Cloudflare
OAuth. Kinu requests these scopes so user-owned Cloudflare billing can power
Workers AI and AI Gateway calls:

```text
user-details.read account-settings.read ai.write aig.write aig.run offline_access
```

`offline_access` is required. `dash.cloudflare.com/oauth2/token` only returns a
`refresh_token` when the authorization request asked for it, and when the client
has the Refresh Token grant enabled. Without it the stored credential dies at
access-token expiry and every visit demands a Workers AI reconnect.

`aig.write` (AI Gateway Write; the client offers no separate Read scope) powers
the `my-gateway` provider: listing the user's AI Gateways, their stored BYOK
provider keys, and the Unified Billing credit balance. The OAuth client must
have the scope enabled in its dashboard configuration, and users who connected
before it was added need one re-login to grant it.

Set:

```bash
bunx wrangler secret put CLOUDFLARE_OAUTH_CLIENT_SECRET
```

The production client id and token auth method are non-secret vars in
`packages/cf-backend/wrangler.jsonc`. The scopes' source of truth is the
`CLOUDFLARE_WORKERS_AI_SCOPES` constant in
`packages/cf-backend/src/lib/cloudflare-oauth.ts:26`. Set a
`CLOUDFLARE_OAUTH_SCOPES` var only to override it.

## Model Providers

Who pays, per provider. The provider split exists for this property:

| Provider | Credential | Billed to |
| --- | --- | --- |
| `workers-ai` | the signed-in user's Cloudflare OAuth token | **that user's** Cloudflare account |
| `my-gateway/<provider>/<model>` | the same OAuth token, against the user's own AI Gateway | **that user's** BYOK provider keys or Unified Billing credits |
| `ai-gateway` (platform) | none; the `AI` binding, pre-authenticated in-account | **the account this Worker runs in** |
| `openai` / `anthropic` / `openrouter` / `codex` / `openai-compat` | the user's own stored key | **that user's** provider account |

So user chat rides the user's credential over HTTPS on purpose. The platform
`ai-gateway` provider is the deploy-time fallback used when no user credential
is reachable, plus the path platform-side work takes: embeddings, judges, evals,
benches. Its transport is the Workers AI binding, so it needs no API token and
its spend lands where it always did. Moving `workers-ai` or `my-gateway` onto
the binding would silently move every user's model spend onto the platform
account. Don't.

To set up the platform AI Gateway:

1. Go to [Cloudflare Dashboard > AI > AI Gateway](https://dash.cloudflare.com/?to=/:account/ai/ai-gateway)
2. Create a new gateway (e.g., `kinu-ai-gateway`) **in the same account as
   the Worker**. The binding resolves gateway names in-account only.
3. Set `AI_GATEWAY_URL` in wrangler vars to `https://gateway.ai.cloudflare.com/v1/<account-id>/<gateway-name>/workers-ai/v1`

No API token is required. The Worker reaches the gateway through the `AI`
binding, which is pre-authenticated inside its own account.

### The provider registry

Registration order is the default-preference order. The cloud registers, in
order (`cf-backend/src/providers/agent-registry.ts:111-125`): `workers-ai`, the
user's own `my-gateway`, the platform `ai-gateway` fallback, `codex`, `openai`,
`anthropic`, `openrouter`, `openai-compat`, and finally a **dynamic source
backed by the live models.dev catalog**. Any provider id in that catalog becomes
usable once you store a `<id>.bearer` credential. The cloud surfaces each extra
named OpenAI-compatible credential as a model spec, `openai-compat:<name>/<modelId>`,
rather than as a registered provider (`user/available-models.ts:55-66`).

The CLI registers a different list (`cli-backend/src/model-resolver.ts:286-351`):
`workers-ai` and `my-gateway` against the signed-in cloud proxy, or against a
direct local endpoint when `PROTEUS_BASE_URL` names one; then `claude` (which
drives your own Claude Code binary), `opencode`, `codex`, `openai`, `anthropic`,
`openrouter` and `openai-compat`; then one `openai-compat:<name>` per extra
named credential; and the same models.dev dynamic source the cloud uses.

### Model catalogs are live

Model lists are fetched from `https://models.dev/api.json` behind a 5-minute
cache (`core/src/providers/models-dev.ts:9`), which is where each model's
context window and capability flags come from. The static lists,
`WORKERS_AI_FALLBACK_MODEL_CATALOG` in
`packages/cf-backend/src/providers/workers-ai-catalog.ts` and each provider's
`FALLBACK_MODELS`, are only what you get when that fetch fails, returns
non-200, or filters to nothing. OpenRouter is the exception. It queries its own
`/api/v1/models` instead.

The default model id lives once in `@kinu/core` as
`DEFAULT_WORKERS_AI_MODEL_ID` / `DEFAULT_WORKERS_AI_MODEL_SPEC`
(`@cf/deepseek-ai/deepseek-v4-pro-0813`, `core/src/providers/workers-ai.ts:6`),
and is written into the user's `default_model` config on first Cloudflare
sign-in. The Workers AI fallback catalog carries six entries:

| Model ID | Name | Context |
|----------|------|---------|
| `@cf/deepseek-ai/deepseek-v4-pro-0813` | DeepSeek V4 Pro 0813 | 1,048k; default, reasoning + tools, paid access required |
| `@cf/moonshotai/kimi-k2.6` | Kimi K2.6 | 262k; reasoning + tools + vision |
| `@cf/nvidia/nemotron-3-120b-a12b` | Nemotron 3 Super 120B | 256k |
| `@cf/openai/gpt-oss-120b` | GPT OSS 120B | 128k |
| `@cf/openai/gpt-oss-20b` | GPT OSS 20B | 128k |
| `@cf/meta/llama-4-scout-17b-16e-instruct` | Llama 4 Scout | 131k |

Model choice interacts with prompt caching. The reasoning-era Kimi line (k2.6,
k2.7-code, k3) is the family this repository records a cached-input rate for
(`core/src/prompting/model-profile.ts:34-43`), and those models can benefit from
the session-affinity pin. Per-model cached-input pricing for the rest of the
catalog is not measured here. Read it off the account's own model catalog before
relying on it.

### Rate limits

Every provider fetch goes through `withRateLimitRetry`
(`core/src/providers/rate-limit-retry.ts`), so a 429 does not surface as a
failed turn. It retries 429, 529 and overload-shaped 503s up to 6 attempts
within a 180-second budget. It honors `Retry-After` verbatim when present, and
otherwise waits a full-jitter draw under a ceiling that doubles from 2 s to a
60 s cap. Requests whose body cannot be replayed pass through untouched, and an
exhausted budget returns the original response rather than throwing.

## Environment Variables

| Variable | Where | Description |
|----------|-------|-------------|
| `CREDENTIAL_ENCRYPTION_KEY` | Wrangler secret | **Required.** Root secret for the user plane: encrypts `user_credentials` at rest and derives the owner capability. Without it no signed-in surface works. |
| `CREDENTIAL_ENCRYPTION_KEY_PREVIOUS` | Wrangler secret | Retired encryption keys (comma-separated), read-only, for a rotation window |
| `AI_GATEWAY_URL` | wrangler.jsonc `vars` | Platform AI Gateway endpoint, in the Worker's own account. Names the gateway, upstream provider and endpoint prefix the `AI` binding transport addresses. No token needed. |
| `SANDBOX_TRANSPORT` | wrangler.jsonc `vars` | Container control plane, `rpc` in both environments. A stored per-sandbox transport beats this var on a cold start; the var covers a future `getSandbox` that omits the option. |
| `PREVIEW_HOST_SUFFIX` | wrangler.jsonc `vars` | Zone Workspace and Sandbox previews are served under, one capability hostname per exposed port. Requires a proxied wildcard DNS record on that zone plus a `*.<zone>/*` route; the wrangler.jsonc comment has both steps. Every host under it except the app's own serves previews and nothing else. Empty means previews are unavailable. |
| `CLI_PUBLIC_ORIGIN` | wrangler.jsonc `vars` | Origin embedded in installer/setup commands |
| `CLI_APPROVAL_ORIGIN` | wrangler.jsonc `vars` | Browser approval origin for CLI auth |
| `GOOGLE_OAUTH_CLIENT_ID` | wrangler.jsonc `vars` | Google OAuth client id |
| `GOOGLE_OAUTH_CLIENT_SECRET` | Wrangler secret | Google OAuth client secret |
| `GITHUB_OAUTH_CLIENT_ID` | wrangler.jsonc `vars` | GitHub OAuth client id |
| `GITHUB_OAUTH_CLIENT_SECRET` | Wrangler secret | GitHub OAuth client secret |
| `CLOUDFLARE_OAUTH_CLIENT_ID` | wrangler.jsonc `vars` | Cloudflare OAuth client id |
| `CLOUDFLARE_OAUTH_CLIENT_SECRET` | Wrangler secret | Cloudflare OAuth client secret |
| `CLOUDFLARE_OAUTH_SCOPES` | optional override | Defaults to `CLOUDFLARE_WORKERS_AI_SCOPES` in `lib/cloudflare-oauth.ts` |
| `CLOUDFLARE_OAUTH_TOKEN_AUTH_METHOD` | wrangler.jsonc `vars` | Token endpoint auth method (`client_secret_basic` in production) |
| `CLOUDFLARE_AI_GATEWAY_ID` | wrangler.jsonc `vars` | User account AI Gateway id for Workers AI routing; defaults to `default` |
| `GOOGLE_OAUTH_SCOPES` / `GITHUB_OAUTH_SCOPES` | optional override | Per-provider scope overrides |
| `EMAIL_DOMAIN` | wrangler.jsonc `vars` | Mission Inbox domain; unset disables email entirely (as on staging) |
| `OPS_ALERT_EMAIL` | wrangler.jsonc `vars` | Where synthetic-monitoring alerts go; unset leaves the monitor silent (as on staging) |
| `DEV_USER_EMAIL` | wrangler env var | Local/staging-only synthetic auth identity. Production must leave this unset. |
| `PROTEUS_ORIGIN` | CLI shell env | Override CLI app origin for alternate deployments |
| `PROTEUS_BASE_URL` | CLI shell env | Advanced direct LLM override for local agents |
| `PROTEUS_AUTH` | CLI shell env | Advanced direct LLM auth override for local agents |
| `PROTEUS_MODEL` | CLI shell env | Override local agent model |
| `PROTEUS_SOURCE_TARBALL` | CLI shell env | Advanced installer/update source override (`cli/routes.ts:957`) |
| `PROTEUS_SOURCE_SHA256` | CLI shell env | Pin a SHA-256 for the source tarball (default: published `.sha256` asset, always verified) |
| `PROTEUS_MAX_STEPS` | CLI shell env / wrangler env var | Max tool-call steps (default: 500) |

`SANDBOX_TRANSPORT` is the one `vars` entry `Env` in `env.d.ts` does not
declare. Read it from `wrangler.jsonc`, not from the type.

## Wrangler Bindings

| Binding | Type | Description |
|---------|------|-------------|
| `OrchestratorAgent` | Durable Object | The workspace agent (extends `ActorAgent` → `Think`) |
| `UserDO` | Durable Object | Per-user profile, CLI tokens, devices, release changes |
| `MonitorDO` | Durable Object | Synthetic monitoring: open incidents + the alert outbox (one instance, `site`) |
| `NIMBUS_SESSION` | Durable Object | `NimbusSession` from `@nimbus-sh/sdk`; built-in lightweight sandbox (local DO class, deployed with this Worker) |
| `Sandbox` | Durable Object + Container | `ProteusSandbox` (@cloudflare/sandbox); one container per agent |
| `AUTH_KV` | KV namespace | Sessions, one-time OAuth state, and CLI browser approval state — all of it expiring on its own; identities live in `UserDO`. `kinu-auth`, and `kinu-auth-staging` in staging |
| `LOADER` | Worker Loader | Sandboxed code execution (codemode) |
| `AI` | Workers AI | Platform-side embeddings (chat models use the user's OAuth credential) |
| `MEMORY_VECTORS` | Vectorize | `kinu-memory`, and `kinu-memory-staging` in staging (384-dim, cosine); optional hybrid recall on top of FTS5 |
| `EMAIL` | `send_email` | Outbound Mission Inbox replies and owner notifications |
| `BACKUP_BUCKET` | R2 bucket | Sandbox `/workspace` backups (squashfs archives). `kinu-backups`, and `kinu-backups-staging` in staging, so eval snapshots never land beside real archives |
| `NIMBUS_RUNTIME_CACHE` | R2 bucket | `nimbus-runtime-cache`, the artifact store a hosted workspace installs its toolchain from. Absent means a hosted `python3`, `ruby` or `clang` exits 127 |
| `ASSETS` | Static assets | `dist/client` SPA bundle + CLI source archive downloads |

Two agent classes have no binding of their own. `ExplorationAgent` (MCTS
branches and heads) and `SubordinateAgent` both exist only as facets of
`OrchestratorAgent`, reached through the agents SDK's sub-agent mechanism.
`ExplorationAgent` still appears in the DO migration list, because a class
registration and a binding are separate things.

`compatibility_date` is `2025-12-01` with `nodejs_compat`. Durable Object
migrations are three tags in production (`v1` registering `OrchestratorAgent`,
`ExplorationAgent`, `ProteusSandbox`, `UserDO`; `v2` adding `NimbusSession`;
`v3` adding `MonitorDO`) and a **different five-tag sequence** under
`env.staging`, because the two deployments registered their classes in a
different order. Wrangler does not inherit `env.*` config, so every binding is
re-specified there.

## Deploy Script

`scripts/deploy.sh` is the deploy path, reached by `bun run deploy` at the repo
root. Everything ships as one Worker (name `kinu`). `NimbusSession` is a
local DO class deployed with it, so there is no separate Nimbus deploy.

```bash
bun run deploy
```

### Order of operations

The script refuses a dirty checkout first, so the build SHA in `/api/health`
always identifies the exact source bytes that were published. Then it runs the
environment preflight, verifies Wrangler authentication, and installs the locked
dependency graph with `bun install --frozen-lockfile` when a checkout has no
root `node_modules`.

1. **Required pre-deploy gates.** 49 gates, every one unconditional. Each is a
   `run_required_gate` line in `scripts/deploy.sh`, which is the full list. They
   cover `bun run check`; the deploy contract test; the agent-utils, core,
   compaction, test-utils, Cloudflare-backend, workerd, CLI-backend, full
   production CLI, local-device daemon and root end-to-end suites; the
   exploration policy mutation suite; the deterministic eval and benchmark
   tests; the secret-scanner self-test and its scan; every gate's own
   self-test; the static gates for dead code, duplication, capability parity,
   policy drift, silently dropped failures, reachability, typecheck coverage,
   skip ratchet, set equality, citation registers, commit hygiene, dependency
   policy and committed-patch parity; Layergate conformance and its
   fault-localization matrix; behavioural evals; and the full Lean proof,
   consistency and traceability gate. `gate:computed-style` is deliberately
   absent: it boots Vite and Chrome over 19 gallery frames and would fail this
   pipeline for environmental reasons, so only its decision logic is guarded
   here. `gate:bench-corpus` runs the cheap half of the bench corpus check, 159
   `git apply --check` invocations measured at 0.15 s for the whole corpus. The
   other half, `bench.ts validate`, actually runs each task's checks and is a
   separate nightly run. The last gate is the only one that talks to Cloudflare:
   `bun run gate:infra` checks that every resource `wrangler.jsonc` declares for
   **production** exists and that the deployed Worker is bound to it. Everything
   above it proves the source is deployable; that one proves the account is. Any
   failure exits before Vite, archive generation, or Wrangler. No variable skips
   a gate on this path. `PROTEUS_INFRA_ACK` only acknowledges a missing
   Cloudflare session, and the `npx wrangler whoami` check above already fails
   the deploy in that case.
2. **Build.** `vite build`, then `scripts/build-cli-source-archive.sh` (CLI
   source tarball, `.sha256`, `kinu-version.json`). Fails if any of the three
   is missing from `packages/cf-backend/dist/client/downloads/`.
3. **Deploy.** `npx wrangler deploy`. Verifies the `ProteusSandbox` binding
   appears in wrangler output, and that the assets directory wrangler reports
   reading is the one the downloads were staged into.
4. **Smoke test.** Asserts HTTP 200 and app content on the production URL, that
   `/api/health` reports the build stamp of the commit being deployed, that
   `/downloads/kinu-version.json` parses as JSON for that same build, that
   the CLI shim points at the deployed source archive, that the archive
   downloads and lists expected files, and that the published `.sha256` matches
   the served archive. The stamp checks retry with backoff, because edge
   rollout takes up to about two minutes and a stamp that never converges is
   the real failure.
5. **Summary.** Prints the URL, Version ID, and build sha.

### Build budget

Two platform limits govern what step 2 may produce. Both limits are recorded in
`core/src/platform-catalog.ts` under `worker.script_bytes` and
`worker.startup_ms`, read from Cloudflare's published limits on 2026-08-17.
Neither figure has a gate, so re-measure rather than deriving either from
memory.

- **Worker bundle, gzipped.** The cap is 10 MB on Workers Paid, and 64 MB
  uncompressed. The repository encodes that cap as 10,000,000 bytes
  (`MB = 1000 * 1000`, `core/src/platform-catalog.ts:217`). Last reading:
  **7,091.83 KiB gzip, measured 2026-08-19**, about 73% of it. Measure it with
  `bunx wrangler deploy --dry-run` in `packages/cf-backend` after a vite build.
  That prints the `Total Upload / gzip` figure the deploy API enforces. Vite's
  per-chunk `gzip:` line covers one chunk and understates the total by more
  than 2x.
- **Worker startup time.** The limit is **1 second** of module top-level
  evaluation, and every cold activation of every Durable Object pays it. Last
  reading: **185-252 ms, measured 2026-08-04**, about a fifth of the limit.
  Cloudflare raised this limit from 400 ms on 2025-10-10. Do not cite 400 ms.

Bundle size charges against startup time as well, so the gzip figure is the one
to watch.

### Static assets

There is exactly one assets directory: `packages/cf-backend/dist/client`.

`wrangler deploy` follows the redirect the Vite plugin writes to
`packages/cf-backend/.wrangler/deploy/config.json` and deploys the generated
`dist/kinu/wrangler.json`, whose `assets.directory` is `../client`. The
hand-written `wrangler.jsonc` says `dist/client`. Both resolve to the same
place, so the choice of config does not change which files are published.

`dist/kinu/assets/` holds the Worker bundle's code-split chunk output, which
wrangler attaches as Worker modules. It is not an assets directory, and nothing
written there is ever served over HTTP.

Step 2 of the deploy asserts the downloads exist in `dist/client/downloads/`,
and step 3 asserts wrangler read that same directory, so a future config or
plugin change that moves the assets dir fails the deploy instead of silently
shipping an assetless site.

### Build stamp

`scripts/build-cli-source-archive.sh` stamps the short HEAD sha into the CLI
package version (`0.1.0+<sha>`) and writes `dist/client/downloads/kinu-version.json`
(`{version, sha, builtAt}`) from that same stamped `package.json`. The Worker
reads that file back through the `ASSETS` binding and reports it as `build` on
`GET /api/health`, so one unauthenticated GET answers both "which commit is
live?" and "did the asset half of the deploy land?". `/api/health` reports
`ok: false` when there is no build stamp, because a deployment without one has
broken CLI download endpoints. Deploying from a dirty worktree prints a warning:
the stamp names a commit that does not describe what shipped.

### Environment variables

| Variable | Default | Purpose |
|----------|---------|---------|
| `CLOUDFLARE_ACCOUNT_ID` | `f44999d1ddda7012e9a87729eba250f1` | Deploy account |

### Staging

A fully isolated second deployment (`kinu-staging`, own DO namespaces and KV
session store, `DEV_USER_EMAIL` headless identity) answers on
https://staging.kinu.run and is configured under `env.staging` in
`wrangler.jsonc`:

```bash
bun run --cwd packages/cf-backend deploy:staging
```

It rebuilds with `CLOUDFLARE_ENV=staging` so the Vite plugin generates the
staging config the deploy redirect points at, builds the CLI source archive,
deploys, then rebuilds for production so the working tree is not left holding a
staging bundle.

### Synthetic monitoring

The deploy smoke gate above only runs at deploy time, and the outage it was
written for happened to a deploy that never went through it. So the same checks
run on a schedule. A cron trigger (`*/15 * * * *` in `wrangler.jsonc`) calls
`MonitorDO.check()`, which probes the live origin and emails `OPS_ALERT_EMAIL`
through the Mission Inbox's outbound path when something breaks.

| Probe | Passes when |
|-------|-------------|
| `health` | `/api/health` returns `ok:true` JSON with a build identifier that matches the one `/downloads/kinu-version.json` advertises |
| `downloads` | `/downloads/kinu-source.tar.gz` hashes to exactly what `…​.sha256` declares. This is the check the installer itself makes |
| `login` | `/login` renders the sign-in page with at least one provider link |

One email per incident, not per tick. A failing probe opens an incident with one
alert, stays open silently while it keeps failing, and closes with one recovery
notice. Delivery rides `EmailOutbox`, so a send that fails is re-driven with the
same Message-ID rather than lost or duplicated.

Unset `OPS_ALERT_EMAIL` (as in staging) leaves the monitor recording incidents
but silent. Staging also has no cron trigger: its sign-in providers and mail
route are absent on purpose, so probing it would report a site that is missing
by design.

### Rollback

Static assets are part of a Worker version, so a rollback moves the Worker code
and the published `/downloads/*` assets together. How many versions Cloudflare
retains is not measured here; `npx wrangler versions list` prints the ones you
can actually roll back to.

```bash
cd packages/cf-backend
npx wrangler versions list
npx wrangler rollback --version-id <version-id>
```

Then confirm the rollback took, the same way the deploy gate does. The build
stamp must name the commit you rolled back to, and the CLI download path must
still verify:

```bash
curl -s https://kinu.run/api/health | jq '.ok, .build'
curl -fsSL https://kinu.run/downloads/kinu-source.tar.gz -o /tmp/p.tgz
curl -fsSL https://kinu.run/downloads/kinu-source.tar.gz.sha256
sha256sum /tmp/p.tgz
```

A rollback that leaves `ok: false`, an unexpected `build.sha`, or a 404 on the
downloads has not recovered anything. Redeploy forward with `bun run deploy`
instead. This rehearsal has not been run against production. The commands are
the ones `scripts/deploy.sh` runs, reduced to what a rollback needs.

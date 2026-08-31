# Deployment

## Live Instance

Production answers on https://kinu.run, staging on https://staging.kinu.run. Previews live under `<PREVIEW_HOST_SUFFIX>`, one capability hostname per exposed Workspace or Sandbox port. Previews are agent-written HTML, so each port gets its own hostname and the suffix needs wildcard DNS. Sandbox uses the @cloudflare/sandbox SDK hostname; the Workspace uses a Nimbus session capability under the same trust boundary. `packages/cf-backend/src/lib/preview-origin.ts` holds the reasoning and the Public Suffix List prerequisite still open for full cookie-site isolation.

### One origin per environment

One app origin per environment (`workers_dev` false in both), so `CLI_PUBLIC_ORIGIN` names the whole set. The Worker redirects cleartext to HTTPS and sends HSTS for that host plus the preview subtree. Any other hostname reaching the Worker is not an app origin and gets served as nothing.

Production's preview suffix is `kinu.run` itself, so previews are strict subdomains of the app host and `*.kinu.run/*` matches previews, never the app. Staging leaves `PREVIEW_HOST_SUFFIX` empty (`staging.kinu.run` is no wildcard parent) and serves no previews. Staging binds as a ROUTE (`pattern: "staging.kinu.run"`, `zone_name: "kinu.run"`), not a custom domain: production's wildcard already claims `*.kinu.run/*`, and exact-route-beats-wildcard is the only precedence rule Cloudflare documents unambiguously.

## Local Development

You need [Bun](https://bun.sh/), Node.js 18+ (for Wrangler), and a Cloudflare account (for AI Gateway).

```bash
git clone https://github.com/AshishKumar4/kinu.git
cd kinu
bun install
```

### Web UI (Vite + Wrangler)

```bash
cd packages/cf-backend

# Create .dev.vars. The platform AI Gateway needs NO token. Its transport is the
# Workers AI binding, which is pre-authenticated inside your own account.
cat > .dev.vars << EOF
AI_GATEWAY_URL=https://gateway.ai.cloudflare.com/v1/<account-id>/<gateway-name>/workers-ai/v1
CREDENTIAL_ENCRYPTION_KEY=$(openssl rand -base64 32)
EOF

# Start dev server (from repo root)
bun run dev
```

`bun run dev` runs `vite dev --host 0.0.0.0` in `packages/cf-backend`; open http://localhost:5173. The Vite cloudflare() plugin runs real Durable Objects through Miniflare. That URL bills models to the account the Worker runs in. For chat billed to each signed-in user's own account, add `CLOUDFLARE_OAUTH_CLIENT_ID` and `CLOUDFLARE_OAUTH_CLIENT_SECRET` to `.dev.vars`. `DEV_USER_EMAIL` skips auth for headless work.

### CLI

```bash
curl -fsSL 'https://kinu.run/install.sh' | bash
kinu setup
kinu create jarvis --mode cloud --alias jarvis --purpose "A helpful coding assistant"
jarvis "summarize this checkout"
```

From source: `bun run cli -- setup`, then `bun run cli -- ...`. Origin defaults to `https://kinu.run`; `--origin` or `KINU_ORIGIN` for alternate deployments only.

## Zero to production

Assumes an EMPTY Cloudflare account. Three commands do it, a fourth proves it:

```bash
bun run infra:provision      # the R2 buckets and the Vectorize indexes
bun run deploy               # the Worker, its DO namespaces, container, routes, cron
bun run infra:provision      # the secrets; `wrangler secret put` needs the Worker to exist
bun run gate:infra           # every declared resource exists and is bound
```

`wrangler secret put` refuses on a nonexistent Worker, so on a fresh account the root secret installs only after the first deploy. That is why provisioning runs twice; run two creates nothing new. `bun run deploy` is the only supported deploy path; provisioning creates resources and never deploys.

### Before you start

Provisioning cannot create these; without them a fresh account fails. The provisioner prints this list every run.

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

Universal SSL on `kinu.run` covers the app host, staging, and every preview host. No Advanced Certificate Manager needed.

### What each command does

**`infra:provision`** reads its inventory from `wrangler.jsonc`; there is no second list. Creates what is missing in dependency order (R2 buckets, then Vectorize indexes), printing `CREATED` or `existed` per resource, so a second run is visibly a no-op. A FAILED lookup refuses rather than creates: network-down and does-not-exist differ, and creating through the first leaves two candidate snapshot buckets. What wrangler cannot create prints as a manual worklist, every run.

**`gate:infra`** checks every declared resource exists **and** that the deployed Worker binds it; exits non-zero otherwise. It is the only gate that talks to Cloudflare and the last required gate before the build. The deploy script currently runs 57 required gate invocations, all before deployment. It checks `KINU_DEPLOY_ENV`, else argv, else production, so staging never takes a production defect's refusal, and reports one verdict per resource instead of dying on the first failure (`scripts/infra-verify.ts` has the reasoning):

| Verdict | Meaning |
| --- | --- |
| `present` | observed to exist |
| `absent` | observed not to exist. Fails when `env.d.ts` declares the field required |
| `unknown` | the lookup failed. Always a failure, because a check that could not look did not pass |
| `unobservable` | no CLI path can confirm it. Declared in `UNOBSERVABLE` with its manual check, and pinned by equality so the blind spot can only shrink |

Production: `bun run gate:infra`. Staging: `bun scripts/infra-verify.ts staging`. Each run names skipped environments with their checking command. No Cloudflare session: BLOCKED, non-zero exit.

**`infra:teardown <environment>`** deletes in reverse dependency order and refuses without a typed environment name (`destroy kinu production`). Prints WHAT IS INSIDE each data-bearing resource before asking. Never deletes what another environment binds: `nimbus-runtime-cache` belongs to both, so one teardown retains it and says who else holds it. Nothing imports it and no other command reaches it.

### Every value the Worker reads, and where it comes from

Derived from `Env` in `env.d.ts`, pinned. A field neither binding nor `vars` entry supplies fails `gate:infra` until someone records how it is obtained. `wrangler secret list` returns names only; Cloudflare never returns a value.

| Value | Handling | Required | Absent means |
| --- | --- | --- | --- |
| `CREDENTIAL_ENCRYPTION_KEY` | **prompt**: paste one, or press enter and provisioning generates 32 random bytes and displays them **once** | yes, everywhere | Every signed-in surface answers 503 while public routes answer 200, so the site looks healthy. |
| `WEBHOOK_ROUTE_SECRET` | **prompt**: paste 32 random bytes (`openssl rand -base64 32`) | yes, everywhere | No workspace can take an inbound webhook. Creating one answers 503, and every delivery URL answers 404 without waking a workspace. Timers and email keep working. |
| `CLOUDFLARE_OAUTH_CLIENT_SECRET` | **prompt** | where `CLOUDFLARE_OAUTH_CLIENT_ID` is a var | Chat falls back to the platform gateway and bills the **platform** account instead of each user's. |
| `GOOGLE_OAUTH_CLIENT_SECRET` | **prompt** | where `GOOGLE_OAUTH_CLIENT_ID` is a var | Google is not on `/login`. Unset on both environments. |
| `GITHUB_OAUTH_CLIENT_SECRET` | **prompt** | where `GITHUB_OAUTH_CLIENT_ID` is a var | GitHub is not on `/login`. Unset on both environments. |
| `CREDENTIAL_ENCRYPTION_KEY_PREVIOUS` | **out of band**: the outgoing key, during a rotation | no | Nothing. It is the read-only half of a rotation. |
| `GOOGLE_OAUTH_CLIENT_ID`, `GITHUB_OAUTH_CLIENT_ID` | **config var**, beside their secrets | no | That provider is not on `/login`. |
| `GOOGLE_OAUTH_SCOPES`, `GITHUB_OAUTH_SCOPES`, `CLOUDFLARE_OAUTH_SCOPES` | **config var**: overrides only | no | The provider default applies (`CLOUDFLARE_WORKERS_AI_SCOPES` in `lib/cloudflare-oauth.ts`). |
| `ANALYTICS_SQL_API_TOKEN` | **out of band**: Account Analytics Read token | for `/control` metrics queries | Analytics Engine writes continue; the Metrics tab reports that queries are not configured. |
| `CONTROL_PLANE_ADMINS` | **config var**: comma-separated operator email addresses | for `/control` | The control route returns 404 and no admin link appears. Staging keeps this empty. |
| `CLOUDFLARE_ACCOUNT_ID` | **config var** | for Analytics Engine queries | The Metrics tab reports that queries are not configured. |

No "generate it silently" handling, deliberately. The root secret is the only value this repo could mint unattended, and a key nobody has seen nobody can restore; losing it means every user reconnects every provider. So it is a prompt at a terminal, shown exactly once.

Three Analytics Engine bindings; Cloudflare creates each dataset on first write. Rows retain three months, writes can sample, and every query in `analytics/query.ts` weights `_sample_interval`.

### What the binding manifest cannot express

Dependencies with no field in `wrangler.jsonc`, verified against the live account 2026-08-18 unless an entry names its own date. `scripts/infra-manifest.ts` carries the same list with a re-check command each.

- **AI Gateway `kinu-ai-gateway`**: exists only inside the `AI_GATEWAY_URL` string. Nothing here creates or reads it.
- **Vectorize geometry**: `kinu-memory` needs `--dimensions=384 --metric=cosine`; wrong width binds fine then rejects every insert. Provisioning reads the dimension from the embedder in `runtime.ts`, so they cannot drift. The metric lives only in a wrangler.jsonc comment.
- **DNS records and zone**: wrangler has no DNS command and the zone DNS API answers 403 under the OAuth token; verification resolves each name instead.
- **KV titles**: `kv_namespaces` binds by id; `kinu-auth`/`kinu-auth-staging` exist only in the account. `npx wrangler kv namespace list` reports titles.
- **Email Routing**: verified 2026-08-20, the `kinu.run` zone held zero DNS records and neither Email Routing nor Email Sending was onboarded, so mail is dead despite a correct binding, var and handler. One-time owner action; `docs/EMAIL-INGRESS.md`.
- **Cron trigger**: written by deploy from `triggers.crons`; no wrangler command reads it back. Declared blind spot.
- **Container image**: pullable. Both environments name it by DIGEST — `docker.io/cloudflare/sandbox@sha256:822501de…`, which is `0.12.8` as the registry resolved it on 2026-08-27 — because a tag is a mutable pointer and a container restart would otherwise pick up re-pushed bytes with nothing here changed. `scripts/release-config.test.ts` holds both environments to that one reference, refuses a tagged one, and holds the declared version equal to `@cloudflare/sandbox` in `packages/cf-backend/package.json`. What it cannot do is pull the image or read a running container: only a deploy reconciles an image, so the deployed pair can disagree until both environments redeploy after a bump.
- **Source maps**: `upload_source_maps` is on in both environments and `vite.config.ts` emits maps for every worker environment — never the client, where a map in `dist/client` would be TypeScript served from the public origin. Cloudflare remaps uncaught exceptions against them before they reach Workers Logs, and maps travel as separate upload parts that do not count against the 10 MB script budget. What no gate proves from here: that Cloudflare remapped a given trace. Read one after a deploy.
- **Browser errors reach structured diagnostics.** `ErrorBoundary` sends a bounded report to `POST /api/client-errors`. The route requires the session and CSRF checks, validates the route, error class, and stack-frame grammar, labels the browser release as `match`, `stale`, `unreported`, or `undeployed`, and emits `client.render_failed` through `diagnostics` to Workers Logs and Analytics Engine. It returns `202`; it creates no application row. The route keeps the report separate from storage failures such as `storage_unavailable` and `row_write_failed`.
- **`backups/` reclamation, which must NOT be a lifecycle rule**: each workspace stores an immutable base layer written once plus a cumulative delta (`backups/<uuid>/data.sqsh`, `…/delta.sqsh`). An age rule bricks every workspace older than itself. Do not set one. The delta replaces in place, so growth is base plus changed set. Deleting a workspace discards both objects before DO death; that discard is the reclamation path. A DO dying first strands both objects, and nothing collects them today. Restore-time TTL covers the extraction path only (local dev).
- **Committed patch on `@cloudflare/sandbox@0.12.8`**: makes SDK mount-handler registration MERGE with subclass handlers instead of replacing them, so an R2 bucket mount cannot unbind KinuSandbox egress/event interception. `bun scripts/patch-parity.ts` (required gate) proves patches match the tree; bumping means regenerating and moving BOTH pins, the version and digest in `scripts/release-config.test.ts`, both `containers[].image` entries, and the root `overrides` entry for `@cloudflare/containers`, in one commit. That override exists because the SDK's own `^0.3.5` range resolved to a second, nested copy at 0.3.6 — which was the only copy the deployed Worker bound, while both manifests pinned 0.3.7 — so a bump has to leave manifests, lockfile, installed graph and emitted artifact naming one version. `scripts/nested-container-resolution.test.ts` measures all four.
- **Committed patch on `@nimbus-sh/core@0.6.0`**: carries commit `ceb3b736` (merged upstream, unreleased at patch time). Its esbuild-service imported bare `esbuild-wasm`; resolvers ignoring the legacy `browser` field picked Node CJS, which rejects the wasm-module init option (the only Worker form), failing every workspace `.mjs` transform with `The "wasmModule" option only works in the browser`. The patch names `esbuild-wasm/esm/browser.js` in both shipped shapes (`src/` under Bun's export condition, `dist/` under wrangler bundling). Remove once core pins a fixed version; until then regenerate on bump, same commit.
- **Workspace storage mode**: with `BACKUP_BUCKET`, `/workspace` restores lazy layers at fixed cost regardless of size. Without container outbound interception (local docker), empty workspaces record extraction mode; workspaces holding chain layers refuse to start rather than silently degrade.
- **The Workers Paid plan**, and **the account**.
- **Feedback lifecycle rule**: both feedback buckets expire `feedback/` after 90 days, set and read back 2026-08-24. The DO keeps pointer and metadata only.

## Cloudflare Deployment

### 1. Configure wrangler.jsonc

Set `account_id` in `packages/cf-backend/wrangler.jsonc`:

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
# the user plane. It encrypts the credential store (every provider API key and
# OAuth token a user connects) and derives the owner capability that authorizes
# every privileged call. Without it the Worker cannot serve a signed-in user at
# all. Sign-in, the CLI, and credentials all return 503; public routes still
# answer. Keep a copy. If you lose it, every user reconnects every provider.
openssl rand -base64 32 | bunx wrangler secret put CREDENTIAL_ENCRYPTION_KEY

# REQUIRED for webhook ingress. It signs the route capability in every public
# delivery URL (`events/webhook-route.ts`), so without it a workspace cannot be
# given a webhook at all: creation answers 503 and every delivery URL answers
# 404 without waking a workspace. Separate from the root secret because the two
# rotate on different clocks — this one's URLs live in other people's systems.
openssl rand -base64 32 | bunx wrangler secret put WEBHOOK_ROUTE_SECRET

# No AI Gateway token. The platform gateway rides the Workers AI binding.

# OAuth providers appear only when both id and secret are configured.
# Client ids can live in wrangler vars; client secrets must be Wrangler secrets.
printf '<google-client-secret>' | bunx wrangler secret put GOOGLE_OAUTH_CLIENT_SECRET
printf '<github-client-secret>' | bunx wrangler secret put GITHUB_OAUTH_CLIENT_SECRET
printf '<cloudflare-client-secret>' | bunx wrangler secret put CLOUDFLARE_OAUTH_CLIENT_SECRET

# The control plane queries Analytics Engine through the account SQL API.
printf '<account-analytics-read-token>' | bunx wrangler secret put ANALYTICS_SQL_API_TOKEN
```

#### Rotating CREDENTIAL_ENCRYPTION_KEY

Credentials name the key that sealed them, so rotation is a two-key window with no downtime:

```bash
# 1. keep the outgoing key readable, 2. install the new one
printf '<outgoing-key>' | bunx wrangler secret put CREDENTIAL_ENCRYPTION_KEY_PREVIOUS
openssl rand -base64 32 | bunx wrangler secret put CREDENTIAL_ENCRYPTION_KEY
```

Each UserDO re-seals on next credential access (`user/credential-envelope.ts`). Delete `PREVIOUS` once every account has been active or after a sweep. It takes comma-separated lists, so an interrupted rotation resumes rather than unwinds. Losing a key with rows still sealed is unrecoverable by design; reconnect those providers.

#### Rotating WEBHOOK_ROUTE_SECRET

Rotating this secret revokes every webhook URL the deployment ever issued, all at once, and there is no two-key window: the capability is derived, not stored, so an old URL simply stops verifying.

```bash
openssl rand -base64 32 | bunx wrangler secret put WEBHOOK_ROUTE_SECRET
```

After it, every external system that posts to a Kinu webhook needs the new URL. Owners read it from the triggers list — the Supervise Automations block, or `kinu triggers <workspace> list` — which prints the current URL for each webhook row. Trigger rows, secrets and delivery history are untouched; only the URL changes. Rotate on purpose (a leaked URL, an operator handover), not on a schedule.

### 3. Build and Deploy

```bash
bun run deploy                # production, https://kinu.run
bun run deploy:staging        # staging, https://staging.kinu.run
```

Both call `scripts/deploy.sh` (§ Deploy Script) with the environment as sole argument. One script so the gates, CLI asset check and six smoke checks cannot exist for production and be absent for staging.

Staging also deploys itself, and the operator setup that needs is in § Staging deploys itself. The daily run catches account drift under a Worker nobody touched, which is how `gate:infra` found staging predating the MonitorDO migration.

Never bare `wrangler deploy`: it skips the CLI asset check, and production shipped assetless once. Downloads served the SPA shell while the site looked fine, killing every fresh install and update on checksum mismatch.

### 4. Custom Domain (Optional)

Cloudflare Workers Custom Domains API:

```bash
curl -X PUT "https://api.cloudflare.com/client/v4/accounts/<account-id>/workers/domains" \
  -H "Authorization: Bearer <api-token>" \
  -H "Content-Type: application/json" \
  -d '{"hostname":"kinu.yourdomain.com","zone_id":"<zone-id>","service":"kinu","environment":"production"}'
```

Keep Cloudflare Access off it. Kinu serves a public landing page and guards the dashboard with its own OAuth session; Access would show unauthenticated users its login before the Worker can serve `/`.

## OAuth Setup

Google, GitHub, and Cloudflare OAuth. A provider shows on `/login` only when both id and secret are configured.

### Callback URLs

The Worker matches `/auth/<provider>/callback` (`auth/routes.ts:82`). Register these exact redirect URLs per provider:

```text
https://kinu.run/auth/google/callback
https://kinu.run/auth/github/callback
https://kinu.run/auth/cloudflare/callback
```

### Cloudflare OAuth

Response type `Code`, grant `Authorization Code, Refresh Token`, token auth per `CLOUDFLARE_OAUTH_TOKEN_AUTH_METHOD` (`client_secret_basic` in production). No `openid`. These scopes route billing to each user's own Cloudflare account:

```text
user-details.read account-settings.read ai.write aig.write aig.run offline_access
```

`offline_access` is required: the token endpoint returns a `refresh_token` only when asked for and the grant enabled. Without it credentials die at access-token expiry and every visit demands a Workers AI reconnect.

`aig.write` (no separate Read scope exists) powers `my-gateway`: gateway listings, stored BYOK keys, Unified Billing balance. Enable it dashboard-side; users connected before it was added need one re-login.

```bash
bunx wrangler secret put CLOUDFLARE_OAUTH_CLIENT_SECRET
```

Client id and token auth method are non-secret vars in `wrangler.jsonc`. Scope source of truth: `CLOUDFLARE_WORKERS_AI_SCOPES`, `lib/cloudflare-oauth.ts:26`; override via `CLOUDFLARE_OAUTH_SCOPES` only.

## Model Providers

Who pays, per provider. Billing is why the providers split.

| Provider | Credential | Billed to |
| --- | --- | --- |
| `workers-ai` | the signed-in user's Cloudflare OAuth token | **that user's** Cloudflare account |
| `my-gateway/<provider>/<model>` | the same OAuth token, against the user's own AI Gateway | **that user's** BYOK provider keys or Unified Billing credits |
| `ai-gateway` (platform) | none; the `AI` binding, pre-authenticated in-account | **the account this Worker runs in** |
| `openai` / `anthropic` / `openrouter` / `codex` / `openai-compat` | the user's own stored key | **that user's** provider account |

User chat rides the user's credential over HTTPS on purpose. Platform `ai-gateway` covers the fallback when no user credential is reachable, plus embeddings, judges, evals, benches; binding transport, no token. Moving `workers-ai` or `my-gateway` onto the binding would silently move all user spend to the platform account. Don't.

Platform gateway setup: [Dashboard > AI > AI Gateway](https://dash.cloudflare.com/?to=/:account/ai/ai-gateway), create one (e.g. `kinu-ai-gateway`) **in the Worker's account** (the binding resolves names in-account only), point `AI_GATEWAY_URL` at `https://gateway.ai.cloudflare.com/v1/<account-id>/<gateway-name>/workers-ai/v1`.

### The provider registry

Registration order is default-preference order. Cloud (`cf-backend/src/providers/agent-registry.ts:111-125`): `workers-ai`, the user's `my-gateway`, platform `ai-gateway` fallback, `codex`, `openai`, `anthropic`, `openrouter`, `openai-compat`, then a dynamic models.dev source. Any catalog id becomes usable given a `<id>.bearer` credential; extra named OpenAI-compatible credentials surface as specs `openai-compat:<name>/<modelId>`, not registered providers (`user/available-models.ts:55-66`).

CLI (`cli-backend/src/model-resolver.ts:286-351`): `workers-ai` and `my-gateway` via the signed-in cloud proxy or direct when `KINU_BASE_URL` names one; `claude` (drives your Claude Code binary), `opencode`, `codex`, `openai`, `anthropic`, `openrouter`, `openai-compat`; one `openai-compat:<name>` per extra credential; same dynamic source.

### Model catalogs are live

Model lists come from `https://models.dev/api.json` behind a 5-minute cache (`core/src/providers/models-dev.ts:9`), supplying context windows and capability flags. Static lists (`WORKERS_AI_FALLBACK_MODEL_CATALOG`, `providers/workers-ai-catalog.ts`; per-provider `FALLBACK_MODELS`) apply only when that fetch fails, returns non-200, or filters empty. OpenRouter queries its own `/api/v1/models`.

Default model lives once in core: `DEFAULT_WORKERS_AI_MODEL_ID` / `DEFAULT_WORKERS_AI_MODEL_SPEC` (`@cf/deepseek-ai/deepseek-v4-pro-0813`, `core/src/providers/workers-ai.ts:6`), written into `default_model` at first sign-in. Six-entry fallback catalog:

| Model ID | Name | Context |
|----------|------|---------|
| `@cf/deepseek-ai/deepseek-v4-pro-0813` | DeepSeek V4 Pro 0813 | 1,048k; default, reasoning + tools, paid access required |
| `@cf/moonshotai/kimi-k2.6` | Kimi K2.6 | 262k; reasoning + tools + vision |
| `@cf/nvidia/nemotron-3-120b-a12b` | Nemotron 3 Super 120B | 256k |
| `@cf/openai/gpt-oss-120b` | GPT OSS 120B | 128k |
| `@cf/openai/gpt-oss-20b` | GPT OSS 20B | 128k |
| `@cf/meta/llama-4-scout-17b-16e-instruct` | Llama 4 Scout | 131k |

Prompt caching interacts with model choice: the reasoning-era Kimi line (k2.6, k2.7-code, k3) carries this repository's recorded cached-input rate (`core/src/prompting/model-profile.ts:34-43`) and benefits from the session-affinity pin. Rest of the catalog unmeasured; read pricing off the account catalog first.

### Rate limits

Every fetch goes through `withRateLimitRetry` (`core/src/providers/rate-limit-retry.ts`): a 429 retries and the turn keeps running. Patient, not budgeted: neither elapsed time nor attempt count ends it; the request follows `Retry-After` until success, definitive failure, or caller cancel.

Classification is narrow: 429 and 529 always count; a 503 counts only when status text, `x-error-code` or body matches overload, capacity, too many requests, or rate limit, and an unreadable 503 propagates rather than reading healthy. Without `Retry-After`: full-jitter draw doubling from 2 s to a 60 s cap (`DEFAULT_BASE_DELAY_MS`, `DEFAULT_MAX_DELAY_MS`). Non-replayable bodies pass through untouched. SDK transport retry pinned at `PROVIDER_SDK_RETRIES = 2`, stated at the `streamText` call so a vendor default cannot move it silently.

`ProviderPacer` (`core/src/providers/pacing.ts`) spaces request starts per shared host. It holds the lane only while awaiting headers, so a request sleeping out `Retry-After` frees capacity for siblings, and `declareWait` joins siblings into one cooldown instead of each starting into a refusing limit.

## Environment Variables

| Variable | Where | Description |
|----------|-------|-------------|
| `CREDENTIAL_ENCRYPTION_KEY` | Wrangler secret | **Required.** Root secret for the user plane: encrypts `user_credentials` at rest and derives the owner capability. Without it no signed-in surface works. |
| `CREDENTIAL_ENCRYPTION_KEY_PREVIOUS` | Wrangler secret | Retired encryption keys (comma-separated), read-only, for a rotation window |
| `WEBHOOK_ROUTE_SECRET` | Wrangler secret | **Required for webhook ingress.** Signs the route capability every public delivery URL carries (`events/webhook-route.ts`). Without it, webhook creation answers 503 and delivery answers 404. Rotating it revokes every issued URL. |
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
| `KINU_ORIGIN` | CLI shell env | Override CLI app origin for alternate deployments |
| `KINU_BASE_URL` | CLI shell env | Advanced direct LLM override for local agents |
| `KINU_AUTH` | CLI shell env | Advanced direct LLM auth override for local agents |
| `KINU_MODEL` | CLI shell env | Override local agent model |
| `KINU_SOURCE_TARBALL` | CLI shell env | Advanced installer/update source override (`cli/routes.ts:957`) |
| `KINU_SOURCE_SHA256` | CLI shell env | Pin a SHA-256 for the source tarball (default: published `.sha256` asset, always verified) |
| Per-call timeout tuning | CLI shell env / wrangler env var | None exposed, and none exists to expose. There is no per-call silence window and no per-turn step or time bound. What ends a call is the provider answering, failing definitively, or the caller cancelling; what ends a turn is the model finishing without tool calls, the mission budget, or an abort. The SDK transport retry is pinned at `PROVIDER_SDK_RETRIES = 2` (`core/src/providers/rate-limit-retry.ts`). |

`SANDBOX_TRANSPORT` is the one `vars` entry `Env` does not declare. Read it from `wrangler.jsonc`, not the type.

## Wrangler Bindings

| Binding | Type | Description |
|---------|------|-------------|
| `OrchestratorAgent` | Durable Object | The workspace agent (extends `ActorAgent` → `Think`) |
| `UserDO` | Durable Object | Per-user profile, CLI tokens, devices, release changes |
| `MonitorDO` | Durable Object | Synthetic monitoring: open incidents + the alert outbox (one instance, `site`) |
| `Sandbox` | Durable Object + Container | `KinuSandbox` (@cloudflare/sandbox); one container per agent |
| `ControlPlaneDO` | Durable Object | The admin surface's singleton (one instance, `site`): a fleet index and an audit log. It holds no business logic, and every action it exposes proxies an existing `@callable` on the object that already owns that state |
| `AUTH_KV` | KV namespace | Sessions, one-time OAuth handoff state, and CLI browser approval state, all of it expiring on its own; identities live in `UserDO`, and so does the one row that says a session is still live and what it stands for — the KV session record is a projection of that row. `kinu-auth`, and `kinu-auth-staging` in staging |
| `LOADER` | Worker Loader | Sandboxed code execution (codemode) |
| `AI` | Workers AI | Platform-side embeddings (chat models use the user's OAuth credential) |
| `MEMORY_VECTORS` | Vectorize | `kinu-memory`, and `kinu-memory-staging` in staging (384-dim, cosine); optional hybrid recall on top of FTS5 |
| `EMAIL` | `send_email` | Outbound Mission Inbox replies and owner notifications |
| `BACKUP_BUCKET` | R2 bucket | Sandbox `/workspace` backups (squashfs archives). `kinu-backups`, and `kinu-backups-staging` in staging, so eval snapshots never land beside real archives |
| `NIMBUS_RUNTIME_CACHE` | R2 bucket | `nimbus-runtime-cache`, the artifact store a hosted workspace installs its toolchain from. Absent means a hosted `python3`, `ruby` or `clang` exits 127 |
| `FEEDBACK_BUCKET` | R2 bucket | `kinu-feedback`, and `kinu-feedback-staging` in staging. Feedback screenshot bytes. A PNG is megabytes, so it never enters a Durable Object row or an analytics blob; the control-plane row carries the object key only |
| `AGENT_METRICS`, `FEEDBACK_MARKERS`, `CONTROL_PLANE_OPS` | Analytics Engine | Fleet metrics, feedback markers, and admin operations. Staging writes `*_staging` datasets, so its panels cannot answer with production's numbers |
| `ASSETS` | Static assets | `dist/client` SPA bundle + CLI source archive downloads |

Two agent classes bind nowhere: `ExplorationAgent` (MCTS branches and heads) and `SubordinateAgent` exist only as facets of `OrchestratorAgent` via the agents SDK's sub-agent mechanism. `ExplorationAgent` still appears in the DO migration list; class registration and binding are separate things.

`compatibility_date` `2025-12-01`, `nodejs_compat`. Migrations are two tags, identical across environments: `v1` registers `OrchestratorAgent`, `ExplorationAgent`, `KinuSandbox`, `UserDO`, `NimbusSession`, `MonitorDO`; `v2` adds `ControlPlaneDO`. Wrangler inherits no `env.*` config, so every binding repeats under `env.staging` even where the two agree.

## Deploy Script

`scripts/deploy.sh` deploys both environments (`bun run deploy`, `bun run deploy:staging`). One Worker: `kinu` in production, `kinu-staging` in staging. `NimbusSession` ships inside it, so there is no separate Nimbus deploy.

```bash
bash scripts/deploy.sh <production|staging>
```

Environments differ in four values: route, wrangler `--env` flag, infrastructure scope, label. Unknown name: exit 2, nothing runs.

### Order of operations

Dirty checkout refused first, so the `/api/health` build SHA always identifies the published bytes. Then environment preflight, Wrangler auth check, and `bun install --frozen-lockfile` when there is no root `node_modules`.

1. **Required pre-deploy gates.** 57, every one unconditional; each is a `run_required_gate` line in `scripts/deploy.sh`, which is the full list. Preflight runs alone first. The other 55 run concurrently, then `gate:infra` runs alone last. `flush_gates` runs up to `nproc / 4` concurrently — each gate is a Bun process with up to four workers, so one outer gate per four hardware threads keeps the aggregate at the machine's thread count. Each gate's verdict is its child's exit status, read with `wait -n -p`: a gate killed by the OOM killer settles as 128+signal and one past the 480s deadline as 124, so a gate that never reports cannot hold the wave open. Coverage: `bun run check`; the deploy contract then continues with build, deploy, and smoke.
2. **Build.** `vite build`, then `scripts/build-cli-source-archive.sh` (tarball, `.sha256`, `kinu-version.json`); fails if any of the three misses `dist/client/downloads/`.
3. **Deploy.** `npx wrangler deploy --tag <sha> --message "kinu <env> <sha>"`, so the published Worker version carries the build sha as a version annotation: Workers Logs tags an invocation with a version id and nothing else, and `npx wrangler versions list` prints the pair. Verifies the `KinuSandbox` binding appears in output and the assets directory reported is the one downloads were staged into.
4. **Smoke test.** HTTP 200 plus app content on the production URL; `/api/health` stamp equals the deployed commit; `/downloads/kinu-version.json` parses; the CLI shim points at the deployed archive; archive downloads with expected files; `.sha256` matches. Stamp checks retry with backoff: edge rollout takes about two minutes, and a stamp that never converges is the real failure.
5. **Summary.** URL, Version ID, build sha.

### Build budget

Two platform limits bound step 2, recorded in `core/src/platform-catalog.ts` (`worker.script_bytes`, `worker.startup_ms`), read from Cloudflare's published limits 2026-08-17. Neither has a gate; re-measure, never derive from memory.

- **Bundle, gzipped.** Cap 10 MB on Workers Paid, 64 MB raw; encoded as 10,000,000 bytes (`MB = 1000 * 1000`, `platform-catalog.ts:217`). Last reading: **7,259.24 KiB gzip, 2026-08-24**, 70.9% of cap, raw upload 27,965.43 KiB. Control plane, three Analytics datasets, feedback flow and profile routing added 120.90 KiB gzip over 2026-08-20's 7,138.34 KiB. Measure after vite build with `bunx wrangler deploy --dry-run`; that prints the enforced `Total Upload / gzip`. Vite's per-chunk `gzip:` understates the total by more than 2x.
- **Startup time.** Limit **1 second** of module top-level evaluation, paid by every cold DO activation. Last reading: **185-252 ms, 2026-08-04**, about a fifth of limit. Raised from 400 ms on 2025-10-10; do not cite 400 ms.

Bundle size charges startup too, so watch gzip.

### Static assets

One assets directory: `packages/cf-backend/dist/client`.

Wrangler follows the redirect the Vite plugin writes to `packages/cf-backend/.wrangler/deploy/config.json`, deploying generated `dist/kinu/wrangler.json` whose `assets.directory` is `../client`. The hand-written `wrangler.jsonc` says `dist/client`; same place, either config publishes the same files. `dist/kinu/assets/` holds code-split chunks attached as Worker modules; nothing there is ever served over HTTP.

Step 2 asserts downloads exist in `dist/client/downloads/`, step 3 asserts wrangler read that directory, so moving the assets dir fails the deploy instead of shipping assetless.

### Build stamp

`scripts/build-cli-source-archive.sh` stamps short HEAD sha into the CLI version (`0.1.0+<sha>`) and writes `dist/client/downloads/kinu-version.json` (`{version, sha, builtAt}`) from that stamped `package.json`. The Worker reads it via `ASSETS` and reports `build` on `GET /api/health`: one unauthenticated GET answers both "which commit is live?" and "did the asset half land?". No stamp means `ok: false`, since a deployment without one has broken download endpoints. Dirty worktree prints a warning; the stamp then describes bytes that did not ship.

### Environment variables

| Variable | Default | Purpose |
|----------|---------|---------|
| `CLOUDFLARE_ACCOUNT_ID` | `f44999d1ddda7012e9a87729eba250f1` | Deploy account |

### Staging

Fully isolated second deployment (`kinu-staging`, own DO namespaces and KV session store, `DEV_USER_EMAIL` headless identity) on https://staging.kinu.run, configured under `env.staging`:

```bash
bun run deploy:staging
```

That is `scripts/deploy.sh staging`, the same script production runs. It exports `CLOUDFLARE_ENV=staging` so Vite generates the config the deploy redirect points at, builds the CLI archive, deploys, and runs the six smoke checks against `staging.kinu.run`. No package deploys itself: `packages/cf-backend` once declared its own `deploy:staging` around a bare `wrangler deploy`, which skipped every gate and both asset checks, and `scripts/deploy.test.ts` now fails if a package script or a document names a second deploy path.

#### Staging deploys itself

`.github/workflows/deploy-staging.yml` runs `bun run deploy:staging` on every push to `main`, once a day, and on demand. The daily run is what catches the account drifting under a Worker nobody touched.

The job holds a Cloudflare credential, so it asks for a GitHub environment and for read-only repository permissions, installs its Lean toolchain from a checksum-verified release, and checks out with no persisted git token. Three things it cannot do for itself:

| Operator setup required | Where | Why the repository cannot do it |
|---|---|---|
| Create an environment named `staging` and move `CLOUDFLARE_API_TOKEN` into it. Add a deployment branch rule for `main`. | GitHub → Settings → Environments | The workflow declares `environment: staging`, which is the only boundary a file in the repository can ask for. Which secret that environment holds, and which branches may use it, are dashboard settings. A repository-level secret of the same name still resolves, so nothing is bound until the secret moves. |
| Mint the token with Edit Cloudflare Workers, plus Workers R2 Storage: Edit, Workers KV Storage: Edit and Vectorize: Edit, scoped to the deploy account. | Cloudflare → My Profile → API Tokens | Nothing in a repository can reduce what an account-scoped token is allowed to do. `scripts/deploy.sh` prints this list when the token is absent, and stops before the build. |
| Create an environment named `eval` and move `EVAL_SERVICE_TOKEN`, `EVAL_ANTHROPIC_API_KEY` and `EVAL_OPENAI_API_KEY` into it. | GitHub → Settings → Environments | Same boundary, for `.github/workflows/eval.yml`. That job can be started by labelling a pull request, so it checks out the reviewed base revision rather than the branch: a branch that changes the eval harness or corpus has to land, or be dispatched from a trusted ref, before it is measured. `validate-corpus` runs the branch's own code and holds no credential. |

`scripts/release-config.test.ts` (required gate) holds these properties: every workflow declares its token permissions, every credential-bearing job names an environment, a credential-bearing job reachable from a pull request pins the base revision, no workflow pipes a download into a shell, and no action is used from a moving ref.

Staging is the only target tests and evals may hit, so before an eval arm spends anything, verify it runs the branch you think:

```bash
bun scripts/staging-preflight.ts            # refuses on a mismatch
bun scripts/staging-preflight.ts --allow-stale
```

Compares `git rev-parse --short HEAD` against `build.sha` from the health endpoint, the pair the deploy asserts post-publish. Mismatch refuses and names `bun run deploy:staging`. Reason, measured: on 2026-08-24 the deployed sha was `17abc2980` with the checkout 27 commits ahead, so an arm run would have graded code nobody had written. `--allow-stale` downgrades to warning for the legit deploy window; the outage it was written for hit a deploy that never passed through it. Hence the scheduled cron (`*/15 * * * *`): `MonitorDO.check()` probes the live origin and emails `OPS_ALERT_EMAIL` via the Mission Inbox outbound path when something breaks.

| Probe | Passes when |
|-------|-------------|
| `health` | `/api/health` returns `ok:true` JSON with a build identifier that matches the one `/downloads/kinu-version.json` advertises |
| `downloads` | `/downloads/kinu-source.tar.gz` hashes to exactly what `…​.sha256` declares. This is the check the installer itself makes |
| `login` | `/login` renders the sign-in page with at least one provider link |

One email per incident: open with one alert, silent while persisting, one recovery notice on close. Delivery rides `EmailOutbox`, so a failed send re-drives with the same Message-ID rather than duplicating or vanishing. Unset `OPS_ALERT_EMAIL` (as in staging) records incidents silently. Staging has no cron trigger: its providers and mail route are absent by design, and probing would report a site missing on purpose.

### Rollback

Assets ride the Worker version, so rollback moves code and published `/downloads/*` together. Version retention is not measured here; `npx wrangler versions list` prints what you can roll back to.

```bash
cd packages/cf-backend
npx wrangler versions list
npx wrangler rollback --version-id <version-id>
```

Then confirm it took, the way the deploy gate does: stamp names the rolled-back commit and downloads still verify.

```bash
curl -s https://kinu.run/api/health | jq '.ok, .build'
curl -fsSL https://kinu.run/downloads/kinu-source.tar.gz -o /tmp/p.tgz
curl -fsSL https://kinu.run/downloads/kinu-source.tar.gz.sha256
sha256sum /tmp/p.tgz
```

`ok: false`, unexpected `build.sha`, or a downloads 404 recovered nothing; redeploy forward with `bun run deploy`. I have not run this rehearsal against production. The commands are `scripts/deploy.sh`'s own, reduced to rollback needs.

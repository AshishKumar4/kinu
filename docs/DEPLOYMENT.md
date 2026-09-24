# Deployment

## Live instance

Kinu runs in one environment, https://kinu.run. There is no staging deployment. Previews live under `<PREVIEW_HOST_SUFFIX>`, one capability hostname per exposed Workspace or Sandbox port. Previews are agent-written HTML, so each port gets its own hostname and the suffix needs wildcard DNS. Sandbox uses the @cloudflare/sandbox SDK hostname. The Workspace uses a Nimbus session capability under the same trust boundary. `packages/core/src/preview/preview-origin.ts` holds the reasoning. The Public Suffix List prerequisite is still open for full cookie-site isolation.

### One origin

One app origin serves the deployment (`workers_dev` is false), so `CLI_PUBLIC_ORIGIN` names it. The Worker redirects cleartext to HTTPS and sends HSTS for that host plus the preview subtree. Any other hostname that reaches the Worker is not an app origin and gets served as nothing.

The preview suffix is `kinu.run` itself, so previews are strict subdomains of the app host, and the `*.kinu.run/*` route matches previews, never the app. The app host is a custom domain (`kinu.run`, `custom_domain: true`).

## Local development

You need [Bun](https://bun.sh/) and Node.js 22 or later (the installed wrangler declares `node >=22.0.0`). You also need a Cloudflare account (for AI Gateway).

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

`bun run dev` runs `vite dev --host 0.0.0.0` in `packages/cf-backend`. Open http://localhost:5173. The Vite cloudflare() plugin runs real Durable Objects through Miniflare. Chat on that URL bills models to the account the Worker runs in. For chat billed to each signed-in user's own account, add `CLOUDFLARE_OAUTH_CLIENT_ID` and `CLOUDFLARE_OAUTH_CLIENT_SECRET` to `.dev.vars`. `DEV_USER_EMAIL` skips auth for headless work.

### CLI

```bash
curl -fsSL 'https://kinu.run/install.sh' | bash
kinu setup
kinu create jarvis --mode cloud --alias jarvis --purpose "A helpful coding assistant"
jarvis "summarize this checkout"
```

From source I run `bun run cli -- setup`, then `bun run cli -- ...`. Origin defaults to `https://kinu.run`. I use `--origin` or `KINU_ORIGIN` for alternate deployments only.

## Zero to production

This assumes an empty Cloudflare account. Three commands do it, and a fourth proves it:

```bash
bun run infra:provision      # the R2 buckets and the Vectorize indexes
bun run deploy               # the Worker, its DO namespaces, container, routes, cron
bun run infra:provision      # the secrets; `wrangler secret put` needs the Worker to exist
bun run gate:infra           # every declared resource exists and is bound
```

`wrangler secret put` refuses on a nonexistent Worker, so on a fresh account the root secret installs only after the first deploy. That is why provisioning runs twice. The second run creates nothing new. `bun run deploy` is the only supported deploy path. Provisioning creates resources and never deploys.

### Before you start

Provisioning cannot create these. A fresh account fails without them. The provisioner prints this list on every run.

| Prerequisite | Why nothing here can create it |
| --- | --- |
| A Cloudflare account on the **Workers Paid** plan | SQLite Durable Objects, Containers, `worker_loaders` and 7-day Workers Logs retention are all plan-gated. No wrangler command reports or changes a plan. |
| The `account_id`, in `packages/cf-backend/wrangler.jsonc` | It names the account. It does not create one. |
| A wrangler login (`npx wrangler login`) with Workers, KV, R2, Vectorize, Containers and Email scopes | Every command below rides it. `npx wrangler whoami` lists what you have. |
| The `kinu.run` **zone**, active on the account the Worker runs in | `zone_name` in `routes` assumes an active zone, and a Workers custom domain only lands in a zone that account holds. wrangler has no DNS command at all. |
| A proxied wildcard DNS record `*.kinu.run` | The `*.kinu.run/*` route matches preview requests. It does not make a preview hostname resolve. Without it every preview URL is NXDOMAIN while the route reads as present. `custom_domain: true` cannot express a wildcard, so this record is made by hand. |
| A **KV namespace** `kinu-auth` | The session store. `wrangler kv namespace create kinu-auth` prints an id you paste into `kv_namespaces`. Provisioning will not run it: KV titles are not unique, so a second run makes a second namespace instead of finding the first. |
| An **AI Gateway** in the same account, named in `AI_GATEWAY_URL` | wrangler has no `ai-gateway` command. Checked 2026-08-19 against both versions this tree installed then, 4.97.0 at the root and 4.123.0 in `packages/cf-backend`: the only `ai-gateway` strings in either binary belong to the bundled REST client. The wrangler OAuth session also carries no `aig` scope, so the REST API answers 403. Dashboard only. |
| OAuth applications at Google, GitHub and/or Cloudflare | Created on three other websites. See § OAuth setup for the exact redirect URLs and scopes. |
| Email Routing onboarding for `EMAIL_DOMAIN` | MX records, a verified destination, and a rule delivering to this Worker. The `send_email` binding is outbound only. See [EMAIL-INGRESS.md](EMAIL-INGRESS.md). |
| A Cloudflare Access application on `/control` | `CONTROL_PLANE_ACCESS_TEAM_DOMAIN` and `CONTROL_PLANE_ACCESS_AUD` pin it. wrangler has no `access` command; `gate:infra` reads it through the Access REST API. Without it the admin plane answers 404 to everyone. |

Universal SSL on `kinu.run` covers the app host and every preview host. I need no Advanced Certificate Manager.

### What each command does

`infra:provision` reads its inventory from `wrangler.jsonc`. There is no second list. It creates what is missing in dependency order (R2 buckets, then Vectorize indexes). It prints `CREATED` or `existed` per resource, so a second run is visibly a no-op. A failed lookup refuses rather than creates: "network down" and "does not exist" differ, and creating through the first would leave two candidate snapshot buckets. What wrangler cannot create prints as a manual worklist on every run.

`gate:infra` checks that every declared resource exists and that the deployed Worker binds it, and exits non-zero otherwise. The deploy script runs it alone, as the last gate before the build. It takes the environment from argv, then `KINU_DEPLOY_ENV`, then defaults to `production`. It reports one verdict per resource instead of dying on the first failure (`scripts/infra-verify.ts` has the reasoning):

| Verdict | Meaning |
| --- | --- |
| `present` | observed to exist |
| `absent` | observed not to exist. Fails when `env.d.ts` declares the field required |
| `unknown` | the lookup failed. Always a failure, because a check that could not look did not pass |
| `unobservable` | no CLI path can confirm it. Declared in `UNOBSERVABLE` with its manual check, and pinned by equality so the blind spot can only shrink |

With no Cloudflare session the verdict is BLOCKED with a non-zero exit.

`bun run infra:teardown production` deletes in reverse dependency order. It refuses without the typed phrase `destroy kinu production`. It prints what sits inside each data-bearing resource before asking. Nothing imports it and no other command reaches it.

### Every value the Worker reads, and where it comes from

This derives from `Env` in `packages/cf-backend/env.d.ts` and from `SUPPLY` in `scripts/infra-manifest.ts`. A field that neither a binding nor a `vars` entry supplies fails `gate:infra` until I record how it is obtained. `wrangler secret list` returns names only. Cloudflare never returns a value.

| Value | Handling | Required | Absent means |
| --- | --- | --- | --- |
| `CREDENTIAL_ENCRYPTION_KEY` | **prompt**: paste one, or press enter and provisioning generates 32 random bytes and displays them **once** | yes | Every signed-in surface answers 503 while public routes answer 200, so the site looks healthy. |
| `WEBHOOK_ROUTE_SECRET` | **prompt**: paste 32 random bytes (`openssl rand -base64 32`) | yes | No workspace can take an inbound webhook. Creating one answers 503, and every delivery URL answers 404 without waking a workspace. Timers and email keep working. |
| `JWT_SECRET` | **prompt**: paste 32 random bytes (`openssl rand -base64 32`) | yes | No Drive. The Mossaic tenant objects sign every listing cursor with it inside the Durable Object, so the Drive page and every `/shared` listing answer 503 (stated up front) instead of the 500 the deployed build answered on 2026-09-21 before the secret existed. |
| `CLOUDFLARE_OAUTH_CLIENT_SECRET` | **prompt** | yes, beside `CLOUDFLARE_OAUTH_CLIENT_ID` | Chat falls back to the platform gateway and bills the **platform** account instead of each user's. |
| `DEV_IDENTITY_SECRET` | **prompt**: 32 random bytes, never shared with another deployment | beside `DEV_USER_EMAIL` | No synthetic identity. The first-run tier and every eval fail to authenticate as `eval-service`. |
| `GOOGLE_OAUTH_CLIENT_SECRET` | **prompt** | where `GOOGLE_OAUTH_CLIENT_ID` is a var | Google is not on `/login`. Unset on kinu.run. |
| `GITHUB_OAUTH_CLIENT_SECRET` | **prompt** | where `GITHUB_OAUTH_CLIENT_ID` is a var | GitHub is not on `/login`. Unset on kinu.run. |
| `CREDENTIAL_ENCRYPTION_KEY_PREVIOUS` | **out of band**: the outgoing key, during a rotation | no | Nothing. It is the read-only half of a rotation. |
| `GOOGLE_OAUTH_CLIENT_ID`, `GITHUB_OAUTH_CLIENT_ID` | **config var**, beside their secrets | no | That provider is not on `/login`. |
| `GOOGLE_OAUTH_SCOPES`, `GITHUB_OAUTH_SCOPES`, `CLOUDFLARE_OAUTH_SCOPES` | **config var**: overrides only | no | The provider default applies (`CLOUDFLARE_WORKERS_AI_SCOPES` in `core/src/providers/cloudflare-oauth.ts`). |
| `MCP_GITHUB_CLIENT_ID`, `MCP_GITHUB_CLIENT_SECRET` | **out of band**: a GitHub OAuth app the owner registers, whose authorization callback URL is `https://<deployment-origin>/api/user/mcp/callback` ([register](https://github.com/settings/applications/new), [remote-server docs](https://github.com/github/github-mcp-server/blob/main/docs/remote-server.md)); the preset asks `repo read:user` | no | The GitHub preset card falls back to a personal-access-token field. |
| `MCP_GOOGLE_CLIENT_ID`, `MCP_GOOGLE_CLIENT_SECRET` | **out of band**: a Google OAuth client created under the Workspace MCP setup, whose authorized redirect URI is `https://<deployment-origin>/api/user/mcp/callback` ([guide](https://developers.google.com/workspace/gmail/api/guides/configure-mcp-server)); the preset asks `https://www.googleapis.com/auth/gmail.readonly` | no | The Gmail preset card is not rendered. It has no token fallback. |
| `ANALYTICS_SQL_API_TOKEN` | **prompt**: Account Analytics Read token | for `/control` metrics queries | Analytics Engine writes continue; the Metrics tab reports that queries are not configured. |
| `CONTROL_PLANE_ADMINS` | **config var**: comma-separated operator email addresses | for `/control` | The control route returns 404 and no admin link appears. |
| `CLOUDFLARE_ACCOUNT_ID` | **config var** | for Analytics Engine queries | The Metrics tab reports that queries are not configured. |

No value is generated silently. The root secret is the only value this repo could mint unattended, and a key nobody has seen nobody can restore. Losing it means every user reconnects every provider. So it stays a prompt at a terminal, shown exactly once.

Three Analytics Engine bindings exist. Cloudflare creates each dataset on first write. Rows retain three months. Writes can sample, so every query in `packages/core/src/obs/analytics/query.ts` weights `_sample_interval`.

### What the binding manifest cannot express

These dependencies have no field in `wrangler.jsonc`. I verified them against the live account on 2026-08-18, unless an entry names its own date. `UNCAPTURED` in `scripts/infra-manifest.ts` carries the same list with a re-check command each.

- AI Gateway `kinu-ai-gateway`: exists only inside the `AI_GATEWAY_URL` string. Nothing here creates or reads it.
- Vectorize geometry: `kinu-memory` needs `--dimensions=384 --metric=cosine`. Wrong width binds fine, then rejects every insert. Provisioning reads the dimension from the embedder in `runtime.ts`, so they cannot drift. The metric lives only in a wrangler.jsonc comment.
- DNS records and zone: wrangler has no DNS command, and the zone DNS API answers 403 under the OAuth token. Verification resolves each name instead.
- KV title: `kv_namespaces` binds by id. `kinu-auth` exists only in the account. `npx wrangler kv namespace list` reports titles.
- Email Routing: verified 2026-08-20. The `kinu.run` zone held zero DNS records, and neither Email Routing nor Email Sending was onboarded, so mail is dead despite a correct binding, var and handler. One-time owner action; [EMAIL-INGRESS.md](EMAIL-INGRESS.md).
- Cron trigger: deploy writes it from `triggers.crons`. No wrangler command reads it back. Declared blind spot.
- Container image: pullable. `containers[].image` names it by digest, `registry.cloudflare.com/<account>/kinu-devbox-block-layer@sha256:3b11f7bf…`. That image is `packages/devbox/block-lower/Dockerfile` built on the upstream base `docker.io/cloudflare/sandbox@sha256:822501de…`, which is `0.12.8` as the registry resolved it on 2026-08-27. A tag is a mutable pointer, and a container restart would otherwise pick up re-pushed bytes with nothing here changed. `scripts/release-config.test.ts` holds the config to that one reference, refuses a tagged one, and holds the declared version equal to `@cloudflare/sandbox` in `packages/cf-backend/package.json`. It cannot pull the image or read a running container. Only a deploy reconciles an image.
- Source maps: `upload_source_maps` is on, and `vite.config.ts` emits maps for every worker environment, never the client. A map in `dist/client` would be TypeScript served from the public origin. Cloudflare remaps uncaught exceptions against them before they reach Workers Logs. Maps travel as separate upload parts that do not count against the 10 MB script budget. No gate proves that Cloudflare remapped a given trace. I read one after a deploy.
- Browser errors reach structured diagnostics. `ErrorBoundary` sends a bounded report to `POST /api/client-errors`. The route requires the session and CSRF checks. It validates the route, error class, and stack-frame grammar. It labels the browser release as `match`, `stale`, `unreported`, or `undeployed`. It emits `client.render_failed` through `diagnostics` to Workers Logs and Analytics Engine. It returns `202`. It creates no application row. The route keeps the report separate from storage failures such as `storage_unavailable` and `row_write_failed`.
- `backups/` reclamation, which must not be a lifecycle rule. Each workspace stores an immutable base layer written once plus a cumulative delta (`backups/<uuid>/data.sqsh`, `.../delta.sqsh`). An age rule bricks every workspace older than itself, so I do not set one. The delta replaces in place, so growth is base plus changed set. Deleting a workspace discards both objects before DO death. That discard is the reclamation path. A DO dying first strands both objects, and nothing collects them today. Restore-time TTL covers the extraction path only (local dev).
- Committed patch on `@cloudflare/sandbox@0.12.8`: makes SDK mount-handler registration merge with subclass handlers instead of replacing them, so an R2 bucket mount cannot unbind KinuSandbox egress/event interception. `bun run gate:patch-parity` (required gate) proves the patches in `patches/` match the tree. A bump regenerates the patch and moves every pin in one commit: the version and digest in `scripts/release-config.test.ts`, the `containers[].image` entry, and the root `overrides` entry for `@cloudflare/containers`. That override exists because the SDK's own `^0.3.5` range resolved to a second, nested copy at 0.3.6, which was the only copy the deployed Worker bound, while both manifests pinned 0.3.7. A bump has to leave manifests, lockfile, installed graph and emitted artifact naming one version. `scripts/nested-container-resolution.test.ts` measures all four.
- No Nimbus package has been patched since 2026-09-14. The published `@nimbus-sh/*` packages carry the library seams, the credentialed `EsbuildService`, the transactional VFS boundary, and the durable port reservation the four earlier patches held.
- Workspace storage mode: with `BACKUP_BUCKET`, `/workspace` restores lazy layers at fixed cost regardless of size. Without container outbound interception (local docker), empty workspaces record extraction mode. Workspaces holding chain layers refuse to start rather than degrade silently.
- The Workers Paid plan, and the account.
- Feedback lifecycle rule: `kinu-feedback` expires `feedback/` after 90 days, set and read back 2026-08-24. The DO keeps pointer and metadata only.

## Cloudflare deployment

### 1. Configure wrangler.jsonc

I set `account_id` in `packages/cf-backend/wrangler.jsonc`:

```jsonc
{
  "account_id": "<your-account-id>",
  // ...
}
```

### 2. Set secrets

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
# rotate on different clocks, this one's URLs live in other people's systems.
openssl rand -base64 32 | bunx wrangler secret put WEBHOOK_ROUTE_SECRET

# The Drive's signing secret. Mossaic's tenant objects read it off their own
# env to sign listing cursors; without it every Drive listing fails inside the
# object. Rotating it invalidates only in-flight cursors (15-minute tokens).
openssl rand -base64 32 | bunx wrangler secret put JWT_SECRET

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

Credentials name the key that sealed them. Rotation is a two-key window with no downtime:

```bash
# 1. keep the outgoing key readable, 2. install the new one
printf '<outgoing-key>' | bunx wrangler secret put CREDENTIAL_ENCRYPTION_KEY_PREVIOUS
openssl rand -base64 32 | bunx wrangler secret put CREDENTIAL_ENCRYPTION_KEY
```

Each UserDO re-seals on next credential access (`packages/core/src/credentials/envelope.ts`). I delete `PREVIOUS` once every account has been active or after a sweep. It takes comma-separated lists, so an interrupted rotation resumes rather than unwinds. Losing a key with rows still sealed is unrecoverable by design; I reconnect those providers.

#### Rotating WEBHOOK_ROUTE_SECRET

Rotating this secret revokes every webhook URL the deployment ever issued, all at once. There is no two-key window. The capability is derived, not stored, so an old URL stops verifying.

```bash
openssl rand -base64 32 | bunx wrangler secret put WEBHOOK_ROUTE_SECRET
```

After it, every external system that posts to a Kinu webhook needs the new URL. I read it from the triggers list: the Supervise Automations block, or `kinu triggers <workspace> list`, which prints the current URL for each webhook row. Trigger rows, secrets and delivery history are untouched; only the URL changes. I rotate on purpose (a leaked URL, an operator handover), not on a schedule.

### 3. Build and deploy

```bash
bun run deploy                # https://kinu.run
```

That runs `scripts/deploy.sh` (§ Deploy script). I never run bare `wrangler deploy`. It skips the gates and the CLI asset check, and production shipped assetless once: downloads served the SPA shell while the site looked fine, killing every fresh install and update on checksum mismatch.

### 4. Custom domain (optional)

Cloudflare Workers Custom Domains API:

```bash
curl -X PUT "https://api.cloudflare.com/client/v4/accounts/<account-id>/workers/domains" \
  -H "Authorization: Bearer <api-token>" \
  -H "Content-Type: application/json" \
  -d '{"hostname":"kinu.yourdomain.com","zone_id":"<zone-id>","service":"kinu","environment":"production"}'
```

I keep Cloudflare Access off the app host. Kinu serves a public landing page and guards the dashboard with its own OAuth session. Access would show unauthenticated users its login before the Worker can serve `/`. The one Access application guards `/control` only, and `gate:infra` (row `access-scope.*`) fails if a broader one appears.

## OAuth setup

Google, GitHub, and Cloudflare OAuth. A provider shows on `/login` only when both id and secret are configured.

### Callback URLs

The Worker matches `/auth/<provider>/callback` (`packages/cf-backend/src/auth/routes.ts:112`). Register these exact redirect URLs per provider:

```text
https://kinu.run/auth/google/callback
https://kinu.run/auth/github/callback
https://kinu.run/auth/cloudflare/callback
```

### Cloudflare OAuth

Response type `Code`, grant `Authorization Code, Refresh Token`, token auth per `CLOUDFLARE_OAUTH_TOKEN_AUTH_METHOD` (`client_secret_basic` on kinu.run). No `openid`. These scopes route billing to each user's own Cloudflare account:

```text
user-details.read account-settings.read ai.write aig.write aig.run offline_access
```

`offline_access` is required. The token endpoint returns a `refresh_token` only when asked for and the grant is enabled. Without it credentials die at access-token expiry and every visit demands a Workers AI reconnect.

`aig.write` (no separate Read scope exists) powers `my-gateway`: gateway listings, stored BYOK keys, Unified Billing balance. I enable it dashboard-side. Users connected before it was added need one re-login.

```bash
bunx wrangler secret put CLOUDFLARE_OAUTH_CLIENT_SECRET
```

Client id and token auth method are non-secret vars in `wrangler.jsonc`. Scope source of truth: `CLOUDFLARE_WORKERS_AI_SCOPES`, `packages/core/src/providers/cloudflare-oauth.ts:33`. Override via `CLOUDFLARE_OAUTH_SCOPES` only.

## Model providers

Billing is why the providers split.

| Provider | Credential | Billed to |
| --- | --- | --- |
| `workers-ai` | the signed-in user's Cloudflare OAuth token | **that user's** Cloudflare account |
| `my-gateway/<provider>/<model>` | the same OAuth token, against the user's own AI Gateway | **that user's** BYOK provider keys or Unified Billing credits |
| `ai-gateway` (platform) | none; the `AI` binding, pre-authenticated in-account | **the account this Worker runs in** |
| `openai` / `anthropic` / `openrouter` / `codex` / `openai-compat` | the user's own stored key | **that user's** provider account |

User chat rides the user credential over HTTPS on purpose. Platform `ai-gateway` covers the fallback when no user credential is reachable, plus embeddings, judges, evals, benches. It uses binding transport and no token. Moving `workers-ai` or `my-gateway` onto the binding would move all user spend to the platform account without any error.

Platform gateway setup: [Dashboard > AI > AI Gateway](https://dash.cloudflare.com/?to=/:account/ai/ai-gateway). I create one (for example `kinu-ai-gateway`) **in the Worker's account** (the binding resolves names in-account only). I point `AI_GATEWAY_URL` at `https://gateway.ai.cloudflare.com/v1/<account-id>/<gateway-name>/workers-ai/v1`.

### The provider registry

Registration order is default-preference order. Cloud (`packages/cf-backend/src/providers/agent-registry.ts:138-151`): `workers-ai`, the user `my-gateway`, platform `ai-gateway` fallback, `codex`, `openai`, `anthropic`, `openrouter`, `openai-compat`, then a dynamic models.dev source. Any catalog id becomes usable given a `<id>.bearer` credential. Extra named OpenAI-compatible credentials surface as specs `openai-compat:<name>/<modelId>`, not registered providers (`packages/cf-backend/src/user/available-models.ts:70-82`).

CLI (`packages/cli-backend/src/model-resolver.ts`): `workers-ai` and `my-gateway` via the signed-in cloud proxy, or direct when `KINU_BASE_URL` names one. `claude` drives your Claude Code binary. Then `opencode`, `codex`, `openai`, `anthropic`, `openrouter`, `openai-compat`. One `openai-compat:<name>` per extra credential. Same dynamic source.

### Model catalogs are live

Model lists come from `https://models.dev/api.json` with a 5-minute cache (`packages/core/src/providers/models-dev.ts:12-14`). They supply context windows and capability flags. Static lists (`WORKERS_AI_FALLBACK_MODEL_CATALOG` in `packages/core/src/providers/workers-ai-catalog.ts`, per-provider `FALLBACK_MODELS`) apply only when that fetch fails, returns non-200, or filters empty. OpenRouter queries its own `/api/v1/models`.

Default model lives once in core: `DEFAULT_WORKERS_AI_MODEL_ID` / `DEFAULT_WORKERS_AI_MODEL_SPEC` (`@cf/zai-org/glm-5.3`, `packages/core/src/providers/workers-ai.ts:3-5`). It is the built-in profile catalog's `default` tier. Seven-entry fallback catalog:

| Model ID | Name | Context |
|----------|------|---------|
| `@cf/zai-org/glm-5.3` | GLM 5.3 | 1,048k; default, reasoning + tools |
| `@cf/deepseek-ai/deepseek-v4-pro-0813` | DeepSeek V4 Pro 0813 | 1,048k; reasoning + tools, paid access required |
| `@cf/moonshotai/kimi-k2.6` | Kimi K2.6 | 262k; reasoning + tools + vision |
| `@cf/nvidia/nemotron-3-120b-a12b` | Nemotron 3 Super 120B | 256k |
| `@cf/openai/gpt-oss-120b` | GPT OSS 120B | 128k |
| `@cf/openai/gpt-oss-20b` | GPT OSS 20B | 128k |
| `@cf/meta/llama-4-scout-17b-16e-instruct` | Llama 4 Scout | 131k |

Prompt caching interacts with model choice. The reasoning-era Kimi line (k2.6, k2.7-code, k3) is flagged `prompt-caching` (`KIMI_CAPABILITIES`, `packages/core/src/prompting/model-profile.ts:47`) and benefits from the session-affinity pin. The rest of the catalog is unmeasured. I read pricing off the account catalog first.

### Rate limits

Every fetch goes through `withRateLimitRetry` (`packages/core/src/providers/rate-limit-retry.ts`). A 429 retries and the turn keeps running. Patient, not budgeted: neither elapsed time nor attempt count ends it. The request follows `Retry-After` until success, definitive failure, or caller cancel.

Classification is narrow. 429 and 529 always count. A 503 counts only when status text, `x-error-code` or body matches overload, capacity, too many requests, or rate limit. An unreadable 503 propagates rather than reading healthy. Without `Retry-After` the wait is a full-jitter draw doubling from 2 s to a 60 s cap (`DEFAULT_BASE_DELAY_MS`, `DEFAULT_MAX_DELAY_MS`). Non-replayable bodies pass through untouched. SDK transport retry is pinned at `PROVIDER_SDK_RETRIES = 2`, stated at the `streamText` call, so a vendor default cannot move it silently.

`ProviderPacer` (`packages/core/src/providers/pacing.ts`) holds requests to a host behind its declared cooldown. `declareWait` joins siblings into one cooldown instead of each starting into a refusing limit. The pacer counts no requests. Workers limits connections waiting for headers to six per invocation and queues the seventh itself. An isolate-wide count made one request wait on another request's release, and workerd cancels such a request as hung: HTTP 500 `error code: 1101` on kinu.run, 2026-09-23.

## Environment variables

| Variable | Where | Description |
|----------|-------|-------------|
| `CREDENTIAL_ENCRYPTION_KEY` | Wrangler secret | **Required.** Root secret for the user plane: encrypts `user_credentials` at rest and derives the owner capability. Without it no signed-in surface works. |
| `CREDENTIAL_ENCRYPTION_KEY_PREVIOUS` | Wrangler secret | Retired encryption keys (comma-separated), read-only, for a rotation window |
| `WEBHOOK_ROUTE_SECRET` | Wrangler secret | **Required for webhook ingress.** Signs the route capability every public delivery URL carries (`events/webhook-route.ts`). Without it, webhook creation answers 503 and delivery answers 404. Rotating it revokes every issued URL. |
| `AI_GATEWAY_URL` | wrangler.jsonc `vars` | Platform AI Gateway endpoint, in the Worker's own account. Names the gateway, upstream provider and endpoint prefix the `AI` binding transport addresses. No token needed. |
| `SANDBOX_TRANSPORT` | wrangler.jsonc `vars` | Container control plane, `rpc`. A stored per-sandbox transport beats this var on a cold start; the var covers a future `getSandbox` that omits the option. |
| `PREVIEW_HOST_SUFFIX` | wrangler.jsonc `vars` | Zone Workspace and Sandbox previews are served under, one capability hostname per exposed port. Requires a proxied wildcard DNS record on that zone plus a `*.<zone>/*` route; the wrangler.jsonc comment has both steps. Every host under it except the app's own serves previews and nothing else. Empty means previews are unavailable. |
| `CLI_PUBLIC_ORIGIN` | wrangler.jsonc `vars` | Origin embedded in installer/setup commands |
| `CLI_APPROVAL_ORIGIN` | wrangler.jsonc `vars` | Browser approval origin for CLI auth |
| `GOOGLE_OAUTH_CLIENT_ID` | wrangler.jsonc `vars` | Google OAuth client id |
| `GOOGLE_OAUTH_CLIENT_SECRET` | Wrangler secret | Google OAuth client secret |
| `GITHUB_OAUTH_CLIENT_ID` | wrangler.jsonc `vars` | GitHub OAuth client id |
| `GITHUB_OAUTH_CLIENT_SECRET` | Wrangler secret | GitHub OAuth client secret |
| `CLOUDFLARE_OAUTH_CLIENT_ID` | wrangler.jsonc `vars` | Cloudflare OAuth client id |
| `CLOUDFLARE_OAUTH_CLIENT_SECRET` | Wrangler secret | Cloudflare OAuth client secret |
| `CLOUDFLARE_OAUTH_SCOPES` | optional override | Defaults to `CLOUDFLARE_WORKERS_AI_SCOPES` in `core/src/providers/cloudflare-oauth.ts` |
| `CLOUDFLARE_OAUTH_TOKEN_AUTH_METHOD` | wrangler.jsonc `vars` | Token endpoint auth method (`client_secret_basic` on kinu.run) |
| `CLOUDFLARE_AI_GATEWAY_ID` | wrangler.jsonc `vars` | User account AI Gateway id for Workers AI routing; defaults to `default` |
| `GOOGLE_OAUTH_SCOPES` / `GITHUB_OAUTH_SCOPES` | optional override | Per-provider scope overrides |
| `EMAIL_DOMAIN` | wrangler.jsonc `vars` | Mission Inbox domain; unset disables email entirely |
| `OPS_ALERT_EMAIL` | wrangler.jsonc `vars` | Where synthetic-monitoring alerts go; unset leaves the monitor silent |
| `CONTROL_PLANE_ADMINS` | wrangler.jsonc `vars` | Operator emails allowed on `/control` |
| `CONTROL_PLANE_ACCESS_TEAM_DOMAIN`, `CONTROL_PLANE_ACCESS_AUD` | wrangler.jsonc `vars` | The Cloudflare Access team and application the `/control` assertion is verified against (`control-plane/access-gate.ts`). Unset or empty means the admin plane answers 404 to everyone |
| `DEV_USER_EMAIL` | wrangler.jsonc `vars` | The eval service identity, `eval-service@kinu.run`. Off localhost it applies only to a request presenting `DEV_IDENTITY_SECRET`, and the admin gate refuses it regardless |
| `DEV_IDENTITY_SECRET` | Wrangler secret | The whole authority for the `DEV_USER_EMAIL` identity, sent in `x-kinu-dev-identity-secret` (core `DEV_IDENTITY_HEADER`; Workers Logs redacts a header whose name contains `secret`) |
| `KINU_ORIGIN` | CLI shell env | Override CLI app origin for alternate deployments |
| `KINU_BASE_URL` | CLI shell env | Advanced direct LLM override for local agents |
| `KINU_AUTH` | CLI shell env | Advanced direct LLM auth override for local agents |
| `KINU_MODEL` | CLI shell env | Override local agent model |
| Per-call timeout tuning | CLI shell env / wrangler env var | None exposed, and none exists to expose. There is no per-call silence window and no per-turn step or time bound. What ends a call is the provider answering, failing definitively, or the caller cancelling; what ends a turn is the model finishing without tool calls, the mission budget, or an abort. The SDK transport retry is pinned at `PROVIDER_SDK_RETRIES = 2` (`core/src/providers/rate-limit-retry.ts`). |

`SANDBOX_TRANSPORT` is the one `vars` entry `Env` does not declare. Read it from `wrangler.jsonc`, not the type.

## Wrangler bindings

| Binding | Type | Description |
|---------|------|-------------|
| `OrchestratorAgent` | Durable Object | The workspace agent (`OrchestratorAgent extends ActorAgent extends Agent<Env>`) |
| `UserDO` | Durable Object | Per-user profile, CLI tokens, devices, release changes |
| `MonitorDO` | Durable Object | Synthetic monitoring: open incidents and the alert outbox (one instance, `site`) |
| `Sandbox` | Durable Object + Container | `KinuSandbox` (@cloudflare/sandbox); one container per agent |
| `ControlPlaneDO` | Durable Object | The admin surface's singleton (one instance, `site`): a fleet index and an audit log. It holds no business logic, and every action it exposes proxies an existing `@callable` on the object that already owns that state |
| `DeployRunDO` | Durable Object | One guided self-deployment per run ([SELF-DEPLOY.md](SELF-DEPLOY.md)): the step ledger and the Cloudflare tokens the run holds until it hands them to the new Worker |
| `MOSSAIC_USER`, `MOSSAIC_SHARD` | Durable Object | The shared Drive's tenant objects (`MossaicUserDO`, `MossaicShardDO`) |
| `AUTH_KV` | KV namespace | `kinu-auth`. Sessions, one-time OAuth handoff state, and CLI browser approval state, all of it expiring on its own. Identities live in `UserDO`, and so does the one row that says a session is still live and what it stands for; the KV session record is a projection of that row |
| `LOADER` | Worker Loader | Sandboxed code execution (codemode) |
| `AI` | Workers AI | Platform-side embeddings (chat models use the user's OAuth credential) |
| `MEMORY_VECTORS` | Vectorize | `kinu-memory` (384-dim, cosine); optional hybrid recall on top of FTS5 |
| `EMAIL` | `send_email` | Outbound Mission Inbox replies and owner notifications |
| `BACKUP_BUCKET` | R2 bucket | `kinu-backups`. Sandbox `/workspace` backups (squashfs archives) |
| `NIMBUS_RUNTIME_CACHE` | R2 bucket | `nimbus-runtime-cache`, the artifact store a hosted workspace installs its toolchain from. Absent means a hosted `python3`, `ruby` or `clang` exits 127 |
| `FEEDBACK_BUCKET` | R2 bucket | `kinu-feedback`. Feedback screenshot bytes. A PNG is megabytes, so it never enters a Durable Object row or an analytics blob; the control-plane row carries the object key only |
| `RELEASES_BUCKET` | R2 bucket | `kinu-releases`. The worker release tarballs the self-deploy flow downloads; absent means `/downloads/kinu-worker-<version>.tar.gz` answers 404 |
| `AGENT_METRICS`, `FEEDBACK_MARKERS`, `CONTROL_PLANE_OPS` | Analytics Engine | Fleet metrics, feedback markers, and admin operations |
| `CF_VERSION_METADATA` | Version metadata | The deployed Worker version; a durable turn claim records it |
| `ASSETS` | Static assets | `dist/client` SPA bundle and prebuilt CLI downloads |

Every workspace agent (main, subordinate, head, swarm node, branch) is a logical actor bound by one `ActorHost` over the workspace object's SQLite. There is no second agent class to bind. Class registration and binding are separate things, and only `OrchestratorAgent` registers as an agent class.

`compatibility_date` `2025-12-01`, `nodejs_compat`. Migrations: `v1` registers `OrchestratorAgent`, `KinuSandbox`, `UserDO`, `MonitorDO` and `ControlPlaneDO` as new SQLite classes and is the genesis of a reset deployment; `v2` adds `DeployRunDO`; `v3` adds `MossaicUserDO` and `MossaicShardDO`. A class added later gets its own tag, and an applied tag is never edited: appending a class to the applied `v1` answered 10061 at upload (measured 2026-09-18). A reset keeps the Worker and resets its classes in place (measured 2026-09-05), because the Worker holds secrets nobody can read back. Deploy a placeholder script under the same name and routes with no Durable Object bindings and one migration `{ deleted_classes: [every class the Worker carries] }`; its `/api/health` answers 200 `{ build: null }` so the infra gate reads the hostname as a stampless Kinu Worker. Then deploy main. The API refuses a delete while a binding still references the class (code 10061) and refuses `new_sqlite_classes` for a class that exists (code 10074), which is why the placeholder deploy stands between the two. A placeholder deployed with `migrations: []` clears the Worker's migration tag, so the genesis deploy that follows applies the tags from `v1`.

## Deploy script

`scripts/deploy.sh` is the one deploy path (`bun run deploy`). It publishes one Worker, `kinu`, to https://kinu.run. Nimbus is held as a library inside the `OrchestratorAgent` that owns each workspace, so there is no separate Nimbus deploy.

```bash
bash scripts/deploy.sh [--bootstrap] [--gates-only] [--all]
```

`--bootstrap` is for the deploy that declares something only a deploy can create (a Durable Object class new to `migrations`, a new container, a new route): the pre-deploy infra phase defers exactly those, and step 5 re-checks everything with no tolerance. `--gates-only` runs every pre-publish wave and stops before the build. `--all` keeps launching after the first red so one run reports every red. Any other argument exits 2 and runs nothing.

### Order of operations

A dirty checkout is refused first, so the `/api/health` build SHA always names the published bytes. Then come the preflight phase, the Wrangler auth check, and `bun install --frozen-lockfile` when there is no root `node_modules`.

1. Required pre-deploy gates. `scripts/deploy.sh` names no gate itself: it loads `bun scripts/ladder.ts --plan`, one tab-separated line per deploy-tier row (phase, label, threads, resident MiB, deadline, command) in phase order, and `run_phase` schedules each phase as one wave with a barrier after it. Preflight runs alone first. The source phase runs concurrently under two caps the machine answers for, `nproc` threads and 75% of `MemAvailable`, against each row's measured cost in `scripts/gate-cost.json` (`bun scripts/gate-cost-measure.ts` runs every row alone and samples its session; no row declares a cost). A row heavier than the whole cap runs alone rather than never. Then `gate:hammer` and `gate:infra` each run alone, in that order. Each gate verdict is its child exit status, read with `wait -n -p`. A gate killed by the OOM killer settles as 128+signal. One past its deadline (the row's own, or 480 s) settles as 124. A gate that never reports cannot hold the wave open. The first red stops new launches and lets running gates finish. `scripts/deploy.test.ts` drives the real script against stub gates over the same plan, proves each of those behaviours, and asserts the script contains no gate command of its own.
2. Build. `vite build`, then `scripts/build-worker-release.ts` (the self-deploy tarball and `release.json`), then `scripts/build-cli-dist.sh` (four platform artifacts, the shared CPython runtime, a `.sha256` for each, and `kinu-version.json`). The build fails if any output misses `dist/client/downloads/`. The worker tarball is over the 25 MiB per-file asset limit, so the script uploads it and its `.sha256` to the `kinu-releases` R2 bucket before the deploy.
3. Deploy. `npx wrangler deploy --tag <sha> --message "kinu production <sha>"`, so the published Worker version carries the build sha as a version annotation. Workers Logs tags an invocation with a version id and nothing else, and `npx wrangler versions list` prints the pair. The step verifies the `KinuSandbox` binding appears in output and the assets directory reported is the one downloads were staged into.
4. Smoke test. HTTP 200 plus app content on `https://kinu.run/`. The `/api/health` stamp equals the deployed commit. `/downloads/kinu-version.json` and `release.json` parse and name that commit, and the worker tarball's `.sha256` matches the signed manifest. The CLI launcher points at the deployed artifacts. Every artifact downloads, unpacks, and matches its published `.sha256`. Stamp checks retry with backoff: edge rollout takes about two minutes, and a stamp that never converges is the real failure.
5. Post-publish tiers. The first-run and trajectory tiers drive the deployed product as the eval service identity, in one wave.
6. Infrastructure verification. `bun scripts/infra-verify.ts production --phase=post-deploy`, the strictest phase, unconditional.
7. Summary. URL, Version ID, build sha.

### Build budget

Two platform limits bound step 2, recorded in `packages/core/src/platform-catalog.ts:1977` (`worker.script_bytes`, `worker.startup_ms`). I read them from the Cloudflare published limits on 2026-08-17. Neither has a gate. I re-measure, never derive from memory.

- Bundle, gzipped. Cap is 10 MB on Workers Paid, 64 MB raw, encoded as 10,000,000 bytes (`MB = 1000 * 1000`, `packages/core/src/platform-catalog.ts:218`). Last reading: **7,259.24 KiB gzip, 2026-08-24**, 70.9% of cap, raw upload 27,965.43 KiB. Control plane, three Analytics datasets, feedback flow and profile routing added 120.90 KiB gzip over the 2026-08-20 reading of 7,138.34 KiB. I measure after vite build with `bunx wrangler deploy --dry-run`, which prints the enforced `Total Upload / gzip`. The Vite per-chunk `gzip:` understates the total by more than 2x.
- Startup time. Limit is **1 second** of module top-level evaluation, paid by every cold DO activation. Last reading: **185-252 ms, 2026-08-04**, about a fifth of the limit. Cloudflare raised it from 400 ms on 2025-10-10. I do not cite 400 ms.

Bundle size charges startup too, so I watch gzip.

### Static assets

One assets directory exists: `packages/cf-backend/dist/client`.

Wrangler follows the redirect the Vite plugin writes to `packages/cf-backend/.wrangler/deploy/config.json`. It deploys generated `dist/kinu/wrangler.json` whose `assets.directory` is `../client`. The hand-written `wrangler.jsonc` says `dist/client`. Same place; either config publishes the same files. `dist/kinu/assets/` holds code-split chunks attached as Worker modules. Nothing there is ever served over HTTP.

Step 2 asserts downloads exist in `dist/client/downloads/`. Step 3 asserts wrangler read that directory. Moving the assets dir fails the deploy instead of shipping assetless.

### Build stamp

`scripts/build-cli-dist.sh` stamps the short HEAD sha into the CLI version (`0.2.0+<sha>`). It writes `dist/client/downloads/kinu-version.json` (`{version, sha, builtAt}`). The bundler inlines the stamp, so the program reports the same string the manifest advertises. The Worker reads the manifest via `ASSETS` and reports `build` on `GET /api/health`. One unauthenticated GET answers both "which commit is live?" and "did the asset half land?". No stamp means `ok: false`, since a deployment without one has broken download endpoints.

### Environment variables

| Variable | Default | Purpose |
|----------|---------|---------|
| `CLOUDFLARE_ACCOUNT_ID` | `f44999d1ddda7012e9a87729eba250f1` | Deploy account |

### CI credentials

`.github/workflows/evals.yml` holds a credential, so its two jobs that read it (`evals`, `diagnose`) ask for the GitHub environment `eval`, and no pull request can start the workflow: it is dispatched after a deploy and measures the deployed build. Two things only an operator can do:

| Operator setup required | Where | Why the repository cannot do it |
|---|---|---|
| Create an environment named `eval` holding `KINU_EVAL_WEB_IDENTITY`, the deployment's `DEV_IDENTITY_SECRET`, which lets a trial act as `eval-service`. | GitHub → Settings → Environments | The workflow declares `environment: eval`, the only boundary a file in the repository can ask for. Which secrets that environment holds is a dashboard setting. |
| For a deploy from CI, mint `CLOUDFLARE_API_TOKEN` with Edit Cloudflare Workers, plus Workers R2 Storage: Edit, Workers KV Storage: Edit and Vectorize: Edit, scoped to the deploy account. | Cloudflare → My Profile → API Tokens | Nothing in a repository can reduce what an account-scoped token may do. `scripts/deploy.sh` prints this list when wrangler is not authenticated, and stops before the build. |

`scripts/release-config.test.ts` (required gate) holds these properties. Every workflow declares its token permissions. Every credential-bearing job names an environment. No pull request can start a credential-bearing job. No workflow pipes a download into a shell. No action is used from a moving ref.

### Eval preflight

Before an eval spends, I check that kinu.run runs the revision I am measuring:

```bash
bun run deploy:preflight                 # refuses on a mismatch
bun run deploy:preflight --allow-stale   # warns instead
```

It compares `git rev-parse --short HEAD` against `build.sha` from the health endpoint, the pair the deploy asserts post-publish. A mismatch refuses and names `bun run deploy`. The reason, measured: on 2026-08-24 the deployed sha was `17abc2980` with the checkout 27 commits ahead, so an arm run would have graded code nobody had written. `--allow-stale` is for measuring a deployment on purpose (a bisect, or reproducing a production report).

### Synthetic monitoring

A cron trigger (`*/15 * * * *`) runs `MonitorDO.check()`, which probes the live origin and emails `OPS_ALERT_EMAIL` through the Mission Inbox outbound path when something breaks.

| Probe | Passes when |
|-------|-------------|
| `health` | `/api/health` returns `ok:true` JSON with a build identifier that matches the one `/downloads/kinu-version.json` advertises |
| `downloads` | Every published CLI artifact hashes to exactly what its `.sha256` declares, the same check the installer makes |
| `login` | `/login` renders the sign-in page with at least one provider link |

One email per incident: one alert on open, silence while it persists, one recovery notice on close. Delivery rides `EmailOutbox`, so a failed send re-drives with the same Message-ID rather than duplicating or vanishing. With `OPS_ALERT_EMAIL` unset the monitor records incidents silently.

### Rollback

Assets ride the Worker version, so rollback moves code and published `/downloads/*` together. I have not measured version retention here. `npx wrangler versions list` prints what I can roll back to.

```bash
cd packages/cf-backend
npx wrangler versions list
npx wrangler rollback --version-id <version-id>
```

Then I confirm it took, the way the deploy gate does: the stamp names the rolled-back commit and downloads still verify.

```bash
curl -s https://kinu.run/api/health | jq '.ok, .build'
curl -fsSL https://kinu.run/downloads/kinu-cli-linux-x64.tar.gz -o /tmp/p.tgz
curl -fsSL https://kinu.run/downloads/kinu-cli-linux-x64.tar.gz.sha256
sha256sum /tmp/p.tgz
```

`ok: false`, an unexpected `build.sha`, or a downloads 404 means the rollback recovered nothing, and I redeploy forward with `bun run deploy`. I have not run this rehearsal against production. The commands are the checks `scripts/deploy.sh` runs, reduced to what a rollback needs.

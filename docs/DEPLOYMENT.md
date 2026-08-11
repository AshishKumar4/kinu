# Deployment

> Maintained by Claude (AI-edited documentation, presented as-is); verify against the code when precision matters.

## Live Instance

**Production:** https://proteus.ashishkumarsingh.com  
**Sandbox previews:** https://proteus.ashishkmr472.workers.dev

The workers.dev hostname serves sandbox previews and nothing else — it is no
longer an app fallback. Previewed apps are agent-written HTML, so they get an
origin with no Proteus session on it; see `PREVIEW_HOSTNAME` below and
`packages/cf-backend/src/lib/preview-origin.ts`.

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

# Create .dev.vars with your AI Gateway credentials
cat > .dev.vars << 'EOF'
AI_GATEWAY_URL=https://gateway.ai.cloudflare.com/v1/<account-id>/<gateway-name>/workers-ai/v1
AI_GATEWAY_AUTH=Bearer <your-token>
EOF

# Start dev server (from repo root)
bun run dev
```

Open http://localhost:5173 in your browser. The Vite cloudflare() plugin runs real Durable Objects locally via Miniflare.

Those two keys get you the platform AI Gateway fallback provider. For the
primary path — models billed to the signed-in user's own Cloudflare account —
you also need `CLOUDFLARE_OAUTH_CLIENT_ID` and `CLOUDFLARE_OAUTH_CLIENT_SECRET`
in `.dev.vars`, or `DEV_USER_EMAIL` to skip auth entirely for headless work.

### CLI

```bash
curl -fsSL 'https://proteus.ashishkumarsingh.com/install.sh' | bash
proteus setup
proteus create jarvis --mode cloud --alias jarvis --purpose "A helpful coding assistant"
jarvis "summarize this checkout"
```

For a source checkout, use `bun run cli -- setup` and `bun run cli -- ...`.
The CLI app origin defaults to `https://proteus.ashishkumarsingh.com`; use
`--origin` or `PROTEUS_ORIGIN` only for alternate deployments.

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

# Set the AI Gateway auth token as a Wrangler secret (encrypted, never in code)
printf 'Bearer <your-token>' | bunx wrangler secret put AI_GATEWAY_AUTH

# OAuth providers appear only when both id and secret are configured.
# Client ids can live in wrangler vars; client secrets must be Wrangler secrets.
printf '<google-client-secret>' | bunx wrangler secret put GOOGLE_OAUTH_CLIENT_SECRET
printf '<github-client-secret>' | bunx wrangler secret put GITHUB_OAUTH_CLIENT_SECRET
printf '<cloudflare-client-secret>' | bunx wrangler secret put CLOUDFLARE_OAUTH_CLIENT_SECRET
```

### 3. Build and Deploy

```bash
bun run deploy                # the only supported production deploy path
```

That runs `scripts/deploy.sh` (see "Deploy Script" below). Do not deploy
production with a bare `wrangler deploy`: it uploads a Worker without checking
that the CLI download assets were built, and production has already shipped
that way once — the site was fine while `/downloads/proteus-source.tar.gz`,
its `.sha256`, and `proteus-version.json` all answered with the SPA shell, so
every fresh install and update died on a checksum mismatch.

### 4. Custom Domain (Optional)

Use the Cloudflare Workers Custom Domains API:

```bash
curl -X PUT "https://api.cloudflare.com/client/v4/accounts/<account-id>/workers/domains" \
  -H "Authorization: Bearer <api-token>" \
  -H "Content-Type: application/json" \
  -d '{"hostname":"proteus.yourdomain.com","zone_id":"<zone-id>","service":"proteus","environment":"production"}'
```

Do not put the custom domain behind Cloudflare Access. Proteus serves a public
landing page and protects the dashboard with its own OAuth session. If an Access
application is attached to `proteus.ashishkumarsingh.com`, unauthenticated users
will see the Access login page before the Worker can serve `/`.

## OAuth Setup

Proteus supports Google, GitHub, and Cloudflare OAuth. A provider is shown on
`/login` only when both its client id and client secret are configured.

### Callback URLs

Register these exact redirect URLs on each provider:

```text
https://proteus.ashishkumarsingh.com/auth/google/callback
https://proteus.ashishkumarsingh.com/auth/github/callback
https://proteus.ashishkumarsingh.com/auth/cloudflare/callback
```

### Cloudflare OAuth

Use response type `Code`, grant type `Authorization Code, Refresh Token`, and
the token authentication method configured by `CLOUDFLARE_OAUTH_TOKEN_AUTH_METHOD`
(`client_secret_basic` in production). Do not request `openid` for Cloudflare
OAuth. Proteus requests these scopes so user-owned Cloudflare billing can power
Workers AI and AI Gateway calls:

```text
user-details.read account-settings.read ai.write aig.write aig.run offline_access
```

`offline_access` is required: `dash.cloudflare.com/oauth2/token` only returns
a `refresh_token` when the authorization request asked for it (and the client
has the Refresh Token grant enabled). Without it the stored credential dies at
access-token expiry and every visit demands a Workers AI reconnect.

`aig.write` (AI Gateway Write — the client offers no separate Read scope) powers the `my-gateway` provider: listing the
user's AI Gateways, their stored BYOK provider keys, and the Unified Billing
credit balance. The OAuth client must have the scope enabled in its dashboard
configuration, and users who connected before it was added need one re-login
to grant it.

Set:

```bash
bunx wrangler secret put CLOUDFLARE_OAUTH_CLIENT_SECRET
```

The production client id and token auth method are non-secret vars in
`packages/cf-backend/wrangler.jsonc`. The scopes' source of truth is the
`CLOUDFLARE_WORKERS_AI_SCOPES` constant in
`packages/cf-backend/src/lib/cloudflare-oauth.ts`; set a
`CLOUDFLARE_OAUTH_SCOPES` var only to override it.

## Model Providers

Web agents run chat models through the **logged-in user's own Cloudflare
account**: the Cloudflare OAuth credential (scopes above) powers Workers AI
calls billed to that user, and the `my-gateway` provider routes third-party
models (`my-gateway/<provider>/<model>`) through the user's own AI Gateway —
paid by the gateway's stored BYOK provider keys or the account's Unified
Billing credits. The platform-level AI Gateway
(`AI_GATEWAY_URL` + `AI_GATEWAY_AUTH`) is the env-configured fallback
provider, and the `AI` binding serves platform-side embeddings. Users can
also attach their own OpenAI / Anthropic / OpenRouter / ChatGPT-Codex
credentials per account.

To set up the platform AI Gateway:

1. Go to [Cloudflare Dashboard > AI > AI Gateway](https://dash.cloudflare.com/?to=/:account/ai/ai-gateway)
2. Create a new gateway (e.g., `proteus-ai-gateway`)
3. Copy the gateway URL: `https://gateway.ai.cloudflare.com/v1/<account-id>/<gateway-name>/workers-ai/v1`
4. Create an API token with Workers AI permissions
5. Set the token as `AI_GATEWAY_AUTH` secret (see above)

### The provider registry

Registration order is the default-preference order. The cloud registers, in
order: `workers-ai`, the user's own `my-gateway`, the platform `ai-gateway`
fallback, `codex`, `openai`, `anthropic`, `openrouter`, `openai-compat` (plus
one `openai-compat:<name>` per extra configured credential), and finally a
**dynamic source backed by the live models.dev catalog** — any provider id there
becomes usable once you store a `<id>.bearer` credential. The CLI registers the
same list minus the dynamic catalog, plus two that only make sense locally:
`claude` (drives your own Claude Code binary) and `opencode`.

### Model catalogs are live

Model lists are fetched from `https://models.dev/api.json` behind a 5-minute
cache (`core/src/providers/models-dev.ts`), which is where each model's context
window and capability flags come from. The static lists —
`WORKERS_AI_FALLBACK_MODEL_CATALOG` in
`packages/cf-backend/src/providers/workers-ai-catalog.ts`, and each provider's
`FALLBACK_MODELS` — are only what you get when that fetch fails, returns
non-200, or filters to nothing. OpenRouter is the exception: it queries its own
`/api/v1/models` instead.

The default model id lives once in `@proteus/core` as
`DEFAULT_WORKERS_AI_MODEL_ID` / `DEFAULT_WORKERS_AI_MODEL_SPEC`
(`@cf/moonshotai/kimi-k2.6`), and is written into the user's `default_model`
config on first Cloudflare sign-in. The Workers AI fallback catalog carries five
entries:

| Model ID | Name | Context |
|----------|------|---------|
| `@cf/moonshotai/kimi-k2.6` | Kimi K2.6 | 262k — default; reasoning + tools + vision |
| `@cf/nvidia/nemotron-3-120b-a12b` | Nemotron 3 Super 120B | 256k |
| `@cf/openai/gpt-oss-120b` | GPT OSS 120B | 128k |
| `@cf/openai/gpt-oss-20b` | GPT OSS 20B | 128k |
| `@cf/meta/llama-4-scout-17b-16e-instruct` | Llama 4 Scout | 131k |

Model choice interacts with prompt caching: as of the 2026-07-13 catalog check,
only `kimi-k2.6` (plus `kimi-k2.7-code` and `glm-5.2`) bills a discounted
cached-input rate, so those are the only Workers AI models where the
session-affinity pin buys anything. The others bill input at full rate
regardless.

### Rate limits

Every provider fetch goes through `withRateLimitRetry`
(`core/src/providers/rate-limit-retry.ts`), so a 429 does not surface as a
failed turn. It retries 429/529 (and overload-shaped 503s) up to 6 attempts
within a 180-second budget, honoring `Retry-After` verbatim when present and
otherwise waiting a full-jitter draw under a ceiling that doubles from 2 s to a
60 s cap. Requests whose body cannot be replayed pass through untouched, and an
exhausted budget returns the original response rather than throwing.

## Environment Variables

| Variable | Where | Description |
|----------|-------|-------------|
| `AI_GATEWAY_URL` | wrangler.jsonc `vars` | AI Gateway endpoint URL |
| `AI_GATEWAY_AUTH` | Wrangler secret | `Bearer <token>` (NEVER in code) |
| `AUTH_DB` | D1 binding | Browser OAuth sessions and identities |
| `PREVIEW_HOSTNAME` | wrangler.jsonc `vars` | Host sandbox previews are served on. **Must not be the app's own host** — preview content is agent-written, and on the app's origin it runs with the owner's session. The Worker serves only `/_preview/*` there, and refuses that path anywhere else. |
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
| `PROTEUS_SOURCE_TARBALL` | CLI shell env | Advanced installer/update source override |
| `PROTEUS_SOURCE_SHA256` | CLI shell env | Pin a SHA-256 for the source tarball (default: published `.sha256` asset, always verified) |
| `PROTEUS_MAX_STEPS` | CLI shell env / wrangler env var | Max tool-call steps (default: 500) |

## Wrangler Bindings

| Binding | Type | Description |
|---------|------|-------------|
| `OrchestratorAgent` | Durable Object | The workspace agent (extends `ActorAgent` → `Think`) |
| `ExplorationAgent` | Durable Object | MCTS branches and heads (Facets) |
| `UserDO` | Durable Object | Per-user profile, CLI tokens, devices, product changes |
| `MonitorDO` | Durable Object | Synthetic monitoring: open incidents + the alert outbox (one instance, `site`) |
| `NIMBUS_SESSION` | Durable Object | `NimbusSession` from `@nimbus-sh/sdk` — built-in lightweight sandbox (local DO class, deployed with this Worker) |
| `Sandbox` | Durable Object + Container | `ProteusSandbox` (@cloudflare/sandbox) — one container per agent |
| `AUTH_DB` | D1 database | OAuth users, sessions, one-time OAuth state, and CLI browser approval state |
| `LOADER` | Worker Loader | Sandboxed code execution (codemode) |
| `AI` | Workers AI | Platform-side embeddings (chat models use the user's OAuth credential) |
| `MEMORY_VECTORS` | Vectorize | `proteus-memory` (384-dim, cosine) — optional hybrid recall on top of FTS5 |
| `EMAIL` | `send_email` | Outbound Mission Inbox replies and owner notifications |
| `BACKUP_BUCKET` | R2 bucket | Sandbox `/workspace` backups (squashfs archives) |
| `ASSETS` | Static assets | `dist/client` SPA bundle + CLI source archive downloads |

`SubordinateAgent` has no binding of its own — it exists only as a facet of
`OrchestratorAgent`, reached through the agents SDK's sub-agent mechanism.

`compatibility_date` is `2025-12-01` with `nodejs_compat`. Durable Object
migrations are three tags in production (`v1` registering `OrchestratorAgent`,
`ExplorationAgent`, `ProteusSandbox`, `UserDO`; `v2` adding `NimbusSession`;
`v3` adding `MonitorDO`) but a **different five-tag sequence** under
`env.staging`, because the two deployments registered their classes in a
different order. Wrangler does not
inherit `env.*` config, so every binding is re-specified there.

## Deploy Script

`scripts/deploy.sh` is the deploy path — `bun run deploy` at the repo root.
Everything ships as one Worker (name `proteus`); `NimbusSession` is a local
DO class deployed with it — there is no separate Nimbus deploy.

```bash
bun run deploy
```

### Order of operations

1. **Pre-deploy verification** — runs `scripts/e2e-test.sh`. Skip with
   `SKIP_E2E=1` for doc-only or config-only deploys.
2. **Build** — `bun install` (if root `node_modules` missing), `vite build`,
   then `scripts/build-cli-source-archive.sh` (CLI source tarball, `.sha256`,
   `proteus-version.json`). Fails if any of the three is missing from
   `packages/cf-backend/dist/client/downloads/`.
3. **Deploy** — `npx wrangler deploy`. Verifies the `ProteusSandbox` binding
   appears in wrangler output, and that the assets directory wrangler reports
   reading is the one the downloads were staged into.
4. **Smoke test** — asserts HTTP 200 + app content on the production URL,
   that `/api/health` reports the build stamp of the commit being deployed,
   that `/downloads/proteus-version.json` parses as JSON for that same build,
   that the CLI shim points at the deployed source archive, that the archive
   downloads and lists expected files, and that the published `.sha256`
   matches the served archive (the shim verifies it by default).
5. **Summary** — prints the URL, Version ID, and build sha.

### Static assets

There is exactly one assets directory: `packages/cf-backend/dist/client`.

`wrangler deploy` follows the redirect the Vite plugin writes to
`packages/cf-backend/.wrangler/deploy/config.json` and deploys the generated
`dist/proteus/wrangler.json`, whose `assets.directory` is `../client`. The
hand-written `wrangler.jsonc` says `dist/client`. Both resolve to the same
place, so the choice of config does not change which files are published.

`dist/proteus/assets/` is not an assets directory — it is the Worker bundle's
code-split chunk output, which wrangler attaches as Worker modules. Anything
written there is never served over HTTP.

Step 2 of the deploy asserts the downloads exist in `dist/client/downloads/`,
and step 3 asserts wrangler read that same directory, so a future config or
plugin change that moves the assets dir fails the deploy instead of silently
shipping an assetless site.

### Build stamp

`scripts/build-cli-source-archive.sh` stamps the short HEAD sha into the CLI
package version (`0.1.0+<sha>`) and writes `dist/client/downloads/proteus-version.json`
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
| `SKIP_E2E` | `0` | `1` to skip pre-deploy E2E tests |

### Staging

A fully isolated second deployment (`proteus-staging`, own DO namespaces and
D1 database, `DEV_USER_EMAIL` headless identity) is configured under
`env.staging` in `wrangler.jsonc`:

```bash
bun run --cwd packages/cf-backend deploy:staging
```

It rebuilds with `CLOUDFLARE_ENV=staging` so the Vite plugin generates the
staging config the deploy redirect points at, then rebuilds for production so
the working tree is not left holding a staging bundle.

### Synthetic monitoring

The deploy smoke gate above only runs at deploy time, and the outage it was
written for happened to a deploy that never went through it. So the same checks
run on a schedule: a cron trigger (`*/15 * * * *` in `wrangler.jsonc`) calls
`MonitorDO.check()`, which probes the live origin and emails `OPS_ALERT_EMAIL`
through the Mission Inbox's outbound path when something breaks.

| Probe | Passes when |
|-------|-------------|
| `health` | `/api/health` returns `ok:true` JSON with a build identifier that matches the one `/downloads/proteus-version.json` advertises |
| `downloads` | `/downloads/proteus-source.tar.gz` hashes to exactly what `…​.sha256` declares — the check the installer itself makes |
| `login` | `/login` renders the sign-in page with at least one provider link |

One email per incident, not per tick: a failing probe opens an incident (one
alert), stays open silently while it keeps failing, and closes with one recovery
notice. Delivery rides `EmailOutbox`, so a send that fails is re-driven with the
same Message-ID rather than lost or duplicated.

Unset `OPS_ALERT_EMAIL` (as in staging) leaves the monitor recording incidents
but silent. Staging also has no cron trigger: its sign-in providers and mail
route are absent on purpose, so probing it would report a site that is missing
by design.

### Rollback

Cloudflare keeps the last 10 Worker versions. Static assets are part of a
version, so a rollback moves the Worker code and the published `/downloads/*`
assets together:

```bash
cd packages/cf-backend
npx wrangler versions list
npx wrangler rollback --version-id <version-id>
```

Then confirm the rollback took, the same way the deploy gate does — the build
stamp must name the commit you rolled back to, and the CLI download path must
still verify:

```bash
curl -s https://proteus.ashishkumarsingh.com/api/health | jq '.ok, .build'
curl -fsSL https://proteus.ashishkumarsingh.com/downloads/proteus-source.tar.gz -o /tmp/p.tgz
curl -fsSL https://proteus.ashishkumarsingh.com/downloads/proteus-source.tar.gz.sha256
sha256sum /tmp/p.tgz
```

A rollback that leaves `ok: false`, an unexpected `build.sha`, or a 404 on the
downloads is not a recovery — redeploy forward with `bun run deploy` instead.
This rehearsal has not been run against production; the commands are the ones
`scripts/deploy.sh` runs, reduced to what a rollback needs.

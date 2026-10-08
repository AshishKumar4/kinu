# Deployment

## Live instance

Kinu runs in two environments on one account. Staging, https://staging.kinu.run (the Worker `kinu-staging`, `env.staging` in `wrangler.jsonc`), is where every deploy lands and the post-deploy tiers run. Production, https://kinu.run (`kinu`), takes only a build staging verified (§ Deploy script). Each has its own Durable Objects, stores and secrets. Staging has no admin plane, no OAuth provider and no mail; the eval identity is its only way in, granted only to a request presenting staging's own `DEV_IDENTITY_SECRET`, never to a caller without it (KINU-001 in the owner's hardening audit). Provisioning mints each deployment's secret, so staging's never acts on production. Previews live under `<PREVIEW_HOST_SUFFIX>`, one capability hostname per exposed Workspace or Sandbox port. Previews are agent-written HTML, so each port gets its own hostname and the suffix needs wildcard DNS. Sandbox uses the @cloudflare/sandbox SDK hostname. The Workspace uses a Nimbus session capability under the same trust boundary. `packages/core/src/preview/preview-origin.ts` holds the reasoning. The Public Suffix List prerequisite is still open for full cookie-site isolation.

### One origin per environment

One app origin serves each deployment (`workers_dev` is false), so its `CLI_PUBLIC_ORIGIN` names it. The Worker redirects cleartext to HTTPS and sends HSTS for that host plus the preview subtree. Any other hostname that reaches the Worker is not an app origin and gets served as nothing.

The preview suffix is the app host itself, so previews are strict subdomains of it. Production's app host is a custom domain (`kinu.run`, `custom_domain: true`), and the `*.kinu.run/*` route matches its previews, never the app. Staging's app host and previews are both routes, `staging.kinu.run/*` and `*.staging.kinu.run/*`: a route runs before a Custom Domain on a hostname both match, so production's wildcard would answer a staging Custom Domain, while between two routes the most specific pattern wins (Workers routing docs).

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

This assumes an empty Cloudflare account. Two commands bring up each environment, staging first because every build lands there, and a third proves it:

```bash
bun run infra:provision staging      # staging's R2 buckets, Vectorize index and secrets
bun run deploy --bootstrap           # kinu-staging, its DO namespaces, containers, routes, cron
bun run gate:infra staging           # every resource staging declares exists and is bound

bun run infra:provision production   # the same for production
bun run deploy --promote --bootstrap # kinu, from the build staging verified
bun run gate:infra production
```

On an environment with no Worker yet, `wrangler secret put` creates a placeholder Worker to hold the secrets, so the deploy's upload gate finds them and no Kinu version is live without them. The first deploy replaces the placeholder. It passes `--bootstrap` because it declares everything only a deploy can create; its post-deploy check tolerates nothing. Later deploys drop the flag. `bun run deploy` is the only supported deploy path. Provisioning creates resources and secrets and never deploys Kinu.

### Release signing

A source self-host needs its own Ed25519 signing key before the first distribution build. I generate it on the build machine, from the repository root:

```bash
bun scripts/release-signing-key.ts
```

`scripts/release-signing-key.ts` writes a PKCS#8 base64 private key to `~/.config/kinu/release-signing.key` with mode `0600`. It prints the path and `RELEASE_SIGNING_PUBLIC_KEY=<64 hex characters>`, never the private key, and refuses an existing file. `KINU_RELEASE_SIGNING_KEY_FILE` chooses another path; I set it for generation and every later build. The private key belongs in a backup or build-runner secret store, never in source or Worker secrets. Staging and production use the same signed artifacts, so the key belongs to the build machine, not one deployment environment.

I replace `RELEASE_SIGNING_PUBLIC_KEY` in both `packages/core/src/http/release-signing.ts` and `packages/pc-agent/src/update.js` with that printed hex value. Core's pin reaches the served installer launcher and the bundled CLI; the daemon ships its own copy. Both must name the new key.

```bash
unset KINU_RELEASE_SIGNING_PUBLIC_KEY
bun scripts/sign-release.ts --check
```

The check signs a probe and verifies it against the source pin. I commit both pins with the deployment configuration and push the revision before the supported deploy path runs. `KINU_RELEASE_SIGNING_PUBLIC_KEY` overrides verification only in the operator's process; setting it on a builder alone does not change the pins clients ship. It is useful for distribution fixtures, not a substitute for this bootstrap. A client already installed with another key does not acquire trust in the new one through this procedure.

For CI, `KINU_RELEASE_SIGNING_KEY` supplies the private key as PKCS#8 base64 and takes precedence over the configured key file. `scripts/build-cli-dist.sh` runs `sign-release.ts --check` before creating output or bundling. The final `sign-release.ts <out dir> <version> <sha>` signs the artifact checksums and verifies the signature again before writing `kinu-version.json`. Missing keys or pins and key/pin mismatches refuse the build with the bootstrap instructions. Installer, CLI and daemon verification still refuse unsigned, foreign-signed, or checksum-mismatched artifacts.

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

Universal SSL on `kinu.run` covers both app hosts and production's previews. Staging adds four, made once in the dashboard of the `kinu.run` zone:

| Staging prerequisite | Why nothing here can create it |
| --- | --- |
| No DNS record of its own for `staging.kinu.run` | `kinu-staging`'s first deploy makes `staging.kinu.run` a Custom Domain, and wrangler creates its record then; one already there refuses it. The Custom Domain's certificate covers `staging.kinu.run` and `*.staging.kinu.run`, which a staging preview needs: it is two labels below `kinu.run`, where Universal SSL stops, and `kinu.run` sends HSTS with `includeSubDomains`. |
| A proxied wildcard DNS record `*.staging` (A `192.0.2.1`, like the zone's `*`) | A wildcard does not answer below a name that exists, so `*.kinu.run` stops short of staging's previews. |
| A **KV namespace** `kinu-auth-staging` | The same reason as `kinu-auth`. Its id is in `env.staging`. |
| An **AI Gateway** `kinu-ai-gateway-staging`, with `default`'s settings | The same reason as production's: staging's gateway logs are its own. |

### What each command does

`infra:provision` reads its inventory from `wrangler.jsonc`. There is no second list. It creates what is missing in dependency order (R2 buckets, then Vectorize indexes). It prints `CREATED` or `existed` per resource, so a second run is visibly a no-op. A failed lookup refuses rather than creates: "network down" and "does not exist" differ, and creating through the first would leave two candidate snapshot buckets. What wrangler cannot create prints as a manual worklist on every run.

`gate:infra` checks that every declared resource exists and that the deployed Worker binds it, and exits non-zero otherwise. The deploy script runs it before the build, in the upload phase beside the secret scan, whose red stops the deploy. Its one argument names the environment, `production` or `staging`; without one it takes `KINU_INFRA_ENVIRONMENT`, which the deploy script always sets, and then production; staging reads `env.staging` in `wrangler.jsonc` the way Wrangler does, and refuses one that names no routes of its own. `infra:provision` and `infra:teardown` take the same argument. It reports one verdict per resource instead of dying on the first failure (`scripts/infra-verify.ts` has the reasoning):

| Verdict | Meaning |
| --- | --- |
| `present` | observed to exist |
| `absent` | observed not to exist. Fails when `env.d.ts` declares the field required |
| `unknown` | the lookup failed. Always a failure, because a check that could not look did not pass |
| `unobservable` | no CLI path can confirm it. Its kind is declared in `UNOBSERVABLE` with the manual check, and pinned by equality so the blind spot can only shrink |

With no Cloudflare session the verdict is BLOCKED with a non-zero exit.

`bun run infra:teardown [staging]` deletes in reverse dependency order. It refuses without the typed phrase `destroy <worker>` (`destroy kinu`, `destroy kinu-staging`). It prints what sits inside each data-bearing resource before asking. Nothing imports it and no other command reaches it.

### Every value the Worker reads, and where it comes from

This derives from `Env` in `packages/cf-backend/env.d.ts` and from `SUPPLY` in `scripts/infra-manifest.ts`. A field that neither a binding nor a `vars` entry supplies fails `gate:infra` until I record how it is obtained. `wrangler secret list` returns names only. Cloudflare never returns a value.

| Value | Handling | Required | Absent means |
| --- | --- | --- | --- |
| `CREDENTIAL_ENCRYPTION_KEY` | **prompt**: paste one, or press enter and provisioning generates 32 random bytes and displays them **once** | yes | Every signed-in surface answers 503 while public routes answer 200, so the site looks healthy. |
| `WEBHOOK_ROUTE_SECRET` | **prompt**: paste 32 random bytes (`openssl rand -base64 32`) | yes | No workspace can take an inbound webhook. Creating one answers 503, and every delivery URL answers 404 without waking a workspace. Timers and email keep working. |
| `JWT_SECRET` | **prompt**: paste 32 random bytes (`openssl rand -base64 32`) | yes | No Drive. The Mossaic tenant objects sign every listing cursor with it inside the Durable Object, so the Drive page and every `/shared` listing answer 503 (stated up front) instead of the 500 the deployed build answered on 2026-09-21 before the secret existed. |
| `CLOUDFLARE_OAUTH_CLIENT_SECRET` | **prompt** | yes, beside `CLOUDFLARE_OAUTH_CLIENT_ID` | Chat falls back to the platform gateway and bills the **platform** account instead of each user's. |
| `DEV_IDENTITY_SECRET` | **prompt**: minted there, 32 random bytes shown once; a pasted value is refused, so no two deployments share one | beside `DEV_USER_EMAIL` | No synthetic identity. The first-run tier and every eval fail to authenticate as `eval-service`. |
| `GOOGLE_OAUTH_CLIENT_SECRET` | **prompt** | where `GOOGLE_OAUTH_CLIENT_ID` is a var | Google is not on `/login`. Unset on kinu.run. |
| `GITHUB_OAUTH_CLIENT_SECRET` | **prompt** | where `GITHUB_OAUTH_CLIENT_ID` is a var | GitHub is not on `/login`. Unset on kinu.run. |
| `CREDENTIAL_ENCRYPTION_KEY_PREVIOUS` | **out of band**: the outgoing key, during a rotation | no | Nothing. It is the read-only half of a rotation. |
| `GOOGLE_OAUTH_CLIENT_ID`, `GITHUB_OAUTH_CLIENT_ID` | **config var**, beside their secrets | no | That provider is not on `/login`. |
| `GOOGLE_OAUTH_SCOPES`, `GITHUB_OAUTH_SCOPES`, `CLOUDFLARE_OAUTH_SCOPES` | **config var**: overrides only | no | The provider default applies (`CLOUDFLARE_WORKERS_AI_SCOPES` in `core/src/providers/cloudflare-oauth.ts`). |
| `MCP_GITHUB_CLIENT_ID`, `MCP_GITHUB_CLIENT_SECRET` | **out of band**: a GitHub OAuth app the owner registers, whose authorization callback URL is `https://<deployment-origin>/api/user/mcp/callback` ([register](https://github.com/settings/applications/new), [remote-server docs](https://github.com/github/github-mcp-server/blob/main/docs/remote-server.md)); the preset asks `repo read:user` | no | The GitHub preset card falls back to a personal-access-token field. |
| `MCP_GOOGLE_CLIENT_ID`, `MCP_GOOGLE_CLIENT_SECRET` | **out of band**: a Google OAuth client created under the Workspace MCP setup, whose authorized redirect URI is `https://<deployment-origin>/api/user/mcp/callback` ([guide](https://developers.google.com/workspace/gmail/api/guides/configure-mcp-server)); the preset asks `https://www.googleapis.com/auth/gmail.readonly` | no | The Gmail preset card is not rendered. It has no token fallback. |
| `ANALYTICS_SQL_API_TOKEN` | **prompt**: Account Analytics Read token | for `/control` metrics queries | Analytics Engine writes continue; the Metrics tab reports that queries are not configured. |
| `DEVBOX_REGISTRY_TOKEN` | **prompt**: a token the owner mints with one scope, Account · Containers · Edit | yes | Boxes keep the snapshots of lineages nothing can wake again until they lapse after 30 days. Containers-scoped because a box deletes those snapshots' registry tags (D65), and only that scope can mint the registry credentials a delete takes (`snapshot-registry.ts`); no binding reaches the registry. |
| `KINU_OBS_TOKEN` | **prompt**: a token the owner mints with one scope, Account · Workers Observability · Read | for the monitor's platform-kill alert | The monitor cannot see out-of-memory or wall-time kills and sends one `fleet.sources` alert naming this secret. |
| `SIGN_IN_PROVIDERS` | **config var**: comma-separated provider ids `/login` must offer (`cloudflare` on production, empty on staging) | yes, even when empty | `gate:infra` refuses a declared provider whose client id or secret is missing, and the monitor's `login` probe fails when one is not configured or not offered. Without the declaration a deployment that lost its OAuth secrets would render the sign-in-unavailable page and pass. |
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
- Container image: `KinuDevbox` runs on the `durable_object` scheduling policy with no image of its own: each box starts from `cloudflare/debian-trixie`, or from a golden snapshot of it with the pinned tools tarball installed (D65, D72), and chooses its instance size at start (D50). The tarball (`packages/devbox/block-lower/upstream.json`) carries an offline Debian repository for s3fs, squashfuse's runtime and the desktop, the Sandbox 1.0.0 shim, squashfuse and the block lower; it is built on armada by `bun scripts/devbox-tools.ts build`, with no Docker (D78). `scripts/release-config.test.ts` checks the pin against this tree's sources and that no devbox host prepares an image.
- Source maps: `upload_source_maps` is on, and `vite.config.ts` emits maps for every worker environment, never the client. A map in `dist/client` would be TypeScript served from the public origin. Cloudflare remaps uncaught exceptions against them before they reach Workers Logs. Maps travel as separate upload parts that do not count against the 64 MiB Worker size limit; their own limit is 15 MB gzipped. No gate proves that Cloudflare remapped a given trace. I read one after a deploy.
- Browser errors reach structured diagnostics. `ErrorBoundary` sends a bounded report to `POST /api/client-errors`. The route requires the session and CSRF checks. It validates the route, error class, and stack-frame grammar. It labels the browser release as `match`, `stale`, `unreported`, or `undeployed`. It emits `client.render_failed` through `diagnostics` to Workers Logs and Analytics Engine. It returns `202`. It creates no application row. The route keeps the report separate from storage failures such as `storage_unavailable` and `row_write_failed`.
- `backups/` reclamation, which must not be a lifecycle rule. Each workspace stores an immutable base layer written once plus a cumulative delta (`backups/<uuid>/data.sqsh`, `.../delta.sqsh`). An age rule bricks every workspace older than itself, so I do not set one. The delta replaces in place, so growth is base plus changed set. Deleting a workspace discards both objects before DO death. That discard is the reclamation path. A DO dying first strands both objects, and nothing collects them today. Restore-time TTL covers the extraction path only (local dev).
- Native Devbox has no Sandbox or Containers patch. It owns `ctx.container` and uses first-party Files and S3Mount. The mount's S3 requests are answered by `DevboxStoreGateway` from the `BACKUP_BUCKET` binding, so no S3 key pair exists for it (D41). D38-D41 record the measurements and remaining deployed checks.
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
# Workers Observability read token (one scope: Account · Workers Observability · Read).
# The monitor reads invocation kills with it; `scripts/prod-logs.ts` reads the same name.
printf '<workers-observability-read-token>' | bunx wrangler secret put KINU_OBS_TOKEN
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

#### Built-in sign-in (self-hosting without an OAuth app)

A deployment that declares no OAuth provider signs in with its own accounts: a password or a passkey. "Declares" means any of the `*_OAUTH_CLIENT_ID` / `*_OAUTH_CLIENT_SECRET` names set to a non-empty value, or a non-empty `SIGN_IN_PROVIDERS`. A declared provider that is broken (an id without its secret) leaves sign-in unavailable rather than falling back to built-in accounts. The default `wrangler.jsonc` declares Cloudflare (`CLOUDFLARE_OAUTH_CLIENT_ID`, `SIGN_IN_PROVIDERS`), so a self-hosted deployment clears both for built-in sign-in.

The first account becomes the deployment's owner, and only a request carrying the setup token may create it. Generate a long random token in your password manager, keep it there, and set it as a secret:

```bash
bunx wrangler secret put KINU_SETUP_TOKEN
```

Then open `https://<your-host>/login`, type the token into the "Setup token" field, and create the owner account. The token is never put in a URL: the page sends it only in the body of the sign-up or reset request.

After that, people join only through invite links the owner makes in Settings → Account → Invite people. Each link names one email address, works once, and expires after 7 days. Keep the token: it is the owner's recovery. With an owner, "Set up or recover the owner" on `/login` takes the token and resets the owner's sign-in (new password or passkey, every owner session ended), throttled like sign-up. Without the token set, `/login` offers sign-in only.

Built-in accounts have their own ids, unrelated to any OAuth login of the same address: configuring OAuth later makes OAuth sign-in a separate account, and built-in sessions stop working once any provider is declared. Passwords are PBKDF2-SHA256 at 100,000 iterations (the most Cloudflare's runtime runs), salted per account and peppered with a key derived from `CREDENTIAL_ENCRYPTION_KEY`. During a key rotation a password still verifies against `CREDENTIAL_ENCRYPTION_KEY_PREVIOUS` and is re-hashed under the new key at that sign-in. For a forgotten password, a lost passkey, or an account that did not sign in during a rotation, the owner makes a reset link in Settings → Account → Accounts: it works once, within 7 days, for that account's address, replaces its password and passkeys with the one set through it, and signs the account out everywhere. Passkeys need a domain: browsers refuse them on an IP address.

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

Model lists come from `https://models.dev/api.json` with a 5-minute cache (`packages/core/src/providers/models-dev.ts:12-14`). They supply context windows and capability flags. Static lists (`WORKERS_AI_FALLBACK_MODEL_CATALOG` in `packages/core/src/providers/workers-ai-catalog.ts`, per-provider `FALLBACK_MODELS`) apply only when that fetch fails, returns non-200, or filters empty, and the model menu then names the failure beside them (`StaleModelList`). Codex's `/models` is read the same way; chatgpt.com answers Workers egress with an HTTP 403 HTML block page before sign-in (probe Worker, 2026-09-24), which Kinu reports as a refused network, not a login problem. OpenRouter queries its own `/api/v1/models`.

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

Every fetch goes through `withRateLimitRetry` (`packages/core/src/providers/rate-limit-retry.ts`). A 429 waits out `Retry-After` and retries, at most the owner's retry count (Settings → Models → Retries, `ProfileCatalog.retries`, default 3); then the call fails with the limit. A model with a fallback chain entry still left retries nothing: it hands the turn to the next model at once and sits out a cooldown (its `Retry-After`, else 5 minutes), and the first turn after the cooldown returns to it (`packages/core/src/providers/fallback-cooldown.ts`, after oh-my-pi's `cooldown-expiry`). A model's own chain (`ProfileCatalog.modelFallbacks`) runs instead of its tier's. One exception, after oh-my-pi's `maxRetryDelayMs`: a `Retry-After` above 60 s means the provider declared the account spent until then (OpenCode Go asked for 729883 s on kinu.run, 2026-09-24), so the call fails at once as `budget` with the reset time and the provider's message, and siblings that meet that cooldown fail the same way instead of parking.

Classification is narrow. 429 and 529 always count. A 503 counts only when status text, `x-error-code` or body matches overload, capacity, too many requests, or rate limit. An unreadable 503 propagates rather than reading healthy. Without `Retry-After` the wait is a full-jitter draw doubling from 2 s to a 60 s cap (`DEFAULT_BASE_DELAY_MS`, `DEFAULT_MAX_DELAY_MS`). Non-replayable bodies pass through untouched. SDK transport retries take the same count at the `streamText` call: the owner's retries on the chain's last model, none before it, so a vendor default cannot move it.

`ProviderPacer` (`packages/core/src/providers/pacing.ts`) holds requests to a host behind its declared cooldown. `declareWait` joins siblings into one cooldown instead of each starting into a refusing limit. The pacer counts no requests. Workers limits connections waiting for headers to six per invocation and queues the seventh itself. An isolate-wide count made one request wait on another request's release, and workerd cancels such a request as hung: HTTP 500 `error code: 1101` on kinu.run, 2026-09-23.

### Provider limits

`/stats` in the TUI and Settings → Usage on the web open with what each connected account has left, read from the
provider (`packages/core/src/providers/usage-limits.ts`, after OMP `packages/ai/src/usage/*.ts`): a Claude sign-in
from `api.anthropic.com/api/oauth/usage` (5-hour and weekly), a ChatGPT sign-in from `chatgpt.com/backend-api/wham/usage`
(its two plan windows, through the connected machine on kinu.run), an OpenRouter key from `GET /api/v1/key` (USD credit), and an
OpenCode Go key from `opencode.ai/zen/go/v1/usage` (5-hour, weekly, monthly; first-party but undocumented, and marked so).
Each read is cached 5 minutes per credential, in memory only (`/stats refresh` or Read again asks now). A failed read
shows the last answer with its age, or, with none, is named under "could not be read"; never a zero.

### Codex from the cloud

chatgpt.com refuses Workers egress: measured 2026-09-24 with throwaway probes and no credential, a Worker's fetch (egress 2a06:98c0:3600::103) got an HTTP 403 block page before sign-in. So no chatgpt.com call from kinu.run (the Codex model list, turns and plan usage) leaves from a Worker: the account's connected machine carries every one of them (below), and with none connected the call is refused. No container carries them (owner, 2026-10-07): the per-user `CodexEgress` container is deleted, both for its image (whose `policy.mjs` the server user could not read, so every forward failed) and because a container per user was what the owner had asked to avoid (m1763). The web Codex sign-in stays: its device-code exchange talks to `auth.openai.com`, which Workers reach, and it is how a `codex.oauth` credential gets into the account; the machine forwards the cloud's bearer token on each call.

The route is chosen in one place, `deviceRouteFetch` (`packages/cf-backend/src/egress/model-relay-route.ts`), which is the Codex provider's `egress` transport for turns, the model list and plan usage. It asks the UserDO for `relayDevice(caller, 'codex')`: the first connected machine whose HELLO lists `codexRelay` among its features. No machine means the call is refused, in the words "Codex calls from kinu.run go through your connected machine; connect one, or pick ChatGPT (Sign in with ChatGPT)". Inside a turn, the first Codex call picks and the turn keeps that route, keyed by the turn's identity (actor, run and turn ids from `activeOperationProfile()`), so every scope the live turn opens (a tool, a profile lane) gets the same route and a turn never switches silently. A call writes the pin only when its turn is the actor's in-flight turn, which the workspace object reads from the actor's session (`currentTurnOf` on the actor object, passed to `OwnedModelServices` and to each runtime's profile lanes). Any other call, such as a background job that outlived its turn, picks a route for itself and writes nothing, so it never moves the live turn; either route spends the same UserDO-held token. The next turn's first call replaces a finished turn's pin, so the map holds one entry per actor. A failed pick changes only its own turn's entry. The profile lanes a turn uses (judge, fast, advisor, reflection) read the same seam, so they follow the turn's route; plan usage and the model list run outside any turn and pick per call. A machine lost mid-turn fails that step, not retryable, with "<machine> went offline during this turn, and Codex keeps one route per turn. Send again to continue." The next turn picks again. A machine that connects mid-turn is used from the next turn. The pin lives in the workspace object's memory, so a turn resumed after the object restarts picks again.

The machine relays with one deadline-free RPC, `codexRelay` (`{ method, url, headers, body }`), over the device tunnel. The daemon (`packages/pc-agent/src/index.js`) checks the same allow-list as `codexEgressAllowed` and also refuses a URL with credentials. It drops hop-by-hop, `cf-*` and `x-kinu-*` headers, fetches with `redirect: 'manual'`, and sends the answer back as `RELAY_HEAD` once and one `RELAY_BODY` (base64) per upstream chunk, so the stream arrives as chatgpt.com sends it. The RPC answer ends the body. The tunnel's one `cancel` method, naming the relay's request id, aborts the upstream fetch and answers once it has ended; a relay the UserDO's eviction cut is cancelled the same way when the hub wakes, and its reader fails with the interruption. The hub side is `DeviceRelays` in core `execution/device-relay.ts`, reached through `UserDO.relayModelCall` / `cancelModelRelay`, gated on the `credentials.model` tier. The daemon receives only the access-token headers of that one call. It logs no header or body and writes nothing to disk. The refresh token stays in the UserDO, which alone renews the login, one refresh at a time per login (`refreshOAuthCredential`). A 401 through either route goes back to the provider, which asks the UserDO once, naming the headers that were refused (`rejected`), and resends on the same route. The UserDO refreshes only while the stored login is still the refused one, so two turns refused on the same old token spend its refresh token once. Each step records the route in `step_finish.egress` (`device <device id>` or `relay`; the header is ASCII whatever the machine is named, and the name is read from the device list where it is shown, so a rename never rewrites a record), and each turn emits `codex.route_pinned`. Proof: `unit-codex-device-turn.test.ts` (a Codex turn on the real hosted root: the pin reads the root's live turn, and a side call inside it keeps the turn's route while a machine connects), `unit-codex-device-route.test.ts` (routing, pin, lost machine, one refresh for two turns), `unit-pc-agent-codex-relay.test.ts` (the shipped daemon behind a TLS-terminating proxy that plays a recorded chatgpt.com: streaming, token, Stop, allow-list parity with core), and `unit-device-hub.test.ts` (frames). Not yet measured: a relayed turn against the real chatgpt.com, which needs the owner's own ChatGPT login.

### ChatGPT plan

Every account can use its ChatGPT plan (Sign in with ChatGPT, provider `chatgpt`). The owner signs in one of two ways.

Through a machine. The daemon signs in itself: `chatgptSignIn` answers an authorize URL whose redirect is `127.0.0.1` on that machine, so a browser there must open it. The token stays in `pc-agent.chatgpt.json` (0600). Calls to `api.openai.com` (`GET /v1/models`, `POST /v1/responses`) ride the `codexRelay` RPC, and the daemon attaches its own token and rotates it on a 401. `POST /api/user/chatgpt/sign-in` starts the sign-in. With no machine connected it answers `waiting_for_machine`, and the next machine to say HELLO opens it (`UserDO.continueChatGptSignIn`). `GET /api/user/chatgpt` then shows the URL under `machineSignIn`.

By paste-back, with no machine. `POST /api/user/chatgpt/paste/start` answers the authorize URL. The account's object makes the state, nonce and PKCE verifier and keeps them. The redirect is `http://127.0.0.1:1455/auth/callback`, where nothing listens: the browser's failed load leaves that address in its bar, and the owner pastes it to `POST /api/user/chatgpt/paste/finish`. The object checks the state, exchanges the code with the verifier, checks the ID token against OpenAI's published keys (issuer, audience is the issued client, expiry, nonce) and checks that the granted scopes include `chatgpt.tokens.use.direct`. Then it stores the login in the account's credential vault as `chatgpt.oauth` (`packages/core/src/providers/chatgpt-sign-in.ts`), renews it itself (`chatgptLoginIssuer`), and calls `api.openai.com` from the Worker or Durable Object. The issued client survives a sign-out (`chatgpt.registration` in the object's KV), so the next sign-in skips registration. A sign-in that withheld plan usage stores no tokens, and the next one asks for consent again. The deployment is one agent host: its `ext_agent_host_id` is a UUID URN derived from `CREDENTIAL_ENCRYPTION_KEY`, the same for every sign-in until that key changes.

An account that holds its own login uses it. Otherwise the call goes through the first connected machine whose `chatgptStatus` says signed in. No container carries this provider. `DELETE /api/user/chatgpt` signs out both ways: OpenAI revokes each session, and each side forgets its tokens and keeps its registration.

Egress, measured 2026-10-05 with a throwaway Worker and a Durable Object in it, no credential, 3 runs each: `auth.openai.com` answered JSON to both (discovery 200, JWKS 200, token endpoint 400 `invalid_client`), and `api.openai.com` answered JSON 401 to `GET /v1/models` and `POST /v1/responses`. In the same runs chatgpt.com still answered with its HTTP 403 HTML block page. So the paste-back route needs no machine.

Requests follow the preview limits (developers.openai.com/siwc/token-sharing-open-source/preview-limitations, read 2026-10-05): `store: false` and `stream: true` on every call, no `previous_response_id` over HTTP, and the unsupported fields removed (`REFUSED_FIELDS` in `packages/core/src/providers/chatgpt.ts`). Server-side compaction stays off on this route (`serverCompactor`).

## Environment variables

| Variable | Where | Description |
|----------|-------|-------------|
| `CREDENTIAL_ENCRYPTION_KEY` | Wrangler secret | **Required.** Root secret for the user plane: encrypts `user_credentials` at rest and derives the owner capability. Without it no signed-in surface works. |
| `CREDENTIAL_ENCRYPTION_KEY_PREVIOUS` | Wrangler secret | Retired encryption keys (comma-separated), read-only, for a rotation window |
| `WEBHOOK_ROUTE_SECRET` | Wrangler secret | **Required for webhook ingress.** Signs the route capability every public delivery URL carries (`events/webhook-route.ts`). Without it, webhook creation answers 503 and delivery answers 404. Rotating it revokes every issued URL. |
| `AI_GATEWAY_URL` | wrangler.jsonc `vars` | Platform AI Gateway endpoint, in the Worker's own account. Names the gateway, upstream provider and endpoint prefix the `AI` binding transport addresses. No token needed. |
| `PREVIEW_HOST_SUFFIX` | wrangler.jsonc `vars` | Zone Workspace and Sandbox previews are served under, one capability hostname per exposed port. Requires a proxied wildcard DNS record on that zone plus a `*.<zone>/*` route; the wrangler.jsonc comment has both steps. Every host under it except the app's own serves previews and nothing else. Empty means previews are unavailable. |
| `PREVIEW_HOST_PORT` | `vite dev` only | The port preview and share URLs carry when the preview zone is not on 443. `vite dev` serves `*.preview.localhost` on its own https port (`packages/cf-backend/vite-preview-zone.ts`) and sets this with `PREVIEW_HOST_SUFFIX`; production leaves it unset. |
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
| `DEV_USER_EMAIL` | wrangler.jsonc `vars` | The eval service identity, `eval-service@kinu.run`. Off localhost it applies only to a request presenting `DEV_IDENTITY_SECRET`, and the admin gate refuses it regardless. Such a request may name one of its eval accounts in `x-kinu-dev-identity-account` (core `DEV_IDENTITY_ACCOUNT_HEADER`, `EVAL_ACCOUNTS`). `devices` is `eval-service+devices@kinu.run`, another user, which holds the machines the first-run tier attaches, so they never reach the workspaces every tier's agent turns run in. `trial-1` to `trial-512` (core `parseEvalAccount`, one rule for this header and the eval harness) are one eval trial each, so trials that run at once never see each other as peers; `GET /api/user/held-rows`, answered to this identity alone (404 to anyone else), counts the rows of each table such an account holds, a full-text index's own tables aside since they index another table's rows. An unknown name is refused |
| `WORKERS_AI_VIA_BINDING` | wrangler.jsonc `vars` | `on` sends every user's Workers AI calls through this Worker's own `AI` binding, on the deployment's account, for the chat lanes and the OpenAI-compatible proxy at `/api/user/ai/v1`. `on` in both environments. Unset, Workers AI goes through each user's Cloudflare OAuth credential. |
| `DEV_IDENTITY_SECRET` | Wrangler secret | The whole authority for the `DEV_USER_EMAIL` identity and its eval accounts, sent in `x-kinu-dev-identity-secret` (core `DEV_IDENTITY_HEADER`; Workers Logs redacts a header whose name contains `secret`) |
| `KINU_ORIGIN` | CLI shell env | Override CLI app origin for alternate deployments |
| `KINU_BASE_URL` | CLI shell env | Advanced direct LLM override for local agents |
| `KINU_AUTH` | CLI shell env | Advanced direct LLM auth override for local agents |
| `KINU_MODEL` | CLI shell env | Override local agent model |
| Per-call timeout tuning | CLI shell env / wrangler env var | None exposed, and none exists to expose. There is no per-call silence window and no per-turn step or time bound. What ends a call is the provider answering, failing definitively, or the caller cancelling; what ends a turn is the model finishing without tool calls, the mission budget, or an abort. Retries are the owner's setting (Settings → Models → Retries, default 3), spent only on the last model of a fallback chain. |

## Wrangler bindings

| Binding | Type | Description |
|---------|------|-------------|
| `OrchestratorAgent` | Durable Object | The workspace agent (`OrchestratorAgent extends ActorAgent extends Agent<Env>`) |
| `UserDO` | Durable Object | Per-user profile, CLI tokens, devices |
| `MonitorDO` | Durable Object | Synthetic monitoring: open incidents and the alert outbox (one instance, `site`) |
| `KinuDevbox` | Durable Object + Container | `KinuDevbox` (`@kinu.run/devbox`) on the `durable_object` scheduling policy; one container per workspace, started at the size the box records |
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

`compatibility_date` `2026-09-30`, `nodejs_compat`. `exports` declares every Durable Object class as a SQLite class: `OrchestratorAgent`, `KinuDevbox`, `UserDO`, `MonitorDO`, `ControlPlaneDO`, `DeployRunDO`, `MossaicUserDO` and `MossaicShardDO`, and lists `CodexEgress` as deleted. Cloudflare reconciles the map against each environment's namespaces on every `wrangler deploy`: a class new to it gets its namespace, and a retired class is kept as a `{ "type": "durable-object", "state": "deleted" }` tombstone, which deletes its namespace and its data; there are no tags. The switch from the `migrations` array kept rows and a pending alarm on a probe Worker, and is one-way: after it, a rollback or deploy to a `migrations` version is refused (`provisioned_class_missing_from_config`, code 100402) and the current version keeps serving (measured 2026-09-28, `~/kinu-logs/deploy-lane/exports-probe/`). `wrangler versions upload` refuses a config with `exports`. A version binds its namespaces by id: after a reset, `wrangler rollback` to any earlier version succeeds and every Durable Object call it serves throws `Durable Object Namespace was deleted` (measured the same day), which is why the rollback below refuses to cross a reset. A reset keeps the Worker and resets its classes in place (measured 2026-09-05), because the Worker holds secrets nobody can read back. `bun run deploy --reset` does it between the build and the upload (`scripts/reset.ts`); on production, `--promote --reset` needs a terminal, and `reset.ts wipe production` asks there for `reset production` to be typed just before it deletes anything. The classes are the ones `exports` keeps live, and the live version must bind exactly those. A placeholder script goes up under the same name and routes with no Durable Object bindings and every class a `deleted` tombstone; its `/api/health` answers 200 `{ build: null }` so the infra gate reads the hostname as a stampless Kinu Worker. Once it serves with no Durable Object binding, each container application bound to one of the deleted namespaces, or named by the config, is deleted and logged as it goes, because a deploy refuses an application of its name bound to another namespace. The upload that follows creates every class afresh. What the reset deletes (each class with its namespace id, each container application, the devbox chains, the placeholder version) is kept at `resets/<tag>.json` and `resets/latest.json` in the environment's releases bucket, and once done in the deploy record: staging's `verified/<sha>.json` or production's `promoted.json` entry. A reset is safe to stop anywhere. It checks everything it needs before it deletes anything, the REST token its REST-only deletions take included; it writes its record `started` to both keys before the placeholder, the first deletion, and `done` after the last; and run again against its own placeholder, it finishes what the record names that is still there. The reset deletes this machine's eval bearers for that origin (`~/.config/kinu/eval-session/<host>/`) as soon as the placeholder serves, since each named a deleted session; the tiers mint new ones. A deploy that fails after the reset started leaves the placeholder serving; deploy again with `--reset`, which finishes the reset or finds it done, then uploads. `bun run deploy --rollback` refuses to return production to a build promoted before its latest reset: that build never ran on the storage the reset left. A tombstone is refused while the class is still in the uploaded code (`tombstone_delete_class_still_in_code`), which is why the placeholder deploy stands between the delete and the build.

### Runtime compatibility

`packages/cf-backend/wrangler.jsonc` owns the date and flags. `workerCompatibility` in `vite-agent-bundle.ts` reads them for Vitest, the tracing runtime, devbox runtime tests, the agent bundle's `compatibility.json`, and resident slate workers. Other Worker JSONC files repeat the date because JSONC cannot import it; `release-config.test.ts` enumerates them through `scripts/sources.ts` and refuses a different top-level or environment date. Release-artifact fixtures keep their caller-supplied dates: they test deploying someone else's manifest, not Kinu's runtime settings.

On 2026-09-30 the application toolchain is Wrangler 4.145.0, workerd 1.20260930.2, Vite plugin 1.62.3, Vitest plugin 1.3.4 and workers-types 5.20260930.2. Direct Miniflare stays at 5.20260926.0-alpha: 5.20260930.0-alpha sends a `dispatchFetch` request to DNS instead of its configured Worker under Bun 1.4.0, while both versions pass on Node 22.22.3. The four-run, 799-byte repro is in `kinu-logs/miniflare-upstream/ISSUE-2026-09-30.md`. The hold ends when a release passes that Bun smoke. The latest plugins retain their own new Miniflare under Node; the held direct version retains its undici 7.29.1 override and workerd 1.20260926.1 subtree.

No compatibility flag changes default between 2026-09-28 and 2026-09-30. This is the dated-flag list in workerd tag `v1.20260930.2`, commit `d99bc6b777e35d72d71c2f1fe2fd1db53284528a`, `src/workerd/io/compatibility-date.capnp`, read 2026-09-30. Its maximum-date source says 2026-10-07, but a deployed Worker stays at today's date, not a future local-runtime date.

The next default is `durable_object_io_tasks_prevent_eviction`, on 2026-10-01; it is not enabled here. Cloudflare's [compatibility-flag docs](https://developers.cloudflare.com/workers/configuration/compatibility-flags/), read 2026-09-30, say: “pending I/O keeps a Durable Object in memory after the client disconnects or drops its reference to the object,” including service requests, DO RPC, `container.monitor()` and `ctx.waitUntil()`, until completion or up to 15 minutes. The code review found no correctness dependency on that eviction: long work has SDK keepalives and durable recovery, cancellation is explicit, and eviction-recovery tests force `abortAllDurableObjects()` rather than await idle eviction. Nimbus's detached slate redrive and scheduled `waitUntil` work, model/RPC waits and devbox's awaited monitor could stay resident longer. That occupancy change is unmeasured on Kinu and requires a separate decision; no keepalive or recovery path is deleted for it.

## Deploy script

`scripts/deploy.sh` is the one deploy path. `bun run deploy` publishes `kinu-staging` to https://staging.kinu.run; `bun run deploy --promote` publishes `kinu` to https://kinu.run, and only the build staging verified; `bun run deploy --rollback` returns production to the build it took before (§ Rollback). Nimbus is held as a library inside the `OrchestratorAgent` that owns each workspace, so there is no separate Nimbus deploy.

```bash
bash scripts/deploy.sh [--promote] [--reset] [--bootstrap] [--gates-only]
bash scripts/deploy.sh --rollback
```

'--promote' runs no source gate: staging's verified record stands for the complete CI and deployment proof, and staging must still serve those downloads. Staging withdraws its record before rebuilding. '--bootstrap' defers only resources the upload creates, with strict post-deploy verification. '--gates-only' takes the same CI verdict, runs the remaining local gates and stops before the build; it requires a clean revision armada has proved too. '--reset' deletes the Worker's Durable Objects before upload as described under Wrangler bindings.

The deploy reads three values from the environment of whoever runs it, never from the tree. `KINU_EVAL_STAGING_WEB_IDENTITY` and `KINU_EVAL_WEB_IDENTITY` are staging's and production's `DEV_IDENTITY_SECRET` (§ Environment variables). `KINU_SCRIPTED_MODEL_KEY` is the bearer of the tiers' scripted model Worker: any random string, for example `openssl rand -hex 32`, kept in a file outside the tree and exported before `bun run deploy`. The deploy refuses to start without it, uploads it as that Worker's secret, and the tiers store it on the eval accounts, so a new value takes effect at the next deploy.

One deploy of an environment runs at a time on a machine: `scripts/deploy.sh` holds `$XDG_RUNTIME_DIR/kinu-deploy-<environment>.lock` for its whole run, and a deploy that finds it held does nothing and exits 75.

Continuous staging. Whenever the release branch moves on origin (integration/0965 now) and no staging deploy runs, its tip is deployed to staging (`scripts/staging-loop.ts`, L21). `kinu-staging@integration-0965.path` watches `.git/refs/remotes/origin/integration/0965` in the primary checkout, which moves when the release is pushed, and starts `kinu-staging@integration-0965.service`, a oneshot that runs `bun scripts/staging-loop.ts run integration/0965` from the dedicated worktree `/mnt/local/kinu/wt/staging-loop`, which nothing else edits, with the deploy's credentials from `~/.config/kinu/secrets.env` (mode 600; the same names an interactive deploy exports). Each round reads the tip and stops once it is the last tip deployed (kept in `~/.local/state/kinu/staging-loop/integration-0965`); otherwise it moves the worktree to the tip, cleans it except for `node_modules` and `bench-artifacts`, makes the install the tip's own (when `scripts/install-parity.ts` does not hold, every `node_modules` tree is removed and `bun install --frozen-lockfile` runs, since a frozen install over the old tree keeps what the new lock dropped, and then parity is required), and runs the deploy. A promotion round prepares its worktree the same way. The newest tip wins: a tip pushed past while a deploy ran is never deployed, a deploy refused for another one running waits for it and reads the tip again, and a red deploy is not repeated until the tip moves. Auto-promotion. Production takes whichever build staging verified, through `deploy.sh --promote`, the one path: `kinu-promote@integration-0965.timer` starts `kinu-promote@integration-0965.service` every 15 minutes, which runs `bun scripts/staging-loop.ts promote integration/0965` from its own worktree `/mnt/local/kinu/wt/promote-loop` with production's credentials from the same `~/.config/kinu/secrets.env`. A round takes the last tip continuous staging deployed and leaves it if production already serves it or a round tried it before (`~/.local/state/kinu/promote-loop/integration-0965`); otherwise, at that tip, `promote.ts check` refuses until staging's record and the evals' green Verdict are both there, and only then does the round promote. A promotion that goes red is never tried again and nothing rolls it back: its report and the rollback hint stand, and the next verified tip deploys forward. A tip passed by a newer staging deploy before its verdict lands is never promoted, since staging no longer serves it. `bun scripts/staging-loop.ts install integration/0965` refuses until both credential files exist; it creates both worktrees, writes the four units under `~/.config/systemd/user` and enables the path unit and the timer. `systemctl --user disable --now kinu-staging@integration-0965.path kinu-promote@integration-0965.timer` stops them, and a new release branch is installed by its own name.

### Order of operations

A dirty checkout is refused first, so the `/api/health` build SHA always names the published bytes. Then come the preflight phase, the Wrangler auth check, and `bun install --frozen-lockfile` when there is no root `node_modules`.

CI is the ladder's CI tier on armada (L25), and the deploy takes its verdict for the exact clean HEAD SHA, which armada stored when that commit's push to `integration/**` or `main` was proved. Every CI unit is one task: each split suite's files, the upload scan, and the six hammer runs, each with its own container and burners. armada grades the plan's every row exactly once, with a timing for each file a split suite declares, before it stores a verdict. A missing or red verdict never verifies a revision, and nothing reruns it locally.

1. The local machine preflight runs first. A staging deploy then reads armada's verdict for the exact full HEAD SHA (`ladder.ts --ci-verdict`) and puts every row of it in the report; a missing verdict or any red row ends the deploy there, before anything is built, and never falls back to a local run. The account gate still proves staging's account before build/upload.
2. Build. On staging, `bun scripts/promote.ts forget` first withdraws HEAD's record, and a record that cannot be withdrawn builds nothing. Then `vite build` for the deploy's environment (`CLOUDFLARE_ENV=staging` on staging; production is the config's top level), and the build's own flattened config (`dist/kinu/wrangler.json`) must name that environment, or nothing leaves the machine; the Worker name and origin the later steps use are read from it. On staging, `scripts/build-worker-release.ts` (the self-deploy tarball and `release.json`), then `scripts/build-cli-dist.sh` (four platform artifacts, the shared CPython runtime, a `.sha256` for each, and `kinu-version.json`), and the worker tarball, over the 25 MiB per-file asset limit, goes with its `.sha256` to staging's releases bucket before the deploy. On a promotion nothing of that is rebuilt: `bun scripts/promote.ts adopt` refuses a build whose artifact digest is not the one staging recorded, fetches every download the record lists from staging, each refused unless it hashes as the green run's did, writes them into `dist/client/downloads/`, and copies the worker tarball into `kinu-releases` only once it hashes as the signed stamp says. The first promotion also starts production's history with the build production serves before it, with the hash of every download it serves. The build fails if any output misses `dist/client/downloads/`.
3. Deploy. `npx wrangler deploy --tag <sha> --message "kinu <environment> <sha>"`, so the published Worker version carries the build sha as a version annotation. Workers Logs tags an invocation with a version id and nothing else, and `npx wrangler versions list` prints the pair. The step verifies the `KinuDevbox` binding appears in output and the assets directory reported is the one downloads were staged into.
4. Smoke test, against the deployment's own origin. HTTP 200 plus app content. The `/api/health` stamp equals the deployed commit. `/downloads/kinu-version.json` and `release.json` parse and name that commit, and the worker tarball's `.sha256` matches the signed manifest. The CLI launcher points at the deployed artifacts. Every artifact downloads, unpacks, and matches its published `.sha256`. Each check reads the answer of the version this deploy made, which every response names in `x-kinu-version` (the reset placeholder too): while a version it replaced still answers at an edge, the check asks that route again, for up to 120 s, and then names the version still answering. On 2026-10-08 the reset placeholder answered one smoke request 23 s after the deploy of b8340eebf, between answers from the new version. Last, every name the deployment serves (each Custom Domain, and a name under each route) must answer HTTPS with a certificate that verifies (`scripts/edge-settled.ts`). An environment's first deploy returns before the edge has issued a certificate for each new name, so each is asked again every 15 s, for at most 15 minutes, before anything drives it.

   A red in steps 2 to 4 is reported, and rows that need this deployment are named as not run. Remaining local gates still finish. Staging may serve a red build, but no red deploy writes a verified record.
5. The tiers' scripted-model Worker publishes on its route and Custom Domain at scripted-model.kinu.run; hosted DO calls need the route and the provider proxy needs the Custom Domain. It answers only the bearer KINU_SCRIPTED_MODEL_KEY, which the deploy uploads as SCRIPTED_MODEL_KEY and scripts/scripted-tier.ts stores for the scripted accounts.
6. The tiers and the source gates CI cannot host, in one wave.

   First-run, product flows and the one-trial Muse eval pass drive this deployment. KINU_EVAL_ORIGIN and KINU_ORIGIN name it; evalWebIdentityEnv selects that deployment's own secret. First-run's fleet uses the devices account, its other cases and product flows use scripted, and the real-model eval pass uses eval-service. Product flows run only against a Workers deployment, not vite dev. Every task stays, including the full true-myth journey; no model deadline is added. The eval pass prepares eval-service's provider keys inside its own admitted row, so source gates and scripted tiers do not wait for real-model credentials. A reset deletes them with every Durable Object, and may have run in another deploy, so the eval pass could find no model. `scripts/eval-provider-keys.ts` reads `GET /api/user/models` as eval-service (the deployment's eval identity in `x-kinu-dev-identity-secret`), stores each key of `~/.config/kinu/eval-provider-keys.json` (mode 600, `{"<provider>.bearer": "<key>"}`) whose provider it does not list, under that very name, the one the provider reads (`POST /api/user/credentials/<provider>.bearer`), and then the models must include every one the eval pass runs. It prints no key; a missing file, key, identity or model is a finding in the report, and the deploy goes on.

   Every deploy row of a phase runs on armada in that phase's one job at the deploy's SHA, unless it states why it runs on this machine (`here`): only the preflight, `deadline-capability` and `gate:infra` do. A row that needs secrets of its own names them (`secrets`), and armada gives secrets per job, so it runs in a job of its own (`--deploy-secrets=`) and no other row's container holds them. `gate:devbox-e2e` is one: its Worker, bucket and containers go through `KINU_CLOUDFLARE_API_TOKEN`, which every wrangler it starts reads as `CLOUDFLARE_API_TOKEN`, never a wrangler login; it copies the staging tools with `R2_ACCESS_KEY_ID` and `R2_SECRET_ACCESS_KEY`, cleans the registry with `DEVBOX_REGISTRY_TOKEN`, acts as `KINU_EVAL_STAGING_WEB_IDENTITY` whatever the deployment, and drives the desktop client in its container's Chrome.

   The ladder runs only deployment-dependent and CI-exempt rows here. Source and push-tier rows take the exact-SHA CI verdict, never the deploy checkout's unrelated cache and never a local retry. Each row's measured CPU and PSS determines admission under the existing thread/memory caps and exclusive browser lane. The sampler runs live rows once while they execute, including red runs, and stores CPU/PSS outside the checkout at ~/.cache/kinu-ladder/resources/. A row without resource measurements still reserves the box; later deploys use its observed footprint to admit it concurrently when it fits. Those measurements are resource evidence, not green verdicts.

   The staging deploy dispatches evals.yml with this build before the local wave, without awaiting it: ten trials on staging against production and a Verdict that fails on regression. Its run id stays in the verified record, and production still waits for that Verdict.
7. Infrastructure verification. `bun scripts/infra-verify.ts --phase=post-deploy` for the deploy's environment, the strictest phase, whenever the upload happened, whatever the smoke test said; a red there is a red of the deploy. Then, on staging, what the version did while the tiers and the eval pass drove it: `bun scripts/prod-logs.ts version <version id>` reads staging's own telemetry for that version alone, from its upload on, and each signal it finds is a red of the deploy under `telemetry` in the report, however the tests went: an invocation that ended in an uncaught exception or that the platform ended (a reset), a terminal effect that failed or was left owed, an object woken as often as the product calls a wake loop (`ALERT_THRESHOLDS.startupsPerHour`), by startups or by alarms. Telemetry it cannot read is a red too. With zero users, the traffic is our own; staging took at most 16 alarms in an object-hour under the tiers and the evals (2026-09-30).

   Terminal-effect observations are not unfinished sequences: the report follows each sequence's last `turn.terminal_effects_owed` or `turn.terminal_effects_settled` event, separates those that settled after owing, and reports only those still owed at the window's end. Capped or sampled state history is unavailable evidence, not a green classification. The historical 19 observations across 13 sequences predate the completion event; their window-end state is unclassifiable.
8. On staging, the record: `bun scripts/promote.ts record <version> <evals run>` writes `verified/<sha>.json` (the sha, the artifact digest, the staging version, the evals run, and every download under `dist/client/downloads/` with its sha256) to staging's releases bucket, last, so a red anywhere above leaves none, and only once staging is seen serving that commit with that signed stamp. On a promotion, the history: `bun scripts/promote.ts promoted <version>` adds the build to `promoted.json` in `kinu-releases`, each download with its hash, once production is seen serving that version and that signed stamp; a promotion production cannot record fails, since no rollback could return to it. A promotion's `bun scripts/promote.ts check` reads the record's evals run and refuses the build until that run's `Verdict` job has finished green: "no eval verdict yet" while the run has none, and the verdict's own link when it is red. The run's own conclusion is not the verdict: a run is green whenever it finished.
9. The report and the summary. Every deploy ends with one report file, `bench-artifacts/deploys/<environment>/<start>-<sha>/report.md` (`scripts/deploy-report.ts`), whose path it prints: every red row with its finding, its reproducing command and its output's tail (the whole output beside it in `logs/`), grouped by phase, each marked NEW or CARRIED OVER against the previous deploy of the environment (never a `--gates-only` one), the merges between the two deployed commits, the rows not run and why, notices that are no red, and when the deploy reached each mark. Then the URL, Worker, Version ID and build sha. The deploy's exit status is its verdict: 0 only with no red anywhere. While a phase runs, `live.txt` beside the report names each running row, how long it has run and the last line it printed (`scripts/deploy-live.ts`), so whoever watches or cancels a long deploy sees what it waits on: the eval pass's line names the trial and the job it waits on. A Ctrl-C or a stop of the deploy's service gives every running row SIGTERM and 5 s to end (`scripts/deadline.ts`), and the file's last word names the rows still running then. The report also lists every measured row's wall and longest silence, longest first. Its budget row goes red when the whole wall minus the longest named eval trial exceeds 1200 seconds; the trial stays in full and is not timed out. Cache usage is recorded per request from main's and retained descendants' public ledgers, preserving actor, run and step identity. Per trial and for the deployment, the table shows exact input, cache-read and output counts, token-weighted cache-hit share, Activity's EMA (alpha 0.2), p95 and p99, with the previous deploy alongside. Missing counts remain unknown; older reports without request measurements are named unavailable, never backfilled. Before staging writes a verified record, the completed checks and budget must be green.

### Build budget

Measured deploy wall, 2026-10-02: staging `85a438698` took 8,599 seconds. The legacy Ling order-book trial was the critical path at 8,125.925 seconds; subtracting that trial, not the whole eval row, leaves 473.075 seconds (7m53.1s). All non-eval wave rows finished 951.278 seconds after the start. Muse's slowest of those twelve trials was chess at 964.301 seconds. These are the saved deploy and trial clocks, not a measurement of the revised deploy.

The extended true-myth journey is not bounded by that old Muse maximum: its 2026-10-01 trial reached only turns 1–3 before failing, in 1,317.758 seconds (21m57.8s). The full journey stays; its complete duration is unmeasured. The revised deploy overlaps the old 138.735-second CI-upload wait with the 40.3-second account row, and moves the old 87.334-second provider-readiness step into the eval row. Its new end-to-end wall must be measured on deployment.

Two platform limits bound step 2, recorded in `packages/core/src/platform-catalog.ts` (`worker.script_bytes`, `worker.startup_ms`). I read them from the Cloudflare Workers limits page (https://developers.cloudflare.com/workers/platform/limits/, updated 2026-09-05) on 2026-09-28. Neither has a gate. I re-measure, never derive from memory.

- Bundle, uncompressed. Limit is **64 MiB** on Free and Paid, encoded as `64 * MiB`. There is no compressed limit: the gzip figure the dry-run prints is for reference only. Last reading: **21,347.18 KiB raw (5,745.18 KiB gzip), 2026-09-28**, about a third of the limit. I measure after vite build with `bunx wrangler deploy --dry-run`, which prints `Total Upload` (the measured size) and `gzip`.
- Startup time. Limit is **1 second** of module top-level evaluation, paid by every cold DO activation. Last reading: **185-252 ms, 2026-08-04**, about a fifth of the limit. Cloudflare raised it from 400 ms on 2025-10-10. I do not cite 400 ms.

Bundle size charges startup too, and startup is the tighter of the two limits.

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

GitHub runs no source CI: the ladder's CI tier runs on armada (§ CI on armada), Lean verification among its rows. GitHub keeps two workflows: secret scanning on every push, with a read-only repository token, and live evals, only on dispatch. The nightly flake sweep and bench corpus validation run on armada from a user timer (`bun scripts/nightly-sweeps.ts install <branch>`), one `armada map` each. Every workflow uses setup-bun's `bun-version-file: package.json`, so `packageManager` controls both local and CI builds. Bun 1.4.2 emitted a different sync bundle from the pinned 1.4.0 image in run 36687270202; CI follows the declared version, not `latest`.

`.github/workflows/evals.yml` holds a credential, so its two jobs that read it (`evals`, `diagnose`) ask for the GitHub environment `eval`, and no pull request can start the workflow: it is dispatched after a promotion and measures the build production serves. Two things only an operator can do:

| Operator setup required | Where | Why the repository cannot do it |
|---|---|---|
| Create an environment named `eval` holding `KINU_EVAL_WEB_IDENTITY`, the deployment's `DEV_IDENTITY_SECRET`, which lets a trial act as `eval-service`. | GitHub → Settings → Environments | The workflow declares `environment: eval`, the only boundary a file in the repository can ask for. Which secrets that environment holds is a dashboard setting. |
| For a deploy from CI, mint `CLOUDFLARE_API_TOKEN` with Edit Cloudflare Workers, plus Workers R2 Storage: Edit, Workers KV Storage: Edit and Vectorize: Edit, scoped to the deploy account. | Cloudflare → My Profile → API Tokens | Nothing in a repository can reduce what an account-scoped token may do. `scripts/deploy.sh` prints this list when wrangler is not authenticated, and stops before the build. |

`scripts/release-config.test.ts` (required gate) holds these properties. Every workflow declares its token permissions. Every credential-bearing job names an environment. No pull request can start a credential-bearing job. No workflow pipes a download into a shell. No action is used from a moving ref.

### CI on armada

armada, the owner's mapped compute on Cloudflare Containers, is CI (L25). It is pinned as a dev dependency, so `bunx armada` is this checkout's. `bunx armada run <commit|worktree>` runs the CI tier for any commit, pushed or not: it reads `.armada.json` from the commit, prints every red row with the tail of its output, and exits 0 when every planned row ran once and passed, 1 when one was red, and 2 when the run could not grade the commit. A graded run of the whole tier stores its verdict under the commit, and `bunx armada verdict <commit>` reads it back. A worktree must be committed first. The connection is `~/.config/armada/connection.json`.

- A push to `main` or `integration/**` is proved there (`.githooks/pre-push`): the hook takes the verdict armada stored for the pushed commit, or runs `armada run` when it has none, and refuses the push unless every row is green. A stored red is not run again; it is fixed in a new commit. Moving `main` to a commit integration already proved only moves the pointer. Any other push runs the `local` tier as before.
- A commit, or a merge commit, runs only oxlint on the files it touches (`.githooks/pre-commit`). The `local` tier's rows (typecheck, whole-tree lint, structural gates) are ci rows, so the push above proves them.
- A deploy reads the same verdict (step 1 above), and a promotion takes staging's record, which only a deploy past that gate wrote.

What this repository supplies:

- `.armada.json` names the environment recipe. Armada's own layer gives every recipe what a GitHub runner has and a stock container lacks: git 2.53, iproute2, strace and a compiler. `scripts/armada/setup.sh` adds Google Chrome, bubblewrap, ffmpeg and the squashfs tools. `scripts/armada/install.sh` runs the locked install. The lock, the workspaces' manifests, the patches, the vendored SDK and both scripts' text key the environment, which is prepared once and snapshotted. Every container starts from that snapshot and only checks out its commit, with its whole history as a `fetch-depth: 0` checkout has it.
- `ladder.ts --ci-plan --ci-costs=<timings>` prints one task per CI unit. Each task names the row it must report and every file a split suite must time, which armada holds it to. Each task carries its measured seconds, so the longest start first. A pool of `standard-4` containers on the `durable_object` scheduling policy pulls task after task, each running `ladder.ts --tier=ci --ci-row=<command> --verdicts=<file>` as an unprivileged user.
- Weights are armada's own timings, the median of each row's last five green runs, laid over `scripts/ci-cost.json`, the walls a GitHub run measured on 2026-10-01.
- A row's green proof outlives its container (`scripts/ladder-proofs.ts`). The ladder mirrors its cache entries to the private R2 bucket `kinu-ci-proofs`, keyed by the row's input-closure hash, so a later commit whose closure for that row is unchanged reports the row as carried, naming the revision that proved it, and runs only the rows its change reaches. Each object carries an HMAC under the bucket's secret; an edited or misplaced entry, or a bucket that does not answer, is a run. Every CI task holds `KINU_PROOFS_ACCESS_KEY_ID` and `KINU_PROOFS_SECRET_ACCESS_KEY` (`.armada.json` `task.secrets`), and the ladder deletes both from its environment before any gate spawns. They are the proof store's own names: `R2_ACCESS_KEY_ID` and `R2_SECRET_ACCESS_KEY` belong to `gate:devbox-e2e`, and the ladder leaves them alone.

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

```bash
bun run deploy --rollback
```

It returns production to the newest build it took before the one it serves (`bun scripts/promote.ts rollback`). `promoted.json` in `kinu-releases` lists every build a green promotion gave production, oldest first, and the first promotion starts it with the build production served before it. A promotion that went red after its upload serves a version the list never took, so a rollback from it returns to the newest build in the list; from a listed build it returns to the one before, and withdraws the build it leaves, so a later rollback never returns to it. It runs `wrangler rollback` to that version, then proves the rollback took, the way the deploy's smoke test does: `/api/health` names the build's commit once the edge converges, and every download, the worker release tarball among them, hashes as that build's did. Assets ride the Worker version, so the rollback moves code and `/downloads/*` together, and the worker tarball a build's `release.json` names stays in `kinu-releases` under its own versioned key. A rollback moves no Durable Object, R2 or KV state. Cloudflare refuses one across a Durable Object class migration, or to a version bound to a bucket, namespace or queue that no longer exists, and keeps only the 100 most recent versions (Workers rollbacks docs); a forward deploy is then the way back.

Going forward instead means a commit staging verifies: `bun run deploy`, then `bun run deploy --promote`.

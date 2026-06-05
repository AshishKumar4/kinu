# Deployment

## Live Instance

**Production:** https://proteus.ashishkumarsingh.com  
**Workers.dev fallback:** https://proteus.ashishkmr472.workers.dev

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
bunx vite build
bunx wrangler deploy
```

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
token authentication method `Client Secret POST`. Use the `user-details.read`
scope only;
do not request `openid` for Cloudflare OAuth.

Set:

```bash
bunx wrangler secret put CLOUDFLARE_OAUTH_CLIENT_SECRET
```

The production client id, scope, and token auth method are non-secret vars in
`packages/cf-backend/wrangler.jsonc`.

## AI Gateway Setup

Proteus uses Cloudflare AI Gateway as a proxy to Workers AI models. The `/workers-ai/v1` endpoint provides access to Workers AI models.

1. Go to [Cloudflare Dashboard > AI > AI Gateway](https://dash.cloudflare.com/?to=/:account/ai/ai-gateway)
2. Create a new gateway (e.g., `proteus-ai-gateway`)
3. Copy the gateway URL: `https://gateway.ai.cloudflare.com/v1/<account-id>/<gateway-name>/workers-ai/v1`
4. Create an API token with Workers AI permissions
5. Set the token as `AI_GATEWAY_AUTH` secret (see above)

### Supported Models

| Model ID | Name | Description |
|----------|------|-------------|
| `@cf/moonshotai/kimi-k2.5` | Kimi K2.5 | Advanced reasoning model with extended thinking |
| `@cf/meta/llama-4-scout-17b-16e-instruct` | Llama 4 Scout 17B | General-purpose instruction model |

## Environment Variables

| Variable | Where | Description |
|----------|-------|-------------|
| `AI_GATEWAY_URL` | wrangler.jsonc `vars` | AI Gateway endpoint URL |
| `AI_GATEWAY_AUTH` | Wrangler secret | `Bearer <token>` (NEVER in code) |
| `AUTH_DB` | D1 binding | Browser OAuth sessions and identities |
| `PREVIEW_HOSTNAME` | wrangler.jsonc `vars` | Hostname used for sandbox preview URLs |
| `CLI_PUBLIC_ORIGIN` | wrangler.jsonc `vars` | Origin embedded in installer/setup commands |
| `CLI_APPROVAL_ORIGIN` | wrangler.jsonc `vars` | Browser approval origin for CLI auth |
| `GOOGLE_OAUTH_CLIENT_ID` | wrangler.jsonc `vars` | Google OAuth client id |
| `GOOGLE_OAUTH_CLIENT_SECRET` | Wrangler secret | Google OAuth client secret |
| `GITHUB_OAUTH_CLIENT_ID` | wrangler.jsonc `vars` | GitHub OAuth client id |
| `GITHUB_OAUTH_CLIENT_SECRET` | Wrangler secret | GitHub OAuth client secret |
| `CLOUDFLARE_OAUTH_CLIENT_ID` | wrangler.jsonc `vars` | Cloudflare OAuth client id |
| `CLOUDFLARE_OAUTH_CLIENT_SECRET` | Wrangler secret | Cloudflare OAuth client secret |
| `CLOUDFLARE_OAUTH_SCOPES` | wrangler.jsonc `vars` | Cloudflare OAuth scopes, currently `user-details.read` |
| `DEV_USER_EMAIL` | wrangler env var | Local/staging-only synthetic auth identity |
| `PROTEUS_ORIGIN` | CLI shell env | Override CLI app origin for alternate deployments |
| `PROTEUS_BASE_URL` | CLI shell env | Advanced direct LLM override for local agents |
| `PROTEUS_AUTH` | CLI shell env | Advanced direct LLM auth override for local agents |
| `PROTEUS_MODEL` | CLI shell env | Override local agent model |
| `PROTEUS_SOURCE_TARBALL` | CLI shell env | Advanced installer/update source override |
| `PROTEUS_SOURCE_SHA256` | CLI shell env | Optional SHA-256 for the source tarball override |
| `PROTEUS_MAX_STEPS` | Shell env | Max tool-call steps (default: 500) |

## Wrangler Bindings

| Binding | Type | Description |
|---------|------|-------------|
| `OrchestratorAgent` | Durable Object | Main chat agent (extends Think) |
| `ExplorationAgent` | Durable Object | MCTS branch agents (Facets) |
| `UserDO` | Durable Object | Per-user profile, CLI tokens, devices, product changes |
| `AUTH_DB` | D1 database | OAuth users, sessions, one-time OAuth state, and CLI browser approval state |
| `LOADER` | Worker Loader | Sandboxed code execution (codemode) |
| `NIMBUS_SESSION` | Cross-Worker DO | Nimbus dev env (`script_name: "nimbus"`) |

## Unified Deploy (Proteus + Nimbus)

Proteus binds Nimbus via a cross-Worker service binding
(`script_name: "nimbus"` in `wrangler.jsonc`). Nimbus must be deployed
**before** Proteus. The unified deploy script handles both:

```bash
bash scripts/deploy.sh
```

### Order of operations

1. **Pre-deploy verification** — runs `scripts/e2e-test.sh`. Skip with
   `SKIP_E2E=1` for doc-only or config-only deploys.
2. **Nimbus deploy** — `bun install` (if `node_modules` missing),
   `npx wrangler deploy`. Captures URL + Version ID from the output.
   Skip with `SKIP_NIMBUS=1` when only Proteus changed.
3. **Proteus deploy** — `bun install` (if root `node_modules` missing),
   `vite build`, `npx wrangler deploy`. Verifies the `NIMBUS_SESSION`
   binding appears in wrangler output.
4. **Smoke test** — curls both URLs, asserts HTTP 200 and that Proteus
   serves the app.
5. **Summary** — prints both URLs and Version IDs.

### Environment variables

| Variable | Default | Purpose |
|----------|---------|---------|
| `NIMBUS_PATH` | `../nimbus` | Filesystem path to Nimbus checkout |
| `CLOUDFLARE_ACCOUNT_ID` | `f44999d1ddda7012e9a87729eba250f1` | Account for both Workers |
| `SKIP_E2E` | `0` | `1` to skip pre-deploy E2E tests |
| `SKIP_NIMBUS` | `0` | `1` to deploy Proteus only |

### If Nimbus is not at `../nimbus`

```bash
git clone https://github.com/AshishKumar4/Nimbus.git ../nimbus
# Or point at an existing checkout
NIMBUS_PATH=/path/to/nimbus bash scripts/deploy.sh
```

### Rollback

Cloudflare keeps the last 10 Worker versions. To roll back either Worker:

```bash
# List versions (last 10)
cd ../nimbus && npx wrangler versions list
cd packages/cf-backend && npx wrangler versions list

# Roll back to a specific version
npx wrangler rollback --version-id <version-id>
```

Proteus and Nimbus roll back independently. If you rolled Nimbus back but
kept Proteus on the latest, the `NIMBUS_SESSION` binding still points to
the sibling Worker — the binding resolves to whichever version is live.

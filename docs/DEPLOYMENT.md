# Deployment

## Live Instance

**Production:** https://proteus.ashishkumarsingh.com  
**Workers.dev:** https://proteus.ashishkmr472.workers.dev

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
cd packages/cli && bun link

export PROTEUS_BASE_URL="https://gateway.ai.cloudflare.com/v1/<account-id>/<gateway>/workers-ai/v1"
export PROTEUS_AUTH="Bearer <your-token>"
export NODE_TLS_REJECT_UNAUTHORIZED=0

proteus create myagent --purpose "A helpful coding assistant"
proteus chat myagent
```

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
| `CLOUDFLARE_ACCOUNT_ID` | Shell env (dev only) | Account ID for `vite dev` |
| `PROTEUS_BASE_URL` | Shell env (CLI) | Same as AI_GATEWAY_URL |
| `PROTEUS_AUTH` | Shell env (CLI) | Same as AI_GATEWAY_AUTH |
| `PROTEUS_MODEL` | Shell env (CLI) | Override default model |
| `PROTEUS_MAX_STEPS` | Shell env | Max tool-call steps (default: 500) |

## Wrangler Bindings

| Binding | Type | Description |
|---------|------|-------------|
| `OrchestratorAgent` | Durable Object | Main chat agent (extends Think) |
| `ExplorationAgent` | Durable Object | MCTS branch agents (Facets) |
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


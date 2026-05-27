#!/usr/bin/env bash
# Deploy Proteus v2 to the user's Cloudflare account.
#
# Prereqs:
#   - `wrangler login` (interactive) OR `export CLOUDFLARE_API_TOKEN=<token>`
#   - bun + Node toolchain (handled by repo `bun install` upstream)
#
# What it does:
#   1. Sanity-check auth
#   2. bun install + bun run check + bun test --cwd packages/core
#   3. vite build (worker + client SPA)
#   4. wrangler deploy
#   5. Curl the new /api/v2/health to confirm the deploy landed
#
# Run from the repo root or the worktree root.

set -euo pipefail
shopt -s nullglob

REPO_ROOT="$(git rev-parse --show-toplevel)"
cd "$REPO_ROOT"

echo "→ Repo: $REPO_ROOT"
echo "→ Branch: $(git rev-parse --abbrev-ref HEAD)"
echo "→ HEAD: $(git rev-parse --short HEAD)"
echo

# Step 1: auth check
echo "→ Step 1/5: wrangler whoami"
if ! npx wrangler whoami 2>&1 | grep -q -i "associated email\|you are logged in\|account id"; then
  echo "  wrangler is not authenticated."
  echo "  Run: wrangler login   (interactive)"
  echo "  OR:  export CLOUDFLARE_API_TOKEN=<your token>"
  exit 1
fi
echo

# Step 2: install + check + tests
echo "→ Step 2/5: install + typecheck + tests"
bun install
bun run check
bun test --cwd packages/core
echo

# Step 3: build
echo "→ Step 3/5: vite build"
(cd packages/cf-backend && npx vite build)
echo

# Step 4: deploy
echo "→ Step 4/5: wrangler deploy"
(cd packages/cf-backend && npx wrangler deploy)
echo

# Step 5: health probe
echo "→ Step 5/5: confirm v2 health endpoint"
sleep 5
HEALTH_URL="https://proteus.ashishkumarsingh.com/api/v2/health"
echo "  GET $HEALTH_URL"
if curl -sf -m 30 "$HEALTH_URL" | head -c 1024; then
  echo
  echo
  echo "✓ Deploy succeeded — v2 endpoint reachable."
else
  echo
  echo "⚠ Health endpoint not yet reachable (may take a minute to propagate)."
  echo "  Retry manually: curl $HEALTH_URL"
fi

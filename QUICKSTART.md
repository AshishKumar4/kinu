# Proteus Quick Start

## CLI (local, no Cloudflare account needed)

```bash
cd /workspace/proteus
bun install

# Link the CLI globally
cd packages/cli && bun link && cd ../..

# Configure AI Gateway (get your token from the Cloudflare dashboard)
export PROTEUS_BASE_URL="https://gateway.ai.cloudflare.com/v1/<account-id>/<gateway-name>/workers-ai/v1"
export PROTEUS_AUTH="Bearer <your-ai-gateway-token>"
export NODE_TLS_REJECT_UNAUTHORIZED=0

# Create and chat with an agent
proteus create myagent --purpose "A helpful coding assistant"
proteus chat myagent
proteus status myagent
proteus list
```

## Web UI (Cloudflare Workers + Durable Objects)

```bash
cd /workspace/proteus/packages/cf-backend

# Start the dev server (Vite + Wrangler)
CLOUDFLARE_ACCOUNT_ID=fc895c5670cff9268b310a6a86bb6c35 npx vite dev --port 5173 --host 0.0.0.0

# Open http://localhost:5173 in a browser
# Type a mission to create a new agent, or click a recent agent to resume
```

## Available Models

| Model | Speed | Best For |
|-------|-------|----------|
| `@cf/moonshotai/kimi-k2.5` (default) | Slow | Complex reasoning, CTF challenges |
| `@cf/meta/llama-4-scout-17b-16e-instruct` | Fast | Quick tasks, simple questions |

Change the model in the web UI via the dropdown next to the chat input,
or in the CLI via `proteus chat --model <id>`.

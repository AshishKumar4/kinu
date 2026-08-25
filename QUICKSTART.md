# Kinu Quick Start

Kinu gives AI agents a durable computer of their own. It adapts and improves with
use, runs locally or fully in the cloud, and solves hard tasks by exploring multiple
approaches and letting executable checks choose the winner.

This page makes your first workspace.

## CLI

```bash
curl -fsSL 'https://kinu.run/install.sh' | bash
kinu create triage --mode cloud
kinu run triage "find the slowest query"
```

The tested installer path is Linux. The script also admits macOS, but no macOS
CI job currently verifies installation or first launch. It adds `~/.kinu/bin`
to PATH when needed and runs setup unless you pass `--no-setup`.

Use `--mode cloud` for a persistent cloud workspace that uses your desktop daemon
as the local execution engine, or `--mode local` for a fully local bun:sqlite
workspace. Either way you get a workspace (the container that owns the files, execution
environments, and sessions) with its default agent inside.

From here, [docs/USER-GUIDE.md](docs/USER-GUIDE.md) covers daily use,
[docs/CLI.md](docs/CLI.md) is the full command reference, and
[docs/CONFIG.md](docs/CONFIG.md) documents `~/.kinu/config.json`.

## Providers & models

```bash
kinu auth                             # browser sign-in: attaches Cloudflare (Workers AI + AI Gateway)
kinu provider list                    # see what's connected, with status inline
kinu provider connect openai          # or: anthropic, openrouter, codex, openai-compatible
```

Signed in, a **local** workspace gets Workers AI with no separate key (it defaults to
`workers-ai/@cf/deepseek-ai/deepseek-v4-pro-0813`, which requires paid Workers
access or prepaid AI Gateway credits). Your AI Gateway shows up as
`my-gateway/{author}/{model}` once the OAuth grant includes the `aig.write`
scope. Run `kinu auth` again if you connected before it was added.

**Claude subscription** (local only, via your Claude Code login):

```bash
claude                                    # one-time: sign in to your Claude subscription
kinu provider connect claude          # status check + next steps (no key is stored)
kinu create jarvis --mode local --model claude/claude-opus-4-x
```

Kinu drives the official `claude` binary, which owns its own login. Kinu never
reads your credentials. The subscription is local only; a cloud workspace runs on
an Anthropic API key (`kinu provider connect anthropic`).

**Web search**: the `web` tool's `search` and `fetch` actions work with zero keys,
over DuckDuckGo and Cloudflare's markdown service. For ranked, answer-augmented
search, store a Tavily key as the `tavily` credential.

## Web UI Development

```bash
bun install
bun run dev
```

Open the printed Vite URL. Dev servers must bind to `0.0.0.0`; port `3000` is
reserved by the platform relay.

## CLI From A Checkout

```bash
bun install
bun run cli -- setup
bun run cli -- create jarvis --mode local --alias jarvis
```

Source checkouts use `https://kinu.run` as the default app
origin. Override with `--origin` or `KINU_ORIGIN` only for alternate
deployments.

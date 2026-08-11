# Proteus Quick Start

> Maintained by Claude (AI-edited documentation, presented as-is); verify against the code when precision matters.

## CLI

```bash
curl -fsSL 'https://proteus.ashishkumarsingh.com/install.sh' | bash
proteus setup
proteus create jarvis --mode cloud --alias jarvis --purpose "A helpful coding assistant"
jarvis "what changed in this repo?"
```

The installer works on macOS and Linux, adds `~/.proteus/bin` to your PATH when
needed, and runs setup unless `--no-setup` is passed. `proteus setup` handles
browser login and optional local model-provider credentials.

Use `--mode cloud` for a persistent cloud workspace that uses your desktop daemon
as the local execution engine, or `--mode local` for a fully local bun:sqlite
workspace. Either way you get a workspace — the container that owns the files,
execution environments, and sessions — with its default agent inside.

From here, [docs/USER-GUIDE.md](docs/USER-GUIDE.md) covers daily use,
[docs/CLI.md](docs/CLI.md) is the full command reference, and
[docs/CONFIG.md](docs/CONFIG.md) documents `~/.proteus/config.json`.

## Providers & models

```bash
proteus auth                              # browser sign-in: attaches Cloudflare (Workers AI + AI Gateway)
proteus providers list                    # see what's connected, with status inline
proteus providers connect openai          # or: anthropic, openrouter, codex, openai-compatible
```

Signed in, a **local** workspace gets free Workers AI with no key (it defaults to
`workers-ai/@cf/moonshotai/kimi-k2.6`). Your AI Gateway shows up as
`my-gateway/{author}/{model}` once the OAuth grant includes the `aig.write`
scope — run `proteus auth` again if you connected before it was added.

**Claude subscription** (local only, via your Claude Code login):

```bash
claude                                    # one-time: sign in to your Claude subscription
proteus providers connect claude          # status check + next steps (no key is stored)
proteus create jarvis --mode local --model claude/claude-opus-4-x
```

Proteus drives the official `claude` binary, which owns its own login — it never
reads your credentials. Cloud workspaces can't use the subscription; give them an
Anthropic API key (`proteus providers connect anthropic`) instead.

**Web search** just works: the `web` tool's `search` and `fetch` actions need no setup
(DuckDuckGo + Cloudflare's markdown service). For ranked, answer-augmented
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

Source checkouts use `https://proteus.ashishkumarsingh.com` as the default app
origin. Override with `--origin` or `PROTEUS_ORIGIN` only for alternate
deployments.

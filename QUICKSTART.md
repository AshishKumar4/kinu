# Kinu quick start

Kinu gives agents a durable computer of their own. It adapts with use, runs
locally or in the cloud, and solves hard tasks by trying several approaches
and letting executable checks pick the winner.

## CLI

```bash
curl -fsSL 'https://kinu.run/install.sh' | bash
kinu create triage --mode cloud
kinu run triage "find the slowest query"
```

I test on Linux. It also runs on macOS without CI coverage. The installer adds
`~/.kinu/bin` to PATH when needed and runs setup unless you pass `--no-setup`.

`--mode cloud` gives a persistent cloud workspace that uses your desktop daemon
as its local execution engine. `--mode local` gives a fully local bun:sqlite
workspace. Both come with the workspace default agent inside. That agent owns the
files, execution environments, and sessions.

[docs/USER-GUIDE.md](docs/USER-GUIDE.md) covers daily use.
[docs/CLI.md](docs/CLI.md) is the full command reference.
[docs/CONFIG.md](docs/CONFIG.md) documents `~/.kinu/config.json`.

## Providers and models

```bash
kinu auth                             # browser sign-in: attaches Cloudflare (Workers AI + AI Gateway)
kinu provider list                    # see what's connected, with status inline
kinu provider connect openai          # or: anthropic, openrouter, codex, openai-compatible
```

Once signed in, a local workspace gets Workers AI with no separate key.
It defaults to `workers-ai/@cf/zai-org/glm-5.3` (paid Workers
access or prepaid AI Gateway credits). Your AI Gateway appears as
`my-gateway/{author}/{model}` once the OAuth grant includes `aig.write`. Run
`kinu auth` again if you connected before that scope existed.

Claude subscription (local only):

```bash
claude                                    # one-time: sign in to your Claude subscription
kinu provider connect claude          # status check + next steps (no key is stored)
kinu create jarvis --mode local --model claude/claude-opus-4-x
```

Kinu drives the official `claude` binary, which owns its own login. Kinu never
reads your credentials. A cloud workspace needs an Anthropic API key instead
(`kinu provider connect anthropic`).

Web search: the `web` tool `search` and `fetch` actions need no keys.
They run over DuckDuckGo and the Cloudflare markdown service. For ranked,
answer-augmented results, store a Tavily key as the `tavily` credential.

## Web UI development

```bash
bun install
bun run dev
```

Open the printed Vite URL. Dev servers must bind to `0.0.0.0`. Port `3000` is
reserved by the platform relay.

## CLI from a checkout

```bash
bun install
bun run cli -- setup
bun run cli -- create jarvis --mode local --alias jarvis
```

Source checkouts default to `https://kinu.run`. Override with `--origin` or
`KINU_ORIGIN` only for alternate deployments.

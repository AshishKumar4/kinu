# Kinu quick start

Kinu gives an agent a computer of its own that persists between sessions. It
adapts as you use it, runs locally or in the cloud, and takes on hard tasks by trying
several approaches and letting executable checks pick the winner.

## CLI

```bash
curl -fsSL 'https://kinu.run/install.sh' | bash
kinu create triage --mode cloud
kinu run triage "find the slowest query"
```

I test on Linux. It also runs on macOS without CI coverage. The installer adds
`~/.kinu/bin` to PATH when needed and runs setup unless you pass `--no-setup`.

`--mode cloud` gives you a persistent cloud workspace that can also run commands
on your machine through the desktop daemon. `--mode local` keeps everything on
your machine in bun:sqlite. Either way the workspace comes with its default
agent, which owns the files, execution environments, and sessions.

[docs/USER-GUIDE.md](docs/USER-GUIDE.md) covers daily use.
[docs/CLI.md](docs/CLI.md) is the full command reference.
[docs/CONFIG.md](docs/CONFIG.md) documents `~/.kinu/config.json`.

## Providers and models

```bash
kinu auth                             # browser sign-in: attaches Cloudflare (Workers AI + AI Gateway)
kinu provider list                    # see what's connected, with status inline
kinu provider connect openai          # or: anthropic, openrouter, codex, openai-compatible
```

Once you're signed in, a local workspace gets Workers AI with no separate key.
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

Web search needs no keys: the `web` tool's `search` and `fetch` actions run
over DuckDuckGo and Cloudflare's HTML-to-markdown conversion. For ranked,
answer-augmented results, store a Tavily key as the `tavily` credential.

## Web UI development

```bash
bun install
bun run dev
```

Open the printed Vite URL. Dev servers bind to `0.0.0.0`, and port `3000` is
reserved.

## CLI from a checkout

```bash
bun install
bun run cli -- setup
bun run cli -- create jarvis --mode local --alias jarvis
```

A source checkout talks to `https://kinu.run` by default. Use `--origin` or
`KINU_ORIGIN` only for another deployment.

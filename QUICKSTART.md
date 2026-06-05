# Proteus Quick Start

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

Use `--mode cloud` for a persistent cloud agent that uses your desktop daemon as
the local execution engine, or `--mode local` for a fully local bun:sqlite agent.

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

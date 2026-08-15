# Configuration — `~/.proteus/config.json` and the environment

> Maintained by Claude (AI-edited documentation, presented as-is); verify against the code when precision matters.

Every CLI setting lives in one JSON file. `proteus setup`, `proteus auth`,
`proteus providers connect` and `proteus create` write it for you; this page is
for when you want to read or edit it yourself. The authoritative shape is
`ProteusConfig` in `packages/cli/src/config.ts`.

```
~/.proteus/                 mode 0700
  config.json               mode 0600 — everything below
  bin/                      the proteus command + your workspace alias shims
  source/                   the CLI source cache the launcher runs
  <workspace>/agent.db      one per LOCAL workspace: its entire state
  sessions/                 recorded CLI sessions
  daemon.log                the local scheduler's log
```

`PROTEUS_HOME` moves all of it. Nothing outside this directory is written, so
backing it up backs up everything the CLI knows.

## Account

| Field | Type | What it is |
| --- | --- | --- |
| `origin` | string | The Proteus deployment this CLI talks to. Defaults to `https://proteus.ashishkumarsingh.com`; `PROTEUS_ORIGIN` and `--origin` override it. |
| `accessToken` | string | The interactive session token from `proteus auth`. Treat it as a password. |
| `tokenExpiresAt` | ISO date | When that token expires. The CLI refuses it after this and asks you to re-auth. |
| `user` | `{id, email, displayName?}` | Who the token belongs to — what `proteus whoami` prints. |

`PROTEUS_TOKEN` overrides `accessToken` for CI, where a scoped token from
`proteus tokens create` is the right thing to use rather than a session token.

## Workspaces

| Field | Type | What it is |
| --- | --- | --- |
| `agents` | map | One entry per workspace you've created, keyed by name. |
| `agents.<name>.mode` | `"cloud"` \| `"local"` | Where it lives. Decided at creation. |
| `agents.<name>.cloudName` / `localName` | string | Its name on that side, when it differs from the key. |
| `agents.<name>.displayName` | string | The human name shown in the web app. |
| `agents.<name>.alias` | string | The alias shim created for it, if any. |
| `agents.<name>.createdAt` / `updatedAt` | ISO date | Bookkeeping. |
| `aliases` | map | `alias → workspace name`. `proteus alias` / `unalias` maintain it, and each alias also has a shim in `bin/`. |

Workspace and alias names are `[A-Za-z0-9][A-Za-z0-9_-]{0,63}`, and an alias may
not shadow a built-in command name.

## Models

| Field | Type | What it is |
| --- | --- | --- |
| `model` | string | Default model spec for new work, e.g. `workers-ai/@cf/deepseek-ai/deepseek-v4-pro-0813`. `PROTEUS_MODEL` and `--model` override it. |
| `reasoningEffort` | `"low"` \| `"medium"` \| `"high"` | Default reasoning effort. |

## Providers

**`proteus provider connect` no longer writes a key here by default.** Signed
in, the key goes to your Proteus account, where it is encrypted at rest — and
this machine reaches it through the provider proxy without holding a copy. Pass
`--local` to keep one here instead, for offline use or an endpoint only this
machine can see. A local key always wins over the account copy.

Two exceptions, both deliberate. Codex stays local because the Codex endpoint
refuses Cloudflare Workers egress, so proxying it would break a credential that
works today. And with no account signed in there is nowhere else to put a key,
so it lands here.

`providers` is therefore the local-override store. Cloud workspaces never read
it.

| Field | What it is |
| --- | --- |
| `providers.openai.apiKey` | OpenAI API key. |
| `providers.anthropic.apiKey` | Anthropic API key. |
| `providers.openrouter.apiKey` | OpenRouter API key. |
| `providers.codex` | The ChatGPT device-flow tokens (`accessToken`, `refreshToken`, `expiresAt`, `metadata`), written by `proteus providers connect codex`. |
| `providers.openaiCompat.<name>` | An OpenAI-compatible endpoint: `{baseURL, apiKey?, headers?, extraHeaders?}`. |

The Claude subscription provider stores nothing here: Proteus drives the
official `claude` binary, which owns its own login.

## MCP servers

```json
{
  "mcpServers": {
    "github": { "command": "npx", "args": ["-y", "@modelcontextprotocol/server-github"], "env": { "GITHUB_TOKEN": "…" } }
  }
}
```

The standard `mcpServers` shape: `command` (required), `args`, `env`, and
`timeoutMs` (per-call timeout, default 60s). These are stdio servers connected
by local workspaces. Cloud workspaces get MCP servers from your account instead.

## Behaviour

| Field | Type | Default | What it does |
| --- | --- | --- | --- |
| `updateCheck` | boolean | `true` | The once-a-day "newer Proteus available" notice in an interactive terminal. Set `false` to silence it. |
| `updateCheckedAt` | number | — | Throttle state for that notice. Cache only — never a version source. |
| `updateLatestSeen` | string | — | The newest served version the notice has seen. |
| `deviceConnectPromptDismissed` | boolean | `false` | "Don't ask again" for the chat device-connect prompt. |
| `checkpointKeep` | number | `50` | Shadow-git file checkpoints kept per working directory — what `/undo` restores from. |

## Environment variables

| Variable | What it does |
| --- | --- |
| `PROTEUS_HOME` | Workspace + config directory (default `~/.proteus`). |
| `PROTEUS_ORIGIN` | Proteus app origin. |
| `PROTEUS_TOKEN` | Account access token, for CI. |
| `PROTEUS_MODEL` | Default model ID. |
| `PROTEUS_BASE_URL` | LLM API base URL. |
| `PROTEUS_AUTH` | LLM auth header value. |

Precedence everywhere: an explicit flag beats the environment, and the
environment beats `config.json`.

## Editing it by hand

The file is plain JSON and the CLI rewrites it whole on every change, so edit it
while nothing else is running. It is created `0600` inside a `0700` directory
because it holds tokens and API keys — if you copy it anywhere, copy those
modes with it.

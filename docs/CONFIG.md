# Configuration — `~/.proteus/config.json` and the environment

> Maintained by Claude (AI-edited documentation, presented as-is); verify against the code when precision matters.

Every CLI setting lives in one JSON file. `proteus setup`, `proteus auth`,
`proteus providers connect` and `proteus create` write it for you; this page is
for when you want to read or edit it yourself. The authoritative shape is
`ProteusConfig` in `packages/cli/src/config.ts`.

```
~/.proteus/                 mode 0700
  config.json               mode 0600, everything below
  bin/                      the proteus command + your workspace alias shims
  source/                   the CLI source cache the launcher runs
  <workspace>/agent.db      one per LOCAL workspace: its entire state
  sessions/                 recorded CLI sessions
  checkpoints/              shadow-git file snapshots that `/undo` restores from
  heads/                    scratch databases for branch runs
  daemon.log, daemon.pid    the local scheduler
  device.json, pc-agent.*   the desktop execution daemon, its script and its log
```

`PROTEUS_HOME` moves all of it. The CLI keeps no state anywhere else, so backing
up this directory backs up everything it knows. Files you name yourself, such as
an export archive, land where you point them and are the one exception.

## Account

| Field | Type | What it is |
| --- | --- | --- |
| `origin` | string | The Kinu deployment this CLI talks to. Defaults to `https://proteus.ashishkumarsingh.com`; `PROTEUS_ORIGIN` and `--origin` override it. |
| `accessToken` | string | The interactive session token from `proteus auth`. Treat it as a password. |
| `tokenExpiresAt` | ISO date | When that token expires. The CLI refuses it after this and asks you to re-auth. |
| `user` | `{id, email, displayName?}` | Who the token belongs to. `proteus whoami` prints it. |

`PROTEUS_TOKEN` overrides `accessToken` for CI, where a scoped token from
`proteus tokens create` is the right thing to use rather than a session token.

## Workspaces

| Field | Type | What it is |
| --- | --- | --- |
| `agents` | map | One entry per workspace you've created, keyed by name. |
| `agents.<name>.name` | string | The workspace name, repeated inside the entry. |
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
in, the key goes to your Kinu account, where it is encrypted at rest, and
this machine reaches it through the provider proxy without holding a copy. Pass
`--local` to keep one here instead, for offline use or an endpoint only this
machine can see.

Two exceptions, both deliberate. Codex stays local because the Codex endpoint
refuses Cloudflare Workers egress, so proxying it would break a credential that
works today. And with no account signed in there is nowhere else to put a key,
so it lands here.

`providers` is therefore the local-override store. Cloud workspaces never read
it.

The model spec decides which credential answers a turn. `resolveLLMConfig` gives
the account every spec the account hosts, so `@cf/…` and the provider ids the
proxy carries go to the proxy even when a local key is present. Every other spec
falls to the local store, matched on the provider the spec names (`openai/…`,
`anthropic/…`, `openrouter/…`, `codex/…`, `opencode/…`). A bare model id with no
provider goes to a stored Codex or OpenAI credential, in that order, and
`providers.openaiCompat.default` catches anything still unmatched. With no
account session the local store is the only source.

| Field | What it is |
| --- | --- |
| `providers.openai.apiKey` | OpenAI API key. |
| `providers.anthropic.apiKey` | Anthropic API key. |
| `providers.openrouter.apiKey` | OpenRouter API key. |
| `providers.codex` | The ChatGPT device-flow tokens (`accessToken`, `refreshToken`, `expiresAt`, `metadata`), written by `proteus providers connect codex`. |
| `providers.openaiCompat.<name>` | An OpenAI-compatible endpoint: `{baseURL, apiKey?, headers?, extraHeaders?}`. |

The Claude subscription provider stores nothing here. Kinu drives Anthropic's
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
| `updateCheck` | boolean | `true` | The once-a-day "newer Kinu available" notice in an interactive terminal. Set `false` to silence it. |
| `updateCheckedAt` | number | — | Throttle state for that notice. A cache, never a version source. |
| `updateLatestSeen` | string | — | The newest served version the notice has seen. |
| `deviceConnectPromptDismissed` | boolean | `false` | "Don't ask again" for the chat device-connect prompt. |
| `checkpointKeep` | number | `50` | Shadow-git file checkpoints kept per working directory. `/undo` restores from them. |

## Environment variables

Six apply to every command, and `proteus --help` lists exactly these.

| Variable | What it does |
| --- | --- |
| `PROTEUS_HOME` | Workspace + config directory (default `~/.proteus`). |
| `PROTEUS_ORIGIN` | Kinu app origin. |
| `PROTEUS_TOKEN` | Account access token, for CI. |
| `PROTEUS_MODEL` | Default model ID. |
| `PROTEUS_BASE_URL` | LLM API base URL. |
| `PROTEUS_AUTH` | LLM auth header value. |

`resolveLLMConfig` reads three more as fallbacks, each taken only when its
`PROTEUS_` counterpart is unset: `AI_GATEWAY_BASE_URL`, `AI_GATEWAY_AUTH` and
`AI_GATEWAY_MODEL`.

`resolveProviderCredentials` reads the local provider keys from the environment
before it reads `config.json`, so a shell override wins inside the shell that
sets it.

| Variable | What it stands in for |
| --- | --- |
| `OPENAI_API_KEY` | `providers.openai.apiKey` |
| `ANTHROPIC_API_KEY` | `providers.anthropic.apiKey` |
| `OPENROUTER_API_KEY` | `providers.openrouter.apiKey` |
| `CODEX_ACCESS_TOKEN` | the access token in `providers.codex` |

Precedence is the same everywhere. An explicit flag beats the environment, and
the environment beats `config.json`. `PROTEUS_BASE_URL` and `PROTEUS_AUTH` have
no `config.json` counterpart, so a direct endpoint is only ever set by a flag or
the environment.

## Editing it by hand

The file is plain JSON and the CLI rewrites it whole on every change, so edit it
while nothing else is running. It is created `0600` inside a `0700` directory
because it holds tokens and API keys. If you copy it anywhere, copy those modes
with it.

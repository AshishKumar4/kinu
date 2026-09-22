# Configuration: `~/.kinu/config.json` and the environment

Every CLI setting lives in one JSON file. `kinu setup`, `kinu auth`, `kinu provider connect`, and `kinu create` write it for you. This page is for when I want to read or edit it myself. The authoritative shape is `KinuConfig` in `packages/cli/src/config.ts`.

```
~/.kinu/                 mode 0700
  config.json               mode 0600, everything below
  bin/                      the kinu command + your workspace alias shims
  cli/                      the installed CLI build the launcher runs
  <workspace>/agent.db      one per LOCAL workspace: its entire state
  <workspace>/agent.db.partial
                            a workspace mid-creation; renamed into place
  sessions/                 recorded CLI sessions
  checkpoints/              shadow-git file snapshots that `/undo` restores from
  daemon.log, daemon.pid    the local scheduler
  device.json, pc-agent.*   the desktop execution daemon, its script and its log
```

`KINU_HOME` moves all of it. The CLI keeps no state anywhere else, so backing up this directory backs up everything it knows. The one exception is a file I name myself, such as an export archive: it lands where I point it.

## Account

| Field | Type | What it is |
| --- | --- | --- |
| `origin` | string | The Kinu deployment this CLI talks to. Defaults to `https://kinu.run`; `KINU_ORIGIN` and `--origin` override it. |
| `accessToken` | string | The interactive session token from `kinu auth`. Treat it as a password. |
| `tokenExpiresAt` | ISO date | When that token expires. The CLI refuses it after this and asks you to re-auth. |
| `user` | `{id, email, displayName?}` | Who the token belongs to. `kinu whoami` prints it. |
| `pendingRevocation` | `{token, origin, at}` | A logout the server could not confirm. The server stores only a hash, so this raw token is the one copy; the next `kinu logout` retries the revocation and then deletes it. |

`KINU_TOKEN` overrides `accessToken` for CI. I use a scoped token from `kinu tokens create`.

## Workspaces

| Field | Type | What it is |
| --- | --- | --- |
| `agents` | map | One entry per workspace you've created, keyed by name. |
| `agents.<name>.name` | string | The workspace name, repeated inside the entry. |
| `agents.<name>.mode` | `"cloud"` \| `"local"` | Where it lives. Decided at creation. |
| `agents.<name>.cloudName` / `localName` | string | Its name on that side, when it differs from the key. |
| `agents.<name>.displayName` | string | Cloud workspaces only: a cache of the title the server holds. A local workspace keeps its title in its own database. |
| `agents.<name>.alias` | string | The alias shim created for it, if any. |
| `agents.<name>.cwd` | string | For a local workspace placed in a project: the directory its file and shell plane binds to. |
| `agents.<name>.workspaceId` / `identityId` | string | The virtual workspace label that groups it with its peers, and the `workspace_identity.id` of its database, so a reused name cannot silently point the entry at a different workspace. |
| `agents.<name>.createdAt` / `updatedAt` | ISO date | Bookkeeping. |
| `aliases` | map | `alias → workspace name`. `kinu alias` / `unalias` maintain it, and each alias also has a shim in `bin/`. |

Workspace and alias names are `[A-Za-z0-9][A-Za-z0-9_-]{0,63}`, and an alias may
not shadow a built-in command name. A cloud workspace name must also be a
hostname label; [WORKSPACES.md](WORKSPACES.md) has that rule.

## Models

| Field | Type | What it is |
| --- | --- | --- |
| `model` | string | Default model spec for new work, e.g. `workers-ai/@cf/deepseek-ai/deepseek-v4-pro-0813`. `KINU_MODEL` and `--model` override it. |
| `reasoningEffort` | `"low"` \| `"medium"` \| `"high"` | Default reasoning effort. |

## Providers

Signed in, `kinu provider connect` sends my key to my Kinu account by default. The key is encrypted at rest there, and this machine reaches it through the provider proxy without holding a copy. I pass `--local` to keep one here instead, for offline use or an endpoint only this machine can see.

Two deliberate exceptions. Codex stays local. The Codex endpoint refuses Cloudflare Workers egress, so proxying it would break a credential that works today. With no account signed in, there is nowhere else to put a key, so it lands here.

`providers` is therefore the local-override store. Cloud workspaces never read it.

The model spec decides which credential answers a turn. `resolveLLMConfig` gives the account every spec the account hosts. `@cf/…` and the provider ids the proxy carries go to the proxy even when a local key is present. Every other spec falls to the local store, matched on the provider the spec names (`openai/…`, `anthropic/…`, `openrouter/…`, `codex/…`, `opencode/…`). A bare model id with no provider goes to a stored Codex or OpenAI credential, in that order. `providers.openaiCompat.default` catches anything still unmatched except a `@cf/…` spec, which a local endpoint would accept and answer with some other model. With no account session the local store is the only source.

| Field | What it is |
| --- | --- |
| `providers.openai.apiKey` | OpenAI API key. |
| `providers.anthropic.apiKey` | Anthropic API key. |
| `providers.openrouter.apiKey` | OpenRouter API key. |
| `providers.codex` | The ChatGPT device-flow tokens (`accessToken`, `refreshToken`, `expiresAt`, `metadata`), written by `kinu provider connect codex`. |
| `providers.openaiCompat.<name>` | An OpenAI-compatible endpoint: `{baseURL, apiKey?, headers?, extraHeaders?}`. |

The Claude subscription provider stores nothing here. Kinu drives Anthropic's official `claude` binary, which owns its own login.

## MCP servers

```json
{
  "mcpServers": {
    "github": { "command": "npx", "args": ["-y", "@modelcontextprotocol/server-github"], "env": { "GITHUB_TOKEN": "…" } }
  }
}
```

The standard `mcpServers` shape: `command` (required), `args`, `env`, and `timeoutMs` (per-call timeout, default 60s). These are stdio servers connected by local workspaces. Cloud workspaces get MCP servers from my account instead.

## Behaviour

| Field | Type | Default | What it does |
| --- | --- | --- | --- |
| `updateCheck` | boolean | `true` | The once-a-day "newer Kinu available" notice in an interactive terminal. Set `false` to silence it. |
| `updateCheckedAt` | number | none | Throttle state for that notice. Nothing reads a version from it. |
| `updateLatestSeen` | string | none | The newest served version the notice has seen. |
| `deviceConnectPromptDismissed` | boolean | `false` | "Don't ask again" for the chat device-connect prompt. |
| `checkpointKeep` | number | `50` | Shadow-git file checkpoints kept per working directory. `/undo` restores from them. |
| `providerRevision` | number | `0` | Goes up by one each time this machine's provider configuration changes. `kinu provider connect` runs in a different process from a resident daemon or a live chat session, so it cannot signal them; they compare this number against the one their cached provider list was built under and rebuild on any difference. Only inequality is read. |
| `localProfile` | envelope | none | The signed-out profile authority: one local envelope carrying `authority`, `version`, `digest` and the catalog. It is canonical when no account session governs this machine, and it never holds account data. |

## Environment variables

Six apply to every command. `kinu --help` lists exactly these.

| Variable | What it does |
| --- | --- |
| `KINU_HOME` | Workspace + config directory (default `~/.kinu`). |
| `KINU_ORIGIN` | Kinu app origin. |
| `KINU_TOKEN` | Account access token, for CI. |
| `KINU_MODEL` | Default model ID. |
| `KINU_BASE_URL` | LLM API base URL. |
| `KINU_AUTH` | LLM auth header value. |

`resolveLLMConfig` reads three more as fallbacks. Each applies only when its `KINU_` counterpart is unset. The three are `AI_GATEWAY_BASE_URL`, `AI_GATEWAY_AUTH`, and `AI_GATEWAY_MODEL`.

`resolveProviderCredentials` reads the local provider keys from the environment before it reads `config.json`. A shell override wins inside the shell that sets it.

| Variable | What it stands in for |
| --- | --- |
| `OPENAI_API_KEY` | `providers.openai.apiKey` |
| `ANTHROPIC_API_KEY` | `providers.anthropic.apiKey` |
| `OPENROUTER_API_KEY` | `providers.openrouter.apiKey` |
| `CODEX_ACCESS_TOKEN` | the access token in `providers.codex` |

Precedence is the same everywhere. An explicit flag beats the environment, and the environment beats `config.json`. `KINU_BASE_URL` and `KINU_AUTH` have no `config.json` counterpart. I set a direct endpoint only by flag or environment.

## Editing it by hand

The file is plain JSON. The CLI rewrites it whole on every change, so I edit it while nothing else is running. It is created `0600` inside a `0700` directory because it holds tokens and API keys. If I copy it anywhere, I copy those modes with it.

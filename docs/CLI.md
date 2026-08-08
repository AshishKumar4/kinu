# Proteus CLI reference

> Maintained by Claude (AI-edited documentation, presented as-is); verify against the code when precision matters.
>
> Generated from the command registry (`packages/cli/src/program.ts`) by
> `bun run docs:cli`. Edit the registration, not this file.

Create and chat with self-evolving agent workspaces.

```
proteus <command> [options]
```

## Commands

### Account

| Command | What it does |
| --- | --- |
| [`proteus setup`](#proteus-setup) | Connect your account; optionally configure local-only model credentials |
| [`proteus provider [action] [name]`](#proteus-provider-action-name) | List or connect model and account providers |
| [`proteus auth`](#proteus-auth) | Sign the CLI into your Proteus account |
| [`proteus whoami`](#proteus-whoami) | Show the signed-in Proteus account |
| [`proteus logout`](#proteus-logout) | Sign out of the Proteus CLI |
| [`proteus tokens [action] [name]`](#proteus-tokens-action-name) | Manage long-lived CI access tokens (list, create, revoke) |

### Workspaces

| Command | What it does |
| --- | --- |
| [`proteus create [name]`](#proteus-create-name) | Create a new workspace |
| [`proteus list`](#proteus-list) | List all workspaces |
| [`proteus status <name>`](#proteus-status-name) | Show workspace state and evolution history |
| [`proteus workspace delete <name>`](#proteus-workspace-delete-name) | Permanently delete a cloud workspace |
| [`proteus alias <workspace> [alias]`](#proteus-alias-workspace-alias) | Create an executable command alias for a workspace |
| [`proteus unalias <alias>`](#proteus-unalias-alias) | Remove an executable command alias |
| [`proteus aliases`](#proteus-aliases) | List configured workspace aliases |
| [`proteus export <name>`](#proteus-export-name) | Back up a workspace — local or cloud — to a portable archive |
| [`proteus import <file>`](#proteus-import-file) | Restore a workspace archive into a local workspace |

### Running

| Command | What it does |
| --- | --- |
| [`proteus run <name> [prompt...]`](#proteus-run-name-prompt) | Run a workspace once, or open chat when no prompt is provided |
| [`proteus chat [name]`](#proteus-chat-name) | Interactive conversation with a workspace |
| [`proteus acp <name>`](#proteus-acp-name) | Serve a workspace over the Agent Client Protocol on stdio (Zed, JetBrains, neovim) |
| [`proteus exec [prompt...]`](#proteus-exec-prompt) | Run one workspace task headlessly and exit (CI-friendly; executor passthrough lives under `executors`) |
| [`proteus executors <name> [executor] [command...]`](#proteus-executors-name-executor-command) | List executors, or run a command in one |
| [`proteus sessions [workspace]`](#proteus-sessions-workspace) | List recorded CLI sessions |
| [`proteus stop <name>`](#proteus-stop-name) | Stop current cloud work or cancel local background jobs |

### Configure

| Command | What it does |
| --- | --- |
| [`proteus model <name> [spec]`](#proteus-model-name-spec) | Show or change a workspace model |
| [`proteus effort <name> [level]`](#proteus-effort-name-level) | Show or change workspace reasoning effort (low, medium, high) |
| [`proteus tools <name>`](#proteus-tools-name) | List a workspace tool surface |
| [`proteus triggers <name> [action] [value]`](#proteus-triggers-name-action-value) | List, schedule, cancel, or create workspace triggers |
| [`proteus webhook <name> <label>`](#proteus-webhook-name-label) | Create a durable webhook trigger for a cloud workspace |

### Inspect & evolve

| Command | What it does |
| --- | --- |
| [`proteus evolve <name>`](#proteus-evolve-name) | Trigger an MCTS evolution cycle |
| [`proteus jobs <name> [action] [id]`](#proteus-jobs-name-action-id) | List or cancel background jobs |
| [`proteus state <name>`](#proteus-state-name) | Show the durable workspace state snapshot |
| [`proteus memory <name> [query...]`](#proteus-memory-name-query) | Read or search workspace memory |
| [`proteus events <name>`](#proteus-events-name) | List recent workspace events |
| [`proteus timeline <name>`](#proteus-timeline-name) | List the run/evolution/MCTS timeline |
| [`proteus mcts <name> [nodeId]`](#proteus-mcts-name-nodeid) | Inspect MCTS search history |
| [`proteus heads <name>`](#proteus-heads-name) | Inspect parallel reasoning branch runs |
| [`proteus gepa <name> [runId]`](#proteus-gepa-name-runid) | Inspect GEPA optimization runs |
| [`proteus alignment <name>`](#proteus-alignment-name) | K_align: correction rate per 100 graded turns, by scaffold version, with 95% intervals |
| [`proteus label [action] [name] [file]`](#proteus-label-action-name-file) | Hand-label turn outcomes (export \| ingest \| ensemble \| report) to measure and correct the classifier; mine \| score for the free behavioural corpus |
| [`proteus product <name>`](#proteus-product-name) | Inspect product self-customization state |

### This computer

| Command | What it does |
| --- | --- |
| [`proteus connect`](#proteus-connect) | Link this computer as the desktop execution daemon |
| [`proteus desktop [action]`](#proteus-desktop-action) | Connect or inspect the local desktop execution daemon |
| [`proteus daemon [action]`](#proteus-daemon-action) | Manage the local scheduler daemon: start, stop, restart, status, logs |
| [`proteus doctor`](#proteus-doctor) | Inspect local Proteus CLI installation state |
| [`proteus update [target]`](#proteus-update-target) | Update the installed Proteus command |
| [`proteus uninstall`](#proteus-uninstall) | Remove the installed Proteus command |

## Reference

### proteus setup

Connect your account; optionally configure local-only model credentials.

| Option | What it does |
| --- | --- |
| `--origin <url>` | Proteus app origin |
| `--provider <name>` | Provider: codex, openai, openrouter, anthropic, openai-compatible, skip |
| `--model <id>` | Default model for the selected provider |
| `--local-model` | Configure credentials for local-only agents |
| `-y, --yes` | Accept recommended setup choices where possible |
| `--skip-cloud` | Skip account sign-in |

### proteus provider [action] [name]

List or connect model and account providers.

Also: `proteus providers`

| Option | What it does |
| --- | --- |
| `--origin <url>` | Proteus app origin |
| `--model <id>` | Default model for the selected provider |

### proteus auth

Sign the CLI into your Proteus account.

| Option | What it does |
| --- | --- |
| `--origin <url>` | Proteus app origin |

### proteus whoami

Show the signed-in Proteus account.

| Option | What it does |
| --- | --- |
| `--origin <url>` | Proteus app origin |

### proteus logout

Sign out of the Proteus CLI.

| Option | What it does |
| --- | --- |
| `--origin <url>` | Proteus app origin |

### proteus tokens [action] [name]

Manage long-lived CI access tokens (list, create, revoke).

| Option | What it does |
| --- | --- |
| `--name <name>` | Token name for create |
| `--scopes <scopes>` | Comma-separated scopes: workspace.exec, workspace.read |
| `--json` | Print raw JSON |

### proteus create [name]

Create a new workspace.

| Option | What it does |
| --- | --- |
| `--purpose <text>` | Workspace purpose |
| `--mode <mode>` | Workspace mode: cloud or local |
| `--alias <name>` | Create an executable alias command |
| `--origin <url>` | Proteus app origin for first-use sign-in |
| `--no-alias-shim` | Do not create an alias shim |
| `--model <id>` | Model ID (env: PROTEUS_MODEL) |
| `--base-url <url>` | LLM API base URL (env: PROTEUS_BASE_URL) |
| `--auth <header>` | Auth header value (env: PROTEUS_AUTH) |

### proteus list

List all workspaces.

### proteus status <name>

Show workspace state and evolution history.

| Option | What it does |
| --- | --- |
| `--model <id>` | Model ID (env: PROTEUS_MODEL) |
| `--base-url <url>` | LLM API base URL (env: PROTEUS_BASE_URL) |
| `--auth <header>` | Auth header value (env: PROTEUS_AUTH) |

### proteus workspace delete <name>

Permanently delete a cloud workspace.

| Option | What it does |
| --- | --- |
| `-y, --yes` | Skip the confirmation prompt |

### proteus alias <workspace> [alias]

Create an executable command alias for a workspace.

### proteus unalias <alias>

Remove an executable command alias.

### proteus aliases

List configured workspace aliases.

### proteus export <name>

Back up a workspace — local or cloud — to a portable archive.

| Option | What it does |
| --- | --- |
| `-o, --output <file>` | Output file path |

### proteus import <file>

Restore a workspace archive into a local workspace.

| Option | What it does |
| --- | --- |
| `-n, --name <name>` | Workspace name (default: the name recorded in the archive) |

### proteus run <name> [prompt...]

Run a workspace once, or open chat when no prompt is provided.

| Option | What it does |
| --- | --- |
| `--mode <mode>` | Output mode: text, json, or rpc (default: "text") |
| `-c, --continue` | Continue the latest recorded CLI session |
| `-r, --resume` | Resume the latest recorded CLI session |
| `--session <idOrPath>` | Use a recorded CLI session |
| `--fork <idOrPath>` | Fork a recorded CLI session into a new session |
| `--session-dir <dir>` | Override CLI session storage directory |
| `--no-session` | Do not record this CLI run |
| `-n, --name <label>` | Human-readable session label |
| `--model <id>` | Model ID (env: PROTEUS_MODEL) |
| `--base-url <url>` | LLM API base URL (env: PROTEUS_BASE_URL) |
| `--auth <header>` | Auth header value (env: PROTEUS_AUTH) |

### proteus chat [name]

Interactive conversation with a workspace.

| Option | What it does |
| --- | --- |
| `--classic` | Use classic readline interface instead of TUI |
| `-c, --continue` | Continue the latest recorded CLI session |
| `-r, --resume` | Resume the latest recorded CLI session |
| `--session <idOrPath>` | Use a recorded CLI session |
| `--fork <idOrPath>` | Fork a recorded CLI session into a new session |
| `--session-dir <dir>` | Override CLI session storage directory |
| `--no-session` | Do not record this CLI chat |
| `--model <id>` | Model ID (env: PROTEUS_MODEL) |
| `--base-url <url>` | LLM API base URL (env: PROTEUS_BASE_URL) |
| `--auth <header>` | Auth header value (env: PROTEUS_AUTH) |

### proteus acp <name>

Serve a workspace over the Agent Client Protocol on stdio (Zed, JetBrains, neovim).

| Option | What it does |
| --- | --- |
| `--no-auto-evolve` | Run without turn/session auto-evolution (local workspaces) |
| `--session-dir <dir>` | Override CLI session storage directory |
| `--model <id>` | Model ID (env: PROTEUS_MODEL) |
| `--base-url <url>` | LLM API base URL (env: PROTEUS_BASE_URL) |
| `--auth <header>` | Auth header value (env: PROTEUS_AUTH) |

### proteus exec [prompt...]

Run one workspace task headlessly and exit (CI-friendly; executor passthrough lives under `executors`).

| Option | What it does |
| --- | --- |
| `-w, --workspace <name>` | Workspace to run (defaults to the only configured workspace) |
| `--json` | Emit line-delimited JSON events |
| `--no-auto-evolve` | Run without turn/session auto-evolution (local workspaces) |
| `--resume <sessionId>` | Continue a recorded CLI session |
| `--session-dir <dir>` | Override CLI session storage directory |
| `--no-session` | Do not record this run |
| `-n, --name <label>` | Human-readable session label |
| `--model <id>` | Model ID (env: PROTEUS_MODEL) |
| `--base-url <url>` | LLM API base URL (env: PROTEUS_BASE_URL) |
| `--auth <header>` | Auth header value (env: PROTEUS_AUTH) |

### proteus executors <name> [executor] [command...]

List executors, or run a command in one.

| Option | What it does |
| --- | --- |
| `--json` | Print raw JSON |

### proteus sessions [workspace]

List recorded CLI sessions.

| Option | What it does |
| --- | --- |
| `--session-dir <dir>` | Override CLI session storage directory |
| `--path` | Show session file paths |
| `--show <idOrPath>` | Show a specific session path |

### proteus stop <name>

Stop current cloud work or cancel local background jobs.

| Option | What it does |
| --- | --- |
| `--json` | Print raw JSON |

### proteus model <name> [spec]

Show or change a workspace model.

| Option | What it does |
| --- | --- |
| `--model <id>` | Model ID (env: PROTEUS_MODEL) |
| `--base-url <url>` | LLM API base URL (env: PROTEUS_BASE_URL) |
| `--auth <header>` | Auth header value (env: PROTEUS_AUTH) |

### proteus effort <name> [level]

Show or change workspace reasoning effort (low, medium, high).

### proteus tools <name>

List a workspace tool surface.

| Option | What it does |
| --- | --- |
| `--model <id>` | Model ID (env: PROTEUS_MODEL) |
| `--base-url <url>` | LLM API base URL (env: PROTEUS_BASE_URL) |
| `--auth <header>` | Auth header value (env: PROTEUS_AUTH) |

### proteus triggers <name> [action] [value]

List, schedule, cancel, or create workspace triggers.

| Option | What it does |
| --- | --- |
| `--auth-mode <mode>` | Webhook auth mode: hmac, bearer, or mtls |
| `--secret <value>` | Webhook secret for hmac or bearer auth |
| `--content-type <type>` | Accepted webhook content type |
| `--rate-limit <n>` | Webhook deliveries per minute |
| `--json` | Print raw JSON |
| `--model <id>` | Model ID (env: PROTEUS_MODEL) |
| `--base-url <url>` | LLM API base URL (env: PROTEUS_BASE_URL) |
| `--auth <header>` | Auth header value (env: PROTEUS_AUTH) |

### proteus webhook <name> <label>

Create a durable webhook trigger for a cloud workspace.

| Option | What it does |
| --- | --- |
| `--auth-mode <mode>` | Webhook auth mode: hmac, bearer, or mtls |
| `--secret <value>` | Webhook secret for hmac or bearer auth |
| `--content-type <type>` | Accepted webhook content type |
| `--rate-limit <n>` | Webhook deliveries per minute |
| `--json` | Print raw JSON |

### proteus evolve <name>

Trigger an MCTS evolution cycle.

| Option | What it does |
| --- | --- |
| `--budget <n>` | MCTS iterations (default: "2") |
| `--branches <n>` | Branches per expansion (default: "2") |
| `--model <id>` | Model ID (env: PROTEUS_MODEL) |
| `--base-url <url>` | LLM API base URL (env: PROTEUS_BASE_URL) |
| `--auth <header>` | Auth header value (env: PROTEUS_AUTH) |

### proteus jobs <name> [action] [id]

List or cancel background jobs.

| Option | What it does |
| --- | --- |
| `--json` | Print raw JSON |
| `--model <id>` | Model ID (env: PROTEUS_MODEL) |
| `--base-url <url>` | LLM API base URL (env: PROTEUS_BASE_URL) |
| `--auth <header>` | Auth header value (env: PROTEUS_AUTH) |

### proteus state <name>

Show the durable workspace state snapshot.

| Option | What it does |
| --- | --- |
| `--json` | Print raw JSON |

### proteus memory <name> [query...]

Read or search workspace memory.

| Option | What it does |
| --- | --- |
| `--limit <n>` | Search result limit |
| `--json` | Print raw JSON |

### proteus events <name>

List recent workspace events.

| Option | What it does |
| --- | --- |
| `--variant <name>` | Filter by event variant |
| `--since <time>` | Filter events after a timestamp or date |
| `--limit <n>` | Event limit |
| `--json` | Print raw JSON |

### proteus timeline <name>

List the run/evolution/MCTS timeline.

| Option | What it does |
| --- | --- |
| `--limit <n>` | Timeline row limit |
| `--json` | Print raw JSON |

### proteus mcts <name> [nodeId]

Inspect MCTS search history.

| Option | What it does |
| --- | --- |
| `--json` | Print raw JSON |

### proteus heads <name>

Inspect parallel reasoning branch runs.

| Option | What it does |
| --- | --- |
| `--limit <n>` | Run limit |
| `--json` | Print raw JSON |

### proteus gepa <name> [runId]

Inspect GEPA optimization runs.

| Option | What it does |
| --- | --- |
| `--limit <n>` | Run limit |
| `--json` | Print raw JSON |

### proteus alignment <name>

K_align: correction rate per 100 graded turns, by scaffold version, with 95% intervals.

| Option | What it does |
| --- | --- |
| `--json` | Print raw JSON |

### proteus label [action] [name] [file]

Hand-label turn outcomes (export | ingest | ensemble | report) to measure and correct the classifier; mine | score for the free behavioural corpus.

| Option | What it does |
| --- | --- |
| `--out <file>` | Where to write the labeling file (export) or the corpus report (mine, score) |
| `--size <n>` | Turns to draw (export) |
| `--labeler <name>` | Who is labeling (ingest) |
| `--models <a,b>` | Judges to run, comma-separated (ensemble, score; default: one per connected vendor) |
| `--root <dir>` | Claude Code transcript root (mine, score; default: ~/.claude/projects) |
| `--projects <a,b>` | Only projects whose directory name contains one of these (mine, score) |
| `--limit <n>` | Labeled turns to put to the raters (score; default: 25) |
| `--json` | Print raw JSON |

### proteus product <name>

Inspect product self-customization state.

| Option | What it does |
| --- | --- |
| `--limit <n>` | Change limit |
| `--json` | Print raw JSON |

### proteus connect

Link this computer as the desktop execution daemon.

| Option | What it does |
| --- | --- |
| `--label <name>` | Device label |

### proteus desktop [action]

Connect or inspect the local desktop execution daemon.

| Option | What it does |
| --- | --- |
| `--label <name>` | Device label |

### proteus daemon [action]

Manage the local scheduler daemon: start, stop, restart, status, logs.

### proteus doctor

Inspect local Proteus CLI installation state.

### proteus update [target]

Update the installed Proteus command.

| Option | What it does |
| --- | --- |
| `--origin <url>` | Proteus app origin |
| `--force` | Reinstall even if already current |

### proteus uninstall

Remove the installed Proteus command.

| Option | What it does |
| --- | --- |
| `--purge` | Also remove ~/.proteus data |

## Environment

These apply to every command.

| Variable | What it does |
| --- | --- |
| `PROTEUS_HOME` | Workspace + config directory (default ~/.proteus) |
| `PROTEUS_ORIGIN` | Proteus app origin |
| `PROTEUS_TOKEN` | Account access token (CI) |
| `PROTEUS_MODEL` | Default model ID |
| `PROTEUS_BASE_URL` | LLM API base URL |
| `PROTEUS_AUTH` | LLM auth header value |

## Examples

```bash
proteus setup
proteus provider connect codex
proteus create jarvis --mode cloud --alias jarvis
jarvis "review this repo"
proteus sessions jarvis
proteus daemon status
proteus connect
```

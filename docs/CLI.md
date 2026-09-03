# Kinu CLI reference

> Generated from the command registry (`packages/cli/src/program.ts`) by
> `bun run docs:cli`. Edit the registration, not this file.

Create and chat with self-evolving agent workspaces.

```
kinu <command> [options]
```

## Commands

### Account

| Command | What it does |
| --- | --- |
| [`kinu setup`](#kinu-setup) | Connect your account; optionally configure local-only model credentials |
| [`kinu provider [action] [name]`](#kinu-provider-action-name) | List, connect, or disconnect model and account providers |
| [`kinu auth`](#kinu-auth) | Sign the CLI into your Kinu account |
| [`kinu whoami`](#kinu-whoami) | Show the signed-in Kinu account |
| [`kinu logout`](#kinu-logout) | Sign out and revoke this CLI session |
| [`kinu sessions [action] [hash]`](#kinu-sessions-action-hash) | Manage live CLI sessions (list, revoke, revoke --all) |
| [`kinu tokens [action] [name]`](#kinu-tokens-action-name) | Manage long-lived CI access tokens (list, create, revoke) |

### Workspaces

| Command | What it does |
| --- | --- |
| [`kinu create [name]`](#kinu-create-name) | Create a new workspace |
| [`kinu list`](#kinu-list) | List all workspaces |
| [`kinu status <name>`](#kinu-status-name) | Show workspace state and evolution history |
| [`kinu workspace delete <name>`](#kinu-workspace-delete-name) | Permanently delete a cloud workspace |
| [`kinu alias <workspace> [alias]`](#kinu-alias-workspace-alias) | Create an executable command alias for a workspace |
| [`kinu unalias <alias>`](#kinu-unalias-alias) | Remove an executable command alias |
| [`kinu aliases`](#kinu-aliases) | List configured workspace aliases |
| [`kinu export <name>`](#kinu-export-name) | Back up a workspace (local or cloud) to a portable archive |
| [`kinu import <file>`](#kinu-import-file) | Restore a workspace archive into a local workspace |

### Running

| Command | What it does |
| --- | --- |
| [`kinu run <name> [prompt...]`](#kinu-run-name-prompt) | Run a workspace once, or open chat with no prompt |
| [`kinu chat [name]`](#kinu-chat-name) | Interactive conversation with a workspace |
| [`kinu acp <name>`](#kinu-acp-name) | Serve a workspace over the Agent Client Protocol on stdio (Zed, JetBrains, neovim) |
| [`kinu exec [prompt...]`](#kinu-exec-prompt) | Run one workspace task headlessly and exit (CI-friendly; executor passthrough lives under `executors`) |
| [`kinu executors <name> [executor] [command...]`](#kinu-executors-name-executor-command) | List executors, or run a command in one |
| [`kinu transcripts [agent]`](#kinu-transcripts-agent) | List recorded terminal transcripts (diagnostics; never conversations) |
| [`kinu stop <name>`](#kinu-stop-name) | Stop current cloud work or cancel local background jobs |

### Configure

| Command | What it does |
| --- | --- |
| [`kinu model <name> [spec]`](#kinu-model-name-spec) | Show or change a workspace model |
| [`kinu effort <name> [level]`](#kinu-effort-name-level) | Show or change workspace reasoning effort (low, medium, high) |
| [`kinu tools <name>`](#kinu-tools-name) | List a workspace tool surface |
| [`kinu triggers <name> [action] [value]`](#kinu-triggers-name-action-value) | List, schedule, cancel, or create workspace triggers |
| [`kinu webhook <name> <label>`](#kinu-webhook-name-label) | Create a durable webhook trigger for a cloud workspace |

### Inspect & evolve

| Command | What it does |
| --- | --- |
| [`kinu evolve <name>`](#kinu-evolve-name) | Trigger an MCTS evolution cycle |
| [`kinu jobs <name> [action] [id]`](#kinu-jobs-name-action-id) | List or cancel background jobs |
| [`kinu state <name>`](#kinu-state-name) | Show the durable workspace state snapshot |
| [`kinu spend <name>`](#kinu-spend-name) | Show what the whole workspace spent, by producer and by mission |
| [`kinu memory <name> [query...]`](#kinu-memory-name-query) | Read or search workspace memory |
| [`kinu events <name>`](#kinu-events-name) | List recent workspace events |
| [`kinu timeline <name>`](#kinu-timeline-name) | List the run/evolution/MCTS timeline |
| [`kinu mcts <name> [nodeId]`](#kinu-mcts-name-nodeid) | Inspect MCTS search history |
| [`kinu heads <name>`](#kinu-heads-name) | Inspect parallel reasoning branch runs |
| [`kinu debug <name>`](#kinu-debug-name) | Fetch everything about a workspace into one bundle: identity, messages, runs and their events, heads, MCTS searches, background jobs, evolution state, memory and facts |
| [`kinu gepa <name> [runId]`](#kinu-gepa-name-runid) | Inspect GEPA optimization runs, or run a pass with --run |
| [`kinu alignment <name>`](#kinu-alignment-name) | K_align: correction rate per 100 graded turns, by scaffold version, with 95% intervals |
| [`kinu label [action] [name] [file]`](#kinu-label-action-name-file) | Hand-label turn outcomes (export \| ingest \| ensemble \| report) to measure and correct the classifier; mine \| score for the free behavioural corpus |
| [`kinu release <name>`](#kinu-release-name) | Inspect the governed release lane: sources, changes, checks, approvals, deployments |

### This computer

| Command | What it does |
| --- | --- |
| [`kinu connect`](#kinu-connect) | Link this computer as the desktop execution daemon (the link renews while the daemon connects; re-run after 180 idle days) |
| [`kinu desktop [action]`](#kinu-desktop-action) | Connect or inspect the local desktop execution daemon |
| [`kinu daemon [action] [workspace]`](#kinu-daemon-action-workspace) | Manage the local scheduler daemon: start, stop, restart, status, logs, tick |
| [`kinu doctor`](#kinu-doctor) | Inspect local Kinu CLI installation state |
| [`kinu update [target]`](#kinu-update-target) | Update the installed Kinu command |
| [`kinu uninstall`](#kinu-uninstall) | Remove the installed Kinu command |

## Reference

### kinu setup

Connect your account; optionally configure local-only model credentials.

| Option | What it does |
| --- | --- |
| `--origin <url>` | Kinu app origin |
| `--provider <name>` | Provider: codex, openai, openrouter, anthropic, openai-compatible, skip |
| `--model <id>` | Default model for the selected provider |
| `--local-model` | Configure credentials for local-only agents |
| `--local` | Keep the provider key on this machine instead of your Kinu account |
| `-y, --yes` | Accept recommended setup choices where possible |
| `--skip-cloud` | Skip account sign-in |

### kinu provider [action] [name]

List, connect, or disconnect model and account providers.

Also: `kinu providers`

| Option | What it does |
| --- | --- |
| `--origin <url>` | Kinu app origin |
| `--model <id>` | Default model for the selected provider |
| `--local` | Keep the provider key on this machine instead of your Kinu account |

### kinu auth

Sign the CLI into your Kinu account.

| Option | What it does |
| --- | --- |
| `--origin <url>` | Kinu app origin |

### kinu whoami

Show the signed-in Kinu account.

| Option | What it does |
| --- | --- |
| `--origin <url>` | Kinu app origin |

### kinu logout

Sign out and revoke this CLI session.

| Option | What it does |
| --- | --- |
| `--origin <url>` | Kinu app origin |

### kinu sessions [action] [hash]

Manage live CLI sessions (list, revoke, revoke --all).

| Option | What it does |
| --- | --- |
| `--origin <url>` | Kinu app origin |

### kinu tokens [action] [name]

Manage long-lived CI access tokens (list, create, revoke).

| Option | What it does |
| --- | --- |
| `--name <name>` | Token name for create |
| `--scopes <scopes>` | Comma-separated scopes: workspace.read, workspace.exec, ai.proxy |
| `--json` | Print raw JSON |

### kinu create [name]

Create a new workspace.

| Option | What it does |
| --- | --- |
| `--purpose <text>` | Mission: what this workspace is for (seeds SOUL.md) |
| `--mode <mode>` | Workspace mode: cloud or local |
| `--alias <name>` | Create an executable alias command |
| `--origin <url>` | Kinu app origin for first-use sign-in |
| `--join` | Add an agent to the workspace already here, inheriting its mission (no name or purpose needed) |
| `--no-alias-shim` | Do not create an alias shim |
| `--model <id>` | Model ID (env: KINU_MODEL) |
| `--base-url <url>` | LLM API base URL (env: KINU_BASE_URL) |
| `--auth <header>` | Auth header value (env: KINU_AUTH) |

### kinu list

List all workspaces.

### kinu status <name>

Show workspace state and evolution history.

| Option | What it does |
| --- | --- |
| `--model <id>` | Model ID (env: KINU_MODEL) |
| `--base-url <url>` | LLM API base URL (env: KINU_BASE_URL) |
| `--auth <header>` | Auth header value (env: KINU_AUTH) |

### kinu workspace delete <name>

Permanently delete a cloud workspace.

| Option | What it does |
| --- | --- |
| `-y, --yes` | Skip the confirmation prompt |

### kinu alias <workspace> [alias]

Create an executable command alias for a workspace.

### kinu unalias <alias>

Remove an executable command alias.

### kinu aliases

List configured workspace aliases.

### kinu export <name>

Back up a workspace (local or cloud) to a portable archive.

| Option | What it does |
| --- | --- |
| `-o, --output <file>` | Output file path |

### kinu import <file>

Restore a workspace archive into a local workspace.

| Option | What it does |
| --- | --- |
| `-n, --name <name>` | Workspace name (default: the name recorded in the archive) |

### kinu run <name> [prompt...]

Run a workspace once, or open chat with no prompt.

| Option | What it does |
| --- | --- |
| `--mode <mode>` | Output mode: text, json, or rpc (default: "text") |
| `--transcript-dir <dir>` | Override transcript storage directory |
| `--no-transcript` | Do not record a transcript for this run |
| `--model <id>` | Model ID (env: KINU_MODEL) |
| `--base-url <url>` | LLM API base URL (env: KINU_BASE_URL) |
| `--auth <header>` | Auth header value (env: KINU_AUTH) |

### kinu chat [name]

Interactive conversation with a workspace.

| Option | What it does |
| --- | --- |
| `--classic` | Use classic readline interface instead of TUI |
| `--transcript-dir <dir>` | Override transcript storage directory |
| `--no-transcript` | Do not record a transcript for this chat |
| `--model <id>` | Model ID (env: KINU_MODEL) |
| `--base-url <url>` | LLM API base URL (env: KINU_BASE_URL) |
| `--auth <header>` | Auth header value (env: KINU_AUTH) |

### kinu acp <name>

Serve a workspace over the Agent Client Protocol on stdio (Zed, JetBrains, neovim).

| Option | What it does |
| --- | --- |
| `--no-auto-evolve` | Run without turn/session auto-evolution (local workspaces) |
| `--transcript-dir <dir>` | Override transcript storage directory |
| `--model <id>` | Model ID (env: KINU_MODEL) |
| `--base-url <url>` | LLM API base URL (env: KINU_BASE_URL) |
| `--auth <header>` | Auth header value (env: KINU_AUTH) |

### kinu exec [prompt...]

Run one workspace task headlessly and exit (CI-friendly; executor passthrough lives under `executors`).

| Option | What it does |
| --- | --- |
| `-w, --workspace <name>` | Workspace to run (defaults to the only configured workspace) |
| `--json` | Emit line-delimited JSON events |
| `--no-auto-evolve` | Run without turn/session auto-evolution (local workspaces) |
| `--transcript-dir <dir>` | Override transcript storage directory |
| `--no-transcript` | Do not record a transcript for this run |
| `--model <id>` | Model ID (env: KINU_MODEL) |
| `--base-url <url>` | LLM API base URL (env: KINU_BASE_URL) |
| `--auth <header>` | Auth header value (env: KINU_AUTH) |

### kinu executors <name> [executor] [command...]

List executors, or run a command in one.

| Option | What it does |
| --- | --- |
| `--json` | Print raw JSON |

### kinu transcripts [agent]

List recorded terminal transcripts (diagnostics; never conversations).

| Option | What it does |
| --- | --- |
| `--transcript-dir <dir>` | Override transcript storage directory |
| `--path` | Show transcript file paths |
| `--show <idOrPath>` | Show a specific transcript path |

### kinu stop <name>

Stop current cloud work or cancel local background jobs.

| Option | What it does |
| --- | --- |
| `--json` | Print raw JSON |

### kinu model <name> [spec]

Show or change a workspace model.

| Option | What it does |
| --- | --- |
| `--model <id>` | Model ID (env: KINU_MODEL) |
| `--base-url <url>` | LLM API base URL (env: KINU_BASE_URL) |
| `--auth <header>` | Auth header value (env: KINU_AUTH) |

### kinu effort <name> [level]

Show or change workspace reasoning effort (low, medium, high).

### kinu tools <name>

List a workspace tool surface.

| Option | What it does |
| --- | --- |
| `--model <id>` | Model ID (env: KINU_MODEL) |
| `--base-url <url>` | LLM API base URL (env: KINU_BASE_URL) |
| `--auth <header>` | Auth header value (env: KINU_AUTH) |

### kinu triggers <name> [action] [value]

List, schedule, cancel, or create workspace triggers.

| Option | What it does |
| --- | --- |
| `--auth-mode <mode>` | Webhook auth mode: hmac, bearer, or mtls |
| `--secret <value>` | Webhook secret for hmac or bearer auth |
| `--content-type <type>` | Accepted webhook content type |
| `--rate-limit <n>` | Webhook deliveries per minute |
| `--json` | Print raw JSON |
| `--model <id>` | Model ID (env: KINU_MODEL) |
| `--base-url <url>` | LLM API base URL (env: KINU_BASE_URL) |
| `--auth <header>` | Auth header value (env: KINU_AUTH) |

### kinu webhook <name> <label>

Create a durable webhook trigger for a cloud workspace.

| Option | What it does |
| --- | --- |
| `--auth-mode <mode>` | Webhook auth mode: hmac, bearer, or mtls |
| `--secret <value>` | Webhook secret for hmac or bearer auth |
| `--content-type <type>` | Accepted webhook content type |
| `--rate-limit <n>` | Webhook deliveries per minute |
| `--json` | Print raw JSON |

### kinu evolve <name>

Trigger an MCTS evolution cycle.

| Option | What it does |
| --- | --- |
| `--budget <n>` | MCTS iterations (default: the engine default) |
| `--branches <n>` | Branches per expansion (default: the engine default) |
| `--max-cost <usd>` | Cost ceiling in USD (default: the engine default) |
| `--model <id>` | Model ID (env: KINU_MODEL) |
| `--base-url <url>` | LLM API base URL (env: KINU_BASE_URL) |
| `--auth <header>` | Auth header value (env: KINU_AUTH) |

### kinu jobs <name> [action] [id]

List or cancel background jobs.

| Option | What it does |
| --- | --- |
| `--json` | Print raw JSON |
| `--model <id>` | Model ID (env: KINU_MODEL) |
| `--base-url <url>` | LLM API base URL (env: KINU_BASE_URL) |
| `--auth <header>` | Auth header value (env: KINU_AUTH) |

### kinu state <name>

Show the durable workspace state snapshot.

| Option | What it does |
| --- | --- |
| `--json` | Print raw JSON |

### kinu spend <name>

Show what the whole workspace spent, by producer and by mission.

| Option | What it does |
| --- | --- |
| `--json` | Print raw JSON |

### kinu memory <name> [query...]

Read or search workspace memory.

| Option | What it does |
| --- | --- |
| `--limit <n>` | Search result limit |
| `--json` | Print raw JSON |

### kinu events <name>

List recent workspace events.

| Option | What it does |
| --- | --- |
| `--variant <name>` | Filter by event variant |
| `--since <time>` | Filter events after a timestamp or date |
| `--limit <n>` | Event limit |
| `--json` | Print raw JSON |

### kinu timeline <name>

List the run/evolution/MCTS timeline.

| Option | What it does |
| --- | --- |
| `--limit <n>` | Timeline row limit |
| `--json` | Print raw JSON |

### kinu mcts <name> [nodeId]

Inspect MCTS search history.

| Option | What it does |
| --- | --- |
| `--json` | Print raw JSON |

### kinu heads <name>

Inspect parallel reasoning branch runs.

| Option | What it does |
| --- | --- |
| `--limit <n>` | Run limit |
| `--json` | Print raw JSON |

### kinu debug <name>

Fetch everything about a workspace into one bundle: identity, messages, runs and their events, heads, MCTS searches, background jobs, evolution state, memory and facts.

| Option | What it does |
| --- | --- |
| `-o, --out <file>` | Bundle output path (default: <name>.debug.jsonl) |
| `--runs <n>` | How many recent runs/head-runs/searches to page through |
| `--limit <n>` | Row limit for the smaller sections (messages, jobs, facts, ...) |
| `--json` | Print the assembled summary as JSON instead of a human report |

### kinu gepa <name> [runId]

Inspect GEPA optimization runs, or run a pass with --run.

| Option | What it does |
| --- | --- |
| `--run` | Run one optimisation pass over the scaffold |
| `--iterations <n>` | Reflection iterations (--run) |
| `--eval-size <n>` | Labeled turns to draw the split from (--run) |
| `--metric-calls <n>` | Metric-call ceiling (--run) |
| `--limit <n>` | Run limit |
| `--json` | Print raw JSON |

### kinu alignment <name>

K_align: correction rate per 100 graded turns, by scaffold version, with 95% intervals.

| Option | What it does |
| --- | --- |
| `--json` | Print raw JSON |

### kinu label [action] [name] [file]

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

### kinu release <name>

Inspect the governed release lane: sources, changes, checks, approvals, deployments.

| Option | What it does |
| --- | --- |
| `--limit <n>` | Change limit |
| `--json` | Print raw JSON |

### kinu connect

Link this computer as the desktop execution daemon (the link renews while the daemon connects; re-run after 180 idle days).

| Option | What it does |
| --- | --- |
| `--label <name>` | Name for this device (default: user@hostname); skips the name prompt |

### kinu desktop [action]

Connect or inspect the local desktop execution daemon.

| Option | What it does |
| --- | --- |
| `--label <name>` | Name for this device (default: user@hostname); skips the name prompt |

### kinu daemon [action] [workspace]

Manage the local scheduler daemon: start, stop, restart, status, logs, tick.

### kinu doctor

Inspect local Kinu CLI installation state.

### kinu update [target]

Update the installed Kinu command.

| Option | What it does |
| --- | --- |
| `--origin <url>` | Kinu app origin |
| `--force` | Reinstall even if already current |

### kinu uninstall

Remove the installed Kinu command.

| Option | What it does |
| --- | --- |
| `--purge` | Also remove ~/.kinu data |

## Environment

These apply to every command.

| Variable | What it does |
| --- | --- |
| `KINU_HOME` | Workspace + config directory (default ~/.kinu) |
| `KINU_ORIGIN` | Kinu app origin |
| `KINU_TOKEN` | Account access token (CI) |
| `KINU_MODEL` | Default model ID |
| `KINU_BASE_URL` | LLM API base URL |
| `KINU_AUTH` | LLM auth header value |

## Examples

```bash
kinu setup
kinu provider connect codex
kinu create jarvis --mode cloud --alias jarvis
jarvis "review this repo"
kinu transcripts jarvis
kinu daemon status
kinu connect
```

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
| [`kinu setup`](#kinu-setup) | Sign in to Kinu and pick a model provider for local workspaces |
| [`kinu provider [action] [name]`](#kinu-provider-action-name) | List, connect or disconnect model providers |
| [`kinu auth`](#kinu-auth) | Sign in to your Kinu account |
| [`kinu whoami`](#kinu-whoami) | Show which Kinu account you are signed in to |
| [`kinu logout`](#kinu-logout) | Sign out and revoke this CLI session |
| [`kinu sessions [action] [hash]`](#kinu-sessions-action-hash) | List or revoke CLI sessions |
| [`kinu tokens [action] [name]`](#kinu-tokens-action-name) | List, create or revoke access tokens for CI |

### Workspaces

| Command | What it does |
| --- | --- |
| [`kinu create [name]`](#kinu-create-name) | Create a workspace |
| [`kinu list`](#kinu-list) | List your workspaces |
| [`kinu status <name>`](#kinu-status-name) | Show a workspace's mission, model and evolution state |
| [`kinu workspace delete <name>`](#kinu-workspace-delete-name) | Delete a cloud workspace for good |
| [`kinu alias <workspace> [alias]`](#kinu-alias-workspace-alias) | Create a shell command that runs a workspace |
| [`kinu unalias <alias>`](#kinu-unalias-alias) | Remove a workspace's shell command |
| [`kinu aliases`](#kinu-aliases) | List workspace shell commands |
| [`kinu export <name>`](#kinu-export-name) | Back up a workspace, local or cloud, to an archive file |
| [`kinu import <file>`](#kinu-import-file) | Restore a workspace archive as a local workspace |

### Running

| Command | What it does |
| --- | --- |
| [`kinu run <name> [prompt...]`](#kinu-run-name-prompt) | Run one prompt in a workspace, or open chat when there is no prompt |
| [`kinu chat [name]`](#kinu-chat-name) | Chat with a workspace |
| [`kinu acp <name>`](#kinu-acp-name) | Serve a workspace over the Agent Client Protocol on stdio (Zed, JetBrains, neovim, Marimo) |
| [`kinu exec [prompt...]`](#kinu-exec-prompt) | Run one task without the TUI and exit, for CI and scripts |
| [`kinu executors <name> [executor] [command...]`](#kinu-executors-name-executor-command) | List a workspace's executors, or run a command in one |
| [`kinu transcripts [agent]`](#kinu-transcripts-agent) | List terminal transcripts recorded for diagnostics (they cannot be reopened as chats) |
| [`kinu stop <name>`](#kinu-stop-name) | Stop a cloud workspace's current work, or cancel a local workspace's background jobs |

### Configure

| Command | What it does |
| --- | --- |
| [`kinu model <name> [spec]`](#kinu-model-name-spec) | Show or change a workspace's model |
| [`kinu effort <name> [level]`](#kinu-effort-name-level) | Show or change a workspace's reasoning effort |
| [`kinu tools <name>`](#kinu-tools-name) | List the tools a workspace can use |
| [`kinu triggers <name> [action] [value]`](#kinu-triggers-name-action-value) | List, schedule, cancel or create workspace triggers |
| [`kinu webhook <name> <label>`](#kinu-webhook-name-label) | Create a webhook trigger for a cloud workspace |

### Inspect & evolve

| Command | What it does |
| --- | --- |
| [`kinu evolve <name>`](#kinu-evolve-name) | Run an MCTS search for one improvement to a local workspace |
| [`kinu jobs <name> [action] [id]`](#kinu-jobs-name-action-id) | List or cancel background jobs |
| [`kinu actors <name> [actorId]`](#kinu-actors-name-actorid) | List every actor a workspace holds, or show one by id |
| [`kinu state <name>`](#kinu-state-name) | Show the workspace state snapshot |
| [`kinu spend <name>`](#kinu-spend-name) | Show what a workspace spent, by producer and by mission |
| [`kinu memory <name> [query...]`](#kinu-memory-name-query) | Read or search a workspace's memory |
| [`kinu events <name>`](#kinu-events-name) | List a workspace's recent events |
| [`kinu timeline <name>`](#kinu-timeline-name) | List a workspace's runs, evolutions and MCTS searches in order |
| [`kinu mcts <name> [nodeId]`](#kinu-mcts-name-nodeid) | Show a workspace's MCTS search history |
| [`kinu heads <name>`](#kinu-heads-name) | Show parallel reasoning branch runs |
| [`kinu debug <name>`](#kinu-debug-name) | Save everything about a workspace to one file: identity, messages, runs and their events, heads, MCTS searches, background jobs, evolution state, memory and facts |
| [`kinu gepa <name> [runId]`](#kinu-gepa-name-runid) | Show GEPA optimisation runs, or run one pass with --run |
| [`kinu alignment <name>`](#kinu-alignment-name) | Show K_align: corrections per 100 graded turns for each scaffold version, with 95% intervals |
| [`kinu label [action] [name] [file]`](#kinu-label-action-name-file) | Label turn outcomes by hand to measure and correct the classifier (export, ingest, ensemble, report), or build a corpus from Claude Code transcripts (mine, score) |
| [`kinu release <name>`](#kinu-release-name) | Show a workspace's release board: sources, changes, checks, approvals and deployments |

### This computer

| Command | What it does |
| --- | --- |
| [`kinu connect`](#kinu-connect) | Connect this computer so your agents can run commands on it |
| [`kinu desktop [action]`](#kinu-desktop-action) | Connect this computer, or show its connection status and daemon logs |
| [`kinu daemon [action] [workspace]`](#kinu-daemon-action-workspace) | Start, stop or check the local scheduler daemon, or run one pass by hand with tick |
| [`kinu deploy [target] [action]`](#kinu-deploy-target-action) | Run your own Kinu: `deploy cloudflare` in your Cloudflare account, `deploy local [start\|stop\|status]` on this computer |
| [`kinu doctor`](#kinu-doctor) | Check the installed Kinu CLI: paths, origin and version |
| [`kinu update [target]`](#kinu-update-target) | Update the installed Kinu command |
| [`kinu uninstall`](#kinu-uninstall) | Remove the installed Kinu command |

## Reference

### kinu setup

Sign in to Kinu and pick a model provider for local workspaces.

| Option | What it does |
| --- | --- |
| `--origin <url>` | Kinu app origin |
| `--provider <name>` | Provider: workers-ai, codex, openai, openrouter, anthropic, openai-compatible, opencode, skip |
| `--model <id>` | Default model for the selected provider |
| `--local-model` | Set up a model provider for local workspaces |
| `--local` | Keep the provider key on this machine instead of your Kinu account |
| `-y, --yes` | Take the recommended choice at each prompt where there is one |
| `--skip-cloud` | Skip account sign-in |

```bash
kinu setup --provider codex
```

### kinu provider [action] [name]

List, connect or disconnect model providers.

Also: `kinu providers`

| Option | What it does |
| --- | --- |
| `--origin <url>` | Kinu app origin |
| `--model <id>` | Default model for the selected provider |
| `--local` | Keep the provider key on this machine instead of your Kinu account |

```bash
kinu provider connect openrouter
```

### kinu auth

Sign in to your Kinu account.

| Option | What it does |
| --- | --- |
| `--origin <url>` | Kinu app origin |

```bash
kinu auth
```

### kinu whoami

Show which Kinu account you are signed in to.

| Option | What it does |
| --- | --- |
| `--origin <url>` | Kinu app origin |

```bash
kinu whoami
```

### kinu logout

Sign out and revoke this CLI session.

| Option | What it does |
| --- | --- |
| `--origin <url>` | Kinu app origin |

```bash
kinu logout
```

### kinu sessions [action] [hash]

List or revoke CLI sessions.

| Option | What it does |
| --- | --- |
| `--origin <url>` | Kinu app origin |

```bash
kinu sessions revoke --all
```

### kinu tokens [action] [name]

List, create or revoke access tokens for CI.

| Option | What it does |
| --- | --- |
| `--name <name>` | Token name for create |
| `--scopes <scopes>` | Comma-separated scopes: workspace.read, workspace.exec, ai.proxy |
| `--json` | Print raw JSON |

```bash
kinu tokens create --name ci --scopes workspace.read,workspace.exec
```

### kinu create [name]

Create a workspace.

| Option | What it does |
| --- | --- |
| `--purpose <text>` | Say what this workspace is for. It seeds SOUL.md |
| `--mode <mode>` | Workspace mode: cloud or local |
| `--alias <name>` | Also create a shell command with this name that runs the workspace |
| `--origin <url>` | Kinu app origin for first-use sign-in |
| `--join` | Add an agent to the workspace in this directory. It takes the workspace mission, so it needs no name or purpose |
| `--no-alias-shim` | Do not create the alias shell command |
| `--model <id>` | Model ID (env: KINU_MODEL) |
| `--base-url <url>` | Base URL of your own model endpoint (env: KINU_BASE_URL) |
| `--auth <header>` | Auth header value for that endpoint (env: KINU_AUTH) |

```bash
kinu create jarvis --mode local --purpose "Keep this repo's tests green"
```

### kinu list

List your workspaces.

```bash
kinu list
```

### kinu status <name>

Show a workspace's mission, model and evolution state.

| Option | What it does |
| --- | --- |
| `--model <id>` | Model ID (env: KINU_MODEL) |
| `--base-url <url>` | Base URL of your own model endpoint (env: KINU_BASE_URL) |
| `--auth <header>` | Auth header value for that endpoint (env: KINU_AUTH) |

```bash
kinu status jarvis
```

### kinu workspace delete <name>

Delete a cloud workspace for good.

| Option | What it does |
| --- | --- |
| `-y, --yes` | Skip the confirmation prompt |

```bash
kinu workspace delete jarvis
```

### kinu alias <workspace> [alias]

Create a shell command that runs a workspace.

```bash
kinu alias jarvis j
```

### kinu unalias <alias>

Remove a workspace's shell command.

```bash
kinu unalias j
```

### kinu aliases

List workspace shell commands.

```bash
kinu aliases
```

### kinu export <name>

Back up a workspace, local or cloud, to an archive file.

| Option | What it does |
| --- | --- |
| `-o, --output <file>` | Output file path |

```bash
kinu export jarvis -o jarvis.kinu.jsonl
```

### kinu import <file>

Restore a workspace archive as a local workspace.

| Option | What it does |
| --- | --- |
| `-n, --name <name>` | Workspace name (default: the name recorded in the archive) |

```bash
kinu import jarvis.kinu.jsonl --name jarvis-copy
```

### kinu run <name> [prompt...]

Run one prompt in a workspace, or open chat when there is no prompt.

| Option | What it does |
| --- | --- |
| `--mode <mode>` | Output mode: text, json, or rpc (default: "text") |
| `--transcript-dir <dir>` | Where to store transcripts |
| `--no-transcript` | Do not record a transcript for this run |
| `--model <id>` | Model ID (env: KINU_MODEL) |
| `--base-url <url>` | Base URL of your own model endpoint (env: KINU_BASE_URL) |
| `--auth <header>` | Auth header value for that endpoint (env: KINU_AUTH) |

```bash
kinu run jarvis "summarise yesterday's commits"
```

### kinu chat [name]

Chat with a workspace.

| Option | What it does |
| --- | --- |
| `--classic` | Use the line-by-line chat instead of the full-screen TUI |
| `--transcript-dir <dir>` | Where to store transcripts |
| `--no-transcript` | Do not record a transcript for this chat |
| `--model <id>` | Model ID (env: KINU_MODEL) |
| `--base-url <url>` | Base URL of your own model endpoint (env: KINU_BASE_URL) |
| `--auth <header>` | Auth header value for that endpoint (env: KINU_AUTH) |

```bash
kinu chat jarvis
```

### kinu acp <name>

Serve a workspace over the Agent Client Protocol on stdio (Zed, JetBrains, neovim, Marimo).

| Option | What it does |
| --- | --- |
| `--no-auto-evolve` | Turn off evolution after turns and sessions (local workspaces) |
| `--transcript-dir <dir>` | Where to store transcripts |
| `--model <id>` | Model ID (env: KINU_MODEL) |
| `--base-url <url>` | Base URL of your own model endpoint (env: KINU_BASE_URL) |
| `--auth <header>` | Auth header value for that endpoint (env: KINU_AUTH) |

```bash
kinu acp jarvis
```

### kinu exec [prompt...]

Run one task without the TUI and exit, for CI and scripts.

| Option | What it does |
| --- | --- |
| `-w, --workspace <name>` | Workspace to run (default: the only one configured) |
| `--json` | Emit line-delimited JSON events |
| `--no-auto-evolve` | Turn off evolution after turns and sessions (local workspaces) |
| `--transcript-dir <dir>` | Where to store transcripts |
| `--no-transcript` | Do not record a transcript for this run |
| `--model <id>` | Model ID (env: KINU_MODEL) |
| `--base-url <url>` | Base URL of your own model endpoint (env: KINU_BASE_URL) |
| `--auth <header>` | Auth header value for that endpoint (env: KINU_AUTH) |

```bash
kinu exec -w jarvis --json "run the test suite and report failures"
```

### kinu executors <name> [executor] [command...]

List a workspace's executors, or run a command in one.

| Option | What it does |
| --- | --- |
| `--json` | Print raw JSON |

```bash
kinu executors jarvis
```

### kinu transcripts [agent]

List terminal transcripts recorded for diagnostics (they cannot be reopened as chats).

| Option | What it does |
| --- | --- |
| `--transcript-dir <dir>` | Where transcripts are stored |
| `--path` | Show transcript file paths |
| `--show <idOrPath>` | Show one transcript's file path |

```bash
kinu transcripts jarvis --path
```

### kinu stop <name>

Stop a cloud workspace's current work, or cancel a local workspace's background jobs.

| Option | What it does |
| --- | --- |
| `--json` | Print raw JSON |

```bash
kinu stop jarvis
```

### kinu model <name> [spec]

Show or change a workspace's model.

| Option | What it does |
| --- | --- |
| `--model <id>` | Model ID (env: KINU_MODEL) |
| `--base-url <url>` | Base URL of your own model endpoint (env: KINU_BASE_URL) |
| `--auth <header>` | Auth header value for that endpoint (env: KINU_AUTH) |

```bash
kinu model jarvis anthropic/claude-sonnet-4-7
```

### kinu effort <name> [level]

Show or change a workspace's reasoning effort.

```bash
kinu effort jarvis high
```

### kinu tools <name>

List the tools a workspace can use.

| Option | What it does |
| --- | --- |
| `--model <id>` | Model ID (env: KINU_MODEL) |
| `--base-url <url>` | Base URL of your own model endpoint (env: KINU_BASE_URL) |
| `--auth <header>` | Auth header value for that endpoint (env: KINU_AUTH) |

```bash
kinu tools jarvis
```

### kinu triggers <name> [action] [value]

List, schedule, cancel or create workspace triggers.

| Option | What it does |
| --- | --- |
| `--auth-mode <mode>` | Webhook auth mode: hmac, bearer, or mtls |
| `--secret <value>` | Webhook secret for hmac or bearer auth |
| `--content-type <type>` | Accepted webhook content type |
| `--rate-limit <n>` | Webhook deliveries per minute |
| `--json` | Print raw JSON |
| `--model <id>` | Model ID (env: KINU_MODEL) |
| `--base-url <url>` | Base URL of your own model endpoint (env: KINU_BASE_URL) |
| `--auth <header>` | Auth header value for that endpoint (env: KINU_AUTH) |

```bash
kinu triggers jarvis every "0 9 * * 1-5"
```

### kinu webhook <name> <label>

Create a webhook trigger for a cloud workspace.

| Option | What it does |
| --- | --- |
| `--auth-mode <mode>` | Webhook auth mode: hmac, bearer, or mtls |
| `--secret <value>` | Webhook secret for hmac or bearer auth |
| `--content-type <type>` | Accepted webhook content type |
| `--rate-limit <n>` | Webhook deliveries per minute |
| `--json` | Print raw JSON |

```bash
kinu webhook jarvis github-push --auth-mode hmac --secret "$HOOK_SECRET"
```

### kinu evolve <name>

Run an MCTS search for one improvement to a local workspace.

| Option | What it does |
| --- | --- |
| `--budget <n>` | MCTS iterations (default: the engine default) |
| `--branches <n>` | Branches per expansion (default: the engine default) |
| `--max-cost <usd>` | Cost limit in USD (default: the engine default) |
| `--model <id>` | Model ID (env: KINU_MODEL) |
| `--base-url <url>` | Base URL of your own model endpoint (env: KINU_BASE_URL) |
| `--auth <header>` | Auth header value for that endpoint (env: KINU_AUTH) |

```bash
kinu evolve jarvis --budget 4
```

### kinu jobs <name> [action] [id]

List or cancel background jobs.

| Option | What it does |
| --- | --- |
| `--json` | Print raw JSON |
| `--model <id>` | Model ID (env: KINU_MODEL) |
| `--base-url <url>` | Base URL of your own model endpoint (env: KINU_BASE_URL) |
| `--auth <header>` | Auth header value for that endpoint (env: KINU_AUTH) |

```bash
kinu jobs jarvis
```

### kinu actors <name> [actorId]

List every actor a workspace holds, or show one by id.

| Option | What it does |
| --- | --- |
| `--json` | Print raw JSON |

```bash
kinu actors jarvis
```

### kinu state <name>

Show the workspace state snapshot.

| Option | What it does |
| --- | --- |
| `--json` | Print raw JSON |

```bash
kinu state jarvis --json
```

### kinu spend <name>

Show what a workspace spent, by producer and by mission.

| Option | What it does |
| --- | --- |
| `--json` | Print raw JSON |

```bash
kinu spend jarvis
```

### kinu memory <name> [query...]

Read or search a workspace's memory.

| Option | What it does |
| --- | --- |
| `--limit <n>` | Search result limit |
| `--json` | Print raw JSON |

```bash
kinu memory jarvis deploy steps
```

### kinu events <name>

List a workspace's recent events.

| Option | What it does |
| --- | --- |
| `--variant <name>` | Filter by event variant |
| `--since <time>` | Filter events after a timestamp or date |
| `--limit <n>` | Event limit |
| `--json` | Print raw JSON |

```bash
kinu events jarvis --since 2026-09-01 --limit 20
```

### kinu timeline <name>

List a workspace's runs, evolutions and MCTS searches in order.

| Option | What it does |
| --- | --- |
| `--limit <n>` | Timeline row limit |
| `--json` | Print raw JSON |

```bash
kinu timeline jarvis --limit 20
```

### kinu mcts <name> [nodeId]

Show a workspace's MCTS search history.

| Option | What it does |
| --- | --- |
| `--json` | Print raw JSON |

```bash
kinu mcts jarvis
```

### kinu heads <name>

Show parallel reasoning branch runs.

| Option | What it does |
| --- | --- |
| `--limit <n>` | Run limit |
| `--json` | Print raw JSON |

```bash
kinu heads jarvis --limit 5
```

### kinu debug <name>

Save everything about a workspace to one file: identity, messages, runs and their events, heads, MCTS searches, background jobs, evolution state, memory and facts.

| Option | What it does |
| --- | --- |
| `-o, --out <file>` | Bundle output path (default: <name>.debug.jsonl) |
| `--runs <n>` | How many recent runs, head runs and searches to include |
| `--limit <n>` | Row limit for the smaller sections (messages, jobs, facts and so on) |
| `--json` | Print the summary as JSON instead of text |

```bash
kinu debug jarvis -o jarvis.debug.jsonl
```

### kinu gepa <name> [runId]

Show GEPA optimisation runs, or run one pass with --run.

| Option | What it does |
| --- | --- |
| `--run` | Run one optimisation pass over the scaffold |
| `--iterations <n>` | Reflection iterations (--run) |
| `--eval-size <n>` | Labeled turns to draw the split from (--run) |
| `--metric-calls <n>` | Most metric calls to make (--run) |
| `--limit <n>` | Run limit |
| `--json` | Print raw JSON |

```bash
kinu gepa jarvis --run --iterations 3
```

### kinu alignment <name>

Show K_align: corrections per 100 graded turns for each scaffold version, with 95% intervals.

| Option | What it does |
| --- | --- |
| `--json` | Print raw JSON |

```bash
kinu alignment jarvis
```

### kinu label [action] [name] [file]

Label turn outcomes by hand to measure and correct the classifier (export, ingest, ensemble, report), or build a corpus from Claude Code transcripts (mine, score).

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

```bash
kinu label export jarvis --size 20
```

### kinu release <name>

Show a workspace's release board: sources, changes, checks, approvals and deployments.

| Option | What it does |
| --- | --- |
| `--limit <n>` | Change limit |
| `--json` | Print raw JSON |

```bash
kinu release jarvis
```

### kinu connect

Connect this computer so your agents can run commands on it.

| Option | What it does |
| --- | --- |
| `--label <name>` | Name for this device (default: the hostname); skips the name prompt |

```bash
kinu connect --label studio
```

### kinu desktop [action]

Connect this computer, or show its connection status and daemon logs.

| Option | What it does |
| --- | --- |
| `--label <name>` | Name for this device (default: the hostname); skips the name prompt |

```bash
kinu desktop status
```

### kinu daemon [action] [workspace]

Start, stop or check the local scheduler daemon, or run one pass by hand with tick.

```bash
kinu daemon tick jarvis
```

### kinu deploy [target] [action]

Run your own Kinu: `deploy cloudflare` in your Cloudflare account, `deploy local [start|stop|status]` on this computer.

| Option | What it does |
| --- | --- |
| `--origin <url>` | Kinu app origin |
| `--port <n>` | Port for the local instance (default 8787) |

```bash
kinu deploy local start --port 8787
```

### kinu doctor

Check the installed Kinu CLI: paths, origin and version.

```bash
kinu doctor
```

### kinu update [target]

Update the installed Kinu command.

| Option | What it does |
| --- | --- |
| `--origin <url>` | Kinu app origin |
| `--force` | Reinstall even when already up to date |

```bash
kinu update
```

### kinu uninstall

Remove the installed Kinu command.

| Option | What it does |
| --- | --- |
| `--purge` | Also delete ~/.kinu and everything in it |

```bash
kinu uninstall
```

## Environment

These apply to every command.

| Variable | What it does |
| --- | --- |
| `KINU_HOME` | Where Kinu keeps workspaces and config (default ~/.kinu) |
| `KINU_ORIGIN` | Kinu app origin |
| `KINU_TOKEN` | Account access token, for CI |
| `KINU_MODEL` | Default model ID |
| `KINU_BASE_URL` | Base URL of your own model endpoint |
| `KINU_AUTH` | Auth header value for that endpoint |

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

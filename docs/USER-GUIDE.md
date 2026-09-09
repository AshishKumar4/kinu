# Kinu user guide: install, first workspace, daily use

My path: install Kinu, make one workspace, then use it.
[QUICKSTART.md](../QUICKSTART.md) is the short version. [docs/CLI.md](CLI.md)
is the generated reference for every command and flag.
The complete requested contract and source/evidence comparison is in
[PRODUCT-SPEC.md](PRODUCT-SPEC.md). It separates current behavior from the shared-state target.

---

## 1. What you are creating

You create workspaces. A workspace owns files and execution environments,
can hold more than one agent, and gives each agent one durable conversation
and its own memory. [docs/WORKSPACES.md](WORKSPACES.md) has the object model.
The day-one decision is where it runs.

| | `--mode cloud` | `--mode local` |
| --- | --- | --- |
| Lives in | a Durable Object on `kinu.run` | `~/.kinu/<name>/agent.db` on this machine |
| Keeps running when you close the laptop | yes | no |
| Web UI, webhooks | yes | no |
| Email inbox | code-complete; live only on a domain whose Email Routing setup is done, which `kinu.run` has not yet had ([EMAIL-INGRESS.md](EMAIL-INGRESS.md)) | no |
| Timers | yes | yes, while `kinu daemon` runs |
| Runs commands on your machine | through the desktop daemon you connect | directly |
| Needs an account | yes | no; account-backed Workers AI is billed to that Cloudflare account |

You can have both. You can move a cloud workspace onto your machine later
(§7). Shared commands use the same core, but hosting and capability availability differ.

## 2. Day one

```bash
curl -fsSL 'https://kinu.run/install.sh' | bash
kinu create jarvis --mode cloud --alias jarvis --purpose "My coding assistant"
jarvis "what changed in this repo today?"
```

The installer runs `kinu setup` in an interactive terminal: browser sign-in and
optional local model credentials. A signed-in local workspace can use Workers AI
without a separate API key. Inference bills the connected Cloudflare account.
To bring your own provider instead:

```bash
kinu provider list                 # what's connected, and where each key lives
kinu provider connect openai       # or anthropic, openrouter, codex, openai-compatible
```

Signed in, keys live in your Kinu account, not this disk, and work from every
machine you sign in on. Connecting a provider in the web UI is enough. Add
`--local` to keep a key here for offline work or an endpoint only this machine
reaches. Which credential answers a turn depends on the model: your account
serves the specs it hosts (`@cf/…` and proxied provider ids), a local key
serves everything else. Signed out, the local key is all there is.

`--alias jarvis` puts a `jarvis` command on your PATH that means
`kinu run jarvis`. It is the difference between using this daily and not.

If anything above misbehaves, run `kinu doctor` before reinstalling. It prints
where the CLI lives, whether it is on your PATH, which origin it talks to, and
whether your version matches the served one.

## 3. Talking to a workspace

```bash
jarvis "summarise the open PRs"        # one turn, then back to your shell
kinu chat jarvis                    # stay in the conversation, where it left off
kinu exec -w jarvis "run the tests" # headless: for scripts and CI
kinu exec -w jarvis --json "…"      # line-delimited JSON events instead of prose
kinu stop jarvis                    # stop the turn that's running
```

In the full-screen TUI, `Ctrl+K` opens the command palette, `Alt+W` opens the
workspace navigator, `Ctrl+,` opens settings, and `Ctrl+L` opens the model
picker. `Ctrl+O` opens tool details, `Ctrl+G` opens the external editor,
`Ctrl+P` cycles the inference tier, and `Shift+Tab` cycles reasoning effort.
`Esc` interrupts the turn or closes the active panel. `/` filters commands in
the composer.

Useful on day one:

| | |
| --- | --- |
| `/queue <text>` | send this after the current turn finishes; a plain line steers the running turn |
| `/branch <text>` | run a redirect as a parallel branch of the running turn |
| `/undo [n]` | put your files back to before a turn, then offer to rewind the conversation |
| `/fork [n]` | walk back: fork the conversation before an earlier message |
| `/takes [n]` | compare the last alternate takes and pick one |
| `/changelog` | review what the agent changed about itself; revert by index |
| `/model`, `/effort` | change model or reasoning effort mid-conversation |
| `/settings` | open model, effort, shell approval, and always-active skill settings |
| `/theme` | pick a theme with a live preview; by default the ink follows your terminal's own background |
| `/role [id]` | show or switch this agent's active role |

Transcripts record by default (`kinu transcripts` lists them). They are
diagnostics of past runs, never conversations to reopen. Your conversation
lives in the workspace and loads when it opens. `--no-transcript` skips the
record for one run. `--transcript-dir <dir>` chooses where they go.

## 4. Letting it touch your machine

A cloud workspace reaches your computer through a daemon:

```bash
kinu connect          # link this computer, with a consent prompt
kinu desktop status   # is it attached?
```

Kinu asks consent once per workspace and remembers it. The agent sees the
folder you consented to by default. The whole-filesystem grant is an explicit
switch in the web app's workspace settings.

`kinu executors <name>` lists where a workspace can run commands (the canonical
workspace, a sandbox container, or your connected machine).
`kinu executors <name> <executor> <command…>` runs one directly.

A long command is not killed for being long. Nothing deadlines the work itself.
A live session backgrounds a call still running after 30 seconds. It wakes the
agent when the call settles. Under `kinu exec` the threshold is 300 seconds,
because a one-shot process exits after the answer and a handle nobody reads is
worse than waiting. A 60-second ceiling used to sit inside the container and
kill work the layer above meant to detach. That ceiling is gone.

In the sandbox container, commands run in `/workspace`, the directory that
survives recycling. Bytes written elsewhere vanish at the next fresh instance.

## 5. Work while you are away

Cloud workspaces take work three ways with nobody at the keyboard:

```bash
kinu triggers jarvis                          # what's scheduled
kinu triggers jarvis every "0 9 * * 1-5"       # a cron timer
kinu triggers jarvis at "2026-08-09T09:00Z"    # a one-shot
kinu triggers jarvis cancel <id>
kinu webhook jarvis deploys                   # a durable webhook endpoint
```

`kinu webhook` prints the URL to give the other system, and the secret it must
sign with. The URL carries a signature of its own, so it cannot be typed or
guessed. A URL you assemble by hand is refused. If you lose it, read it back
with `kinu triggers <workspace>`, which prints the current URL for every
webhook. Cancelling the trigger stops the URL working.

Each workspace also has an email address once the mail domain is set up,
`<workspace>@kinu.run` (see [docs/EMAIL-INGRESS.md](EMAIL-INGRESS.md)). Mail
from your verified address starts a turn. The reply comes back on the thread.

Background signals arriving mid-turn splice into its next step. Delegated Plan
or Build work keeps its trusted mode and queues immediately for its own turn.
A busy workspace admits the message without blocking the sender.

## 6. Watching it think

```bash
kinu status jarvis     # state, evolution history
kinu timeline jarvis   # runs, evolution events, MCTS activity
kinu spend jarvis      # what the workspace spent, by producer and by mission
kinu memory jarvis     # read or search what it remembers
kinu events jarvis     # recent events (email, webhook, timer, peer)
kinu jobs jarvis       # background jobs, and cancel them
kinu actors jarvis     # every agent in this workspace, retired ones included
```

`kinu actors` answers a question that used to have no answer: a workspace is
one database, and the agents it hired, the reasoning heads it forked and the
search nodes it opened all live in it. Dismissed agents are listed and flagged
rather than dropped, because their transcripts are kept — and `kinu actors
jarvis <id>` reads what any one of them did without starting it, which is what
makes a dismissed agent readable at all.

`kinu spend` covers the whole workspace, not just the chat: judges, fast tier,
evolution engine, exploration heads, search nodes, compaction, embedder,
summed over every row the log holds rather than a recent window. It also
reports what it could NOT account for: calls the provider reported nothing
for, and calls no catalog could price. "Everything reported" and "92%, with
the embedder silent" are different facts, and you can tell them apart.

[kinu.run](https://kinu.run) presents Output (produced results), Work (plans,
jobs and waiting decisions), Files (workspace files), Releases (deliverables
and approvals), Exploration (searches), Agent (identity, memory, tools and
adaptation evidence), and Environment (executors, files and terminals).
The right-hand gauge shows context, cost and cache information. Work counts
items awaiting a decision and opens each one where that decision happens.

Exploration is where I go when the agent tried more than one thing. The
`agents` tool's `swarm` action grows a configured tree. Tool-using nodes run
the full agent loop; a declared thought unit is toolless. The preset, context
and scoring choice determine what runs. A registered verifier supplies measured
scores; judged searches and unranked ideation remain separate. Hosted actors
share canonical project files with credentialed homes and private temporary
paths. See [EXPLORATION.md](EXPLORATION.md) for the actual combinations.

Every search is a row, newest first, and the canvas draws its tree: score in a
node's fill, rollouts in its radius, a ring on the settled answer. Measured
records carry into later searches. [docs/EXPLORATION.md](EXPLORATION.md)
defines the six axes and presets.

Kinu can author a **slate**: a project with browser JS/JSX/TS/TSX, HTML/CSS and
Worker-style server routes. The UI can take input and use admitted workspace,
MCP and execution bindings. Source and versions stay in the workspace; the
preview process is derived. This is not a host-rendered JSON widget language.
[LIVE-UI.md](LIVE-UI.md) explains the hosted runtime and its limits;
[PRODUCT-SPEC.md](PRODUCT-SPEC.md#12-slates-and-authored-applications) records the acceptance boundary.

## 7. Backup, and moving a workspace

Hosted state lives in the workspace root and its actor stores. Export before deleting, and check the archive's coverage:

```bash
kinu export jarvis                       # → jarvis.kinu.jsonl
kinu export jarvis -o ~/backups/jarvis.kinu.jsonl
kinu import ~/backups/jarvis.kinu.jsonl --name jarvis-restored
```

Cloud and local exports use the same archive format, but their coverage must
be distinguished. The current cloud root export does not traverse separate
facet databases, so it does not establish a complete backup of retained child
histories. `import` restores an archive as a local workspace. The web backup
action uses the same declared export boundary; inspect it before deleting data.

Exporting a cloud workspace needs an interactive session (`kinu auth`). A
scoped CI token can run tasks but cannot take the database. Export is a live,
paged read, so pause workspace writes if you need consistency. The archive
excludes capability secrets and may omit changes made during pagination. Keep
it with your other sensitive data. `kinu workspace delete` is permanent, so
export first.

## 8. Keeping the install healthy

```bash
kinu doctor            # home, installed command, PATH, origin, version vs served
kinu update            # update the installed command
kinu daemon status     # the local scheduler (local workspaces' timers)
kinu daemon logs
kinu uninstall         # or --purge to remove ~/.kinu as well
```

The CLI checks daily for a newer served version and mentions it in an
interactive terminal. Silence it with `"updateCheck": false` in
`~/.kinu/config.json`.

## 9. Where your things live

Everything sits under `~/.kinu` (override with `KINU_HOME`):

```
~/.kinu/
  config.json        account, providers, workspaces, aliases   → docs/CONFIG.md
  bin/               the kinu command and your workspace aliases
  <workspace>/       one directory per LOCAL workspace
    agent.db         its entire state
  sessions/          recorded CLI sessions
  checkpoints/       shadow-git file snapshots that /undo restores from
  daemon.log         local scheduler log
```

[docs/CONFIG.md](CONFIG.md) documents every field and environment variable.

## 10. When something goes wrong

| What you see | What it usually is |
| --- | --- |
| `Not authenticated. Run: kinu auth` | the CLI session expired. Run `kinu auth` |
| `Source checksum mismatch` on install or update | the download and its checksum disagree; the site is mid-deploy or broken. Retry, then check `/api/health` |
| A model error the moment a turn starts | no usable credential for the chosen model. Run `kinu provider list`, then `kinu provider connect …` |
| `No agents found` | you have none yet. Run `kinu create <name>` |
| A cloud workspace won't run commands on your machine | the daemon isn't attached. Run `kinu desktop status`, then `kinu connect` |
| The daemon died and timers stopped | `kinu daemon restart`, and `kinu daemon logs` for why |

`kinu doctor` answers the install-shaped ones. If a workspace itself is
wedged, `kinu stop <name>` ends the current turn without losing its
conversation.

## 11. Feedback and the control plane

Use Feedback in the app navigation to send a note, optionally with a
full-page screenshot you annotate before submitting. Kinu blocks out secrets
before the image exists: password fields, an issued webhook secret and the
curl command carrying it, MCP server headers.

Only configured operators can open `/control`: paged users and workspaces,
incidents, feedback, weighted fleet metrics, exact run history, jobs,
approvals, executors, and its admin audit log. Destructive actions need a
fresh sign-in and explicit confirmation.

Feedback text and screenshot pointers are exact durable records. Screenshot
bytes live in R2. Analytics Engine receives a marker without note or image.

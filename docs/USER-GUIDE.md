# Kinu user guide: install, first workspace, daily use

This is how I use Kinu: install it, make one workspace, then live in it.
[QUICKSTART.md](../QUICKSTART.md) is the short version, and
[docs/CLI.md](CLI.md) lists every command and flag. What Kinu promises, and
where it falls short today, is in [PRODUCT-SPEC.md](PRODUCT-SPEC.md).

---

## 1. What you are creating

A workspace owns files and places to run commands. It can hold more than one
agent, and each agent gets one lasting conversation and its own memory.
[docs/WORKSPACES.md](WORKSPACES.md) has the object model. On day one you only
decide where it runs.

| | `--mode cloud` | `--mode local` |
| --- | --- | --- |
| Lives in | a Durable Object on `kinu.run` | `~/.kinu/<name>/agent.db` on this machine |
| Keeps running when you close the device | yes | no |
| Web UI, webhooks | yes | no |
| Email inbox | the code is done; it works only on a domain with Email Routing set up, and `kinu.run` does not have that yet ([EMAIL-INGRESS.md](EMAIL-INGRESS.md)) | no |
| Timers | yes | yes, while `kinu daemon` runs |
| Runs commands on your machine | through the desktop daemon you connect | directly |
| Needs an account | yes | no; Workers AI through your account bills that Cloudflare account |

You can have both, and you can move a cloud workspace onto your machine later
(§7). Both run the same core, but they are hosted differently and some
features exist only in one.

## 2. Day one

```bash
curl -fsSL 'https://kinu.run/install.sh' | bash
kinu create jarvis --mode cloud --alias jarvis --purpose "My coding assistant"
jarvis "what changed in this repo today?"
```

In an interactive terminal the installer runs `kinu setup`: a browser sign-in,
then optional local model credentials. Once you are signed in, a local
workspace can use Workers AI without an API key, and your Cloudflare account
pays for the inference. To use your own provider instead:

```bash
kinu provider list                 # what's connected, and where each key lives
kinu provider connect openai       # or anthropic, openrouter, codex, openai-compatible
```

When you are signed in, keys live in your Kinu account, not on this disk, and
they work on every machine you sign in from. Connecting a provider in the web
UI does the same. Add `--local` to keep a key on this machine, for offline work
or for an endpoint only this machine can reach. The model decides which
credential answers a turn: your account serves the models it hosts (`@cf/…`
and proxied provider ids), and a local key serves everything else. When you
are signed out, only local keys exist.

`--alias jarvis` puts a `jarvis` command on your PATH that runs
`kinu run jarvis`. In my experience this is what decides whether you use it
every day.

If something above goes wrong, run `kinu doctor` before you reinstall. It shows
where the CLI lives, whether it is on your PATH, which origin it talks to, and
whether your version matches the one the server offers.

## 3. Talking to a workspace

```bash
jarvis "summarise the open PRs"        # one turn, then back to your shell
kinu chat jarvis                    # stay in the conversation, where it left off
kinu exec -w jarvis "run the tests" # headless: for scripts and CI
kinu exec -w jarvis --json "…"      # line-delimited JSON events instead of prose
kinu stop jarvis                    # stop the turn that's running
```

In the full-screen TUI, `Ctrl+K` opens the command palette, `Alt+W` the
workspace navigator, `Ctrl+,` settings, and `Ctrl+L` the model picker.
`Ctrl+O` opens tool details, `Ctrl+G` opens your external editor, `Ctrl+P`
cycles the inference tier, and `Shift+Tab` cycles reasoning effort. `Esc`
interrupts the turn or closes the open panel. Type `/` in the composer to
filter commands.

The commands I use most:

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

The CLI records a transcript of each run by default (`kinu transcripts` lists
them). Transcripts are for diagnosing past runs; you cannot reopen one as a
conversation. Your conversation lives in the workspace and loads when you open
it. `--no-transcript` skips the record for one run, and
`--transcript-dir <dir>` chooses where it goes.

## 4. Letting it touch your machine

A cloud workspace reaches your computer through a daemon:

```bash
kinu connect          # link this computer, with a consent prompt
kinu desktop status   # is it attached?
```

Kinu asks consent once per workspace and remembers it. By default the agent
sees only the folder you consented to. Access to the whole filesystem is a
separate switch in the web app's workspace settings.

`kinu executors <name>` lists where a workspace can run commands: the
workspace itself, a sandbox container, or your connected machine.
`kinu executors <name> <executor> <command…>` runs one command there.

Kinu never kills a command for running long. In a live session, a call still
running after 30 seconds moves to the background and wakes the agent when it
finishes. Under `kinu exec` the limit is 300 seconds, because a one-shot
process exits after its answer and a background handle nobody reads is worse
than waiting. Nothing inside the container caps a command either, since a cap
there would kill work the layer above means to move to the background.

In the sandbox container, commands run in `/workspace`, the directory that
survives a recycle. Anything written elsewhere is gone on the next fresh
instance.

## 5. Work while you are away

A cloud workspace can start work in three ways while nobody is at the keyboard:

```bash
kinu triggers jarvis                          # what's scheduled
kinu triggers jarvis every "0 9 * * 1-5"       # a cron timer
kinu triggers jarvis at "2026-08-09T09:00Z"    # a one-shot
kinu triggers jarvis cancel <id>
kinu webhook jarvis deploys                   # a durable webhook endpoint
```

`kinu webhook` prints the URL to give the other system and the secret it must
sign with. The URL carries its own signature, so nobody can guess it, and Kinu
refuses a URL assembled by hand. If you lose it, `kinu triggers <workspace>`
prints the current URL of every webhook. Cancel the trigger and the URL stops
working.

Once the mail domain is set up, each workspace also gets an email address,
`<workspace>@kinu.run` (see [docs/EMAIL-INGRESS.md](EMAIL-INGRESS.md)). Mail
from your verified address starts a turn, and the reply comes back on the
same thread.

A background signal that arrives mid-turn joins the turn's next step.
Delegated Plan or Build work keeps its own mode and queues right away for its
own turn. A busy workspace still accepts the message, so the sender never
waits.

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

A workspace is one database. The agents it hired, the reasoning heads it
forked and the swarm nodes it started all live in it, and `kinu actors` lists
them. Dismissed agents stay on the list, flagged, because Kinu keeps their
transcripts. `kinu actors jarvis <id>` shows what any one of them did without
starting it, and it is the only way to read a dismissed agent.

`kinu spend` covers the whole workspace, not only the chat: judges, the fast
tier, the evolution engine, exploration heads, swarm nodes, compaction and the
embedder. It sums every row in the log, not a recent window. It also tells you
what it could not count: calls the provider reported nothing for, and calls no
catalog could price. So you can tell "everything reported" from "92%, with
the embedder silent".

On [kinu.run](https://kinu.run) a workspace has two views, Work and Supervise.
Its tabs are Work (plans, jobs and decisions waiting on you), Changes (what
changed since you last marked it reviewed, when anything did, where a note on
any line goes back to the agent), Files, Swarms, Agent (identity, memory,
tools and what it changed about itself) and Env (executors, files and
terminals). Each slate the agent writes gets a tab of its own. The gauge beside the tab strip shows context, cost and cache use.
Work counts the items waiting on you and opens each one where you decide it.

I open Swarms when the agent tried more than one thing. The `agents` tool's
`swarm` action grows a tree of candidates. Nodes that use tools run the full
agent loop; a node declared as a thought runs without tools. The preset, the
context and the scoring choice decide what runs. A registered verifier gives
measured scores; judged searches and unranked ideation are kept apart from
measured ones. Hosted nodes share the project files and keep their own
credentialed homes and temporary paths.
[EXPLORATION.md](EXPLORATION.md) lists the combinations that exist.

Each search is a row, newest first, and the canvas draws its tree: a node's
fill is its score, its radius is its rollouts, and a ring marks the settled
answer. Measured results carry over into later searches.
[docs/EXPLORATION.md](EXPLORATION.md) defines the six axes and the presets.

Kinu can also write a **slate**: a project with browser JS/JSX/TS/TSX,
HTML/CSS and Worker-style server routes. A slate can take input and use the
workspace, MCP and execution bindings it was allowed. Its source and versions
stay in the workspace; the running preview is rebuilt from them.
[LIVE-UI.md](LIVE-UI.md) explains the hosted runtime and its limits, and
[PRODUCT-SPEC.md](PRODUCT-SPEC.md#12-slates-and-authored-applications) records
what counts as done.

## 7. Backup, and moving a workspace

Export before you delete anything, and check what the archive covers:

```bash
kinu export jarvis                       # → jarvis.kinu.jsonl
kinu export jarvis -o ~/backups/jarvis.kinu.jsonl
kinu import ~/backups/jarvis.kinu.jsonl --name jarvis-restored
```

Cloud and local exports use the same archive format. A cloud export covers
every agent the workspace kept: hired agents and other child actors are rows
in the workspace's one SQLite database, keyed by `actor_id`. `import` always
restores an archive as a local workspace. The backup action in the web app
exports the same set of data.

Exporting a cloud workspace needs an interactive session (`kinu auth`). A
scoped CI token can run tasks but cannot take the database. Export reads the
live database page by page, so pause writes to the workspace if you need a
consistent copy; changes made during the export may be missing. The archive
leaves out capability secrets, but treat it as sensitive data anyway.
`kinu workspace delete` is permanent, so export first.

## 8. Keeping the install healthy

```bash
kinu doctor            # home, installed command, PATH, origin, version vs served
kinu update            # update the installed command
kinu daemon status     # the local scheduler (local workspaces' timers)
kinu daemon logs
kinu uninstall         # or --purge to remove ~/.kinu as well
```

Once a day the CLI checks for a newer version and tells you in an interactive
terminal. Turn that off with `"updateCheck": false` in `~/.kinu/config.json`.

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
| `Checksum mismatch` on install, or `checksum mismatch` on update | the download and its checksum disagree, usually because the site is mid-deploy or broken. Retry, then check `/api/health` |
| A model error the moment a turn starts | no usable credential for the chosen model. Run `kinu provider list`, then `kinu provider connect …` |
| `No agents found` | you have none yet. Run `kinu create <name>` |
| A cloud workspace won't run commands on your machine | the daemon isn't attached. Run `kinu desktop status`, then `kinu connect` |
| The daemon died and timers stopped | `kinu daemon restart`, and `kinu daemon logs` for why |

`kinu doctor` covers the install problems. If a workspace is stuck,
`kinu stop <name>` ends the current turn and keeps its conversation.

## 11. Feedback and the control plane

Feedback in the app's navigation sends a note to the operators, with an
optional full-page screenshot you can mark up first. Kinu blanks out secrets
before it takes the image: password fields, an issued webhook secret and the curl command that
carries it, and MCP server headers.

Only configured operators can open `/control`. It pages through users and
workspaces, and shows incidents, feedback, weighted fleet metrics, exact run
history, jobs, approvals, executors and its own admin audit log. Destructive
actions need a fresh sign-in and an explicit confirmation.

Kinu stores feedback text and screenshot pointers as exact records and the
screenshot bytes in R2. Analytics Engine gets only a marker, with no note or
image.

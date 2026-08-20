# Kinu user guide — install, first workspace, daily use

This is the path I actually use: get it installed, make one workspace, then live
with it. [QUICKSTART.md](../QUICKSTART.md) is the two-minute version and
[docs/CLI.md](CLI.md) is the generated reference for every command and flag.
This page sits between them, on what the pieces are and how a day goes.

---

## 1. What you're creating

You create **workspaces**. A workspace is a durable container: its own files,
its own execution environments, its own sessions and memory, with an agent
working inside it. [docs/WORKSPACES.md](WORKSPACES.md) has the object model.
What you decide on day one is where a workspace lives.

| | `--mode cloud` | `--mode local` |
| --- | --- | --- |
| Lives in | a Durable Object on `kinu.run` | `~/.proteus/<name>/agent.db` on this machine |
| Keeps running when you close the laptop | yes | no |
| Web UI, email inbox, webhooks, timers | yes | no |
| Runs commands on your machine | through the desktop daemon you connect | directly |
| Needs an account | yes | no (but signing in gets you free Workers AI) |

You can have both, and you can move a cloud workspace to your machine later
(§7). Everything else in this guide works the same for either.

## 2. Day one

```bash
curl -fsSL 'https://kinu.run/install.sh' | bash
kinu setup
kinu create jarvis --mode cloud --alias jarvis --purpose "My coding assistant"
jarvis "what changed in this repo today?"
```

`kinu setup` does the browser sign-in and, if you want, stores local model
credentials. Signing in with Cloudflare is what makes local workspaces free.
They default to Workers AI with no key of your own. To bring your own provider
instead:

```bash
kinu providers list                 # what's connected, and where each key lives
kinu providers connect openai       # or anthropic, openrouter, codex, openai-compatible
```

Signed in, the key goes to your Kinu account rather than this disk, and this
machine uses it through Kinu without holding a copy. The same key then works
from every machine you sign in on, and connecting a provider in the web UI is
enough. Add `--local` to keep a key on this machine instead, for offline work or
an endpoint only this machine can reach. Which one answers a turn depends on the
model you pick. Your account serves the specs it hosts (`@cf/…` and the provider
ids it proxies) and a local key serves everything else, so naming a provider in
the spec is how you choose. Signed out, the local key is all there is.

`--alias jarvis` puts a `jarvis` command on your PATH that means
`kinu run jarvis`. It is the difference between using this daily and not.

If anything above misbehaves, run `kinu doctor` before you reinstall. It
prints where the CLI is installed, whether it is on your PATH, which origin it
talks to, and whether the version you have matches the one the site serves.

## 3. Talking to a workspace

```bash
jarvis "summarise the open PRs"        # one turn, then back to your shell
kinu chat jarvis                    # stay in the conversation
kinu chat jarvis -c                 # continue where the last session ended
kinu exec -w jarvis "run the tests" # headless: for scripts and CI
kinu exec -w jarvis --json "…"      # line-delimited JSON events instead of prose
kinu stop jarvis                    # stop the turn that's running
```

Inside `kinu chat`, `/` opens the command list. The ones worth knowing on day
one:

| | |
| --- | --- |
| `/queue <text>` | send this after the current turn finishes; a plain line steers the running turn |
| `/branch <text>` | run a redirect as a parallel branch of the running turn |
| `/undo [n]` | put your files back to before a turn, then offer to rewind the conversation |
| `/fork [n]` | walk back: fork the conversation before an earlier message |
| `/takes [n]` | compare the last alternate takes and pick one |
| `/changelog` | review what the agent changed about itself; revert by index |
| `/model`, `/effort` | change model or reasoning effort mid-conversation |

Sessions are recorded by default. `kinu sessions` lists them,
`kinu chat <name> --session <id>` reopens one, and `--fork <id>` branches a
new one from it. `--no-session` opts a run out.

## 4. Letting it touch your machine

A cloud workspace reaches your computer through a daemon you run:

```bash
kinu connect          # link this computer, with a consent prompt
kinu desktop status   # is it attached?
```

Kinu asks for consent once per workspace and remembers it. By default the agent
sees the folder you consented to; the wider grant (whole filesystem) is a
deliberate switch in the web app's workspace settings, under Device access.

`kinu executors <name>` lists the places a workspace can run commands (the
canonical workspace, a sandbox container, or your connected machine), and
`kinu executors <name> <executor> <command…>` runs one directly.

## 5. Making it work while you're away

Cloud workspaces have three ways in that don't involve you typing:

```bash
kinu triggers jarvis                          # what's scheduled
kinu triggers jarvis every "0 9 * * 1-5"       # a cron timer
kinu triggers jarvis at "2026-08-09T09:00Z"    # a one-shot
kinu triggers jarvis cancel <id>
kinu webhook jarvis deploys                   # a durable webhook endpoint
```

Each workspace also has an email address once the mail domain is set up,
`<workspace>@kinu.run` (see
[docs/EMAIL-INGRESS.md](EMAIL-INGRESS.md)). Mail from your verified address
starts a turn, and the reply comes back on the thread.

Compatible background signals that arrive while a turn is running are spliced
into its next step. Delegated Plan or Build work keeps its trusted mode and
queues immediately for its own homogeneous turn, so a busy workspace still
admits the message without blocking the sender.

## 6. Watching it think

```bash
kinu status jarvis     # state, evolution history
kinu timeline jarvis   # runs, evolution events, MCTS activity
kinu memory jarvis     # read or search what it remembers
kinu events jarvis     # recent events (email, webhook, timer, peer)
kinu jobs jarvis       # background jobs, and cancel them
```

The web app at [kinu.run](https://kinu.run)
has the same information, split across six surfaces named for what you go there
to find out. **Output** is what it produced. **Work** is what it is working
through: the plan it wrote for itself, the jobs still running, everything that
has settled, and anything waiting on you at the top. **Releases** is what it is
shipping and what you have to approve. **Exploration** is every search it ran.
**Agent** is what this agent is: identity, memory, learned tools, and whether it
is measurably getting better. **Environment** is every executor it can reach,
its files and its terminal. The gauge at the far right of the strip carries the
run's own meters: context, cost and cache-hit rate.

Anything the agent needs a decision on is counted on the **Work** tab and listed
at the top of it. Each row takes you to where the decision is actually made: a
release awaiting approval, a rewrite of its own scaffold sitting under trial, a
failed job, or changes to itself you have not read.

**Exploration** is where I go when the agent tried more than one thing. The
`agents` tool's `swarm` action is the only verb that grows one of these. A swarm
is a configured tree search over agent nodes. A preset fixes the shape of the
search, and an objective says what is measured. Each node is a whole agent with
its own home directory, running the same loop as the agent you talk to. A
candidate can be scored by a verifier you registered rather than judged by a
model, so what the tab compares is measured. Every search the workspace has run
is a row, newest first, and all of them are drawn on one canvas as the trees
they are. Score sits in a node's fill, rollouts in its radius, and the line the
search paid for along the spine; a ring marks the answer it settled on. Results
carry across runs, so a later search starts from what an earlier one proved.
[docs/EXPLORATION.md](EXPLORATION.md) is the spec, with the six axes, the
presets and what a refusal means.

Kinu can add surfaces of its own. Ask it for a dashboard and it publishes a
**view**: a tab, after the six, marked with a sparkle and labelled *Written by
Kinu*. A view is data. It reads workspace state you can already see and draws
it with the same components everything else uses, so it can show you numbers but
can never ask you for anything. It also cannot wear the name of any surface
Kinu ships, including ones we have retired. "View source" shows exactly what
it wrote, and the Work tab's journal reverts it.

## 7. Backup, and moving a workspace

A cloud workspace's only copy is the Durable Object it lives in. Take your own:

```bash
kinu export jarvis                       # → jarvis.proteus.jsonl
kinu export jarvis -o ~/backups/jarvis.proteus.jsonl
kinu import ~/backups/jarvis.proteus.jsonl --name jarvis-restored
```

`export` works the same for cloud and local workspaces and writes the same
archive either way: transcripts, memory, files, crafted tools, evolution
history. `import` restores it as a **local** workspace, which also makes it the
way to pull a cloud workspace down onto your machine.

The web app has the same button, under workspace settings → Backup →
*Download archive*.

Exporting a cloud workspace needs an interactive session (`kinu auth`). A
scoped CI token can run tasks in a workspace but cannot walk off with its
database.

Two things to know. An archive is a complete copy of everything the workspace
holds, so keep it where you'd keep a password. And `kinu workspace delete` is
permanent, so export first. The prompt says so too.

## 8. Keeping the install healthy

```bash
kinu doctor            # home, installed command, PATH, origin, version vs served
kinu update            # update the installed command
kinu daemon status     # the local scheduler (local workspaces' timers)
kinu daemon logs
kinu uninstall         # or --purge to remove ~/.proteus as well
```

The CLI checks for a newer served version once a day and mentions it in an
interactive terminal. Silence it by setting `"updateCheck": false` in
`~/.proteus/config.json`.

## 9. Where your things live

Everything is under `~/.proteus` (override with `PROTEUS_HOME`):

```
~/.proteus/
  config.json        account, providers, workspaces, aliases   → docs/CONFIG.md
  bin/               the kinu command and your workspace aliases
  <workspace>/       one directory per LOCAL workspace
    agent.db         its entire state
  sessions/          recorded CLI sessions
  checkpoints/       shadow-git file snapshots that /undo restores from
  daemon.log         local scheduler log
```

[docs/CONFIG.md](CONFIG.md) documents every `config.json` field and every
environment variable.

## 10. When something goes wrong

| What you see | What it usually is |
| --- | --- |
| `Not authenticated. Run: kinu auth` | the CLI session expired. Run `kinu auth` |
| `Source checksum mismatch` on install or update | the download and its checksum disagree; the site is mid-deploy or broken. Retry, then check `/api/health` |
| A model error the moment a turn starts | no usable credential for the chosen model. Run `kinu providers list`, then `kinu providers connect …` |
| `No workspaces found` | you have none yet. Run `kinu create <name>` |
| A cloud workspace won't run commands on your machine | the daemon isn't attached. Run `kinu desktop status`, then `kinu connect` |
| The daemon died and timers stopped | `kinu daemon restart`, and `kinu daemon logs` for why |

`kinu doctor` answers the install-shaped ones. If a workspace itself is
wedged, `kinu stop <name>` ends the current turn without losing the session.

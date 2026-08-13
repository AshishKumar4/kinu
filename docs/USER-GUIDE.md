# Proteus user guide — install, first workspace, daily use

> Maintained by Claude (AI-edited documentation, presented as-is); verify against the code when precision matters.

This is the path I actually use: get it installed, make one workspace, and then
live with it. [QUICKSTART.md](../QUICKSTART.md) is the two-minute version,
[docs/CLI.md](CLI.md) is the generated reference for every command and flag, and
this page is the middle — what the pieces are and how a day with them goes.

---

## 1. What you're creating

You create **workspaces**, not agents. A workspace is a durable container: its
own files, its own execution environments, its own sessions and memory, with an
agent working inside it. [docs/WORKSPACES.md](WORKSPACES.md) has the object
model; the practical part is choosing where a workspace lives.

| | `--mode cloud` | `--mode local` |
| --- | --- | --- |
| Lives in | a Durable Object on `proteus.ashishkumarsingh.com` | `~/.proteus/<name>/agent.db` on this machine |
| Keeps running when you close the laptop | yes | no |
| Web UI, email inbox, webhooks, timers | yes | no |
| Runs commands on your machine | through the desktop daemon you connect | directly |
| Needs an account | yes | no (but signing in gets you free Workers AI) |

You can have both, and you can move a cloud workspace to your machine later
(§7). Everything else in this guide works the same for either.

## 2. Day one

```bash
curl -fsSL 'https://proteus.ashishkumarsingh.com/install.sh' | bash
proteus setup
proteus create jarvis --mode cloud --alias jarvis --purpose "My coding assistant"
jarvis "what changed in this repo today?"
```

`proteus setup` does the browser sign-in and, if you want, stores local model
credentials. Signing in with Cloudflare is what makes local workspaces free —
they default to Workers AI with no key of your own. To bring your own provider
instead:

```bash
proteus providers list                 # what's connected, and where each key lives
proteus providers connect openai       # or anthropic, openrouter, codex, openai-compatible
```

Signed in, the key goes to your Proteus account rather than this disk, and this
machine uses it through Proteus without holding a copy — so the same key works
from every machine you sign in on, and connecting a provider in the web UI is
enough. Add `--local` to keep a key on this machine instead (for offline work,
or an endpoint only this machine can reach); a local key always wins.

`--alias jarvis` puts a `jarvis` command on your PATH that means
`proteus run jarvis`. It is the difference between using this daily and not.

If anything above misbehaves, `proteus doctor` prints where the CLI is installed, whether it is on
your PATH, which origin it talks to, and whether the version you have matches
the one the site serves — start there, not with a reinstall.

## 3. Talking to a workspace

```bash
jarvis "summarise the open PRs"        # one turn, then back to your shell
proteus chat jarvis                    # stay in the conversation
proteus chat jarvis -c                 # continue where the last session ended
proteus exec -w jarvis "run the tests" # headless: for scripts and CI
proteus exec -w jarvis --json "…"      # line-delimited JSON events instead of prose
proteus stop jarvis                    # stop the turn that's running
```

Inside `proteus chat`, `/` opens the command list. The ones worth knowing on day
one:

| | |
| --- | --- |
| `/queue <text>` | send this after the current turn finishes, instead of interrupting |
| `/branch <text>` | run a redirect as a parallel branch of the running turn |
| `/undo [n]` | put your files back to before a turn, then offer to rewind the conversation |
| `/fork [n]` | walk back: fork the conversation before an earlier message |
| `/takes [n]` | compare the last alternate takes and pick one |
| `/changelog` | review what the agent changed about itself; revert by index |
| `/model`, `/effort` | change model or reasoning effort mid-conversation |

Sessions are recorded by default. `proteus sessions` lists them,
`proteus chat <name> --session <id>` reopens one, and `--fork <id>` branches a
new one from it. `--no-session` opts a run out.

## 4. Letting it touch your machine

A cloud workspace reaches your computer through a daemon you run:

```bash
proteus connect          # link this computer, with a consent prompt
proteus desktop status   # is it attached?
```

Consent is asked once per workspace and remembered. By default the agent sees
the folder you consented to; the wider grant (whole filesystem) is a deliberate
switch in the web app's workspace settings, under Device access.

`proteus executors <name>` lists the places a workspace can run commands (your
machine, a sandbox container, a Nimbus sandbox), and
`proteus executors <name> <executor> <command…>` runs one directly.

## 5. Making it work while you're away

Cloud workspaces have three ways in that don't involve you typing:

```bash
proteus triggers jarvis                          # what's scheduled
proteus triggers jarvis every "0 9 * * 1-5"       # a cron timer
proteus triggers jarvis at "2026-08-09T09:00Z"    # a one-shot
proteus triggers jarvis cancel <id>
proteus webhook jarvis deploys                   # a durable webhook endpoint
```

Each workspace also has an email address —
`<workspace>@proteus.ashishkumarsingh.com` — once the mail domain is set up
(see [docs/EMAIL-INGRESS.md](EMAIL-INGRESS.md)). Mail from your verified address
starts a turn, and the reply comes back on the thread.

Anything that arrives while a turn is running is spliced into that turn at its
next step rather than queued behind it, so a busy workspace still hears you.

## 6. Watching it think

```bash
proteus status jarvis     # state, evolution history
proteus timeline jarvis   # runs, evolution events, MCTS activity
proteus memory jarvis     # read or search what it remembers
proteus events jarvis     # recent events (email, webhook, timer, peer)
proteus jobs jarvis       # background jobs, and cancel them
```

The web app at [proteus.ashishkumarsingh.com](https://proteus.ashishkumarsingh.com)
has the same information, split across six surfaces named for what you go there
to find out: **Output** (what it produced), **Work** (what it is working
through: the plan it wrote for itself, the jobs still running, everything
that has settled, and anything waiting on you at the top), **Releases** (what
it is shipping, and what you have to approve), **Exploration** (every time it
forked itself to try more than one approach, each fork drawn as the tree it
is), **Agent** (what this agent is: identity, memory, learned tools, and
whether it is measurably getting better), **Environment** (every executor it
can reach, its files and its terminal). The gauge at the far right of the strip
is the run's own instrument panel: context, cost and cache-hit rate.

Two things worth knowing. Anything the agent needs a decision on (a release
awaiting approval, a rewrite of its own scaffold sitting under trial, a failed
job, changes to itself you have not read) is counted on the **Work** tab and
listed at the top of it, and each row takes you to where the decision is
actually made. And a fork is one list whatever the agent chose to do with it:
a merge is a tree one level deep, a competition is the same tree deeper with
scores on it, and past forks are the rows below the newest one.

Proteus can add surfaces of its own. Ask it for a dashboard and it publishes
a **view**: a tab, after the six, marked with a sparkle and labelled *written by
Proteus*. A view is data, not code — it reads workspace state you can already see
and draws it with the same components everything else uses, so it can show you
numbers but can never ask you for anything. It also cannot wear the name of any
surface Proteus ships, including ones we have retired. "View source" shows
exactly what it wrote, and the Work tab's journal reverts it.

## 7. Backup, and moving a workspace

A cloud workspace's only copy is the Durable Object it lives in. Take your own:

```bash
proteus export jarvis                       # → jarvis.proteus.jsonl
proteus export jarvis -o ~/backups/jarvis.proteus.jsonl
proteus import ~/backups/jarvis.proteus.jsonl --name jarvis-restored
```

`export` works the same for cloud and local workspaces and writes the same
archive either way: transcripts, memory, files, crafted tools, evolution
history. `import` restores it as a **local** workspace, which also makes it the
way to pull a cloud workspace down onto your machine.

The web app has the same button — workspace settings → Backup → *Download
archive*.

Exporting a cloud workspace needs an interactive session (`proteus auth`). A
scoped CI token can run tasks in a workspace but cannot walk off with its
database.

Two things to know. An archive is a complete copy of everything the workspace
holds, so keep it where you'd keep a password. And `proteus workspace delete` is
permanent — export first; the prompt says so too.

## 8. Keeping the install healthy

```bash
proteus doctor            # home, installed command, PATH, origin, version vs served
proteus update            # update the installed command
proteus daemon status     # the local scheduler (local workspaces' timers)
proteus daemon logs
proteus uninstall         # or --purge to remove ~/.proteus as well
```

The CLI checks for a newer served version once a day and mentions it in an
interactive terminal. Silence it by setting `"updateCheck": false` in
`~/.proteus/config.json`.

## 9. Where your things live

Everything is under `~/.proteus` (override with `PROTEUS_HOME`):

```
~/.proteus/
  config.json        account, providers, workspaces, aliases   → docs/CONFIG.md
  bin/               the proteus command and your workspace aliases
  <workspace>/       one directory per LOCAL workspace
    agent.db         its entire state
  sessions/          recorded CLI sessions
  daemon.log         local scheduler log
```

[docs/CONFIG.md](CONFIG.md) documents every `config.json` field and every
environment variable.

## 10. When something goes wrong

| What you see | What it usually is |
| --- | --- |
| `Not authenticated. Run: proteus auth` | the CLI session expired — `proteus auth` |
| `Source checksum mismatch` on install or update | the download and its checksum disagree; the site is mid-deploy or broken. Retry, then check `/api/health` |
| A model error the moment a turn starts | no usable credential for the chosen model — `proteus providers list`, then `proteus providers connect …` |
| `No workspaces found` | you have none yet — `proteus create <name>` |
| A cloud workspace won't run commands on your machine | the daemon isn't attached — `proteus desktop status`, then `proteus connect` |
| The daemon died and timers stopped | `proteus daemon restart`, and `proteus daemon logs` for why |

`proteus doctor` answers the install-shaped ones. If a workspace itself is
wedged, `proteus stop <name>` ends the current turn without losing the session.

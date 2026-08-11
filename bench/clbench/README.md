# Proteus on Continual Learning Bench

> This document is edited and maintained by Claude and is presented as-is.

[Continual Learning Bench](https://github.com/pgasawa/continual-learning-bench)
(Berkeley/Snorkel, [arXiv:2606.05661](https://arxiv.org/abs/2606.05661)) measures
one thing I care about more than any benchmark we wrote ourselves: **`mean_gain`,
the stateful system's reward minus the reward of the same system run stateless**.
That is Proteus's central claim, scored by someone else's harness on someone
else's tasks.

This directory is the adapter. It stays in the Proteus repo because it is our
code about our agent; CL-Bench is cloned separately and left unmodified.

## Layout

```
bench/clbench/
  proteus/            the `proteus` CL-Bench system (symlinked into a checkout)
  configs/            run configs covering both axes
```

## Setup

Clone and install CL-Bench (Python 3.13, `uv`, and Docker for the tasks that
containerize):

```bash
git clone https://github.com/pgasawa/continual-learning-bench
cd continual-learning-bench
uv sync --all-extras && source .venv/bin/activate
```

Link the adapter in as a system. CL-Bench discovers systems from
`src/systems/<name>/`, and a symlink is discovered like a directory, so the code
stays here and the checkout stays clean:

```bash
ln -s /path/to/Proteus/bench/clbench/proteus src/systems/proteus
clbench inspect system proteus     # confirms registration + every parameter
```

Some tasks need a one-time dataset download:

```bash
clbench setup database_exploration   # ~800 MB from Hugging Face, free
```

## Credentials

The adapter reads the model key at runtime and never takes it as a parameter, so
nothing secret lands in a committed config or on a command line. It looks in
`$OPENROUTER_API_KEY` (or `$<PROVIDER>_API_KEY`, or whatever `api_key_env`
names), then falls back to `providers.<provider>.apiKey` in
`~/.proteus/config.json`.

Every run gets a throwaway `PROTEUS_HOME`, so your own workspaces are never
opened, mutated, or measured. That home goes through `bench/isolation.py`, the
one rule both benchmark adapters share: it refuses an unset or relative home,
your real `~/.proteus`, and anything inside the Proteus checkout.

## Running

```bash
# Wiring check — one interaction, no trace, no baseline.
clbench smoke exploitable_poker --system proteus

# The smallest slice with a real reward and a real baseline: 5 hands.
clbench run --config /path/to/Proteus/bench/clbench/configs/exploitable_poker_proteus_quick_test.json \
  --runs 1 --max-workers 3
```

`clbench run` runs the stateful rollout *and* the stateless baseline, then
reports `mean_gain` between them. Budget before you start a full schedule: the
paper reports **$7.6–62.8 per full run**, and every default schedule is 12–120
instances.

## The two axes

"A stateful, self-evolving agent improves over a task sequence" is two claims.
The configs separate them.

| Config | `persist_workspace` | `auto_evolve` | What it isolates |
|---|---|---|---|
| `*_proteus.json` | on | on | the full claim |
| `*_proteus_no_evolve.json` | on | off | memory without evolution |
| `*_proteus_fresh_workspace.json` | off | on | evolution without carried state |

**Workspace persistence.** One durable workspace — memory, lessons, CraftStore,
the evolved scaffold — carried across the sequence. CL-Bench already drives half
of this itself: the stateless baseline builds a fresh system per instance, and
each system gets its own throwaway home, so "stateless" really is a v0
workspace. `persist_workspace=False` covers the *within-run* case, resetting the
workspace at every instance boundary so a single rollout can be its own control.

**Self-evolution.** `auto_evolve=False` passes `proteus exec --no-auto-evolve`,
which turns off turn- and session-level evolution while leaving durable state
intact. Persistent state with evolution off is the control that says how much of
any gain is evolution rather than plain memory.

`single_conversation` (the direct analogue of the Codex adapter's flag, on by
default) captures the CLI session id from the first turn and replays it with
`--resume`, so Proteus sees its own prior turns rather than only the task's
latest observation.

## How a turn actually works

One benchmark turn is one `proteus exec --json`. Proteus runs its full agentic
loop inside that turn — its own tools, memory, and scaffold, in its own
throwaway working directory — and returns one structured action.

Worth being clear about, because it is easy to expect otherwise: **no CL-Bench
task hands a system a live handle on its environment.** `Query` carries a
prompt, a Pydantic schema, and the previous observation; every task, including
the containerized ones, is driven one structured action per turn, and the task
owns the container. So Proteus's tool calls happen in *its* workspace, and the
benchmark environment is reached through the returned action. The built-in
`codex` and `claude` systems work exactly the same way.

## Cost

Token usage comes from the CLI's `turn_end` event and is reported to CL-Bench as
a `UsageEvent` per turn, which prices it through litellm. When litellm has no
rate for the model, CL-Bench records `pricing_error` and leaves `cost_usd` null;
the token counts are still exact. Cross-check real spend against the provider:

```bash
curl -s https://openrouter.ai/api/v1/key -H "Authorization: Bearer $OPENROUTER_API_KEY"
```

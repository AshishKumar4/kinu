# Kinu on Continual Learning Bench

[Continual Learning Bench](https://github.com/pgasawa/continual-learning-bench)
(Berkeley/Snorkel, [arXiv:2606.05661](https://arxiv.org/abs/2606.05661)) measures
one thing I care about more than any benchmark we wrote ourselves: **`mean_gain`,
the stateful system's reward minus the reward of the same system run stateless**.
That is Kinu's central claim, scored by someone else's harness on someone
else's tasks.

This directory is the adapter. It stays in the Kinu repo because it is our
code about our agent; CL-Bench is cloned separately and left unmodified.

## Layout

```
bench/clbench/
  kinu/            the `kinu` CL-Bench system (symlinked into a checkout)
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
ln -s /path/to/Proteus/bench/clbench/kinu src/systems/kinu
clbench inspect system kinu     # confirms registration + every parameter
```

Point it at a checkout that will still be there. `clbench inspect system kinu`
fails on a dangling link, and a symlink into a throwaway agent worktree under
`.claude/worktrees/` dies the moment that worktree is removed — which is how the
first install of this adapter was wired. Repoint with `ln -sfn` rather than
re-cloning CL-Bench.

Some tasks need a one-time dataset download:

```bash
clbench setup database_exploration   # ~800 MB from Hugging Face, free
```

## Credentials

The default is native Workers AI DeepSeek V4 Pro 0813 through Kinu's
signed-in `/api/user/ai/v1` proxy. The adapter reads `$KINU_TOKEN` first,
then the session written by `kinu auth` in `~/.kinu/config.json`. For a
long benchmark, mint a scoped token and keep it in the run environment:

```bash
kinu tokens create --name clbench --scopes ai.proxy
export KINU_TOKEN=pta_…
```

The credential is read at runtime and never accepted as a system parameter, so
it does not land in a committed config or on a command line. A direct Workers
AI endpoint can be selected explicitly with `base_url` set to
`https://api.cloudflare.com/client/v4/accounts/<account-id>/ai/v1`; that path
reads `$CLOUDFLARE_API_TOKEN`. Explicit BYO comparisons remain available by
setting `model`, `base_url`, and `provider` together; known providers read their
own key, while a custom endpoint must name its exact `api_key_env`.

Every run gets a throwaway `KINU_HOME`, so your own workspaces are never
opened, mutated, or measured. `_env()` strips every `KINU_*` variable the
operator's shell holds and re-adds exactly six: `HOME` and `KINU_HOME` (both,
so the child cannot fall back to `~/.kinu` even if it ignored the latter),
`KINU_BASE_URL`, `KINU_MODEL`, `KINU_AUTH` — the resolved bearer, via
the environment rather than argv, because a command line is world-readable — and
`CI=1`. Anything else named `KINU_*` cannot reach a measured run at all,
which is worth knowing before blaming one for a result: `KINU_MAX_STEPS` was
suspected of causing the first run's one-step turns and was ruled out on exactly
this filter, leaving the default of 500 steps against 1 used. That home goes through `bench/isolation.py`, the
one rule both benchmark adapters share: it refuses an unset or relative home,
your real `~/.kinu`, and anything inside the Kinu checkout.

## Running

```bash
# Wiring check — one interaction, no trace, no baseline.
clbench smoke exploitable_poker --system kinu

# The smallest slice with a real reward and a real baseline: 5 hands.
clbench run --config /path/to/Proteus/bench/clbench/configs/exploitable_poker_kinu_quick_test.json \
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
| `*_kinu.json` | on | on | the full claim |
| `*_kinu_no_evolve.json` | on | off | memory without evolution |
| `*_kinu_fresh_workspace.json` | off | on | evolution without carried state |

**Workspace persistence.** One durable workspace — memory, lessons, CraftStore,
the evolved scaffold — carried across the sequence. CL-Bench already drives half
of this itself: the stateless baseline builds a fresh system per instance, and
each system gets its own throwaway home, so "stateless" really is a v0
workspace. `persist_workspace=False` covers the *within-run* case, resetting the
workspace at every instance boundary so a single rollout can be its own control.

**Self-evolution.** `auto_evolve=False` passes `kinu exec --no-auto-evolve`,
which turns off turn- and session-level evolution while leaving durable state
intact. Persistent state with evolution off is the control that says how much of
any gain is evolution rather than plain memory.

`single_conversation` (the direct analogue of the Codex adapter's flag, on by
default) captures the CLI session id from the first turn and replays it with
`--resume`, so Kinu sees its own prior turns rather than only the task's
latest observation.

## How a turn actually works

One benchmark turn is one `kinu exec --json`. Kinu runs its full agentic
loop inside that turn — its own tools, memory, and scaffold, in its own
throwaway working directory — and returns one structured action.

Worth being clear about, because it is easy to expect otherwise: **no CL-Bench
task hands a system a live handle on its environment.** `Query` carries a
prompt, a Pydantic schema, and the previous observation; every task, including
the containerized ones, is driven one structured action per turn, and the task
owns the container. So Kinu's tool calls happen in *its* workspace, and the
benchmark environment is reached through the returned action. The built-in
`codex` and `claude` systems work exactly the same way.

## Cost

Token usage comes from the CLI's `turn_end` event and is reported to CL-Bench as
a `UsageEvent` per turn, which prices it through litellm. When litellm has no
rate for the model, CL-Bench records `pricing_error` and leaves `cost_usd` null;
the token counts are still exact. The Cloudflare dashboard remains authoritative
for the account's Workers AI entitlement and billing.

The `turn_end` payload is sparse: a field is present only when the provider
reported it, and the whole `usage` object is absent when the provider reported
nothing. A turn like that records NO `UsageEvent` rather than a row of zeros, so
"nobody metered this turn" stays visible instead of being priced as free.

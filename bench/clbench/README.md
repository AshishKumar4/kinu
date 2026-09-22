# Kinu on Continual Learning Bench

[Continual Learning Bench](https://github.com/pgasawa/continual-learning-bench)
(Berkeley/Snorkel, [arXiv:2606.05661](https://arxiv.org/abs/2606.05661)) measures
the thing I care about more than any benchmark we wrote ourselves: `mean_gain`,
the stateful system's reward minus the reward of the same system run
stateless. That is Kinu's central claim, scored by someone else's harness on
someone else's tasks.

This directory is the adapter. It lives here because it is our code about our
agent. CL-Bench is cloned separately and left unmodified.

## Layout

```
bench/clbench/
  kinu/               the `kinu` CL-Bench system (symlinked into a checkout)
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
`src/systems/<name>/` and follows a symlink like a directory, so the code stays
here and the checkout stays clean:

```bash
ln -s /path/to/Kinu/bench/clbench/kinu src/systems/kinu
clbench inspect system kinu     # confirms registration + every parameter
```

Point the symlink at a checkout that will still exist. A link into a throwaway
agent worktree under `.claude/worktrees/` breaks when that worktree is removed;
the first install of this adapter was wired that way. Repoint with `ln -sfn`
instead of re-cloning.

Some tasks need a one-time dataset download:

```bash
clbench setup database_exploration   # ~800 MB from Hugging Face, free
```

## Credentials

By default the adapter calls Workers AI (`@cf/zai-org/glm-5.3`) through the
signed-in `/api/user/ai/v1` proxy at `https://kinu.run`. The only credential
it reads for that proxy is `$KINU_EVAL_TOKEN`, a token for the `eval-service`
account. It never borrows the session `kinu auth` stored in
`~/.kinu/config.json`. Mint the token against kinu.run and keep it in the run
environment:

```bash
kinu auth --origin https://kinu.run
kinu tokens create --name clbench --scopes ai.proxy
export KINU_EVAL_TOKEN=pta_…
```

The credential is read at runtime and never accepted as a system parameter, so
it cannot land in a committed config or on a command line.

A run may only point at `https://kinu.run`, a loopback dev server, or a direct
Workers AI endpoint
(`https://api.cloudflare.com/client/v4/accounts/<account-id>/ai/v1`, which
reads `$CLOUDFLARE_API_TOKEN`). The adapter refuses any other `base_url`
before it reads a key, so an OpenAI, Anthropic or OpenRouter endpoint is
refused too. A loopback endpoint that is not Kinu's proxy path must name its
exact `api_key_env`.

Every run gets a throwaway `KINU_HOME`, so your own workspaces are never
opened, changed or measured. `_env()` drops every `KINU_*` variable in your
shell and sets exactly six: `HOME` and `KINU_HOME` (both, so the child cannot
fall back to `~/.kinu` even if it ignored the latter), `KINU_BASE_URL`,
`KINU_MODEL` and the resolved bearer `KINU_AUTH` (in the environment rather
than argv, because a command line is world-readable), and `CI=1`. Nothing else
named `KINU_*` reaches a measured run.

Keep that in mind before blaming the environment for a result. A first run's
one-step turns were blamed on a step ceiling, and there is none: a turn whose
caller names no stop condition runs under `UNBOUNDED_STEPS`
(`packages/core/src/chat.ts`). A one-step turn means the model chose to stop
or a tool failed. The harness configured neither.

The throwaway home goes through `bench/isolation.py`, the one rule both
benchmark adapters share. It refuses an unset or relative home, anything at or
under your real `~/.kinu`, and anything inside the Kinu checkout.

## Running

```bash
# Wiring check: one interaction, no trace, no baseline.
clbench smoke exploitable_poker --system kinu

# The smallest slice with a real reward and a real baseline: 5 hands.
clbench run --config /path/to/Kinu/bench/clbench/configs/exploitable_poker_kinu_quick_test.json \
  --runs 1 --max-workers 3
```

`clbench run` runs the stateful rollout and the stateless baseline, then
reports `mean_gain`. Budget before you start a full schedule: the paper
reports $7.6 to $62.8 per full run, and every default schedule is 12 to 120
instances.

## The two axes

"A stateful, self-evolving agent improves over a task sequence" is two claims.
The configs separate them.

| Config | `persist_workspace` | `auto_evolve` | What it isolates |
|---|---|---|---|
| `*_kinu.json` | on | on | the full claim |
| `*_kinu_no_evolve.json` | on | off | memory without evolution |
| `*_kinu_fresh_workspace.json` | off | on | evolution without carried state |

One durable workspace carries memory, lessons, the CraftStore and the evolved
scaffold across the sequence. CL-Bench already drives half of this itself: the
stateless baseline builds a fresh system per instance, each with its own
throwaway home, so "stateless" really is a v0 workspace.
`persist_workspace=False` covers the *within-run* case. It resets the
workspace at every instance boundary, so a single rollout can be its own
control.

With `auto_evolve=False`, the run passes `kinu exec --no-auto-evolve`, which
turns off turn- and session-level evolution and leaves durable state intact.
Persistent state with evolution off is the control that says how much of any
gain is evolution rather than plain memory.

`single_conversation` (the counterpart of the Codex adapter's flag, on by
default and in every config here) captures the CLI session id from the first
turn's `session` event and passes it back with `--resume`, so Kinu would see
its own prior turns and not only the task's latest observation. `kinu exec`
at HEAD has no `--resume` option and exits with `unknown option '--resume'`,
so with this flag on, the second turn of a run fails.

## How a turn works

One benchmark turn is one `kinu exec --json`. Kinu runs its full agentic loop
inside that turn, with its own tools, memory and scaffold, in its own
throwaway working directory, and returns one structured action.

No CL-Bench task hands a system a live handle on its environment. `Query`
carries a prompt, a Pydantic schema and the previous observation, and every
task, the containerized ones included, is driven one structured action per
turn. The task owns the container. Kinu's tool calls happen in its own
workspace and reach the benchmark environment only through the returned
action. The built-in `codex` and `claude` systems work the same way.

## Cost

Token usage comes from the CLI's `turn_end` events. The adapter reports it to
CL-Bench as a `UsageEvent` per turn, and CL-Bench prices it through litellm.
When litellm has no rate for the model, CL-Bench records `pricing_error` and
leaves `cost_usd` null; the token counts are still exact. The Cloudflare
dashboard is the authority on the account's Workers AI entitlement and
billing.

The `turn_end` payload is sparse. A field appears only when the provider
reported it, and the whole `usage` object is absent when the provider reported
nothing. Such a turn records no `UsageEvent` at all, so an unmetered turn
stays visible instead of being priced as free.

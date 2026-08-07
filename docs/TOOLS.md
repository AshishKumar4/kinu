# Agent Tools — Built-in Tool Architecture

> Maintained by Claude (AI-edited documentation, presented as-is); verify against the code when precision matters.

The agent exposes a small set of **built-in top-level tools** to the LLM (the canonical list is `BUILTIN_TOOLS` in `packages/core/src/tools/registry.ts` — 12 names). All filesystem operations are available as `workspace.*` APIs inside the `execute_tools` codemode sandbox. Crafted tools from the CraftStore are injected into the same sandbox as `codemode.*` (the default namespace exposed by `@cloudflare/codemode`'s `createCodeTool`) and, via the preamble, as `tools.<name>`.

Both surfaces (Cloudflare Workers and CLI) consume the same factory
`buildBuiltinTools` from `@proteus/core/tools`. The registry and descriptions
live in `packages/core/src/tools/registry.ts`; neither the CF orchestrator nor
the CLI chat loop hand-builds tools anymore. Only `execute_tools`, `run`, and
`memory` are unconditional; every other tool is registered when — and only
when — the backend wires its deps. That gating is structural rather than
flagged, and it is how a subordinate gets `report` and never gets `team`.

## Top-Level Tools

| Tool | Purpose |
|------|---------|
| `execute_tools` | Codemode sandbox — LLM writes JS with `workspace.*`, `codemode.*`, and `tools.<name>` crafted-tool APIs |
| `run` | One shell command in one explicitly selected runtime |
| `skills` | List/read/invoke/create/edit/delete `SKILL.md` workflow instructions |
| `think` | Fork into 2–6 parallel copies that share the workspace, run their own tool loops, and merge back into the turn |
| `memory` | Save/search durable prose memory; recall past session transcripts (`action=sessions`) |
| `fact` | Remember/recall/forget typed keyed facts (preferences, project state, URLs) |
| `web_search` | Search the live web; ranked results (title, url, snippet, date). Key-less via DuckDuckGo; a stored `tavily` credential upgrades to ranked Tavily results |
| `web_fetch` | Fetch one URL as clean, citation-ready markdown (Cloudflare markdown service, with a local HTML→markdown fallback) |
| `team` | Staff this workspace with persistent subordinate agents — `list \| spawn \| assign \| status \| message \| dismiss` |
| `peers` | Reach the owner's *other* workspaces — `list \| ask \| send \| reply \| spawn_workspace` |
| `report` | A subordinate's progress spine back to its orchestrator — `progress \| completed \| blocked` |
| `experience` | Share and reuse proven crafts, lessons and facts across the owner's workspaces — `publish \| search \| import` |
| `product_change` | Governed lane for changing the Proteus product/UI itself |

## think, team, peers, report — the delegation surface

Delegation is **one ladder keyed on lifetime**, because lifetime is the only
axis the model actually has to decide on. The system prompt's `## Delegation`
section (`packages/core/src/prompt.ts`) renders it, with both rung triggers
pulled verbatim from `BUILTIN_TOOL_SPECS` so `registry.ts` stays the single
source:

1. **Do it yourself** — a single short coherent change.
2. **Ephemeral fork** (`think`) — spawns 2–6 copies of you on the same
   workspace, sandbox and files; each runs its own multi-step tool loop
   concurrently; findings merge back into this turn and the forks disappear.
3. **Persistent subordinate** (`team`) — long-lived, keeps its own context
   across turns, stays in the roster.

`mcts` is **not** a rung. It is a scoring policy over the same fork primitive:
`think`'s `strategy` defaults to forking (branches merge), and `strategy=mcts`
switches how branches are settled — scored against each other by execution
instead of merged. Everything about the search (UCT selection, backprop,
pruning, convergence, search-store resume, sibling diversity,
execution-grounded rewards) is unchanged and fully reachable; it is simply no
longer advertised as a co-equal first choice, which is what kept the model from
ever reaching for `think` at all.

`peers` is the one axis that is genuinely not lifetime — it crosses *workspace*
boundaries, which is why it sits outside the ladder.

- **`team`** spawns a `SubordinateAgent` — a Durable Object facet of the same
  workspace that runs the *full* turn loop on its own workstream. It shares the
  workspace's files through a parent-RPC VFS mount, so a subordinate and the
  orchestrator are looking at the same tree. `spawn` takes a role plus a mission
  (the mission runs as its first turn); `assign` hands it further tasks;
  `message` injects a conversational note into its next turn; `dismiss` retires
  it, wiping its storage unless `keep_history` is set.
- **`peers`** crosses workspace boundaries over the EventsHub peer transport:
  `ask` waits for the reply (default 120 s, max 600 — a late reply still arrives
  as an event), `send` does not wait, `reply` answers a peer message event by its
  `event_id`, and `spawn_workspace` creates or reuses a whole specialist
  workspace.
- **`report`** is registered only on subordinates. It is how a subordinate's
  findings reach the orchestrator between turns; the answer of an assigned turn
  is relayed automatically at turn end, so `report` is for milestones, not
  per-step noise.

## execute_tools — Codemode Sandbox

The primary tool. The LLM writes JavaScript code that runs in an isolated Worker via the `LOADER` binding (`@cloudflare/codemode`).

### workspace.* APIs (always available)

| API | Signature | What it does |
|-----|-----------|-------------|
| `workspace.readFile` | `(path: string) → string` | Read file contents from SqliteFS |
| `workspace.writeFile` | `(path: string, content: string) → "ok"` | Write file to SqliteFS (auto-creates parents) |
| `workspace.readdir` | `(path: string) → string[]` | List directory entries |
| `workspace.exists` | `(path: string) → boolean` | Check if a path exists |
| `workspace.exec` | `(command: string) → string` | Run POSIX shell command (cat, grep, find, sed, ls, etc.) |
| `workspace.searchMemory` | `(query: string) → results` | FTS5 search over long-term memory |
| `workspace.saveNote` | `(content: string) → "ok"` | Append note to MEMORY.md with FTS indexing |
| `workspace.listTools` | `() → Array<{name, description, qualityScore}>` | List crafted tools with their EMA scores |
| `workspace.createTool` | `(name, description, code) → {ok, name, action}` | Create/update a crafted tool in CraftStore; callable on the next `execute_tools` call in the same turn |

These come from `InlineExecutor` in `packages/core/src/execution/inline.ts`, registered as the `workspace` provider in the `ExecutionRouter`.

### codemode.* APIs (dynamically learned)

Crafted tools from the CraftStore are injected into the codemode sandbox as `codemode.*` — the default namespace exposed by `@cloudflare/codemode`'s unnamed provider (`createCodeTool`). The preamble also splices a `const tools = {…}` binding into the sandbox arrow, so the same tool answers to `tools.<name>` and crafted-tool bodies can call `workspace.*`, `codemode.*`, and each other in one lexical scope. See [CRAFT-ARCHITECTURE.md](./CRAFT-ARCHITECTURE.md).

```javascript
// Inside execute_tools:
const result = await codemode.my_custom_parser({ input: "data" });
```

**How injection works** (`buildCraftedToolSetFromExecute` in
`@proteus/core/tools/builtins.ts`):
1. `craftStore.list()` reads all crafted tools from SQLite.
2. Each row is filtered by effective score (`DEFAULT_CONFIG.craftStore.minEffectiveScoreForInjection`, default 0.2) so decayed or low-quality tools never reach the LLM.
3. Each passing tool dispatches through `deps.craftedToolExecute` — the LOADER Worker on CF, a Node adapter on the CLI. There is no host-side codegen: nothing is compiled inside `builtins.ts`, because a `new Function()` would break in a V8 isolate.
4. The resulting `craftedToolSet` is passed as the `tools` parameter to `createExecuteTool`; codemode wraps it as an unnamed provider → `codemode.*`.
5. Inside the sandbox, the LLM calls `codemode.name(args)` or `tools.name(args)`.

### agents.* APIs (delegation, dep-gated)

The `agents` delegation tool is also projected into the sandbox, so a script can
delegate with ordinary control flow. This is what makes a crafted tool able to
*be* a workflow: fan out, inspect results, branch, aggregate — then save the
routine with `workspace.createTool`, and schedule or trigger it like any other
craft. There is no workflow DSL, graph engine or step store, because
`CraftStore`, `agent.schedule` and the trigger hub already cover those.

```javascript
// Inside execute_tools — a workflow is just code.
const settled = await Promise.all(areas.map((area) => agents.fork({
  task: `review ${area}`,
  forks: [
    { task: `read ${area}`, rationale: "ground it" },
    { task: `test ${area}`, rationale: "check it" },
  ],
})));
return settled.filter((s) => !s.error && s.score > 0.6).map((s) => s.text);
```

`createAgentsCodemodeProvider` (`packages/core/src/tools/agents-codemode.ts`)
builds the namespace, and every member lands in the same `dispatchAgentsAction`
the top-level `agents` tool calls, over the same deps — one delegation path with
one more caller, not a second spawn/join implementation. Which members exist is
`agentsActionsFor(deps)`, the identical gate behind the tool's action enum: an
orchestrator gets all seven, a subordinate or a local CLI session gets `fork`
alone, and a head — handed no delegation deps — has no `agents` namespace at
all. The workspace-clone `forkAgent` RPC is deliberately not projected.

One limitation to know: a fork started inside the sandbox rides the enclosing
`execute_tools` call, and that job kind declines background resume (its side
effects cannot be safely re-run). Quick orchestration belongs in the sandbox; a
single long search that must survive an eviction belongs at the top-level tool,
which resumes from its MCTS checkpoint.

### Example usage

```javascript
// Read a file, transform it, write the result
async () => {
  const pkg = await workspace.readFile("package.json");
  const parsed = JSON.parse(pkg);
  parsed.version = "2.0.0";
  await workspace.writeFile("package.json", JSON.stringify(parsed, null, 2));
  return `Updated version to ${parsed.version}`;
}
```

```javascript
// Parallel file operations
async () => {
  const [src, tests] = await Promise.all([
    workspace.exec("find /src -name '*.ts' | wc -l"),
    workspace.exec("find /tests -name '*.test.ts' | wc -l"),
  ]);
  return { sourceFiles: src.trim(), testFiles: tests.trim() };
}
```

```javascript
// Use a crafted tool
async () => {
  const result = await codemode.parse_csv({ input: await workspace.readFile("data.csv") });
  await workspace.saveNote(`Parsed ${result.rows} rows from data.csv`);
  return result;
}
```

### No silent fallback

There is deliberately no in-process fallback. The CF backend requires the
`LOADER` Worker Loader binding and throws without it; the CLI supplies its own
Node adapter (`createNodeExecuteToolFactory` in `@proteus/cli-backend`). If
neither is wired, `execute_tools` still registers but returns a sharp
"not configured" error rather than quietly compiling code with `new Function()`,
which would break in a V8 isolate anyway.

## run — Shell Command

Direct POSIX shell execution over the agent's virtual filesystem (SqliteFS).

**Supported commands** (16): `cat`, `head`, `tail`, `ls`, `tree`, `find`, `grep`, `echo`, `mkdir`, `touch`, `rm`, `cp`, `mv`, `sed`, `stat`, `wc`

**Features**: Pipelines (`|`), redirects (`>`, `>>`), chaining (`&&`, `||`, `;`)

**Runtime routing**: the `runtime` parameter takes `workspace` (the default,
the in-VFS virtual shell), `nimbus`, `sandbox`, or `laptop` (the user's own PC,
via the pc-agent daemon and a consent prompt on first use). Anything other than
`workspace` dispatches through the `ExecutionRouter`. There is no fallback
chain: asking for a runtime that isn't provisioned returns a structured
`runtime_not_provisioned` error the UI turns into an install card, rather than
silently routing elsewhere and letting the model believe it has more access than
it does.

**Approval gate**: every command is pre-flighted through
`core/src/safety/approval-gate.ts` before it runs, on every runtime. A `deny`
verdict is refused outright; a `gate` verdict is refused with an actionable note
unless the workspace's shell approval mode is `allow_all`.

**Blocked commands**: the workspace shell is an emulator, so real programs
(`node`, `npm`, `git`, `python`, `docker`, …) exit 127 with a message pointing at
a real runtime instead.

## think — the ephemeral-fork rung

`think` dispatches through the strategy registry (`core/src/strategy/`). With
`strategy` omitted it runs `FORK_STRATEGY_ID` (`heads`): independent forks of
the agent, each running its own multi-step tool loop over a fork of the parent
workspace, merged back into the turn. `strategy=mcts` keeps the same fork
primitive but settles branches by scoring them against each other by execution.
See [MCTS.md](./MCTS.md) for the search algorithm.

## experience — cross-workspace transfer

The owner's workspaces each earn their own crafted tools, lessons and facts, and
`experience` is the one path between them: `publish` offers what THIS workspace
proved, `search` retrieves what the owner's others proved, `import` stages one
entry here. The library itself is owner-level state in the UserDO
(`core/src/experience/library.ts`), reached through the capability gate — the
two `experience.*` capabilities are `full`-tier, so a shared workspace keeps
everything inside itself and reaches neither.

Nothing crosses on assertion. Publishing is gated on local evidence, which
travels with the entry: a crafted tool needs real uses and a time-decayed score
at or above the same bar its own injection filter uses, a lesson must be
CORROBORATED (a provisional one is already kept out of this workspace's
MEMORY.md), a fact must clear its confidence bar
(`core/src/experience/publishable.ts`).

Importing reuses the two mechanisms the agent already trusts
(`core/src/experience/imports.ts`):

1. **The misevolution gate** runs on every import of every kind, not just code —
   an imported lesson lands in MEMORY.md and an imported fact lands in the
   per-turn facts block, which is the paper's memory pathway. A veto is recorded
   in `evolution_events` like any other.
2. **Provisional until corroborated.** What survives the gate is STAGED in
   `imported_experience`, not adopted: the tool hands the payload back inline so
   the agent can use it in the very turn it imported it, and that turn's own
   outcome decides. Accepted promotes it into the CraftStore / MEMORY.md /
   `agent_facts`; corrected or frustrated discards it; an ungraded turn leaves it
   waiting. `EvolutionEngine.reviewTurn` is the only place this happens.

## CraftStore Lifecycle

Crafted tools are discovered, scored, and retired automatically:

1. **Extract**: `EvolutionEngine.extractPattern()` asks the LLM to generalize successful tool-call patterns (`evolution/engine.ts`)
2. **Score**: `updateCraftScores()` updates EMA scores (α=0.3) after each turn that uses crafted tools (`craft/ema.ts`)
3. **Filter**: `filterByEffectiveScore()` drops anything below `minEffectiveScoreForInjection` (0.2), so decayed tools never reach the LLM
4. **Inject**: The surviving set is passed to `createExecuteTool` as the `tools` parameter
5. **Consolidate**: `periodicCraftConsolidation()` (`craft/consolidation.ts`) retires tools with `effectiveScore < 0.1` after at least 2 uses, and never retires the last one

## Why so few tools

The tool roster is deliberately small: filesystem work folds into the
`execute_tools` codemode sandbox rather than living as a dozen flat
per-operation tools. The whole schema surface the model sees is the 12 names
plus their docstrings — roughly 1.7k tokens of description text
(`BUILTIN_TOOL_DESCRIPTIONS`), and that stays flat as the CraftStore grows,
because crafted tools live inside the sandbox namespace instead of the top-level
schema.

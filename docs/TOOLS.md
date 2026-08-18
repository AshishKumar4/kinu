# Agent Tools — Built-in Tool Architecture

> Maintained by Claude (AI-edited documentation, presented as-is); verify against the code when precision matters.

The agent exposes a small set of **built-in top-level tools** to the LLM (the canonical list is `BUILTIN_TOOLS` in `packages/core/src/tools/registry.ts` — 8 names). The surface is deliberately this small not to save tokens but to keep the model's *decision surface* small: every native tool is a standing choice weighed on every turn it is not the answer to, and selection accuracy degrades with choice count. Files are read and changed through the `file` tool; the same operations are also available as `workspace.*` APIs inside the `execute_tools` codemode sandbox. Crafted tools from the CraftStore are injected into the same sandbox as `codemode.*` (the default namespace exposed by `@cloudflare/codemode`'s `createCodeTool`) and, via the preamble, as `tools.<name>`.

Both surfaces (Cloudflare Workers and CLI) consume the same factory
`buildBuiltinTools` from `@proteus/core/tools`. The registry and descriptions
live in `packages/core/src/tools/registry.ts`; neither the CF orchestrator nor
the CLI chat loop hand-builds tools anymore. Only `execute_tools`, `run`, `file`,
`memory` and `tasks` are unconditional; every other tool is registered only when
the backend wires its deps. That gating is structural rather than
flagged, and it is how a subordinate gets `report` and never gets the `reply`
action of `agents`.

## Top-Level Tools

| Tool | Purpose |
|------|---------|
| `execute_tools` | Codemode sandbox — LLM writes JS with `workspace.*`, `codemode.*`, `agents.*`, `memory.*`, `tasks.*`, `report.*`, `release.*`, and `tools.<name>` crafted-tool APIs |
| `run` | One shell command in one explicitly selected runtime |
| `file` | The one file plane — `read` a file, `edit` exact text inside it, `write` it whole — over the same workspace filesystem every other surface addresses |
| `agents` | The whole delegation surface — `fork \| hire \| ask \| send \| reply \| list \| dismiss` |
| `memory` | The one durable-state tool — `save \| search` prose memory, `remember \| recall \| forget` typed keyed facts, `sessions` to recall past session transcripts |
| `tasks` | The agent's own task list — `add` titles (with a `parent` for subtasks), `update` one item's status, `list` it back. One row per item in `agent_tasks`; the open half renders into the live context block every step, and into the Tasks tab |
| `web` | Live web access — `search` returns ranked results (title, url, snippet, date), `fetch` returns one URL as clean, citation-ready markdown. Key-less via DuckDuckGo + the Cloudflare markdown service; a stored `tavily` credential upgrades search |
| `report` | A subordinate's progress spine back to its orchestrator — `progress \| completed \| blocked` |

### The reach axis — declared, not derived

How the model reaches a capability is a **declared property** of that
capability, in `TOOL_REACH` (`packages/core/src/tools/registry.ts`):

```ts
report: { native: true,  codemode: 'report' }   // both surfaces
run:    { native: true,  codemode: 'workspace' } // native, plus a namespace it does not own
release:{ native: false, codemode: 'release' }   // codemode only
execute_tools: { native: true, codemode: null }  // native only — it IS the sandbox
```

`codemode` is a namespace *name* rather than a boolean because it is not always
the capability's own name: `run` and `file` are reached inside the sandbox
through the shared `workspace` primitives they already dispatch into, so they
own no namespace. A capability owns its namespace exactly when `codemode`
equals its own key.

Four things read the declaration, which is what stops the surfaces disagreeing:

| Reader | What it uses the declaration for |
| --- | --- |
| `BuiltinToolName` (a derived type) | `BUILTIN_TOOL_SPECS` / `BUILTIN_TOOL_DESCRIPTIONS` cannot compile without an entry for a newly-native capability, and `BUILTIN_TOOLS` cannot list one the declaration does not call native |
| every `*-codemode.ts` factory | takes its provider `name` straight from the table, so a namespace cannot exist for a capability the table gives none, and cannot be spelled differently — deleting `report`'s namespace from the table makes `report-codemode.ts` fail to compile |
| `explainNativeToolReferenceError` | tells the model where the capability actually is when it reaches for a native tool name inside the sandbox. This was previously a hardcoded `name === 'run'` branch, with the other seven told they were "not reachable from inside execute_tools" — false for all of them |
| `getToolDescriptions` (cf) | reports it to the Tools panel instead of guessing `nativeNames.has(name) ? 'native' : 'codemode'` |

**Reach is not permission.** What a given actor gets is reach ∩ the deps its
backend wires (`actorActiveTools`, and each tool's dep gate in
`buildBuiltinTools`). Those are two facts and the UI receives them as two
fields — `exposure` (declared) and `wired` (this actor). The old single guessed
word could not express "this agent has it on neither surface", so `report`, the
one dep-gated builtin, rendered as codemode-only on an orchestrator — which is
the report *sink* and has it on no surface at all.

Adding a `native` row grows the standing 8-tool surface. That is a decision, not
a side effect: `packages/core/tests/unit-tool-reach.test.ts` pins the native set
*and* the count, and asserts that every declared namespace has a factory
producing exactly that name with at least one member.

Two capabilities that used to be top-level tools are gone from this list on
purpose, with their machinery intact and reachable from `execute_tools`
instead — neither earned a standing choice on every turn:

- **Skills** (`SKILL.md` workflow instructions) were never really a separate
  instrument: they are ordinary files under `/workspace/skills/`, on the same
  workspace filesystem `file`/`workspace.*` already address. `read`/`create`/`edit`/
  `delete` are `workspace.readFile`/`writeFile`/`readdir`/`exec('rm …')` calls
  — a dedicated tool would have been a third path to the same bytes.
  Discovery no longer needs a tool call either: every available skill's
  name + description renders as an ambient index in the system prompt
  (`renderSkillsIndexSection`), and activation (explicit `/name`,
  `always_active` config, or an `auto_activate` keyword match) is resolved
  once at turn start, before any tool call — a mid-turn "invoke" action never
  restricted anything, because the turn's system prompt and tool surface are
  already fixed by the time a tool call could run.
- **`release`** (the governed release/deploy pipeline) is a `release.*`
  codemode namespace (`tools/release-codemode.ts`) — occasional and
  high-blast-radius enough that it should not cost a standing choice on every
  turn it is not the answer to. Same dispatcher (`runReleaseAction`,
  `tools/release-tool.ts`), same engine-presence gating, same ledger; only the
  caller changed.

Not every self-change is a tool. Some live on the codemode `workspace.*`
surface inside `execute_tools`, because they are artifacts the agent writes for
itself rather than instruments it reaches for:

| Call | What it makes |
| --- | --- |
| `workspace.createTool(name, description, code)` | a reusable crafted tool, callable the same turn |
| `workspace.createView(name, spec)` | a dashboard tab in the web UI, drawn by the host from declarative JSON |
| `workspace.editFile(path, edits)` | an exact-match edit — the SAME gate and, where the backend shares a turn ledger, the SAME read-before-write state as the native `file` tool's `edit` action |

## file — the file plane

There is **one** file tool, with three actions, for the same reason `memory` is
one tool: reading a file, replacing text inside it and creating it are one
concept, and which action a call needs follows from what the agent is doing
rather than from a comparison it has to make. The action names mirror the
codemode calls (`workspace.readFile` / `writeFile`), so there is one vocabulary
across the tool surface and the sandbox.

Everything goes through `rt.storage.vfs`. On the hosted backend that is the
authoritative `NIMBUS_SESSION`; on the CLI it is the local workspace VFS. The
same bytes are addressed by `file`, `run { runtime: "workspace" }`, and
`workspace.*`. There is no second Nimbus filesystem. Optional containers and
devices keep their own files and are reached through `sandbox.*` and
`laptop.*`.

### Why it exists

Before it, the agent had no read/write/edit primitive at all: file work went
through `run`. Over the preserved Terminal-Bench trajectories
(`bench-artifacts/`) the split was **789 `run` calls against 6 `execute_tools`
calls**, and of the 374 `run` commands in the 2.1 set, 65 were inline
`python3 -c`, 55 were heredocs, 23 were shell redirects and 14 were `sed -i` —
roughly two in five shell calls were the model hand-rolling a file mutation
through the three most failure-prone mechanisms available. None of them can
report that the text they aimed at was not there: `sed -i` exits 0 either way.

### The properties that make it worth a tool

| Property | What it means |
|---|---|
| **Exact match** | `old_text` must occur in the file **exactly once**. Absent → fail. Repeated → fail, with the occurrence count and the instruction to widen it. Occurrences are counted at every position, overlapping ones included, so `aa` in `aaa` is ambiguous rather than a silent first-match. Nothing is written either way. |
| **Atomic batches** | Every edit in a call matches the file *as it was read*, never a sibling's result; offsets are applied back-to-front. One bad anchor applies none of them. Overlapping edits are refused by name. |
| **Read-before-write** | `edit` — and `write` over an existing file — are refused unless the file has been read, and refused again (`stale`) if it changed after that read. The refusal names the exact call to make next. Authorization is keyed on the **content digest**, so a different spelling of the same path is not a spurious refusal, and a write authorizes the edits that follow it. |
| **Seen depth, not just seen** | How much was read matters. A capped or paged read authorizes an `edit` — the anchor still has to be exactly and uniquely present — but not a `write` that discards lines the model never saw. Coverage is the contiguous prefix the turn has paged through, which is exactly the shape the read's own `offset=N` recipe produces, so paging to the end earns the overwrite and the gate is never a dead end. |
| **No silent truncation** | A capped or limited `read` always names the offset that continues it, and no read is ever a bare empty string — an empty file says so, an offset past the end says so, and a single line too large to show at all hands over the `workspace.readFile`-inside-`execute_tools` recipe. A trailing newline ends the last line rather than creating a phantom one, so the offsets it hands back always resolve. Reads are counted against the same per-turn bulk budget as every other tool result (`context-budget.ts`). |
| **Nothing invisible** | A BOM is stripped from what the read shows, so the first line can be copied back as `old_text` and match. Restored on write. |
| **Faithful round-trip** | Matching happens on LF text with the BOM stripped, so an anchor typed with `\n` matches a CRLF file — but the splice lands on the **original** string at mapped indices, so a file with mixed endings keeps every ending it had outside the replaced span. Only the inserted text takes the file's ending. |
| **A gradable outcome** | Every attempt is counted by outcome into the turn's `TurnFileLedger`, and the settle spine writes one `file_edit` run event per turn: `attempts` and `applied` (calls), `failures` by reason, `recoveredPaths` and `abandonedPaths` (paths — recovery is a property of a file, not of a call). |

Reads are **not** line-numbered. `old_text` is built by copying out of a read,
and a line-number gutter is the most reliable way to make a model copy
something that is not in the file.

There is deliberately **no fuzzy fallback**. pi's editor, when its exact match
misses, re-matches in a normalized space (NFKC, smart quotes, dashes, per-line
`trimEnd`) and then writes the whole file back *from that normalized space* — so
one tolerated smart quote in the anchor silently rewrites every unrelated line.
That is the corruption class this tool exists to remove. A miss fails loudly and
the agent re-reads: one round trip, honest.

`hashline` (the line-anchored patch DSL of oh-my-pi — `can1357/oh-my-pi`, the hard
fork of pi, not upstream pi) was considered and rejected: it
costs ~6 KB of always-on system prompt teaching a 17-rule DSL plus a
line-numbered read format, a snapshot store and 3-way merge, and its published
gains concentrate on weak models. Exact match captures most of the benefit at no
prompt cost.

## agents — the delegation surface

There is **one** delegation tool. `think`, `team` and `peers` were three tools
for one decision; they are now three groups of actions on `agents`, gated by
the deps a backend wires (`agentsActionsFor`).

The spawn rungs are **one ladder keyed on lifetime**, because lifetime is the
only axis the model has to decide on to pick between them; the measured rung
sits beside them on its own axis, keyed on whether the answer can be measured
instead of judged. The system prompt's `## Delegation`
section (`packages/core/src/prompt.ts`) indexes the rungs and carries the
operational doctrine no schema does; each rung's *triggers* live in
`BUILTIN_TOOL_SPECS` (`registry.ts`, the single source) and reach the model
through the `agents` schema description, which providers weight for selection.

The section opens on a **default**, not on a choice: *"Delegate once the shape
of the work is settled: naming the parts is yours, running them is theirs."*
The three exemptions — a single coherent change in one file, a direct answer
that needs no change, a command the user asked you to run — come last, and are
stated as things to *do*.

That ordering is the point, and it replaced a first bullet reading *"Do it
yourself — a single short coherent change"* (2026-08-17). Naming the zeroth
rung first made the section a *classification*, and the correct classification
of "I am not sure" is to do it alone — so every ambiguous turn failed closed:
the doctrine converted **0%** of eligible turns where the mechanical splice in
`orchestrator/turn-steering.ts` converted 24%. An exemption list fails the
other way. The same file now also states the shape test at **step 0** of a
session's first ask (`turn_start_no_delegation`), because the 25-step steer
beside it can only ever be recovery from a shape already chosen serially.

The rungs themselves:

1. **No agent at all** — for bulk text that needs no tools, slice it and
   `llm.query` each slice inside `execute_tools`. Rendered only where the RLM
   provider is actually wired, and weight-ordered here because it is the
   cheapest helper there is.
2. **Ephemeral fork** (`fork`) — spawns 2–6 copies of you on the same
   workspace, sandbox and files; each runs its own multi-step tool loop
   concurrently; findings merge back into this turn and the forks disappear.
   `forks` is **required**: a fork runs the briefs it is given, and a call that
   supplies none is refused (`forkBriefsRefusal`) naming `action:'swarm'` as the
   place a search writes its own candidates.
3. **Configured search** (`swarm`) — the measured rung, on the same deps as
   `fork`. `preset` fixes the shape of the search and `depth` how deep it may
   go; every candidate is scored against the `objective` the caller declares,
   by a verifier registered in `strategy/verifier-registry.ts` that runs in this
   workspace. Tree search of every depth lives here.
4. **Persistent subordinate** (`hire`) — long-lived, starts from a blank context, keeps its own
   across turns, stays in the roster.

`fork` and `swarm` are not two settlements of one primitive. `fork` has ONE
settlement, a merge: it reconciles what the briefs reported. A swarm has no
settlement to choose — its candidates are measured, and the number decides.
That is why a swarm needs an `objective` and a fork does not, and why there is
no route from a swarm to a judged ensemble: ranking by a panel of model opinions
is not something the surface offers.

The MCTS engine itself is unchanged and still registered (`strategy/mcts.ts` in
the `StrategyRegistry`; UCT selection, backprop, pruning, convergence,
search-store resume, sibling diversity, execution-grounded rewards all intact).
What it no longer has is a model-facing route: it is reached programmatically,
by the durable search store and by the eval harness. See
[MCTS.md](./MCTS.md).

Talking to what already exists is not a rung either — `ask`, `send`, `reply`
and `list` address agents by name, and the name decides the transport:

- **A subordinate** is a `SubordinateAgent` — a Durable Object facet of the same
  workspace that runs the *full* turn loop on its own workstream. It shares the
  workspace's authoritative Nimbus session directly, so a subordinate and the
  orchestrator are looking at the same tree. `hire` takes a role plus a mission
  (the mission runs as its first turn); `ask` hands it further work; `send`
  injects a conversational note; `dismiss` retires it, keeping its context
  archived unless `keep_history: false` is passed.
- **A peer** is one of the owner's *other* workspaces, reached over the
  EventsHub peer transport. Its axis is neither lifetime nor measurement, which
  is why it sits outside the ladder. `ask` waits for the reply
  (default 120 s, max 600 — a late reply still arrives as an event), `send`
  does not wait, `reply` answers an agent message event by its `event_id`, and
  `hire` with `scope: workspace` creates or reuses a whole specialist
  workspace.
- **`report`** is a separate tool, registered only on subordinates (also
  reachable as `report.*` in `execute_tools` — same `ReportToolDeps.report`
  either way). It is how a
  subordinate's findings reach the orchestrator between turns; the answer of an
  assigned turn is relayed automatically at turn end, so `report` is for
  milestones, not per-step noise.

### The field contract

Every field belongs to an ACTION, and that relation is enforced rather than
documented. `AGENTS_ACTION_FIELDS` (`core/src/tools/agents-tool.ts`) names the
fields each action's handler reads; the input schemas are `v.strictObject` over
one shared set of entries; and `parseAgentsToolInput` runs on BOTH surfaces (the
native tool's `execute` and the `agents.*` codemode member), so an unrecognised
field — or a real field on an action whose handler cannot act on it — is an error
that names the field meant:

```
unknown field "budgetUsd" — did you mean "budget_usd"?
field "budget_usd" does not apply to action "hire" — it is read by fork, and hire
would ignore it. action "hire" takes: agent, role, mission, model, scope, message,
timeout_seconds.
```

This exists because the schema was one flat `v.object`, and valibot's `object`
**excludes** an unknown entry instead of rejecting it. Measured against the
shipped parser on 2026-08-18, `{ action:'fork', task:'x', budgetUsd:5,
wallClockMs:1000 }` parsed to `{ action:'fork', task:'x' }`: two spend caps
asked for, neither applied, no error and nothing in the run record saying the
request had vanished. `gate:agents-fields` holds the declaration to the code —
per action, the `input.<field>` reads its `case` arm performs (followed through
every whole-input hand-off, including into `readMissionLimits`, where
`budget_usd` is actually read) must be exactly the fields declared for it, and
every declared field must be in the parse. The JSON Schema the model sees is
derived from the same map at compile time.

One deliberate asymmetry: the resume filter (`resumableForkInput`) DROPS an
unknown field instead of refusing it. A durable job row was recorded verbatim
from the model's original call, no model is listening for a correction, and the
field was already dropped when the row was first dispatched — so refusing it
would turn a replayable fork into a hard failure. It is logged
(`agents.resume.fields_dropped`) rather than dropped silently.

The same filter also TRANSLATES. A stored row carrying a `settle` is a tree
search, and tree search is now `action:'swarm'`, so the row is re-driven as
`{action:'swarm', preset:'ideate', task}` — as is a legacy `kind:'think'` row
whose `strategy` is not `heads`. `ideate` and not a measured preset because it
writes its own competing approaches from `task` alone, exactly as the stored
settle did, and because the row carries no `objective`: a measured preset would
need a metric, a unit, a direction and a verifier the original call never
supplied. What the replay cannot carry is the RANKING — the judged ensemble that
ordered those approaches is not reachable from a swarm — so `ranking` is named
in `agents.resume.fields_dropped` beside the dropped fields. A resumed search
that quietly stopped ranking is worse than one that said so.

### The delivery contract

A busy agent is **never blocked on**, and both `ask` and `send` say so in their
return rather than leaving the sender to guess:

| Field | Meaning |
|-------|---------|
| `event_id` | The admitted event's id — the same id the eventual `subordinate_report` cites, which is what correlates an answer arriving turns later with the thing that was asked |
| `delivery` | `starts_now` (the target was idle; the drain starts a turn) or `queued` (the target was busy or the event was already admitted, so it waits for its own Plan/Build-homogeneous turn) |
| `subordinate_phase` | `{busy, lastActivityAt, workingOn}` — what the target was doing when the message landed |

`send` additionally reports `status: delivered | queued`, the same vocabulary
the peer transport uses: *delivered* means it reached the target's context,
*queued* means it waits behind work already admitted.

Delegated work never splices into a live turn: the reactor drain preserves its
trusted Plan/Build mode and queues a separate turn when the target is busy.
The mode is stamped by the host, not selected by the model. The shared drain
and signal-delivery seam starts the next serialized turn with that same mode.

## execute_tools — Codemode Sandbox

The primary tool. The LLM writes JavaScript code that runs in an isolated Worker via the `LOADER` binding (`@cloudflare/codemode`).

### workspace.* APIs (always available)

| API | Signature | What it does |
|-----|-----------|-------------|
| `workspace.readFile` | `(path: string) → string` | Read from the canonical workspace VFS |
| `workspace.writeFile` | `(path: string, content: string) → string \| {error}` | Write to the canonical workspace VFS (auto-creates parents; overwrites require a prior read) |
| `workspace.editFile` | `(path: string, edits: [{old_text, new_text}]) → {ok, applied} \| {error}` | Exact-match edit — the SAME dispatcher (`createFileDispatcher`) and gate the native `file` tool's `edit` action uses |
| `workspace.readdir` | `(path: string) → string[]` | List directory entries |
| `workspace.exists` | `(path: string) → boolean` | Check if a path exists |
| `workspace.exec` | `(command: string) → string` | Run POSIX shell command (cat, grep, find, sed, ls, etc.) |
| `workspace.searchMemory` | `(query: string) → results` | FTS5 search over long-term memory |
| `workspace.saveNote` | `(content: string) → "ok"` | Append note to MEMORY.md with FTS indexing |
| `workspace.listTools` | `() → Array<{name, description, qualityScore}>` | List crafted tools with their EMA scores |
| `workspace.createTool` | `(name, description, code) → {ok, name, action}` | Create/update a crafted tool in CraftStore; callable on the next `execute_tools` call in the same turn |

These come from `InlineExecutor` in `packages/core/src/execution/inline.ts`, registered as the `workspace` provider in the `ExecutionRouter`. `readFile`/`writeFile` observe into the SAME `TurnFileLedger` `editFile` gates against (a read/write on either surface is known to the other). Both backends bind that live turn ledger into the executor after their loop exists, so a read or write through native `file` is immediately known to `workspace.*`, and vice versa.

`/workspace/skills/*.md` is an ordinary path on this same VFS — `workspace.readFile`/`writeFile`/`readdir`/`exec('rm …')` are how skill CRUD happens now that there is no `skills` tool.

### memory.* / tasks.* / report.* / release.* APIs (codemode projections)

Every remaining native tool is also reachable from `execute_tools`, projecting
onto the SAME dispatcher the native tool calls — one implementation, two
callers, the same pattern `agents.*`/`web.*` established:

| Namespace | Members | Shared with |
|---|---|---|
| `memory.*` | `save`, `search`, `sessions`, and (when a FactsStore is wired) `remember`/`recall`/`forget` | `createMemoryDispatcher` (`tools/memory-tool.ts`) |
| `tasks.*` | `add`, `update`, `list` | `createTasksDispatcher` over the same `TaskListStore` instance (`tools/tasks-tool.ts`) |
| `report.*` | `send(status, content)` | the native `report` tool's `ReportToolDeps.report` |
| `release.*` | `board`/`bindSource`/`create`/`update`/`transition`/`requestApproval`, plus `apply`/`runChecks`/`preview`/`deploy`/`rollback` (engine backends) or `recordCheck`/`recordDeployment` (ledger-only backends) | `runReleaseAction` (`tools/release-tool.ts`) — release has no native tool at all; this is its only reach |

`memory.*`/`tasks.*` are unconditional (every ActorAgent); `report.*` is
subordinate-only.

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
orchestrator gets all eight, a subordinate or a local CLI session gets `fork`
and `swarm` — a swarm rides the same deps as a fork, so no deps set grants one
without the other — and a head, handed no delegation deps, has no `agents`
namespace at all. The workspace-clone `forkAgent` RPC is deliberately not
projected.

One limitation to know: a fork started inside the sandbox rides the enclosing
`execute_tools` call, and that job kind declines background resume (its side
effects cannot be safely re-run). Quick orchestration belongs in the sandbox; a
single long search that must survive an eviction belongs at the top-level tool,
whose durable job row is re-driven on resume (`resumableForkInput`).

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

### One docstring, both backends

`execute_tools`' description is composed once, by
`renderExecuteToolsDescription(typeBlock)` in the registry: the registry's own
spec for the tool, then the two standing facts about the sandbox, then the
TypeScript declaration of every namespace it binds. Both backends call it —
CF passes `@cloudflare/codemode`'s `{{types}}` placeholder and lets
`createCodeTool` substitute (it can generate a declaration from a tool's input
schema, which the CLI cannot); the CLI joins its providers' declared `types`.

This is worth stating because both halves were previously missing, in opposite
directions. CF passed **no** description to `createCodeTool`, so production
shipped the vendor's generic `"Execute code to achieve a goal."` and none of
`BUILTIN_TOOL_SPECS.execute_tools` — no when-to-use, no `workspace.*` doctrine,
no returns — with a worked example calling `codemode.searchWeb({...})`, a shape
`craftedDispatcherEntry` is written to throw on. The CLI passed the spec and
discarded every provider's `types`, so its model was handed `memory.*`,
`tasks.*`, `agents.*`, `web.*` and `llm.*` as live callables and told about
none of them.

Every capability provider therefore declares its own `types`. The last one that
did not was `web`, and codemode generated `search: (input: SearchInput) =>
Promise<SearchOutput>` from its absent input schema — an object-argument
signature beside a member description stating the positional shape, so a model
following the declared type searched for the literal `"[object Object]"`.

### The crafted-tool preamble reaches every code shape

Crafted tools are callable as `tools.<name>` because `PreambleCraftedExecutor`
splices a `const tools = { … }` preamble into the model's program before the
sandbox runs it — that is what makes a tool crafted in step 1 callable in step 2
of the same turn. The splice used to be a regex against the head of
`async (...) => {` on the model's **raw** code, and it dropped the preamble
silently when the code did not have that head. A bare statement body never does
— and a bare statement body is what this tool's own worked example teaches, and
what codemode itself wraps for you (`normalizeCode`, called later inside
`DynamicWorkerExecutor`). So on those calls every `tools.<name>` was
`undefined`, with nothing naming why.

`injectPreamble` now normalizes first and wraps rather than splices:
`async () => { const tools = {…}; return await (<normalized>)(); }`. The
namespaces are `const`s in the scope enclosing the evaluated arrow, so the
model's code still closes over `workspace`, `memory`, `agents` and the rest, and
now over `tools` as well. `normalizeCode` is idempotent, so codemode
re-normalizing the wrapper is a no-op. Statements, a trailing expression, a
concise arrow and a block arrow are all equally correct now —
`packages/cf-backend/tests/unit-crafted-injection.test.ts` runs the injected
program for each shape.

## file — action reference

```
file { action: "read",  path, offset?, limit? }   → the content, or a marker naming the next offset
file { action: "edit",  path, edits: [{ old_text, new_text }] }
                                                  → { ok, path, applied: [{ line, removed_lines, added_lines }] }
                                                  → or { error } naming exactly what was wrong
file { action: "write", path, content }           → { ok, path, bytes, action: "created" | "replaced" }
```

Failure reasons, as counted in the `file_edit` run event: `not_found`,
`ambiguous`, `empty_anchor`, `overlap`, `no_change`, `unread`, `stale`,
`missing`, `io`. A malformed edit is never read as the destructive option: a
missing `new_text` is refused, while an explicit `""` deletes.

The engine is pure string math in `packages/core/src/tools/file-edit.ts` (no
I/O), the per-turn state is `tools/file-ledger.ts`, and the tool itself is
`tools/file-tool.ts`. The `file-plane` layergate layer locks the two properties
that matter (an anchor lands exactly once or not at all, and no read is clipped
without saying how to continue it) with faults that model each being lost.

## run — Shell Command

Direct POSIX shell execution over the workspace **file plane** — Nimbus's own
shell over the same bytes the `file` tool and `workspace.*` address, so a path
means the same thing on every surface. Pipelines, redirects, chaining,
variables, loops, a persistent working directory, and ~95 coreutils.

On the hosted backend this is the Nimbus workspace shell and supports the
runtimes the live execution-status block declares, including native processes,
git, Node, package managers, and exposed ports when configured. The local
backend runs in the local workspace process environment.

**Runtime routing**: the `runtime` parameter takes `workspace` (the default),
`sandbox`, or `laptop` (the user's own PC, via the pc-agent daemon and a consent
prompt on first use). Sandbox and laptop are different machines with their own
filesystems; anything other than `workspace` dispatches through the
`ExecutionRouter`. There is no fallback chain: asking for a runtime
that isn't provisioned returns a structured `runtime_not_provisioned` error the
UI turns into an install card, rather than silently routing elsewhere and
letting the model believe it has more access than it does.

**Approval gate**: every command is pre-flighted through
`core/src/safety/approval-gate.ts` before it runs, on every runtime. A `deny`
verdict is refused outright; a `gate` verdict is refused with an actionable note
unless the workspace's shell approval mode is `allow_all`.

The live executor status is authoritative for which workspace programs and
runtimes are installed. Do not infer capability from older backend labels.

## agents fork — the ephemeral-fork rung

`agents` with `action: fork` dispatches through the strategy registry
(`core/src/strategy/`) to `FORK_STRATEGY_ID` (`heads`) — the only strategy the
action reaches, because a fork has one settlement. The briefs in `forks` —
**required** — each become an independent fork of the agent running its own
multi-step tool loop (`HEAD_BUILTIN_TOOLS`, narrowed by the brief's own
`allowedTools`) over a fork of the parent workspace, merged back into the turn.

The requirement is enforced at the seam (`forkBriefsRefusal` in
`core/src/tools/agents-tool.ts`) rather than documented: a call that supplies no
briefs is refused with `reason: 'bad_input'`, and the refusal names
`action:'swarm'` as the place a search writes its own competing approaches and
ranks them. Before that refusal existed, such a call announced its spawn,
detached, and reported the strategy's throw as a wake about spawned work
failing.

A tree search of any depth is `action:'swarm'` with a `depth`: it reads `task`
and writes its own candidates, each measured against the `objective` the caller
declared by a verifier from `strategy/verifier-registry.ts`. It is not a
settlement of `fork`, and there is no field on `fork` that selects it.

## experience — cross-workspace transfer

The owner's workspaces each earn their own crafted tools, lessons and facts, and
`experience` is the one path between them: `publish` offers what THIS workspace
proved, `search` retrieves what the owner's others proved, `import` stages one
entry here. This is **not** agent-facing: sharing proven work across
workspaces is a rare, deliberate, owner-shaped decision, not something an
agent should weigh on every turn, so it is the owner-facing
`experienceAction` RPC (`cf-backend/orchestrator.ts`) — no `experience` tool
and no `experience.*` codemode namespace — driven by the web UI, over the same
`runExperienceAction` dispatcher (`core/src/experience/actions.ts`). The
library itself is owner-level state in the UserDO
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

The tool roster is deliberately small, and the reason is the **decision
surface**, not token cost. Every native tool is a standing choice the model
weighs on every turn it is not the answer to, and selection accuracy degrades
with choice count; that is the whole argument, independent of what anything
costs to render. File work is one tool with three actions rather than three
tools, the rest of filesystem work folds into the `execute_tools` codemode
sandbox rather than living as a dozen flat per-operation tools, and delegation
folds into `agents` rather than one tool per delegation shape. Two former
top-level tools (`skills`, `release`) moved entirely to codemode reach for the
same reason: neither is frequent or important enough to occupy a standing
choice. The redundancy test applied to each candidate: *if this tool did not
exist, could the agent still accomplish the thing via `run` or
`execute_tools`?* — and for these two, yes, with the machinery either already
reachable (`skills`, over `workspace.*`) or moved intact behind a namespace
(`release.*`). `run`, `execute_tools`, `file`, `agents`, `memory`, `tasks`,
`web`, and `report` stayed native because the owner judged them frequent and
important enough to earn native availability even where a shell or a script
could technically substitute — several of them (`agents` most of all)
genuinely cannot be done any other way (spawning is not something a shell can
do), and `file`'s exact-match edit is enforcement no shell command performs.

The schema surface the model sees natively is the 8 names plus their
docstrings — 9,034 characters of description text (`BUILTIN_TOOL_DESCRIPTIONS`),
~2.26k tokens at the chars/4 estimate, down from 10,201 chars / ~2.55k tokens
across the 10 names this replaced. That is a **side effect** of shrinking the
surface, not the goal: the codemode namespaces that replaced `release`
(`release.*`, 13 members with per-member JSDoc) render into `execute_tools`'s
own description at ~2,000 chars / ~500 tokens — MORE than the 704-char flat
schema it replaced, because per-member TypeScript JSDoc is a more verbose
format than one action-enum plus prose. The `memory.*`/`tasks.*`/`report.*`
projections (all of which kept their native tool too — these are pure
additions, reachable a second way) cost roughly 1,118 / 565 / 382 chars
respectively. None of this is hidden from the measurement; it is the honest
price of "reachable from code" over "one schema," paid because the owner
values the smaller decision surface over the byte count.

That stays flat as the CraftStore grows, because crafted tools live inside the
sandbox namespace instead of the top-level schema.

`tasks` is the one place that argument was re-opened and answered the other way.
It could have been three more actions on `memory`, and it is not, because
`memory` answers "what will I want to look up later" — its own docstring rules
out temporary task progress — while a task list answers "what is still in front
of me": live plan state, re-read every step out of the dynamic-context block and
closed out as the work lands. Folding it in would have made `memory`'s summary
untrue and put four more properties on the schema the model reads for every
durable-state decision.

# Agent Tools: Built-in Tool Architecture

The agent exposes a small set of **built-in top-level tools** to the LLM. `BUILTIN_TOOLS` in `packages/core/src/tools/registry.ts` is the canonical list of 8 names. The list stays short to keep the model's *decision surface* small. Every native tool is a standing choice the model weighs on every turn it is not the answer to, and selection accuracy degrades with choice count. Files are read and changed through the `file` tool; the same operations are also available as `workspace.*` APIs inside the `execute_tools` codemode sandbox. Crafted tools from the CraftStore are injected into the same sandbox as `codemode.*` (the default namespace exposed by `@cloudflare/codemode`'s `createCodeTool`) and, via the preamble, as `tools.<name>`.

Both surfaces (Cloudflare Workers and CLI) consume the same factory
`buildBuiltinTools` from `@kinu.run/core/tools`. The registry and descriptions
live in `packages/core/src/tools/registry.ts`; neither the CF orchestrator nor
the CLI chat loop hand-builds tools anymore. Only `execute_tools`, `run`, `file`,
`memory` and `tasks` are unconditional; every other tool is registered only when
the backend wires its deps. No flag controls that gating, and it is how a
subordinate gets `report` and never gets the `reply` action of `agents`.

## Top-Level Tools

| Tool | Purpose |
|------|---------|
| `execute_tools` | Codemode sandbox. The LLM writes JS with `workspace.*`, `codemode.*`, `agents.*`, `memory.*`, `tasks.*`, `report.*`, `release.*`, and `tools.<name>` crafted-tool APIs |
| `run` | One shell command in one explicitly selected runtime |
| `file` | The one file plane, over the same workspace filesystem every other surface addresses. `read` a file, `edit` exact text inside it, `write` it whole |
| `agents` | The whole delegation surface: `swarm \| hire \| ask \| send \| reply \| list \| dismiss` |
| `memory` | The one durable-state tool: `save \| search` prose memory, `remember \| recall \| forget` typed keyed facts, `conversations` to search or browse this agent's own past conversation |
| `tasks` | The agent's own task list and active role: `add` titles (with a `parent` for subtasks), `update` one item's status, `list` it back, `mode` to set or read the role. One row per item in `agent_tasks`; the open half renders into the live context block every step, and into the Tasks tab |
| `web` | Live web access: `search` returns ranked results (title, url, snippet, date), `fetch` returns one URL as clean, citation-ready markdown. Key-less via DuckDuckGo + the Cloudflare markdown service; a stored `tavily` credential upgrades search |
| `report` | A subordinate's progress spine back to its orchestrator: `progress \| completed \| blocked` |

### The reach axis: declared, not derived

How the model reaches a capability is a **declared property** of that
capability, in `TOOL_REACH` (`packages/core/src/tools/registry.ts`):

```ts
report: { native: true,  codemode: 'report' }   // both surfaces
run:    { native: true,  codemode: 'workspace' } // native, plus a namespace it does not own
release:{ native: false, codemode: 'release' }   // codemode only
execute_tools: { native: true, codemode: null }  // native only; it IS the sandbox
```

`codemode` is a namespace *name* rather than a boolean because it is not always
the capability's own name. `run` and `file` are reached inside the sandbox
through the shared `workspace` primitives they already dispatch into, so they
own no namespace. A capability owns its namespace exactly when `codemode`
equals its own key.

Four things read the declaration, which is what stops the surfaces disagreeing:

| Reader | What it uses the declaration for |
| --- | --- |
| `BuiltinToolName` (a derived type) | `BUILTIN_TOOL_SPECS` / `BUILTIN_TOOL_DESCRIPTIONS` cannot compile without an entry for a newly-native capability, and `BUILTIN_TOOLS` cannot list one the declaration does not call native |
| every `*-codemode.ts` factory | takes its provider `name` straight from the table, so a namespace cannot exist for a capability the table gives none, and cannot be spelled differently. Deleting `report`'s namespace from the table makes `report-codemode.ts` fail to compile |
| `explainNativeToolReferenceError` | tells the model where the capability actually is when it reaches for a native tool name inside the sandbox. This was previously a hardcoded `name === 'run'` branch, with the other seven told they were "not reachable from inside execute_tools", which was false for all of them |
| `getToolDescriptions` (cf) | reports it to the Tools panel instead of guessing `nativeNames.has(name) ? 'native' : 'codemode'` |

**Reach and permission are two different things.** What a given actor gets is
reach ∩ the deps its backend wires (`actorActiveTools`, and each tool's dep gate
in `buildBuiltinTools`). Those are two facts, and the UI receives them as two
fields, `exposure` (declared) and `wired` (this actor). The old single guessed
word could not express "this agent has it on neither surface", so `report`, the
one dep-gated builtin, rendered as codemode-only on an orchestrator. An
orchestrator is the report *sink* and has it on no surface at all.

Adding a `native` row grows the standing 8-tool surface, and a test holds that
decision to the code. `packages/core/tests/unit-tool-reach.test.ts` pins the
native set *and* the count, and asserts that every declared namespace has a
factory producing exactly that name with at least one member.

Two capabilities that used to be top-level tools are gone from this list on
purpose. Their machinery is intact and reachable from `execute_tools`. Neither
earned a standing choice on every turn.

- **Skills** (`SKILL.md` workflow instructions) are ordinary files under
  `/workspace/skills/`, on the same workspace filesystem `file`/`workspace.*`
  already address. `read`/`create`/`edit`/`delete` are
  `workspace.readFile`/`writeFile`/`readdir`/`exec('rm …')` calls, so a
  dedicated tool would have been a third path to the same bytes.
  Discovery needs no tool call either. Every available skill's
  name + description renders as an ambient index in the system prompt
  (`renderSkillsIndexSection`), and activation (explicit `/name`,
  `always_active` config, or an `auto_activate` keyword match) is resolved
  once at turn start, before any tool call. A mid-turn "invoke" action never
  restricted anything, because the turn's system prompt and tool surface are
  already fixed by the time a tool call could run.
- **`release`** (the governed release/deploy pipeline) is a `release.*`
  codemode namespace (`tools/release-codemode.ts`). It is occasional and
  high-blast-radius enough that it should not cost a standing choice on every
  turn it is not the answer to. Same dispatcher (`runReleaseAction`,
  `tools/release-tool.ts`), same engine-presence gating, same ledger; only the
  caller changed.

Some self-changes live on the codemode `workspace.*` surface inside
`execute_tools`, because they are artifacts the agent writes for itself rather
than instruments it reaches for:

| Call | What it makes |
| --- | --- |
| `workspace.createTool(name, description, code)` | a reusable crafted tool, callable the same turn |
| `workspace.createView(name, spec)` | a dashboard tab in the web UI, drawn by the host from declarative JSON |
| `workspace.editFile(path, edits)` | an exact-match edit, with the SAME gate and, where the backend shares a turn ledger, the SAME read-before-write state as the native `file` tool's `edit` action |

## file: the file plane

There is **one** file tool, with three actions, for the same reason `memory` is
one tool. Reading a file, replacing text inside it and creating it are one
concept, and which action a call needs follows from what the agent is doing
rather than from a comparison it has to make. The action names mirror the
codemode calls (`workspace.readFile` / `writeFile`), so there is one vocabulary
across the tool surface and the sandbox.

Everything goes through `rt.storage.vfs`. On the hosted backend that is the
authoritative `NIMBUS_SESSION`. On the CLI it is the plane the runtime binds:
the stored working directory when one is set (`CLIRuntimeConfig.cwd`), otherwise
the agent's own in-SQLite tree. The
same bytes are addressed by `file`, `run { runtime: "workspace" }`, and
`workspace.*`. There is no second Nimbus filesystem. Optional containers and
devices keep their own files and are reached through `sandbox.*` and
`laptop.*`.

### Why it exists

Before it, the agent had no read/write/edit primitive at all, so file work went
through `run`. Over the preserved Terminal-Bench trajectories the split was
**789 `run` calls against 6 `execute_tools` calls**, and of the 374 `run` commands
in the 2.1 set, 65 were inline `python3 -c`, 55 were heredocs, 23 were shell
redirects and 14 were `sed -i`. Roughly two in five shell calls were the model
hand-rolling a file mutation through the three most failure-prone mechanisms
available. None of them can report that the text they aimed at was not there.
`sed -i` exits 0 either way.

**Those seven counts came from one local bench run and no reader can reproduce
them here.** The trajectories live in `bench-artifacts/`, which
`scripts/bench-retention.ts` treats as gitignored run output, so a fresh checkout
has none of it. No date is recorded for the run either. The counts are kept
because they are the reason this tool exists, and they are labelled because a
number nobody can re-derive is evidence about one machine.

### The properties that make it worth a tool

| Property | What it means |
|---|---|
| **Exact match** | `old_text` must occur in the file **exactly once**. Absent → fail. Repeated → fail, with the occurrence count and the instruction to widen it. Occurrences are counted at every position, overlapping ones included, so `aa` in `aaa` is ambiguous rather than a silent first-match. Nothing is written either way. |
| **Atomic batches** | Every edit in a call matches the file *as it was read*, never a sibling's result; offsets are applied back-to-front. One bad anchor applies none of them. Overlapping edits are refused by name. |
| **Read-before-write** | `edit`, and `write` over an existing file, are refused unless the file has been read, and refused again (`stale`) if it changed after that read. The refusal names the exact call to make next. Authorization is keyed on the **content digest**, so a different spelling of the same path is not a spurious refusal, and a write authorizes the edits that follow it. |
| **Seen depth** | How much was read matters. A capped or paged read authorizes an `edit`, where the anchor still has to be exactly and uniquely present, but not a `write` that discards lines the model never saw. Coverage is the contiguous prefix the turn has paged through, which is exactly the shape the read's own `offset=N` recipe produces, so paging to the end earns the overwrite and the gate is never a dead end. |
| **No silent truncation** | A capped or limited `read` always names the offset that continues it, and no read is ever a bare empty string. An empty file says so, an offset past the end says so, and a single line too large to show at all hands over the `workspace.readFile`-inside-`execute_tools` recipe. A trailing newline ends the last line rather than creating a phantom one, so the offsets it hands back always resolve. Reads are counted against the same per-turn bulk budget as every other tool result (`context-budget.ts`). |
| **Nothing invisible** | A BOM is stripped from what the read shows, so the first line can be copied back as `old_text` and match. Restored on write. |
| **Faithful round-trip** | Matching happens on LF text with the BOM stripped, so an anchor typed with `\n` matches a CRLF file. The splice lands on the **original** string at mapped indices, so a file with mixed endings keeps every ending it had outside the replaced span. Only the inserted text takes the file's ending. |
| **A gradable outcome** | Every attempt is counted by outcome into the turn's `TurnFileLedger`, and the settle spine writes one `file_edit` run event per turn: `attempts` and `applied` (calls), `failures` by reason, `recoveredPaths` and `abandonedPaths` (paths, because recovery is a property of a file rather than of a call). |

Reads are **not** line-numbered. `old_text` is built by copying out of a read,
and a line-number gutter is the most reliable way to make a model copy
something that is not in the file.

There is deliberately **no fuzzy fallback**. pi's editor, when its exact match
misses, re-matches in a normalized space (NFKC, smart quotes, dashes, per-line
`trimEnd`) and then writes the whole file back *from that normalized space*, so
one tolerated smart quote in the anchor silently rewrites every unrelated line.
That is the corruption class this tool exists to remove. A miss fails loudly and
the agent re-reads, which costs one round trip.

`hashline` (the line-anchored patch DSL of oh-my-pi, `can1357/oh-my-pi`, the hard
fork of pi, not upstream pi) was considered and rejected. It
costs ~6 KB of always-on system prompt teaching a 17-rule DSL plus a
line-numbered read format, a snapshot store and 3-way merge, and its published
gains concentrate on weak models. Exact match captures most of the benefit at no
prompt cost.

## agents: the delegation surface

There is **one** delegation tool. `think`, `team` and `peers` were three tools
for one decision; they are now three groups of actions on `agents`, gated by
the deps a backend wires (`agentsActionsFor`).

Two rungs spawn, on two different axes. `hire` is keyed on lifetime. The helper
outlives this turn and stays in the roster. `swarm` is keyed on measurement. A
verifier the caller registered scores every candidate, and the run settles back
this turn. The system prompt's `## Delegation` section
(`packages/core/src/prompt.ts`) indexes the rungs and carries the operational
doctrine no schema does; each rung's *triggers* live in `BUILTIN_TOOL_SPECS`
(`registry.ts`, the single source) and reach the model through the `agents`
schema description, which providers weight for selection.

The section opens on a **default**: *"Delegate once the shape of the work is
settled: naming the parts is yours, running them is theirs."* The three
exemptions come last, and are stated as things to *do*: a single coherent change
in one file, a direct answer that needs no change, a command the user asked you
to run.

That ordering is the point, and it replaced a first bullet reading *"Do it
yourself — a single short coherent change"* (2026-08-17). Naming the zeroth
rung first made the section a *classification*, and the correct classification
of "I am not sure" is to do it alone, so every ambiguous turn failed closed.
The doctrine converted **0%** of eligible turns where the mechanical splice in
`orchestrator/turn-steering.ts` converted 24%. An exemption list fails the
other way. The same file now also states the shape test at **step 0** of the
conversation's first ask (`turn_start_no_delegation`), because the 25-step steer
beside it can only ever be recovery from a shape already chosen serially.

The rungs themselves:

1. **No agent at all.** For bulk text that needs no tools, slice it and
   `llm.query` each slice inside `execute_tools`. Rendered only where the RLM
   provider is wired, and weight-ordered here because it is the cheapest helper
   there is.
2. **Configured search** (`swarm`) is the measured rung. `preset` fixes the
   shape of the search, `objective` says what is measured, and `depth` says
   how deep the search may go. A verifier registered in
   `strategy/verifier-registry.ts` scores every candidate of a verify-scored
   search, and it runs in this workspace.
   Each swarm node is a full agent with its own multi-step tool loop.
   Tree search of every depth lives here; [EXPLORATION.md](./EXPLORATION.md) is
   the document for the search itself.
3. **Persistent subordinate** (`hire`) is long-lived. It starts from a blank
   context, keeps its own across turns, and stays in the roster.

A swarm has no settle field to choose. The answer's shape is DERIVED from
`score` and `advance`, never supplied. `score:"verify"` measures every
candidate through a registered verifier; `score:"judge"` ranks by a model
ensemble sized with the tagged `samples` parameter, under the marginalisation
floor (`JUDGE_MARGINALISATION_MIN`); `score:"none"` returns unranked
candidates. A measured search needs an `objective`; an ideation does not.

**The `fork` action is gone.** It took 2-6 briefs the caller wrote, ran one copy
of the agent per brief, and merged what they reported. `AGENTS_TOOL_ACTIONS`
lists seven actions now and `fork` is not one of them, so the call is refused by
the action picklist. No field carries a brief and nothing on the surface selects
the old behaviour. A search that writes its own candidates and measures them
covers the same work with a number behind the ranking.

The MCTS engine is unchanged and still registered (`strategy/mcts.ts` in the
`StrategyRegistry`; UCT selection, backprop, pruning, convergence, search-store
resume, sibling diversity, execution-grounded rewards all intact). It has no
model-facing route. It is reached programmatically, by the durable search store
and by the eval harness. See [MCTS.md](./MCTS.md).

Talking to an agent that already exists is not a rung. `ask`, `send`, `reply`
and `list` address agents by name, and the name decides the transport:

- **A subordinate** is a `SubordinateAgent`, a Durable Object facet of the same
  workspace that runs the *full* turn loop on its own workstream. It shares the
  workspace's authoritative Nimbus session directly, so a subordinate and the
  orchestrator are looking at the same tree. `hire` takes a role plus a mission
  (the mission runs as its first turn); `ask` hands it further work; `send`
  injects a conversational note; `dismiss` retires it, keeping its context
  archived unless `keep_history: false` is passed.
- **A peer** is one of the owner's *other* workspaces, reached over the
  EventsHub peer transport. Its axis is neither lifetime nor measurement, which
  is why it sits outside the ladder. `ask` delivers the message and waits for
  the reply with no elapsed limit; a reply that outlives this activation
  arrives as a peer event instead, and the turn's abort signal ends the wait.
  `send` does not wait, `reply` answers an agent message event by its `event_id`,
  and `hire` with `scope: workspace` creates or reuses a whole specialist
  workspace.
- **`report`** is a separate tool, registered only on subordinates (also
  reachable as `report.*` in `execute_tools`, with the same
  `ReportToolDeps.report` either way). It is how a subordinate's findings reach
  the orchestrator between turns; the answer of an assigned turn is relayed
  automatically at turn end, so `report` carries milestones rather than
  per-step noise.

### The field contract

Every field belongs to an ACTION, and that relation is enforced rather than
documented. `AGENTS_ACTION_FIELDS` (`core/src/tools/agents-tool.ts`) names the
fields each action's handler reads; the input schemas are `v.strictObject` over
one shared set of entries; and `parseAgentsToolInput` runs on BOTH surfaces (the
native tool's `execute` and the `agents.*` codemode member), so an unrecognised
field, or a real field on an action whose handler cannot act on it, is an error
that names the field meant:

```
unknown field "budgetUsd" — did you mean "budget_usd"?
field "budget_usd" does not apply to action "hire" — it is read by swarm, and
hire would ignore it. action "hire" takes: agent, role, mission, tier, scope,
message.
```

The declared relation, action by action:

| Action | Fields its handler reads |
|---|---|
| `swarm` | `task`, `preset`, `objective`, `key`, `config`, `from`, `label`, `name`, `branches`, `depth`, `role`, `tier`, `budget_usd`, `budget_tokens`, `budget_label` |
| `hire` | `agent`, `role`, `mission`, `tier`, `scope`, `message` |
| `ask` | `agent`, `message`, `topic`, `deliverable`, `deadline_hint` |
| `send` | `agent`, `message`, `topic` |
| `reply` | `event_id`, `message` |
| `list` | `agent` |
| `dismiss` | `agent`, `keep_history` |

A verifier is not a field of its own. `verify` is `{kind, spec}` nested inside
`objective`, so a metric and the instrument that measures it arrive together.

**A swarm takes no iteration cap and no wall-clock cap, and the absence is the
design.** Nothing in the runner cuts a search off on either one. A surface that
takes a cap it never applies is the defect this repository is written against, so
neither field is declared, and a caller who sends one is told which actions read
it. `depth`, `branches`, `budget_usd` and `budget_tokens` are the caps that are
enforced. The two absent ones join the list when something enforces them.

`models` was removed on 2026-08-19 for that same reason. It promised per-node
model routing and no runner read it, so a caller who named a cheap model for the
deep levels got the workspace model and no error. Routing reaches a search
through `role` and `tier` now. The resolver turns them into one immutable
profile before the first node runs.

The contract exists because the schema was one flat `v.object`, and valibot's
`object` **excludes** an unknown entry instead of rejecting it. Measured against
the shipped parser on 2026-08-18, `{ action:'fork', task:'x', budgetUsd:5,
wallClockMs:1000 }` parsed to `{ action:'fork', task:'x' }`. Two spend caps were
asked for, neither applied, no error and nothing in the run record saying the
request had vanished. That exact call is refused twice over now, because `fork`
has left the picklist too. The mistake the surface provokes is unchanged,
since every cap on it is snake_case and camelCase is what a model reaches for.
`gate:agents-fields` holds the declaration to the code. Per action, the
`input.<field>` reads its `case` arm performs (followed through every
whole-input hand-off, including into `readMissionLimits`, where `budget_usd` is
actually read) must be exactly the fields declared for it, and every declared
field must be in the parse. The JSON Schema the model sees is derived from the
same map at compile time.

The resume filter (`resumableAgentsInput`) is deliberately asymmetric. It DROPS
an unknown field instead of refusing it. A durable job row was recorded verbatim
from the model's original call, no model is listening for a correction, and the
field was already dropped when the row was first dispatched, so refusing it
would turn a replayable search into a hard failure. It is logged
(`agents.resume.fields_dropped`) rather than dropped silently.

The same filter also TRANSLATES. A stored row carrying a `settle` is a tree
search, and tree search is now `action:'swarm'`, so the row is re-driven as
`{action:'swarm', preset:'ideate', task}`, and so is a legacy `kind:'think'` row
whose `strategy` is not `heads`. The preset is `ideate` because it writes its
own competing approaches from `task` alone, exactly as the stored
settle did, and because the row carries no `objective`. A measured preset would
need a metric, a unit, a direction and a verifier the original call never
supplied. The replay cannot carry the RANKING, because the judged ensemble that
ordered those approaches is not reachable from a swarm, so the loss is named
`settlement` in `agents.resume.fields_dropped` beside the dropped fields.
A resumed search that quietly stopped ranking is worse than one that records
the loss.

### The delivery contract

A busy agent never blocks its sender, and both `ask` and `send` report the
delivery in their return rather than leaving the sender to guess:

| Field | Meaning |
|-------|---------|
| `event_id` | The admitted event's id. The eventual `subordinate_report` cites the same id, which correlates an answer arriving turns later with the thing that was asked |
| `delivery` | `starts_now` (the target was idle; the drain starts a turn) or `queued` (the target was busy or the event was already admitted, so it waits for its own Plan/Build-homogeneous turn) |
| `subordinate_phase` | `{busy, lastActivityAt, workingOn}`: what the target was doing when the message landed |

`send` additionally reports `status: delivered | queued`, the same vocabulary
the peer transport uses: *delivered* means it reached the target's context,
*queued* means it waits behind work already admitted.

Delegated work never splices into a live turn. The reactor drain preserves its
trusted Plan/Build mode and queues a separate turn when the target is busy.
The host stamps the mode. The shared drain and signal-delivery path starts the
next serialized turn with that same mode.

## execute_tools: Codemode Sandbox

The primary tool. The LLM writes JavaScript code that runs in an isolated Worker via the `LOADER` binding (`@cloudflare/codemode`).

### workspace.* APIs (always available)

| API | Signature | What it does |
|-----|-----------|-------------|
| `workspace.readFile` | `(path: string) → string` | Read from the canonical workspace VFS |
| `workspace.writeFile` | `(path: string, content: string) → string \| {error}` | Write to the canonical workspace VFS (auto-creates parents; overwrites require a prior read) |
| `workspace.editFile` | `(path: string, edits: [{old_text, new_text}]) → {ok, applied} \| {error}` | Exact-match edit, with the SAME dispatcher (`createFileDispatcher`) and gate the native `file` tool's `edit` action uses |
| `workspace.readdir` | `(path: string) → string[]` | List directory entries |
| `workspace.exists` | `(path: string) → boolean` | Check if a path exists |
| `workspace.exec` | `(command: string) → string` | Run POSIX shell command (cat, grep, find, sed, ls, etc.) |
| `workspace.searchMemory` | `(query: string) → results` | FTS5 search over long-term memory |
| `workspace.saveNote` | `(content: string) → "ok"` | Append note to MEMORY.md with FTS indexing |
| `workspace.listTools` | `() → Array<{name, description, qualityScore}>` | List crafted tools with their EMA scores |
| `workspace.createTool` | `(name, description, code) → {ok, name, action}` | Create/update a crafted tool in CraftStore; callable on the next `execute_tools` call in the same turn |

These come from `InlineExecutor` in `packages/core/src/execution/inline.ts`, registered as the `workspace` provider in the `ExecutionRouter`. `readFile`/`writeFile` observe into the SAME `TurnFileLedger` `editFile` gates against (a read/write on either surface is known to the other). Both backends bind that live turn ledger into the executor after their loop exists, so a read or write through native `file` is immediately known to `workspace.*`, and vice versa.

`/workspace/skills/*.md` is an ordinary path on this same VFS. `workspace.readFile`/`writeFile`/`readdir`/`exec('rm …')` are how skill CRUD happens now that there is no `skills` tool.

### memory.* / tasks.* / report.* / release.* APIs (codemode projections)

Every remaining native tool is also reachable from `execute_tools`, projecting
onto the SAME dispatcher the native tool calls. That is one implementation with
two callers, the same pattern `agents.*`/`web.*` established:

| Namespace | Members | Shared with |
|---|---|---|
| `memory.*` | `save`, `search`, `conversations`, and (when a FactsStore is wired) `remember`/`recall`/`forget` | `createMemoryDispatcher` (`tools/memory-tool.ts`) |
| `tasks.*` | `add`, `update`, `list`, `mode` | `createTasksDispatcher` over the same `TaskListStore` instance (`tools/tasks-tool.ts`) |
| `report.*` | `send(status, content)` | the native `report` tool's `ReportToolDeps.report` |
| `release.*` | `board`/`bindSource`/`create`/`update`/`transition`/`requestApproval`, plus `apply`/`runChecks`/`preview`/`deploy`/`rollback` (engine backends) or `recordCheck`/`recordDeployment` (ledger-only backends) | `runReleaseAction` (`tools/release-tool.ts`); release has no native tool at all, so this is its only reach |

`memory.*`/`tasks.*` are unconditional (every ActorAgent); `report.*` is
subordinate-only.

### codemode.* APIs (dynamically learned)

Crafted tools from the CraftStore are injected into the codemode sandbox as `codemode.*`, the default namespace exposed by `@cloudflare/codemode`'s unnamed provider (`createCodeTool`). The preamble also splices a `const tools = {…}` binding into the sandbox arrow, so the same tool answers to `tools.<name>` and crafted-tool bodies can call `workspace.*`, `codemode.*`, and each other in one lexical scope. See [CRAFT-ARCHITECTURE.md](./CRAFT-ARCHITECTURE.md).

```javascript
// Inside execute_tools:
const result = await codemode.my_custom_parser({ input: "data" });
```

**How injection works** (`buildCraftedToolSetFromExecute` in
`@kinu.run/core/tools/builtins.ts`):
1. `craftStore.list()` reads all crafted tools from SQLite.
2. Each row is filtered by effective score (`DEFAULT_CONFIG.craftStore.minEffectiveScoreForInjection`, default 0.2) so decayed or low-quality tools never reach the LLM.
3. Each passing tool dispatches through `deps.craftedToolExecute`, which is the LOADER Worker on CF and a Node adapter on the CLI. There is no host-side codegen. Nothing is compiled inside `builtins.ts`, because a `new Function()` would break in a V8 isolate.
4. The resulting `craftedToolSet` is passed as the `tools` parameter to `createExecuteTool`; codemode wraps it as an unnamed provider → `codemode.*`.
5. Inside the sandbox, the LLM calls `codemode.name(args)` or `tools.name(args)`.

### agents.* APIs (delegation, dep-gated)

The `agents` delegation tool is also projected into the sandbox, so a script can
delegate with ordinary control flow. A crafted tool can be the whole workflow.
The script fans out, inspects results, branches, aggregates, then saves the
routine with `workspace.createTool`, and schedules or triggers it like any
other craft. There is no workflow DSL, graph engine or step store, because
`CraftStore`, `agent.schedule` and the trigger hub already cover those.

```javascript
// Inside execute_tools: a workflow is code.
const settled = await Promise.all(areas.map((area) => agents.swarm({
  task: `review ${area}`,
  preset: "ideate",
})));
return settled
  .filter((run) => !("reason" in run))
  .flatMap((run) => run.candidates.map((c) => c.artifact));
```

`createAgentsCodemodeProvider` (`packages/core/src/tools/agents-codemode.ts`)
builds the namespace, and every member lands in the same `dispatchAgentsAction`
the top-level `agents` tool calls, over the same deps. That is one delegation
path with one more caller. Which members exist is `agentsActionsFor(deps)`, the
identical gate behind the tool's action enum: `team` opens `hire`, `ask`,
`send`, `list` and `dismiss`, `peers` adds `reply`, and a workspace
orchestrator, which wires both beside the search substrate, gets all seven.
A head, handed no delegation deps, has no `agents` namespace at all.
The workspace-clone `forkAgent` RPC is deliberately not projected.

One limitation applies. A search started inside the sandbox rides the enclosing
`execute_tools` call, and that job kind declines background resume (its side
effects cannot be safely re-run). Quick orchestration belongs in the sandbox; a
single long search that must survive an eviction belongs at the top-level tool,
whose durable job row is re-driven on resume (`resumableAgentsInput`).

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
Node adapter (`createNodeExecuteToolFactory` in `@kinu.run/cli-backend`). If
neither is wired, `execute_tools` still registers but returns a sharp
"not configured" error rather than quietly compiling code with `new Function()`,
which would break in a V8 isolate anyway.

### One docstring, both backends

`execute_tools`' description is composed once, by
`renderExecuteToolsDescription(typeBlock)` in the registry: the registry's own
spec for the tool, then the two standing facts about the sandbox, then the
TypeScript declaration of every namespace it binds. Both backends call it.
CF passes `@cloudflare/codemode`'s `{{types}}` placeholder and lets
`createCodeTool` substitute (it can generate a declaration from a tool's input
schema, which the CLI cannot); the CLI joins its providers' declared `types`.

Both halves were previously missing, in opposite directions. CF passed **no**
description to `createCodeTool`, so production shipped the vendor's generic
`"Execute code to achieve a goal."` and none of
`BUILTIN_TOOL_SPECS.execute_tools` (no when-to-use, no `workspace.*` doctrine,
no returns), with a worked example calling `codemode.searchWeb({...})`, a shape
`craftedDispatcherEntry` is written to throw on. The CLI passed the spec and
discarded every provider's `types`, so its model was handed `memory.*`,
`tasks.*`, `agents.*`, `web.*` and `llm.*` as live callables and told about
none of them.

Every capability provider therefore declares its own `types`. The last one that
did not was `web`, and codemode generated `search: (input: SearchInput) =>
Promise<SearchOutput>` from its absent input schema, an object-argument
signature beside a member description stating the positional shape, so a model
following the declared type searched for the literal `"[object Object]"`.

### The crafted-tool preamble reaches every code shape

Crafted tools are callable as `tools.<name>` because `PreambleCraftedExecutor`
splices a `const tools = { … }` preamble into the model's program before the
sandbox runs it. That is what makes a tool crafted in step 1 callable in step 2
of the same turn. The splice used to be a regex against the head of
`async (...) => {` on the model's **raw** code, and it dropped the preamble
silently when the code did not have that head. A bare statement body never does,
and that is what this tool's own worked example teaches, and what codemode
itself wraps for you (`normalizeCode`, called later inside
`DynamicWorkerExecutor`). So on those calls every `tools.<name>` was
`undefined`, with nothing naming why.

`injectPreamble` now normalizes first and wraps rather than splices:
`async () => { const tools = {…}; return await (<normalized>)(); }`. The
namespaces are `const`s in the scope enclosing the evaluated arrow, so the
model's code still closes over `workspace`, `memory`, `agents` and the rest, and
now over `tools` as well. `normalizeCode` is idempotent, so codemode
re-normalizing the wrapper is a no-op. Statements, a trailing expression, a
concise arrow and a block arrow are all equally correct now.
`packages/cf-backend/tests/unit-crafted-injection.test.ts` runs the injected
program for each shape.

## file: action reference

```
file { action: "read",  path, offset?, limit? }   → the content, or a marker naming the next offset
file { action: "edit",  path, edits: [{ old_text, new_text }] }
                                                  → { ok, path, applied: [{ line, removed_lines, added_lines }] }
                                                  → or { error } naming exactly what was wrong
file { action: "write", path, content }           → { ok, path, bytes, action: "created" | "replaced" }
```

Failure reasons, as counted in the `file_edit` run event: `not_found`,
`ambiguous`, `empty_anchor`, `overlap`, `no_change`, `unread`, `stale`,
`missing`, `io`. A malformed edit is never read as the destructive option. A
missing `new_text` is refused, while an explicit `""` deletes.

The engine is pure string math in `packages/core/src/tools/file-edit.ts` (no
I/O), the per-turn state is `tools/file-ledger.ts`, and the tool itself is
`tools/file-tool.ts`. The `file-plane` layergate layer locks the two properties
that matter (an anchor lands exactly once or not at all, and no read is clipped
without saying how to continue it) with faults that model each being lost.

## run: Shell Command

Direct POSIX shell execution over the workspace **file plane**. This is Nimbus's
own shell over the same bytes the `file` tool and `workspace.*` address, so a
path means the same thing on every surface. Pipelines, redirects, chaining,
variables, loops, a persistent working directory, and ~95 coreutils.

On the hosted backend this is the Nimbus workspace shell and supports the
runtimes the live execution-status block declares, including native processes,
git, Node, package managers, and exposed ports when configured. The local
backend runs in the local workspace process environment.

**Runtime routing**: the `runtime` parameter takes `workspace` (the default),
`sandbox`, or `laptop` (the user's own PC, via the pc-agent daemon and a consent
prompt on first use). Sandbox and laptop are different machines with their own
filesystems; anything other than `workspace` dispatches through the
`ExecutionRouter`. There is no fallback chain. Asking for a runtime
that isn't provisioned returns a structured `runtime_not_provisioned` error the
UI turns into an install card, rather than silently routing elsewhere and
letting the model believe it has more access than it does.

**Approval gate**: every command is pre-flighted through
`core/src/safety/approval-gate.ts` before it runs, on every runtime. A `deny`
verdict is refused outright; a `gate` verdict is refused with an actionable note
unless the workspace's shell approval mode is `allow_all`.

The live executor status is authoritative for which workspace programs and
runtimes are installed. Do not infer capability from older backend labels.

## agents swarm: the configured-search rung

`agents` with `action: swarm` resolves the call, checks it, then runs it.
`runSwarmAction` (`core/src/tools/agents-tool.ts`) dispatches into `runSwarm`
(`core/src/strategy/swarm-run.ts`). The order is load-bearing. Resolution turns
`preset` into a full axis tuple, validity is checked over that tuple, and only
the last step spends anything.

The swarm path calls `resolveSwarm`, `swarmValidity`, and `runSwarm` directly.
`AgentsForkDeps` carries only the execution substrate: runtime, model resolver,
pricing, node isolation, and shared-prefix compaction. It carries no strategy
registry or dormant strategy objects.

Three refusal classes, kept apart by vocabulary:

| `reason` | What it says |
|---|---|
| `bad_input` | the call does not describe a legal search |
| `unsupported` | a legal search this tree has no engine for |
| `unavailable` | a legal search whose instrument this actor does not have |

Only one of the three is worth correcting, which is why they are not one bucket.

A run that started returns a report: the axes in force, the caps, the frozen
resolved profile the run started under (`profile`, the snapshot a durable
re-drive reads back), the settle report, the publication marker, the best
candidate and every candidate. A run
that did not start returns a refusal. Those are two shapes on purpose. A caller
branching on `reason` asks a different question from one reading a report.

[EXPLORATION.md](./EXPLORATION.md) is the normative document for the search
itself: the six axes, the seven presets, what a node is, and the rules a call
must satisfy.

## experience: cross-workspace transfer

The owner's workspaces each earn their own crafted tools, lessons, facts and
agent loop, and `experience` is the one path between them: `publish` offers what
THIS workspace proved, `search` retrieves what the owner's others proved,
`import` stages one entry here. `experience` is owner-facing. Sharing proven
work across workspaces is a rare, deliberate, owner-shaped decision that an
agent should not weigh on every turn, so it runs as the `experienceAction` RPC
(`cf-backend/orchestrator.ts`), with no `experience` tool and no
`experience.*` codemode namespace. The web UI drives it, over the same
`runExperienceAction` dispatcher (`core/src/experience/actions.ts`). The
library itself is owner-level state in the UserDO
(`core/src/experience/library.ts`), reached through the capability gate. The
two `experience.*` capabilities are `full`-tier, so a shared workspace keeps
everything inside itself and reaches neither.

Nothing crosses on assertion. Publishing is gated on local evidence, which
travels with the entry: a crafted tool needs real uses and a time-decayed score
at or above the same bar its own injection filter uses, a lesson must be
CORROBORATED (a provisional one is already kept out of this workspace's
MEMORY.md), a fact must clear its confidence bar, and a scaffold must be the
LIVE version, promoted on a shadow record that still clears `decidePromotion`,
with `DEFAULT_SHADOW_CONFIG.minTrials` graded turns served since promotion and
no misevolution veto recorded in that window
(`core/src/experience/publishable.ts`). The probation reuses the promotion
gate's own number, so a loop crosses only after the user has lived through as
many turns of it as the offline judge demanded trials.

Importing reuses the two mechanisms the agent already trusts
(`core/src/experience/imports.ts`):

1. **The misevolution gate** runs on every import of every kind, code or not.
   An imported lesson lands in MEMORY.md and an imported fact lands in the
   per-turn facts block, which is the paper's memory pathway. A veto is recorded
   in `evolution_events` like any other.
2. **Provisional until corroborated.** What survives the gate is STAGED in
   `imported_experience` rather than adopted. The tool hands the payload back
   inline so the agent can use it in the turn it imported it, and that turn's own
   outcome decides. Accepted promotes it into the CraftStore / MEMORY.md /
   `agent_facts`; corrected or frustrated discards it; an ungraded turn leaves it
   waiting. `EvolutionEngine.reviewTurn` is the only place this happens.

An imported scaffold is the one kind whose adoption is not the end of its
journey. Promoting it hands the code to `modifyScaffold`, the same 4-gate
pipeline a locally-proposed mutation takes, so it lands as a PENDING version and
the live `scaffold/agent.js` is untouched. This workspace's own shadow trials
and promotion gate then decide whether it ever runs. There is no other route: an
imported loop is a proposal here, whatever it proved elsewhere.

## CraftStore Lifecycle

Crafted tools are discovered, scored, and retired automatically:

1. **Extract**: `EvolutionEngine.extractPattern()` asks the LLM to generalize successful tool-call patterns (`evolution/engine.ts`)
2. **Score**: `updateCraftScores()` updates EMA scores (α=0.3) after each turn that uses crafted tools (`craft/ema.ts`)
3. **Filter**: `filterByEffectiveScore()` drops anything below `minEffectiveScoreForInjection` (0.2), so decayed tools never reach the LLM
4. **Inject**: The surviving set is passed to `createExecuteTool` as the `tools` parameter
5. **Consolidate**: `periodicCraftConsolidation()` (`craft/consolidation.ts`) retires tools with `effectiveScore < 0.1` after at least 2 uses, and never retires the last one

## Why so few tools

The tool roster is deliberately small because of the **decision surface**. Every
native tool is a standing choice the model weighs on every turn it is not the
answer to, and selection accuracy degrades with choice count; that is the whole
argument, independent of what anything costs to render. File work is one tool
with three actions rather than three tools, the rest of filesystem work folds
into the `execute_tools` codemode sandbox rather than living as a dozen flat
per-operation tools, and delegation folds into `agents` rather than one tool per
delegation shape. Two former top-level tools (`skills`, `release`) moved
entirely to codemode reach for the same reason. Neither is frequent or important
enough to occupy a standing choice. The redundancy test applied to each
candidate: *if this tool did not exist, could the agent still accomplish the
thing via `run` or `execute_tools`?* For these two the answer is yes, with the
machinery either already reachable (`skills`, over `workspace.*`) or moved
intact behind a namespace (`release.*`). `run`, `execute_tools`, `file`,
`agents`, `memory`, `tasks`, `web`, and `report` stayed native because the owner
judged them frequent and important enough to earn native availability even where
a shell or a script could technically substitute. Several of them (`agents` most
of all) cannot be done any other way (spawning is not something a shell can do),
and `file`'s exact-match edit is enforcement no shell command performs.

The schema surface the model sees natively is the 8 names plus their docstrings.
That is **11,823 characters of description text (`BUILTIN_TOOL_DESCRIPTIONS`),
about 2,956 tokens at the chars/4 estimate, measured 2026-08-19.** `agents` is
4,805 of those characters on its own, `tasks` 1,704 and `file` 1,331.

**That is larger than the surface it replaced, and the earlier claim that it
shrank is withdrawn.** On 2026-08-12 the eight names measured 9,034 chars and the
ten names before them measured 10,201, so the count fell and this document said
so. A week of docstring work put it above both. The argument is the decision
surface, which is eight standing choices instead of ten, whatever the
docstrings cost.

The codemode namespaces are measured the same way, on 2026-08-19, off each
provider's own declared `types`:

| namespace | members | chars | tokens at chars/4 |
|---|---:|---:|---:|
| `release.*` (engine backend) | 11 | 2,000 | 500 |
| `release.*` (ledger-only backend) | 8 | 1,728 | 432 |
| `memory.*` (with a FactsStore) | 6 | 1,118 | 280 |
| `memory.*` (notes only) | 3 | 628 | 157 |
| `tasks.*` | 4 | 988 | 247 |
| `report.*` | 1 | 382 | 96 |

`release.*` costs MORE than the 704-char flat schema the native `release` tool
carried, because per-member TypeScript JSDoc is a more verbose format than one
action-enum plus prose. That 704 is history, because the tool is gone and
nothing can re-measure it. The `memory.*`, `tasks.*` and `report.*` projections each kept
their native tool too, so their characters sit on top of the native total rather
than instead of it.

None of this is hidden from the measurement. It is the honest price of "reachable
from code" over "one schema", paid because the owner values the smaller decision
surface over the byte count.

That stays flat as the CraftStore grows, because crafted tools live inside the
sandbox namespace instead of the top-level schema.

`tasks` is the one place that argument was re-opened and answered the other way.
It could have been four more actions on `memory`, and it is not, because
`memory` answers "what will I want to look up later", and its own docstring rules
out temporary task progress. A task list answers "what is still in front
of me", which is live plan state, re-read every step out of the dynamic-context
block and closed out as the work lands. Folding it in would have made `memory`'s
summary untrue and put five more properties (`titles`, `parent`, `id`, `status`,
`role`) on the schema the model reads for every durable-state decision.

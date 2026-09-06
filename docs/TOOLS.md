# Agent tools

`BUILTIN_TOOLS` in `packages/core/src/tools/registry.ts` defines eight native
tools. Each is a standing choice, so a longer list reduces selection accuracy.
`buildBuiltinTools` builds one set for both backends. Only `execute_tools`,
`run`, `file`, `memory`, and `tasks` are unconditional. The rest need wired
deps. Subordinates get `report`, never `agents.reply`. Files use `file` or
`workspace.*`. Crafted tools use `tools.<name>(args)`.

## Top-level tools

| Tool | Purpose |
|------|---------|
| `execute_tools` | The codemode sandbox. The model writes JavaScript against `workspace.*`, `agents.*`, `memory.*`, `tasks.*`, `report.*`, `release.*`, `web.*`, `agent.*`, `llm.*`, and `tools.<name>` for crafted tools |
| `run` | One shell command in one explicitly selected runtime |
| `file` | The one file plane, over the same workspace filesystem every other surface addresses. `read` a file, `edit` exact text inside it, `write` it whole |
| `agents` | The whole delegation surface: `swarm \| hire \| ask \| send \| reply \| list \| dismiss` |
| `memory` | The one durable-state tool: `save \| search` prose memory, `remember \| recall \| forget` typed keyed facts, `conversations` to search or browse this agent's own past conversation |
| `tasks` | The agent's own task list and active role: `add` titles (with a `parent` for subtasks), `update` one item's status, `list` it back, `mode` to set or read the role. One row per item in `agent_tasks`; the open half renders into the live context block every step, and into the Tasks tab |
| `web` | Live web access: `search` returns ranked results (title, url, snippet, date), `fetch` returns one URL as clean, citation-ready markdown. Key-less via DuckDuckGo + the Cloudflare markdown service; a stored `tavily` credential upgrades search |
| `report` | A subordinate's progress spine back to its orchestrator: `progress \| completed \| blocked` |

### Reach

`TOOL_REACH` declares where each capability exists:

```ts
report: { native: true,  codemode: 'report' }   // both surfaces
run:    { native: true,  codemode: 'workspace' } // native, plus a namespace it does not own
release:{ native: false, codemode: 'release' }   // codemode only
execute_tools: { native: true, codemode: null }  // native only; it IS the sandbox
```

`codemode` is a namespace name, not a boolean. `run` and `file` use shared
`workspace` primitives, so they own no namespace. A capability owns one when
`codemode` equals its key. Four readers keep this declaration authoritative:

| Reader | What it uses the declaration for |
| --- | --- |
| `BuiltinToolName` (a derived type) | `BUILTIN_TOOL_SPECS` / `BUILTIN_TOOL_DESCRIPTIONS` cannot compile without an entry for a newly-native capability, and `BUILTIN_TOOLS` cannot list one the declaration does not call native |
| every `*-codemode.ts` factory | takes its provider `name` straight from the table, so a namespace cannot exist for a capability the table gives none, and cannot be spelled differently. Deleting `report`'s namespace from the table makes `report-codemode.ts` fail to compile |
| `explainNativeToolReferenceError` | tells the model where the capability actually is when it reaches for a native tool name inside the sandbox. This was previously a hardcoded `name === 'run'` branch, with the other seven reported as unreachable from inside execute_tools. That report was false for all of them |
| `getToolDescriptions` (cf) | reports it to the Tools panel instead of guessing `nativeNames.has(name) ? 'native' : 'codemode'` |

Reach says what a surface exposes. Deps say what an actor gets. The UI receives
`exposure` and `wired`. An orchestrator is the `report` sink with neither
surface, while the old guess showed codemode-only.
`packages/core/tests/unit-tool-reach.test.ts` pins names, count, and namespace
factories.

`skills` and `release` stay off the standing list. Skills are ordinary
`/workspace/skills/` files, with CRUD through `workspace.*`. Discovery comes
from `renderSkillsIndexSection`, and activation resolves at turn start.
`release.*` keeps its `runReleaseAction` dispatcher, engine-presence gate, and
ledger.

| Call | What it makes |
| --- | --- |
| `workspace.createTool(name, description, code)` | a reusable crafted tool, callable the same turn |
| `workspace.slate(operation)` | list or preview authored slates, call a POST route, commit source, inspect history, fork a version, or restore source |
| `workspace.editFile(path, edits)` | an exact-match edit, with the same gate and, where the backend shares a turn ledger, the same read-before-write state as the native `file` tool `edit` action |

## file: the file plane

`FILE_TOOL_ACTIONS` names `read`, `write`, and `edit`. `file`, workspace
`run`, and `workspace.*` address `rt.storage.vfs`: on hosted, the actor DO own
Nimbus workspace; on CLI, the working directory when set, otherwise its in-SQLite tree. Containers
and devices keep separate files under `sandbox.*` and `laptop.*`.

### Why it exists

Before `file`, all file changes used `run`. One local Terminal-Bench run found
789 `run` calls and 6 `execute_tools` calls. Of 374 `run` commands in the 2.1
set, 65 were inline `python3 -c`, 55 heredocs, 23 shell redirects, and 14
`sed -i`. Roughly two in five hand-rolled a mutation. None can report an absent
target, and `sed -i` exits 0 either way.

This is unreproducible local evidence. `bench-artifacts/` is gitignored under
`scripts/bench-retention.ts`, absent from a fresh checkout, and the run has no
recorded date.

### Properties

| Property | What it means |
|---|---|
| **Exact match** | `old_text` must occur in the file exactly once. Absent → fail. Repeated → fail, with the occurrence count and the instruction to widen it. Occurrences are counted at every position, overlapping ones included, so `aa` in `aaa` is ambiguous rather than a silent first-match. Nothing is written either way. |
| **Atomic batches** | Every edit in a call matches the file *as it was read*, never a sibling's result; offsets are applied back-to-front. One bad anchor applies none of them. Overlapping edits are refused by name. |
| **Read-before-write** | `edit`, and `write` over an existing file, are refused unless the file has been read, and refused again (`stale`) if it changed after that read. The refusal names the exact call to make next. Authorization is keyed on the content digest, so a different spelling of the same path is not a spurious refusal, and a write authorizes the edits that follow it. |
| **Seen depth** | How much was read matters. A capped or paged read authorizes an `edit`, where the anchor still has to be exactly and uniquely present, but not a `write` that discards lines the model never saw. Coverage is the contiguous prefix the turn has paged through, which is exactly the shape the read's own `offset=N` recipe produces, so paging to the end earns the overwrite and the gate is never a dead end. |
| **No silent truncation** | A capped or limited `read` always names the offset that continues it, and no read is ever a bare empty string. An empty file says so, an offset past the end says so, and a single line too large to show at all hands over the `workspace.readFile`-inside-`execute_tools` recipe. A trailing newline ends the last line rather than creating a phantom one, so the offsets it hands back always resolve. Reads are counted against the same per-turn bulk budget as every other tool result (`context-budget.ts`). |
| **Nothing invisible** | A BOM is stripped from what the read shows, so the first line can be copied back as `old_text` and match. Restored on write. |
| **Faithful round-trip** | Matching happens on LF text with the BOM stripped, so an anchor typed with `\n` matches a CRLF file. The splice lands on the original string at mapped indices, so a file with mixed endings keeps every ending it had outside the replaced span. Only the inserted text takes the file's ending. |
| **A gradable outcome** | Every attempt is counted by outcome into the turn's `TurnFileLedger`, and the settle spine writes one `file_edit` run event per turn: `attempts` and `applied` (calls), `failures` by reason, `recoveredPaths` and `abandonedPaths` (paths, because recovery is a property of a file rather than of a call). |

Reads omit line numbers so models copy file text. The pi fuzzy editor normalizes
NFKC, smart quotes, dashes, and `trimEnd`, then rewrites the whole file. One
smart quote can rewrite unrelated lines, so this tool refuses a miss.

I rejected `hashline`, the oh-my-pi DSL (`can1357/oh-my-pi`, the hard fork of pi,
not upstream). Its ~6 KB always-on prompt teaches a 17-rule DSL, line-numbered
reads, a snapshot store, and 3-way merge. Its gains concentrate on weak models.

## agents: delegation

`agents` combines `think`, `team`, and `peers`. `hire` is persistent.
`swarm` measures candidates and settles this turn. `BUILTIN_TOOL_SPECS` holds
rung triggers. The prompt `## Delegation` section holds the doctrine.

Its default reads: "Delegate once the shape of the work is settled: naming the
parts is yours, running them is theirs." Exemptions are a one-file change, a
direct answer, or a command the user asked you to run.

Until 2026-08-17, leading with serial work made uncertainty classify as serial.
The doctrine converted 0% of eligible turns where a mechanical nudge in
`orchestrator/turn-steering.ts` converted 24%. That nudge is gone. The system
no longer steers a turn toward delegating, and the doctrine above is the whole
of the ask. `turn-steering.ts` keeps the three loop-detection steers only:
`repeated_call`, `repeated_failure`, `no_progress`.

1. One bounded question uses `agents({action:'ask', role, message})`. That call creates a full
   agent for the question and releases it when it answers. Oversize material goes by
   `context_ref`, so the bytes reach that agent and never the caller.
2. `swarm` fixes search through `preset`, `objective`, and `depth`. Registered
   verifiers score verify-scored candidates. Nodes are full agents. See
   [EXPLORATION.md](./EXPLORATION.md).
3. `hire` starts a persistent subordinate with a blank context.

A swarm derives its answer shape from `score` and `advance`, never `settle`.
`score:"verify"` uses a registered verifier. `score:"judge"` uses `samples`
under `JUDGE_MARGINALISATION_MIN`. `score:"none"` returns unranked candidates.
Only measured search needs `objective`.

`fork` is gone. Its 2-6 caller-written briefs became measured search candidates.
The seven-action picklist rejects it. MCTS stays registered in
`strategy/mcts.ts` but has no model-facing route. The durable search store and
eval suites call it. See [MCTS.md](./MCTS.md).

`ask`, `send`, `reply`, and `list` use a target name:

- `SubordinateAgent` is a same-workspace Durable Object facet with a full turn
  loop and shared Nimbus session. `hire` takes role and mission. `ask` adds
  work. `send` adds a note. `dismiss` archives unless `keep_history: false`.
- A peer is another owner workspace over EventsHub. `ask` waits until abort or
  a peer event. `send` does not wait. `reply` uses `event_id`. Workspace-scope
  `hire` creates or reuses a specialist workspace.
- `report` is subordinate-only, native and `report.*`, using
  `ReportToolDeps.report`. Turn answers relay automatically, so it carries
  milestones.

### Fields and replay

`AGENTS_ACTION_FIELDS`, `v.strictObject`, and `parseAgentsToolInput` enforce
the native and codemode field contract. An unknown field fails and names the
field meant (the `agents-tool.ts` refusal strings carry the exact quote). A
field another action reads fails and names the action that reads it.

| Action | Fields its handler reads |
|---|---|
| `swarm` | `task`, `preset`, `objective`, `key`, `config`, `from`, `label`, `name`, `branches`, `depth`, `nodes`, `models`, `role`, `tier`, `budget_usd`, `budget_tokens`, `budget_label` |
| `ask` | `agent`, `message`, `topic`, `deliverable`, `deadline_hint` |
| `send` | `agent`, `message`, `topic` |
| `reply` | `event_id`, `message` |
| `list` | `agent` |
| `dismiss` | `agent`, `keep_history` |

`verify` is `{kind, spec}` inside `objective`. The runner enforces `depth`,
`branches`, `budget_usd`, and `budget_tokens`, with no iteration or wall-clock
cap. `models` routes each node to its own model spec round-robin by slot, through
the same resolver a `tier` names. The field stayed on 2026-08-19 because no runner
read it and returned wired: an unresolvable spec is refused naming it before any
node runs. `role` and `tier` resolve one immutable profile, and `models` and
`tier` are mutually exclusive.

On 2026-08-18, flat `v.object` changed `{ action:'fork', task:'x',
budgetUsd:5, wallClockMs:1000 }` to `{ action:'fork', task:'x' }`, losing both
spend caps. `gate:agents-fields` checks handler reads, including
`readMissionLimits`, against the map that generates JSON Schema.

`resumableAgentsInput` drops unknown replay fields because the durable row has
already dispatched and no model can correct it. It logs
`agents.resume.fields_dropped` rather than failing replay.

Stored `settle`, or `kind:'think'` with a non-`heads` strategy, becomes
`{action:'swarm', preset:'ideate', task}`. Such rows lack the metric, unit,
direction, and verifier for measured search. Judge ranking is unavailable to
swarm, so lost ranking logs as `settlement`.

### Delivery

`ask` and `send` never block a busy target. They return:

| Field | Meaning |
|-------|---------|
| `event_id` | The admitted event's id. The eventual `subordinate_report` cites the same id, which correlates an answer arriving turns later with the thing that was asked |
| `delivery` | `starts_now` (the target was idle; the drain starts a turn) or `queued` (the target was busy or the event was already admitted, so it waits for its own Plan/Build-homogeneous turn) |
| `subordinate_phase` | `{busy, lastActivityAt, workingOn}`: what the target was doing when the message landed |

`send` also returns `status: delivered | queued`. The host stamps Plan/Build
mode. The shared drain queues the next serialized turn with it.

## execute_tools: codemode

`execute_tools` runs JavaScript in an isolated sandbox. Cloudflare starts a
child Worker through `LOADER` (`@cloudflare/codemode`). The CLI evaluates
in-process through `createNodeExecuteToolFactory`. Both bind these namespaces.

### workspace.*

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
| `workspace.createTool` | `(name, description, code) → {ok, name, action}` | Create or update a crafted tool in CraftStore. Callable as `tools.<name>(args)` on the NEXT `execute_tools` call in the same turn, because the sandbox that created it is already built |

`createInlineExecutor` registers `workspace` in `ExecutionRouter`. Native
`file` and `workspace.*` share its `TurnFileLedger` read-before-write state.
`SKILLS_DIR` declares `/workspace/skills/*.md` on that VFS.

### Slates

A slate is an authored project under `/home/user/slates/<id>/`. Its `package.json` names a TypeScript Worker module in `main` and declares capabilities in the strict `slate.bindings` field. The default export handles `fetch(request, env)`; introduced capabilities are `env.NAME.member(...args)`. Write files through the ordinary file plane, then use `workspace.slate({op:'preview',id})` to boot a live preview. `call` POSTs a JSON argument array to a named route. `commit` freezes source, `history` reads versions, `fork` copies a version into a new slate, and `restore` restores a version's tree. Running previews are isolate-lifetime processes, not durable records. These operations stay in the existing workspace codemode namespace; the native surface remains eight tools.

### Projected native tools

| Namespace | Members | Shared with |
|---|---|---|
| `memory.*` | `save`, `search`, `conversations`, and (when a FactsStore is wired) `remember`/`recall`/`forget` | `createMemoryDispatcher` (`tools/memory-tool.ts`) |
| `tasks.*` | `add`, `update`, `list`, `mode` | `createTasksDispatcher` over the same `TaskListStore` instance (`tools/tasks-tool.ts`) |
| `report.*` | `send(status, content)` | the native `report` tool's `ReportToolDeps.report` |
| `release.*` | `board`/`bindSource`/`create`/`update`/`transition`/`requestApproval`, plus `apply`/`runChecks`/`preview`/`deploy`/`rollback` (engine backends) or `recordCheck`/`recordDeployment` (ledger-only backends) | `runReleaseAction` (`tools/release-tool.ts`); release has no native tool at all, so this is its only reach |

These project onto their native dispatchers. `memory.*` and `tasks.*` are
unconditional. `report.*` is subordinate-only.

### Crafted tools

`sandbox-contract.ts` sets one cross-backend rule: `CRAFTED_TOOL_NAMESPACE` is
`tools`. That is the one namespace every tool is callable in: native
builtins and crafted tools alike, on every backend. There is no second spelling
and no alias. A name that is not in `tools` is not a tool.

| Backend | How `tools.<name>` becomes callable |
|---|---|
| Cloudflare | one `CodemodeProvider` named `tools` (`packages/cf-backend/src/execute-tools.ts`): native tools are host-dispatched functions, crafted tools are defined by its `prelude`, and `renderToolsDeclaration(native, crafted)` is the declaration the model reads |
| CLI | the `tools` parameter of the evaluated function (`packages/cli-backend/src/execute-tools-factory.ts`), beside `workspace` and `console`: native tools through the same `nativeToolFunctions` Cloudflare uses, crafted tools from the per-call set, and the same `renderToolsDeclaration(native, crafted)` block. `buildActorTools` builds the sandbox last, over the finished surface, so the block lists every tool the actor holds |

Both re-read the crafted set per call, so a tool saved a program ago is callable
now. A native tool referenced as a bare identifier is explained rather than
left as a `ReferenceError`. `explainNativeToolReferenceError` names
`tools.<name>(input)` as the form. See
[CRAFT-ARCHITECTURE.md](./CRAFT-ARCHITECTURE.md).

`buildCraftedToolSetFromExecute` reads `craftStore.list()` and filters below 0.2.
It then dispatches through `deps.craftedToolExecute`: LOADER on Cloudflare, Node
on the CLI. `buildBuiltinTools` re-reads it every call.
`selectInjectableCraftedTools` uses the same filter for the preamble.

### agents.*

A script can delegate, then save the routine with `workspace.createTool`.
`CraftStore`, `agent.schedule`, and the trigger hub replace a workflow DSL,
graph engine, and step store.

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

`createAgentsCodemodeProvider` routes through `dispatchAgentsAction`.
`agentsActionsFor(deps)` governs it and the native enum: `team` supplies
`hire`, `ask`, `send`, `list`, `dismiss`; `peers` adds `reply`; a workspace
orchestrator has seven; a head has none. `forkAgent` is never projected.
A sandboxed search cannot resume safely. Use the native tool for durable work.

### No fallback, shared description, and preamble

CF requires `LOADER`. The CLI requires `createNodeExecuteToolFactory`. Without
either, `execute_tools` returns "not configured" instead of `new Function()`.
`new Function()` fails in a V8 isolate.

`renderExecuteToolsDescription(typeBlock)` gives both backends the registry
spec, sandbox facts, and declarations. CF substitutes `{{types}}`. The CLI
joins declared `types`. CF once shipped only `"Execute code to achieve a goal."`
with incompatible `codemode.searchWeb({...})`. The CLI omitted live
`memory.*`, `tasks.*`, `agents.*`, `web.*`, and `llm.*`. `web` once declared
object-argument `search` beside positional prose, producing `"[object Object]"`.

Crafted tools are defined by the `tools` provider prelude
(`renderToolsPrelude`, `cf-backend/src/codemode-sandbox.ts`), one guarded
definition per tool, before the model program runs. A program is written as a
Node-style script: statements at the top level, `await` anywhere, `return` for
the result. `tests/workerd/codemode-sandbox.test.ts` runs the whole thing under
workerd: `require('fs/promises')` over the workspace, `state.*`, a crafted tool
calling another, a broken crafted row poisoning only its own name, and `fetch`
through the egress entrypoint.

## file: action reference

```
file { action: "read",  path, offset?, limit? }   → the content, or a marker naming the next offset
file { action: "edit",  path, edits: [{ old_text, new_text }] }
                                                  → { ok, path, applied: [{ line, removed_lines, added_lines }] }
                                                  → or { error } naming exactly what was wrong
file { action: "write", path, content }           → { ok, path, bytes, action: "created" | "replaced" }
```

`file_edit` records `not_found`, `ambiguous`, `empty_anchor`, `overlap`,
`no_change`, `unread`, `stale`, `missing`, and `io`. Missing `new_text` is
refused. `""` deletes. `file-edit.ts` is pure string math. `file-ledger.ts`
holds turn state. The `file-plane` layergate faults exact edits and clipped
reads.

## run: shell command

`run` is the Nimbus POSIX shell over the `file` and `workspace.*` plane. It has
pipelines, redirects, variables, loops, and the executor advertised "~95
coreutils" (`packages/core/src/execution/inline.ts`), not a document count.
Live executor status defines hosted capability. Local execution uses the
workspace process.

`runtime` defaults to `workspace`. `sandbox` and `laptop` have separate files.
`ExecutionRouter` has no fallback: absent runtimes return
`runtime_not_provisioned`. Relative paths use `WORKSPACE_ROOT`, `/home/user`.
Containers receive `/workspace`.

`run` and `execute_tools` are backgroundable. `detachAfterMs` is 30,000
interactive or 300,000 one-shot. Detached work has no deadline. Teardown waits
`settleGraceMs`, 300,000 interactive or 120,000 one-shot. Approval pre-flights
every runtime: `deny` refuses; `gate` requires `allow_all`.

## agents swarm: configured search

`runSwarmAction` resolves `preset`, validates its axis tuple, then calls
`runSwarm`. Only that step spends. `AgentsForkDeps` holds runtime, model
resolver, pricing, isolation, and shared-prefix compaction.

| `reason` | What it says |
|---|---|
| `bad_input` | the call does not describe a legal search |
| `unsupported` | a legal search this tree has no engine for |
| `unavailable` | a legal search whose instrument this actor does not have |

A started run returns axes, caps, frozen `profile`, settle report, publication
marker, and candidates. A refusal returns `reason`. [EXPLORATION.md](./EXPLORATION.md)
defines axes, presets, `custom`, nodes, and legal calls.

## experience: cross-workspace transfer

`experience` is owner-facing, not a tool or namespace. The owner drives it
through the core `runExperienceAction` over the capability-gated, `full`-tier
UserDO library. Shared workspaces get neither `experience.*`
capability. The workspace-side `experienceAction` RPC that used to front it
had no caller on any transport and was deleted. The engine and the library
stay, driven directly.

`publish` needs real uses plus injection score for crafted tools, corroborated
lessons, confident facts, or a live scaffold with passing `decidePromotion`,
`DEFAULT_SHADOW_CONFIG.minTrials` graded turns, and no misevolution veto.

`import` runs the misevolution gate, records vetoes, and stages survivors in
`imported_experience`. `EvolutionEngine.reviewTurn` alone promotes accepted
entries, discards corrected or frustrated ones, or leaves ungraded ones waiting.
Imported scaffolds enter `modifyScaffold` as pending. Only
`applyPromotionDecision` writes `scaffoldPath`.

## CraftStore lifecycle

`EvolutionEngine.extractPattern()` extracts patterns. `updateCraftScores()` uses
EMA α=0.3. Injection requires 0.2. Consolidation retires below 0.1 after at
least 2 uses, never the last tool. Survivors become `tools.<name>(args)`.

## Why eight tools

Eight standing choices matter more than a short description. `skills` and
`release` stay reachable through `workspace.*` and `release.*`. Filesystem work
uses `file` or `execute_tools`. Delegation uses `agents`. No shell substitutes
for `agents` or `file` exact-match enforcement.

The native schema is 11,823 description characters, about 2,956 tokens at
chars/4, measured 2026-08-19. `agents` uses 4,805 characters, `tasks` 1,704,
and `file` 1,331. This is larger than the earlier surface. On 2026-08-12, the
eight names measured 9,034 chars against 10,201 for the prior ten. Docstring
work then put the eight above both. The count fell. The description did not.

Declared codemode `types`, measured 2026-08-19:

| namespace | members | chars | tokens at chars/4 |
|---|---:|---:|---:|
| `release.*` (engine backend) | 11 | 2,000 | 500 |
| `release.*` (ledger-only backend) | 8 | 1,728 | 432 |
| `memory.*` (with a FactsStore) | 6 | 1,118 | 280 |
| `memory.*` (notes only) | 3 | 628 | 157 |
| `tasks.*` | 4 | 988 | 247 |
| `report.*` | 1 | 382 | 96 |

`release.*` exceeds the retired native `release` tool 704-character flat
schema because member JSDoc costs more than an action enum. That 704 is history
and cannot be re-measured. `memory.*`, `tasks.*`, and `report.*` add to native
text. Crafted tools keep the top-level total flat.

`tasks` stays separate: memory supports later retrieval, tasks hold active plan
state. Folding them together would add `titles`, `parent`, `id`, `status`, and
`role` to every durable-state decision.

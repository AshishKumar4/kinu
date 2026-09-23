# Agent tools

`BUILTIN_TOOLS` in `packages/core/src/tools/registry.ts` lists eight native
tools. Each is a standing choice the model weighs every turn, so a longer list
lowers selection accuracy. `buildBuiltinTools` builds one set for both backends.
`eval`, `shell`, `file`, `memory`, and `tasks` are always present; `agents`,
`web`, and `report` need wired deps. Subordinates get `report` and no `peers`,
so answering an inbound agent message event (`msg` with `event_id`) is not on
their surface. Crafted tools are called as `tools.<name>(args)` inside `eval`.

## Top-level tools

| Tool | Purpose |
|------|---------|
| `eval` | The codemode sandbox. The model writes JavaScript against `workspace.*`, `agents.*`, `memory.*`, `tasks.*`, `report.*`, `release.*`, `web.*`, `agent.*`, `db.*`, `state.*`, and `tools.<name>` |
| `shell` | One shell command in one selected runtime |
| `file` | The file plane, over the same workspace filesystem every other surface addresses: `read`, `write`, `edit`, `list`, `stat`, `search` |
| `agents` | Delegation: `swarm \| hire \| msg \| list \| dismiss` |
| `memory` | Durable state: `save \| search` prose notes, `remember \| recall \| forget` keyed facts, `conversations` to search or browse this agent's past conversation |
| `tasks` | The agent's task list and active role: `add` titles (with a `parent` for subtasks), `update` one item's status or note, `list` it back, `mode` to set or read the role. One row per item in `agent_tasks`; open items render into the live context block every step and into the Tasks tab |
| `web` | `search` returns ranked results (title, url, snippet, date); `fetch` returns one URL as markdown. Works without a key through DuckDuckGo and the Cloudflare markdown service; a stored `tavily` credential upgrades search |
| `report` | A subordinate's progress back to its orchestrator: `progress \| completed \| blocked` |

`submit_plan` is not one of the eight. `buildBuiltinTools` adds it only on a
Plan turn whose actor owns plan submission.

### Reach

`TOOL_REACH` declares where each capability exists and how a replayed call
behaves. Some rows:

```ts
eval:    { native: true,  codemode: null,        replay: 'claimed' } // native only; it is the sandbox
shell:   { native: true,  codemode: 'workspace', replay: 'claimed' } // native, plus a namespace it does not own
web:     { native: true,  codemode: 'web',       replay: 'safe' }    // both surfaces
report:  { native: true,  codemode: 'report',    replay: 'claimed' } // both surfaces
release: { native: false, codemode: 'release',   replay: 'claimed' } // codemode only
```

The codemode-only rows are `release`, `agent`, `db`, and `slate` (which reaches
`workspace`). `codemode` is a namespace name, not a boolean. `shell`, `file`,
and `slate` use the shared `workspace` namespace, so they own none. A
capability owns a namespace when `codemode` equals its key. `replay` is `safe`
when rerunning a call cannot do anything twice; `claimed` calls go through the
effect claim (`tools/effect-claim.ts`). A name the table does not declare, such
as an MCP tool, is `claimed`.

Four readers keep the declaration authoritative:

| Reader | What it uses the declaration for |
| --- | --- |
| `BuiltinToolName` (a derived type) | `BUILTIN_TOOL_SPECS` / `BUILTIN_TOOL_DESCRIPTIONS` cannot compile without an entry for a newly native capability, and `BUILTIN_TOOLS` cannot list one the declaration does not call native |
| every `*-codemode.ts` factory | takes its provider `name` from the table, so a namespace cannot exist for a capability the table gives none, and cannot be spelled differently. Deleting `report`'s namespace from the table makes `report-codemode.ts` fail to compile |
| `explainNativeToolReferenceError` | tells the model where a capability is when it uses a native tool name inside the sandbox. It reads the table instead of hardcoding names |
| `getToolDescriptions` (cf) | reports `exposure` and `wired` to the Tools panel instead of guessing `nativeNames.has(name) ? 'native' : 'codemode'` |

Reach says what a surface exposes. Deps say what an actor gets. An orchestrator
is the `report` sink and has `report` on neither surface; the `nativeNames`
guess would have shown it as codemode-only.
`packages/core/tests/unit-tool-reach.test.ts` pins the eight names and checks
that every declared namespace has a real factory.

`skills` and `release` are not on the standing list. Every skill loads from the
read-only `/skills` view as `/skills/<name>/SKILL.md` (`skills/view.ts`): a
built-in from its source, any other name from the workspace's
`/home/user/skills/` or the owner's `/shared/skills/`, by the one precedence in
`skills/discover.ts`. The prompt lists them through `renderSkillsIndexSection`;
only a user's `/name` or an operator pin loads a body at turn start.
`release.*` keeps its `runReleaseAction` dispatcher, engine-presence gate, and
ledger.

| Call | What it makes |
| --- | --- |
| `workspace.createTool(name, description, code)` | a reusable crafted tool, callable from the next `eval` call in the same turn |
| `workspace.slate(operation)` | list or preview authored slates, call a slate method, commit source, read history, fork a version, or restore source |
| `workspace.editFile(path, edits)` | an exact-match edit, with the same gate and, where the backend shares a turn ledger, the same read-before-write state as the native `file` tool's `edit` action |

## Plan authority

Core enforces Plan. It does not infer it from command text or trust a model's
promise. `execution/work-mode.ts` owns the Plan permission check: operations
that are safe in Plan are wrapped with `permitInPlan` and carry `planAllowed`,
and dispatchers with mixed actions check each parsed action. An unclassified
operation is unavailable in Plan. Build keeps every capability.

In Plan, native `file` read/list/stat/search and declared provider reads stay
usable. Write and edit, process/package/port operations, releases, and authored
slate execution need Build. Slate `list` and `history` are inspection;
`commit`, `fork`, `restore`, `preview`, and `call` are not. A Build preview that
already runs keeps the authority it was started with. Research memory, task and
state records, evidence and reports, and `submit_plan` stay available.
Temporary research children inherit Plan. Persistent hire/dismiss, and search
configurations that measure, publish, or apply project changes, need Build.

Hosted `eval` still runs isolated analysis through WorkerLoader, with only
permitted host callbacks and no raw egress. An MCP read also needs the
producer's read-only declaration and the existing role/owner gates. That
declaration is a promise from the remote server, not proof of what it does.
The CLI cannot confine its in-process Function/native-require and subprocess
executors, so those paths refuse Plan before they evaluate anything. Structured
inspection and research tools stay available; Kinu uses no command-string
allowlist, because no allowlist makes native code read-only. Plan runs the
standard guarded inference loop and does not evaluate a promoted authored
scaffold or its initializer.

Mode belongs to one invocation. A nested call cannot upgrade Plan. New
authorized turns and durable jobs enter with their own admitted or recorded
mode. A queued Build turn is not trapped in an earlier Plan callback, and
delayed Plan work does not borrow a later Build turn's authority. A Plan mode
that a role imposes is captured before terminal effects and stops automatic
improvement lanes that would change the project. Plan adds no second approval
queue and no new persisted format.

## file: the file plane

`FILE_TOOL_ACTIONS` is `read`, `write`, `edit`, `list`, `stat`, and `search`.
`file`, workspace `shell`, and `workspace.*` all address `rt.storage.vfs`. On
hosted, the actor DO owns its Nimbus workspace. On CLI, it is the working
directory when one is set, otherwise the in-SQLite tree. Containers and devices
keep separate files, mounted at `/sandbox` and `/pc`.

### Why it exists

Before `file`, every file change went through `shell`. One local Terminal-Bench
run recorded 789 `shell` calls and 6 `eval` calls. Of 374 `shell` commands in
the 2.1 set, 65 were inline `python3 -c`, 55 heredocs, 23 shell redirects, and
14 `sed -i`. About two in five hand-rolled a file change. None of these can
report an absent target, and `sed -i` exits 0 either way.

This evidence cannot be reproduced. `bench-artifacts/` is gitignored and
retained under `scripts/bench-retention.ts`, so it is absent from a fresh
checkout, and the run has no recorded date.

### Properties

| Property | What it means |
|---|---|
| Exact match | `old_text` must occur in the file exactly once. Absent: fail. Repeated: fail, with the occurrence count and an instruction to widen the anchor. Occurrences are counted at every position, overlapping ones included, so `aa` in `aaa` is ambiguous, not a silent first match. Nothing is written on failure. |
| Atomic batches | Every edit in a call matches the file as it was read, never a sibling edit's result; offsets are applied back to front. One bad anchor applies none of them. Overlapping edits are refused by name. |
| Read before write | `edit`, and `write` over an existing file, are refused unless the file has been read, and refused again (`stale`) if it changed after that read. The refusal names the exact call to make next. Authorization is keyed on the content digest, so a different spelling of the same path is not refused, and a write authorizes the edits that follow it. |
| Seen depth | How much was read matters. A capped or paged read authorizes an `edit`, where the anchor must still be present exactly once, but not a `write` that would discard lines the model never saw. Coverage is the contiguous prefix the turn has paged through, which is the shape the read's own `offset=N` hint produces, so paging to the end earns the overwrite. |
| No silent truncation | A truncated `read` names the offset that continues it, and no read returns a bare empty string. An empty file says so, an offset past the end says so, and a single line too large to show hands over the `workspace.readFile`-inside-`eval` recipe. A trailing newline ends the last line instead of creating a phantom one, so the offsets it returns always resolve. Reads count against the same per-turn budget as every other tool result (`context-budget.ts`). |
| Nothing invisible | A BOM is stripped from what the read shows, so the first line can be copied back as `old_text` and match. It is restored on write. |
| Faithful round trip | Matching runs on LF text with the BOM stripped, so an anchor typed with `\n` matches a CRLF file. The splice lands on the original string at mapped indices, so a file with mixed endings keeps every ending outside the replaced span. Only the inserted text takes the file's ending. |
| Gradable outcome | Every attempt is counted by outcome in the turn's `TurnFileLedger`, and the settle path writes one `file_edit` run event per turn: `attempts` and `applied` (calls), `failures` by reason, `recoveredPaths` and `abandonedPaths` (paths, because recovery belongs to a file, not a call). |

Reads carry no line numbers, so models copy the file text itself. The pi fuzzy
editor normalizes NFKC, smart quotes, dashes, and `trimEnd`, then rewrites the
whole file, so one smart quote can rewrite unrelated lines. This tool refuses a
miss instead.

Kinu does not use `hashline`, the oh-my-pi edit DSL (`can1357/oh-my-pi`, the
hard fork of pi, not upstream). Its always-on prompt of about 6 KB teaches a
17-rule DSL, line-numbered reads, a snapshot store, and 3-way merge, and its
gains concentrate on weak models.

## agents: delegation

`agents` combines the three deps groups `AgentsToolDeps` names: `swarm`,
`team`, and `peers`. There is no `think` group; `think` survives only as a
stored run-event tool name, which `read-models/timeline.ts` maps to the `mcts`
timeline kind. `hire`'s `lifetime` decides whether the helper persists. `swarm`
measures candidates and settles into this turn. `DELEGATION_RUNGS` in
`registry.ts` holds the rung text the `agents` schema description renders; the
prompt's `## Delegation` section (`prompts/delegation-section.md`) lists the
actions the actor holds.

Until 2026-08-17, leading with serial work made uncertainty classify as serial.
The prompt doctrine converted 0% of eligible turns where a mechanical nudge in
`orchestrator/turn-steering.ts` converted 24%. That nudge is gone, and nothing
steers a turn toward delegating. `turn-steering.ts` keeps only its three
loop-detection steers: `repeated_call`, `repeated_failure`, `no_progress`.

1. One bounded question uses `agents({action:'hire', lifetime:'task', role, mission})`.
   The call creates a full agent for the question, returns its answer as the
   tool result, and archives the row, keeping its transcript. Name oversize
   material by workspace path in the mission, so the bytes reach that agent and
   never the caller.
2. `swarm` fixes a search through `preset`, `objective`, and `depth`.
   Registered verifiers score verify-scored candidates. Nodes are full agents.
   See [EXPLORATION.md](./EXPLORATION.md).
3. `hire` without `lifetime` (or with `lifetime:'durable'`) starts a persistent
   subordinate. With `context:'fresh'` (the default) it starts from its role and
   mission; `context:'inherit'` also hands it the caller's recent turns.

A swarm derives its answer shape from `score` and `advance`, never `settle`.
`score:"verify"` uses a registered verifier. `score:"judge"` uses `samples`
under `JUDGE_MARGINALISATION_MIN`. `score:"none"` returns unranked candidates.
Only measured search needs `objective`.

`fork` is gone. Its 2 to 6 caller-written briefs became measured search
candidates, and the five-action picklist rejects it. MCTS stays in
`core/src/mcts/engine.ts` but has no model-facing route; the durable search
store and eval suites call it. See [MCTS.md](./MCTS.md).

Which of the five actions an actor holds follows from the deps its backend
wires. `agentsActionsFor` is the one gate, read by the tool's action enum, the
prompt's `## Delegation` section, and the `agents.*` sandbox namespace:

| Action | The deps that put it on the surface |
|---|---|
| `swarm` | `swarm`: a model to expand with and a workspace to measure in |
| `hire`, `msg`, `list` | `team` or `peers` |
| `dismiss` | `team` |

`lifetime` is gated one level finer, on `team.temporary`. With no port to run a
task hire on, the field is in neither the JSON Schema nor the sandbox
declaration, so it is absent from the schema rather than refused at call time.
`scope` and `event_id` are gated the same way on `peers`.

`hire`, `msg`, and `list` take a target name:

- A hired subordinate is a logical actor of the workspace object, with a full
  turn loop and a shared Nimbus session. `hire` with `role` takes a role and
  mission; `hire` naming an existing `agent` hands it the workstream, with
  `deliverable` optional. `msg` adds a note. `dismiss` archives unless
  `keep_history: false`.
- A peer is another of the owner's workspaces, reached over EventsHub. `hire`
  naming a peer waits until abort or a peer event. `msg` does not wait. `msg`
  with `event_id` answers an inbound agent message event and cannot be combined
  with `agent`. `hire` with `scope:'workspace'` creates or reuses a specialist
  workspace.
- `report` is subordinate-only, native and `report.*`, and uses
  `ReportToolDeps.report`. Turn answers relay automatically, so `report`
  carries milestones.

Owners read retained subordinate history through the workspace RPC
`inspectSubordinate`. This read is separate from model delegation and does not
make a dismissed agent addressable. `CloudAgentClient.inspectSubordinate`
(`packages/cli/src/cloud-agent-client.ts`) uses the same interactive owner
transport. Scoped access tokens cannot use it.

`path` lists direct subordinate names from the workspace root; an empty path
reads the root. The `children`, `history`, `runs`, and `plans` views take
`page` with `limit` and an optional `cursor`. The `events` view takes `runId`
and `query` with `limit` and an optional inclusive `since` index. `plan` and
`planTasks` read one plan revision. A page reports `more` with `next`, or
`end`. Missing retained storage returns a classified `missing` result.
Inspection does not initialize application identity or start a turn; normal
activation still recovers work the actor owes.

### Fields and replay

`AGENTS_ACTION_FIELDS`, `v.strictObject`, and `parseAgentsToolInput` enforce
one field contract for native and codemode calls. The native tool's `execute`
parses the model's input, and every `agents.*` member parses the object the
script passed after setting `action` itself, so the member called decides the
action. Both then reach `dispatchAgentsAction`. An unknown field fails and
names the field meant (the refusal strings in `agents-tool.ts` carry the exact
text). A field another action reads fails and names that action.

| Action | Fields its handler reads |
|---|---|
| `swarm` | `task`, `preset`, `objective`, `key`, `config`, `from`, `label`, `name`, `branches`, `depth`, `nodes`, `models`, `role`, `tier`, `budget_usd`, `budget_tokens`, `budget_label` |
| `hire` | `role`, `mission`, `agent`, `tier`, `lifetime`, `context`, `scope`, `message`, `deliverable`, `topic` |
| `msg` | `agent`, `event_id`, `message`, `topic` |
| `list` | `agent` |
| `dismiss` | `agent`, `keep_history` |

`verify` is `{kind, spec}` inside `objective`. The runner enforces `depth`,
`branches`, `budget_usd`, and `budget_tokens`, with no iteration or wall-clock
cap. `models` routes each node to its own model spec round-robin by slot,
through the same resolver a `tier` names. On 2026-08-19 the field was kept
because it was wired back in instead of left unread: an unresolvable spec is
refused, naming it, before any node runs. `role` and `tier` resolve one
immutable profile, and `models` and `tier` are mutually exclusive.

On 2026-08-18, flat `v.object` changed `{ action:'fork', task:'x',
budgetUsd:5, wallClockMs:1000 }` to `{ action:'fork', task:'x' }`, losing both
spend caps. `gate:agents-fields` now checks handler reads, including
`readMissionLimits`, against the map that generates the JSON Schema.

`resumableAgentsInput` drops unknown fields on replay, because the durable row
has already dispatched and no model can correct it. It logs
`agents.resume.fields_dropped` instead of failing the replay.

Stored `settle`, or `kind:'think'` with a non-`heads` strategy, becomes
`{action:'swarm', preset:'ideate', task}`. Such rows lack the metric, unit,
direction, and verifier a measured search needs. Swarm has no judge ranking
for them, so the lost ranking is logged as `settlement`.

### Delivery

A `hire` handed to an existing subordinate, and `msg`, never block on a busy
target. Both return the three fields `renderHandoff` builds:

| Field | Meaning |
|-------|---------|
| `event_id` | The admitted event's id. The eventual `subordinate_report` cites the same id, which ties an answer arriving turns later to the request |
| `delivery` | `starts_now` (the target was idle; the drain starts a turn) or `queued` (the target was busy or the event was already admitted, so it waits for its own Plan/Build-homogeneous turn) |
| `subordinate_phase` | `{busy, lastActivityAt, workingOn}`: what the target was doing when the message arrived |

The hire path adds `status: working` and the `ASSIGN_NOTES` sentence for its
`delivery`. `msg` adds `status: delivered | queued`. `msg` with `event_id`
answers through `peers.reply` and returns that transport's result instead. A
`hire` naming a peer is the one call here that waits, as above. The host stamps
the Plan/Build mode, and the shared drain queues the next serialized turn with
it.

## eval: codemode

`eval` runs JavaScript in an isolated sandbox. Cloudflare starts a child Worker
through `LOADER` (`@cloudflare/codemode`). The CLI evaluates in-process through
`createNodeCodemodeToolFactory`. Both bind the namespaces below.

### workspace.*

| API | Signature | What it does |
|-----|-----------|-------------|
| `workspace.readFile` | `(path: string) → string` | Read from the canonical workspace VFS |
| `workspace.writeFile` | `(path: string, content: string) → string \| {error}` | Write to the canonical workspace VFS (creates parents; overwrites need a prior read) |
| `workspace.editFile` | `(path: string, edits: [{old_text, new_text}]) → {ok, applied} \| {error}` | Exact-match edit, through the same dispatcher (`createFileDispatcher`) and gate as the native `file` tool's `edit` action |
| `workspace.readdir` | `(path: string) → string[]` | List directory entries |
| `workspace.exists` | `(path: string) → boolean` | Check whether a path exists |
| `workspace.exec` | `(command: string) → string` | Run a POSIX shell command (cat, grep, find, sed, ls, etc.) |
| `workspace.searchMemory` | `(query: string) → results` | FTS5 search over long-term memory |
| `workspace.saveNote` | `(content: string) → "ok"` | Append a note to MEMORY.md with FTS indexing |
| `workspace.listTools` | `() → Array<{name, description, qualityScore}>` | List crafted tools with their EMA scores |
| `workspace.createTool` | `(name, description, code) → {ok, name, action}` | Create or update a crafted tool in CraftStore. Callable as `tools.<name>(args)` from the next `eval` call in the same turn, because the sandbox that created it is already built |
| `workspace.slate` | `(operation) → result` | Present when slates are wired; see below |

`createInlineExecutor` registers `workspace` in `ExecutionRouter`. Native
`file` and `workspace.*` share its `TurnFileLedger` read-before-write state.
Workspace skills are written at `WORKSPACE_SKILLS_DIR` (`/home/user/skills`) on
that VFS.

### Slates

A slate is an authored project under `/home/user/slates/<id>/`. For the default
`worker` runtime, `package.json` `main` names the module that exports
`class Slate extends SlateObject` from `kinu:slate`; every public method is
callable from the client. A `node` runtime instead names a server `slate.port`
and a `dev` or `start` script. Capabilities are declared in the strict
`slate.bindings` field and called as `this.env.NAME.member(...args)`. Write the
files through the ordinary file plane, then call
`workspace.slate({op:'preview', id})` to boot a live preview. `call` invokes a
named method with a JSON argument array. `commit` freezes source, `history`
reads versions, `fork` copies a committed version into a new slate, and
`restore` restores a version's tree. Running previews live as long as the
isolate and are not durable records. These operations stay in the `workspace`
namespace, so the native surface remains eight tools.

Three things in this document are spelled `fork`. This one is a
`workspace.slate` op: it takes a committed `version` and copies its tree into a
new slate. The removed `agents` action `fork` ran caller-written briefs (see
*agents: delegation*). The `forkAgent` RPC clones a whole agent at a message
and is the UI's fork-chat.

### Projected native tools

| Namespace | Members | Shared with |
|---|---|---|
| `memory.*` | `save`, `search`, `conversations`, and (when a FactsStore is wired) `remember`/`recall`/`forget` | `createMemoryDispatcher` (`tools/memory-tool.ts`) |
| `tasks.*` | `add`, `update`, `list`, `mode` | `createTasksDispatcher` over the same `TaskListStore` instance (`tools/tasks-tool.ts`) |
| `report.*` | `send(status, content, handoff?)` | the native `report` tool's `ReportToolDeps.report` |
| `release.*` | `board`/`bindSource`/`create`/`update`/`transition`/`requestApproval`, plus `apply`/`runChecks`/`preview`/`deploy`/`rollback` (engine backends) or `recordCheck`/`recordDeployment` (ledger-only backends) | `runReleaseAction` (`tools/release-tool.ts`); release has no native tool, so this is its only reach |

These project onto their native dispatchers. `memory.*` and `tasks.*` are always
present. `report.*` is subordinate-only.

### Crafted tools

`CRAFTED_TOOL_NAMESPACE` (`types/codemode.ts`) is `tools`. It is the one
namespace every tool is callable in, native builtins and crafted tools alike,
on every backend. There is no second spelling and no alias.

| Backend | How `tools.<name>` becomes callable |
|---|---|
| Cloudflare | one `CodemodeProvider` named `tools` (`packages/cf-backend/src/codemode-tool.ts`): native tools are host-dispatched functions, crafted tools are defined by its `prelude`, and `renderToolsDeclaration(native, crafted)` is the declaration the model reads |
| CLI | the `tools` parameter of the evaluated function (`packages/cli-backend/src/codemode-tool-factory.ts`), beside `workspace` and `console`: native tools through the same `nativeToolFunctions` Cloudflare uses, crafted tools from the per-call set, and the same `renderToolsDeclaration(native, crafted)` block. `buildActorTools` builds the sandbox last, over the finished surface, so the block lists every tool the actor holds |

Both re-read the crafted set per call, so a tool saved one program earlier is
callable now. A native tool used as a bare identifier gets an explanation, not
a bare `ReferenceError`: `explainNativeToolReferenceError` names
`tools.<name>(input)` as the form. See
[CRAFT-ARCHITECTURE.md](./CRAFT-ARCHITECTURE.md).

`buildCraftedToolSetFromExecute` reads the injectable crafted tools
(`selectInjectableCraftedTools`, effective score at least 0.2) and dispatches
through `deps.craftedToolExecute`: LOADER on Cloudflare, Node on the CLI.
`buildBuiltinTools` re-reads it every call. The preamble uses the same filter.

### agents.*

A script can delegate, then save the routine with `workspace.createTool`.
`CraftStore`, `agent.schedule`, and the trigger hub take the place of a
workflow DSL, graph engine, and step store.

```javascript
// Inside eval: a workflow is code.
const settled = await Promise.all(areas.map((area) => agents.swarm({
  task: `review ${area}`,
  preset: "ideate",
})));
return settled
  .filter((run) => !("reason" in run))
  .flatMap((run) => run.candidates.map((c) => c.artifact));
```

`createAgentsCodemodeProvider` routes through `dispatchAgentsAction`.
`agentsActionsFor(deps)` governs it and the native enum by the rule above, so a
member exists exactly when the action does. A workspace orchestrator wires
`swarm`, `team`, and `peers` and gets all five. A head gets none of the three,
so `buildActorTools` does not add the tool and the namespace has no members.
`forkAgent` is never projected. A sandboxed search cannot resume safely, so use
the native tool for durable work.

### No fallback, shared description, and preamble

Cloudflare requires `LOADER`. The CLI requires `createNodeCodemodeToolFactory`.
Without either, `eval` returns "not configured" instead of falling back to
`new Function()`, which fails in a V8 isolate.

`renderCodemodeDescription(typeBlock)` gives both backends the registry spec,
sandbox facts, and declarations. Cloudflare substitutes `{{types}}`; the CLI
joins the declared `types`. Neither writes its own text. A description written
by a backend reaches the model without the spec, leaves out live namespaces,
and names `codemode.<name>` calls the dispatcher throws on. A declaration whose
prose disagrees with its arguments is how an object argument arrives as
`"[object Object]"`.

Crafted tools are defined by the `tools` provider prelude
(`renderToolsPrelude`, `cf-backend/src/codemode-sandbox.ts`), one guarded
definition per tool, before the model's program runs. A program is a
Node-style script: statements at the top level, `await` anywhere, `return` for
the result. `packages/cf-backend/tests/workerd/codemode-sandbox.test.ts` runs
it under workerd: `require('fs/promises')` over the workspace, `state.*`, a
crafted tool calling another, a broken crafted row breaking only its own name,
and `fetch` through the egress entrypoint.

## file: action reference

```
file { action: "read",   path, offset?, limit? } → the content, or a marker naming the next offset
file { action: "list",   path }                  → the directory's entries
file { action: "stat",   path }                  → { path, size, mtimeMs, isDir }
file { action: "search", path, query }           → { path, matches, truncated? }
file { action: "edit",   path, edits: [{ old_text, new_text }] }
                                                 → { ok, path, reference, applied: [{ line, removed_lines, added_lines }] }
                                                 → or { error } naming exactly what was wrong
file { action: "write",  path, content }         → { ok, path, reference, bytes, action: "created" | "replaced" }
```

`search` finds literal text in one file and returns matching lines with line
numbers. `file_edit` records `not_found`, `ambiguous`, `empty_anchor`,
`overlap`, `no_change`, `unread`, `stale`, `missing`, and `io`. Missing
`new_text` is refused; `""` deletes. `file-edit.ts` is pure string math, and
`file-ledger.ts` holds turn state. The `file-plane` layergate injects faults
into exact edits and clipped reads.

## shell: shell command

`shell` is the Nimbus POSIX shell over the same files as `file` and
`workspace.*`. It has pipelines, redirects, variables, loops, and the "~95
coreutils" the executor advertises (`packages/core/src/execution/inline.ts`);
that number is the executor's claim, not a count. Live executor status defines
what hosted execution can do. Local execution uses the workspace process.

`runtime` accepts `workspace`, `sandbox`, or a device by the nickname the live
prompt lists, and defaults to `workspace`. `sandbox` and each device have
separate files; each device mounts at `/pc/<name>`. `ExecutionRouter` has no
fallback: an absent runtime returns `runtime_not_provisioned`. Relative paths
resolve against `WORKSPACE_ROOT`, `/home/user`. Containers receive
`/workspace`.

`shell`, `eval`, and resumable `agents` spawns can run in the background.
`detachAfterMs` is 30,000 for interactive turns and 300,000 for one-shot
turns. Detached work has no deadline. Teardown waits `settleGraceMs`: 300,000
interactive, 120,000 one-shot. Approval checks every runtime first: `deny`
refuses; `gate` requires `allow_all`.

## agents swarm: configured search

`runSwarmAction` resolves `preset`, validates its axis tuple, then calls
`runSwarm`, the only step that spends. `AgentsSwarmDeps` holds the runtime,
model resolver, pricing, isolation, and shared-prefix compaction.

| `reason` | What it says |
|---|---|
| `bad_input` | the call does not describe a legal search |
| `unsupported` | a legal search this tree has no engine for |
| `unavailable` | a legal search whose instrument this actor does not have |

A started run returns the axes, caps, frozen `profile`, settle report,
publication marker, and candidates. A refusal returns `reason`.
[EXPLORATION.md](./EXPLORATION.md) defines axes, presets, `custom`, nodes, and
legal calls.

## experience: cross-workspace transfer

`experience` is owner-facing; it is not a tool or a namespace. The owner drives
it through the workspace RPC `experienceAction`, which calls core
`runExperienceAction` over the owner's UserDO library, gated by the
`experience.read` and `experience.write` capabilities. The model has no route
to it.

`publish` needs real uses plus an injection score for crafted tools,
corroborated lessons, confident facts, or a live scaffold with a passing
`decidePromotion`, `DEFAULT_SHADOW_CONFIG.minTrials` graded turns, and no
misevolution veto.

`import` runs the misevolution gate, records vetoes, and stages survivors in
`imported_experience`. Only `EvolutionEngine.reviewTurn` promotes accepted
entries, discards corrected or frustrated ones, or leaves ungraded ones
waiting. Imported scaffolds enter `modifyScaffold` as pending. Only
`applyPromotionDecision` writes `scaffoldPath`.

## CraftStore lifecycle

`EvolutionEngine.extractPattern()` extracts patterns. `updateCraftScores()`
applies an EMA with α=0.3. Injection needs an effective score of 0.2.
Consolidation retires tools below 0.1 after at least 2 uses, and skips the pass
if it would retire every tool. Surviving tools are called as
`tools.<name>(args)`.

## Why eight tools

Eight standing choices matter more than a short description. `skills` and
`release` stay reachable through `workspace.*` and `release.*`. Filesystem work
uses `file` or `eval`. Delegation uses `agents`. No shell command replaces
`agents` or the exact-match checks in `file`.

The native schema was 11,823 description characters, about 2,956 tokens at
chars/4, measured 2026-08-19. `agents` used 4,805 characters, `tasks` 1,704,
and `file` 1,331. That is larger than the earlier surface: on 2026-08-12 the
eight names measured 9,034 chars against 10,201 for the prior ten, and later
docstring work put the eight above both. The count fell; the description did
not.

Declared codemode `types`, measured 2026-08-19:

| namespace | members | chars | tokens at chars/4 |
|---|---:|---:|---:|
| `release.*` (engine backend) | 11 | 2,000 | 500 |
| `release.*` (ledger-only backend) | 8 | 1,728 | 432 |
| `memory.*` (with a FactsStore) | 6 | 1,118 | 280 |
| `memory.*` (notes only) | 3 | 628 | 157 |
| `tasks.*` | 4 | 988 | 247 |
| `report.*` | 1 | 382 | 96 |

`release.*` exceeds the retired native `release` tool's 704-character flat
schema because member JSDoc costs more than an action enum. That 704 is
history and cannot be measured again. `memory.*`, `tasks.*`, and `report.*` add
to the native text. Crafted tools keep the top-level total flat.

`tasks` stays separate from `memory`: memory is for later retrieval, tasks hold
the active plan. Folding them together would add `titles`, `parent`, `id`,
`status`, and `role` to every durable-state decision.

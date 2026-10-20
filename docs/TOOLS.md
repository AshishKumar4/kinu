# Agent tools

`BUILTIN_TOOLS` in `packages/core/src/tools/registry.ts` lists eight native
tools. Each is a standing choice the model weighs every turn, so a longer list
lowers selection accuracy. `buildBuiltinTools` (`tools/builtins.ts`) builds one
set for both backends. `eval`, `shell`, `file`, `memory`, and `tasks` are always
present; `agents`, `web`, and `report` need wired deps. `file`, `agents`,
`memory`, `tasks` and `web` select an operation with `op`; `eval`, `shell` and
`report` take their declared input directly. Inside `eval`, `tools.<name>(input)` calls any tool with its
native input, and a native tool's operations are also its namespace's members
(`memory.note(text)`): both run one served operation.

## Top-level tools

| Tool | Purpose |
|------|---------|
| `eval` | The codemode sandbox. The model writes JavaScript against `tools.<name>`, `file.*`, `memory.*`, `tasks.*`, `agents.*`, `report.*`, `web.*`, `agent.*`, `db.*`, and each machine's namespace (`workspace.*`, `computer.*`, `device.*`, `parent.*`) |
| `shell` | One shell command in one selected runtime |
| `file` | The file plane, over the same workspace filesystem every other surface addresses: `read`, `write`, `edit`, `list`, `stat`, `search` |
| `agents` | Delegation: `swarm \| hire \| assign \| hireWorkspace \| message \| reply \| list \| dismiss` (`AGENTS_OPS`), each offered only where its wiring is |
| `memory` | Durable memory: `note` saves prose and `search` ranks notes and facts; `remember \| recall \| forget` keyed facts; `searchConversations \| readConversation \| listConversations` read this agent's past conversations |
| `tasks` | The agent's task list and active role: `add` titles (with a `parent` for subtasks), `update` one item's status, `note` it, `list` it back, `role` reads the active role and `switchRole` changes it. One row per item in `agent_tasks`; open items render into the live context block every step and into the Tasks tab |
| `web` | `search` returns ranked results (title, url, snippet, date); `fetch` returns one URL as markdown, and with `render: true` loads it in Browser Run first (quick action `content`, then Kinu's converter); `screenshot` saves a PNG under `screenshots/` and shows it to a model that takes images: inside the tool result on Anthropic Messages and OpenAI Responses, in a user message right after the tool results on Chat Completions; a model without image input gets a note in its place. Rendering and screenshots run on Kitesurf unless `engine: 'chrome'`; the CLI reaches Browser Run with `CLOUDFLARE_ACCOUNT_ID` and `CLOUDFLARE_API_TOKEN`, and refuses naming them without. Search is the deployment's own, Cloudflare's Web Search API on Ceramic.ai's index (`$0.25` per 1,000 requests, billed to the platform account's AI Gateway credits), through the AI binding on a Worker and through the signed-in account's `/api/user/web/search` from the CLI; a stored `tavily` credential wins, at `https://api.tavily.com` or at the credential's own `baseURL` (a bearer credential's optional endpoint, for a proxy). With neither, search refuses saying so. Key-less DuckDuckGo was removed: from Workers in six regions it answered results to 3 of 72 queries (2026-10-17). In eval, `web.openBrowser` opens a Chrome session kept across programs until closed or idle 20 min, with a Live View link, and `web.connectBrowser` drives it with @cloudflare/puppeteer through `CodemodeEgress`, which admits only the agent that opened it; `connectBrowser('kitesurf')` starts a browser that ends with its program. `web.pageTools`/`web.callPageTool` list and run a page's WebMCP tools (Kitesurf, or Chrome opened with `lab: true`). Hosted only; the CLI refuses sessions |
| `report` | A hire's report to whoever assigned the work: `status` is `progress`, `completed` or `blocked`, with `content` and, where the destination takes them, the `concerns`, `deviations`, `findings` and `open_work` lists. Programs call `report.send(status, content, options?)` |

`submit_plan`, `reply_to_comment` and `ask_owner` are not among the eight:
they are the owner's lane, and `ownerLaneTools` builds each only where core's
`turnReach` gives the turn it (`submit_plan` on an owner turn in Plan mode,
`reply_to_comment` while a plan the owner sent back awaits answers). Their
effects commit in the agent's own store, so on the cloud the agent's isolate
builds and runs them under its own receipt and the workspace only declares them
(`ownerLaneDeclarations`); the CLI's `buildBuiltinTools` adds them beside the
eight.

### Reach

`TOOL_REACH` declares where each capability exists and how a replayed call
behaves. Some rows:

```ts
eval:    { native: true,  codemode: null,        replay: 'claimed' } // native only; it is the sandbox
shell:   { native: true,  codemode: 'workspace', replay: 'claimed' } // native, plus a namespace it does not own
file:    { native: true,  codemode: 'file',      replay: 'claimed' } // both surfaces
web:     { native: true,  codemode: 'web',       replay: 'safe' }    // both surfaces
db:      { native: false, codemode: 'db',        replay: 'claimed' } // codemode only
```

The codemode-only rows are `agent`, `db`, and `slate` (which reaches
`workspace`). `codemode` is a namespace name, not a boolean. `shell` and `slate`
use the `workspace` namespace, so they own none. A capability owns a namespace
when `codemode` equals its key. `replay` is `safe` when rerunning a call cannot
do anything twice; `claimed` calls go through the effect claim
(`tools/effect-claim.ts`). A name the table does not declare, such as an MCP
tool, is `claimed`.

Readers keep the declaration authoritative:

| Reader | What it uses the declaration for |
| --- | --- |
| `BuiltinToolName` (a derived type) | `BUILTIN_TOOL_SPECS` / `BUILTIN_TOOL_DESCRIPTIONS` cannot compile without an entry for a newly native capability, and `BUILTIN_TOOLS` cannot list one the declaration does not call native |
| `explainSandboxError` | tells the model where a capability is when it uses a native tool name inside the sandbox. It reads the table instead of hardcoding names |
| `getToolDescriptions` (cf) | reports `exposure` and `wired` to the Tools panel instead of guessing `nativeNames.has(name) ? 'native' : 'codemode'` |

Reach says what a surface exposes. Deps say what an actor gets. An orchestrator
is the `report` sink and has `report` on neither surface; the `nativeNames`
guess would have shown it as codemode-only.
`packages/core/tests/unit-tools.test.ts` checks each native tool against
`BUILTIN_TOOLS` and codemode-only reach against the declaration.

`skills` is not on the standing list. Every skill loads from the
read-only `/skills` view as `/skills/<name>/SKILL.md` (`skills/view.ts`): a
built-in from its source, any other name from the workspace's
`/home/main/skills/` or the owner's `/shared/skills/`, by the one precedence in
`skills/discover.ts`. The prompt lists them through `renderSkillsIndexSection`;
only a user's `/name` or an operator pin loads a body at turn start.

| Call | What it makes |
| --- | --- |
| `workspace.createTool(name, description, code)` | a reusable crafted tool, callable as `tools.<name>(args)` from the next `eval` call |
| `workspace.slates.<id>.<method>(...args)` | a call to an authored slate's class method; `$`-named members preview, list, commit, fork, restore or remove slates |

## Plan authority

Core enforces Plan. It does not infer it from command text or trust a model's
promise. `execution/work-mode.ts` owns the Plan permission check: operations
that are safe in Plan are wrapped with `permitInPlan` and carry `planAllowed`,
and dispatchers with mixed actions check each parsed action. An unclassified
operation is unavailable in Plan. Build keeps every capability.

In Plan, native `file` read/list/stat/search and declared provider reads stay
usable. Write and edit, process/package/port operations and authored
slate execution need Build. Slate `list` and `history` are inspection;
`commit`, `fork`, `restore`, `preview`, and `call` are not. A Build preview that
already runs keeps the authority it was started with. Research memory, tasks,
`db` records, evidence and reports, and `submit_plan` stay available.
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

## The inert boundary

A measured session (the OMP measurement, `evals/omp/`) runs its turns behind `toolsBehindBoundary`
(`execution/work-mode.ts`), set through the workspace's open config (`CLIOpenConfig.boundary`) and by nothing else; every
agent the workspace hires inherits it with the rest of its parent's open config. The turn stays Build, so
its authored scaffold and its evolution accounting run as they would. Each tool call runs as Plan would run it: what
Plan permits runs (reads, research, the agent's own memory), and a call in which Plan refused an operation never runs.
It is recorded as intended (`ToolBoundary.intended`) and answered from a record of the same call where the measurement
holds one, or with `NOT_RUN`. Plan's own classification decides; there is no second list. On the CLI that keeps every
shell command and in-process program from running, as Plan does.

## file: the file plane

`FILE` (`operations/file.ts`) declares `read`, `text`, `write`, `edit`, `list`,
`stat`, and `search`. The native `file` tool serves six of them; `text`, the
whole file as one string, is for programs, which hold the value
(`createFileTool`, `tools/file-operations.ts`). `file.*`, every machine's
`fs.*`, and the workspace `shell` address one file plane: on hosted, the
actor's Nimbus workspace; on CLI, this machine's files, the workspace's folder
and its own space at `~/.kinu/<workspace>/`. The computer and devices keep
separate files, mounted at `/computer` and `/pc/<name>`.

`<machine>.fs.*` is the same seven operations in that machine's own paths, on
`workspace`, `computer` and `device` (`device` takes `{device?}`), and not on
`parent`: the folder a hire shares with its parent is among its own files, read
through `file` (`machineFileOperations`, `operations/executors.ts`). An absolute path is the
machine's own, a relative one starts at its home, and a `..` that would climb
above the machine's root is held there (`onMachine`,
`tools/executor-operations.ts`). Each call becomes the `file` operation on the
plane path (`/computer/...`, `/pc/<name>/...`), so the ledger and the approval
gates are one: a read through either spelling lets an edit through the other.
The workspace's root is the plane's own, so `workspace.fs` and `file` are one
operation under two names.

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
| Read before write | `edit`, and `write` over an existing file, are refused unless the file has been read since the conversation was last compacted (a read lasts across turns, and a compaction forgets every read), and refused again (`stale`) if it changed after that read. The refusal names the exact call to make next. Authorization is keyed on the content digest, so a different spelling of the same path is not refused, and a write authorizes the edits that follow it. |
| Seen depth | How much was read matters. A capped or paged read authorizes an `edit`, where the anchor must still be present exactly once, but not a `write` that would discard lines the model never saw. Coverage is the contiguous prefix the turn has paged through, which is the shape the read's own `offset=N` hint produces, so paging to the end earns the overwrite. A line a read cuts at 2,000 characters was not seen: the prefix stops before it and no later read passes it. `file.text` inside `eval` hands the program the whole file and earns the overwrite, and the refusal names it. An edit moves the covered prefix with its replacements: authored text counts as seen, but deleting read lines does not cover unseen lines that move up, and joining a read line to an unread one leaves the joined line unread. |
| Asks before replacing the user's files | A change on `/pc` or `/shared`, or outside a CLI workspace's directory, goes through `approveFileAccess` (`core/src/safety/approval-gate.ts`) under the shell's approval mode and grants; a new file on `/pc` or `/shared` is free. With nobody to answer, a hosted overwrite parks bound to its bytes (`file write <path> sha256:<new> over sha256:<old>`): approving writes those bytes unless the file changed meanwhile, `reviewParkedWrite` shows the diff, and the bytes are deleted once the row is decided. The CLI asks and never parks. A read asks only when it looks like a secret, as `cat` would. |
| No silent truncation | A truncated `read` names the offset that continues it, and no read returns a bare empty string. An empty file says so, an offset past the end says so, and a single line too large to show hands over the `file.text`-inside-`eval` recipe. A trailing newline ends the last line instead of creating a phantom one, so the offsets it returns always resolve. Reads count against the same per-turn budget as every other tool result (`context-budget.ts`). |
| Nothing invisible | A BOM is stripped from what the read shows, so the first line can be copied back as `old_text` and match. An edit preserves it. The ledger and the streaming scanner use the same BOM-free text identity as `file.text`, so reading through either surface authorizes the same content. |
| Faithful round trip | Matching runs on LF text with the BOM stripped, so an anchor typed with `\n` matches a CRLF file. The splice lands on the original string at mapped indices, so a file with mixed endings keeps every ending outside the replaced span. Only the inserted text takes the file's ending. |
| Gradable outcome | Every attempt is counted by outcome in the turn's `TurnFileLedger`, and the settle path writes one `file_edit` run event per turn: `attempts` and `applied` (calls), `failures` by reason, `recoveredPaths` and `abandonedPaths` (paths, because recovery belongs to a file, not a call). |

A read numbers each line: its number, a tab, then the line. `old_text` is the
text after the tab. The pi fuzzy editor normalizes NFKC, smart quotes, dashes,
and `trimEnd`, then rewrites the whole file, so one smart quote can rewrite
unrelated lines. This tool refuses a miss instead.

Kinu does not use `hashline`, the oh-my-pi edit DSL (`can1357/oh-my-pi`, the
hard fork of pi, not upstream). Its always-on prompt of about 6 KB teaches a
17-rule DSL, line-numbered reads, a snapshot store, and 3-way merge, and its
gains concentrate on weak models.

## agents: delegation

`agents` combines the three deps groups `AgentsToolDeps` names: `swarm`,
`team`, and `peers`. Each operation is declared in
`delegation/agents-operations.ts` and offered only where its wiring is
(`agentsActionsFor`, `delegation/agents-tool.ts`). `hire`'s `lifetime` decides
whether the helper persists. A `swarm` on a live session runs in the background
and its result wakes the caller. The `agents` notes are
`BUILTIN_TOOL_SPECS.agents.notes` in `registry.ts`; the prompt's `## Delegation`
section (`prompts/delegation-section.md`) names the operations the actor holds.

Until 2026-08-17, leading with serial work made uncertainty classify as serial.
The prompt doctrine converted 0% of eligible turns where a mechanical nudge in
`orchestrator/turn-steering.ts` converted 24%. That nudge is gone, and nothing
steers a turn toward delegating. `turn-steering.ts` keeps only its three
loop-detection steers: `repeated_call`, `repeated_failure`, `no_progress`.

1. One bounded question uses `agents({op:'hire', lifetime:'task', role, message})`.
   The call starts a full agent for the question and returns at once; its
   answer arrives later as a message that opens the caller's next turn, and the
   row is archived with its transcript. Name oversize material by workspace
   path in the message, so the bytes reach that agent and never the caller.
2. `swarm` fixes a search through `preset`, `objective`, and `depth`.
   Registered verifiers score verify-scored candidates. Nodes are full agents.
   See [EXPLORATION.md](./EXPLORATION.md).
3. `hire` without `lifetime` (or with `lifetime:'durable'`) starts a persistent
   subordinate. With `context:'fresh'` (the default) it starts from its role
   and message; `context:'inherit'` also hands it the caller's recent turns.

A swarm derives its answer shape from `score` and `advance`, never `settle`.
`score:"verify"` uses a registered verifier. `score:"judge"` on a tree advance
needs at least `JUDGE_MARGINALISATION_MIN` `samples`. `score:"none"` returns
unranked candidates. Only measured search needs `objective`.

`fork` is gone. Its 2 to 6 caller-written briefs became measured search
candidates. MCTS folded into swarm (2026-09-27): swarm's tree search is the one
search engine.

Which operations an actor holds follows from the deps its backend wires.
`agentsActionsFor` is the one gate, read by the native tool's schema, the
prompt's `## Delegation` section, and the `agents.*` namespace:

| Operation | The deps that put it on the surface |
|---|---|
| `swarm` | `swarm` (a model to expand with and a workspace to measure in), and the account's swarms beta on |
| `hire`, `dismiss` | `team`, below the delegation depth cap |
| `assign`, `message`, `list` | `team` below the cap, or `peers` |
| `hireWorkspace`, `reply` | `peers` |

`lifetime` is gated one level finer, on `team.temporary`. With no port to run a
task hire on, the field is in neither the JSON Schema nor the program
declaration, so it is absent from the schema rather than refused at call time.
`topic` is gated the same way on `peers`, and `deliverable` on `team`.

- A hired subordinate is a logical actor of the workspace object, with a full
  turn loop and a shared Nimbus session. `hire` takes a `role` and a `message`,
  with an optional new `name`. `assign` hands an existing `agent` its next
  workstream, with `deliverable` optional. `message` sends a note without a
  workstream. `dismiss` archives unless `keepHistory: false`.
- A peer is another of the owner's workspaces, reached over EventsHub.
  `assign` to a peer waits until abort or the peer's reply. `message` does not
  wait. `reply` answers an inbound agent message by its `eventId`.
  `hireWorkspace` creates or reuses a specialist workspace from its `mission`,
  sends it `message`, and waits for the result.
- `report` belongs to an actor someone assigned work to, native and
  `report.send`, through `ReportDeps.report`. Turn answers relay automatically,
  so `report` carries milestones.

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

Each `agents` operation is declared once, with its own fields, in
`delegation/agents-operations.ts`, as a `v.strictObject` the wiring assembles.
The native tool and every `agents.*` member parse a call against it, and the
parsed fields reach `dispatchAgentsCall` as they are, under the operation's
name: the dispatcher's field types are checked against those declarations at
compile time, and nothing renames or remaps them. An unknown field fails and
names the field; a retired one (`hire`'s `mission`) names its successor
(`operations/retired.ts`).

| Operation | Fields |
|---|---|
| `swarm` | `task`, `preset`, `objective`, `key`, `config`, `from`, `label`, `name`, `branches`, `depth`, `nodes`, `models`, `role`, `tier`, `budgetUsd`, `budgetTokens`, `budgetLabel` |
| `hire` | `role`, `message`, `name`, `tier`, `context`, `lifetime` (with a task-agent port) |
| `assign` | `agent`, `message`, `deliverable` (with a team), `topic` (with peers) |
| `hireWorkspace` | `mission`, `message`, `agent` |
| `message` | `agent`, `message`, `topic` (with peers) |
| `reply` | `eventId`, `message` |
| `list` | `agent` |
| `dismiss` | `agent`, `keepHistory` |

`verify` is `{kind, spec}` inside `objective`. The runner enforces `depth`,
`branches`, `budgetUsd`, and `budgetTokens`, with no iteration or wall-clock
cap. `models` routes each node to its own model spec round-robin by slot,
through the same resolver a `tier` names. On 2026-08-19 the field was kept
because it was wired back in instead of left unread: an unresolvable spec is
refused, naming it, before any node runs. `role` and `tier` resolve one
immutable profile, and `models` and `tier` are mutually exclusive.

On 2026-08-18, flat `v.object` changed `{ action:'fork', task:'x',
budgetUsd:5, wallClockMs:1000 }` to `{ action:'fork', task:'x' }`, losing both
spend caps. Each operation's `v.strictObject` now refuses an unknown field, and
the dispatcher reads only the fields that declaration admitted.

`resumableAgentsInput` drops unknown fields on replay, because the durable row
has already dispatched and no model can correct it. It logs
`agents.resume.fields_dropped` instead of failing the replay.

### Delivery

`assign` to an existing subordinate, and `message`, never block on a busy
target. Both return the three fields `renderHandoff` builds:

| Field | Meaning |
|-------|---------|
| `event_id` | The admitted event's id. The eventual `subordinate_report` cites the same id, which ties an answer arriving turns later to the request |
| `delivery` | `starts_now` (the target was idle; the drain starts a turn) or `queued` (the target was busy or the event was already admitted, so it waits for its own Plan/Build-homogeneous turn) |
| `subordinate_phase` | `{busy, lastActivityAt, workingOn}`: what the target was doing when the message arrived |

`assign` adds `status: working` and the `ASSIGN_NOTES` sentence for its
`delivery`. `message` to a subordinate adds `status: delivered | queued`; to a
peer it returns that transport's result. `reply` answers through
`peers.reply` and returns its result. `assign` to a peer, and `hireWorkspace`,
are the calls here that wait, as above. The host stamps the Plan/Build mode,
and the shared drain queues the next serialized turn with it.

## eval: codemode

`eval` runs JavaScript in an isolated sandbox. Cloudflare starts a program
Worker through `LOADER` (`KinuSandboxExecutor`, `cf-backend/src/codemode-sandbox.ts`,
built by `createCodemodeToolFactory`). The CLI evaluates in-process through
`createNodeCodemodeToolFactory`. Both bind the same namespaces: `tools`
(`toolsNamespace`, `tools/sandbox-contract.ts`), the actor's own namespaces
(`actorNamespaces`, `delegation/actor-surface.ts`), and one namespace per
machine (`executorNamespace`, `tools/executor-operations.ts`).

A member takes its required fields positionally, then one object of options:
`agents.hire(role, message, { lifetime: 'task' })`, `file.list(path, { offset })`.
`tools.<name>(input)` takes a tool's native input instead, including `op` where its schema declares it. Any
call can resolve to a `Refusal`, `{ success: false, reason, error }`; returning
one fails the program with that reason. `describe('db')` returns a namespace's
full TypeScript declarations, `describe('db.select')` one member's, and
`describe()` all of them (`programDeclarations`, `registry.ts`).

### What each caller reaches

`SURFACE_POLICY` (`delegation/actor-surface.ts`) is the one table:

| Caller | Reaches |
|---|---|
| An actor's own program: main's, a hire's, a head's or a swarm node's | what its own native tools reach and no more: `file`, `memory` (the account's scope where it is wired), `tasks`, `db` with its `private` tables, and each machine it has; `agent` where its lifecycle or owner-wait host is wired, `web`'s browser sessions where they are wired, `agents` where its native `agents` is wired, and `report` where its native `report` is. A head or swarm node holds only `eval shell file web` (and a node `report`), so its programs reach no `memory`, `tasks` or `agents` (`narrowAdmittedSurface`) |
| A slate's call, or a crafted tool a slate runs | the members `slateReaches` admits (`slates/surface.ts`): no `agents`, `agent`, `report`, `createTool`, `retireTool` or slate lifecycle, no member its operation keeps from slates (`switchRole`, the desktop), no account memory and no `private` tables; a share's viewer drives no browser |
| The owner's own slate | a slate's reach, plus `agents` |

### Machines

Each machine's members come from its declared capabilities
(`machineOperations`, `operations/executors.ts`), one name and one shape on
every machine:

| Member | Answers | Admitted by |
|---|---|---|
| `exec(command, { cwd?, name?, parts? })` | the output as text, or `{ stdout, stderr, exitCode }` with `parts` | `shell` |
| `startProcess(command, { cwd? })` | `{ processId, jobId? }` | `process_long` |
| `stopProcess(processId)` | `{ stopped }` | `process_long` |
| `listProcesses()` | `[{ processId, pid?, status, restartable?, command, session?, waiting? }]` | `process_long` |
| `logs(processId, { lines?, bytes? })` | text | `process_long` |
| `exposePort(port, { name? })` | `{ port, url, name?, route }` | `net_inbound` |
| `unexposePort(port)` | `null` | `net_inbound` |
| `listPorts()` | `[{ port, url, name?, status }]` | `net_inbound` |
| `fs.read`, `fs.text`, `fs.write`, `fs.edit`, `fs.list`, `fs.stat`, `fs.search` | as `file.*` | a root in the file plane |

Every `device` member also takes `{ device? }`. A variable a process needs goes
at the head of its command (`PORT=4100 node server.js`).

- The hosted workspace has all of them, plus `createTool`, `listTools`,
  `retireTool` and `slates`. A process its `startProcess` starts is a
  background job of the agent's from its start (`jobId`): the job holds the
  workspace awake while the process runs, and its end, or a restart that lost
  it, wakes the agent. One past the job cap is stopped and refused. A retry of
  its job starts the command again as a job of its own.
- The CLI workspace has `exec` and `fs`, plus `createTool`, `listTools`,
  `retireTool` and `slates`; it declares no `process_long` or `net_inbound`.
- The computer has all of them, plus `resize(size)` where it has sizes,
  `rest(answer)`, and the eight desktop members (`screenshot`, `watch`,
  `click`, `type`, `key`, `scroll`, `move`, `drag`) where it has a screen.
- A device has `exec` and `fs`.
- `parent` has `exec` alone, in the parent's own paths.

Code runs through `exec`: `node -e '...'`, `python3 -c '...'`, `ruby -e '...'`.
TypeScript does not parse in `node -e`; write it to a `.ts` file and run
`node file.ts`. A runtime installs the first time a command names it. Measured
2026-10-19 on staging `667f96316`: from a fresh workspace, `exec` gave the same
output `runCode` gave in each of its five languages, and installed Python and
Ruby on first use (`runcode-probe.md` in the surface plan's folder). On the
user's machines `exec` is approved as it always was: command review, strict
mode, the bound-directory gate and device consent. An interpreter handed its
program as text meets those rules alone (ARCHITECTURE-DECISIONS M5, O4).

A removed member is refused with its successor named, never run under its old
name. `operations/retired.ts` is the one table: `workspace.readFile`,
`writeFile`, `readdir` and `exists` (now `workspace.fs.text`, `write`, `list`
and `stat`), `workspace.killProcess` (`stopProcess`), `workspace.runCode` and
`installRuntime` (`exec`), `workspace.listRuntimes` (the Execution status in the
context), the machines' `readdir`, `exists`
and `computer.deleteFile`, `parent.readdir` and `exists` (`file.*`), the `state`
namespace (a `private` `db` table), `agents.hire`'s `mission` (`message`), and
`workspace.startProcess`'s `env` and `timeoutMs`.

### workspace.*

| Member | What it does |
|-----|-------------|
| `workspace.listTools()` | Crafted tools, best first, each with its preference and, if its last call raised, the error |
| `workspace.createTool(name, description, code)` | Create or update a crafted tool; answers `{ name, action }`. Callable as `tools.<name>(args)` from the next `eval` call, because the sandbox that created it is already built. A rewrite clears its broken flag |
| `workspace.retireTool(name)` | Delete a crafted tool; answers `{ name, action: 'retired' }` |
| `workspace.slates` | `.<id>.<method>(...args)`, `.<id>.$preview()`, `.$list()`, ...; present when slates are wired, see below |

In an `eval` program, `process.cwd()` is the workspace root, and
`require('fs/promises')` keeps Node's names over `workspace.fs`, resolving a
relative path against it. Workspace skills are written at
`WORKSPACE_SKILLS_DIR` (`/home/main/skills`).

### Slates

A slate is an authored project under `/slates/<id>/`. `/slates` is the
workspace's, not one agent's: every agent, hired ones too, makes, edits,
previews and removes slates there, and only the workspace root shares one with other people. For the default
`worker` runtime, `package.json` `main` names the module that exports
`class Slate extends SlateObject` from `kinu:slate`; every public method is
callable from the client. A `node` runtime instead names a server `slate.port`
and a `dev` or `start` script. A slate declares no capabilities: it calls its
caller's own reach as `this.env.workspace.<namespace>.<member>(...args)`, the
namespaces an `eval` program reaches less what only the agent does
(`docs/LIVE-UI.md`). Write the files through the ordinary file plane, then call
`workspace.slates.<id>.$preview()` to boot a live preview.

`workspace.slates.<id>.<method>(...args)` calls a class method with JSON
arguments, as the slate's own client does. `$commit()` freezes source,
`$history(after?)` reads versions a page at a time, oldest first, and names the
cursor for the next page, `workspace.slates.$fork(version)` copies a committed
version into a new slate, and `$restore(version)` restores a version's tree.
`$`-named members are lifecycle, which no class method can shadow. Running
previews live as long as the isolate and are not durable records. These members
stay in the `workspace` namespace, so the native surface remains eight tools.

Three things in this document are spelled `fork`. This one is
`workspace.slates.$fork`: it takes a committed `version` and copies its tree into
a new slate. The removed `agents` action `fork` ran caller-written briefs (see
*agents: delegation*). The `forkAgent` RPC clones a whole agent at a message
and is the UI's fork-chat.

### Native tools as namespaces

| Namespace | Members | Served by |
|---|---|---|
| `file.*` | `read`, `text`, `write`, `edit`, `list`, `stat`, `search` | `serveFile` (`tools/file-operations.ts`), on the native tool's ledger |
| `memory.*` | `note`, `search`, `searchConversations`, `readConversation`, `listConversations`, and (with a FactsStore) `remember`, `recall`, `forget`; a write takes `scope: 'account'` and a read names its scope where the account is wired | `serveMemory` (`tools/memory-operations.ts`) |
| `tasks.*` | `add`, `update`, `note`, `list`, `role`, `switchRole` | `serveTasks` (`tools/tasks-operations.ts`) |
| `agents.*` | the operations `agentsActionsFor` offers | `createAgentsCodemodeProvider` (`delegation/agents-operations.ts`) |
| `report.*` | `send(status, content, options?)` | `serveReport` (`tools/report-operations.ts`) |
| `web.*` | `search`, `fetch`, `screenshot`, and the browser sessions | `serveWeb` (`tools/web-operations.ts`) |

Each is the same served operation as the native tool's, so the schema, the
checks and the ledger are one. `report.*` exists where a parent drives the
turn.

### Crafted tools

`CRAFTED_TOOL_NAMESPACE` (`types/codemode.ts`) is `tools`. It is the one
namespace every tool is callable in: native tools with their native input,
crafted, MCP and extension tools, and a head's own tools. A native tool's
namespace member is the same operation under a second name, never a second
implementation.

| Backend | How `tools.<name>` becomes callable |
|---|---|
| Cloudflare | `toolsNamespace` over the actor's tools (`packages/cf-backend/src/codemode-tool.ts`): native tools are host-dispatched, crafted tools are defined by the `tools` provider's prelude (`renderToolsPrelude`, `renderCraftedDefinitions`), and each native tool's own schema is its input |
| CLI | the same `toolsNamespace` among the evaluated function's parameters (`packages/cli-backend/src/codemode-tool-factory.ts`), crafted tools defined ahead of the program by the same `renderCraftedDefinitions` |

Both re-read the crafted set per call, so a tool saved one program earlier is
callable now. A native tool used as a bare identifier gets an explanation, not
a bare `ReferenceError`: `explainSandboxError` names
`tools.<name>(input)` as the form. See
[CRAFT-ARCHITECTURE.md](./CRAFT-ARCHITECTURE.md).

`codemodeSurface` (`packages/core/src/tools/builtins.ts`) is the one reader of
the crafted tools a turn is offered (`selectInjectableCraftedTools`, at most 20 by
preference); both backends' `eval` read its `craftedTools()` on every call. The
preamble uses the same set.

### agents.*

A script can delegate, then save the routine with `workspace.createTool`.
`CraftStore`, `agent.schedule`, and the trigger hub take the place of a
workflow DSL, graph engine, and step store.

```javascript
// Inside eval: a workflow is code.
const settled = await Promise.all(areas.map((area) => agents.swarm(`review ${area}`, {
  preset: "ideate",
})));
return settled
  .filter((run) => !("reason" in run))
  .flatMap((run) => run.candidates.map((c) => c.artifact));
```

`createAgentsCodemodeProvider` routes through `dispatchAgentsCall`.
`agentsActionsFor(deps)` governs it and the native schema by the rule above, so a
member exists exactly when the operation does. A program's `agents` uses the
same deps as its actor's native `agents`, where that is wired. A spent mission
budget is the call's value, for the program to branch on. A sandboxed search
cannot resume safely, so use the native tool for durable work.

### No fallback, and one description

Cloudflare requires `LOADER`. The CLI requires `createNodeCodemodeToolFactory`.
Without either, `eval` returns "not configured" instead of falling back to
`new Function()`, which fails in a V8 isolate.

`renderCodemodeDescription(providers, substrate)` (`registry.ts`) composes the
`eval` description for both backends: the registry spec, the substrate, then
each namespace with what it is for and its members' call forms. Full
declarations are left out and read on demand through `describe`. A declaration
whose prose disagrees with its arguments is how an object argument arrives as
`"[object Object]"`.

A program is a Node-style script: statements at the top level, `await`
anywhere, `return` for the result. `packages/cf-backend/tests/workerd/codemode-sandbox.test.ts`
runs it under workerd: `require('fs/promises')` over the workspace, a `private`
`db` table across programs, a crafted tool calling another, a broken crafted row
breaking only its own name, and `fetch` through the egress entrypoint.

## file: operation reference

```
file { op: "read",   path, offset?, limit? } → numbered lines with a footer naming the next offset, or an image
file { op: "list",   path, offset? }         → { path, entries, truncated?: { shown, total, next } }
file { op: "stat",   path }                  → { path, size, mtimeMs, isDir }
file { op: "search", path, query }           → { path, matches: [{ line, text }], truncated?: { shown, total } }
file { op: "edit",   path, edits: [{ old_text, new_text }] }
                                             → { path, reference, checked, applied: [{ line, removedLines, addedLines }], undo?, build? }
file { op: "write",  path, content, encoding? } → { path, reference, checked, bytes, action: "created" | "replaced", undo?, build? }
file.text(path, { encoding? })               → the whole file as a string (programs only); base64: its bytes exactly
```

A failure is a classified refusal naming exactly what was wrong. `search` finds
literal text in one file and returns matching lines with line numbers.
`file_edit` records `not_found`, `ambiguous`, `empty_anchor`, `overlap`,
`no_change`, `unread`, `stale`, `missing`, and `io`. Missing `new_text` is
refused; `""` deletes. `file-edit.ts` is pure string math, and `file-ledger.ts`
holds turn state. The `file-plane` layergate injects faults into exact edits and
clipped reads.

## shell: shell command

`shell` is the Nimbus POSIX shell over the same files as `file` and
`workspace.fs`. It has pipelines, redirects, variables, loops, and the "~95
coreutils" the executor advertises (`packages/core/src/tools/inline-executor.ts`);
that number is the executor's claim, not a count. Live executor status defines
what hosted execution can do. Local execution uses the workspace process.

`runtime` accepts `workspace`, `computer`, or a device by the nickname the live
prompt lists, and defaults to `workspace`. `computer` and each device have
separate files; each device mounts at `/pc/<name>`. `ExecutionRouter` has no
fallback: an absent runtime returns `runtime_not_provisioned`. A relative path
resolves against the directory the command starts in.

Every call is a fresh shell. It starts in `cwd`, else the agent's home (a
container's `/workspace`, a device's `~`), and a `cd` or `export` lasts only
that call; calls run side by side. The answer opens with `cwd: <dir>`, where the
command started. A `name` keeps its directory and exported variables from call
to call: Nimbus's own named shells, keyed by agent, in the workspace; on the
computer, a device and the CLI's host shell, one bash wrapper
(`execution/shell-session.ts`) that restores and saves them in a 0600 file under
`~/.kinu/shells`, `exit 3` included. A name runs one call at a time. One a
detached job holds answers at once, `shell <name> is busy with job <id> since
<time>`, until the command ends. Approval judges a named call from the
directory its last call reported, and a name it has not seen from that saved
state. The CLI's in-process workspace keeps no named shells and refuses a name.

`shell`, `eval`, and resumable `agents` spawns can run in the background.
`detachAfterMs` is 30,000 for interactive turns and 300,000 for one-shot
turns. Detached work has no deadline. Teardown waits `settleGraceMs`: 300,000
interactive, 120,000 one-shot. Approval checks every runtime first: `deny`
refuses; `gate` requires `allow_all`.

## agents swarm: configured search

Swarms are a beta, off for every account until its owner turns on Settings → Beta → "Beta: swarms" (`ProfileCatalog.betaSwarms`, `betaSwarms` in `types/profile.ts`). Off, the `agents` tool's schema and description carry no `swarm` (`agentsActionsFor`), and no account's tool names its catalog's roles or tiers: `role` and `tier` are open strings, the step context lists the choices (`delegationChoices`) and dispatch enforces them. Every such account shares one tool definition, and a `swarm` call is refused `denied`, naming the setting. The Swarms tab and the role editor's "Default swarm preset" are hidden. cf reads the setting from the catalog before it builds a turn's toolset and again after a catalog write, and reads it as it stands before a retry or a re-drive, which no turn read reconciles; the CLI reads it from the catalog its turn resolves against. The eval harness turns it on for the accounts the evals run as (`openPublicSession`).

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
corroborated lessons, confident facts, or a scaffold the owner promoted here
that has since served 10 rated turns with no misevolution veto.

`import` runs the misevolution gate, records vetoes, and stages survivors in
`imported_experience`. Only `EvolutionEngine.reviewTurn` promotes entries on
a turn rated 4 or more, discards them on one rated 2 or lower, and leaves them
waiting on an unrated or neutral one. Imported scaffolds enter `modifyScaffold` as pending. Only
`applyPromotionDecision` writes `scaffoldPath`.

## CraftStore lifecycle

`EvolutionEngine.extractPattern()` extracts patterns. A turn is offered at most
20 crafted tools by preference: how often each was chosen when offered,
weighted by the ratings of the turns that chose it (`craft/preference.ts`). A
raise marks a tool broken, which its declaration says, until a clean return or
a rewrite. Consolidation retires a tool offered 50 turns that no turn chose in
30 days, and skips the pass if it would retire every tool. Offered tools are
called as `tools.<name>(args)`.

## Why eight tools

Eight standing choices matter more than a short description. `skills` stays
reachable through `/skills`. Filesystem work uses `file` or `eval`. Delegation
uses `agents`. No shell command replaces `agents` or the exact-match checks in
`file`.

The native schema was 11,823 description characters, about 2,956 tokens at
chars/4, measured 2026-08-19. `agents` used 4,805 characters, `tasks` 1,704,
and `file` 1,331. That is larger than the earlier surface: on 2026-08-12 the
eight names measured 9,034 chars against 10,201 for the prior ten, and later
docstring work put the eight above both. The count fell; the description did
not. These figures predate the operation catalog; the native schema's size on
the current surface is unmeasured.

The `eval` description lists each namespace's call forms and leaves the full
declarations to `describe`. On `a71c3efaf` (2026-10-17) it rendered 4,527
characters and 95 call forms; its size on the current surface is unmeasured.
Crafted tools keep the top-level total flat.

`tasks` stays separate from `memory`: memory is for later retrieval, tasks hold
the active plan. Folding them together would add `titles`, `parent`, `id`,
`status`, and `role` to every durable-state decision.

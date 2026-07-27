# Proteus Crafted-Tool Architecture — Prior-Art Comparison

> Maintained by Claude (AI-edited documentation, presented as-is); verify against the code when precision matters.

## 0. Background

Three user-visible failures motivate this analysis:

1. **Same-turn invisibility loop.** The LLM calls `workspace.createTool("double", ..., "(n) => n*2")`, which reports `ok: true`, then immediately calls `codemode.double(7)` and gets an empty result (or a `Tool "double" not found` error). The frozen provider snapshot inside `@cloudflare/codemode`'s `createCodeTool` is the root cause; Proteus worked around it with a bespoke `LiveCraftedExecutor` that reimplemented the sandbox module from scratch (`packages/cf-backend/src/crafted-tool-registry.ts:361-388` in the pre-Phase-A commit).
2. **Opaque errors.** Crafted-tool failures surface to the LLM as bare `.message` strings (`packages/cf-backend/src/crafted-tool-registry.ts:217`, `packages/cf-backend/src/craft-executor.ts:165` in the pre-Phase-A commit). No stack, no tool name, no structured payload.
3. **No workspace/codemode cross-scope from inside a crafted tool.** Because each crafted tool ran as its own child Worker with `const fn = (${code})` and no ambient `workspace` / `codemode` bindings, a crafted tool could not call `workspace.readFile`, could not call another crafted tool, and had no standard globals beyond what workerd injects.

A production reference implementation solves (1)–(3) almost for free by adopting a *preamble-injection* pattern on top of upstream codemode's `DynamicWorkerExecutor`. Sections 1–4 below describe that reference design; §5 describes Proteus's pre-refactor state; §6–§9 cover the delta, the phased upgrade, and open questions.

## 1. Reference Execution Harness

The reference implementation defers the sandbox Worker module to upstream `@cloudflare/codemode` and composes `DynamicWorkerExecutor` as-is:

- **Harness construction.** `new DynamicWorkerExecutor({ loader })` — only `loader` is passed. No `globalOutbound`, no `modules`, no `timeout` — it inherits every codemode default (no `fetch`, no `fs`, no `require`, a `Proxy` per provider namespace, console logs captured into `__logs[]`).
- **Signature enforcement.** Crafted code MUST start with `async ( … ) => { … }`. Validated with a chained `.trim()` + `startsWith("async")` + `includes("=>")`. Non-conforming code is rejected at `craft_tool` call time.
- **Injection point.** The LLM's own script is ALSO an `async (...) => { ... }` arrow — that is codemode's sandbox entry shape. The reference implementation splices a `const tools = { ... }` preamble into the head of that arrow:
  - `buildToolsPreamble(craftedTools)` produces the object literal.
  - A regex splice matches the head of the arrow and inserts after the opening brace.
- **Two lexical namespaces inside one sandbox.** Because the preamble is injected *inside* the LLM's arrow, two names are both in scope:
  - `tools.<name>` — a literal fn reference on the object literal. Crafted-to-crafted calls are late-bound on the object; no dispatcher hop.
  - `codemode.<name>` — the upstream codemode `Proxy` that dispatches over RPC to the host `DynamicWorkerExecutor`.
- **Crafted-to-crafted calls.** A crafted tool's body can freely call `tools.other(args)`; the object-literal property lookup happens at call time, so tools can refer to each other by name even if they were authored in arbitrary order.
- **Crafted-to-host calls.** A crafted tool's body can call `codemode.host_tool(args)` because `codemode` is the Proxy bound in the outer arrow's closure — still in lexical scope when the preamble's bodies run.

## 2. Reference Error Propagation

- Errors surface as **bare strings** (`err.message`), NOT a structured `{error, stack, toolName}` envelope. Stream emission and codemode builder rethrow both propagate only the message.
- **Logs DO surface** through a different channel. Codemode's module stubs override `console.log/warn/error` to push into `__logs[]`, and the host reads that array back as `logs` on the `CodemodeResult`. The LLM can thus `console.log` inside a crafted tool and see the output on the next turn.
- No `stack` is sent back. No `toolName` attribution. The reference has chosen "logs for positive signal, short strings for failures".

## 3. Reference Tool Registry

The reference treats the SQL `CraftStore` as the single source of truth — no in-memory mirror.

- **No in-memory mutation cache.** `craft_tool` → `store.create()` → SQL `INSERT`.
- **Same-turn visibility via re-read, not via mutation.** `CraftedToolExecutor.execute` calls `craftStore.getAll()` fresh on every `execute()`. No registry, no subscription — just "query the DB every call".
- **Next-step, not next-arrow.** A newly saved tool is callable in the NEXT codemode invocation — same turn, different step. Within a single `execute_tools` arrow the tool set is frozen (the preamble is built once from that `getAll()` snapshot).
- **LiveToolExecutor parallel.** The MCP path uses the same pattern: `LiveToolExecutor.execute` rebuilds its fns per execute from `getLiveTools()`. Mid-turn MCP tool discovery works the same way.
- **Surfacing.** Crafted tools are ONLY available inside codemode as `tools.<name>`. They are NOT surfaced as top-level AI SDK tools. The LLM is told so by the system prompt.
- **LLM-visible namespace docs.** The `execute_tools` description spells BOTH namespaces explicitly: "workspace tools … as `codemode.toolName(args)`" and "Agent-crafted tools … as `tools.name(args)`".

## 4. Reference LOADER Worker Module

The reference does NOT own a LOADER Worker module at all. `env.LOADER.get(` is never called directly — all LOADER plumbing flows through upstream codemode's `DynamicWorkerExecutor`. The executor module source that runs inside the child Worker is upstream codemode unmodified.

The only platform-owned piece is the string manipulation that produces the LLM's arrow-body-plus-preamble before handing it to `DynamicWorkerExecutor.execute`:

```ts
function buildToolsPreamble(craftedTools: CraftedTool[]): string {
  if (craftedTools.length === 0) return "";
  const entries = craftedTools.map((t) => {
    const code = t.code.trim();
    return `    ${t.name}: ${code}`;
  });
  return `const tools = {\n${entries.join(",\n")}\n  };\n  `;
}
```

```ts
const injected = code.replace(
  /^(\s*async\s*\([^)]*\)\s*=>\s*\{)/,
  `$1\n  ${preamble}`,
);
```

Normalization of stored code is a single `.trim()`. No semicolon stripping, no declaration→expression rewriting, no parenthesization. The stored form is already a legal expression because the `craft_tool` signature gate enforces it.

## 5. Proteus Pre-Phase-A State

Direct reading of the Proteus tree at the commit immediately preceding Phase A (`2641c96`). All paths are relative to the repo root, and describe the tree **as it was then** — several of these files have since moved or been deleted (`craft-executor.ts` on the CF side is gone; `getExecuteToolsTool` now lives in `actor-agent.ts`; `BUILTIN_TOOLS` is 12 names, not 5).

### 5.1 Files observed

- `packages/core/src/tools/builtins.ts` — the canonical 5-tool factory. Crafted tools are materialized as object-shaped entries in a `craftedToolSet` via `buildCraftedToolSetFromExecute` (`:107-150`) and handed to codemode through `deps.createExecuteTool({ tools: craftedToolSet, providers, loader })` (`:197-204`) or bypassed entirely via `deps.preBuiltExecuteTool` (`:195-196`). The CF path takes the `preBuiltExecuteTool` branch.
- `packages/core/src/tools/crafted-executor.ts` — type-only module. Defines `CraftedToolSource`, `CraftedToolExecuteFn`, `CraftedToolExecute` factory type, and a platform-probe helper `codegenDisallowed()`. No runtime behaviour.
- `packages/core/src/tools/registry.ts` — name table. 5 builtin names, 3 session tools. Pre-Phase-A description of `execute_tools` reads: *"Write JS to accomplish tasks. workspace.* for files/shell, codemode.* for learned patterns. Runs in sandboxed Worker."* No `tools.*` namespace mentioned.
- `packages/cf-backend/src/crafted-tool-registry.ts` — at commit `2641c96` this housed BOTH a per-tool child Worker factory (`CraftedToolRegistry`) AND a full reimplementation of `DynamicWorkerExecutor` (`LiveCraftedExecutor`).
- `packages/cf-backend/src/craft-executor.ts` — earlier per-tool LOADER executor (`createCFCraftedExecute`). Unused on the CF path because the orchestrator took the `preBuiltExecuteTool` branch; the child-Worker module source was duplicated almost verbatim between this file and `crafted-tool-registry.ts`.
- `packages/core/src/execution/inline.ts` — the `workspace` provider. Exposes `readFile`, `writeFile`, `readdir`, `exists`, `exec`, `searchMemory`, `saveNote`, `listTools`, `createTool`. The `createTool` execute body called `onToolRegistered` to wake the live registry.
- `packages/cf-backend/src/orchestrator.ts` — the Think subclass. Imported `createCodeTool` from `@cloudflare/codemode/ai` and assembled its own wiring (`getExecuteToolsTool`), passing `LiveCraftedExecutor` into `createCodeTool` as the `executor:` option.
- `packages/cf-backend/src/runtime.ts` — plumbing. Wired `onToolRegistered` from orchestrator hooks into the inline executor. Also constructed an *unrelated* DWE for scaffold-parse-gate use (`createExecutor`) — NOT the one the crafted-tool path used.

### 5.2 `new Function` audit

A repo-wide grep for `new Function` in CF-reachable source returned only doc-comment mentions — no runtime codegen call. That invariant is preserved by Phase A.

### 5.3 Harness ownership — the pre-refactor reimplementation

`LiveCraftedExecutor.execute` built its OWN executor module string and spawned it directly via `this.#loader.get(...)`. The module re-created (from scratch) the exact pieces upstream codemode's DWE provides for free:

- Per-provider `Proxy` over `__dispatchers.<p.name>.call(name, argsJson)`.
- Log capture into `__logs[]` via console rebinding.
- Timeout via `Promise.race` + `setTimeout`.
- Error-to-result envelope.

The reason cited in the header comment was that codemode's DWE sanitizes dispatcher keys (e.g. reserved words like `double` → `double_`), which broke `codemode.double(7)` on the user's repro. The fix was to skip the sanitize pass and keep keys intact — an ~130 LOC workaround that the Phase A preamble pattern obviates entirely.

### 5.4 Signature

Proteus did NOT enforce a signature. `workspace.createTool` accepted arbitrary `code: string` and stored it. The child-Worker wrapper was `const fn = (${code});`. Any expression that parenthesized cleanly was accepted — arrow functions, function expressions, IIFEs, etc.

### 5.5 Same-turn visibility (pre-refactor)

Proteus implemented same-turn visibility via an **in-memory live registry** whose `fns` dict was mutated synchronously by `workspace.createTool`:

- `onToolRegistered` hook on the inline executor.
- CF runtime forwarded the hook to the orchestrator.
- Orchestrator wired it to `this.getCraftRegistry().addOrRefresh(tool)`.
- `CraftedToolRegistry.addOrRefresh` inserted into `this.fns[tool.name]`.
- `LiveCraftedExecutor.execute` spread `{ ...this.#registry.fns }` into the `codemode` provider's fns on every call, so a tool created inside one `execute_tools` call was visible to the NEXT `execute_tools` call in the same turn.

### 5.6 Error format (pre-refactor)

Proteus also returned string-form errors, consistently: bare `err.message` at every layer. No stack, no `toolName`.

### 5.7 In-sandbox cross-namespace access from crafted tool bodies

Crafted code ran inside `const fn = (${code});` in a child Worker. No `workspace`, no `codemode`, no `tools` binding existed in that lexical scope. A crafted tool could not call another crafted tool, could not read a file, could not search memory. Its only capability was computing over the arguments it received.

### 5.8 Surfacing

Crafted tools were surfaced ONLY inside `execute_tools` as `codemode.*`. They were not surfaced as top-level AI SDK tools. This matches the reference implementation.

## 6. Delta Table

| Dimension | Reference impl | Proteus (pre-refactor) | Gap | Fix |
|---|---|---|---|---|
| Sandbox harness ownership | Upstream `DynamicWorkerExecutor({ loader })`, module source from codemode unmodified. | Custom `LiveCraftedExecutor` hand-rolling Proxies, log capture, timeout, error envelope — reimplementing the codemode sandbox module inside Proteus's tree. | ~130 LOC that duplicate upstream and drift on every codemode release. | Delete the hand-rolled executor module. Delegate to `DynamicWorkerExecutor` and inject a `const tools = {...}` preamble instead. |
| Crafted-tool signature enforcement | Hard gate: must start with `async` and include `=>`. | None. `String(code)` accepted as-is, wrapped as `const fn = (${code})`. Any expression flies. | Invalid code is only caught at child-Worker compile time, as a runtime error on first call. | Validate at `workspace.createTool` time; reject with actionable message before write. |
| In-sandbox `workspace.*` access from crafted tool body | Free — `workspace` is a Proxy in the enclosing arrow's lexical scope; crafted code runs inline as `tools.<name>` in the same arrow. | Absent. Crafted code ran in a per-tool child Worker with `const fn = (${code});` only. No `workspace` binding. | Crafted tools could not compose with workspace primitives at all. | Same fix as harness: move crafted tools to preamble inside the main sandbox arrow → `workspace` is lexically in scope. |
| In-sandbox `codemode.*` access from crafted tool body | Free — `codemode` Proxy is also lexically in scope inside the arrow. | Absent for same reason. | Crafted tools could not call host tools. | Same fix; single change unlocks both namespaces. |
| In-sandbox `fetch` / `crypto` / standard globals | Whatever codemode's sandbox grants (no `fetch` by default; `crypto` available as workerd global). | Per-tool child Worker gets workerd defaults with `globalOutbound: null` — no outbound `fetch`. Standard globals (crypto, URL, etc.) present. | Parity on most axes, but less flexible because each tool gets its own Worker, paying cold-start and LOADER cache cost. | After delegating to DWE, globals match the reference exactly. `globalOutbound: null` can be set as a DWE option. |
| Error format | Bare string `err.message` propagated to LLM. | Bare string `err.message` at every layer. | Matches reference. But the project wants structured `{error, stack, toolName}` — neither currently produces this. | Wrap the executor result with a structured envelope on the way back to the tool-output channel. Include `toolName` from the dispatcher, `stack` from `err.stack`. |
| Logs surfaced to LLM | Yes — codemode module rebinds console, returns `logs` on `CodemodeResult`. | Partial. The `LiveCraftedExecutor`-built module captured logs. Per-tool child Worker did NOT. | Logs inside a crafted-tool body were dropped on the floor. | Once crafted tools run as preamble inside the DWE arrow, console rebinding from upstream codemode captures them automatically. |
| Same-turn visibility mechanism | Re-read `craftStore.getAll()` on every `execute()`. SQL is the source of truth. No in-memory mirror. | In-memory `CraftedToolRegistry.fns` dict mutated synchronously by `onToolRegistered`. Registry was re-synced from SQL at each `getTools()` rebuild. | Proteus carried a dual-store (SQL + registry) with cache-coherence rules. Reference has one store. | After Phase A, delete the registry and read `rt.craftStore.list()` at preamble-build time — same pattern. |
| Dual surfacing (top-level AI SDK tools) | No. Only `tools.<name>` inside codemode. | No. Only `codemode.<name>`. Description matched. | Matches reference. | No change (Phase E covers the optional inverse). |
| Normalization of stored code | `.trim()` only. No decl→expr rewrite (signature gate makes it unnecessary). | None. Raw `String(code)` stored. | Pre-refactor relied on `const fn = (${code})` to implicitly parenthesize arbitrary expressions. Function declarations and statement-form code silently failed. | After Phase D's signature gate, `.trim()` is sufficient because only arrow-form code passes. |

## 7. Upgrade Plan — 5 Phases

Where each phase actually landed, verified against the tree:

| Phase | Status |
|---|---|
| A — preamble pattern | **Shipped.** `PreambleCraftedExecutor` in `cf-backend/src/crafted-tool-registry.ts` delegates to upstream `DynamicWorkerExecutor` and splices the preamble; `LiveCraftedExecutor` and `CraftedToolRegistry` survive only in that file's header comment. |
| B — structured error payload | **Shipped**, flat rather than nested (see below). |
| C — helpers inside crafted-tool bodies | **Shipped.** The three namespaces are documented in `tools/registry.ts`. |
| D — signature enforcement + hint | **Partly.** The *description* now says "must be an async arrow", but no check enforces it — `createTool` still validates only argument presence, identifier sanitization, and case collision. The `types` block also still promises SAME-turn callability while the AI-SDK-visible description says next-call. |
| E — dual surfacing | **Not shipped**, as recommended. Crafted tools are still not top-level `ToolSet` entries. |

Note the wiring point moved: what the phases below call
`orchestrator.getExecuteToolsTool()` is now
`ActorAgent.getExecuteToolsTool()` in `cf-backend/src/actor-agent.ts`, shared by
every actor. It also seeds the `codemode` provider with no-op stub executes so
the provider's type declaration lists crafted tools — the real dispatch happens
through the preamble, not that dispatcher.

### Phase A — Adopt the preamble pattern

**Title.** `refactor(crafted): delegate sandbox to DynamicWorkerExecutor with preamble injection`

**Files touched.**
- `packages/cf-backend/src/crafted-tool-registry.ts` — delete `LiveCraftedExecutor` and the reimplemented executor-module source. Keep `CraftedToolRegistry`'s loader plumbing only if still needed for per-tool Worker fallback; otherwise delete the whole file.
- `packages/cf-backend/src/orchestrator.ts` — replace `getExecuteToolsTool()` with a wrapper around upstream `DynamicWorkerExecutor` that injects the preamble from `rt.craftStore.list()` at every execute.
- `packages/core/src/tools/builtins.ts` — `buildCraftedToolSetFromExecute` becomes unused on the CF path once crafted tools move to preamble; keep for CLI-backed `createExecuteTool` or adapt both to the preamble model.

**Before.** The CF path calls `createCodeTool({ tools: [craftedProvider, ...executorProviders], executor: new LiveCraftedExecutor(...) })`. Crafted tools are dispatcher-backed over RPC into per-tool child Workers; `LiveCraftedExecutor` reimplements the sandbox.

**After.** The CF path calls a simple wrapper: upstream `DynamicWorkerExecutor({ loader })`, and a thin `CraftedToolExecutor` that (a) reads `rt.craftStore.list()` on every call, (b) builds the `const tools = {\n  ${name}: ${code.trim()},\n  ...\n};` preamble, (c) splices via `code.replace(/^(\s*async\s*\([^)]*\)\s*=>\s*\{)/, $1\n  ${preamble})`, and (d) hands the injected code to `dwe.execute(injected, providers)`.

**Empirical test.**
- Repro 1: `workspace.createTool("double", "double a number", "async ({n}) => n*2")` then `codemode.double({n:7})` in next step → returns `14`.
- Repro 2: crafted `triple` body `async ({n}) => tools.double({n}) * 1.5` then `codemode.triple({n:4})` → returns `12` (crafted-to-crafted via preamble namespace).
- Repro 3: crafted `readAndReturn` body `async ({path}) => codemode.workspace_readFile(path)` → works because `codemode` proxy is in lexical scope of the spliced arrow.
- `console.log` inside a crafted tool body shows up in the tool-output logs array.

---

### Phase B — Structured error payload

**Title.** `feat(crafted): structured error payloads with stack + toolName`

**Files touched.**
- `packages/cf-backend/src/orchestrator.ts` — wrap the DWE result before handing it to Think's tool-output-available channel. Build `{ error, stack, toolName }` on non-null `error`.
- `packages/core/src/tools/crafted-executor.ts` — extend `CraftedToolSource` type, or add a new `CraftedToolError` type.
- Child-Worker module string (if any remain) — capture `err.stack` and `toolName` alongside `err.message`.

**Before.** Error surfaces as a string: `{ error: "something broke" }` — no stack, no attribution.

**After (as shipped).** The envelope is **flat**, not nested — `StructuredExecutionError` in `crafted-tool-registry.ts` is `{ error: true, message, stack?, toolName?, providerName? }`. The LLM sees the tool name that failed and a truncated stack (first 10 frames). Errors are *returned as values*, not thrown, so a failing crafted tool does not abort the surrounding arrow.

**Empirical test.**
- Create a tool `async () => { throw new Error("boom") }`. Call it. Inspect the tool-output-available payload in the activity log — should contain `error.message === "boom"`, `error.toolName === "boom_tool"`, `error.stack` starting with `Error: boom`.
- Create a tool that re-throws with a chain (`cause`). Verify `cause.message` is preserved.

---

### Phase C — Free ergonomic helpers inside crafted tool bodies

**Title.** `feat(crafted): tools inherit workspace.* and codemode.* scope via preamble`

**Files touched.** None of the core files — this is emergent from Phase A. Only docs and prompts update.
- `packages/core/src/tools/registry.ts` — update `execute_tools` description to call out `tools.*` (the crafted namespace) alongside `workspace.*` and `codemode.*`.
- System prompt — add a sentence: *"Crafted tools are available inside execute_tools as `tools.<name>(args)`. Their bodies may also call `workspace.*` and `codemode.*`."*

**Before.** A crafted tool body runs in a child Worker with no bindings except args. Crafted-to-crafted composition requires the LLM to reimplement logic in each tool.

**After.** Crafted tool bodies compose freely. `tools.helperA` callable from `tools.helperB`; `workspace.readFile` callable from any crafted tool; `codemode.explore` callable from any crafted tool.

**Empirical test.**
- `workspace.createTool("grepFiles", "grep across files", 'async ({query}) => { const files = await workspace.readdir("/src"); return Promise.all(files.map(f => workspace.readFile(f).then(c => c.includes(query) ? f : null))).then(r => r.filter(Boolean)) }')`. Then `codemode.grepFiles({query: "TODO"})` returns a list of files.
- Chain: `tools.a` calls `tools.b` calls `workspace.exec("ls")`. Full chain returns shell output.

---

### Phase D — Signature enforcement + better hint

**Title.** `feat(crafted): enforce async arrow signature + next-turn callability hint`

**Files touched.**
- `packages/core/src/execution/inline.ts` — in `createTool.execute`, after the name-sanitization block, add signature validation: `codeStr.trim().startsWith("async") && codeStr.includes("=>")`. If fails, return `{ ok: false, error: "Crafted tools must be async arrow functions: async (args) => { ... }. Got: <first 60 chars>" }`.
- `packages/core/src/execution/inline.ts` — update the `types` block to reflect the contract. Change `createTool`'s description to document the signature, and update the "same turn" claim to read "callable as `codemode.<name>(args)` in the NEXT step of the same turn".
- `packages/core/src/tools/registry.ts` — add a second sentence to `execute_tools` description.
- System prompt — mirror.

**Before.** Arbitrary code accepted. `const fn = (${code})` silently eats declarations by wrapping them as grouping expressions, failing at first call with a compile error.

**After.** Only valid async arrow functions accepted. Failure surface is immediate and at `createTool`, not later at first `codemode.<name>` call.

**Empirical test.**
- `workspace.createTool("bad", "...", "function x() { return 1 }")` → returns `{ ok: false, error: <signature hint> }`. No row in `crafted_tools`.
- `workspace.createTool("good", "...", "async () => 1")` → `{ ok: true, action: "created" }`.
- Round-trip: `codemode.good()` → `1` on the next step.

---

### Phase E — Dual surfacing (optional, tradeoff-gated)

**Title.** `feat(crafted): optionally expose crafted tools as top-level AI SDK tools`

**Files touched.**
- `packages/core/src/tools/builtins.ts` — loop over `rt.craftStore.list()` and add each as a top-level `ToolSet` entry, driving into the same preamble executor (or a per-tool wrapper that calls the preamble path with a single-tool filter).
- `packages/core/src/tools/registry.ts` — extend `ACTIVE_TOOLS` per-turn from `BUILTIN_TOOLS ∪ {crafted names}` (careful — this grows the request payload).
- Orchestrator cache-key logic — adjust `_craftCacheKey()` to invalidate on crafted-tool name churn.

**Before.** Crafted tools are ONLY available via `execute_tools`. The LLM must write JS to invoke them.

**After.** Crafted tools ALSO appear as direct AI SDK tools, so the LLM can call `double({n: 7})` without going through `execute_tools`.

**Tradeoff (flag at PR).**
- The reference implementation deliberately does NOT do this. Every extra top-level tool bloats the system-message tool schema — 100 crafted tools ≈ +5–20k tokens per request.
- The codemode namespace `codemode.<name>` is already more efficient (one tool schema, N implementations) and composes with other sandbox operations.
- Activating dual surfacing erases the "codemode as the crafted-tool gateway" invariant and forces ongoing name-sanity rules (e.g. avoid collisions with `save_note`, `run`).

**Recommendation.** Defer unless there is explicit user-facing benefit.

**Empirical test.** (if shipped)
- Newly crafted tool shows up in `getTools()` output within one turn boundary.
- Direct call `double({n:7})` from the LLM returns `14` WITHOUT `execute_tools`.
- Token count of a vanilla chat request, with 20 crafted tools, is within a documented budget.

## 8. Recommended ordering

| Phase | Priority | Rationale |
|---|---|---|
| A — Preamble pattern | **Must do.** | Deletes ~130 LOC of reimplemented sandbox, eliminates drift-on-every-codemode-release, eliminates the reserved-word bug class by construction (no dispatcher-key sanitize pass to bypass), unlocks Phase C automatically. |
| B — Structured errors | **Must do.** | Bare strings are the #2 user-visible pain. `toolName` attribution is table stakes for multi-tool sandboxes. Independent of A; could ship in either order, but ordering A first lets B hook the cleaner DWE result. |
| C — Free ergonomic helpers | **Must do — but free.** | Emergent from A. Only docs/prompt work. Ship immediately after A so the LLM knows the new capability exists (otherwise agents won't discover it). |
| D — Signature enforcement | **Nice-to-have, do soon.** | Prevents a silent-fail class (stored code that never parses as an expression). Only ~30 LOC; cheap to include alongside A/B/C. |
| E — Dual surfacing | **Defer.** | Explicit tradeoff; reference passes. No current Proteus pain report identifies this as the blocker. Revisit if crafted-tool-discovery inside `execute_tools` proves to be a bottleneck (e.g. model cannot figure out to use `codemode.*` even after prompt changes). |

**Suggested commit order.** A → C (doc-only, piggyback on A's PR) → D → B → (Phase E if/when needed).

## 9. Open questions

1. **Do we keep `globalOutbound: null`?** The pre-refactor Proteus pinned `globalOutbound: null` at both the per-tool Worker and the live executor. Delegating to DWE means picking the codemode default (no outbound `fetch`) or overriding. **Decision needed:** should crafted tools ever `fetch(...)`? If so, what is the allow-list policy?
2. **Live-dispatch vs static preamble for same-arrow visibility.** The reference preamble is built once per `execute_tools` call and is frozen for that arrow. The pre-refactor `LiveCraftedExecutor` re-read the registry *inside* the execute path, so in theory a tool created by `workspace.createTool` earlier in the SAME arrow was dispatchable. Is that capability worth keeping, or do we accept "next-step, not next-arrow"? (Recommendation: accept the contract — same-arrow dispatch is a rare pattern and the architectural cost is high.)
3. **Top-level surfacing (Phase E).** Under what conditions would we want crafted tools as direct AI SDK tools? Is there a specific agent-side failure mode (e.g. "LLM forgets `codemode.*` prefix") that would motivate it, and is that failure mode more cheaply fixed by prompt engineering?
4. ~~**Error payload format.**~~ **Answered: flat.** Phase B shipped `{ error: true, message, stack?, toolName?, providerName? }` — the flat form, because it survives the Vercel AI SDK's `tool-output-available` JSON-stringification in activity logs intact.

# Proteus Crafted-Tool Architecture — Prior-Art Comparison

> Maintained by Claude (AI-edited documentation, presented as-is); verify against the code when precision matters.

## 0. Background

Three user-visible failures motivated this analysis. All three are described as
they stood at commit `2641c96`, the commit immediately before Phase A.

1. **Same-turn invisibility loop.** The LLM called `workspace.createTool("double", ..., "(n) => n*2")`, which reported `ok: true`, then immediately called `codemode.double(7)` and got an empty result (or a `Tool "double" not found` error). The frozen provider snapshot inside `@cloudflare/codemode`'s `createCodeTool` was the root cause; Proteus worked around it with a bespoke `LiveCraftedExecutor` in `packages/cf-backend/src/crafted-tool-registry.ts` that reimplemented the sandbox module from scratch.
2. **Opaque errors.** Crafted-tool failures reached the LLM as bare `.message` strings, from `crafted-tool-registry.ts` and from the CF-side `craft-executor.ts` that commit still carried. No stack, no tool name, no structured payload.
3. **No workspace/codemode cross-scope from inside a crafted tool.** Each crafted tool ran as its own child Worker with `const fn = (${code})` and no ambient `workspace` / `codemode` bindings, so a crafted tool could not call `workspace.readFile`, could not call another crafted tool, and had no standard globals beyond what workerd injects.

**Both backends craft tools, by different mechanisms.** On Cloudflare,
`PreambleCraftedExecutor` (`cf-backend/src/crafted-tool-registry.ts`) wraps
upstream codemode's `DynamicWorkerExecutor` and splices stored bodies into the
sandbox arrow. On the CLI, `createNodeCraftedExecute`
(`cli-backend/src/craft-executor.ts`) compiles each stored body in-process with
`new Function`, because V8 on Node and Bun permits codegen from strings. The CF
file named in failure (2) above is gone; the only `craft-executor.ts` left in
the tree is the CLI's.

A production reference implementation solves (1)–(3) almost for free by adopting
a *preamble-injection* pattern on top of upstream codemode's
`DynamicWorkerExecutor`. Sections 1–4 describe that reference design; §5
describes Proteus's pre-refactor state; §6–§9 cover the delta, the phased
upgrade and what remains open.

## 1. Reference Execution Harness

The reference implementation defers the sandbox Worker module to upstream `@cloudflare/codemode` and composes `DynamicWorkerExecutor` as-is:

- **Harness construction.** `new DynamicWorkerExecutor({ loader })`, and only `loader` is passed. With no `globalOutbound`, no `modules` and no `timeout`, it inherits every codemode default (no `fetch`, no `fs`, no `require`, a `Proxy` per provider namespace, console logs captured into `__logs[]`).
- **Signature enforcement.** Crafted code MUST start with `async ( … ) => { … }`. Validated with a chained `.trim()` + `startsWith("async")` + `includes("=>")`. Non-conforming code is rejected at `craft_tool` call time.
- **Injection point.** The LLM's own script is ALSO an `async (...) => { ... }` arrow, which is codemode's sandbox entry shape. The reference implementation splices a `const tools = { ... }` preamble into the head of that arrow:
  - `buildToolsPreamble(craftedTools)` produces the object literal.
  - A regex splice matches the head of the arrow and inserts after the opening brace.
- **Two lexical namespaces inside one sandbox.** Because the preamble is injected *inside* the LLM's arrow, two names are both in scope:
  - `tools.<name>`: a literal fn reference on the object literal. Crafted-to-crafted calls are late-bound on the object; no dispatcher hop.
  - `codemode.<name>`: the upstream codemode `Proxy` that dispatches over RPC to the host `DynamicWorkerExecutor`.
- **Crafted-to-crafted calls.** A crafted tool's body can freely call `tools.other(args)`; the object-literal property lookup happens at call time, so tools can refer to each other by name even if they were authored in arbitrary order.
- **Crafted-to-host calls.** A crafted tool's body can call `codemode.host_tool(args)` because `codemode` is the Proxy bound in the outer arrow's closure, which is still in lexical scope when the preamble's bodies run.

## 2. Reference Error Propagation

- Errors surface as **bare strings** (`err.message`), not a structured `{error, stack, toolName}` envelope. Stream emission and codemode builder rethrow both propagate only the message.
- **Logs DO surface** through a different channel. Codemode's module stubs override `console.log/warn/error` to push into `__logs[]`, and the host reads that array back as `logs` on the `CodemodeResult`. The LLM can thus `console.log` inside a crafted tool and see the output on the next turn.
- No `stack` is sent back. No `toolName` attribution. The reference has chosen "logs for positive signal, short strings for failures".

## 3. Reference Tool Registry

The reference treats the SQL `CraftStore` as the single source of truth, with no in-memory mirror. Proteus adopted the pattern and both of its backends now follow it.

- **No in-memory mutation cache.** `craft_tool` → `store.create()` → SQL `INSERT`.
- **Same-turn visibility via re-read, not via mutation.** The executor calls `craftStore.list()` fresh on every `execute()`. There is no registry and no subscription, just a query per call. On CF that read is `selectInjectableCraftedTools`, which also applies `filterByEffectiveScore`. That is the same EMA cutoff core's tool builder applies, so the advertised set and the callable set cannot disagree.
- **Next-step, not next-arrow.** A newly saved tool is callable in the NEXT codemode invocation, in the same turn but a later step. Within a single `execute_tools` arrow the tool set is frozen, because the preamble is built once from that read. On both backends `createExecuteTool` takes a `craftedTools()` resolver rather than a snapshot, and the CLI binds that record under both `codemode` and `tools`. On CF only `tools.<name>` is callable, because the body lives in the preamble rather than in the dispatcher. `codemode.<name>` is still reachable there, so `craftedDispatcherEntry` (`cf-backend/src/execute-tools.ts`) makes it THROW and name the form that works, rather than return an error object the model would read as a result.
- **A crafted tool's failure names itself.** Both paths wrap the body so a throw leaves the sandbox stamped `[crafted:<name>] <message>` (`craftFailureMarker`, `core/src/craft/in-episode.ts`). See docs/EVOLUTION.md, "In-Episode Evolution".
- **MCP tools follow the same re-read rule by a different route.** `buildUserMcpTools` (`cf-backend/src/actor-agent.ts`) rebuilds the whole MCP `ToolSet` whenever the user's server watermark changes, so a mid-turn connection lands. Those tools are top-level AI SDK entries rather than a codemode namespace, clamped through the same turn budget (`withClampedToolResults`, producer `external_tool`).
- **Surfacing.** Crafted tools are ONLY available inside codemode as `tools.<name>`. They are NOT surfaced as top-level AI SDK tools; `BUILTIN_TOOLS` is a fixed list of eight names. The LLM is told so by the system prompt.
- **LLM-visible namespace docs.** The `execute_tools` summary names the namespaces: "Run JavaScript against active executor namespaces, codemode.\* providers, tools.\<name\> crafted tools, and agent helpers." The full contract for all of them is the `Namespace contract` comment above `BUILTIN_TOOL_SPECS` in `core/src/tools/registry.ts`.

## 4. Reference LOADER Worker Module

The reference does NOT own a LOADER Worker module at all. `env.LOADER.get(` is never called directly. All LOADER plumbing flows through upstream codemode's `DynamicWorkerExecutor`. The executor module source that runs inside the child Worker is upstream codemode unmodified.

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

**Proteus's shipped version diverges from both snippets above, and the divergence is the point of each change.**

- `buildToolsPreamble` wraps every body in an IIFE that re-throws with `craftFailureMarker(name)` prefixed, so a failure names the tool that raised it and the in-episode fitness signal can score the right artifact. The body sits alone between parentheses on its own lines, because a model-authored body ending in a `//` comment would otherwise swallow the rest of the wrapper and turn the whole preamble into a syntax error.
- `injectPreamble` does not splice. It normalizes with codemode's own `normalizeCode` and then WRAPS: `async () => { <preamble>return await (<normalized>)(); }`. The regex splice silently dropped the preamble whenever the model's code was not already an `async (…) => {` arrow, which is exactly what `BUILTIN_TOOL_SPECS.execute_tools.example` teaches and what `normalizeCode` wraps for you. On every such call the whole crafted-tool surface was undefined with no error naming why.

Both functions live in `cf-backend/src/crafted-tool-registry.ts` and are exported, so their behaviour is testable without a sandbox.

## 5. Proteus Pre-Phase-A State

Direct reading of the Proteus tree at the commit immediately preceding Phase A (`2641c96`). Paths are relative to the repo root and describe the tree **as it was then**; the notes say where each one went.

### 5.1 Files observed

- `packages/core/src/tools/builtins.ts`: the canonical 5-tool factory, now eight. Crafted tools were materialized as object-shaped entries in a `craftedToolSet` via `buildCraftedToolSetFromExecute` and handed to codemode through `deps.createExecuteTool`, or bypassed entirely via `deps.preBuiltExecuteTool`. The CF path took the `preBuiltExecuteTool` branch, and still does.
- `packages/core/src/tools/crafted-executor.ts`: the platform contract both adapters satisfy. It declares `CraftedToolSource`, `CraftedToolExecuteFn` and the `CraftedToolExecute` factory type, plus one small runtime helper, `toCraftedToolSource`, which drops null and comment-only bodies so no executor has to special-case them. Unchanged by the refactor.
- `packages/core/src/tools/registry.ts`: name table. 5 builtin names, 3 session tools. The pre-Phase-A `execute_tools` description read: *"Write JS to accomplish tasks. workspace.\* for files/shell, codemode.\* for learned patterns. Runs in sandboxed Worker."* No `tools.*` namespace mentioned.
- `packages/cf-backend/src/crafted-tool-registry.ts` housed BOTH a per-tool child Worker factory (`CraftedToolRegistry`) AND a full reimplementation of `DynamicWorkerExecutor` (`LiveCraftedExecutor`). Both are deleted; the file now holds `PreambleCraftedExecutor`.
- `packages/cf-backend/src/craft-executor.ts`: an earlier per-tool LOADER executor (`createCFCraftedExecute`). Unused on the CF path because the orchestrator took the `preBuiltExecuteTool` branch, and its child-Worker module source was duplicated almost verbatim from `crafted-tool-registry.ts`. **Deleted.** The surviving `craft-executor.ts` is the CLI's, at `packages/cli-backend/src/craft-executor.ts`, and it is a different thing: an in-process `new Function` compiler with no Worker and no LOADER.
- `packages/core/src/execution/inline.ts`: the `workspace` provider. Exposes `readFile`, `writeFile`, `readdir`, `exists`, `exec`, `searchMemory`, `saveNote`, `listTools`, `createTool` and the view calls. The `createTool` execute body called `onToolRegistered` to wake the live registry; the hook survives as optional eager notification that CF leaves unused.
- `packages/cf-backend/src/orchestrator.ts`: the Think subclass. Imported `createCodeTool` from `@cloudflare/codemode/ai` and assembled its own wiring, passing `LiveCraftedExecutor` into `createCodeTool` as the `executor:` option. That assembly is now `createExecuteToolsTool` in `cf-backend/src/execute-tools.ts`.
- `packages/cf-backend/src/runtime.ts`: plumbing. Wired `onToolRegistered` from orchestrator hooks into the inline executor. Also constructed an *unrelated* `DynamicWorkerExecutor` for scaffold-parse-gate use, which was never the one the crafted-tool path used.

### 5.2 `new Function` audit

A repo-wide grep for `new Function` on CF-reachable source returned only doc-comment mentions, and it still does. The invariant Phase A preserves is that no CF path calls it. The calls in the tree are local-only: `cli-backend/src/craft-executor.ts` compiles crafted bodies, and `core/src/identity/inline-primitives.ts`'s `createInlineExecutor` runs JavaScript for a local workspace. One more site passes the words `new Function` as a STRING into `rt.executor.execute`. That is `core/src/scaffold/modify.ts`'s parse gate, so the codegen happens inside whatever sandbox that runtime owns rather than in the host.

### 5.3 Harness ownership (pre-refactor reimplementation)

`LiveCraftedExecutor.execute` built its OWN executor module string and spawned it directly via `this.#loader.get(...)`. The module re-created, from scratch, the exact pieces upstream codemode's DWE provides for free:

- Per-provider `Proxy` over `__dispatchers.<p.name>.call(name, argsJson)`.
- Log capture into `__logs[]` via console rebinding.
- Timeout via `Promise.race` + `setTimeout`.
- Error-to-result envelope.

The reason cited in the header comment was that codemode's DWE sanitizes dispatcher keys (reserved words like `double` become `double_`), which broke `codemode.double(7)` on the user's repro. The fix was to skip the sanitize pass and keep keys intact, a workaround the original pre-Phase-A reading put at roughly 130 lines. That line count has not been re-counted since the code was deleted. The Phase A preamble pattern obviates the whole of it.

### 5.4 Signature

Proteus did NOT enforce a signature. `workspace.createTool` accepted arbitrary `code: string` and stored it. The child-Worker wrapper was `const fn = (${code});`, so any expression that parenthesized cleanly was accepted: arrow functions, function expressions, IIFEs.

### 5.5 Same-turn visibility (pre-refactor)

Proteus implemented same-turn visibility via an **in-memory live registry** whose `fns` dict was mutated synchronously by `workspace.createTool`:

- `onToolRegistered` hook on the inline executor.
- CF runtime forwarded the hook to the orchestrator.
- Orchestrator wired it to `this.getCraftRegistry().addOrRefresh(tool)`.
- `CraftedToolRegistry.addOrRefresh` inserted into `this.fns[tool.name]`.
- `LiveCraftedExecutor.execute` spread `{ ...this.#registry.fns }` into the `codemode` provider's fns on every call, so a tool created inside one `execute_tools` call was visible to the NEXT `execute_tools` call in the same turn.

All five links are gone. `PreambleCraftedExecutor` reads `craftStore.list()` at every execute, which is what removes the registry and its cache-coherence rules.

### 5.6 Error format (pre-refactor)

Proteus also returned string-form errors, consistently: bare `err.message` at every layer. No stack, no `toolName`. Phase B replaced this on the CF path with the flat envelope in §7.

### 5.7 In-sandbox cross-namespace access from crafted tool bodies

Crafted code ran inside `const fn = (${code});` in a child Worker. No `workspace`, no `codemode`, no `tools` binding existed in that lexical scope. A crafted tool could not call another crafted tool, could not read a file, could not search memory. Its only capability was computing over the arguments it received.

### 5.8 Surfacing

Crafted tools were surfaced ONLY inside `execute_tools` as `codemode.*`. They were not surfaced as top-level AI SDK tools. That matches the reference implementation and has not changed.

## 6. Delta Table

| Dimension | Reference impl | Proteus (pre-refactor) | Gap | Fix |
|---|---|---|---|---|
| Sandbox harness ownership | Upstream `DynamicWorkerExecutor({ loader })`, module source from codemode unmodified. | Custom `LiveCraftedExecutor` hand-rolling Proxies, log capture, timeout, error envelope. It reimplemented the codemode sandbox module inside Proteus's tree. | ~130 LOC that duplicate upstream and drift on every codemode release. | Delete the hand-rolled executor module. Delegate to `DynamicWorkerExecutor` and inject a `const tools = {...}` preamble instead. |
| Crafted-tool signature enforcement | Hard gate: must start with `async` and include `=>`. | None. `String(code)` accepted as-is, wrapped as `const fn = (${code})`. Any expression flies. | Invalid code is only caught at child-Worker compile time, as a runtime error on first call. | Validate at `workspace.createTool` time; reject with an actionable message before the write. |
| In-sandbox `workspace.*` access from crafted tool body | Free, because `workspace` is a Proxy in the enclosing arrow's lexical scope and crafted code runs inline as `tools.<name>` in the same arrow. | Absent. Crafted code ran in a per-tool child Worker with `const fn = (${code});` only. No `workspace` binding. | Crafted tools could not compose with workspace primitives at all. | Same fix as harness: move crafted tools to the preamble inside the main sandbox arrow, so `workspace` is lexically in scope. |
| In-sandbox `codemode.*` access from crafted tool body | Free, because the `codemode` Proxy is also lexically in scope inside the arrow. | Absent for the same reason. | Crafted tools could not call host tools. | Same fix; one change unlocks both namespaces. |
| In-sandbox `fetch` / `crypto` / standard globals | Whatever codemode's sandbox grants (no `fetch` by default; `crypto` available as a workerd global). | Per-tool child Worker got workerd defaults with `globalOutbound: null`, so no outbound `fetch`. Standard globals (crypto, URL) present. | Parity on most axes, but less flexible: each tool got its own Worker, paying cold-start and LOADER cache cost. | After delegating to DWE, globals match the reference exactly. `globalOutbound: null` can be set as a DWE option. |
| Error format | Bare string `err.message` propagated to the LLM. | Bare string `err.message` at every layer. | Matches the reference, but the project wants structured `{error, stack, toolName}` and neither produces it. | Wrap the executor result with a structured envelope on the way back to the tool-output channel. Include `toolName` from the dispatcher and `stack` from `err.stack`. |
| Logs surfaced to LLM | Yes. The codemode module rebinds console and returns `logs` on `CodemodeResult`. | Partial. The `LiveCraftedExecutor`-built module captured logs; the per-tool child Worker did not. | Logs inside a crafted-tool body were dropped on the floor. | Once crafted tools run as preamble inside the DWE arrow, upstream console rebinding captures them automatically. |
| Same-turn visibility mechanism | Re-read `craftStore.getAll()` on every `execute()`. SQL is the source of truth. No in-memory mirror. | In-memory `CraftedToolRegistry.fns` dict mutated synchronously by `onToolRegistered`, re-synced from SQL at each `getTools()` rebuild. | Proteus carried a dual store (SQL + registry) with cache-coherence rules. The reference has one store. | After Phase A, delete the registry and read the craft store at preamble-build time, which is the same pattern. |
| Dual surfacing (top-level AI SDK tools) | No. Only `tools.<name>` inside codemode. | No. Only `codemode.<name>`. Description matched. | Matches the reference. | No change (Phase E covers the optional inverse). |
| Normalization of stored code | `.trim()` only. No decl→expr rewrite, because the signature gate makes it unnecessary. | None. Raw `String(code)` stored. | Pre-refactor relied on `const fn = (${code})` to implicitly parenthesize arbitrary expressions, so function declarations and statement-form code silently failed. | After Phase D's signature gate, `.trim()` is sufficient because only arrow-form code passes. |

## 7. Upgrade Plan in 5 Phases

Where each phase actually landed, verified against the tree:

| Phase | Status |
|---|---|
| A: preamble pattern | **Shipped.** `PreambleCraftedExecutor` in `cf-backend/src/crafted-tool-registry.ts` delegates to upstream `DynamicWorkerExecutor` and injects the preamble; `LiveCraftedExecutor` and `CraftedToolRegistry` survive only in that file's header comment. |
| B: structured error payload | **Shipped**, flat rather than nested (see below). |
| C: helpers inside crafted-tool bodies | **Shipped.** The namespaces are documented in the `Namespace contract` comment in `tools/registry.ts`. |
| D: signature enforcement + hint | **The hint shipped, the check did not.** `createTool`'s docstring now names `tools.<name>(args)` on the next `execute_tools` call and names `codemode.<name>` as refused, so it agrees with the AI-SDK-visible description and with the hosted dispatcher. No check enforces the async-arrow shape: `createTool` validates argument presence, identifier sanitization, case collision and the misevolution gate, not the signature. |
| E: dual surfacing | **Not shipped**, as recommended. Crafted tools are still not top-level `ToolSet` entries. |

Two wiring points moved. What the phases below call
`orchestrator.getExecuteToolsTool()` is now `ActorAgent.getExecuteToolsTool()`
in `cf-backend/src/actor-agent.ts`, shared by every actor and memoized per
work-mode and tool profile. The construction it calls is
`createExecuteToolsTool` in `cf-backend/src/execute-tools.ts`, which seeds the
`codemode` provider with one entry per injectable crafted tool so the provider's
type declaration lists them. Those seeded entries throw when called; real
dispatch happens through the preamble.

### Phase A: Adopt the preamble pattern

**Title.** `refactor(crafted): delegate sandbox to DynamicWorkerExecutor with preamble injection`

**Where it landed.**
- `packages/cf-backend/src/crafted-tool-registry.ts`: `LiveCraftedExecutor`, `CraftedToolRegistry` and the reimplemented executor-module source are deleted. The file is now `selectInjectableCraftedTools`, `buildToolsPreamble`, `injectPreamble`, the structured-error wrapper, and `PreambleCraftedExecutor`.
- `packages/cf-backend/src/execute-tools.ts`: `createExecuteToolsTool` owns the whole `createCodeTool` assembly, including the provider order that fixes the LLM-visible type description.
- `packages/core/src/tools/builtins.ts`: `buildCraftedToolSetFromExecute` still serves the CLI's `createExecuteTool` factory; CF continues to bypass it through `preBuiltExecuteTool`.

**Before.** The CF path called `createCodeTool({ tools: [craftedProvider, ...executorProviders], executor: new LiveCraftedExecutor(...) })`. Crafted tools were dispatcher-backed over RPC into per-tool child Workers, and `LiveCraftedExecutor` reimplemented the sandbox.

**After.** `PreambleCraftedExecutor` holds one upstream `DynamicWorkerExecutor({ loader })` for the DO's lifetime. On every `execute` it (a) reads the craft store and applies the effective-score filter, (b) builds the marker-wrapped `const tools = {…}` preamble, (c) normalizes the model's code and wraps it so the preamble is always in lexical scope, (d) wraps each provider's fns with structured-error capture, and (e) delegates to the inner executor.

**Empirical test.**
- Repro 1: `workspace.createTool("double", "double a number", "async ({n}) => n*2")` then `tools.double({n:7})` in the next step → returns `14`.
- Repro 2: crafted `triple` body `async ({n}) => tools.double({n}) * 1.5` then `tools.triple({n:4})` → returns `12` (crafted-to-crafted through the preamble namespace).
- Repro 3: crafted `readAndReturn` body `async ({path}) => workspace.readFile(path)` → works because the provider namespaces are `const`-declared in the scope enclosing the wrapped arrow.
- `console.log` inside a crafted tool body shows up in the tool-output logs array.

---

### Phase B: Structured error payload

**Title.** `feat(crafted): structured error payloads with stack + toolName`

**Where it landed.**
- `packages/cf-backend/src/crafted-tool-registry.ts`: `StructuredExecutionError` and the `wrapProvidersWithStructuredErrors` pass over every resolved provider.
- `packages/core/src/tools/crafted-executor.ts`: unchanged; the envelope is a CF-side value, not a core type.

**Before.** An error surfaced as a string, `{ error: "something broke" }`, with no stack and no attribution.

**After (as shipped).** The envelope is **flat**, not nested: `{ error: true, message, stack?, toolName?, providerName? }`. The LLM sees which tool failed and a truncated stack (first 10 frames). Errors are *returned as values* rather than thrown, so a failing crafted tool does not abort the surrounding arrow, and codemode's dispatcher reports the call as having returned. An executor-level failure (sandbox spawn, timeout) behaves differently. It comes back as a non-empty `error` string, which `createCodeTool` turns into a thrown AI SDK error.

**Empirical test.**
- Create a tool `async () => { throw new Error("boom") }`. Call it. The tool-output-available payload carries `message` containing `boom`, `toolName`, and a `stack` starting with `Error: boom`.
- Create a tool that re-throws with a `cause` chain. Verify the cause's message survives, which is what `renderThrownChain` is for.

---

### Phase C: Free ergonomic helpers inside crafted tool bodies

**Title.** `feat(crafted): tools inherit workspace.* and codemode.* scope via preamble`

**Where it landed.** No executor change; this is emergent from Phase A. Only the descriptions moved.
- `packages/core/src/tools/registry.ts`: the `Namespace contract` comment above `BUILTIN_TOOL_SPECS` states all of `workspace.*`, `codemode.*`, `tools.<name>`, the projected native namespaces, and `release.*`.
- `packages/core/src/execution/inline.ts`: `createTool`'s own description now tells the model that a crafted body may call `workspace.*`, `codemode.*`, and `tools.<name>`.

**Before.** A crafted tool body ran in a child Worker with no bindings except its arguments. Crafted-to-crafted composition required the LLM to reimplement logic in each tool.

**After.** Crafted tool bodies compose freely. `tools.helperA` is callable from `tools.helperB`; `workspace.readFile` is callable from any crafted tool; so is any other codemode namespace the actor has wired.

**Empirical test.**
- `workspace.createTool("grepFiles", "grep across files", 'async ({query}) => { const files = await workspace.readdir("/src"); return Promise.all(files.map(f => workspace.readFile(f).then(c => c.includes(query) ? f : null))).then(r => r.filter(Boolean)) }')`. Then `tools.grepFiles({query: "TODO"})` returns a list of files.
- Chain: `tools.a` calls `tools.b` calls `workspace.exec("ls")`. The full chain returns shell output.

---

### Phase D: Signature enforcement + better hint

**Title.** `feat(crafted): enforce async arrow signature + next-turn callability hint`

**Still to do.**
- `packages/core/src/execution/inline.ts`: in `createTool.execute`, after the name-sanitization block, add signature validation: `codeStr.trim().startsWith("async") && codeStr.includes("=>")`. On failure return `{ ok: false, error: "Crafted tools must be async arrow functions: async (args) => { ... }. Got: <first 60 chars>" }`.

**Fixed since.** The `types` block used to promise same-turn callability under `codemode.<name>`, contradicting the AI-SDK-visible description forty lines above it in the same file and contradicting the hosted dispatcher, which throws on that spelling. `createTool`'s docstring now reads: callable as `tools.<name>(args)` on the NEXT `execute_tools` call in this turn, because the sandbox that created the tool is already built, and `codemode.<name>` is named as refused rather than offered (`core/src/execution/inline.ts:482-488`). Read it from source; a verbatim quote here would rot the next time it changes.

**Before.** Arbitrary code is accepted. `const fn = (${code})` silently ate declarations by wrapping them as grouping expressions, failing at first call with a compile error. On the CLI path the equivalent failure is a `new Function` throw inside `createNodeCraftedExecute`.

**After.** Only valid async arrow functions are accepted. The failure surface is immediate, at `createTool`, rather than later at the first call.

**Empirical test.**
- `workspace.createTool("bad", "...", "function x() { return 1 }")` → returns `{ ok: false, error: <signature hint> }`. No row in `crafted_tools`.
- `workspace.createTool("good", "...", "async () => 1")` → `{ ok: true, name: "good", action: "created" }`.
- Round-trip: `tools.good()` → `1` on the next step.

---

### Phase E: Dual surfacing (optional, tradeoff-gated)

**Title.** `feat(crafted): optionally expose crafted tools as top-level AI SDK tools`

**Files it would touch.**
- `packages/core/src/tools/builtins.ts`: loop over the craft store and add each tool as a top-level `ToolSet` entry, driving into the same preamble executor.
- `packages/core/src/tools/registry.ts`: extend `ACTIVE_TOOLS` per turn from `BUILTIN_TOOLS ∪ {crafted names}`. This grows the request payload.
- The per-actor `execute_tools` cache key in `ActorAgent`, so a crafted-tool name change invalidates it.

**Before.** Crafted tools are ONLY available via `execute_tools`. The LLM must write JS to invoke them.

**After.** Crafted tools ALSO appear as direct AI SDK tools, so the LLM can call `double({n: 7})` without `execute_tools`.

**Tradeoff.**
- The reference implementation deliberately does not do this. Every extra top-level tool grows the system-message tool schema; 100 crafted tools is roughly +5–20k tokens per request. That range is an estimate, not a measurement.
- `codemode.<name>` is already cheaper (one tool schema, N implementations) and composes with other sandbox operations.
- Dual surfacing erases the "codemode as the crafted-tool gateway" invariant and forces ongoing name-collision rules against the builtin names.

**Recommendation.** Defer unless there is explicit user-facing benefit.

**Empirical test.** (if shipped)
- A newly crafted tool shows up in `getTools()` output within one turn boundary.
- A direct call `double({n:7})` returns `14` without `execute_tools`.
- The token count of a vanilla chat request with 20 crafted tools stays inside a documented budget.

## 8. Ordering, in retrospect

A was first because it deletes the ~130 LOC of reimplemented sandbox, ends the drift-on-every-codemode-release, removes the reserved-word bug class by construction (there is no dispatcher-key sanitize pass left to bypass), and unlocks C for free. C shipped with it, as documentation only, because a capability the model is not told about is not a capability. B followed, hooking the cleaner DWE result. D is the remainder. It prevents a silent-fail class for roughly 30 LOC, and its two halves are cheap and independent. E stays deferred.

## 9. Open questions

1. **Outbound `fetch` from a crafted tool.** The pre-refactor code pinned `globalOutbound: null` at both the per-tool Worker and the live executor. `PreambleCraftedExecutor` constructs `new DynamicWorkerExecutor({ loader })` and nothing else, so it takes codemode's default of no outbound `fetch`. **Decision needed:** whether crafted tools may `fetch(...)` at all, and under what allow-list.
2. ~~**Live-dispatch vs static preamble for same-arrow visibility.**~~ **Answered: static preamble.** The preamble is built once per `execute_tools` call and frozen for that arrow, so the contract is next-step rather than next-arrow. Same-arrow dispatch is a rare pattern and the architectural cost was high.
3. **Top-level surfacing (Phase E).** **Decision needed:** name the agent-side failure mode that would justify surfacing crafted tools as direct AI SDK tools, and rule out fixing that failure mode in the prompt first. No such failure mode is on record today.
4. ~~**Error payload format.**~~ **Answered: flat.** Phase B shipped `{ error: true, message, stack?, toolName?, providerName? }`, because the flat form survives the Vercel AI SDK's `tool-output-available` JSON-stringification in activity logs intact.

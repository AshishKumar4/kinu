# Crafted-Tool Architecture

A crafted tool is a model-authored async arrow function, stored in `crafted_tools` and callable from inside the `execute_tools` sandbox. This page covers how the sandbox loads one, how failures come back, and what the model must write to call one. The experience library carries a crafted tool between workspaces, and therefore between backends, so `core/src/tools/sandbox-contract.ts` is the call shape's single source.

## 1. The two sandboxes

Both backends craft tools on different platforms behind the same call surface.

- **Cloudflare.** `KinuSandboxExecutor` (`cf-backend/src/codemode-sandbox.ts`) holds one upstream `DynamicWorkerExecutor` for the Durable Object's lifetime and adds three things to it: the `kinu-node.js` module (`codemode-node-shim.ts`) loaded beside the program, a prelude on the `tools` namespace that defines `require`, `fetch`, `env` and every crafted tool, and `globalOutbound` set to the Worker's own loopback entrypoint (`CodemodeEgress`), so `fetch()` inside the sandbox reaches the network. Console logs are captured for the host.
- **CLI.** `createNodeCraftedExecute` (`cli-backend/src/craft-executor.ts`) compiles each stored body in-process with `new Function`. No child Worker, no loader.

No Cloudflare path calls `new Function`. Four host call sites exist, all local: `cli-backend/src/craft-executor.ts:48` compiles a crafted body, `cli-backend/src/execute-tools-factory.ts:151` compiles the model's own `execute_tools` code, `cli-backend/src/executor.ts:241` runs a local JavaScript command, and `createInlineExecutor` (`core/src/identity/inline-primitives.ts:169`) serves a local workspace. One more site passes the words as a string into `rt.executor.execute` (`core/src/scaffold/modify.ts:66`, the parse gate), so that codegen happens inside whatever sandbox the runtime owns.

## 2. Error propagation

A crafted tool that throws rejects with `[crafted:<name>] <message>` (`defineCrafted` in `cf-backend/src/codemode-node-shim.ts`), so the program's own `try`/`catch` sees it and the in-episode fitness can blame the right artifact (`craftFailureMarker`, `core/src/craft/in-episode.ts`). A stored body that does not parse, throws when evaluated, or evaluates to a non-function poisons only its own name: its `tools.<name>` throws the reason on first call, and every other tool in the program keeps working. Host tool failures cross the boundary the same way: the dispatcher turns a rejection into `{error}` and the sandbox proxy rethrows it with the namespace and member in front of the message (`attributeProviders`, `codemode-sandbox.ts`).

An uncaught throw ends the program, and its message comes back as the `execute_tools` result's `error` string, with `explainNativeToolReferenceError` rewriting the one shape that means "the model reached for a native tool as a bare identifier". Executor-level failure behaves the same way: a sandbox spawn failure arrives as a non-empty `error` string, which `createCodeTool` turns into a thrown AI SDK error.

Logs ride their own channel. Codemode's module stubs override `console.log`, `console.warn` and `console.error`, and the host reads the captured array back as `logs`. A model can `console.log` inside a crafted tool and read the output on the next step.

## 3. Tool registry

SQL is the single source of truth. No in-memory registry, no subscription.

- **No mutation cache.** `workspace.createTool` writes one row.
- **Visibility by re-read.** The executor reads the craft store fresh on every `execute` (on Cloudflare, `selectInjectableCraftedTools` with `filterByEffectiveScore`), and Core's tool builder applies the same EMA cutoff, so advertised and callable sets cannot disagree.
- **Next step, not same arrow.** A newly saved tool is callable in the next `execute_tools` call. Inside one arrow the tool set is frozen, because the preamble was built once from that read.
- **A failure carries its tool's name.** `wrapCraftedBodyWithAttribution` (`core/src/craft/attribution.ts`) stamps a throw `[crafted:<name>] <message>` (`craftFailureMarker`, `core/src/craft/in-episode.ts:228`), so in-episode fitness scores the right artifact. It lives in core because it once lived in the Cloudflare file alone: the CLI compiled bodies bare, a local crafted failure never named its artifact, and the same tool earned different fitness per backend. See docs/EVOLUTION.md, "In-episode evolution (the step clock)".
- **MCP tools re-read by a different route.** `buildUserMcpTools` (`cf-backend/src/actor-agent.ts`) rebuilds the whole MCP `ToolSet` when the descriptor surface's content hash or this turn's tool budget differs from what the activation last served, so a mid-turn connection lands. The budget is core's `stepContextLimit` minus the actor's own tool surface — there is no MCP ratio. Those are top-level AI SDK entries rather than a sandbox namespace, clamped through the same turn budget (`withClampedToolResults`, producer `external_tool`).

Crafted tools are reachable only from inside `execute_tools`; they are not top-level AI SDK tools, and `BUILTIN_TOOLS` is a fixed list of eight names. The full namespace contract is the `Namespace contract` comment above `BUILTIN_TOOL_SPECS` in `core/src/tools/registry.ts`.

## 4. The prelude

On Cloudflare all loader plumbing flows through upstream codemode, and `env.LOADER.get(` is never called directly. Codemode declares one `const` proxy per provider namespace and then runs each provider's `prelude` string in that scope, ahead of the model's program. Kinu's `tools` provider carries the one prelude, rendered by `renderToolsPrelude` (`cf-backend/src/codemode-sandbox.ts`) so its text is testable without a sandbox:

- It imports `kinu-node.js`, the module `KinuSandboxExecutor` loads beside the program (`codemode-node-shim.ts`), and from it defines `require` (Node builtins under `nodejs_compat`, plus `fs/promises` and `child_process` shimmed over the `workspace` namespace), `fetch` (the platform's own, through the loopback egress entrypoint) and a frozen `env` (`workspace` name, the `state` namespace, and the builtins the runtime lacked).
- It assigns every injectable crafted tool onto `tools` as `__kinu.defineCrafted(name, () => (<stored source>))`. The stored source is checked on the host with the same parser the admission gate uses (`parsesAsExpression`); a body that does not parse becomes a factory that throws the parse error, so one bad row cannot be a `SyntaxError` for every program in the workspace.

Own properties assigned by the prelude take precedence over the host dispatch proxy, so `tools.<crafted>` runs inside the sandbox while `tools.<native>` crosses to the host. A crafted body runs in the prelude's scope: it can call `workspace.readFile`, `require`, `fetch`, and another tool as `tools.<other>`. Property lookup happens at call time, so authoring order does not matter. Normalization of a stored body is a single `.trim()`.

The same executor runs the model's program on the CLI in-process (`cli-backend/src/execute-tools-factory.ts`), with the crafted set compiled by `createNodeCraftedExecute`.

## 5. The call contract

`tools.<name>(args)` is the one canonical form, on every backend, and it is the form for a NATIVE tool as much as a crafted one. There is no alias and no second spelling: `CRAFTED_TOOL_NAMESPACE` in `core/src/tools/sandbox-contract.ts` is the single constant both sandboxes build from, so a name outside `tools` is not a tool.

The one near-miss the sandbox answers for is a bare identifier naming a native tool. `explainNativeToolReferenceError` (`core/src/execution/sandbox-errors.ts`) turns V8's `ReferenceError` into a sentence naming `tools.<name>(input)` and the input object that call takes, on both backends — Cloudflare in `cf-backend/src/codemode-sandbox.ts`, the CLI in `cli-backend/src/execute-tools-factory.ts`.

The DECLARATION is not symmetric yet. Cloudflare renders `renderToolsDeclaration(native, crafted)` into the types the model reads, so a crafted name is discoverable there. The CLI never calls `createCodeTool`; it binds the crafted set as a sandbox argument, so crafted names are callable without reaching its types. docs/TOOLS.md carries that nuance.

`workspace.createTool`'s docstring agrees with all of this: it names `tools.<name>(args)` on the next `execute_tools` call. Read it from source, in `core/src/execution/inline.ts`; a quote here would rot the next time the file moves.

## 6. Wiring

`ActorAgent.getExecuteToolsTool()` (`cf-backend/src/actor-agent.ts`) is the entry every actor shares, memoized per work mode and tool profile. It calls `createExecuteToolsTool` (`cf-backend/src/execute-tools.ts`), which owns the `createCodeTool` assembly and builds the one `tools` provider: native tools as host-dispatched functions, and a prelude defining every injectable crafted tool.

`core/src/tools/crafted-executor.ts` is the platform contract both adapters satisfy: `CraftedToolSource`, `CraftedToolExecuteFn`, the `CraftedToolExecute` factory type, plus `toCraftedToolSource`, which drops null and comment-only bodies so no executor has to special-case them. Core's `buildCraftedToolSetFromExecute` (`core/src/tools/builtins.ts`) serves the CLI's `createExecuteTool` factory; Cloudflare bypasses it through `preBuiltExecuteTool`.

## 7. Open questions

1. **An allow-list for outbound `fetch`.** The sandbox reaches the network through `CodemodeEgress` (`cf-backend/src/codemode-egress.ts`), which forwards every request. Whether a crafted tool should be held to a host allow-list is undecided.
2. **No signature gate.** `workspace.createTool` validates argument presence, identifier sanitization, case collision and the misevolution gate, but not the async-arrow shape, so a non-arrow body fails later, at first call, as a compile error. The check would be a `.trim()`, `startsWith('async')` and `includes('=>')` test in `createTool.execute` (`core/src/execution/inline.ts`), returning the shape it wanted.
3. **Top-level surfacing.** Crafted tools could also appear as direct AI SDK tools, letting the model call `double({n: 7})` without `execute_tools`. Deferred: every extra top-level tool grows the system-message tool schema, and no agent-side failure mode justifying the cost is on record.

One question is settled. Same-program visibility stays out: the prelude is rendered once per call, so a tool crafted inside a program is callable from the next `execute_tools` call, not the one that created it.

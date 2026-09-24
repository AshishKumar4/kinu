# Crafted-tool architecture

A crafted tool is a model-authored async function, stored in `crafted_tools` and callable from inside the `eval` sandbox. This page covers how each sandbox loads one, how failures come back, and what the model writes to call one. The experience library carries a crafted tool between workspaces, and so between backends. `packages/core/src/tools/sandbox-contract.ts` is the single source of the call shape.

## 1. The two sandboxes

The two backends run crafted tools on different platforms behind one call surface.

- Cloudflare runs `KinuSandboxExecutor` (`packages/cf-backend/src/codemode-sandbox.ts`). It wraps one upstream `DynamicWorkerExecutor` and adds three things: the `kinu-node.js` module (`packages/core/src/execution/codemode-node-shim.ts`) loaded beside the program, a prelude on the `tools` namespace that defines `require`, `fetch`, `env` and every crafted tool, and `globalOutbound` set to the Worker's own loopback entrypoint (`CodemodeEgress`), so `fetch()` inside the sandbox reaches the network. The host captures console logs.
- The CLI runs `createNodeCraftedExecute` (`packages/cli-backend/src/craft-executor.ts`). It compiles each stored body in-process with `runInThisContext`. There is no child Worker and no loader.

No Cloudflare path compiles code from a string. Four local sites do. `createNodeCraftedExecute` compiles a crafted body. `createNodeCodemodeToolFactory` (`packages/cli-backend/src/codemode-tool-factory.ts`) compiles the model's own `eval` program. `executeInProcess` (`packages/cli-backend/src/executor.ts`) runs a local JavaScript command. `createInlineExecutor` (`packages/core/src/identity/inline-primitives.ts`) serves a local workspace. The scaffold parse gate in `packages/core/src/scaffold/modify.ts` passes its `new Function` check as a string into `rt.executor.execute`, so the compile happens inside whatever sandbox the runtime owns.

## 2. Error propagation

A crafted tool that throws rejects with `[crafted:<name>] <message>` (`defineCrafted` in `packages/core/src/execution/codemode-node-shim.ts`). The program's own `try`/`catch` sees it, and in-episode fitness blames the right artifact (`craftFailureMarker`, `packages/core/src/craft/in-episode.ts`). A stored body that does not parse, throws when evaluated, or evaluates to a non-function poisons only its own name: `tools.<name>` throws the reason on first call, and every other tool in the program keeps working. Host tool failures cross the boundary the same way. The dispatcher turns a rejection into `{error}`, and the sandbox proxy rethrows it with the namespace and member in front of the message (`attributeProviders` in `codemode-sandbox.ts`, through `codemodeFunction`).

An uncaught throw ends the program, and its message comes back as the `eval` result's `error` string. `explainNativeToolReferenceError` rewrites the one shape that means the model reached for a native tool as a bare identifier. An executor-level failure, such as a sandbox that fails to spawn, arrives as a non-empty `error` string, which `createCodeTool` turns into a thrown AI SDK error.

Logs have their own channel. Codemode's module stubs override `console.log`, `console.warn` and `console.error`, and the host reads the captured array back as `logs`. A model can `console.log` inside a crafted tool and read the output on the next step.

## 3. Tool registry

SQL is the single source of truth. There is no in-memory registry and no subscription.

- `workspace.createTool` writes one row. There is no mutation cache.
- The executor reads the craft store fresh on every `execute` (`selectInjectableCraftedTools` in `packages/core/src/tools/crafted-executor.ts`, which ends in `filterByEffectiveScore`). Core's tool builder applies the same EMA cutoff, so the advertised and callable sets agree.
- A newly saved tool is callable in the next `eval` call, not the current one. Inside one program the tool set is fixed, because the prelude was built once from that read.
- A failure carries its tool's name. `attributeCraftedFailure` (`packages/core/src/craft/attribution.ts`) stamps a throw with `craftFailureMarker`, so in-episode fitness scores the right artifact on both backends. It lives in core because it once lived only in the Cloudflare file: the CLI compiled bodies bare, a local crafted failure never named its artifact, and the same tool earned different fitness per backend. See [EVOLUTION.md](./EVOLUTION.md), "In-episode evolution (the step clock)".
- MCP tools are re-read by a different route. `buildUserMcpTools` (`packages/cf-backend/src/actor-agent.ts`) rebuilds the MCP `ToolSet` through `McpToolSurfaceCache` when the descriptor surface's content hash changes, or when this turn's tool budget differs from what the activation last served. The budget is core's step context limit minus the actor's own tool surface; there is no MCP ratio. MCP tools are top-level AI SDK entries, not a sandbox namespace, and their results are clamped through the same turn budget (`withClampedToolResults`, producer `external_tool`).

Crafted tools are reachable only from inside `eval`; they are not top-level AI SDK tools. `BUILTIN_TOOLS` holds the eight native names. The namespace contract is the comment above `BUILTIN_TOOL_SPECS` in `packages/core/src/tools/registry.ts`.

## 4. The prelude

On Cloudflare all loader plumbing goes through upstream codemode; Kinu never calls `env.LOADER.get(` itself. Codemode declares one `const` proxy per provider namespace, then runs each provider's `prelude` string in that scope ahead of the model's program. Kinu's `tools` provider carries the one prelude. `renderToolsPrelude` (`packages/cf-backend/src/codemode-sandbox.ts`) renders it, so its text is testable without a sandbox:

- It imports `kinu-node.js`, the module `KinuSandboxExecutor` loads beside the program. From it the prelude defines `process` (the platform's own, whose `cwd()` answers the workspace root), `require` (Node builtins under `nodejs_compat`, plus `fs/promises` and `child_process` shimmed over the `workspace` namespace, resolving a relative path against `process.cwd()`), `fetch` (the platform's own, through the loopback egress entrypoint), and a frozen `env` (the workspace name, the `state` namespace, and the builtins the runtime lacked).
- It assigns every injectable crafted tool onto `tools` through `__kinu.defineCrafted(name, factory, ...)`, where the factory wraps the stored source in an async arrow. The host checks the stored source with the parser the admission gate uses (`parsesAsExpression`). A body that does not parse becomes a factory that throws the parse error, so one bad row cannot be a `SyntaxError` for every program in the workspace.

Own properties the prelude assigns take precedence over the host dispatch proxy: `tools.<crafted>` runs inside the sandbox, and `tools.<native>` crosses to the host. A crafted body runs in the prelude's scope, so it can call `workspace.readFile`, `require`, `fetch`, and another tool as `tools.<other>`. Property lookup happens at call time, so authoring order does not matter.

`admitCraftedSource` (`packages/core/src/craft/source.ts`) normalizes a body once, when `workspace.createTool` stores it. It accepts one expression (an arrow, a function expression) or a program that declares the tool as a function or variable, and stores one parseable expression. A program that declares no function is refused with the three accepted shapes.

The CLI runs the model's program in-process (`packages/cli-backend/src/codemode-tool-factory.ts`), with the crafted set compiled by `createNodeCraftedExecute`.

## 5. The call contract

`tools.<name>(args)` is the one form on every backend, for a native tool as much as a crafted one. There is no alias and no second spelling. `CRAFTED_TOOL_NAMESPACE` in `packages/core/src/types/codemode.ts` is the constant both sandboxes build from. A name outside `tools` is not a tool.

The one near-miss the sandbox answers is a bare identifier naming a native tool. `explainNativeToolReferenceError` (`packages/core/src/execution/sandbox-errors.ts`) turns V8's `ReferenceError` into a sentence that names `tools.<name>(input)` and the input object that call takes. Both backends answer it the same way: Cloudflare in `packages/cf-backend/src/codemode-sandbox.ts`, the CLI in `packages/cli-backend/src/codemode-tool-factory.ts`.

Both backends declare crafted tools the same way. The `eval` description's type block covers native tools only (`renderToolsDeclaration(native, [])`). Each backend attaches a live reader of the crafted set to its `eval` tool (`withCraftedToolDeclarations`), and the per-step dynamic context lists crafted names and descriptions from it (`craftedToolDeclarations`, `packages/core/src/state/dynamic-context.ts`).

`workspace.createTool`'s docstring in `packages/core/src/execution/inline.ts` names `tools.<name>(args)` on the next `eval` call. Read it from source.

## 6. Wiring

`ActorAgent.getCodemodeToolFactory(mode, profileKey)` (`packages/cf-backend/src/actor-agent.ts`) is the entry every Cloudflare actor shares, memoized per work mode and tool profile. It calls `createCodemodeToolFactory` (`packages/cf-backend/src/codemode-tool.ts`), which owns the `createCodeTool` assembly and builds the one `tools` provider: native tools as host-dispatched functions, plus a prelude defining every injectable crafted tool. The actor hands `toolFor(native)` to core as its `codemode` builder.

`packages/core/src/tools/crafted-executor.ts` is the platform contract both adapters satisfy. It declares `CraftedToolSource`, `CraftedToolExecuteFn`, and the `CraftedToolExecute` factory type. `toCraftedToolSource` drops null and comment-only bodies, so no executor special-cases them. Core's `installCodemode` (`packages/core/src/tools/builtins.ts`) builds `eval` over the finished surface for `buildActorTools`; for the CLI it resolves the crafted set through `buildCraftedToolSetFromExecute`.

## 7. Outbound network and open questions

The sandbox reaches the network through `CodemodeEgress` (`packages/cf-backend/src/codemode-egress.ts`). It judges each destination with `refusedHostname` (`packages/core/src/safety/egress-destination.ts`), the same classifier the container egress and `web.fetch` use, and forwards with `redirect: 'manual'` so it never follows a destination it has not judged. There is no per-workspace allow-list: a program may reach what the Worker may reach, minus addresses no untrusted code may reach. A public hostname that resolves to a private address is not caught here; that residual is unmeasured.

Crafted tools stay out of the top-level AI SDK surface. Surfacing them there would let the model call `double({n: 7})` without `eval`. That stays deferred: every extra top-level tool grows the system-message tool schema, and no agent-side failure that would justify the cost is on record.

Same-program visibility is settled and stays out. The prelude is rendered once per call, so a tool crafted inside a program is callable from the next `eval` call, not the one that created it.

# Crafted-Tool Architecture

A crafted tool is a model-authored async arrow function, stored in
`crafted_tools` and callable from inside the `execute_tools` sandbox. This page
describes how the sandbox loads one, how it reports a failure, and what the
model must write to call one.

The experience library carries a crafted tool between workspaces, and therefore
between backends. So the call shape is a cross-backend contract rather than a
per-sandbox detail, and `core/src/tools/sandbox-contract.ts` is its single
source.

## 1. The two sandboxes

Both backends craft tools. They use different sandboxes because the platforms
differ, and they present the same call surface.

- **Cloudflare.** `PreambleCraftedExecutor`
  (`cf-backend/src/crafted-tool-registry.ts`) holds one upstream
  `DynamicWorkerExecutor({ loader })` for the Durable Object's lifetime. Only
  `loader` is passed, so the sandbox inherits every codemode default: no
  `fetch`, no `fs`, no `require`, a `Proxy` per provider namespace, and console
  logs captured for the host to read back. The no-network constraint is recorded
  at `core/src/types/primitives.ts:116`.
- **CLI.** `createNodeCraftedExecute` (`cli-backend/src/craft-executor.ts`)
  compiles each stored body in-process with `new Function`, because V8 on Node
  and Bun permits codegen from strings. There is no child Worker and no loader.

No Cloudflare path calls `new Function`. Four host call sites exist and all
four are local: `cli-backend/src/craft-executor.ts:48` compiles a crafted body,
`cli-backend/src/execute-tools-factory.ts:151` compiles the model's own
`execute_tools` code, `cli-backend/src/executor.ts:241` runs a local JavaScript
command, and `createInlineExecutor`
(`core/src/identity/inline-primitives.ts:169`) serves a local workspace. One
more site passes the words as a string into `rt.executor.execute`, in
`core/src/scaffold/modify.ts:66`'s parse gate, so that codegen happens inside
whatever sandbox the runtime owns rather than in the host.

## 2. Error propagation

A crafted-tool failure comes back as a flat envelope rather than a bare string:
`{ error: true, message, stack?, toolName?, providerName? }`.
`StructuredExecutionError` and `wrapProvidersWithStructuredErrors`
(`cf-backend/src/crafted-tool-registry.ts`) produce it over every resolved
provider. The stack is truncated to its first ten lines, and `renderThrownChain`
keeps a `cause` chain's message.

The envelope is flat because the Vercel AI SDK stringifies
`tool-output-available` into activity logs, and a nested payload does not
survive that intact.

Errors are **returned as values**, so a failing crafted tool does not abort the
surrounding arrow and codemode's dispatcher reports the call as having
returned. An executor-level failure behaves differently. A sandbox spawn or a
timeout comes back as a non-empty `error` string, which `createCodeTool` turns
into a thrown AI SDK error.

Logs surface on their own channel. Codemode's module stubs override
`console.log`, `console.warn` and `console.error`, and the host reads the
captured array back as `logs` on the result. A model can therefore
`console.log` inside a crafted tool and read the output on the next step.

## 3. Tool registry

SQL is the single source of truth. There is no in-memory registry and no
subscription.

- **No mutation cache.** `workspace.createTool` writes one row.
- **Visibility by re-read.** The executor reads the craft store fresh on every
  `execute`. On Cloudflare that read is `selectInjectableCraftedTools`, which
  also applies `filterByEffectiveScore`. Core's tool builder applies the same
  EMA cutoff, so the advertised set and the callable set cannot disagree.
- **Next step, not same arrow.** A newly saved tool is callable in the next
  `execute_tools` call, which is a later step in the same turn. Inside one
  arrow the tool set is frozen, because the preamble was built once from that
  read.
- **A failure carries its tool's name.** One shared wrapper,
  `wrapCraftedBodyWithAttribution` (`core/src/craft/attribution.ts`), stamps a
  throw `[crafted:<name>] <message>` (`craftFailureMarker`,
  `core/src/craft/in-episode.ts:228`), so the in-episode fitness signal scores
  the right artifact. It lives in core because it once lived in the Cloudflare
  file alone: the CLI compiled bodies bare, a local crafted failure never named
  its artifact, and the same tool earned different fitness per backend. See
  docs/EVOLUTION.md, "In-episode evolution (the step clock)".
- **MCP tools re-read by a different route.** `buildUserMcpTools`
  (`cf-backend/src/actor-agent.ts`) rebuilds the whole MCP `ToolSet` whenever
  the user's server watermark changes, so a mid-turn connection lands. Those
  tools are top-level AI SDK entries rather than a sandbox namespace, clamped
  through the same turn budget (`withClampedToolResults`, producer
  `external_tool`).

Crafted tools are reachable only from inside `execute_tools`. They are not
top-level AI SDK tools, and `BUILTIN_TOOLS` is a fixed list of eight names. The
full namespace contract is the `Namespace contract` comment above
`BUILTIN_TOOL_SPECS` in `core/src/tools/registry.ts`.

## 4. The preamble

Neither backend owns a sandbox Worker module. On Cloudflare, `env.LOADER.get(`
is never called directly and all loader plumbing flows through upstream
codemode. The only platform-owned piece is the string work that produces the
arrow body before `DynamicWorkerExecutor.execute` sees it.

Two exported functions do that work, both in
`cf-backend/src/crafted-tool-registry.ts`, so their behaviour is testable
without a sandbox.

- `buildToolsPreamble` produces the `const tools = { … }` object literal, one
  entry per tool, each body passed through `wrapCraftedBodyWithAttribution`.
  The body sits alone between parentheses on its own lines, because a
  model-authored body ending in a `//` comment would otherwise swallow the rest
  of the wrapper and turn the whole preamble into a syntax error.
- `injectPreamble` normalizes the model's code with codemode's own
  `normalizeCode`, then wraps it:
  `async () => { <preamble>return await (<normalized>)(); }`. A wrap rather
  than a regex splice, because a splice silently dropped the preamble whenever
  the model's code was not already an `async (…) => {` arrow. That shape is
  exactly what `BUILTIN_TOOL_SPECS.execute_tools.example` teaches and what
  `normalizeCode` wraps for you, and on every such call the whole crafted-tool
  surface was undefined with no error naming why.

Because the preamble sits inside the arrow, a crafted-tool body shares the
arrow's lexical scope. It can call `workspace.readFile`, any wired
`codemode.*` provider, and another crafted tool by name. Property lookup on
the object literal happens at call time, so authoring order does not matter.

Normalization of a stored body is a single `.trim()`.

## 5. The call contract

A crafted tool is callable as `tools.<name>(args)` on every backend. That is the
one canonical form.

`codemode.<name>` stays declared so the model can discover the tool, but calling
it throws `craftedNamespaceCorrection(name)`; it never returns an error value. A
returned error is a value the model reads as a result and the runtime reads as a
successful call, and it would let an in-episode fitness observation be taken on
a call that never ran.

The refusal is the same on both backends, and both build it from the same
`craftedDispatcherEntry`: Cloudflare in `cf-backend/src/execute-tools.ts`, the
CLI in `cli-backend/src/execute-tools-factory.ts`. The DECLARATION is not
symmetric yet. Cloudflare hands `createCodeTool` a named provider of alias
entries, which is what puts crafted names in the types the model reads. The CLI
never calls `createCodeTool`: it renders its description from the execution
router's provider types and injects the crafted set as sandbox arguments
instead, so crafted names reach the local model as a refusing binding without
reaching its types. docs/TOOLS.md carries that nuance;
`core/src/tools/sandbox-contract.ts` is the source both sides read for the
refusal.

`workspace.createTool`'s own docstring agrees with it. The docstring names
`tools.<name>(args)` on the next `execute_tools` call and names the alias as
refused. Read it from source, in `core/src/execution/inline.ts`; a quote or a
line range here would rot the next time the file moves.

## 6. Wiring

`ActorAgent.getExecuteToolsTool()` (`cf-backend/src/actor-agent.ts`) is the
entry every actor shares, memoized per work mode and tool profile. It calls
`createExecuteToolsTool` (`cf-backend/src/execute-tools.ts`), which owns the
whole `createCodeTool` assembly and seeds the alias namespace with one entry per
injectable crafted tool, so the provider's type declaration lists them.

`core/src/tools/crafted-executor.ts` is the platform contract both adapters
satisfy. It declares `CraftedToolSource`, `CraftedToolExecuteFn` and the
`CraftedToolExecute` factory type, plus one runtime helper,
`toCraftedToolSource`, which drops null and comment-only bodies so no executor
has to special-case them.

Core's `buildCraftedToolSetFromExecute` (`core/src/tools/builtins.ts`) serves
the CLI's `createExecuteTool` factory. Cloudflare bypasses it through
`preBuiltExecuteTool`.

## 7. Open questions

1. **Outbound `fetch` from a crafted tool.** `PreambleCraftedExecutor` takes
   codemode's default, which grants no outbound `fetch`. Whether a crafted tool
   may reach the network at all, and under what allow-list, is undecided.
2. **No signature gate.** `workspace.createTool` validates argument presence,
   identifier sanitization, case collision and the misevolution gate. It does
   not check the async-arrow shape, so a body that is not an arrow fails later,
   at first call, as a compile error. The check would be a `.trim()`,
   `startsWith('async')` and `includes('=>')` test in `createTool.execute`
   (`core/src/execution/inline.ts`), returning the shape it wanted.
3. **Top-level surfacing.** Crafted tools could also appear as direct AI SDK
   tools, letting the model call `double({n: 7})` without `execute_tools`.
   Deferred: every extra top-level tool grows the system-message tool schema,
   and no agent-side failure mode that would justify the cost is on record. A
   decision needs one named, plus a ruling that the prompt cannot fix it first.

Two questions are settled. Same-arrow visibility stays out, because the
preamble is built once per call and frozen for that arrow, which makes the
contract next-step. The error payload stays flat, for the stringification
reason in §2.

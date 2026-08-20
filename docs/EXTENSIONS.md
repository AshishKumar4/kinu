# Kinu turn extensions

> Maintained by Claude (AI-edited documentation, presented as-is); verify against the code when precision matters.

The extension seam is the public API for observing and extending one agent turn
without importing engine internals. Both backends fire the same hook path. On
the CLI that is the shared chat engine, `runChat`. In the cloud it is the
Durable Object's Think hook bridge on `ActorAgent`. Internal consumers and
external plugins ride the same mechanism, so no private callback runs beside a
parallel plugin API.

For the wider seams (model provider, exploration strategy, actor kind), see
[EXTENSIBILITY.md](./EXTENSIBILITY.md). This document covers the per-turn hooks.

Source: `packages/core/src/extension.ts`, exported from `@kinu/core`.

Two files in this tree export something called an extension, and they mean
different things. `packages/core/src/extension.ts` holds the contract: the
`ProteusExtension` interface and the `ExtensionHost` that drives it.
`packages/compaction/src/extension.ts` holds one implementation of that
contract, `createCompactionExtension`, which returns a `ProteusExtension` whose
`name` is `compaction`. Read the first for the seam and the second for a worked
registrant.

## The shape

An extension is a set of optional hooks plus a stable `name`. The name appears
in errors. Implement only the hooks you need.

```ts
import { ExtensionHost, type ProteusExtension } from '@kinu/core';

const logger: ProteusExtension = {
  name: 'my.logger',
  onTurnStart({ system, history }) { /* before the model is streamed */ },
  onToolCall({ toolName, args }) { /* each tool call the model emits */ },
  onToolResult({ toolName, args, result }) { /* each tool result, in full */ },
  onTurnEnd({ text, responseMessages }) { /* after the turn settles */ },
};
```

Three more hooks go beyond observation.

- **`registerTools(): ToolSet`** contributes tools into the turn's tool set.
  `ExtensionHost.tools()` calls it once while that set is built. The caller's
  own tool of the same name wins, so a contributed tool never shadows a
  built-in. A collision between two extensions throws and names both.
- **`prepareStep(ctx): ModelMessage[] | undefined`** rewrites what the model
  sees at one step boundary. Return a replacement message array, or
  `undefined` to leave the step alone. The hooks chain across extensions, so
  extension N sees extension N-1's output. The CLI backend's mid-turn steering
  drain rides this hook. Both backends run the extension chain first and place
  prompt-cache tail markers last, through one shared pipeline
  (`composePrepareStep` in `core/src/prompting/prepare-step.ts`).
- **`transformContext(ctx): Promise<ModelMessage[] | undefined>`** is the
  awaited context transform, and the seam the compaction plugin uses. It fires
  once per turn assembly, before the model streams. `ctx` carries
  `sessionKey`, the durable `messages`, `system`, `contextWindow`, an optional
  `providerReportedTokens`, and `trigger: 'auto' | 'force'`. It chains like
  `prepareStep`, but it is awaited and it fails open per extension. A throwing
  transform is logged and skipped, so a plugin cannot break a turn. Both
  backends add never-persisted context after the transform, so a transform
  never sees the turn-local tail or the per-step dynamic-context blocks.

## Wiring it up

Register extensions on an `ExtensionHost` and pass the host to `runChat`:

```ts
const extensions = new ExtensionHost()
  .register(logger)
  .register(myToolPlugin);

for await (const ev of runChat({ model, system, history, tools, extensions })) {
  // ev is the same ChatEvent stream as before; extensions observe alongside it
}
```

The host is optional. `runChat` without `extensions` passes the caller's tools
straight through and fires no hooks.

### Ordering

Around one turn the observation hooks fire in this order:

```
onTurnStart
  → transformContext   (once, on the durable history; volatile context spliced after)
  → prepareStep        (at each step boundary)
  → onToolCall         (as each tool call streams)
  → onToolResult       (as each tool result returns)
onTurnEnd
```

`registerTools` sits outside that sequence. Each backend calls it once while it
assembles the turn's tool set. `runChat` calls it before `onTurnStart`
(`core/src/chat.ts:204`); the cloud bridge calls it after
(`cf-backend/src/actor-agent.ts:3093`). Do not depend on its position relative
to the observation hooks.

Within one hook, every registered extension runs in registration order.
`prepareStep` and `transformContext` both chain their outputs.

## Internal consumers

Both backends register the same three extensions, in the same order.

1. **`compaction`**, from `createCompactionExtension` in `@kinu/compaction`.
   It is the default `transformContext` registrant. It runs the better-compact
   staged pruning ladder once per turn assembly, over shared stores. Raw
   transcripts land in the canonical workspace VFS at
   `.proteus/compaction/<sessionKey>/<rangeHash>.md`, readable back through
   the agent's own file tools. The replayable plan and the measured
   prompt-token trigger share one `compaction_state` row. Its `onOutcome`
   callback resets the dynamic-context ledger when the model-visible stream
   changed shape, which is the `planned` and `invalidated` outcomes. A
   byte-stable replay keeps the frozen block positions valid, so it resets
   nothing.
2. **The user steer drain.** It is registered as `proteus.steering` on the CLI
   (`cli-backend/src/local-session.ts:1715`) and as `proteus.user-steer` in
   the cloud (`cf-backend/src/actor-agent.ts:846`). Both are one `prepareStep`
   hook over the same `UserSteerDrain`. It drains pending steers into a single
   user message appended after the latest tool results.
3. **`proteus.signals`**, the orchestrator's own turn extension
   (`core/src/orchestrator/agent-orchestrator.ts:161`). It observes tool calls
   for the turn's mechanical steering, and it drains every signal delivered
   for the live turn into that turn's next step. A background event and a
   steer both arrive this way.

The steer drain registers before the signal extension on purpose. A signal
splice must not shift the indices the steer drain replays into durable history.

## The cloud bridge

The host lives on `ActorAgent` (`cf-backend/src/actor-agent.ts`), the abstract
base that `OrchestratorAgent` and `SubordinateAgent` both extend. A subordinate
therefore gets the same seam, the same compaction and the same event injection
as the workspace's own agent, with no second code path. One persistent
`ExtensionHost` per activation bridges Think's subclass hooks onto the contract
above. `packages/cf-backend/package.json` depends on `@cloudflare/think` at
`^0.15.1`, resolved to 0.15.1 in this worktree.

| Think hook | ExtensionHost |
| --- | --- |
| `beforeTurn` (`cf-backend/src/actor-agent.ts:2894`) | `emitTurnStart`, then awaited `runTransformContext`; `ExtensionHost.tools()` folded into `TurnConfig.tools` and `activeTools` |
| `beforeStep` (`cf-backend/src/actor-agent.ts:3180`) | `composePrepareStep`: the extension chain, then the turn's cache-breakpoint plan |
| `beforeToolCall` / `afterToolCall` (`cf-backend/src/actor-agent.ts:3281`, `:3290`) | `emitToolCall` / `emitToolResult` |
| `onChatResponse`, on a completed turn | `emitTurnEnd` |

`emitTurnStart` and `runTransformContext` fire from
`core/src/orchestrator/turn-context.ts:101-103`, inside the shared
`assembleTurnMessages` that `runChat` calls too. The ordering cannot drift per
backend.

One thing is worth knowing about `registerTools` here. An actor's `activeTools`
whitelist is `[...effectiveActiveTools, ...extensionToolNames]`, and
`actorActiveTools()` has already narrowed `effectiveActiveTools` to the deps
that actor's profile wired. Extension tools are additive on top of the narrowed
set and never widen it. A contributed tool whose name is already in the turn's
tools or its MCP tools is dropped before the merge
(`cf-backend/src/actor-agent.ts:3092-3101`).

## Notes

- Hooks may be async and the engine awaits them. Keep them fast, because they
  run on the turn's hot path.
- `onToolResult.result` is the tool's full rendered output, the same string
  the streamed `tool-result` event and the durable turn record carry. It is
  not bounded here, because the built-in consumer keys on it: the turn
  steering hashes it as the call's identity, and a head slice makes two
  different results look like one. Bound it in your own render.
  `evidenceWindow` keeps both ends and states what it dropped.
- The seam is small on purpose. It observes a turn and lightly rewrites it.
  Replacing the inference loop is the mutable scaffold's job
  (`core/src/scaffold/inference-transform.ts`), which rides Think's
  `_transformInferenceResult` rather than this host.

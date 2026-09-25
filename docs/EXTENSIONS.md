# Kinu turn extensions

Extensions observe or extend one agent turn without importing engine internals.
Both backends drive them the same way: `ActorSession.execute`
(`packages/core/src/orchestrator/actor-session.ts`) builds a per-turn
`ExtensionHost` and runs the turn through `runChat`. Internal consumers and
plugins use the same path.

[EXTENSIBILITY.md](./EXTENSIBILITY.md) lists the plug-in points. This document
covers the hook signatures, their order, the internal registrants, and how the
cloud backend wires them. `packages/core/src/extension.ts` defines
`KinuExtension` and `ExtensionHost`, exported from `@kinu.run/core`.
`packages/compaction/src/extension.ts` implements one with
`createCompactionExtension`, named `compaction`.

## The shape

An extension is a set of optional hooks plus a stable `name` that errors report.

```ts
import { ExtensionHost, type KinuExtension } from '@kinu.run/core';

const logger: KinuExtension = {
  name: 'my.logger',
  onTurnStart({ system, history }) { /* before the model is streamed */ },
  onToolCall({ toolName, args }) { /* each tool call the model emits */ },
  onToolResult({ toolName, args, result }) { /* each tool result, in full */ },
  onTurnEnd({ text, responseMessages }) { /* after the turn settles */ },
};
```

- `registerTools(): ToolSet` contributes tools to the turn.
  `ExtensionHost.tools()` calls it once per extension. Caller tools win over
  extension tools. Two extensions registering the same name throw, and the
  error names both.
- `prepareStep(ctx)` returns a replacement message array for one step, or
  `undefined` to leave it unchanged. It may be sync or async. Extensions chain
  in registration order. The `kinu.inbox` extension uses it to splice a mid-turn
  send in at the step boundary. `composePrepareStep`
  (`core/src/prompting/prepare-step.ts`) runs the extension chain before the
  cache tails.
- `transformContext(ctx): Promise<ModelMessage[] | undefined>` runs once per
  turn assembly, before streaming. `ctx` carries `sessionKey`, the durable
  `messages`, `system`, `contextWindow`, optional `providerReportedTokens`,
  `trigger: 'auto' | 'force'` and an optional `abortSignal`. It chains. A
  throwing extension is logged and skipped. It never sees the runtime
  context the step weaves in (dynamic context, the unapproved instructions).

## Wiring

Register extensions on an `ExtensionHost` and pass it to `runChat`:

```ts
const extensions = new ExtensionHost()
  .register(logger)
  .register(myToolPlugin);

for await (const ev of runChat({ model, system, history, tools, extensions })) {
  // ev is the same ChatEvent stream as before; extensions observe alongside it
}
```

Without `extensions`, `runChat` passes tools through and fires no hooks.

### Ordering

```
onTurnStart
  → transformContext   (once, on the durable history; volatile context spliced after)
  → prepareStep        (at each step boundary)
  → onToolCall         (as each tool call streams)
  → onToolResult       (as each tool result returns)
onTurnEnd
```

`registerTools` sits outside that sequence. `runChat` (`core/src/chat.ts`)
calls `extensions.tools()` before `assembleTurnMessages`, which fires
`onTurnStart`, but that position is not a guarantee. Every other hook runs in
registration order, and `prepareStep` and `transformContext` chain their
outputs.

## Internal consumers

Both backends register these, in this order.

1. `compaction` (`createCompactionExtension` in `@kinu.run/compaction`) is the
   default `transformContext` registrant. It runs better-compact once per turn
   over shared stores and keeps raw transcripts in
   `.kinu/compaction/<sessionKey>/<rangeHash>.md`. Its plan and token trigger
   share `compaction_state`. Its `onOutcome` callback resets dynamic context on
   `planned` and `invalidated`, never on a byte-stable replay.
2. `kinu.inbox` (`AgentOrchestrator.turnExtension` in
   `core/src/orchestrator/agent-orchestrator.ts`) watches tool calls for
   mechanical steering. `ActorSession.execute` registers it on every turn, after
   the backend's own extensions. It splices a mid-turn send into the running
   turn's next step (`core/src/orchestrator/inbox.ts`). Pending user messages
   drain as one durable user message, placed before the event text in the same
   splice, so event indices cannot shift replayed history. Core marks landed
   rows with `STEER_METADATA_KEY` (`kinuSteer`) and `STEER_STEP_METADATA_KEY`
   (`kinuSteerAtStep`).

## The cloud side

`ActorAgent` (`cf-backend/src/actor-agent.ts`) holds one `ExtensionHost` for
the life of the object, with `compaction` registered on it.
`OrchestratorAgent` is its only subclass. Each turn, the actor hands
`this.extensions.list()` to `ActorSession.execute`, which composes that turn's
host over them and adds `kinu.inbox`, exactly as the CLI does with its own
compaction extension (`cli-backend/src/local-session.ts`).
`emitTurnStart` and `runTransformContext` both run in `assembleTurnMessages`
(`core/src/orchestrator/turn-context.ts`), so backend ordering cannot drift.

On cloud, the settled turn also owes a `turn_end_extensions` terminal effect.
It replays `emitTurnEnd` on the actor's host from the recorded answer row, so a
turn cut by eviction still announces its end. The CLI owes no such row: its
per-turn host dies with the turn.

Contributed tools pass two filters on cloud. `extensionTools` in
`ActorAgent.assembleTurn` drops names already in the turn or MCP set.
`resolveAgentTurnProfile()` then supplies `profile.allowedTools`, and
`effectiveActiveTools` and `effectiveTools` keep only allowed names.

## Notes

- Hooks may be async. The engine awaits them on the hot path.
- `onToolResult.result` is the full rendered output, shared with the streamed
  `tool-result` event and the durable turn record. It stays unbounded because
  turn steering hashes it as call identity, and a head slice could merge
  distinct results. Bound your own render with `evidenceWindow`
  (`core/src/prompts/evidence-window.ts`): text within a positive character
  budget passes unchanged, and longer text keeps both ends and names the
  omitted middle.
- Only the mutable scaffold replaces inference. It does so through
  `scaffoldChatTransform` (`core/src/scaffold/chat-transform.ts`), called from
  `startActorTurn` in `core/src/orchestrator/actor-turn.ts`.

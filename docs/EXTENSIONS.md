# Kinu turn extensions

Extensions observe or extend one agent turn without importing engine internals.
Both backends use one hook path: CLI `runChat`; cloud `ActorAgent`'s Think hook
bridge. Internal consumers and plugins use the same path.

[EXTENSIBILITY.md](./EXTENSIBILITY.md) lists the plug-in points. This document
specifies this one: hook signatures, order, internal registrants and cloud
bridge. Source: `packages/core/src/extension.ts`, exported from `@kinu.run/core`.

`packages/core/src/extension.ts` defines `KinuExtension` and `ExtensionHost`.
`packages/compaction/src/extension.ts` implements it with
`createCompactionExtension`, named `compaction`.

## The shape

An extension is optional hooks plus a stable error-visible `name`.

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

- `registerTools(): ToolSet` contributes tools while the set builds.
  `ExtensionHost.tools()` calls it once. Caller tools win; extension collisions
  throw and name both extensions.
- `prepareStep(ctx): ModelMessage[] | undefined` replaces one step's messages,
  or returns `undefined` unchanged. Extensions chain in registration order. The
  CLI steer drain uses it. `composePrepareStep`
  (`core/src/prompting/prepare-step.ts`) runs extensions before cache tails.
- `transformContext(ctx): Promise<ModelMessage[] | undefined>` runs once before
  streaming. `ctx` carries `sessionKey`, durable `messages`, `system`,
  `contextWindow`, optional `providerReportedTokens`, and
  `trigger: 'auto' | 'force'`. It chains, logs and skips a throwing extension,
  and never sees turn-local or per-step dynamic context.

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

`registerTools` is outside that sequence. `runChat` in `core/src/chat.ts` and
`ActorAgent.beforeTurn` in `cf-backend/src/actor-agent.ts` invoke it before
`assembleTurnMessages`, which fires `onTurnStart`. Its position is not
guaranteed. Other hooks run in registration order; `prepareStep` and
`transformContext` chain outputs.

## Internal consumers

Both backends register these in order.

1. `compaction` (`createCompactionExtension` in `@kinu.run/compaction`) is the
   default `transformContext` registrant. It runs better-compact once per turn
   over shared stores and keeps raw transcripts in
   `.kinu/compaction/<sessionKey>/<rangeHash>.md`. Its plan and token trigger
   share `compaction_state`; `onOutcome` resets dynamic context for `planned`
   and `invalidated`, never for a byte-stable replay.
2. The user steer drain is `kinu.steering` in
   `cli-backend/src/local-session.ts` and `kinu.user-steer` in
   `cf-backend/src/actor-agent.ts`. The shared `UserSteerDrain`
   `prepareStep` hook appends pending steers after tool results. Core marks rows
   with `STEER_METADATA_KEY` (`kinuSteer`) and `STEER_STEP_METADATA_KEY`
   (`kinuSteerAtStep`) in `core/src/orchestrator/user-steer.ts`.
3. `kinu.signals` (`AgentOrchestrator.turnExtension` in
   `core/src/orchestrator/agent-orchestrator.ts`; cloud registration in
   `cf-backend/src/actor-agent.ts`) observes calls for mechanical steering and
   delivers live signals at the next step.

The steer drain precedes signals so a signal splice cannot shift replayed
history indices.

## The cloud bridge

`ActorAgent` hosts one persistent `ExtensionHost` per activation.
`OrchestratorAgent` and `SubordinateAgent` extend it, so both get the same
hooks, compaction and event injection. `packages/cf-backend/package.json`
depends on `@cloudflare/think` at `^0.15.1`, resolved to 0.15.1 in this
worktree.

| Think hook | ExtensionHost |
| --- | --- |
| `beforeTurn` (`cf-backend/src/actor-agent.ts:3787`) | `emitTurnStart`, then awaited `runTransformContext`; `ExtensionHost.tools()` folded into `TurnConfig.tools` and `activeTools` |
| `beforeStep` (`cf-backend/src/actor-agent.ts:4144`) | `composePrepareStep`: the extension chain, then the turn's cache-breakpoint plan |
| `beforeToolCall` / `afterToolCall` (`cf-backend/src/actor-agent.ts:4259`, `:4268`) | `emitToolCall` / `emitToolResult` |
| `onChatResponse`, on a completed turn | `emitTurnEnd` |

`emitTurnStart` and `runTransformContext` run in shared
`assembleTurnMessages` at `core/src/orchestrator/turn-context.ts:101-103`, so
backend ordering cannot drift.

Contributed tools pass two filters. `extensionTools` in
`cf-backend/src/actor-agent.ts` drops names already in the turn or MCP set
before the merge. `resolveAgentTurnProfile()` then supplies
`profile.allowedTools`; `effectiveActiveTools` and `effectiveTools` keep only
allowed names.

## Notes

- Hooks may be async; the engine awaits them on the hot path.
- `onToolResult.result` is full rendered output, shared with the streamed
  `tool-result` event and durable turn record. It stays unbounded because turn
  steering hashes it as call identity; a head slice could merge distinct
  results. Bound your own render with `evidenceWindow`. It leaves text within a
  positive character budget unchanged; otherwise it keeps both ends and names
  the omitted middle.
- The mutable scaffold, not extensions, replaces inference through
  `core/src/scaffold/inference-transform.ts` and Think's
  `_transformInferenceResult`.

# Proteus turn extensions

> Maintained by Claude (AI-edited documentation, presented as-is); verify against the code when precision matters.

The extension seam is the small, stable public API for **observing and
extending a single agent turn** without importing engine internals. It is the
one hook path BOTH backends' turn loops fire: the shared chat engine
(`runChat`, the CLI path) and the cloud DO's Think hook bridge (`ActorAgent`
maps Think's `beforeTurn`/`beforeStep`/`beforeToolCall`/`afterToolCall`/
`onChatResponse` onto this contract, for every actor that extends it).
Internal consumers and external plugins ride the same mechanism, so there is no
private callback plus a parallel plugin API to drift apart.

For the broader "plug in a new agentic idea" seams (model provider, exploration
strategy, actor kind), see `EXTENSIBILITY.md`. This document is only about the
per-turn hooks.

Source: `packages/core/src/extension.ts`, exported from `@proteus/core`.

## The shape

An extension is a bag of optional hooks plus a stable `name` (surfaced in
errors). Implement only what you need:

```ts
import { ExtensionHost, type ProteusExtension } from '@proteus/core';

const logger: ProteusExtension = {
  name: 'my.logger',
  onTurnStart({ system, history }) { /* before the model is streamed */ },
  onToolCall({ toolName, args }) { /* each tool call the model emits */ },
  onToolResult({ toolName, args, result }) { /* each tool result (≤1000 chars) */ },
  onTurnEnd({ text, responseMessages }) { /* after the turn settles */ },
};
```

Three more hooks go beyond observation:

- **`registerTools(): ToolSet`** — contribute tools into the turn's tool set.
  Called once at turn start. Contributed tools are merged with (and never shadow)
  the caller's built-in tools; a name collision **between two extensions** throws
  so a plugin can't silently override another's tool.
- **`prepareStep(ctx): ModelMessage[] | undefined`** — a message-transform hook
  at each step boundary. Return a replacement message array to rewrite what the
  model sees for that step, or `undefined` to leave it unchanged. Hooks are
  chained across extensions — each sees the prior extension's output. This is the
  seam the CLI backend's mid-turn steering drain rides. On both backends the
  extension chain runs FIRST and prompt-cache tail markers land LAST, via the one
  shared pipeline (`composePrepareStep` in `core/src/prompting/prepare-step.ts`).
- **`transformContext(ctx): Promise<ModelMessage[] | undefined>`** — the awaited
  context-transform hook (the compaction-plugin seam), fired ONCE per turn
  assembly before the model streams. `ctx` carries `sessionKey`, the **durable**
  `messages`, `system`, `contextWindow`, optional `providerReportedTokens`, and
  `trigger: 'auto' | 'force'`. Chained like `prepareStep` but awaited, and
  **fail-open per extension**: a throwing transform is logged and skipped — a
  plugin can never break a turn. Never-persisted context — the turn-local tail
  at turn assembly, the dynamic-context blocks at each step — is added AFTER the
  transform on both backends, so a transform never sees it.

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

The host is optional — `runChat` without `extensions` behaves exactly as before.

### Ordering guarantees

Around one turn the hooks fire in this order:

```
onTurnStart
  → transformContext   ── once, on the durable history (volatile spliced after)
  → (registerTools folded into the ToolSet the model receives)
  → prepareStep        ── at each step boundary
  → onToolCall         ── as each tool call streams
  → onToolResult       ── as each tool result returns
onTurnEnd
```

Within a single hook, every registered extension runs in **registration order**.
`prepareStep` chains: extension N sees extension N-1's rewritten messages.

## Internal consumers: compaction + the steering drain

Compaction is the default `transformContext` registrant on BOTH backends:
`createCompactionExtension` (`@proteus/compaction`) runs the better-compact
staged pruning ladder once per turn assembly, over shared stores — raw
transcripts in the workspace CompositeVFS (`/local/.proteus/compaction/…`,
readable back through the agent's own file tools) and the replayable plan +
the measured prompt-token trigger in one `compaction_state` row (DO SQLite /
agent.db). Its `onOutcome` resets the dynamic-context ledger whenever the
model-visible stream changed shape (`'planned'` / `'invalidated'`);
byte-stable replays keep the frozen block positions valid.

The CLI backend's mid-turn steering (`LocalAgentSession`) is itself an
extension registered as `proteus.steering` with a `prepareStep` hook — it drains
pending steers into a single user message appended after the latest tool results
at each step boundary. There is deliberately no second, private hook path: the
engine drives internal consumers and external plugins through the same
`ExtensionHost`.

## The cloud bridge

The host lives on `ActorAgent` (`cf-backend/src/actor-agent.ts`), the abstract
base both `OrchestratorAgent` and `SubordinateAgent` extend — so a subordinate
gets the same seam, the same compaction, and the same event injection as the
workspace's own agent, with no second code path. One persistent `ExtensionHost`
per activation bridges Think's subclass hooks onto the contract above:

| Think hook (0.8) | ExtensionHost |
| --- | --- |
| `beforeTurn` | `emitTurnStart` + awaited `runTransformContext` (ledger weave + turn-local tail after); `tools()` folded into `TurnConfig.tools`/`activeTools` |
| `beforeStep` | `composePrepareStep` (extension chain, then the turn's cache-breakpoint plan) |
| `beforeToolCall` / `afterToolCall` | `emitToolCall` / `emitToolResult` |
| `onChatResponse` (completed) | `emitTurnEnd` |

Both default registrants attach on this host in the `ActorAgent` constructor:
the compaction extension (`registerCompactionExtension`, registered under the
name `compaction`) and the orchestrator's signal extension (`proteus.signals`,
which observes tool calls for the turn's mechanical steering and drains every
signal delivered for the live turn — a background event, a steer — into the active
turn's next step; the DO counterpart of the CLI steering drain, sharing the
same `StepInjections` splice math).

One thing worth knowing about `registerTools` on this backend: an actor's
`activeTools` whitelist is `[...effectiveActiveTools, ...extensionToolNames]`,
and `effectiveActiveTools` has already been narrowed by `actorActiveTools()` to
the deps that actor's profile wired. Extension tools are additive on top of that
narrowed set; they do not widen it.

## Notes

- Hooks may be async; the engine awaits them. Keep them fast — they run on the
  turn's hot path.
- `onToolResult.result` is truncated to 1000 characters (the same bound the
  streamed `tool-result` event uses).
- The seam is intentionally tiny. It observes and lightly rewrites a turn; it is
  not a place to re-implement the loop. Replacing the inference loop itself is
  the mutable scaffold's job (`core/src/scaffold/inference-transform.ts`), which
  rides Think's `_transformInferenceResult` rather than this host.

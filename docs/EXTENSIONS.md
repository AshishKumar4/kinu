# Proteus turn extensions

> Maintained by Claude (AI-edited documentation, presented as-is); verify against the code when precision matters.

The extension seam is the small, stable public API for **observing and
extending a single agent turn** without importing engine internals. It is the
one hook path the shared chat engine (`runChat`) fires — internal consumers and
external plugins ride the same mechanism, so there is no private callback plus a
parallel plugin API to drift apart.

For the broader "plug in a new agentic idea" seams (model provider, exploration
strategy, inference loop, runtime surface), see `EXTENSIBILITY.md`. This document
is only about the per-turn hooks.

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
  onToolResult({ toolName, result }) { /* each tool result (≤1000 chars) */ },
  onTurnEnd({ text, responseMessages }) { /* after the turn settles */ },
};
```

Two more hooks go beyond observation:

- **`registerTools(): ToolSet`** — contribute tools into the turn's tool set.
  Called once at turn start. Contributed tools are merged with (and never shadow)
  the caller's built-in tools; a name collision **between two extensions** throws
  so a plugin can't silently override another's tool.
- **`prepareStep(ctx): ModelMessage[] | undefined`** — a message-transform hook
  at each step boundary. Return a replacement message array to rewrite what the
  model sees for that step, or `undefined` to leave it unchanged. Hooks are
  chained across extensions — each sees the prior extension's output. This is the
  seam the CLI backend's mid-turn steering drain rides.

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
  → (registerTools folded into the ToolSet the model receives)
  → prepareStep        ── at each step boundary
  → onToolCall         ── as each tool call streams
  → onToolResult       ── as each tool result returns
onTurnEnd
```

Within a single hook, every registered extension runs in **registration order**.
`prepareStep` chains: extension N sees extension N-1's rewritten messages.

## Internal consumer: steering drain

The CLI backend's mid-turn steering (`LocalAgentSession`) is itself an
extension registered as `proteus.steering` with a `prepareStep` hook — it drains
pending steers into a single user message appended after the latest tool results
at each step boundary. There is deliberately no second, private hook path: the
engine drives internal consumers and external plugins through the same
`ExtensionHost`.

## Notes

- Hooks may be async; the engine awaits them. Keep them fast — they run on the
  turn's hot path.
- `onToolResult.result` is truncated to 1000 characters (the same bound the
  streamed `tool-result` event uses).
- The seam is intentionally tiny. It observes and lightly rewrites a turn; it is
  not a place to re-implement the loop. For a new loop, use the InferenceLoop
  seam in `EXTENSIBILITY.md`.

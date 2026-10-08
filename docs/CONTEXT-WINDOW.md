# The context window

This is what Kinu sends a model on every request: the order of the bytes, which of them a provider caches, how
they grow from one step and one turn to the next, and what a hired agent or a swarm node sees instead. Both
backends build every request through the same core code, so this holds for the cloud and for the CLI unless a
line says otherwise.

The rule behind the layout is prefix caching. A provider reuses the longest prefix of a request it has seen
before and stops at the first byte that differs. So the bytes that are the same for every workspace come first,
then the bytes of one workspace, then those of one agent, and live state comes last, as small additions that never
rewrite what came before them.

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="diagrams/context-request-dark.svg">
  <img alt="One request in order: tool definitions; the system prompt as the core every workspace shares, the lead doctrine, the workspace part and the agent part; then messages: the sealed copy of unapproved instruction files, the dynamic-context block, the conversation with its frozen delta blocks, a turn's own skill bodies and the person's request. Markers show where each provider caches." src="diagrams/context-request.svg" width="900">
</picture>

## One request, in order

| Part | What is in it | Changes when | Code |
|---|---|---|---|
| Tool definitions | The native tools this agent may call in this work mode, then MCP and extension tools | The role, the work mode, an active skill's tool restriction, or an MCP server connecting | `profile.allowedTools`; `composeTurn` in `cf-backend/src/actor-agent.ts`, `composeNextRequest` in `cli-backend/src/local-session.ts` |
| System: core | Operating guidance, the execution environments this workspace has, the tool index, persistence, code execution, delegation, background work, verification, output format | The tool list, or a promoted prompt section | `buildSystemPromptSync`, `packages/core/src/prompt.ts` |
| System: lead doctrine | Seven sections on briefing, parallel work, review, interruptions and delivery | Never between turns; only a root agent that can hire has it | same |
| System: workspace | `SOUL.md`, owner-approved `AGENTS.md`, the skills index, pinned skill bodies | The owner edits one of them | same |
| System: agent | The agent's and workspace's names, the role section | A rename or a role change | same |
| Unapproved instruction files | `AGENTS.md` and skill files nobody approved, sealed in `<workspace_instructions>` as reference material | Their bytes change | `renderUnverifiedInstructions`, `prompt.ts` |
| Dynamic context | Runtime facts (backend, model, working directory, date), why the turn runs, work mode, tasks, jobs, delegates, approvals, executor and device status, facts, memory tail | Any of that state changes | `DynamicContextLedger`, `packages/core/src/prompting/volatile-context.ts` |
| Conversation | Earlier turns, with their dynamic blocks where they were first sent | Only by appending, until a cold cache or compaction | `assembleTurnMessages`, `orchestrator/turn-context.ts` |
| A turn's skills | The bodies of skills the person named with `/name`, for this turn only | Every `/name` turn; never stored | `activatedSkillsBlock`, `orchestrator/turn-surface.ts` |
| The request | The person's message, or the event that woke the turn | Every turn | |

Live state is not in the system prompt. A new day, a model switch, a new working directory or a device going
offline changes only the dynamic block's sections that name it. Plan mode states itself in the dynamic block;
a plain build turn states no mode, because operating guidance says that no mode section means Build.

## Where each provider caches

| Provider | Markers | Routed by | Idle lifetime Kinu assumes (default / long retention) |
|---|---|---|---|
| Anthropic | Last tool (cloud only), end of the system prompt, and the last two messages, moved to the new tail on every step | the prefix | 5 minutes / 1 hour |
| OpenAI | none: the provider caches the prefix itself | the prefix | 60 minutes / 24 hours |
| Codex | none | `session_id`, the workspace; `conversation_id` and `x-client-request-id`, the conversation (`chatgptSessionHeaders`, `providers/codex.ts`) | 60 minutes / 24 hours |
| ChatGPT sign-in | none | the same headers | 60 minutes |
| OpenRouter, Claude models | Same places as Anthropic, as `cache_control` | the prefix | 5 minutes / 1 hour |
| OpenRouter other models, AI Gateway | none | the prefix | 60 minutes |
| Workers AI | none: `x-session-affinity` pins the conversation to one replica, whose prefix cache holds the request | the conversation | 60 minutes |
| any other provider | none | the prefix | 60 minutes |

The strategy map and the lifetimes are `resolvePromptCacheStrategy` and `promptCacheLifetimeMs` in
`packages/core/src/prompting/cache-breakpoints.ts`. The lifetimes are the providers' documented ones where a
provider documents one, and 60 minutes where none does; none is measured here. A request with retention `none`
gets no markers. No request carries a `prompt_cache_key`: one would split the static prompt's cache by conversation.

The conversation and workspace a call is routed under (`actorAffinity`, `providers/workers-ai.ts`):

- The workspace's own agent on the cloud: `kinu-<agent name>`, one key across its conversations and its swarm nodes (`owned-model-services.ts`).
- A hired agent on the cloud: `kinu-<its own name>` (`agent-facet/agent-turn.ts`).
- A CLI session: `kinu-<workspace name>` (`local-session.ts`); a CLI hire, `kinu-<its own name>` (`runtime.ts`).
- Every actor's workspace: `kinu-workspace-<workspace id>`, so the conversations of one workspace share ChatGPT's session.

At each step the request is the previous request plus the new tool calls and results, and perhaps one delta
block. The previous request's tail markers sit just before the new messages, so the whole previous request is
read from the cache and only the new tail is written. Markers are placed last in the step pipeline, after pruning,
the dynamic weave and steering, so no later rewrite moves them (`composePrepareStep`, `prompting/prepare-step.ts`).

## How the context grows

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="diagrams/context-growth-dark.svg">
  <img alt="Requests over two turns. The first request of a turn carries one full dynamic block just before its input. A later step appends tool results and, when state changed, a delta block after them. The next turn adds a delta before its input. After the cache goes cold, the stored blocks collapse into one full block. At 85 percent of the window, compaction first drops the superseded blocks, then runs its ladder." src="diagrams/context-growth.svg" width="900">
</picture>

**Within a turn.** Each step runs `composePrepareStep` in this order: the mission budget guard, tool-error
feedback, the extension chain (mid-turn steers and events land here), step pruning, the dynamic weave, the turn's
`/name` skills just before its input, replay normalization for the destination provider, and the cache markers
last.

- The ledger renders live state every step and adds a block only when the render changed.
- At a turn's first step the block goes just before the turn's input, so the request stays the last thing the model reads. On a later step it goes at the tail, after the newest tool results.
- A block's position is frozen once sent. A slot that a tool result has since taken puts the block after the call and its result, never between them.
- A change is a delta: only the sections that changed, and in a list only the rows that changed, keyed by id. A delta names the state it applies to (`state="..."`); a full block carries only its fingerprint.
- A full block replaces the deltas when it is no longer than the delta, or when the deltas since the last full block would pass six times its size. The share of six is measured: glm-5.3 read the task list back 10 of 10 at every share up to 20 row deltas, 6.5 full blocks (`KEYFRAME_SHARE`, commit 59bfdbe59, 2026-09-24).
- Step pruning shrinks the oldest tool outputs when a request nears the window less the output reserve, in quarter-window batches so the cut point holds still between steps (`prompting/step-prune.ts`). The newest result is never pruned.
- A mid-turn steer lands at the step tail as one durable user message; a `/name` in it brings that skill's body with it.

**Across turns.** The blocks a turn sent are stored with its history and read back by the next turn, which adds
a delta before its own input if state changed. Nothing before it moves.

- **Cold cache.** If the previous request is older than its provider's idle lifetime, nothing is cached anyway, so rewriting is free: the stored blocks collapse into one full block before the new input (`promptCacheWarm`, `orchestrator/actor-session.ts`).
- **Compaction.** At 85 % of the context window (the default `light` preset; it compacts to 35 %), the first rung drops every superseded dynamic block and keeps one full block at the newest position. Only then does the ladder run: older images and files move to the agent's home, each left as a `vfs://` link its `file` tool opens again (the newest two images stay), then superseded file reads, failed tool inputs, old tool output, reasoning, the remaining tool output, then assistant runs, with a prefix summary as the last resort (`packages/compaction`).

## What a hired agent and a swarm node see

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="diagrams/context-actors-dark.svg">
  <img alt="Three columns: the workspace's own agent, a hired agent and a swarm node, each with its tools, system prompt, opening messages, dynamic context and cache key." src="diagrams/context-actors.svg" width="900">
</picture>

| | The workspace's own agent | A hired agent (durable or task) | A swarm node |
|---|---|---|---|
| Tools | Its role's tools in this work mode, `agents` included | Its role's tools, `agents` within its depth; `report` on a turn its parent drove | `eval`, `shell`, `file`, `web`, `report`; never `agents`, `memory` or `tasks` |
| System prompt | Core, lead doctrine, workspace, agent | Core, workspace, agent; no lead doctrine | The search's half, then the node's: its isolation, and that only its `report` counts |
| Opening messages | The conversation | The parent's brief; with `context: 'inherit'`, the parent's conversation before it | The node's seed; with `context: 'inherit'`, the parent's conversation before it |
| Dynamic context | Every plane | Its own runtime facts, tasks, jobs and hires; no memory tail | Its runtime facts and its own state; no memory tail, no delegates |
| Cache key (cloud) | `kinu-<agent>` | `kinu-<agent>`, its own | `kinu-<search root>`, shared by the search |

Sources: `assignedTurnFraming` (`prompt.ts`), `hostedActorDynamicContext` (`cf-backend/src/orchestrator.ts`),
`nodeSystemPrompt` and `NODE_WITHHELD_TOOLS` (`packages/core/src/strategy/node-agent.ts`),
`explorationDynamicContext` (`cf-backend/src/hosted-actors.ts`).

## Measured

| What | Number | When, where |
|---|---|---|
| System prompt shared by the root agents of two different workspaces | 22,460 of 23,457 chars; 9 before the reorder | 2026-10-02, `buildSystemPromptSync` at ba5cc1b66 against 89c5b58ef |
| The same prompt on the next day, or with a device gone offline | all 23,457 chars; 23,560 and 1,387 before | same |
| The lead doctrine's share of a root agent's system prompt | 14,240 of 21,872 chars | same |
| Two hires of different roles (researcher, auditor), at the provider | tools identical (22,521 chars); system prompt shares 7,124 of 9,582 and 10,594 | 2026-10-03, request bodies at the gateway, fd89184ba |
| The root agent in Build and in Plan | tools share 22,298 of 29,186 and 30,314; system prompt 22,192 of 29,245 and 29,300 | same |
| The root agent and a task hire | tools share 2,059; system prompt 3,251 | same |
| `eval`'s tool definition after the slates API moved into the slates skill | 1,829 chars shorter | 2026-10-02, 2d1fd2fb7 |

The tool definitions follow the agent's role and work mode, so a mode switch and a root-to-hire boundary each
start a new tools prefix. Hit rates on live providers after this layout are unmeasured.

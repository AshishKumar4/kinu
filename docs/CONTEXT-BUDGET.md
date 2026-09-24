# Context budget: digest plus reference

Bulk bound for the model enters the root's context as a bounded digest plus a resolvable reference to the lossless whole. Below the threshold it inlines untouched, because making a root fetch its own ordinary material costs a round trip and gains nothing.

Tool-borne bulk (stdout, fetched pages, MCP responses) clamps at 2,000 estimated tokens: 8,000 chars through `estimateTokens`/`admissionBytes`, not a tokenizer and not any provider's count (`DEFAULT_TOOL_RESULT_MAX_CHARS` in `packages/core/src/tools/clamp.ts`). Message-borne bulk (attachments and pasted documents) clamps at 8 KiB (`INLINE_TEXT_MAX_BYTES`). Every clamp writes the full payload somewhere the agent can read it back; a digest without that copy is data loss.

The cap covers the whole string the model receives. The truncation marker is priced inside it. A producer that frames its output (the shell's `file` steer, a fetched page's provenance header) composes the whole string and clamps that, so one call owns the cap, the spill and the accounting. A marker or header added on top of a full budget would put the result over budget by the length of its framing.

## The producers, and where each one spills

| Producer | Digest kept inline | Resolvable reference | Code |
|---|---|---|---|
| `shell`, `web` fetch, `eval` results | head + tail (8k chars) | `.kinu/tool-output/<id>.log` | `core/src/tools/clamp.ts` |
| `file` read of an oversize file | offset-bounded page (8k chars) | the file's own path, and the next offset in the marker | `core/src/tools/file-tool.ts` |
| MCP / external tool results | head + tail (8k chars) | same | `withClampedToolResults` at each backend's MCP wiring |
| Attachments the model cannot accept | reference text part | `attachments/<hash>.<ext>` | `core/src/prompting/attachment-sanitizer.ts` |
| Text attachments over 8 KiB | reference text part | same | same |
| Documents the model can accept, over 1 MiB | reference text part | same | same |
| Pasted user text over 8 KiB | 2,000-char head + address | same | same |
| Subordinate reports / peer replies | `EVENT_BRIEF_MAX_CHARS` brief, 600 chars | `.kinu/event-content/<hash>.txt` | `core/src/events/hub/content-spill.ts` |
| Compacted history ranges | checkpoint summary | `.kinu/compaction/<sessionKey>/<rangeHash>.md` | `packages/compaction/src/stores.ts` |

`SPILL_DIRS` (`packages/core/src/context-budget.ts`) owns the four directories. Paths are unrooted and resolve at the workspace root. A `file` read writes nothing: its source path already addresses the whole, and the marker gives the next offset.

Accepted images are exempt: a spilled image is bytes the agent can read but cannot see. Documents keep the ceiling because the agent can extract them in the sandbox or slice and summarize them.

## The turn ledger

`TurnContextBudget` (`packages/core/src/context-budget.ts`) adds up what one turn's root ingested and what it withheld. It records; it does not clamp.

- Every producer calls `admit` with the chars the root actually received and `recordSpill` with what it never saw.
- The budget is per root. Use `TurnAccumulator.context`, reset with the turn, or a fresh `TurnContextBudget`. Roots never share a ledger.
- `buildNodeToolSet` (`packages/core/src/strategy/node-agent.ts`) passes no `contextBudget`. A swarm node has its own budget and no `context_budget` row.

A turn-cumulative second cap (after 120,000 admitted chars, the per-result cap dropped to an 8,000-char floor) was removed on 2026-09-20. Once the per-result cap itself fell to 8,000 chars, that cap could never fire.

## Tool definitions

A tool result arrives once. A tool definition (description and JSON Schema) rides every request of every step, and for MCP a third party writes it. An unbounded catalog lets a stranger spend the user's context window.

There is no separate MCP limit. `stepContextLimit` (`packages/core/src/prompting/step-prune.ts`) is the one request-level allocation: the resolved model's context window minus the output allowance the answer needs (`outputReserveTokens`). The step-prune pass shrinks tool outputs toward it. The actor's builtin tools are priced first; a remote catalog is admitted against what the limit has left, measured on the same scale (`toolSurfaceTokens`, `packages/core/src/tools/mcp-surface.ts`).

`admitMcpDescriptors` (same file) admits in `(server, tool)` name order, so two turns that read the same rows admit the same set:

- A schema is never truncated. A clipped schema lies about what the tool accepts. A descriptor whose schema will not fit is deferred whole.
- Prose gets equal shares of what remains, re-divided at every descriptor, so one server's long descriptions cannot crowd out the rest. There is no per-description percentage to tune.
- Every deferral is reported through the same missing-capability channel a disconnected server uses, so the model knows what it lacks.

## The counters

The settle spine (`packages/core/src/orchestrator/turn-lifecycle.ts`) writes one durable
`context_budget` event beside `turn_end`. Turns that neither admit nor spill bulk
write none.

| Field | Meaning |
|---|---|
| `admittedChars` | tool-result chars this turn's root actually ingested (post-clamp) |
| `omittedChars` | chars withheld and spilled (bytes, for binary payloads) |
| `trips` | spill count per producer (`shell`, `file_read`, `web_fetch`, `eval`, `external_tool`, `attachment`, `pasted_text`) |
| `referenced` | trips whose spill write landed, so the reference resolves |
| `followUps` | tool calls this turn that cited a spill address (the reference was used, not just emitted) |

`RunEventRecorder.read(runId, { types: ['context_budget'] })` reads the event. `followUps` counts calls naming a spill directory: a read-back, a hire whose mission names one, or a swarm node given a spill path. Fewer than one trip per 50 real turns means the mechanism is not worth tuning.

## Pre-registered decision thresholds

These were recorded before any numbers existed. `M2` means (a) single-query digestion and (b) multi-episode continuation across forced compaction boundaries. Neither arm has been measured.

| Change | Ships permanently if | Reverts if |
|---|---|---|
| Ingress unification (spill every message-borne bulk producer) | correctness-motivated, so it ships on tests; counters retained | n/a |
| Turn-cumulative egress budget | M2(a) pass-rate delta CI excludes 0 in favor, and the 159-task defect bench + M2(b) show no regression (CI excludes -5pp) | any regression on the existing bench. Removed 2026-09-20: unreachable once the per-result cap fell to the floor |
| The per-result cap (2,000 estimated tokens) | owner-specified on 2026-09-20; unmeasured: no bench or M2 arm has run against it | n/a |

The bench is the seeded-defect corpus described in [Bench](BENCH.md). Its patches under
`bench/corpus/patches/` numbered 159 on 2026-08-19, 157 on 2026-08-24 after
drifted fixtures were retired, and 156 on 2026-09-22. The MDE calculation in
[Bench](BENCH.md) sets final power.

# Context budget: digest plus reference

One rule governs model-bound bulk:

> Bulk that enters the root's context arrives as a bounded digest. A resolvable
> reference points at the lossless whole. Below the threshold it inlines untouched.
> When a root fetches its own ordinary material, it pays a round trip and gains nothing.

Tool-borne bulk (stdout, fetched pages, MCP responses) clamps at 40,000 chars
(`DEFAULT_TOOL_RESULT_MAX_CHARS`). Message-borne bulk (attachments and pasted
documents) clamps at 8 KiB (`INLINE_TEXT_MAX_BYTES`). Every clamp writes the
full payload somewhere the agent can read it back. Without that whole, a digest
is data loss.

## The producers, and where each one spills

| Producer | Digest kept inline | Resolvable reference | Code |
|---|---|---|---|
| `run`, `web` fetch, `execute_tools` results | head + tail (40k) | `.kinu/tool-output/<id>.log` | `core/src/tools/clamp.ts` |
| `file` read of an oversize file | offset-bounded page (40k) | the file's own path, and the next offset in the marker | `core/src/tools/file-tool.ts` |
| MCP / external tool results | head + tail (40k) | same | `withClampedToolResults` at each backend's MCP wiring |
| Attachments the model cannot accept | reference text part | `attachments/<hash>.<ext>` | `core/src/prompting/attachment-sanitizer.ts` |
| Text attachments over 8 KiB | reference text part | same | same |
| Documents the model *can* accept, over 1 MiB | reference text part | same | same |
| Pasted user text over 8 KiB | 2,000-char head + address | same | same |
| Subordinate reports / peer replies | `EVENT_BRIEF_MAX_CHARS` brief, 600 chars | `.kinu/event-content/<hash>.txt` | `core/src/events/hub/content-spill.ts` |
| Compacted history ranges | checkpoint summary | `.kinu/compaction/<session>/<range>.md` | `@kinu.run/compaction` `stores.ts` |

`SPILL_DIRS` in `core/src/context-budget.ts` owns the four directories. Paths
are unrooted and resolve at the workspace root. A `file` read writes nothing.
Its source path already addresses the whole, and the marker gives the next
offset.

Accepted images are exempt. A spilled image is bytes the agent can read but
cannot see. Documents keep the ceiling because the agent can extract them in
the sandbox or slice and summarise them.

## The turn-cumulative budget

Eight individually valid results can still bury the root, so `TurnContextBudget`
makes the clamp turn-cumulative:

- Admit full per-result text through 120,000 chars, enough for three full-size
  navigation reads.
- Then cap each result at 8,000 chars. Spill the full text and keep the same
  marker recipe.
- Result N depends only on results 1..N-1, so replay clamps identically.
- The budget is per root. Use `TurnAccumulator.context`, reset with the turn,
  or a fresh `TurnContextBudget`. Roots never share a ledger.

`buildNodeToolSet` (`core/src/strategy/node-agent.ts`) passes no
`contextBudget`. A swarm node has its own budget and no `context_budget` row.
`clampToolResult` writes a tightened-cap reason into the marker, where the
model can act on it. It does not go in the system prompt.

A tool result is bulk that arrives once. A tool *definition* is different.
The description and the JSON Schema ride every request of every step. For MCP a
third party writes them, so an unbounded catalog is a stranger spending the
user's window.

There is no MCP number. `stepContextLimit` (`core/src/prompting/step-prune.ts`)
is the one request-level allocation. It holds the resolved model's context window
minus the output allowance the answer needs (`outputReserveTokens`). The step-prune
pass shrinks tool outputs toward it. A remote catalog is admitted against what
that limit has left after the actor's own tool surface, measured on one shared
scale (`toolSurfaceTokens`, `cf-backend/src/user/mcp.ts`). The actor's builtins
are not negotiable. They are priced first.

`admitMcpDescriptors` then admits in `(server, tool)` name order, so two turns
that read the same rows admit the same set:

- A schema is never truncated. A clipped schema lies about what the tool
  accepts, so a descriptor whose schema will not fit is deferred whole.
- Prose gets equal shares of what remains, re-divided at every descriptor. One
  server's essay cannot crowd out the rest. No per-description percentage
  exists to tune.
- Every deferral is reported through the same missing-capability channel a
  disconnected server uses. Nothing stays silently absent for the model to plan
  without.

## The counters

The settle spine (`core/src/orchestrator/turn-lifecycle.ts`) writes one durable
`context_budget` event beside `turn_end`. That event is the denominator. Turns
that neither admit nor spill bulk write none.

| Field | Meaning |
|---|---|
| `admittedChars` | tool-result chars this turn's root actually ingested (post-clamp) |
| `omittedChars` | chars withheld and spilled (bytes, for binary payloads) |
| `trips` | spill count per producer (`run`, `file_read`, `web_fetch`, `execute_tools`, `external_tool`, `attachment`, `pasted_text`) |
| `referenced` | trips whose spill write landed, so the reference resolves |
| `tightened` | trips clamped at the floor because the turn's admit budget was spent |
| `followUps` | tool calls this turn that cited a spill address (the recipe being *used* rather than emitted) |

`RunEventRecorder.read(runId, { types: ['context_budget'] })` reads the event.
`followUps` counts calls naming a spill directory, including read-back, a
temporary agent given `context_ref`, and a swarm node given a spill path. Fewer than
one trip per 50 real turns means the mechanism is not worth tuning.

## Pre-registered decision thresholds

I recorded these before the numbers existed. `M2` means (a) single-query
digestion and (b) multi-episode continuation across forced compaction
boundaries. Neither arm is measured yet.

| Change | Ships permanently if | Reverts if |
|---|---|---|
| Ingress unification (spill every message-borne bulk producer) | correctness-motivated, so it ships on tests; counters retained | n/a |
| Turn-cumulative egress budget | M2(a) pass-rate delta CI excludes 0 in favour, **and** the 159-task defect bench + M2(b) show no regression (CI excludes −5pp) | any regression on the existing bench |
| The 120,000 / 8,000 constants | tuned on M2, not on intuition | n/a |

The bench is the seeded-defect corpus in `docs/BENCH.md`. Its patches under
`tests/bench/patches/` numbered 159 on 2026-08-19 and 157 on 2026-08-24 after
drifted fixtures were retired. `docs/BENCH.md`'s MDE math governs final power.

# Context Budget — the reference-plus-digest invariant, enforced

One rule governs every payload that can reach the model's token stream.

> **Anything bulk that enters the root's context arrives as a bounded digest plus a resolvable reference to the lossless whole.** Below the threshold it inlines untouched. Making a root fetch its own ordinary material costs a round trip and buys nothing.

The threshold is expressed in chars and bytes at two scales. Tool-borne bulk (a
command's stdout, a fetched page, an MCP response) clamps at **40,000 chars**
(`DEFAULT_TOOL_RESULT_MAX_CHARS`). Message-borne bulk (an attachment, a pasted
document) clamps at **8 KiB** (`INLINE_TEXT_MAX_BYTES`). Every clamp writes the
full payload somewhere the agent can read it back. A digest with no readable
whole is data loss.

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
| Subordinate reports / peer replies | 600-char brief | `.kinu/event-content/<hash>.txt` | `core/src/events/hub/content-spill.ts` |
| Compacted history ranges | checkpoint summary | `.kinu/compaction/<session>/<range>.md` | `@kinu.run/compaction` `stores.ts` |

`SPILL_DIRS` in `core/src/context-budget.ts` is the single source of truth for
those four directories, and every producer builds its paths from it. The paths
are written unrooted, so they resolve at the workspace root for every surface
that reads them. A `file` read is the one producer that writes nothing. The
whole text is already addressable at its own path, so the marker names the
offset that continues it instead.

**Accepted images are deliberately exempt from the size ceiling.** A spilled
image is a file the agent can read as bytes and still cannot *see*, so the
reference would not be resolvable in any useful sense. Documents (PDF) keep the
ceiling because there are real read-back recipes for them: extract in the
sandbox, or slice and summarise.

## The turn-cumulative budget

A per-result cap leaves a gap. Eight in-budget results still bury the root, and
they persist in durable history until the compaction ladder reaps them. So the
clamp is also **turn-cumulative** (`TurnContextBudget`):

- The turn admits tool-result text at the full per-result cap until it has taken
  **120,000 chars**. That is three full-size results, enough for the navigation
  reads that open a turn.
- After that, the per-result cap for the remainder of the turn drops to **8,000
  chars**. Full text is still spilled and the marker recipe is unchanged; the
  root stops paying for the bulk inline.
- The cap for result N is a pure function of the sizes of results 1..N-1, so a
  replayed turn clamps identically.
- The budget is **per root**. Every toolset build either receives its root's
  accumulator budget (`TurnAccumulator.context`, which resets with the rest of
  the turn's accounting) or gets a fresh `TurnContextBudget`, so no two roots
  share one ledger.

A swarm node is a root of its own by that rule. It builds its own tool surface
in `buildNodeToolSet` (`core/src/strategy/node-agent.ts`) and passes no
`contextBudget`, so it clamps against a budget nobody else can spend. A node
writes no `context_budget` row, because that row comes from an actor's settle
spine and a node has none.

`clampToolResult` appends the reason to the truncation marker when the cap has
tightened, rather than stating it in the system prompt. The fact reaches the
model where it is actionable and costs nothing on the turns that never reach
the floor.

This is RLMEnv's "the root sees a bounded slice of REPL output per iteration"
made deterministic at the point Kinu already owned, with no new subsystem,
mode or flag.

## The counters

Every trip is recorded on the same object. The turn's settle spine
(`core/src/orchestrator/turn-lifecycle.ts`) writes one durable `context_budget`
run event beside `turn_end`, which is the denominator; a turn that neither
admitted nor spilled bulk writes no row.

| Field | Meaning |
|---|---|
| `admittedChars` | tool-result chars this turn's root actually ingested (post-clamp) |
| `omittedChars` | chars withheld and spilled (bytes, for binary payloads) |
| `trips` | spill count per producer (`run`, `file_read`, `web_fetch`, `execute_tools`, `external_tool`, `attachment`, `pasted_text`) |
| `referenced` | trips whose spill write landed, so the reference resolves |
| `tightened` | trips clamped at the floor because the turn's admit budget was spent |
| `followUps` | tool calls this turn that cited a spill address (the recipe being *used* rather than emitted) |

Query them like any other run event (`RunEventRecorder.read(runId, { types:
['context_budget'] })`). `followUps` counts any call whose arguments name a
spill directory, which covers the three shapes the recipe takes: a plain
read-back, a `slice + llm.query` burst over a spilled file, and a swarm node
handed a spill path.

The counters measure how often the real workload crosses the bulk thresholds at
all, which is the prior question every context-management decision depends on. A
mechanism whose counters show fewer than one trip per 50 real turns is not worth
tuning, whatever the paper number looks like.

## Pre-registered decision thresholds

Recorded before the numbers exist, so they cannot be argued into significance
afterwards. `M2` is this document's label for the long-context/long-horizon
bench slice: **(a)** single-query digestion, **(b)** multi-episode continuation
across forced compaction boundaries. Neither arm is measured yet.

| Change | Ships permanently if | Reverts if |
|---|---|---|
| Ingress unification (spill every message-borne bulk producer) | correctness-motivated, so it ships on tests; counters retained | n/a |
| Turn-cumulative egress budget | M2(a) pass-rate delta CI excludes 0 in favour, **and** the 159-task defect bench + M2(b) show no regression (CI excludes −5pp) | any regression on the existing bench |
| The 120,000 / 8,000 constants | tuned on M2, not on intuition | — |

The bench is the seeded-defect corpus in `docs/BENCH.md`; its 159 patches under
`tests/bench/patches/` were counted on 2026-08-19. The constants above are
pre-registrations rather than derivations, and they encode "meaningful and
detectable at bench power". `docs/BENCH.md`'s MDE math governs final power.

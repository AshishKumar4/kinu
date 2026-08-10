# Context Budget — the reference-plus-digest invariant, enforced

> Maintained by Claude (AI-edited documentation, presented as-is); verify against the code when precision matters.

One rule governs every payload that can reach the model's token stream:

> **Anything bulk that enters the root's context arrives as a bounded digest plus a resolvable reference to the lossless whole.** Below the threshold it inlines untouched — a root that has to fetch its own ordinary material is worse off, not better.

The threshold is expressed in chars/bytes at two scales: **40,000 chars** for tool-borne bulk (a command's stdout, a fetched page, an MCP response) and **8 KiB** for message-borne bulk (an attachment, a pasted document). Never digest-only: a spill that cannot be read back is data loss, not context management.

## The producers, and where each one spills

| Producer | Digest kept inline | Resolvable reference | Code |
|---|---|---|---|
| `run`, `web` fetch, `execute_tools` results | head + tail (40k) | `/.proteus/tool-output/<id>.log` | `core/src/tools/clamp.ts` |
| MCP / external tool results | head + tail (40k) | same | `withClampedToolResults` at each backend's MCP wiring |
| Attachments the model cannot accept | reference text part | `/local/attachments/<hash>.<ext>` | `core/src/prompting/attachment-sanitizer.ts` |
| Text attachments over 8 KiB | reference text part | same | same |
| Documents the model *can* accept, over 1 MiB | reference text part | same | same |
| Pasted user text over 8 KiB | 2,000-char head + address | same | same |
| Subordinate reports / peer replies | 600-char brief | `/local/.proteus/event-content/<hash>.txt` | `core/src/events/hub/content-spill.ts` |
| Compacted history ranges | checkpoint summary | `/local/.proteus/compaction/<session>/<range>.md` | `@proteus/compaction` `stores.ts` |

`SPILL_DIRS` in `core/src/context-budget.ts` is the single source of truth for those addresses; every producer builds its paths from it.

**Accepted images are deliberately exempt from the size ceiling.** A spilled image is a file the agent can read as bytes and still cannot *see*, so the reference would not be resolvable in any useful sense. Documents (PDF) keep the ceiling because there are real read-back recipes for them — extract in the sandbox, or slice and summarise.

## The turn-cumulative budget

A per-result cap is not the whole policy: eight in-budget results still bury the root, and they persist in durable history until the compaction ladder reaps them. So the clamp is also **turn-cumulative** (`TurnContextBudget`):

- The turn admits tool-result text at the full per-result cap until it has taken **120,000 chars** (three full-size results — enough for the navigation reads that open a turn).
- After that, the per-result cap for the remainder of the turn drops to **8,000 chars**. Full text is still spilled and the marker recipe is unchanged; the root simply stops paying for the bulk inline.
- The budget is a pure function of this turn's earlier result sizes, so a replayed turn clamps identically.
- It is **per root**: the accumulator owns one per turn and resets it with the rest of the turn's accounting, while a fork or a subordinate builds its own toolset and therefore budgets its own turns.

The system prompt's `## Delegation` section states the mechanism, because a model that knows *why* a late read came back short reaches for a rung of the ladder instead of re-running the command.

This is RLMEnv's "the root sees a bounded slice of REPL output per iteration" made deterministic at the seam Proteus already owned — not a new subsystem, no mode, no flag.

## The counters

Every trip is recorded on the same object and written once per turn as a durable `context_budget` run event, beside `turn_end` (which is the denominator — turns that never touch bulk write no row):

| Field | Meaning |
|---|---|
| `admittedChars` | tool-result chars this turn's root actually ingested (post-clamp) |
| `omittedChars` | chars withheld and spilled (bytes, for binary payloads) |
| `trips` | spill count per producer (`run`, `web_fetch`, `execute_tools`, `external_tool`, `attachment`, `pasted_text`) |
| `referenced` | trips whose spill write landed, so the reference resolves |
| `tightened` | trips clamped at the floor because the turn's admit budget was spent |
| `followUps` | tool calls this turn that cited a spill address — the recipe being *used*, not just emitted |

Query them like any other run event (`RunEventRecorder.read(runId, { types: ['context_budget'] })`). `followUps` counts any call whose arguments name a spill root, which covers the three shapes the recipe takes: a plain read-back, a `slice + llm.query` burst over a spilled file, and a fork handed a spill path.

These exist to answer the prior question every context-management decision depends on: **how often does the real workload cross the bulk thresholds at all?** A mechanism whose counters show fewer than one trip per 50 real turns is not worth tuning, whatever the paper number looks like.

## Pre-registered decision thresholds

Recorded before the numbers exist, so they cannot be argued into significance afterwards. `M2` is the long-context/long-horizon bench slice: **(a)** single-query digestion, **(b)** multi-episode continuation across forced compaction boundaries.

| Change | Ships permanently if | Reverts if |
|---|---|---|
| Ingress unification (spill every message-borne bulk producer) | correctness-motivated — ships on tests; counters retained | n/a |
| Turn-cumulative egress budget | M2(a) pass-rate delta CI excludes 0 in favour, **and** the 176-task bench + M2(b) show no regression (CI excludes −5pp) | any regression on the existing bench |
| The 120,000 / 8,000 constants | tuned on M2, not on intuition | — |

The constants above are pre-registrations, not derivations: they encode "meaningful and detectable at bench power". `docs/BENCH.md`'s MDE math governs final power.

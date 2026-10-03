# Self-evolution redesign

Status: approved by the owner on 2026-10-02, with revisions. Once built, it replaces the turn, session and lifetime loops in [EVOLUTION.md](./EVOLUTION.md).

## The goal and what is wrong today

The agent improves while it is used: in the background it proposes small edits to its own prompts, tool descriptions, schemas and scaffold. An edit is promoted without the user's approval, but only after tests, and kept only if users are more satisfied with it.

Today's nine loops have five defects. A clean exit counts as success: with no follow-up, the last acting tool call decides the verdict (`executionVerdict`, `packages/core/src/evolution/outcomes.ts:116`). The classifier (`classifyTurnOutcome`, `outcomes.ts:202`) has no label set behind it. Shadow trials and GEPA's scaffold metric run candidates with live tools, files and memory (`scaffold/executor.ts:464`). A candidate is judged only on the turns that motivated it, never on turns that went well. And no loop has evidence of a gain.

## The design in one paragraph

Two signals: rated satisfaction says whether the user was served; struggles say where the agent fought its tools. One proposer, with GEPA as its search, turns low-rated turns or a cluster of struggles into one small edit. GEPA scores candidates by a judge reading recorded turns, so nothing executes, and a frozen set of good turns sits inside its loop. A live trial on prompt-cache segments keeps the edit only if satisfaction rises with confidence and the struggle guardrails hold. The memory, lesson, crafted-tool, recovery, consolidation, refinement and experience loops stay, reading the new signals.

## 1. The satisfaction signal

### What is rated

A decision model reads the request, the agent's tool calls with their status, its answer, and the user's next message, and answers three typed questions:

| Question | Type | Answer |
|---|---|---|
| `satisfaction` | score, 5 levels | 1 rejects or gives up; 2 corrects or asks again; 3 says nothing either way; 4 builds on it or moves on; 5 approves or thanks |
| `corrected` | yes/no | Did the user say the agent got something wrong, left part undone, or ask again for something it should already have done? New information, a changed requirement or a new task is not a correction. |
| `wrong` | choice | `nothing`, `misunderstood`, `incomplete`, `incorrect`, `ignored_instruction`, `broke_something`, `unrecovered_error`, `verbose_or_slow`, `needless_question` |

- An explicit rating overrides the model: thumbs up is 5, thumbs down 1; a take pick of the delivered answer is 4, of an alternate 2. The CLI has no thumbs, so there the model rates.
- A turn the user never answered stays unrated. No rule infers a verdict from tool exits.
- Rating runs off the turn path, after the next message arrives.
- Ratings replace the verdict columns of `turn_outcomes`, with sources `thumbs`, `take_pick` and `model`.

### The model setting

The account's Models settings gain a **Decision model** field, default Workers AI Clef (`@cf/cloudflare/clef`); Clef-flash, Jev or any System One API model can replace it. The cf backend calls the Workers AI binding; the CLI uses the provider path a Workers AI chat model uses.

### Measured on real Kinu turns

On 2026-10-02, Clef and Clef-flash rated every eval turn in `kinu-logs/evals-fast` with a following user message: 185 real agent turns with scripted replies. Forty were also paired with a written correction, repeat and thanks. Data: `/mnt/scratch/kinu/kinu-logs/evals-fast/clef-satisfaction/`.

| | Clef | Clef-flash |
|---|---|---|
| Latency through the REST API from this machine, p50 / p95 | 771 / 1,131 ms | 619 / 855 ms |
| Input tokens per turn, p50 / max | 1,791 / 2,677 | same |
| Cost per 1,000 turns ($0.24 and $0.09 per million input tokens) | $0.43 | $0.16 |
| Written replies rated as expected | 120 / 120 | 89 / 120 |
| A repeated request rated 2 or lower | 40 / 40 | 9 / 40 |
| Same input twice | identical answers | identical answers |

The scripted replies carry no verdict, and Clef read them that way: `wrong = nothing` on 181 of 185. The `corrected` wording above cut false corrections from 9 to 1 of 11 flagged turns and still caught 45 of 45 written corrections and repeats.

**Clef rates every turn**; Clef-flash missed most repeated requests and stays a choice. No hand labels are collected: the eval in section 8 decides whether ratings are good enough to promote by.

## 2. Struggles

A struggle shows the agent fighting its tools. The turn's steering detector (`orchestrator/turn-steering.ts`) already sees most kinds:

| Kind | Rule |
|---|---|
| `repeated_failure` | One tool fails 3 times in a row (`CONSECUTIVE_FAILURES_BEFORE_STEER`) |
| `repeated_call` | One call returns the same output 3 times (`IDENTICAL_CALLS_BEFORE_STEER`) |
| `schema_refusal` | A tool input is refused by its schema before the tool runs |
| `no_progress` | 12 steps with nothing new (`STEPS_WITHOUT_PROGRESS_BEFORE_STEER`) |

Each turn records its struggles (tool, kind, count, a sample error), its error count and its step count. Struggles do three jobs, and never decide satisfaction:

1. **A lesson right after the turn.** A fast-tier reflector reads a struggling turn's struggles and the calls around them, and adds or updates one itemized lesson for that tool, as in ACE's evolving playbooks (Zhang et al., arXiv:2510.04618): one bullet with an id, its tool, helpful and harmful counts, and the turns that taught it. An update edits one bullet in place, so nothing is summarised away. A later turn that uses the tool without struggling counts as helpful, one that struggles as harmful; after 5 uses, a lesson with more harmful than helpful counts retires. Recovery findings and crafted-tool fitness stay.
2. **A trigger for the proposer.** At least 3 struggles with one tool, over at least 2 turns in the last 14 days, start the proposer on that tool's description or schema text.
3. **Live-trial guardrails** (section 5).

## 3. One proposer, with GEPA as its search

The proposer runs on the cadence lane when the agent has no trial running and either trigger holds: at least three turns rated 2 or lower in the last 14 days share a `wrong` reason, or a tool's struggles cluster as above. It edits one artifact:

| Artifact | Today's source | Edit allowed |
|---|---|---|
| Prompt section (18 registered) | `prompting/section-templates.ts:233` | Text, within the 4,800-byte cap (`section-store.ts:26`) |
| Tool description | `BUILTIN_TOOL_SPECS`, `tools/registry.ts:258` | Text |
| Tool input schema | e.g. `tools/file-tool.ts:75` | Description strings only; types, required fields and enum values stay identical |
| Codemode namespace declaration | e.g. `tools/agent-self.ts:56` | Comment text |
| Scaffold | `scaffold_versions`, VFS `agent.js.vN` | Code, passing the four gates in `scaffold/modify.ts` and the scaffold's own tests |

A struggle cluster targets its tool's description or schema text. An edit carries its turns, reason and rationale, and changes at most 600 characters, or 40 lines of scaffold code.

The section store becomes one store, `artifact_versions(actor_id, artifact_id, version, body, status, parent, rationale)`, with ids such as `section:state/verification`, `tool:file.description`, `tool:file.schema` and `namespace:agent`; tool and namespace text has no per-agent store today. The scaffold keeps `scaffold_versions`. Prompt assembly reads each artifact's current version, or its bundled source.

**GEPA is the search** (`evolution/gepa/`). Its reflective mutation and candidate set stay: the deep-tier reflection model reads the motivating turns with their reasons or struggles and proposes a mutation, and the Pareto frontier keeps candidates that win on different turns. Its metric changes from a rollout to the judge-only comparison below, scored per recorded turn, so the search executes nothing.

## 4. Pre-live tests: nothing touches the workspace

Neither check runs the agent on the workspace, so neither changes it.

**Static checks.** The size caps and schema rule above, the misevolution gate (`safety/misevolution.ts`), the per-family prompt token budget and the section parse. A scaffold also passes its four gates and its own `agent.test.js`, run in an isolated sandbox against a scripted host: a fake model, in-memory files, no live tools or memory.

**Judge-only comparison** (GEPA's metric). The decision model reads one recorded turn, its reason or struggle, the old artifact text and the new one, and answers two questions: `fixes` (would the new text have prevented this failure?) and `harms` (would the new text make this turn worse?).

- The bad set is the motivating turns, plus up to 10 other recent turns with the same reason or the same tool's struggles. A bad turn scores `fixes`.
- The regression set is the 30 most recent turns rated 4 or 5 that used the edited artifact, thumbs-up turns first, frozen when the search starts. A regression turn scores 1 − `harms`. Inside the search, it stops GEPA overfitting to the bad turns: a mutation that breaks good turns loses.
- GEPA's best candidate passes when `fixes` > 0.5 on at least 60% of the bad set and `harms` > 0.5 on at most 1 regression turn. These thresholds are hypotheses until the eval in section 8 tunes them.

A failed search is recorded and not repeated for the same turns.

## 5. Live trials

### The unit is a cache segment

Each agent has one durable conversation (`config/conversation.ts`), so per-conversation arms would put every turn on one arm. The arm is drawn instead at the start of each **segment**: a turn whose request finds the prompt cache already cold (`cacheKeptAliveUntil`, `orchestrator/chat-session.ts:1003`), or the first after a compaction. The prompt and tool definitions never change inside a segment, so caching is unaffected. The draw is a seeded 50/50 hash of trial and segment ids, the same on both backends.

### The rules

- One trial at a time per agent, on the main agent; subordinates, heads and swarm nodes use the incumbent.
- The measure is mean rated satisfaction per segment, the random unit. The guardrails are tool errors and steps per turn.
- Checks at 10, 20 and 30 rated segments per arm, each one-sided at α = 0.05/3.
- **Keep** the candidate when the lower bound of (candidate − incumbent) satisfaction is above 0, the `corrected` rate has not risen, and neither guardrail is higher with confidence.
- **Revert** when the satisfaction upper bound is below 0, when a guardrail is higher with confidence, at 30 segments per arm without a decision, or after 14 days.
- A plumbing error reverts; it never promotes.

### The record

Each decision writes a changelog entry: the edit, its turns, GEPA's numbers, segments and satisfaction per arm with the interval, the `corrected` rates and the guardrails. The changelog revert undoes it at any time (`evolution/changelog.ts:681`).

## 6. Existing loops on the new signals

| Loop | Stays | Change |
|---|---|---|
| In-episode craft fitness | Yes | The execution EMA still runs within a turn. After rating, the turn's satisfaction (score / 5) also updates the EMA of every crafted tool the turn called. |
| Recovery findings | Yes | A finding records its turn and is corroborated when that turn is rated 4 or 5. Today it is bound to no turn and stays provisional (`engine.ts:330`). |
| Turn review: lessons, MEMORY.md, pattern extraction | Yes | Runs when a rating lands. The lesson reflects on the `wrong` reason. MEMORY.md still needs the user's own negative: thumbs down, or `corrected` ≥ 0.8. |
| Struggle lessons | New | Section 2. |
| Consolidation, sleep-time memory | Yes | Unchanged. |
| Continual refinement | Yes | Its debt counts turns rated 2 or lower. Its section edits go through sections 4 and 5. |
| Workspace experience import | Yes | Settles on the next rated turn: 4 or 5 adopts, 2 or lower discards. |
| GEPA | Yes | The proposer's search, scored by the judge-only comparison. |
| Session scaffold proposal | No | Replaced by the proposer. |
| Shadow trials | No | Replaced by pre-live tests and live trials. |
| Quality curve (scaffold replay) | No | Replaced by satisfaction over time. |

**Deleted.**

- Shadow trials: `scaffold/shadow.ts`, `scaffold/auto-judge.ts`, `shadowTrialPlan`, `runQueuedShadowTrials`, `owesShadowTrial`.
- The clean-exit rule (`executionVerdict`, the `execution` source) and the dead `session_end` source.
- The classifier: `classifyTurnOutcome`, the `classifier` source, the ensemble (`ensemble.ts`) and the calibration report (`calibration.ts`).
- GEPA's live rollouts (`runScaffoldCaptureText`), its counterfactual section metric and `auto_gepa`'s every-25-turns schedule. The manual optimisation RPCs stay, starting the same proposer.
- The replay curve: `scaffold-scores.ts` and the uncalled `runReplayEval` with `replay_evals`.
- Section trials (`runPromptSectionTrials`), `decidePromotion` and K_align (`alignment.ts`).

## 7. The Quality tab

The Quality panel shows, per agent and per day: mean rated satisfaction with a 95% band, the `corrected` rate, tool errors and steps per turn, and the share of turns rated (by thumbs or the model). Beside them: the tools with the most struggles, a marker per promotion and revert linked to its changelog entry, and the current trial with its arms, segments, interval and guardrails. K_align, the replay sparkline and the calibration block go. On the CLI, `kinu alignment <name>` becomes `kinu quality <name>`, printing the same series from the same core reader.

## 8. Proof: learning on must beat learning off

Scripted replies are fixed whatever the agent did, so they carry no satisfaction. The proof needs a **reactive user** whose reply the eval's checks decide:

- Checks pass: the next task. A check fails: a correction naming the failing behaviour, not the fix; on a second failure, a repeat.
- With probability 0.1, a thumbs up after a pass or down after a failure.

**The run.** Two arms, learning on and off (`--no-auto-evolve`), start from the same state with the same models and run 200 segments each from `evals/tasks`, in the same seeded order, over three seeds. One family is held out until the last 50 segments. CL-Bench already keeps state across instances and toggles evolution alone (`bench/clbench/kinu/system.py:291`); the reactive user is new.

**Learning wins when** the check pass rate and mean rated satisfaction over the last 50 segments are higher with learning on (95% interval over seeds above 0), tool errors and steps per turn are not higher, the held-out family does not regress, and reverting each kept promotion on a copy of the final state lowers the pass rate on the turns it targeted.

Both arms' spend is recorded. **This run decides when promotions are on by default.** Until it wins, candidates that pass the pre-live tests wait in the changelog, and the owner can turn live trials on for an agent.

## Order of work

1. Ratings, the Decision model setting and the new Quality tab. Ratings are shown; nothing is promoted. Delete the classifier and the clean-exit rule.
2. Struggles: the per-turn record and the lesson reflector.
3. The artifact store, the proposer with GEPA as its search, and the pre-live tests. Delete GEPA's live rollouts and the replay curve.
4. Live trials with the guardrails, off by default. Delete shadow trials, section trials and `decidePromotion`.
5. The reactive-user eval. Promotions are on by default only after it wins.

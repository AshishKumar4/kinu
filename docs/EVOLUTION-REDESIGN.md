# Self-evolution redesign

Status: design for the owner's review, 2026-10-02; no product code yet. Once built, it replaces the turn, session and lifetime loops in [EVOLUTION.md](./EVOLUTION.md).

## The goal and what is wrong today

The agent improves while it is used: in the background it proposes small edits to its own prompts, tool descriptions, tool schemas and scaffold. An edit is promoted without the user's approval, but only after tests, and it is kept only if users are more satisfied with it than without it.

Today's nine loops have five defects:

- **A clean exit counts as success.** With no follow-up, the last acting tool call decides the verdict (`executionVerdict`, `packages/core/src/evolution/outcomes.ts:116`), so every downstream rate counts tool success as user success.
- **The classifier is not calibrated.** `classifyTurnOutcome` (`outcomes.ts:202`) has no label set behind it. The calibration tools exist, but a search of the eval logs, local agent databases and label exports found no hand labels.
- **Evaluation changes the live workspace.** Shadow trials and GEPA's scaffold metric run candidates with live tools, files and memory (`scaffold/executor.ts:464`).
- **No regression set.** A candidate is judged on the turns that motivated it, never on turns that went well.
- **Nothing has been shown to help.** No loop has evidence of a gain.

## The design in one paragraph

One signal: rated satisfaction for each turn the user answered. One proposer: it turns low-rated turns into one small edit at a time. Two test stages: pre-live tests that touch nothing live, then a live trial that promotes the edit only if satisfaction rises with confidence, and otherwise reverts it. The memory, lessons, crafted tools, recovery findings, consolidation, refinement and workspace experience loops stay, reading the new signal instead of the classifier and the clean-exit rule.

## 1. The satisfaction signal

### What is rated

A decision model reads the user's request, the agent's tool calls with their status, its final answer, and the user's next message. It answers three typed questions:

| Question | Type | Answer |
|---|---|---|
| `satisfaction` | score, 5 levels | 1 rejects or gives up; 2 corrects or asks again; 3 says nothing either way; 4 builds on it or moves on; 5 approves or thanks |
| `corrected` | yes/no | Did the user say the agent got something wrong, left part undone, or ask again for something it should already have done? New information, a changed requirement or a new task is not a correction. |
| `wrong` | choice | `nothing`, `misunderstood`, `incomplete`, `incorrect`, `ignored_instruction`, `broke_something`, `unrecovered_error`, `verbose_or_slow`, `needless_question` |

Rules:

- An explicit rating overrides the model. Thumbs up is 5 and thumbs down is 1. A take pick of the delivered answer is 4; a pick of an alternate rates the delivered answer 2. The CLI has no thumbs today, so there the model rates.
- A turn the user never answered stays unrated. No rule infers a verdict from tool exits.
- Rating runs off the turn path, after the next message arrives.
- Ratings replace the verdict columns of `turn_outcomes`. The sources become `thumbs`, `take_pick` and `model`; `classifier`, `execution` and the dead `session_end` go.

### The model setting

The account's Models settings gain a **Decision model** field, default Workers AI Clef (`@cf/cloudflare/clef`). Clef-flash, Jev and any other System One API model are the alternatives; Clef follows that API, so a switch changes only the endpoint and model name. The cf backend calls the Workers AI binding; the CLI reaches Workers AI through the provider path a Workers AI chat model uses.

### Measured on real Kinu turns

On 2026-10-02, Clef and Clef-flash rated 185 real Kinu turns: every eval turn in `kinu-logs/evals-fast` with a following user message (real agent answers and tool calls, scripted next messages). Forty of them were also paired with three written replies: a correction, a repeated request, and thanks, each with an expected rating. Scripts, raw answers and summary: `/mnt/scratch/kinu/kinu-logs/evals-fast/clef-satisfaction/`.

| | Clef | Clef-flash |
|---|---|---|
| Latency through the REST API from this machine, p50 / p95 | 771 / 1,131 ms | 619 / 855 ms |
| Input tokens per turn, p50 / max | 1,791 / 2,677 | same |
| Cost per 1,000 turns ($0.24 and $0.09 per million input tokens) | $0.43 | $0.16 |
| Written replies rated as expected | 120 / 120 | 89 / 120 |
| A repeated request rated 2 or lower | 40 / 40 | 9 / 40 |
| Same input twice | identical answers | identical answers |

The scripted replies carry no verdict, and Clef read them that way: mean 3.77, `wrong = nothing` on 181 of 185. A first wording of `corrected` fired on 9 of them, mostly "two rule changes" requests; the wording above cut that to 1 of 11 flagged turns and still caught 45 of 45 written corrections and repeats. The one left, "A correction: our supplier moved us to a new account", is new information that Clef still rates 2.3. Only hand labels will measure errors of this kind.

**Recommendation.** Clef rates every turn: at $0.43 per 1,000 turns volume costs little, and Clef-flash missed most repeated requests. Clef-flash stays a choice in the setting.

**Agreement with hand labels: unknown, because none exist.** Before ratings decide a promotion, 100 hand labels are collected on real turns: the owner's thumbs on staging plus one `kinu label` session (`packages/cli/src/commands/label.ts`). Hypothesis: Clef's `corrected` reaches an AUC of 0.85 or higher against them. After that, every thumb is a fresh label, and the Quality tab shows the running agreement.

## 2. One proposer

The proposer runs on the cadence lane when the agent has no trial running and at least three turns rated 2 or lower in the last 14 days share a `wrong` reason. It reads those turns and their reason, and writes one small edit to one artifact:

| Artifact | Today's source | Edit allowed |
|---|---|---|
| Prompt section (18 registered) | `prompting/section-templates.ts:233` | Text, within the 4,800-byte cap (`section-store.ts:26`) |
| Tool description | `BUILTIN_TOOL_SPECS`, `tools/registry.ts:258` | Text |
| Tool input schema | e.g. `tools/file-tool.ts:75` | Description strings only; types, required fields and enum values stay identical |
| Codemode namespace declaration | e.g. `tools/agent-self.ts:56` | Comment text |
| Scaffold | `scaffold_versions`, VFS `agent.js.vN` | Code, passing the four gates in `scaffold/modify.ts` and the scaffold's own tests |

An edit carries the turns it answers, the reason and a rationale, and changes at most 600 characters, or 40 lines of scaffold code.

Tool descriptions, schemas and namespace declarations have no per-agent store today. The section store becomes one store, `artifact_versions(actor_id, artifact_id, version, body, status, parent, rationale)`, with ids such as `section:state/verification`, `tool:file.description`, `tool:file.schema` and `namespace:agent`. The scaffold keeps `scaffold_versions`, its existing owner. Prompt assembly reads each artifact's current version, or the bundled source when there is none, as sections do today.

The proposer uses the deep tier, the lane the scaffold proposal uses today. It replaces three proposers: the session scaffold proposal, GEPA, and refinement's prompt-section path.

## 3. Pre-live tests: nothing touches the workspace

Neither check runs the agent on the workspace, so neither changes it.

**Static checks.** The size caps and the schema rule above; the misevolution gate (`safety/misevolution.ts`); the per-family prompt token budget; and the section parse. For a scaffold, the four existing gates, then the scaffold's own tests. A scaffold gains an `agent.test.js` beside `agent.js`. The tests run in an isolated sandbox against a scripted host: a fake model, in-memory files, no live tools and no memory.

**Judge-only comparison.** The decision model reads one turn, its reason, the old artifact text and the new one, and answers two questions: `fixes` (would the new text have prevented this failure?) and `harms` (would the new text make this turn worse?).

- The bad set is the low-rated turns that motivated the edit, plus up to 10 other recent low turns with the same reason.
- The regression set is the 30 most recent turns rated 4 or 5 that used the edited artifact (the tool was called, or the section applies), thumbs-up turns first, frozen when the candidate is proposed.
- The candidate passes when `fixes` > 0.5 on at least 60% of the bad set and `harms` > 0.5 on at most 1 regression turn. These thresholds are hypotheses until the eval in section 7 tunes them.

A failed candidate is recorded with its numbers and not proposed again for the same turns.

## 4. Live trials

### The unit is a cache segment

Each agent has one durable conversation (`config/conversation.ts`), so per-conversation arms would put every turn on one arm. The arm is drawn instead at the start of each **segment**: a turn whose request finds the provider's prompt cache already cold (the chat session knows this as `cacheKeptAliveUntil`, `orchestrator/chat-session.ts:1003`), or the first turn after a compaction rebuilt the prefix. The system prompt and tool definitions never change inside a segment, so caching is unaffected. The draw is a seeded 50/50 hash of the trial id and segment id, the same on both backends.

### The rules

- One trial at a time per agent, on the main agent. Subordinates, heads and swarm nodes use the incumbent until it ends.
- The measure is mean rated satisfaction per segment; segments, not turns, are the random unit.
- Checks at 10, 20 and 30 rated segments per arm, each a one-sided test at α = 0.05/3.
- **Keep** the candidate when the lower bound of (candidate − incumbent) is above 0 and the `corrected` rate has not risen.
- **Revert** when the upper bound is below 0, or at 30 segments per arm without a decision, or after 14 days.
- An error in the trial plumbing reverts; it never promotes.

### The record

Each decision writes a changelog entry: the edit, its motivating turns, the pre-live numbers, segments and mean satisfaction per arm, the difference with its interval, and the `corrected` rates. The changelog revert undoes it at any time, as today (`evolution/changelog.ts:681`). The Quality tab shows whether a kept gain lasts.

## 5. Existing loops on the new signal

| Loop | Stays | Change |
|---|---|---|
| In-episode craft fitness | Yes | The execution EMA still runs within a turn. After rating, the turn's satisfaction (score / 5) also updates the EMA of every crafted tool the turn called. |
| Recovery findings | Yes | A finding records its turn and is corroborated when that turn is rated 4 or 5. Today it is bound to no turn and stays provisional (`engine.ts:330`). |
| Turn review: lessons, MEMORY.md, pattern extraction | Yes | Runs when a rating lands, not when a classifier runs. The lesson reflects on the `wrong` reason. MEMORY.md still needs the user's own negative: a thumbs down, or a reply read as a correction at `corrected` ≥ 0.8. |
| Consolidation | Yes | Unchanged. |
| Continual refinement | Yes | Its debt counts turns rated 2 or lower instead of classifier corrected/frustrated. Facts and skills are unchanged. Its section edits go through sections 3 and 4. |
| Workspace experience import | Yes | Settles on the next rated turn: 4 or 5 adopts, 2 or lower discards. Today one classifier `accepted` adopts. |
| Sleep-time memory | Yes | Unchanged. |
| Session scaffold proposal | No | Replaced by the proposer. |
| Shadow trials | No | Replaced by pre-live tests and live trials. |
| GEPA, both lanes | No | Replaced by the proposer. |
| Quality curve (scaffold replay) | No | Replaced by satisfaction over time. |

**Deleted.**

- Shadow trials: `scaffold/shadow.ts` (583 lines), `scaffold/auto-judge.ts` (297), `shadowTrialPlan` and `runQueuedShadowTrials` in `control.ts`, and `owesShadowTrial`.
- The clean-exit rule: `executionVerdict` and the `execution` source.
- The classifier: `classifyTurnOutcome` with its prompt, the `classifier` source, the two-model ensemble (`ensemble.ts`, 493), and the classifier calibration report (`calibration.ts`, 578). The decision model's agreement with thumbs replaces the report.
- GEPA: `evolution/gepa/` (about 1,400 lines without tests), `eval-split.ts` (294), the `auto_gepa` terminal effect, and the manual optimisation RPCs on both backends.
- Live-runtime replay: the `scaffold-scores.ts` replay, `runScaffoldCaptureText`, and the uncalled `runReplayEval` with `replay_evals` (`replay.ts`, 206).
- Section trials (`runPromptSectionTrials`) and `decidePromotion`: the live-trial rule replaces both.
- K_align (`alignment.ts`, 206).

## 6. The Quality tab

The Quality panel shows satisfaction over time, per agent:

- Mean rated satisfaction per day, with a 95% band, on segments.
- The `corrected` rate per day.
- The share of turns rated, and the share rated by thumbs rather than the model.
- A marker for each promotion and revert, linked to its changelog entry with its numbers.
- The current trial: the arms, the segments so far, and the interval.
- The decision model's agreement with thumbs over the last 100 thumbed turns.

K_align, the replay sparkline and the calibration block go. On the CLI, `kinu alignment <name>` becomes `kinu quality <name>`, printing the same series from the same core reader.

## 7. Proof: learning on must beat learning off

Scripted users cannot measure satisfaction: their next message is fixed whatever the agent did, and Clef read 181 of 185 of them as `nothing` wrong. The proof needs a **reactive user** whose reply the eval's own checks decide:

- Checks pass: the next task.
- A check fails: a correction that names the failing behaviour, without the fix. On a second failure: a repeat of the request.
- With probability 0.1: a thumbs up after a pass, or a thumbs down after a failure.

**The run.** Two arms, learning on and learning off (`--no-auto-evolve`), start from the same state with the same models and run 200 segments each from the task families in `evals/tasks`, in the same seeded order, over three seeds. One family is held out and appears only in the last 50 segments. The CL-Bench harness already keeps state across instances and toggles evolution alone (`bench/clbench/kinu/system.py:291`); the reactive user is new.

**Learning wins when:**

- the check pass rate and the mean rated satisfaction over the last 50 segments are higher with learning on than off, with the 95% interval over the seeds above 0;
- the held-out family does not regress;
- reverting each kept promotion on a copy of the final state lowers the pass rate on the turns it targeted.

Both arms' model spend is recorded, so learning has a measured cost.

## Order of work

1. Ratings, the Decision model setting, the new Quality tab and the label collection. Ratings are shown; nothing is promoted. Delete the classifier and the clean-exit rule.
2. The artifact store, the proposer and the pre-live tests. Candidates are listed in the changelog, not trialled.
3. Live trials on staging for the owner's workspace. Delete shadow trials, GEPA and replay.
4. The reactive-user eval. Learning is on by default only after it wins.

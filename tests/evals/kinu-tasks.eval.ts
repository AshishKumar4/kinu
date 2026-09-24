/**
 * THE KINU TASK FAMILY: five multi-turn episodes over the product's own
 * machinery, measured through the PUBLIC API on the deployed product.
 *
 * WHY THESE FIVE. The cfos PR 525 tasks work because every turn is verified
 * through the artifact's own surface against references the verifier owns,
 * state must survive turn boundaries and a fresh connection, and the agent's
 * REPLY is checked against the data. Their reviewers' findings are the bar
 * here too: verify history not just final state; exercise every rule you add;
 * seed in non-sorted order; never accept a paraphrase where a literal was
 * asked; every verifier is run against a minimal correct fixture and a broken
 * one before it ships.
 *
 * Kinu's five exercise the product's own machinery — slates with a contract,
 * hires running concurrently with a plan, workspace-versus-sandbox routing,
 * memory and tasks across an eviction, an app asked for with no format named —
 * so each is both a capability grade and a regression net for the defects
 * fixed this week (B1, B3, B10, the pane room, the wake chains, the task
 * reminder, the 2048 game built as a standalone server).
 *
 * SHAPE. `KinuTaskCase` is `TrajectoryCase`'s shape with one difference the
 * cfos bar forces: the turns are DATA, and the verifier is opened PER EPISODE
 * and asked after EVERY turn. A single `verify()` at the end cannot hold
 * "turn two listed what turn one's seed put there" or "turn three preserved
 * what turn one stored", because both need references the verifier computed
 * between those turns. Subgoals accumulate across `after()` calls and are
 * scored by the existing ledger scorers (`scorePublicLedger`), never a judge;
 * `modelCalls: 'expected'`; a {@link DegenerateRunError} fails the episode;
 * budget is `PUBLIC_BUDGET` × 2 (four turns, hires, previews); pass = every
 * subgoal reached; N trials per model = 3, driven by `scripts/eval-matrix.ts`.
 *
 * ── WHAT WAS MEASURED OR READ BEFORE THESE ROWS SHIPPED ─────────────────────
 *
 * CASE 1 SUBGOAL 6 — WHICH DURABILITY THE PRODUCT PROMISES. It promises
 * durable slate STORAGE and a stable address, NOT durable process memory:
 * `docs/EXECUTION-LAYER-SPEC.md` § Slate preview home says a worker-home slate is "a
 * durable Nimbus application", that port and capability "are the same on every
 * launch", and that `this.sql` "persists across restarts and eviction" —
 * while the same paragraph says "a request for the URL after eviction or
 * redeploy RE-DRIVES the process", and `cf-backend/src/workspace-host.ts:484-
 * 487` states it from the routing side ("a durable application answers its URL
 * whether or not its process survived: the owner is brought to life (or
 * replaced …)"). Turn 1's contract asks for the queue IN MEMORY, so a
 * re-driven process legitimately starts empty and an eviction is not a
 * durability test of anything the product promised. Subgoal 6 therefore
 * measures the durability the product DOES promise across the boundary a user
 * meets: a plain socket reconnect (`disconnect()` then `connect()`), which
 * ends this client's connection and not the object's activation. The spec's
 * other branch — `abortActivation()` — would measure the one thing the
 * contract explicitly does not carry.
 *
 * CASE 2 SUBGOAL 2 — `parallel-delegation`, READ OFF THE STEP BOUNDARIES. The
 * contract is "both hires were issued in ONE model step", and the predicate is
 * exactly that: THE TWO `agents` HIRE `tool_call_end` ROWS OF TURN 1's RUN SIT
 * BETWEEN THE SAME PAIR OF CONSECUTIVE `step_finish` ROWS — that is, they share
 * a `runId` and NO `step_finish` row of that run lies between their
 * `eventIndex` values.
 *
 * That is the same question the spec asked, over the rows the ledger really
 * writes. There is no `tool_call_start`: `packages/core/src/events/types.ts:
 * 147-151` — "There is no matching `tool_call_start`. One existed, declared in
 * this union and read by three readers, and no producer ever wrote it" — and
 * the same finding is recorded at `tests/evals/harness-wiring.test.ts:743` and
 * `packages/cli/src/commands/debug.ts:547`. What the ledger does write is one
 * `tool_call_end` per completed call and one `step_finish` per model request,
 * from the same accumulator and in that order
 * (`packages/core/src/orchestrator/turn-accumulator.ts:202-251` records the
 * call, `:254-297` records the step), so a step's tool rows precede its
 * `step_finish` and the next step's rows follow it. Two hire rows with no
 * `step_finish` between them were therefore issued by ONE assistant message —
 * which is what a tool-calling agent doing two things "at the same time" is.
 *
 * The spec's other branch is closed and stays closed: the `agents` tool does
 * NOT batch hires. `hire`'s whole field list is scalar
 * (`packages/core/src/delegation/agents-tool.ts:740`, and the wire declaration
 * at :1890-1918 types `agent`, `role` and `mission` as single strings), one
 * call creates one helper, and `gate:agents-fields` refuses any field that is
 * not on that list — so "both names in one ok call" is a shape the product
 * cannot produce, and the step-boundary reading is the only one available.
 *
 * CASE 3 SUBGOAL 8 — MEASURED ON THE DEPLOYMENT, 2026-09-18T04:55Z, against
 * https://kinu.run serving `0.2.0+cba44dcb9` (built 2026-09-16T04:31Z), as the
 * eval web identity, through this session's own `execute()`. The hosted
 * `workspace` runtime CAN install and CANNOT run Vite, so the spec's
 * assumption holds and the subgoal stays `boundary-discovered`:
 *
 *   node --version                            exit 0   v20.0.0
 *   npm --version                             exit 0   10.0.0
 *   npm i            (vite@8.0.16 project)    exit 0   "added 13 packages in 1.9s"
 *   npx vite --version                        exit 127 codegen refusal
 *   node node_modules/vite/bin/vite.js        exit 127 codegen refusal
 *   vite --version                            exit 127 "no such command in this workspace's shell"
 *   node -e "console.log(…)"                  exit 127 codegen refusal
 *   npm --version    (control, sandbox)       exit 0   10.9.8
 *
 * The refusal, verbatim: `node: cannot run JavaScript in this workspace: the
 * host forbids runtime code compilation ("Code generation from strings
 * disallowed"). Run Node/Vite programs in an available capable executor, such
 * as sandbox.` — `packages/core/src/vfs/workspace-runtimes.ts:372-378`, which
 * is where subgoal 9's noun (`compil`) comes from. Log:
 * `kinu-logs/evals-0917/hosted-vite-measurement.log`.
 *
 * CASE 4 SUBGOAL 4 — THE TURN-END TASK REMINDER IS NOT ON MAIN, so the subgoal
 * reads FINAL STATE and says so in its detail. `git log main --oneline | grep
 * task` names no `feat/workspace-tasks` landing, and neither `owedTaskReminder`
 * nor `listWorkspaceWork` exists anywhere in the tree — so there is no
 * awaiting-user rule to read and no reminder that could complete the two tasks
 * the user held back. Case 2 subgoals 8 and 9 carry the same consequence: the
 * plan link is checked through `inspectSubordinate`'s `planTasks` view
 * (`packages/core/src/subordinates/inspection.ts:42,99-109`) where it exists
 * and through the implement turn's own window otherwise, and `tasks-closed`
 * grades the closing state alone.
 *
 * CREDENTIAL-FREE HALF. Every case ships with a minimal CORRECT fixture that
 * reaches all of its subgoals and one mutation per subgoal the spec's "Red
 * probes" name, each proved to flip exactly that subgoal. Case 1's fixture is
 * an in-test `Bun.serve` implementing the slate contract correctly; its
 * mutations are variants of that server, so the probe exercises the verifier
 * against a real HTTP app rather than against a canned answer. The probes cost
 * nothing and run at every tier.
 *
 * CLOUD ONLY. `resolvePublicSessionPlan` refuses every other backend before it
 * looks at a credential, and the skip prints the invocation that would run it.
 */
import { tmpdir } from 'node:os';

import { join } from 'node:path';
import { afterAll, describe, expect, test } from 'vitest';
import * as v from 'valibot';

import {
  type EvalBudget, type JsonValue, type LLMProviderConfig, parseJsonValue, type PlanReview,
  REAL_CLOCK, type RunEvent, WORKSPACE_ROOT,
} from '../../packages/core/src/index';
import { tolerate } from '../../packages/core/src/obs/index';
import {
  budgetRow, createObservedModelAccumulator, EVAL_MODELS, FULL_TOOL_SURFACE, ledgerTotalsFromEvents,
  LIVE_MODEL_ENV,
  measuredToolErrorRate, outcomeRow, outputCapRow, projectRunEventProvenance, publishRunRecord,
  reportLiveModelSpend, retainEpisodeTranscript, stepBoundEvidence, subgoalsOutcome,
  withEpisodeEvidence,
  type EvalArmState, type EvalObservation, type EvalScoreRow, type EvalSubgoal, type EvalTier,
} from '@kinu.run/test-utils';
import { resolveArtifactRoot } from '../../scripts/bench-retention';
import { DegenerateRunError, disposeFailedCase } from './episode-failure';
import {
  actionOf, awaitDetachedJobWakes, ok, promptToolCalls,
  reply, requireMeasuredToolOutcomes, systemRows, textOf, toolActionOn,
  type ToolCallEnd,
} from './prompt-ledger';
import {
  resolvePublicSessionPlan,
  scorePublicLedger,
  type KinuPublicSession,
  type PublicMessage,
  type PublicSlatePreview,
  type PublicSendResult,
  type PublicSessionPlan,
  previewTarget,
  type PublicSubordinate,
  type PublicTask,
} from './public-session';

const SUITE = 'Kinu Task Evals';

const REPO_ROOT = join(import.meta.dirname, '../..');

/** The tier this run measures. An unset or unknown name is the flash tier. */
function tierOf(named: string | undefined): EvalTier {
  if (named === 'pro') return 'pro';

  if (named === 'product') return 'product';

  return 'flash';
}

const TIER: EvalTier = tierOf(process.env.KINU_EVAL_TIER);

/**
 * The model this arm PINS on the workspace.
 *
 * `EVAL_MODELS[TIER]` unless the model matrix named one. A matrix row's model
 * arrives through `LIVE_MODEL_ENV.model` — `AI_GATEWAY_MODEL` / `KINU_MODEL`,
 * the same two names `resolveLiveModel` already reads — so the family is run
 * once per row without a second variable and without a second credential
 * path. `scripts/eval-matrix.ts` is the one caller that sets it; the
 * credential-free tiers never see it, because `test-scratch-home.ts` strips
 * those names at preload unless `KINU_EVAL_LIVE=1`.
 */
const MODEL = LIVE_MODEL_ENV.model
  .map((name) => process.env[name]?.trim())
  .find((value) => value !== undefined && value !== '') ?? EVAL_MODELS[TIER];

const RESOLUTION = resolvePublicSessionPlan(SUITE, MODEL);

if (RESOLUTION.kind === 'unavailable') console.warn(`[skip] ${RESOLUTION.remedy}`);

const PLAN: PublicSessionPlan | null = RESOLUTION.kind === 'ready' ? RESOLUTION.plan : null;

if (PLAN !== null) console.warn(`[live] ${SUITE} — ${PLAN.describe}`);

const liveTest = test.skipIf(PLAN === null);

const LLM: LLMProviderConfig | null = PLAN?.llm ?? null;

/** How many trials the matrix runner asks for per model. Declared here because
 *  the record has to name what it repeated, and `scripts/eval-matrix.ts` reads
 *  this same value rather than carrying a second one. */
export const KINU_TASK_TRIALS = 3;

const ARM: EvalArmState = {
  evolution: false,
  settle: 'none',
  tools: [...FULL_TOOL_SURFACE],
};

const TRANSCRIPTS = join(
  resolveArtifactRoot({
    flag: undefined, env: { BENCH_ARTIFACTS: process.env.BENCH_ARTIFACTS },
    repoRoot: REPO_ROOT, runRoot: tmpdir(),
  }),
  `kinu-tasks-${TIER}-${String(Date.now())}`,
);

const observations: EvalObservation[] = [];

const observedModels = createObservedModelAccumulator();

/**
 * `PUBLIC_BUDGET` × 2 — trajectory.eval.ts:276-281's four ceilings, doubled on
 * the three that scale with work. These episodes are three and four turns with
 * concurrent hires, two runtimes and live previews inside them, against that
 * family's two. The ERROR RATE is not doubled: a rate is not a quantity of
 * work, and case 3's whole subject is a runtime boundary the agent is supposed
 * to meet, so the share of calls that may fail is the same share.
 */
const TASK_BUDGET: EvalBudget = {
  steps: 120,
  tokens: 600_000,
  toolErrorRate: 0.5,
  wallMs: 2_400_000,
};

/** Six characters from an unambiguous alphabet, minted per episode so a copied
 *  answer from an earlier run cannot pass. No `0/O` or `1/I`: a nonce a model
 *  transcribes wrongly reads as a failure of the thing being measured. */
const NONCE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

function mintNonce(): string {
  let nonce = '';

  for (let index = 0; index < 6; index += 1) {
    nonce += NONCE_ALPHABET[Math.floor(Math.random() * NONCE_ALPHABET.length)] ?? 'X';
  }

  return nonce;
}

// ── What one case is ───────────────────────────────────────────────

/** Every surface a case's verifier may reach. A `Pick` rather than the class,
 *  so the credential-free fixtures implement exactly what the verifiers use
 *  and a verifier that grew a new dependency cannot compile against a fixture
 *  that has not grown it. */
export type KinuTaskSession = Pick<KinuPublicSession,
  | 'readFile' | 'writeFile' | 'execute' | 'backgroundJobs'
  | 'listSlates' | 'previewSlate' | 'exposedPorts' | 'fetchPreview'
  | 'subordinates' | 'tasks' | 'plans' | 'decidePlan'
  | 'connect' | 'disconnect' | 'runEvents' | 'history'
  | 'abortActivation'
>;

/** What the verifier is handed after a turn settles. */
export interface KinuTaskIo {
  readonly session: KinuTaskSession;
  /** The ledger as it stands now, oldest first. */
  readonly events: readonly RunEvent[];
  readonly history: readonly PublicMessage[];
  /** Prompt → the absorbing run's id when the send landed `mid-turn`. */
  readonly absorbedBy: ReadonlyMap<string, string>;
  /** Re-read the ledger and the transcript after the verifier itself acted —
   *  an approval that queues an implementation turn, an eviction, a
   *  reconnect. */
  refresh(): Promise<{ readonly events: readonly RunEvent[]; readonly history: readonly PublicMessage[] }>;
  /** Start watching for the next turn the PRODUCT opens by itself — the
   *  implementation turn an approved plan queues — and resolve when it closes.
   *  CALLED BEFORE the act that queues it, so the watch cannot miss a turn
   *  that closes while the approval is still being answered. A fixture has no
   *  such turn and answers at once. */
  watchProgrammaticTurn(): Promise<void>;
}

/** One episode's verifier: it owns the references it computes, which is what
 *  makes "the document listed what I seeded" checkable rather than a
 *  restatement of what the agent said. */
export interface KinuTaskEpisode {
  /** Verified after `turns[turn]` settles and before `turns[turn + 1]` is
   *  sent; any interlude the case owes (an approval, an eviction, a
   *  reconnect) happens here too. */
  after(turn: number, io: KinuTaskIo): Promise<readonly EvalSubgoal[]>;
}

export interface KinuTaskCase {
  readonly id: string;
  /** The mission the workspace's SOUL.md carries. */
  readonly purpose: string;
  /** Files seeded through the public files route before the first turn. */
  seed(nonce: string): readonly { readonly path: string; readonly content: string }[];
  /** The user turns, in order, with `<nonce>` already substituted. */
  turns(nonce: string): readonly string[];
  readonly budget: EvalBudget;
  open(nonce: string): KinuTaskEpisode;
}

// ── Predicate vocabulary ───────────────────────────────────────────

/** The `tool_call_end` rows of ONE prompt's run, narrowed to a tool and
 *  optionally to an action. The spec writes this `calls(events, tool, action?)`
 *  and leaves the prompt implicit ("rows for a prompt's run"); it is an
 *  argument here because a multi-turn case asks the question per turn. */
interface CallQuery {
  readonly events: readonly RunEvent[];
  readonly absorbedBy: ReadonlyMap<string, string>;
  readonly prompt: string | undefined;
  readonly tool: string;
  readonly action?: string;
}

function calls(query: CallQuery): ToolCallEnd[] {
  const { action, tool } = query;

  return promptToolCalls(query.events, query.prompt, query.absorbedBy)
    .filter((call) => call.name === tool && (action === undefined || actionOf(call) === action));
}

function excerpt(value: string, length = 200): string {
  return JSON.stringify(value.slice(0, length));
}

/** The non-empty lines of a reply, trimmed. What "reply with exactly two
 *  lines" is graded against: a model that pads with a blank line has answered
 *  the instruction. */
function lines(text: string): string[] {
  return text.split('\n').map((line) => line.trim()).filter((line) => line !== '');
}

/** One preview response's JSON, or `undefined` when the body was not JSON.
 *  `tolerate` rather than a bare catch: an unparseable preview body is an
 *  EXPECTED domain value here — an app that answered HTML is a finding the
 *  subgoal reports — and every other cause still throws. */
function asJson(body: { readonly status: number; readonly text: string }): JsonValue | undefined {
  return tolerate(() => parseJsonValue(body.text), 'malformed-input');
}

// ── Case 1: slate-ledger ───────────────────────────────────────────

const QUEUE_SLATE_ID = 'queue';

const QUEUE_PORT = 8790;

/** The priorities, in POST order, exactly as the spec fixes them — NOT sorted,
 *  which is the reviewers' point: a server that returns insertion order passes
 *  a sorted seed and fails this one. */
const QUEUE_PRIORITIES: readonly number[] = [3, 1, 2, 1, 3, 2, 3, 1, 2, 2, 1, 3];

/** The id suffixes in POST order: `01`..`12` shuffled, so id order, priority
 *  order and insertion order are three different orders. */
const QUEUE_POST_ORDER: readonly number[] = [7, 2, 11, 4, 1, 9, 12, 6, 3, 10, 5, 8];

const QUEUE_AGENTS: readonly string[] = ['ana', 'bo', 'cy'];

interface QueueTicket {
  readonly id: string;
  readonly title: string;
  readonly priority: number;
  /** The agent that FILED it. A new ticket's owner is null, so this is never
   *  the owner and the `?agent=` filter never answers it. */
  readonly filedBy: string;
  status: string;
  owner: string | null;
}

/** The verifier's own seed, computed from the nonce alone so two episodes
 *  cannot share a reference. */
function queueSeed(nonce: string): QueueTicket[] {
  return QUEUE_POST_ORDER.map((suffix, index) => {
    const label = String(suffix).padStart(2, '0');

    return {
      id: `q-${nonce}-${label}`,
      title: `Ticket ${label}`,
      priority: QUEUE_PRIORITIES[index] ?? 1,
      filedBy: QUEUE_AGENTS[index % QUEUE_AGENTS.length] ?? 'ana',
      status: 'open',
      owner: null,
    };
  });
}

/** The contract's order: priority ascending, then id ascending. */
function queueSorted(tickets: readonly QueueTicket[]): QueueTicket[] {
  return [...tickets].sort((left, right) =>
    left.priority - right.priority || left.id.localeCompare(right.id));
}

/** The five fields the contract names, in one shape, so a comparison is about
 *  the contract rather than about whatever else a server echoed. */
const QueueRowSchema = v.object({
  id: v.string(), title: v.string(), priority: v.number(),
  status: v.string(), owner: v.nullable(v.string()),
});

const QueueListSchema = v.object({ tickets: v.array(v.looseObject(QueueRowSchema.entries)) });

const QueueEchoSchema = v.object({ ticket: v.looseObject(QueueRowSchema.entries) });

const QueueErrorSchema = v.looseObject({ error: v.string() });

const QueueMetricsSchema = v.object({
  open: v.number(), claimed: v.number(), resolved: v.number(),
  byAgent: v.record(v.string(), v.object({ claimed: v.number(), resolved: v.number() })),
});

function queueRow(ticket: QueueTicket): v.InferOutput<typeof QueueRowSchema> {
  return {
    id: ticket.id, title: ticket.title, priority: ticket.priority,
    status: ticket.status, owner: ticket.owner,
  };
}

/** The metrics the verifier's own operations imply. DERIVED, never a literal:
 *  the spec's `{open:7, claimed:3, resolved:2, …}` is what this must produce,
 *  and the corpus test below holds it to exactly that. */
function queueMetrics(tickets: readonly QueueTicket[]): v.InferOutput<typeof QueueMetricsSchema> {
  const byAgent: Record<string, { claimed: number; resolved: number }> = {};

  for (const ticket of tickets) {
    if (ticket.owner === null) continue;
    const row = byAgent[ticket.owner] ?? { claimed: 0, resolved: 0 };

    if (ticket.status === 'claimed') row.claimed += 1;

    if (ticket.status === 'resolved') row.resolved += 1;
    byAgent[ticket.owner] = row;
  }

  return {
    open: tickets.filter((ticket) => ticket.status === 'open').length,
    claimed: tickets.filter((ticket) => ticket.status === 'claimed').length,
    resolved: tickets.filter((ticket) => ticket.status === 'resolved').length,
    byAgent,
  };
}

/** One `- <id> · <title> · <agent>` bullet, as the document must spell it. */
const DOC_BULLET = /^- (q-\S+) · (.+) · (\w+)$/u;

/** Case 1's four prompts. No `<nonce>` in the text: this case's per-episode
 *  reference is the TICKET IDS the verifier POSTs, so the nonce reaches the
 *  episode through {@link queueSeed} rather than through the ask. */
const CASE_SLATE_TURNS = (): readonly string[] => [
  'Build a slate at /home/main/slates/queue/ (package.json main "server.ts", slate '
  + '{"title":"Queue","port":8790,"bindings":{}}) that keeps a support-ticket queue in memory '
  + 'with this exact JSON HTTP contract, then start its preview and reply with only the preview URL.\n'
  + '- POST /tickets {id, title, priority, agent} → 201 {ticket}; 409 {"error":"DUPLICATE_ID"} if '
  + 'id exists; 400 {"error":"INVALID_PRIORITY"} unless priority is 1, 2 or 3. A new ticket has '
  + 'status "open" and owner null.\n'
  + '- POST /tickets/:id/claim {agent} → 200 {ticket} with status "claimed" and owner agent; 404 '
  + '{"error":"NOT_FOUND"}; 409 {"error":"ALREADY_CLAIMED","owner":<owner>} if already claimed.\n'
  + '- POST /tickets/:id/resolve → 200 {ticket} with status "resolved"; 404 NOT_FOUND; 409 '
  + '{"error":"NOT_CLAIMED"} if status is not "claimed".\n'
  + '- GET /tickets?status=&agent= → {tickets:[...]} filtered by either or both, sorted by '
  + 'priority ascending then id ascending.\n'
  + '- GET /metrics → {open, claimed, resolved, byAgent:{<agent>:{claimed, resolved}}} counted '
  + 'from the tickets.\n'
  + 'Keep the data across requests. Do not seed any tickets yourself.',
  'Write docs/queue-week.md: a heading "# Queue this week", then one section per priority '
  + '("## P1", "## P2", "## P3") listing every OPEN ticket as a bullet "- <id> · <title> · '
  + '<agent>" in id order. Read the tickets from the running slate, not from memory. Reply DONE.',
  'Change two rules: priority may now be 1 to 5, and resolving an unclaimed ticket is allowed '
  + 'and sets owner to "system". Everything already stored stays exactly as it is. Restart the '
  + 'preview if you must. Reply CHANGED.',
  'How many tickets does ana currently hold in status "claimed"? Reply with only the number.',
];

const SLATE_LEDGER: KinuTaskCase = {
  id: 'slate-ledger',
  purpose: 'A precise engineer who builds small TypeScript HTTP apps and keeps their data intact.',
  seed: () => [],
  turns: CASE_SLATE_TURNS,
  budget: { ...TASK_BUDGET },
  open(nonce) {
    const turns = CASE_SLATE_TURNS();
    const tickets = queueSeed(nonce);
    let preview = '';
    /** The raw `/tickets` body before turn 3 — what `preserved` compares
     *  BYTE-FOR-BYTE, extra fields and all. */
    let preChange = '';

    const get = async (io: KinuTaskIo, path: string): Promise<{ status: number; text: string }> =>
      io.session.fetchPreview(preview, path);

    const post = async (
      io: KinuTaskIo, path: string, json?: Record<string, JsonValue>,
    ): Promise<{ status: number; text: string }> =>
      io.session.fetchPreview(preview, path, {
        method: 'POST', json,
      });

    /** Turn 1: the slate built, served and durable across a reconnect. */
    async function afterTurnOne(io: KinuTaskIo): Promise<readonly EvalSubgoal[]> {
      const listing = await io.session.listSlates();
      const row = listing.slates.find((slate) => slate.id === QUEUE_SLATE_ID);
      const ports = await io.session.exposedPorts('workspace');
      const exposure = ports.find((port) => port.port === QUEUE_PORT);
      preview = exposure?.url ?? '';
      const answer = reply(io.history);

      const previewed = row !== undefined && row.port === QUEUE_PORT && exposure !== undefined
        && lines(answer).includes(exposure.url);

      const subgoals: EvalSubgoal[] = [{
        what: 'previewed',
        reached: previewed,
        detail: `slate row ${JSON.stringify(row)}; exposed ${JSON.stringify(exposure)}; `
          + `reply ${excerpt(answer)}`,
      }];

      // Nothing below can be asked of a preview that never started, and a
      // cascade of five identical misses hides the one that matters.
      if (!previewed) {
        for (const what of ['seeded', 'errors', 'order-and-filters', 'metrics', 'survives-reconnect']) {
          subgoals.push({
            what, reached: false,
            detail: 'no live preview on port 8790 to exercise the contract against',
          });
        }

        return subgoals;
      }

      // 2. SEEDED IN NON-SORTED ORDER, and every echo checked: a server
      //    that stores but answers `{}` has not met the contract.
      const echoes: string[] = [];
      let seeded = true;

      for (const ticket of tickets) {
        const answered = await post(io, '/tickets', {
          id: ticket.id, title: ticket.title, priority: ticket.priority, agent: ticket.filedBy,
        });

        const echo = v.safeParse(QueueEchoSchema, asJson(answered));

        const good = answered.status === 201 && echo.success
          && echo.output.ticket.id === ticket.id && echo.output.ticket.status === 'open'
          && echo.output.ticket.owner === null && echo.output.ticket.priority === ticket.priority;

        if (!good) {
          seeded = false;
          echoes.push(`${ticket.id}: HTTP ${String(answered.status)} ${excerpt(answered.text, 120)}`);
        }
      }

      subgoals.push({
        what: 'seeded',
        reached: seeded,
        detail: seeded
          ? `${String(tickets.length)} tickets accepted 201 in non-sorted order, each echoed open/owner null`
          : `rejected or mis-echoed: ${echoes.slice(0, 4).join('; ')}`,
      });

      // THE FIVE CLAIMS AND TWO RESOLUTIONS, decided BEFORE the refusals
      // are probed: the claim-twice refusal needs a ticket that is already
      // claimed by a known owner, and the resolve-unclaimed refusal needs
      // one that must still be OPEN at the end. Choosing them out of the
      // plan is what keeps subgoal 5's metrics the spec's
      // `{open:7, claimed:3, resolved:2, …}` instead of one claim more.
      const plan = queueSorted(tickets).slice(0, 5);
      const owners = ['ana', 'ana', 'ana', 'bo', 'bo'];
      const claimTarget = plan[0];
      const stayOpen = queueSorted(tickets).at(-1);

      if (claimTarget === undefined || stayOpen === undefined) throw new Error('the queue seed is empty');

      // 3. ALL FIVE REFUSALS. A contract is what it refuses.
      const duplicate = await post(io, '/tickets', {
        id: claimTarget.id, title: claimTarget.title,
        priority: claimTarget.priority, agent: claimTarget.filedBy,
      });

      const badPriority = await post(io, '/tickets', {
        id: `q-${nonce}-99`, title: 'Bad priority', priority: 4, agent: 'ana',
      });

      const unknownClaim = await post(io, `/tickets/q-${nonce}-missing/claim`, { agent: 'ana' });
      const firstClaim = await post(io, `/tickets/${claimTarget.id}/claim`, { agent: 'ana' });
      const secondClaim = await post(io, `/tickets/${claimTarget.id}/claim`, { agent: 'bo' });
      const unclaimedResolve = await post(io, `/tickets/${stayOpen.id}/resolve`);

      const errorOf = (body: { status: number; text: string }): string => {
        const parsed = v.safeParse(QueueErrorSchema, asJson(body));

        return parsed.success ? parsed.output.error : '';
      };

      const alreadyClaimed = v.safeParse(
        v.looseObject({ error: v.literal('ALREADY_CLAIMED'), owner: v.literal('ana') }),
        asJson(secondClaim),
      );

      const refusals = {
        'duplicate→409 DUPLICATE_ID': duplicate.status === 409 && errorOf(duplicate) === 'DUPLICATE_ID',
        'priority 4→400 INVALID_PRIORITY': badPriority.status === 400 && errorOf(badPriority) === 'INVALID_PRIORITY',
        'claim unknown→404': unknownClaim.status === 404 && errorOf(unknownClaim) === 'NOT_FOUND',
        'claim twice→409 ALREADY_CLAIMED owner ana': secondClaim.status === 409 && alreadyClaimed.success,
        'resolve unclaimed→409 NOT_CLAIMED': unclaimedResolve.status === 409 && errorOf(unclaimedResolve) === 'NOT_CLAIMED',
      };

      // The successful claim above IS the plan's first claim, recorded here
      // rather than re-issued below.
      if (firstClaim.status === 200) {
        claimTarget.status = 'claimed';
        claimTarget.owner = 'ana';
      }

      subgoals.push({
        what: 'errors',
        reached: Object.values(refusals).every(Boolean),
        detail: Object.entries(refusals)
          .map(([what, held]) => `${what}: ${held ? 'ok' : 'MISSED'}`).join('; '),
      });

      // 4. The remaining four claims, then the two resolutions, then the
      //    order and every filter against the verifier's own model.
      for (const [index, ticket] of plan.entries()) {
        const owner = owners[index] ?? 'ana';

        if (ticket.status === 'claimed' && ticket.owner === owner) continue;
        const claimed = await post(io, `/tickets/${ticket.id}/claim`, { agent: owner });

        if (claimed.status === 200) {
          ticket.status = 'claimed';
          ticket.owner = owner;
        }
      }

      for (const ticket of plan.filter((candidate) => candidate.owner === 'ana').slice(0, 2)) {
        const resolved = await post(io, `/tickets/${ticket.id}/resolve`);

        if (resolved.status === 200) ticket.status = 'resolved';
      }

      const listOf = async (query: string): Promise<v.InferOutput<typeof QueueRowSchema>[] | null> => {
        const body = await get(io, `/tickets${query}`);
        const parsed = v.safeParse(QueueListSchema, asJson(body));

        if (!parsed.success) return null;

        return parsed.output.tickets.map((listed) => v.parse(QueueRowSchema, listed));
      };

      const all = await listOf('');
      const claimedOnly = await listOf('?status=claimed');
      const anaOnly = await listOf('?agent=ana');
      const anaResolved = await listOf('?status=resolved&agent=ana');

      const expectedAll = queueSorted(tickets).map(queueRow);
      const expectedClaimed = queueSorted(tickets.filter((t) => t.status === 'claimed')).map(queueRow);
      const expectedAna = queueSorted(tickets.filter((t) => t.owner === 'ana')).map(queueRow);

      const expectedAnaResolved = queueSorted(
        tickets.filter((t) => t.owner === 'ana' && t.status === 'resolved'),
      ).map(queueRow);

      const same = <T>(left: T, right: T): boolean =>
        JSON.stringify(left) === JSON.stringify(right);

      const filters = {
        'GET /tickets in priority,id order': same(all, expectedAll),
        '?status=claimed': same(claimedOnly, expectedClaimed),
        '?agent=ana': same(anaOnly, expectedAna),
        '?status=resolved&agent=ana': same(anaResolved, expectedAnaResolved),
      };

      subgoals.push({
        what: 'order-and-filters',
        reached: Object.values(filters).every(Boolean),
        detail: `${Object.entries(filters).map(([what, held]) => `${what}: ${held ? 'ok' : 'MISSED'}`).join('; ')}`
          + `; served ${excerpt(JSON.stringify(all), 240)}`,
      });

      // 5. METRICS, derived from what the verifier did.
      const metricsBody = await get(io, '/metrics');
      const metrics = v.safeParse(QueueMetricsSchema, asJson(metricsBody));
      const expectedMetrics = queueMetrics(tickets);

      subgoals.push({
        what: 'metrics',
        reached: metrics.success && same(metrics.output, expectedMetrics),
        detail: `expected ${JSON.stringify(expectedMetrics)}; served ${excerpt(metricsBody.text, 240)}`,
      });

      // 6. THE DURABILITY THE PRODUCT PROMISES, across the boundary a user
      //    meets: this client's socket goes away and comes back. See the
      //    header for why an eviction is NOT the boundary this contract
      //    carries.
      const before = await get(io, '/tickets');
      const beforeMetrics = await get(io, '/metrics');
      io.session.disconnect();
      await io.session.connect();
      const afterList = await get(io, '/tickets');
      const afterMetrics = await get(io, '/metrics');

      subgoals.push({
        what: 'survives-reconnect',
        reached: afterList.status === 200 && afterList.text === before.text
          && afterMetrics.status === 200 && afterMetrics.text === beforeMetrics.text,
        detail: 'over a socket reconnect — the product promises durable slate storage and a '
          + 'stable address, not durable process memory (see the header): tickets '
          + `${String(before.text === afterList.text)}, metrics `
          + `${String(beforeMetrics.text === afterMetrics.text)}; after `
          + excerpt(afterList.text, 200),
      });

      return subgoals;
    }

    /** Turn 2: the document derived from the live queue, read rather than recalled. */
    async function afterTurnTwo(io: KinuTaskIo): Promise<readonly EvalSubgoal[]> {
      const document = await io.session.readFile('docs/queue-week.md', { allowMissing: true });
      const rows = document.split('\n').map((line) => line.trimEnd());
      const headings = rows.filter((line) => line.startsWith('#'));
      const open = tickets.filter((ticket) => ticket.status === 'open');
      const problems: string[] = [];

      if (JSON.stringify(headings) !== JSON.stringify(['# Queue this week', '## P1', '## P2', '## P3'])) {
        problems.push(`headings ${JSON.stringify(headings)}`);
      }

      for (const priority of [1, 2, 3]) {
        const start = rows.indexOf(`## P${String(priority)}`);
        const rest = rows.slice(start + 1);
        const end = rest.findIndex((line) => line.startsWith('#'));
        const section = (end < 0 ? rest : rest.slice(0, end)).filter((line) => line !== '');

        const expected = open.filter((ticket) => ticket.priority === priority)
          .sort((left, right) => left.id.localeCompare(right.id))
          .map((ticket) => `- ${ticket.id} · ${ticket.title} · ${ticket.filedBy}`);

        if (JSON.stringify(section) !== JSON.stringify(expected)) {
          problems.push(`P${String(priority)} listed ${JSON.stringify(section)} for ${JSON.stringify(expected)}`);
        }

        for (const line of section) {
          if (!DOC_BULLET.test(line)) problems.push(`bullet shape ${excerpt(line, 120)}`);
        }
      }

      const reads = promptToolCalls(io.events, turns[1], io.absorbedBy).filter((call) => {
        if (!ok(call)) return false;
        const text = `${textOf(call.args)}`;

        return (call.name === 'shell' || call.name === 'web') && text.includes('/tickets');
      });

      requireMeasuredToolOutcomes(promptToolCalls(io.events, turns[1], io.absorbedBy));
      preChange = (await get(io, '/tickets')).text;

      return [
        {
          what: 'document',
          reached: problems.length === 0,
          detail: problems.length === 0
            ? `${String(open.length)} open ticket(s) listed under the three priority sections in id order`
            : problems.slice(0, 4).join('; '),
        },
        {
          what: 'read-not-recalled',
          reached: reads.length > 0,
          detail: `${String(reads.length)} shell/web call(s) naming /tickets in turn 2's run`,
        },
      ];
    }

    /** Turn 3: the rules change, over the rows turn 3 already stored. */
    async function afterTurnThree(io: KinuTaskIo): Promise<readonly EvalSubgoal[]> {
      // BEFORE the new rules are exercised: `preserved` is about what was
      // already stored, and the probes below add rows.
      const after = await get(io, '/tickets');

      const fresh = { id: `q-${nonce}-p5`, title: 'Priority five', priority: 5, agent: 'ana' };
      const accepted = await post(io, '/tickets', fresh);
      const refused = await post(io, '/tickets', { ...fresh, id: `q-${nonce}-p6`, priority: 6 });
      const systemResolve = await post(io, `/tickets/${fresh.id}/resolve`);
      const echo = v.safeParse(QueueEchoSchema, asJson(systemResolve));
      const refusedError = v.safeParse(QueueErrorSchema, asJson(refused));

      const ports = await io.session.exposedPorts('workspace');
      const exposure = ports.find((port) => port.port === QUEUE_PORT);

      const rules = {
        'priority 5→201': accepted.status === 201,
        'priority 6→400 INVALID_PRIORITY': refused.status === 400
          && refusedError.success && refusedError.output.error === 'INVALID_PRIORITY',
        'resolve open→200 resolved/system': systemResolve.status === 200 && echo.success
          && echo.output.ticket.status === 'resolved' && echo.output.ticket.owner === 'system',
      };

      return [
        {
          what: 'preserved',
          reached: after.status === 200 && after.text === preChange,
          detail: after.text === preChange
            ? 'every stored row byte-identical across the rule change'
            : `before ${excerpt(preChange, 300)} after ${excerpt(after.text, 300)}`,
        },
        {
          what: 'new-rules',
          reached: Object.values(rules).every(Boolean),
          detail: Object.entries(rules).map(([what, held]) => `${what}: ${held ? 'ok' : 'MISSED'}`).join('; '),
        },
        {
          what: 'still-serving',
          reached: exposure !== undefined && exposure.url === preview,
          detail: `port ${String(QUEUE_PORT)} ${exposure === undefined ? 'is no longer exposed' : `is exposed at ${exposure.url}`}`
            + ` against the turn-1 URL ${preview}`,
        },
      ];
    }

    /** Turn 4: the count, answered as a bare number. */
    function afterTurnFour(io: KinuTaskIo): readonly EvalSubgoal[] {
      const answer = reply(io.history);
      const expected = tickets.filter((t) => t.owner === 'ana' && t.status === 'claimed').length;

      return [{
        what: 'bare-number',
        reached: /^\d+$/u.test(answer.trim()) && answer.trim() === String(expected),
        detail: `reply ${excerpt(answer)} against the verifier's own count ${String(expected)}`,
      }];
    }

    return {
      async after(turn, io) {
        if (turn === 0) return afterTurnOne(io);

        if (turn === 1) return afterTurnTwo(io);

        if (turn === 2) return afterTurnThree(io);

        return afterTurnFour(io);
      },
    };
  },
};

// ── Case 2: delegate-and-build ─────────────────────────────────────

const CASE_DELEGATE_TURNS = (nonce: string): readonly string[] => [
  'Hire two task subagents at the same time, not one after the other. Brief the first: use the '
  + `file tool to write the exact text ALPHA-${nonce} into notes/alpha.txt and answer with only `
  + `the word ALPHA. Brief the second: write the exact text BETA-${nonce} into notes/beta.txt and `
  + 'answer with only the word BETA. While they work, submit a plan (plan mode) for a '
  + 'support-queue dashboard slate with at least three numbered steps; do not implement it. When '
  + 'both subagents have answered, reply with exactly two lines: "first: <its answer>" and '
  + '"second: <its answer>".',
  'List every task you cut from the plan as "<id> · <status>" one per line, then the titles of '
  + 'the slates you built, one per line under a line "slates:".',
  'Which subagent wrote notes/beta.txt? Reply with only its roster name.',
];

/** The bound B3/B10 left behind: delegation may drain at most this many system
 *  cards into the root chat. `delegation.first-run.ts:58` holds the same
 *  number, and a reviewing brief or a re-inlined digest breaks it. */
const SYSTEM_CARD_CEILING = 2;

/**
 * Were these calls issued in ONE model step?
 *
 * They share a run and NO `step_finish` row of that run lies between their
 * `eventIndex` values — the two calls sit between the same pair of consecutive
 * step boundaries, which is the ledger's own record of one assistant message
 * having issued both. See the header for why this, and not a
 * `tool_call_start` ordering, is the reading available.
 */
function issuedInOneStep(events: readonly RunEvent[], issued: readonly ToolCallEnd[]): boolean {
  if (issued.length < 2) return false;
  const runs = new Set(issued.map((call) => call.runId));

  if (runs.size !== 1) return false;
  const indices = issued.map((call) => call.eventIndex);
  const from = Math.min(...indices);
  const to = Math.max(...indices);

  return !events.some((event) => event.type === 'step_finish'
    && issued[0] !== undefined && event.runId === issued[0].runId
    && event.eventIndex > from && event.eventIndex < to);
}

/** Which step boundary broke the pair, or that none did. */
function oneStepDetail(events: readonly RunEvent[], issued: readonly ToolCallEnd[]): string {
  const runs = [...new Set(issued.map((call) => call.runId))];

  const between = issued.length < 2 || runs.length !== 1
    ? []
    : events.filter((event) => event.type === 'step_finish' && event.runId === runs[0]
      && event.eventIndex > Math.min(...issued.map((call) => call.eventIndex))
      && event.eventIndex < Math.max(...issued.map((call) => call.eventIndex)));

  return `${String(issued.length)} settled hire row(s) in run(s) ${JSON.stringify(runs)} at `
    + `${JSON.stringify(issued.map((call) => call.eventIndex))}; `
    + `${String(between.length)} step_finish row(s) between them`
    + `${between.length === 0 ? ' — one model step issued both' : ` (steps ${JSON.stringify(between.map((event) => event.type === 'step_finish' ? event.stepIndex : -1))})`}`;
}

/** A numbered plan step, as the prompt asked for them. */
const PLAN_STEP = /^\d+\./u;

/** The hired name, read off the hire result the deployment answered — never
 *  off the reply (delegation.first-run.ts:123-131). */
const HireResultSchema = v.looseObject({
  name: v.optional(v.string()), agent: v.optional(v.string()),
});

function hiredName(call: ToolCallEnd): string | null {
  const parsed = v.safeParse(HireResultSchema, call.result);

  if (!parsed.success) return null;

  return parsed.output.name ?? parsed.output.agent ?? null;
}

/**
 * The wall window a set of runs occupied, read off the LEDGER's own timestamps
 * — the deployment's clock, which is the one every `createdAt` this file
 * compares against is stamped in. This process's clock is another machine's,
 * and a second of skew silently empties a window check.
 *
 * Null when the ledger holds no event of the set: the caller says what an
 * absent run means, because an open window and an empty one are opposite
 * readings of "nothing ran".
 */
function runWindow(
  events: readonly RunEvent[], holds: (event: RunEvent) => boolean,
): { readonly from: number; readonly to: number } | null {
  const stamps = events.filter(holds).map((event) => Date.parse(event.timestamp));

  if (stamps.length === 0) return null;

  return { from: Math.min(...stamps), to: Math.max(...stamps) };
}

const DELEGATE_AND_BUILD: KinuTaskCase = {
  id: 'delegate-and-build',
  purpose: 'A lead who delegates in parallel, plans while others work, and reports exactly what they answered.',
  seed: () => [],
  turns: CASE_DELEGATE_TURNS,
  budget: { ...TASK_BUDGET },
  open(nonce) {
    const turns = CASE_DELEGATE_TURNS(nonce);
    let secondHire: string | null = null;
    let slatesBefore: readonly string[] = [];
    let approved: { id: string; revision: number } | null = null;
    let implementWindow = { from: 0, to: 0 };

    return {
      async after(turn, io) {
        if (turn === 0) {
          const hires = calls({
            events: io.events, absorbedBy: io.absorbedBy, prompt: turns[0], tool: 'agents', action: 'hire',
          });

          requireMeasuredToolOutcomes(hires);
          const settled = hires.filter(ok);
          const names = settled.map(hiredName).filter((name): name is string => name !== null);
          secondHire = names[1] ?? null;

          const alpha = await io.session.readFile('notes/alpha.txt', { allowMissing: true });
          const beta = await io.session.readFile('notes/beta.txt', { allowMissing: true });
          const answer = reply(io.history);
          const answered = lines(answer);
          const plans = await io.session.plans();
          const roster = await io.session.subordinates();
          const cards = systemRows(io.history);
          slatesBefore = (await io.session.listSlates()).slates.map((slate) => slate.id);

          const pending = plans.filter((plan) => plan.status === 'pending');

          const steps = (plan: { content: string }): number =>
            plan.content.split('\n').filter((line) => PLAN_STEP.test(line.trim())).length;

          // The window turn 1's own run occupied, read off the ledger: a plan
          // this workspace held from some earlier life is not the one the
          // prompt asked for.
          const ownRuns = new Set(promptToolCalls(io.events, turns[0], io.absorbedBy)
            .map((call) => call.runId));

          // A ledger holding none of turn 1's own rows leaves the window OPEN:
          // there is nothing to place the plan against, and refusing every plan
          // for that would grade the read rather than the agent.
          const window = runWindow(io.events, (event) => ownRuns.has(event.runId)
            || (event.type === 'run_start' && event.userMessage === turns[0]))
            ?? { from: 0, to: Number.MAX_SAFE_INTEGER };

          // APPROVED WHATEVER WAS SUBMITTED. The harness plays the reviewer, and
          // a reviewer approves the plan in front of them — grading the step
          // count by refusing to approve would turn one missed subgoal into
          // four, which is the cascade the red probes exist to rule out.
          const target = pending.at(-1) ?? null;
          approved = target === null ? null : { id: target.id, revision: target.revision };

          const planned = pending.length === 1 && target !== null && steps(target) >= 3
            && target.createdAt >= window.from && target.createdAt <= window.to;

          const subgoals: EvalSubgoal[] = [
            {
              what: 'two-hires-settled',
              reached: settled.length === 2 && new Set(names).size === 2,
              detail: `${String(hires.length)} hire call(s), ${String(settled.length)} settled, `
                + `names ${JSON.stringify(names)}`,
            },
            {
              what: 'parallel-delegation',
              reached: issuedInOneStep(io.events, settled),
              detail: oneStepDetail(io.events, settled),
            },
            {
              what: 'files',
              reached: alpha.trim() === `ALPHA-${nonce}` && beta.trim() === `BETA-${nonce}`,
              detail: `notes/alpha.txt ${excerpt(alpha, 60)}, notes/beta.txt ${excerpt(beta, 60)} `
                + `against the episode nonce ${nonce}`,
            },
            {
              what: 'answers-relayed',
              reached: answered.length === 2 && answered[0] === 'first: ALPHA' && answered[1] === 'second: BETA',
              detail: `reply lines ${JSON.stringify(answered.slice(0, 4))}`,
            },
            {
              what: 'plan-submitted',
              reached: planned,
              detail: `${String(pending.length)} pending plan(s) of the root; steps `
                + `${JSON.stringify(pending.map((plan) => steps(plan)))}; createdAt `
                + `${JSON.stringify(pending.map((plan) => plan.createdAt))} against turn 1's run `
                + `window [${String(window.from)}, ${String(window.to)}]`,
            },
            {
              what: 'roster-retired',
              reached: names.length > 0 && names.every((name) => !roster.some((row) =>
                row.name === name && row.status !== 'dismissed')),
              detail: `roster ${JSON.stringify(roster.map((row) => [row.name, row.status, row.lifetime]))} `
                + `against hired ${JSON.stringify(names)}`,
            },
            {
              what: 'no-card-leak',
              reached: cards.length <= SYSTEM_CARD_CEILING,
              detail: `${String(cards.length)} system row(s) against a ceiling of ${String(SYSTEM_CARD_CEILING)}`
                + ` (B3/B10: a reviewing brief or a re-inlined digest lands here)`,
            },
          ];

          // THE INTERLUDE: approve the plan the way the review pane does, then
          // wait for the implementation turn the approval QUEUES — it is a
          // programmatic turn with no prompt of its own, so the window it ran
          // in is what turn 2's task subgoals are read against. The watch is
          // registered BEFORE the approval, and the window is the queued run's
          // own rows: no run of its own means no window, so a task that was
          // already there cannot read as one this turn created.
          if (approved !== null) {
            const queuedTurn = io.watchProgrammaticTurn();
            const before = new Set(io.events.map((event) => event.runId));
            await io.session.decidePlan(approved.id, approved.revision, 'approve');
            await queuedTurn;
            implementWindow = runWindow(await io.session.runEvents(),
              (event) => !before.has(event.runId)) ?? { from: 0, to: 0 };
          }

          return subgoals;
        }

        if (turn === 1) {
          const tasks = await io.session.tasks();
          const listing = await io.session.listSlates();
          const answer = reply(io.history);
          const answered = lines(answer);

          const fresh = listing.slates.filter((slate) => !slatesBefore.includes(slate.id));
          const ports = await io.session.exposedPorts('workspace');

          const served: string[] = [];

          for (const slate of fresh) {
            const exposure = slate.port === undefined
              ? undefined
              : ports.find((port) => port.port === slate.port);

            if (exposure === undefined) {
              served.push(`${slate.id}: not exposed`);
              continue;
            }

            const answeredBody = await io.session.fetchPreview(exposure.url, '/');
            served.push(`${slate.id}: HTTP ${String(answeredBody.status)}`);
          }

          const linked = tasks.filter((task) =>
            task.createdAt >= implementWindow.from && task.createdAt <= implementWindow.to);

          const openStates = ['open', 'active'];
          const stillOpen = linked.filter((task) => openStates.includes(task.status));

          const slateIndex = answered.indexOf('slates:');
          const idLines = slateIndex < 0 ? answered : answered.slice(0, slateIndex);
          const titleLines = slateIndex < 0 ? [] : answered.slice(slateIndex + 1);

          const claimed = idLines.map((line) => line.split('·').map((part) => part.trim()));

          const truthful = claimed.length > 0 && claimed.every(([id, status]) =>
            tasks.some((task) => task.id === id && task.status === status));

          const titlesMatch = JSON.stringify([...titleLines].sort())
            === JSON.stringify(fresh.map((slate) => slate.title).sort());

          return [
            {
              what: 'tasks-linked',
              reached: linked.length >= 3,
              detail: `${String(linked.length)} task(s) created inside the implement turn's window `
                + `(no plan-link read on main: \`listWorkspaceWork\` and \`plan_task_links\` reads `
                + `are not reachable over the public surface here) out of ${String(tasks.length)} total`,
            },
            {
              what: 'tasks-closed',
              reached: linked.length > 0 && stillOpen.length === 0,
              detail: `FINAL STATE ONLY — the turn-end task reminder is not on main, so no `
                + `\`task_reminder\` continuation can be counted: ${String(stillOpen.length)} of `
                + `${String(linked.length)} linked task(s) still open/active `
                + JSON.stringify(linked.map((task) => [task.id, task.status])),
            },
            {
              what: 'slates-built',
              reached: fresh.length === 2 && served.length === 2
                && served.every((row) => row.endsWith('HTTP 200')),
              detail: `${String(fresh.length)} new slate(s) since turn 1: ${served.join('; ')}`,
            },
            {
              what: 'reply-matches-ledger',
              reached: truthful && titlesMatch,
              detail: `reply ids ${JSON.stringify(claimed)} against ${JSON.stringify(tasks.map((task) => [task.id, task.status]))}; `
                + `reply titles ${JSON.stringify(titleLines)} against ${JSON.stringify(fresh.map((slate) => slate.title))}`,
            },
          ];
        }

        const answer = reply(io.history);

        return [{
          what: 'attribution',
          reached: secondHire !== null && answer.trim() === secondHire,
          detail: `reply ${excerpt(answer, 80)} against the second hire's own recorded name `
            + `${JSON.stringify(secondHire)}`,
        }];
      },
    };
  },
};

// ── Case 3: clone-and-serve ────────────────────────────────────────

const APP_A_PORT = 8791;

const APP_A_SANDBOX_PORT = 8792;

const APP_B_PORT = 8793;

/** The plain `node:http` server the case clones. Written as the seed rather
 *  than authored by the agent: the case measures git and routing, not whether
 *  a model can write a health endpoint. */
function appAServer(nonce: string): string {
  return [
    "import { createServer } from 'node:http';",
    '',
    'const port = Number(process.env.PORT ?? 8791);',
    '',
    'createServer((request, response) => {',
    "  if (request.method === 'GET' && request.url === '/health') {",
    "    response.writeHead(200, { 'content-type': 'application/json' });",
    `    response.end(JSON.stringify({ ok: true, token: 'A-${nonce}' }));`,
    '',
    '    return;',
    '  }',
    '',
    '  response.writeHead(404, { \'content-type\': \'application/json\' });',
    "  response.end(JSON.stringify({ error: 'NOT_FOUND' }));",
    '}).listen(port);',
    '',
  ].join('\n');
}

/** `vite@8.0.16` — the version this repository's own lockfile resolves
 *  (`bun.lock`, from the root `vite: ^8.0.8`). Pinned rather than ranged so
 *  the seed installs the artifact that was measured, and so a lockfile bump
 *  fails this constant instead of silently changing what the case runs. */
const SEED_VITE_VERSION = '8.0.16';

function appBFiles(nonce: string): readonly { readonly path: string; readonly content: string }[] {
  return [
    {
      path: 'seed/app-b/package.json',
      content: `${JSON.stringify({
        name: 'app-b',
        private: true,
        type: 'module',
        scripts: { dev: 'vite --host --port $PORT' },
        devDependencies: { vite: SEED_VITE_VERSION },
      }, null, 2)}\n`,
    },
    {
      path: 'seed/app-b/index.html',
      content: '<!doctype html>\n<html>\n  <head>\n'
        + `    <title>APP-B-${nonce}</title>\n`
        + '  </head>\n  <body>\n    <div id="app"></div>\n'
        + '    <script type="module" src="/main.js"></script>\n  </body>\n</html>\n',
    },
    {
      path: 'seed/app-b/main.js',
      content: `document.querySelector('#app').textContent = 'APP-B-${nonce}';\n`,
    },
  ];
}

const CASE_CLONE_TURNS = (): readonly string[] => [
  'seed/app-a is a project\'s working tree. Initialise it as a git repository and commit it, '
  + 'then clone that repository into apps/a and run its start script in the workspace runtime on '
  + 'port 8791, expose the port, and reply with two lines: the preview URL, and the exact JSON '
  + 'body of GET /health.',
  'Now run the same app in the sandbox on port 8792 and expose it. Reply with two lines: the '
  + 'workspace preview URL, then the sandbox preview URL.',
  'seed/app-b is a Vite app. Install its dependencies and run its dev server in the workspace '
  + 'runtime on port 8793 and expose it. If the workspace runtime cannot run it, run it in the '
  + 'sandbox instead and say in one line why the workspace could not.',
];

/** A `shell` call's runtime and command, the two fields routing is graded on. */
const ShellArgsSchema = v.looseObject({
  command: v.string(), runtime: v.optional(v.string()),
});

function shellCall(call: ToolCallEnd): { command: string; runtime: string } | null {
  if (call.name !== 'shell') return null;
  const parsed = v.safeParse(ShellArgsSchema, call.args);

  if (!parsed.success) return null;

  // An absent `runtime` is the workspace: it is the tool's own default, so a
  // command that named none ran there.
  return { command: parsed.output.command, runtime: parsed.output.runtime ?? 'workspace' };
}

/** The noun the hosted `node` guard refuses with — `cannot run JavaScript in
 *  this workspace: the host forbids runtime code compilation`
 *  (core/src/vfs/workspace-runtimes.ts:372-378), measured verbatim on the
 *  deployment 2026-09-18 (see the header). A reply that says "sandbox" without
 *  naming the boundary has reported a choice, not a reason. */
const REFUSAL_NOUN = /compil/iu;

const CLONE_AND_SERVE: KinuTaskCase = {
  id: 'clone-and-serve',
  purpose: 'An engineer who runs services where they can actually run, and says where.',
  seed(nonce) {
    return [
      { path: 'seed/app-a/server.js', content: appAServer(nonce) },
      {
        path: 'seed/app-a/package.json',
        content: `${JSON.stringify({ name: 'app-a', scripts: { start: 'node server.js' } }, null, 2)}\n`,
      },
      ...appBFiles(nonce),
    ];
  },
  turns: CASE_CLONE_TURNS,
  budget: { ...TASK_BUDGET },
  open(nonce) {
    const turns = CASE_CLONE_TURNS();
    const token = `A-${nonce}`;
    let workspaceUrl = '';

    const healthy = (body: { status: number; text: string }): boolean => {
      const parsed = v.safeParse(
        v.looseObject({ ok: v.literal(true), token: v.literal(token) }), asJson(body),
      );

      return body.status === 200 && parsed.success;
    };

    /** Turn 1: app A cloned into the workspace and served from it. */
    async function afterTurnOne(io: KinuTaskIo): Promise<readonly EvalSubgoal[]> {
      const ledger = promptToolCalls(io.events, turns[0], io.absorbedBy);
      requireMeasuredToolOutcomes(ledger);

      const cloned = ledger.filter((call) => {
        const shell = shellCall(call);

        return shell !== null && shell.runtime === 'workspace'
          && shell.command.includes('git clone') && ok(call);
      });

      const server = await io.session.readFile('apps/a/server.js', { allowMissing: true });
      const ports = await io.session.exposedPorts('workspace');
      const exposure = ports.find((port) => port.port === APP_A_PORT);
      workspaceUrl = exposure?.url ?? '';
      const health = exposure === undefined ? { status: 0, text: '' } : await io.session.fetchPreview(exposure.url, '/health');
      const answered = lines(reply(io.history));

      return [
        {
          what: 'git',
          reached: cloned.length > 0 && server.includes(token),
          detail: `${String(cloned.length)} settled workspace \`git clone\` call(s); `
            + `apps/a/server.js ${server === '' ? 'is absent' : 'is present'} and `
            + `${server.includes(token) ? 'carries' : 'lacks'} the seeded token`,
        },
        {
          what: 'served-workspace',
          reached: exposure !== undefined && healthy(health),
          detail: `port ${String(APP_A_PORT)} ${exposure === undefined ? 'not exposed' : `exposed at ${exposure.url}`}; `
            + `/health HTTP ${String(health.status)} ${excerpt(health.text, 160)}`,
        },
        {
          what: 'reply',
          reached: answered.length === 2 && exposure !== undefined
            && answered[0] === exposure.url
            && JSON.stringify(asJson({ status: 200, text: answered[1] ?? '' }))
              === JSON.stringify({ ok: true, token }),
          detail: `reply lines ${JSON.stringify(answered.slice(0, 3))} against ${exposure?.url ?? 'no URL'} `
            + `and {"ok":true,"token":"${token}"}`,
        },
      ];
    }

    /** Turn 2: the same app served from the sandbox, with the workspace copy still up. */
    async function afterTurnTwo(io: KinuTaskIo): Promise<readonly EvalSubgoal[]> {
      const sandboxPorts = await io.session.exposedPorts('sandbox');
      const sandbox = sandboxPorts.find((port) => port.port === APP_A_SANDBOX_PORT);
      const sandboxHealth = sandbox === undefined ? { status: 0, text: '' } : await io.session.fetchPreview(sandbox.url, '/health');
      const workspacePorts = await io.session.exposedPorts('workspace');
      const workspace = workspacePorts.find((port) => port.port === APP_A_PORT);
      const workspaceHealth = workspace === undefined ? { status: 0, text: '' } : await io.session.fetchPreview(workspace.url, '/health');
      const answered = lines(reply(io.history));

      return [
        {
          what: 'served-sandbox',
          reached: sandbox !== undefined && healthy(sandboxHealth),
          detail: `sandbox port ${String(APP_A_SANDBOX_PORT)} ${sandbox === undefined ? 'not exposed' : `exposed at ${sandbox.url}`}; `
            + `/health HTTP ${String(sandboxHealth.status)} ${excerpt(sandboxHealth.text, 160)} against token ${token}`,
        },
        {
          what: 'both-urls',
          reached: answered.length === 2 && sandbox !== undefined
            && answered[0] === workspaceUrl && answered[1] === sandbox.url
            && answered[0] !== answered[1],
          detail: `reply lines ${JSON.stringify(answered.slice(0, 3))} against workspace `
            + `${workspaceUrl} then sandbox ${sandbox?.url ?? 'none'}`,
        },
        {
          what: 'workspace-still-up',
          reached: workspace !== undefined && healthy(workspaceHealth),
          detail: `the workspace copy answers /health with HTTP ${String(workspaceHealth.status)} `
            + excerpt(workspaceHealth.text, 160),
        },
      ];
    }

    /** Turn 3: app B routed to the sandbox, and the boundary discovered in order. */
    async function afterTurnThree(io: KinuTaskIo): Promise<readonly EvalSubgoal[]> {
      const ledger = promptToolCalls(io.events, turns[2], io.absorbedBy);
      requireMeasuredToolOutcomes(ledger);
      const sandboxPorts = await io.session.exposedPorts('sandbox');
      const workspacePorts = await io.session.exposedPorts('workspace');
      const routed = sandboxPorts.find((port) => port.port === APP_B_PORT);
      const onWorkspace = workspacePorts.some((port) => port.port === APP_B_PORT);
      const page = routed === undefined ? { status: 0, text: '' } : await io.session.fetchPreview(routed.url, '/');

      const appBCall = (runtime: string): ToolCallEnd | undefined => ledger.find((call) => {
        const shell = shellCall(call);

        if (shell === null || shell.runtime !== runtime) return false;

        return /\bvite\b/u.test(shell.command) || /\bnpm\b/u.test(shell.command);
      });

      const attempt = appBCall('workspace');
      const fallback = appBCall('sandbox');

      // The attempt must have HIT the boundary: a workspace call that
      // succeeded is not a discovery, and a refusal recorded after the
      // sandbox call is a guess that was rationalised afterwards.
      const refused = attempt !== undefined && !ok(attempt);

      const ordered = refused && fallback !== undefined
        && ledger.indexOf(attempt) < ledger.indexOf(fallback);

      const answer = reply(io.history);
      const answered = lines(answer);

      return [
        {
          what: 'routed',
          reached: routed !== undefined && page.status === 200
            && page.text.includes(`<title>APP-B-${nonce}</title>`) && !onWorkspace,
          detail: `sandbox ${String(APP_B_PORT)} ${routed === undefined ? 'not exposed' : `exposed at ${routed.url}`}; `
            + `HTTP ${String(page.status)}; workspace ${onWorkspace ? 'ALSO lists 8793' : 'does not list 8793'}; `
            + `body ${excerpt(page.text, 160)}`,
        },
        {
          what: 'boundary-discovered',
          reached: ordered,
          detail: `MEASURED 2026-09-18 on the deployment: the hosted workspace runtime installs `
            + `(\`npm i\` exit 0) and cannot run Vite (\`npx vite\` exit 127, codegen refusal), `
            + `so the attempt must be recorded and must precede the sandbox call. workspace `
            + `attempt ${attempt === undefined ? 'absent' : `${attempt.toolCallId} ${ok(attempt) ? 'SUCCEEDED (no boundary met)' : 'refused/failed'}`}; `
            + `sandbox call ${fallback?.toolCallId ?? 'absent'}`,
        },
        {
          what: 'reason-stated',
          reached: answered.length === 1 && /sandbox/iu.test(answer) && REFUSAL_NOUN.test(answer),
          detail: `reply ${excerpt(answer)} — one line naming \`sandbox\` and the refusal's own `
            + 'noun (`compil`, from the hosted node guard)',
        },
      ];
    }

    return {
      async after(turn, io) {
        if (turn === 0) return afterTurnOne(io);

        if (turn === 1) return afterTurnTwo(io);

        return afterTurnThree(io);
      },
    };
  },
};

// ── Case 4: durable-continuity ─────────────────────────────────────

const DEPLOY_WINDOW = 'Thursday 14:00 UTC';

const ON_CALL = 'Priya';

const ROLLBACK = 'kinu release rollback --to 42';

const CASE_CONTINUITY_TURNS = (): readonly string[] => [
  'Save three facts to memory: the deploy window is Thursday 14:00 UTC; the on-call engineer is '
  + 'Priya; the rollback command is `kinu release rollback --to 42`. Then cut three tasks with '
  + 'the tasks tool: write notes/window.txt with the deploy window; write notes/oncall.txt with '
  + 'the on-call engineer\'s name; write notes/rollback.txt with the rollback command. Complete '
  + 'only the first task now, mark it done, and reply DONE.',
  'Finish the remaining tasks from what you saved to memory, without asking me anything, mark '
  + 'them done, then reply with the three files\' contents on three lines in task order.',
  'Who is on call and when is the deploy window? One line.',
];

/** The three task titles, by the word each one has to name. */
const TASK_SUBJECTS: readonly string[] = ['window', 'oncall', 'rollback'];

const DURABLE_CONTINUITY: KinuTaskCase = {
  id: 'durable-continuity',
  purpose: 'An assistant whose memory and task list outlive the process.',
  seed: () => [],
  turns: CASE_CONTINUITY_TURNS,
  budget: { ...TASK_BUDGET },
  open() {
    const turns = CASE_CONTINUITY_TURNS();

    return {
      async after(turn, io) {
        if (turn === 0) {
          const ledger = promptToolCalls(io.events, turns[0], io.absorbedBy);
          requireMeasuredToolOutcomes(ledger);
          const saves = ledger.filter((call) => toolActionOn(call, 'memory', 'save'));
          const tasks = await io.session.tasks();
          const window = await io.session.readFile('notes/window.txt', { allowMissing: true });
          const answer = reply(io.history);

          const named = TASK_SUBJECTS.map((subject) =>
            tasks.filter((task) => task.title.toLowerCase().includes(subject)));

          const cut = named.every((matches) => matches.length > 0)
            && tasks.filter((task) => ['open', 'done'].includes(task.status)).length === 3;

          const done = tasks.filter((task) => task.status === 'done');
          const stillOpen = tasks.filter((task) => task.status === 'open');

          // Three saves, or one call that saved three: both answer "the facts
          // were written down", and only a shape argument prefers one.
          const savedThree = saves.length >= 3
            || saves.some((call) => [DEPLOY_WINDOW, ON_CALL, ROLLBACK]
              .every((fact) => textOf(call.args).includes(fact)));

          const subgoals: EvalSubgoal[] = [
            {
              what: 'saved',
              reached: savedThree,
              detail: `${String(saves.length)} settled memory save(s); a single call must carry all `
                + `three facts: ${JSON.stringify(saves.map((call) => textOf(call.args).slice(0, 80)))}`,
            },
            {
              what: 'tasks-cut',
              reached: cut,
              detail: `${String(tasks.length)} task(s) ${JSON.stringify(tasks.map((task) => [task.title, task.status]))}`
                + ` against the three subjects ${JSON.stringify(TASK_SUBJECTS)}`,
            },
            {
              what: 'first-done',
              reached: window.trim() === DEPLOY_WINDOW && done.length === 1,
              detail: `notes/window.txt ${excerpt(window, 80)}; ${String(done.length)} task(s) done`,
            },
            {
              what: 'honest-stop',
              reached: answer.trim() === 'DONE' && stillOpen.length === 2,
              detail: `reply ${excerpt(answer, 80)}; ${String(stillOpen.length)} task(s) still open. `
                + 'The turn-end task reminder is NOT on main (no `owedTaskReminder` anywhere in the '
                + 'tree), so nothing here could have completed the two the user held back; this '
                + 'subgoal reads the state the turn ended in.',
            },
          ];

          // THE EVICTION: the workspace object's activation ends, so whatever
          // turn 2 recalls came off durable storage. The socket dies with the
          // activation, so it is re-opened here rather than at the next send.
          await io.session.abortActivation();
          io.session.disconnect();
          await io.session.connect();

          return subgoals;
        }

        if (turn === 1) {
          const ledger = promptToolCalls(io.events, turns[1], io.absorbedBy);
          requireMeasuredToolOutcomes(ledger);

          const recalls = ledger.filter((call) =>
            toolActionOn(call, 'memory', 'search') || toolActionOn(call, 'memory', 'recall'));

          const recalled = recalls.filter((call) => textOf(call.result).includes(ON_CALL));
          const oncall = await io.session.readFile('notes/oncall.txt', { allowMissing: true });
          const rollback = await io.session.readFile('notes/rollback.txt', { allowMissing: true });
          const window = await io.session.readFile('notes/window.txt', { allowMissing: true });
          const tasks = await io.session.tasks();
          const answer = reply(io.history);
          const answered = lines(answer);

          const unfinished = tasks.filter((task) => ['open', 'active'].includes(task.status));

          return [
            {
              what: 'recalled',
              reached: recalled.length > 0,
              detail: `${String(recalls.length)} memory search/recall call(s) after the eviction, `
                + `${String(recalled.length)} of them answering with ${ON_CALL}`,
            },
            {
              what: 'files',
              reached: oncall.trim() === ON_CALL && rollback.trim() === ROLLBACK,
              detail: `notes/oncall.txt ${excerpt(oncall, 80)}; notes/rollback.txt ${excerpt(rollback, 80)}`,
            },
            {
              what: 'tasks-done',
              reached: tasks.length === 3 && unfinished.length === 0
                && tasks.every((task) => task.status === 'done'),
              detail: JSON.stringify(tasks.map((task) => [task.title, task.status])),
            },
            {
              what: 'reply',
              reached: answered.length >= 3
                && answered[0] === window.trim() && answered[1] === oncall.trim()
                && answered[2] === rollback.trim(),
              detail: `reply lines ${JSON.stringify(answered.slice(0, 4))} against the three files `
                + JSON.stringify([window.trim(), oncall.trim(), rollback.trim()]),
            },
            {
              what: 'no-question',
              reached: !answer.includes('?'),
              detail: `the prompt forbade asking; reply ${excerpt(answer)}`,
            },
          ];
        }

        const answer = reply(io.history);

        return [{
          what: 'answer-from-data',
          reached: lines(answer).length === 1 && answer.includes(ON_CALL)
            && answer.includes('Thursday 14:00'),
          detail: `reply ${excerpt(answer)}`,
        }];
      },
    };
  },
};

// ── game-as-slate ───────────────────────────────────────────────────

/** Turn one is the owner's own ask from the 2048 transcript: an app, no format named. */
const CASE_GAME_TURNS = (nonce: string): readonly string[] => [
  'build a 2048 game',
  `Put ${nonce} in the game's title.`,
  'Reply with only the link where I can play it.',
];

/** A settled read of the slates skill, by the native file tool or inside a program. */
function readsSlatesSkill(call: ToolCallEnd): boolean {
  return ok(call) && textOf(call.args).includes('skills/slates/');
}

const GAME_AS_SLATE: KinuTaskCase = {
  id: 'game-as-slate',
  purpose: 'A builder who makes small apps and games people can use straight away.',
  seed: () => [],
  turns: CASE_GAME_TURNS,
  budget: { ...TASK_BUDGET },
  open(nonce) {
    const turns = CASE_GAME_TURNS(nonce);
    let slateId = '';
    let url = '';

    /** Turn 1: built as a slate that previews, with no server of its own. */
    async function afterTurnOne(io: KinuTaskIo): Promise<readonly EvalSubgoal[]> {
      const ledger = promptToolCalls(io.events, turns[0], io.absorbedBy);
      requireMeasuredToolOutcomes(ledger);
      const listing = await io.session.listSlates();
      const slate = listing.slates[0];
      slateId = slate?.id ?? '';
      const preview = slate === undefined ? null : await io.session.previewSlate(slate.id);
      url = preview?.ok === true ? preview.value.url : '';
      const page = url === '' ? { status: 0, text: '' } : await io.session.fetchPreview(url, '/');
      const slatePorts = new Set(listing.slates.flatMap((row) => row.port === undefined ? [] : [row.port]));

      const standalone = [...await io.session.exposedPorts('workspace'), ...await io.session.exposedPorts('sandbox')]
        .filter((port) => !slatePorts.has(port.port));

      const skillReads = ledger.filter(readsSlatesSkill);

      return [
        {
          what: 'slate', reached: slate !== undefined,
          detail: `slates ${JSON.stringify(listing.slates)}; problems ${JSON.stringify(listing.problems)}`,
        },
        {
          what: 'playable', reached: page.status === 200,
          detail: preview === null ? 'no slate to preview' : `preview ${JSON.stringify(preview)}; GET / HTTP ${String(page.status)} ${excerpt(page.text, 120)}`,
        },
        {
          what: 'no-standalone-server', reached: standalone.length === 0,
          detail: standalone.length === 0 ? 'no port exposed outside a slate' : `exposed ${JSON.stringify(standalone)}`,
        },
        {
          what: 'read-slates-skill', reached: skillReads.length > 0,
          detail: `${String(skillReads.length)} settled read(s) of the slates skill among ${String(ledger.length)} call(s)`,
        },
      ];
    }

    return {
      async after(turn, io) {
        if (turn === 0) return afterTurnOne(io);

        if (turn === 1) {
          const dir = `${WORKSPACE_ROOT}/slates/${slateId}`;
          const found = slateId === '' ? null : await io.session.execute('workspace', `grep -rl -- '${nonce}' '${dir}'`);

          return [{
            what: 'retitled', reached: (found?.stdout ?? '').trim() !== '',
            detail: found === null ? 'no slate to retitle' : `grep in ${dir}: ${excerpt(found.stdout ?? found.error ?? '', 160)}`,
          }];
        }

        const answer = reply(io.history);
        const bare = (link: string): string => link.trim().replace(/\/+$/u, '');

        return [{
          what: 'link', reached: url !== '' && bare(answer) === bare(url),
          detail: `preview ${url === '' ? 'never started' : url}; reply ${excerpt(answer)}`,
        }];
      },
    };
  },
};

export const KINU_TASK_CASES: readonly KinuTaskCase[] = [
  SLATE_LEDGER, DELEGATE_AND_BUILD, CLONE_AND_SERVE, DURABLE_CONTINUITY, GAME_AS_SLATE,
];

const DECLARED = KINU_TASK_CASES.map((entry) => entry.id);

/** Refuse an episode that recorded nothing gradable, upstream of every write
 *  path — the trajectory family's rule, applied here for its reason: a case
 *  that did nothing must contribute no number to the pool a later comparison
 *  reads. */
function refuseDegenerateEpisode(taskId: string, events: readonly RunEvent[]): void {
  const totals = ledgerTotalsFromEvents(events);

  if (totals.turns === 0 || totals.toolCalls === 0) {
    throw new DegenerateRunError(taskId, totals.turns, totals.toolCalls, totals.failures);
  }
}

afterAll(() => {
  const spend = reportLiveModelSpend(SUITE);
  publishRunRecord({
    family: 'kinu-tasks', tier: TIER, modelId: LLM?.model ?? MODEL,
    repeats: 1, seed: 1, arm: ARM, declaredTasks: DECLARED, observations, spend,
    modelObserved: observedModels.observed,
    transcripts: TRANSCRIPTS, repoRoot: REPO_ROOT,
  });
});

describe('Kinu task evals — the product\'s own machinery over five episodes', () => {
  test('every case is multi-turn, uniquely named, nonce-bearing and machine-checkable', () => {
    expect(KINU_TASK_CASES).toHaveLength(5);
    expect(new Set(DECLARED).size).toBe(DECLARED.length);
    expect(KINU_TASK_TRIALS).toBe(3);

    for (const entry of KINU_TASK_CASES) {
      const turns = entry.turns('AAAAAA');
      expect(turns.length, `${entry.id} is not multi-turn`).toBeGreaterThanOrEqual(3);
      expect(entry.purpose.length).toBeGreaterThan(20);
      expect(Object.keys(entry.budget).length, `${entry.id} declares no budget`).toBeGreaterThan(0);

      // A prompt that still carries the placeholder was never substituted, and
      // a copied answer from an earlier run would pass its case.
      for (const turn of turns) expect(turn).not.toContain('<nonce>');
    }

    // WHERE EACH CASE'S PER-EPISODE REFERENCE LIVES, named rather than assumed:
    // a nonce is only worth having if the thing a copied answer would have to
    // match carries it. `delegate-and-build` puts it in the ask (the two files'
    // bytes), `slate-ledger` in the ticket ids the verifier POSTs, and
    // `clone-and-serve` in the seed the agent clones and serves, and
    // `game-as-slate` in the title turn two asks for, found in the slate's source.
    // `durable-continuity` carries none, and that is the honest reading: its
    // three facts are the spec's own literals, and its subject is an eviction
    // rather than an unguessable reference.
    expect(KINU_TASK_CASES.filter((entry) => entry.turns('ZZZZZZ').join('\n').includes('ZZZZZZ'))
      .map((entry) => entry.id)).toEqual(['delegate-and-build', 'game-as-slate']);

    expect(KINU_TASK_CASES.filter((entry) => entry.seed('ZZZZZZ')
      .some((file) => file.content.includes('ZZZZZZ'))).map((entry) => entry.id))
      .toEqual(['clone-and-serve']);

    expect(queueSeed('ZZZZZZ').every((ticket) => ticket.id.includes('ZZZZZZ'))).toBe(true);

    // The budget is PUBLIC_BUDGET doubled on the three ceilings that scale.
    expect(TASK_BUDGET).toEqual({ steps: 120, tokens: 600_000, toolErrorRate: 0.5, wallMs: 2_400_000 });
  });

  test('the queue metrics the spec fixes are DERIVED from what the verifier did', () => {
    const tickets = queueSeed('NONCE1');
    const plan = queueSorted(tickets).slice(0, 5);
    const owners = ['ana', 'ana', 'ana', 'bo', 'bo'];

    for (const [index, ticket] of plan.entries()) {
      ticket.status = 'claimed';
      ticket.owner = owners[index] ?? 'ana';
    }

    for (const ticket of plan.filter((candidate) => candidate.owner === 'ana').slice(0, 2)) {
      ticket.status = 'resolved';
    }

    // The spec's literal, reached by derivation and never typed into a subgoal.
    expect(queueMetrics(tickets)).toEqual({
      open: 7, claimed: 3, resolved: 2,
      byAgent: { ana: { claimed: 1, resolved: 2 }, bo: { claimed: 2, resolved: 0 } },
    });

    // And the seed is NOT sorted on any of the three axes a lazy server would
    // return: insertion order is neither id order nor priority order.
    const ids = tickets.map((ticket) => ticket.id);
    expect(ids).not.toEqual([...ids].sort());
    expect(tickets.map((ticket) => ticket.priority))
      .not.toEqual(tickets.map((ticket) => ticket.priority).sort((a, b) => a - b));
  });
});

/**
 * LIVE: the five cases run concurrently, each on its own workspace, each
 * verified AFTER EVERY TURN. `genesis: false` so the workspace's own
 * unrequested first turn never runs.
 */
describe('Kinu task evals — measured', () => {
  for (const entry of KINU_TASK_CASES) {
    liveTest.concurrent(`MEASURED: ${entry.id}`, async () => {
      if (PLAN === null) throw new Error('unreachable: this arm is gated on a resolved plan');
      const startedAt = Date.now();
      const plan = PLAN;
      const nonce = mintNonce();
      const turns = entry.turns(nonce);
      let opened: KinuPublicSession | undefined;

      try {
        await withEpisodeEvidence(async () => {
          opened = await plan.open({ subject: entry.id, purpose: entry.purpose, genesis: false });

          return opened;
        }, {
          transcripts: TRANSCRIPTS, taskId: entry.id, modelCalls: 'expected', clock: REAL_CLOCK,
          budgetMs: entry.budget.wallMs,
        }, async (session, collect) => {
          console.warn(`    [kinu-tasks] ${entry.id} (nonce ${nonce}) on ${session.describe}`);

          for (const file of entry.seed(nonce)) await session.writeFile(file.path, file.content);

          const absorbedBy = new Map<string, string>();
          const episode = entry.open(nonce);
          const subgoals: EvalSubgoal[] = [];

          const io = (
            events: readonly RunEvent[], history: readonly PublicMessage[],
          ): KinuTaskIo => ({
            session, events, history, absorbedBy,
            async refresh() {
              const [next, rows] = await Promise.all([session.runEvents(), session.history()]);

              return { events: next, history: rows };
            },
            // The turn an approval queues has no prompt of this session's own,
            // and the socket it streams to is this one: its done frame is the
            // bound, never a poll on a clock.
            watchProgrammaticTurn: () => session.watchProgrammaticTurn(),
          });

          for (const [index, turn] of turns.entries()) {
            const sent: PublicSendResult = await session.prompt(turn);

            if (sent.landed === 'mid-turn' && sent.absorbedBy !== null) {
              absorbedBy.set(turn, sent.absorbedBy);
            }

            await awaitDetachedJobWakes(session, turns, absorbedBy);
            const [events, history] = await Promise.all([session.runEvents(), session.history()]);
            subgoals.push(...await episode.after(index, io(events, history)));
          }

          const { events, history } = await collect();
          observedModels.note(events);
          const totals = ledgerTotalsFromEvents(events);
          refuseDegenerateEpisode(entry.id, events);

          const retained = retainEpisodeTranscript(TRANSCRIPTS, entry.id, { events, history, subgoals });
          const outcome = subgoalsOutcome(subgoals, { turns: totals.turns, toolCalls: totals.toolCalls });
          const mechanisms = scorePublicLedger(events);

          const budget = budgetRow(entry.budget, {
            steps: totals.steps,
            tokens: totals.tokensIn + totals.tokensOut,
            toolErrorRate: measuredToolErrorRate(mechanisms),
            wallMs: Date.now() - startedAt,
          });

          const cap = outputCapRow(stepBoundEvidence(events).lastStepReason);
          const scores: EvalScoreRow[] = [outcomeRow(outcome), ...mechanisms, cap, budget];

          observations.push({
            taskId: entry.id, repetition: 0, outcome: 'scored', scores,
            turns: totals.turns, toolCalls: totals.toolCalls, toolNames: totals.toolNames,
            tokensIn: totals.tokensIn, tokensOut: totals.tokensOut, reasoningOut: totals.reasoningOut,
            provenance: projectRunEventProvenance(events),
            ms: Date.now() - startedAt,
          });
          console.warn(`    [kinu-tasks] ${entry.id}: ${String(totals.turns)} turn(s), `
            + `${String(totals.toolCalls)} tool call(s), ${String(outcome.reached)}/`
            + `${String(outcome.total)} subgoals — retained at ${retained}`);
          console.warn(`    [kinu-tasks] ${outcome.detail}`);

          const closedRuns = new Set(events.filter((event) => event.type === 'run_end').map((event) => event.runId));

          const unclosed = turns.filter((prompt) => {
            const own = events.find((event) => event.type === 'run_start' && event.userMessage === prompt);
            const runId = own?.runId ?? absorbedBy.get(prompt);

            return runId === undefined || !closedRuns.has(runId);
          });

          expect(unclosed,
            `${entry.id}: ${String(unclosed.length)} prompt(s) have no closed absorbing turn`).toEqual([]);

          for (const subgoal of subgoals) {
            expect(subgoal.reached, `${entry.id}/${subgoal.what}: ${subgoal.detail}`).toBe(true);
          }
        });
      } catch (error) {
        const thrown = error instanceof Error ? error : new Error(String(error));

        if (!observations.some((observation) => observation.taskId === entry.id)) {
          observations.push({
            taskId: entry.id, repetition: 0,
            outcome: disposeFailedCase(thrown).outcome,
            reason: thrown.message,
          });
        }

        throw error;
      } finally {
        await opened?.teardown();
      }
    });
  }
});

// ── RED PROBES: every verifier against a correct fixture and a broken one ──
//
// The cfos reviewers' bar, applied to this lane's own verifiers: a subgoal
// nobody has seen fail is a subgoal nobody has measured. Each case below is
// driven once against a MINIMAL CORRECT fixture that must reach every subgoal,
// then once per mutation the spec's "Red probes" name — and each mutation must
// flip EXACTLY its own subgoal, because a mutation that reds three subgoals
// proves none of them.
//
// Case 1's fixture is a real HTTP app (`Bun.serve`) implementing the slate
// contract, so the queue verifier is exercised over the wire it will meet.
// The other three are canned ledgers, transcripts and read models: their
// subjects are attribution and state, and a fake socket would add nothing.

const PROBE_NONCE = 'PRB234';

/** One turn's snapshot of the plane, plus whatever the fixture must do to the
 *  world before that turn is verified (a rule change, a port appearing). */
interface FixtureWorld {
  readonly session: KinuTaskSession;
  events(turn: number): readonly RunEvent[];
  history(turn: number): readonly PublicMessage[];
  /** Called BEFORE `after(turn)`: the fixture's stand-in for what the agent
   *  did during that turn. */
  advance?(turn: number): void;
}

/** Drive one episode's verifier over a fixture, turn by turn, and return every
 *  subgoal it produced in order. */
async function driveEpisode(
  entry: KinuTaskCase, world: FixtureWorld, nonce = PROBE_NONCE,
): Promise<readonly EvalSubgoal[]> {
  const episode = entry.open(nonce);
  const collected: EvalSubgoal[] = [];

  for (let turn = 0; turn < entry.turns(nonce).length; turn += 1) {
    world.advance?.(turn);

    collected.push(...await episode.after(turn, {
      session: world.session,
      events: world.events(turn),
      history: world.history(turn),
      absorbedBy: new Map(),
      refresh: async () => ({ events: world.events(turn), history: world.history(turn) }),
      watchProgrammaticTurn: async () => undefined,
    }));
  }

  return collected;
}

/** Run one probe and hold the MISSED SET to exactly what the mutation claims.
 *  The verdict is printed either way: the log is where a reader checks that a
 *  mutation flipped what it was supposed to. */
async function probe(
  entry: KinuTaskCase, label: string, world: FixtureWorld, expected: readonly string[],
): Promise<void> {
  const subgoals = await driveEpisode(entry, world);
  const missed = subgoals.filter((subgoal) => !subgoal.reached);
  const names = missed.map((subgoal) => subgoal.what);

  console.warn(`    [probe] ${entry.id} · ${label} → flipped ${JSON.stringify(names)}`
    + ` (expected ${JSON.stringify(expected)})`);

  expect(names, `${entry.id}/${label}: ${missed.map((subgoal) => `${subgoal.what} — ${subgoal.detail}`).join(' | ')}`)
    .toEqual([...expected]);

  expect(subgoals.length, `${entry.id}/${label} produced no subgoals`).toBeGreaterThan(0);
}

/** Every field a fixture session may answer. Absent halves are answered with
 *  the empty reading rather than a throw: a verifier that reached for a surface
 *  its case does not use is a defect this shape should surface as a miss, not
 *  as an exception nobody can attribute. */
interface FixtureState {
  slates: { id: string; title: string; bindings: string[]; port?: number }[];
  ports: Record<string, { port: number; url: string }[]>;
  files: Record<string, string>;
  tasks: PublicTask[];
  subordinates: PublicSubordinate[];
  plans: PlanReview[];
  preview(url: string, path: string, body?: { method: string; json?: unknown }): { status: number; text: string };
  /** A slate's preview start; absent means no slate in this world can start. */
  slatePreview?(id: string): PublicSlatePreview;
  /** The ledger the session's OWN read answers, for a verifier that re-reads
   *  it after acting — the run an approval queues appears here. */
  runs?: readonly RunEvent[];
  onDecide?(): void;
}

function fixtureSession(state: FixtureState): KinuTaskSession {
  return {
    readFile: async (path: string) => state.files[path] ?? '',
    writeFile: async () => undefined,
    execute: async () => ({ stdout: '', stderr: '', exitCode: 0 }),
    backgroundJobs: async () => [],
    listSlates: async () => ({ slates: [...state.slates], problems: [] }),
    previewSlate: async (id: string) => state.slatePreview?.(id) ?? { ok: false, reason: 'missing', error: `no slate ${id}` },
    exposedPorts: async (executor: string) => [...(state.ports[executor] ?? [])],
    fetchPreview: async (url: string, path: string, body?: { method: string; json?: unknown }) =>
      state.preview(url, path, body),
    subordinates: async () => [...state.subordinates],
    tasks: async () => [...state.tasks],
    plans: async () => [...state.plans],
    decidePlan: async (id: string, revision: number) => {
      state.onDecide?.();
      const plan = state.plans.find((row) => row.id === id && row.revision === revision);

      if (plan === undefined) return { ok: false, error: 'no such plan' };

      return { ok: true, plan: { ...plan, status: 'approved' }, queued: true };
    },
    connect: async () => undefined,
    disconnect: () => undefined,
    runEvents: async () => [...(state.runs ?? [])],
    history: async () => [],
    abortActivation: async () => undefined,
  };
}

function userRow(text: string): PublicMessage {
  return { role: 'user', text };
}

function assistantRow(text: string): PublicMessage {
  return { role: 'assistant', text };
}

/** A run's opening row, at a fixed instant so a window check is a step a test
 *  takes rather than a race with a real clock. */
function runStart(runId: string, prompt: string, at: number): RunEvent {
  return {
    type: 'run_start', runId, eventIndex: 0, timestamp: new Date(at).toISOString(),
    agentId: 'eval-kinu', caused_by: 'chat', userMessage: prompt,
  };
}

function runEnd(runId: string, at: number, index = 99): RunEvent {
  return {
    type: 'run_end', runId, eventIndex: index, timestamp: new Date(at).toISOString(), reason: 'reply',
  };
}

/** A model step's boundary row. `stepIndex` is the accumulator's own counter
 *  (`turn-accumulator.ts:255`), which is what makes "the same pair of
 *  consecutive step boundaries" a thing a fixture can state. */
function stepRow(runId: string, index: number, at: number, stepIndex: number): RunEvent {
  return {
    type: 'step_finish', runId, eventIndex: index,
    timestamp: new Date(at).toISOString(), stepIndex, reason: 'tool-calls',
  };
}

function toolRow(input: {
  readonly runId: string; readonly index: number; readonly at: number; readonly name: string;
  readonly id: string; readonly args?: Record<string, JsonValue>; readonly result?: JsonValue;
  readonly failed?: boolean;
}): RunEvent {
  return {
    type: 'tool_call_end', runId: input.runId, eventIndex: input.index,
    timestamp: new Date(input.at).toISOString(), name: input.name, toolCallId: input.id,
    args: input.args === undefined ? undefined : JSON.parse(JSON.stringify(input.args)),
    result: input.result === undefined ? undefined : JSON.parse(JSON.stringify(input.result)),
    outcome: input.failed === true ? { success: false, reason: null } : { success: true },
  };
}

// ── Case 1's fixture: the slate contract, implemented correctly ───

/** The mutations case 1's red probes need, each one variant of the SAME
 *  server, so a probe changes one rule and nothing else. */
interface SlateFixtureOptions {
  /** Sort `GET /tickets` by id alone — the reviewers' point about a seed whose
   *  id order and priority order differ. */
  readonly sortById?: boolean;
  /** Count resolved tickets as claimed in `/metrics`. */
  readonly resolvedCountsAsClaimed?: boolean;
  /** Answer a duplicate id 201 (echoing the row it already holds, so the store
   *  keeps twelve rows and only the REFUSAL subgoal can notice). */
  readonly acceptDuplicate?: boolean;
  /** Restart the rules with an empty store — the turn-3 implementation that
   *  loses everything it was told to keep. */
  readonly resetOnRuleChange?: boolean;
  /** Paraphrase the document's title. */
  readonly paraphraseTitle?: boolean;
  /** Answer turn 4 with units instead of a bare number. */
  readonly replyWithUnits?: boolean;
}

interface SlateRow {
  readonly id: string;
  readonly title: string;
  readonly priority: number;
  readonly filedBy: string;
  status: string;
  owner: string | null;
}

/** The queue contract as a real HTTP app: one `Bun.serve`, an in-memory store,
 *  and the two rules turn 3 changes held in a mutable record so the probe can
 *  flip them the way a restarted slate would. */
interface SlateFixtureServer {
  readonly origin: string;
  readonly rows: SlateRow[];
  changeRules(): void;
  stop(): Promise<void>;
}

function slateFixtureServer(options: SlateFixtureOptions): SlateFixtureServer {
  const rows: SlateRow[] = [];
  const rules = { maxPriority: 3, resolveUnclaimed: false };

  const wire = (row: SlateRow): v.InferOutput<typeof QueueRowSchema> => ({
    id: row.id, title: row.title, priority: row.priority, status: row.status, owner: row.owner,
  });

  const server = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    async fetch(request) {
      const url = new URL(request.url);
      const path = url.pathname;

      // A POST with no JSON body is a BAD_REQUEST below, which is a domain
      // value rather than a swallowed failure: `tolerate` names the condition
      // and every other cause still throws.
      const posted = request.method === 'POST' ? await request.text() : '';

      const body: JsonValue = request.method === 'POST'
        ? tolerate(() => parseJsonValue(posted), 'malformed-input') ?? {}
        : {};

      if (request.method === 'POST' && path === '/tickets') {
        const input = v.safeParse(v.object({
          id: v.string(), title: v.string(), priority: v.number(), agent: v.string(),
        }), body);

        if (!input.success) return Response.json({ error: 'BAD_REQUEST' }, { status: 400 });
        const held = rows.find((row) => row.id === input.output.id);

        if (held !== undefined) {
          return options.acceptDuplicate === true
            ? Response.json({ ticket: wire(held) }, { status: 201 })
            : Response.json({ error: 'DUPLICATE_ID' }, { status: 409 });
        }

        if (input.output.priority < 1 || input.output.priority > rules.maxPriority
          || !Number.isInteger(input.output.priority)) {
          return Response.json({ error: 'INVALID_PRIORITY' }, { status: 400 });
        }

        const row: SlateRow = {
          id: input.output.id, title: input.output.title, priority: input.output.priority,
          filedBy: input.output.agent, status: 'open', owner: null,
        };

        rows.push(row);

        return Response.json({ ticket: wire(row) }, { status: 201 });
      }

      const claim = /^\/tickets\/([^/]+)\/claim$/u.exec(path);

      if (request.method === 'POST' && claim !== null) {
        const row = rows.find((candidate) => candidate.id === claim[1]);

        if (row === undefined) return Response.json({ error: 'NOT_FOUND' }, { status: 404 });

        if (row.status !== 'open') {
          return Response.json({ error: 'ALREADY_CLAIMED', owner: row.owner }, { status: 409 });
        }

        const agent = v.safeParse(v.object({ agent: v.string() }), body);

        if (!agent.success) return Response.json({ error: 'BAD_REQUEST' }, { status: 400 });
        row.status = 'claimed';
        row.owner = agent.output.agent;

        return Response.json({ ticket: wire(row) });
      }

      const resolve = /^\/tickets\/([^/]+)\/resolve$/u.exec(path);

      if (request.method === 'POST' && resolve !== null) {
        const row = rows.find((candidate) => candidate.id === resolve[1]);

        if (row === undefined) return Response.json({ error: 'NOT_FOUND' }, { status: 404 });

        if (row.status !== 'claimed') {
          if (!rules.resolveUnclaimed) return Response.json({ error: 'NOT_CLAIMED' }, { status: 409 });
          row.owner = 'system';
        }

        row.status = 'resolved';

        return Response.json({ ticket: wire(row) });
      }

      if (request.method === 'GET' && path === '/tickets') {
        const status = url.searchParams.get('status');
        const agent = url.searchParams.get('agent');

        const filtered = rows
          .filter((row) => status === null || row.status === status)
          .filter((row) => agent === null || row.owner === agent);

        const sorted = [...filtered].sort((left, right) => options.sortById === true
          ? left.id.localeCompare(right.id)
          : left.priority - right.priority || left.id.localeCompare(right.id));

        return Response.json({ tickets: sorted.map(wire) });
      }

      if (request.method === 'GET' && path === '/metrics') {
        const byAgent: Record<string, { claimed: number; resolved: number }> = {};

        for (const row of rows) {
          if (row.owner === null) continue;
          const held = byAgent[row.owner] ?? { claimed: 0, resolved: 0 };

          if (row.status === 'claimed') held.claimed += 1;

          if (row.status === 'resolved') {
            held.resolved += 1;

            if (options.resolvedCountsAsClaimed === true) held.claimed += 1;
          }

          byAgent[row.owner] = held;
        }

        const resolved = rows.filter((row) => row.status === 'resolved').length;

        return Response.json({
          open: rows.filter((row) => row.status === 'open').length,
          claimed: rows.filter((row) => row.status === 'claimed').length
            + (options.resolvedCountsAsClaimed === true ? resolved : 0),
          resolved,
          byAgent,
        });
      }

      return Response.json({ error: 'NOT_FOUND' }, { status: 404 });
    },
  });

  return {
    origin: server.url.origin,
    rows,
    changeRules() {
      rules.maxPriority = 5;
      rules.resolveUnclaimed = true;

      if (options.resetOnRuleChange === true) rows.length = 0;
    },
    async stop() { await server.stop(true); },
  };
}

/** The document a correct agent writes, built from the SERVER's own rows —
 *  which is what "read the tickets from the running slate" means. */
function slateDocument(rows: readonly SlateRow[], options: SlateFixtureOptions): string {
  const heading = options.paraphraseTitle === true ? '# The queue this week' : '# Queue this week';
  const out = [heading, ''];

  for (const priority of [1, 2, 3]) {
    out.push(`## P${String(priority)}`);

    const section = rows.filter((row) => row.status === 'open' && row.priority === priority)
      .sort((left, right) => left.id.localeCompare(right.id));

    for (const row of section) out.push(`- ${row.id} · ${row.title} · ${row.filedBy}`);
    out.push('');
  }

  return out.join('\n');
}

/** One complete case-1 world over a live fixture server. */
async function withSlateWorld(
  options: SlateFixtureOptions,
  run: (world: FixtureWorld) => Promise<void>,
): Promise<void> {
  const server = slateFixtureServer(options);
  const base = Date.parse('2026-09-17T10:00:00Z');
  const turns = CASE_SLATE_TURNS();

  const state: FixtureState = {
    slates: [{ id: QUEUE_SLATE_ID, title: 'Queue', bindings: [], port: QUEUE_PORT }],
    ports: { workspace: [{ port: QUEUE_PORT, url: server.origin }] },
    files: {},
    tasks: [], subordinates: [], plans: [],
    preview(url, path, body) {
      throw new Error(`the slate world routes previews over HTTP, not through this stub: ${url}${path} ${String(body?.method)}`);
    },
  };

  // The doc is READ off the server at read time, exactly as a correct agent
  // would have written it from the same rows.
  const session: KinuTaskSession = {
    ...fixtureSession(state),
    readFile: async (path: string) => path === 'docs/queue-week.md'
      ? slateDocument(server.rows, options)
      : '',
    // The SAME resolution the live session uses, so a query string reaches the
    // fixture app exactly as it reaches a deployed preview.
    fetchPreview: async (url, path, body) => {
      const response = await fetch(previewTarget(url, path), {
        method: body?.method ?? 'GET',
        headers: body?.json === undefined ? {} : { 'content-type': 'application/json' },
        body: body?.json === undefined ? undefined : JSON.stringify(body.json),
      });

      return { status: response.status, text: await response.text() };
    },
  };

  const histories: PublicMessage[][] = [
    [userRow(turns[0] ?? ''), assistantRow(`The queue is live.\n${server.origin}`)],
    [userRow(turns[1] ?? ''), assistantRow('DONE')],
    [userRow(turns[2] ?? ''), assistantRow('CHANGED')],
    [userRow(turns[3] ?? ''), assistantRow(options.replyWithUnits === true ? '1 ticket' : '1')],
  ];

  const ledgers: RunEvent[][] = [
    [
      runStart('t0', turns[0] ?? '', base),
      toolRow({ runId: 't0', index: 1, at: base + 1_000, name: 'file', id: 'write-server',
        args: { action: 'write', path: 'slates/queue/server.ts' }, result: 'ok' }),
      runEnd('t0', base + 2_000),
    ],
    [
      runStart('t1', turns[1] ?? '', base + 10_000),
      toolRow({ runId: 't1', index: 1, at: base + 11_000, name: 'shell', id: 'read-queue',
        args: { command: `curl -s ${server.origin}/tickets`, runtime: 'workspace' },
        result: '{"tickets":[]}' }),
      toolRow({ runId: 't1', index: 2, at: base + 12_000, name: 'file', id: 'write-doc',
        args: { action: 'write', path: 'docs/queue-week.md' }, result: 'ok' }),
      runEnd('t1', base + 13_000),
    ],
    [runStart('t2', turns[2] ?? '', base + 20_000), runEnd('t2', base + 21_000)],
    [runStart('t3', turns[3] ?? '', base + 30_000), runEnd('t3', base + 31_000)],
  ];

  const world: FixtureWorld = {
    session,
    events: (turn) => ledgers.slice(0, turn + 1).flat(),
    history: (turn) => histories.slice(0, turn + 1).flat(),
    advance: (turn) => {
      // Turn 3 IS the rule change: the fixture flips the two rules the prompt
      // asked for, which is where a `resetOnRuleChange` implementation loses
      // the store.
      if (turn === 2) server.changeRules();
    },
  };

  try {
    await run(world);
  } finally {
    await server.stop();
  }
}

describe('Kinu task evals — red probes over credential-free fixtures', () => {
  test('slate-ledger: a correct slate passes, and each mutation flips its own subgoal', async () => {
    await withSlateWorld({}, (world) => probe(SLATE_LEDGER, 'minimal correct', world, []));
    await withSlateWorld({ sortById: true }, (world) =>
      probe(SLATE_LEDGER, 'sorted by id only', world, ['order-and-filters']));
    await withSlateWorld({ resolvedCountsAsClaimed: true }, (world) =>
      probe(SLATE_LEDGER, 'metrics count resolved as claimed', world, ['metrics']));
    await withSlateWorld({ acceptDuplicate: true }, (world) =>
      probe(SLATE_LEDGER, 'duplicate id accepted', world, ['errors']));
    await withSlateWorld({ paraphraseTitle: true }, (world) =>
      probe(SLATE_LEDGER, 'document title paraphrased', world, ['document']));
    await withSlateWorld({ replyWithUnits: true }, (world) =>
      probe(SLATE_LEDGER, 'reply "1 ticket"', world, ['bare-number']));
    await withSlateWorld({ resetOnRuleChange: true }, (world) =>
      probe(SLATE_LEDGER, 'turn-3 rules reset the store', world, ['preserved']));
  });
});

// ── Case 2's fixture: two hires, a plan, an approval, two slates ──

interface DelegateFixtureOptions {
  /** Close the step between the two hires — the lead that hired one after the
   *  other, which is what the prompt forbade. */
  readonly sequentialHires?: boolean;
  readonly wrongNonce?: boolean;
  readonly lowercaseRelay?: boolean;
  readonly twoStepPlan?: boolean;
  readonly systemCards?: boolean;
  readonly taskLeftActive?: boolean;
  readonly slateNotServed?: boolean;
  readonly nameFirstHire?: boolean;
}

const FIRST_HIRE = 'alpha-scribe';

const SECOND_HIRE = 'beta-scribe';

function delegateWorld(options: DelegateFixtureOptions): FixtureWorld {
  const turns = CASE_DELEGATE_TURNS(PROBE_NONCE);
  const base = Date.parse('2026-09-17T11:00:00Z');
  const nonce = options.wrongNonce === true ? 'WRONG1' : PROBE_NONCE;

  const planContent = options.twoStepPlan === true
    ? '1. Read the queue contract.\n2. Draw the dashboard.'
    : '1. Read the queue contract.\n2. Draw the dashboard.\n3. Serve it as a slate.';

  const plan: PlanReview = {
    id: 'plan-1', sessionId: 'default', revision: 1, content: planContent, status: 'pending',
    annotations: [], feedback: null, handoffAccepted: false,
    createdAt: base + 5_000, updatedAt: base + 5_000, decidedAt: null,
  };

  /** The turn the APPROVAL QUEUES, as the ledger records it: a run with no
   *  prompt of its own, at a fixed instant. The verifier reads the implement
   *  window off these two rows, so the tasks the turn cut are stamped between
   *  them rather than at whatever this process's clock says. */
  const implementRun: readonly RunEvent[] = [
    runStart('d-implement', '', base + 20_000), runEnd('d-implement', base + 30_000),
  ];

  const implementedAt = base + 25_000;

  const state: FixtureState = {
    slates: [],
    ports: { workspace: [] },
    files: { 'notes/alpha.txt': `ALPHA-${PROBE_NONCE}`, 'notes/beta.txt': `BETA-${nonce}` },
    tasks: [],
    subordinates: [
      { name: FIRST_HIRE, status: 'dismissed', lifetime: 'task' },
      { name: SECOND_HIRE, status: 'dismissed', lifetime: 'task' },
    ],
    plans: [plan],
    preview: (url) => options.slateNotServed === true && url.endsWith('8801')
      ? { status: 502, text: 'no server is listening on that port' }
      : { status: 200, text: '<!doctype html><title>Queue dashboard</title>' },
    // The implementation turn the approval queues is what cuts the tasks and
    // builds the slates, so the fixture does both AT DECISION TIME, and adds
    // the run itself to the ledger the verifier re-reads — which is what puts
    // their `createdAt` inside the window it reads off that run.
    onDecide() {
      const at = implementedAt;
      state.runs = [...(ledgers[0] ?? []), ...implementRun];

      state.tasks = [
        { id: 't1', title: 'Read the queue contract', status: 'done', createdAt: at, updatedAt: at, subtasks: [] },
        { id: 't2', title: 'Draw the dashboard', status: options.taskLeftActive === true ? 'active' : 'done', createdAt: at, updatedAt: at, subtasks: [] },
        { id: 't3', title: 'Serve it as a slate', status: 'dropped', createdAt: at, updatedAt: at, subtasks: [] },
      ];

      state.slates = [
        { id: 'dashboard', title: 'Queue dashboard', bindings: [], port: 8800 },
        { id: 'dashboard-live', title: 'Queue live', bindings: [], port: 8801 },
      ];

      state.ports = {
        workspace: [
          { port: 8800, url: 'http://127.0.0.1:8800' },
          { port: 8801, url: 'http://127.0.0.1:8801' },
        ],
      };
    },
  };

  const relay = options.lowercaseRelay === true
    ? 'first: alpha\nsecond: BETA'
    : 'first: ALPHA\nsecond: BETA';

  const ledgers: RunEvent[][] = [
    [
      runStart('d0', turns[0] ?? '', base),
      toolRow({ runId: 'd0', index: 1, at: base + 1_000, name: 'agents', id: 'hire-a',
        args: { action: 'hire', role: 'task', lifetime: 'task', mission: 'write alpha' },
        result: { name: FIRST_HIRE, answer: 'ALPHA' } }),
      // THE STEP BOUNDARY THE SUBGOAL READS: absent in the correct fixture, so
      // both hires sit between the same pair of consecutive `step_finish` rows.
      ...(options.sequentialHires === true ? [stepRow('d0', 2, base + 1_200, 1)] : []),
      toolRow({ runId: 'd0', index: 3, at: base + 1_500, name: 'agents', id: 'hire-b',
        args: { action: 'hire', role: 'task', lifetime: 'task', mission: 'write beta' },
        result: { name: SECOND_HIRE, answer: 'BETA' } }),
      stepRow('d0', 4, base + 1_800, options.sequentialHires === true ? 2 : 1),
      toolRow({ runId: 'd0', index: 5, at: base + 5_000, name: 'eval', id: 'submit-plan',
        args: { action: 'submit_plan' }, result: { id: 'plan-1', revision: 1 } }),
      stepRow('d0', 6, base + 5_200, options.sequentialHires === true ? 3 : 2),
      runEnd('d0', base + 6_000),
    ],
    // The queued implementation turn sits in the ledger from turn 2 on, ahead
    // of that turn's own run: it ran between the approval and the next prompt.
    [...implementRun, runStart('d1', turns[1] ?? '', base + 60_000), runEnd('d1', base + 61_000)],
    [runStart('d2', turns[2] ?? '', base + 70_000), runEnd('d2', base + 71_000)],
  ];

  const session = fixtureSession(state);

  return {
    session,
    events: (turn) => ledgers.slice(0, turn + 1).flat(),
    history: (turn) => {
      const rows: PublicMessage[] = [userRow(turns[0] ?? '')];

      if (options.systemCards === true) {
        for (const index of [1, 2, 3]) rows.push({ role: 'system', text: `card ${String(index)}` });
      }

      rows.push(assistantRow(relay));

      if (turn === 0) return rows;
      // The turn-2 answer is GENERATED from the read models, so a mutation to
      // the task list or the slate list moves the reply with it and only the
      // subgoal the mutation is about can flip.
      const listed = state.tasks.map((task) => `${task.id} · ${task.status}`);
      const titles = state.slates.map((slate) => slate.title);
      rows.push(userRow(turns[1] ?? ''), assistantRow([...listed, 'slates:', ...titles].join('\n')));

      if (turn === 1) return rows;
      rows.push(userRow(turns[2] ?? ''),
        assistantRow(options.nameFirstHire === true ? FIRST_HIRE : SECOND_HIRE));

      return rows;
    },
  };
}

// ── Case 3's fixture: two runtimes and one refused boundary ───────

interface CloneFixtureOptions {
  readonly viteOnWorkspace?: boolean;
  readonly sandboxFirst?: boolean;
  readonly twoLineReason?: boolean;
  readonly staleToken?: boolean;
}

const WORKSPACE_A_URL = 'http://127.0.0.1:18791';

const SANDBOX_A_URL = 'http://127.0.0.1:18792';

const SANDBOX_B_URL = 'http://127.0.0.1:18793';

function cloneWorld(options: CloneFixtureOptions): FixtureWorld {
  const turns = CASE_CLONE_TURNS();
  const base = Date.parse('2026-09-17T12:00:00Z');
  const token = `A-${PROBE_NONCE}`;

  const state: FixtureState = {
    slates: [],
    ports: { workspace: [], sandbox: [] },
    files: { 'apps/a/server.js': appAServer(PROBE_NONCE) },
    tasks: [], subordinates: [], plans: [],
    preview: (url, path) => {
      if (path === '/health' && url === WORKSPACE_A_URL) {
        return { status: 200, text: JSON.stringify({ ok: true, token }) };
      }

      if (path === '/health' && url === SANDBOX_A_URL) {
        return {
          status: 200,
          text: JSON.stringify({ ok: true, token: options.staleToken === true ? 'A-STALE1' : token }),
        };
      }

      if (path === '/' && url === SANDBOX_B_URL) {
        return { status: 200, text: `<!doctype html><title>APP-B-${PROBE_NONCE}</title>` };
      }

      return { status: 404, text: 'not found' };
    },
  };

  const refusal = 'node: cannot run JavaScript in this workspace: the host forbids runtime code '
    + 'compilation ("Code generation from strings disallowed").';

  const workspaceAttempt = toolRow({
    runId: 'c2', index: 1, at: base + 40_000, name: 'shell', id: 'vite-workspace',
    args: { command: 'cd seed/app-b && npm i && npx vite --host --port 8793', runtime: 'workspace' },
    result: refusal, failed: true,
  });

  const sandboxRun = toolRow({
    runId: 'c2', index: 2, at: base + 41_000, name: 'shell', id: 'vite-sandbox',
    args: { command: 'cd seed/app-b && npm i && npx vite --host --port 8793', runtime: 'sandbox' },
    result: 'vite dev server running', failed: false,
  });

  const ledgers: RunEvent[][] = [
    [
      runStart('c0', turns[0] ?? '', base),
      toolRow({ runId: 'c0', index: 1, at: base + 1_000, name: 'shell', id: 'git',
        args: { command: 'cd seed/app-a && git init && git add -A && git commit -m seed && git clone . /home/main/apps/a', runtime: 'workspace' },
        result: 'Cloning into /home/main/apps/a' }),
      runEnd('c0', base + 2_000),
    ],
    [runStart('c1', turns[1] ?? '', base + 20_000), runEnd('c1', base + 21_000)],
    [
      runStart('c2', turns[2] ?? '', base + 39_000),
      // ORDER IS THE SUBJECT: the workspace attempt must precede the sandbox
      // call, so the mutation is the same two rows the other way round.
      ...(options.sandboxFirst === true
        ? [{ ...sandboxRun, eventIndex: 1 }, { ...workspaceAttempt, eventIndex: 2 }]
        : [workspaceAttempt, sandboxRun]),
      runEnd('c2', base + 42_000),
    ],
  ];

  const reason = options.twoLineReason === true
    ? 'Ran it in the sandbox instead.\nThe workspace forbids runtime code compilation.'
    : 'Ran it in the sandbox: the workspace host forbids runtime code compilation.';

  return {
    session: fixtureSession(state),
    events: (turn) => ledgers.slice(0, turn + 1).flat(),
    history: (turn) => {
      const rows: PublicMessage[] = [
        userRow(turns[0] ?? ''),
        assistantRow(`${WORKSPACE_A_URL}\n${JSON.stringify({ ok: true, token })}`),
      ];

      if (turn === 0) return rows;
      rows.push(userRow(turns[1] ?? ''), assistantRow(`${WORKSPACE_A_URL}\n${SANDBOX_A_URL}`));

      if (turn === 1) return rows;
      rows.push(userRow(turns[2] ?? ''), assistantRow(reason));

      return rows;
    },
    advance: (turn) => {
      if (turn === 0) state.ports = { workspace: [{ port: APP_A_PORT, url: WORKSPACE_A_URL }], sandbox: [] };

      if (turn === 1) {
        state.ports = {
          workspace: [{ port: APP_A_PORT, url: WORKSPACE_A_URL }],
          sandbox: [{ port: APP_A_SANDBOX_PORT, url: SANDBOX_A_URL }],
        };
      }

      if (turn === 2) {
        state.ports = {
          workspace: [
            { port: APP_A_PORT, url: WORKSPACE_A_URL },
            ...(options.viteOnWorkspace === true ? [{ port: APP_B_PORT, url: 'http://127.0.0.1:28793' }] : []),
          ],
          sandbox: [
            { port: APP_A_SANDBOX_PORT, url: SANDBOX_A_URL },
            { port: APP_B_PORT, url: SANDBOX_B_URL },
          ],
        };
      }
    },
  };
}

// ── Case 4's fixture: memory and tasks across an eviction ─────────

interface ContinuityFixtureOptions {
  readonly skipRecall?: boolean;
  readonly paraphrasedFile?: boolean;
  readonly taskLeftOpen?: boolean;
  readonly trailingQuestion?: boolean;
}

function continuityWorld(options: ContinuityFixtureOptions): FixtureWorld {
  const turns = CASE_CONTINUITY_TURNS();
  const base = Date.parse('2026-09-17T13:00:00Z');
  const oncall = options.paraphrasedFile === true ? 'Priya Sharma' : ON_CALL;

  const state: FixtureState = {
    slates: [], ports: {},
    files: { 'notes/window.txt': DEPLOY_WINDOW },
    tasks: [
      { id: 't1', title: 'write notes/window.txt with the deploy window', status: 'done', createdAt: base, updatedAt: base, subtasks: [] },
      { id: 't2', title: 'write notes/oncall.txt with the on-call name', status: 'open', createdAt: base, updatedAt: base, subtasks: [] },
      { id: 't3', title: 'write notes/rollback.txt with the rollback command', status: 'open', createdAt: base, updatedAt: base, subtasks: [] },
    ],
    subordinates: [], plans: [],
    preview: () => ({ status: 404, text: 'this case serves nothing' }),
  };

  const ledgers: RunEvent[][] = [
    [
      runStart('k0', turns[0] ?? '', base),
      toolRow({ runId: 'k0', index: 1, at: base + 1_000, name: 'memory', id: 'save-1',
        args: { action: 'save', content: `The deploy window is ${DEPLOY_WINDOW}. On call: ${ON_CALL}. Rollback: ${ROLLBACK}` },
        result: 'saved' }),
      toolRow({ runId: 'k0', index: 2, at: base + 2_000, name: 'tasks', id: 'add',
        args: { action: 'add' }, result: 'three tasks' }),
      toolRow({ runId: 'k0', index: 3, at: base + 3_000, name: 'file', id: 'write-window',
        args: { action: 'write', path: 'notes/window.txt' }, result: 'ok' }),
      runEnd('k0', base + 4_000),
    ],
    [
      runStart('k1', turns[1] ?? '', base + 40_000),
      ...(options.skipRecall === true ? [] : [toolRow({
        runId: 'k1', index: 1, at: base + 41_000, name: 'memory', id: 'search',
        args: { action: 'search', query: 'deploy window on-call rollback' },
        result: `The deploy window is ${DEPLOY_WINDOW}. On call: ${ON_CALL}. Rollback: ${ROLLBACK}`,
      })]),
      toolRow({ runId: 'k1', index: 2, at: base + 42_000, name: 'file', id: 'write-oncall',
        args: { action: 'write', path: 'notes/oncall.txt' }, result: 'ok' }),
      runEnd('k1', base + 43_000),
    ],
    [runStart('k2', turns[2] ?? '', base + 60_000), runEnd('k2', base + 61_000)],
  ];

  return {
    session: fixtureSession(state),
    events: (turn) => ledgers.slice(0, turn + 1).flat(),
    history: (turn) => {
      const rows: PublicMessage[] = [userRow(turns[0] ?? ''), assistantRow('DONE')];

      if (turn === 0) return rows;

      const answer = [
        state.files['notes/window.txt'] ?? '',
        state.files['notes/oncall.txt'] ?? '',
        state.files['notes/rollback.txt'] ?? '',
        ...(options.trailingQuestion === true ? ['Anything else you want closed?'] : []),
      ].join('\n');

      rows.push(userRow(turns[1] ?? ''), assistantRow(answer));

      if (turn === 1) return rows;
      rows.push(userRow(turns[2] ?? ''),
        assistantRow(`${ON_CALL} is on call and the deploy window is ${DEPLOY_WINDOW}.`));

      return rows;
    },
    advance: (turn) => {
      // Turn 2 finishes the work: the two files land and the two tasks close.
      if (turn !== 1) return;
      state.files = { ...state.files, 'notes/oncall.txt': oncall, 'notes/rollback.txt': ROLLBACK };

      state.tasks = state.tasks.map((task) => task.id === 't3' && options.taskLeftOpen === true
        ? task
        : { ...task, status: 'done' });
    },
  };
}

// ── Case 5's fixture: an app asked for with no format named ─────────

interface GameFixtureOptions {
  /** The 2048 transcript: no slate, a static page on an exposed port, the skill never found. */
  readonly staticPage?: boolean;
  /** A server exposed beside a correct slate. */
  readonly serverBeside?: boolean;
  /** The skill read at a path that does not exist. */
  readonly skillMissed?: boolean;
  /** The title turn changed nothing in the slate's source. */
  readonly titleUnchanged?: boolean;
  /** The link wrapped in a sentence. */
  readonly proseLink?: boolean;
}

const GAME_URL = 'https://eval-game-slate-2048.kinu.run/';

function gameWorld(options: GameFixtureOptions): FixtureWorld {
  const turns = CASE_GAME_TURNS(PROBE_NONCE);
  const base = Date.parse('2026-09-23T12:00:00Z');
  const slate = options.staticPage !== true;

  const state: FixtureState = {
    slates: slate ? [{ id: '2048', title: '2048', bindings: [] }] : [],
    ports: { workspace: [], sandbox: [] },
    files: {}, tasks: [], subordinates: [], plans: [],
    slatePreview: (id) => ({ ok: true, value: { url: GAME_URL, port: id === '2048' ? 0 : -1 } }),
    preview: (url, path) => url === GAME_URL && path === '/'
      ? { status: 200, text: '<!doctype html><title>2048</title>' }
      : { status: 404, text: 'not found' },
  };

  const skillPath = options.skillMissed === true || options.staticPage === true ? '/workspace/skills/slates.md' : '/skills/slates/SKILL.md';

  const ledgers: RunEvent[][] = [
    [
      runStart('g0', turns[0] ?? '', base),
      toolRow({ runId: 'g0', index: 1, at: base + 1_000, name: 'file', id: 'skill',
        args: { action: 'read', path: skillPath }, failed: skillPath !== '/skills/slates/SKILL.md' }),
      toolRow({ runId: 'g0', index: 2, at: base + 2_000, name: 'file', id: 'write',
        args: { action: 'write', path: slate ? 'slates/2048/server.ts' : 'game/index.html' }, result: 'ok' }),
      runEnd('g0', base + 3_000),
    ],
    [runStart('g1', turns[1] ?? '', base + 20_000), runEnd('g1', base + 21_000)],
    [runStart('g2', turns[2] ?? '', base + 40_000), runEnd('g2', base + 41_000)],
  ];

  const link = options.staticPage === true ? 'https://eval-game-8080.kinu.run/' : GAME_URL;

  return {
    session: {
      ...fixtureSession(state),
      execute: async (_executor: string, command: string) => ({
        stdout: slate && options.titleUnchanged !== true && command.includes(PROBE_NONCE) ? `${WORKSPACE_ROOT}/slates/2048/client.tsx\n` : '',
        stderr: '', exitCode: 0,
      }),
    },
    events: (turn) => ledgers.slice(0, turn + 1).flat(),
    history: (turn) => [
      userRow(turns[0] ?? ''), assistantRow('Built it.'),
      ...(turn >= 1 ? [userRow(turns[1] ?? ''), assistantRow('Retitled.')] : []),
      ...(turn >= 2 ? [userRow(turns[2] ?? ''), assistantRow(options.proseLink === true ? `Play it here: ${link}` : link)] : []),
    ],
    advance: (turn) => {
      if (turn !== 0) return;

      if (options.staticPage === true || options.serverBeside === true) {
        state.ports = { workspace: [{ port: 8080, url: 'https://eval-game-8080.kinu.run/' }], sandbox: [] };
      }
    },
  };
}

describe('Kinu task evals — red probes over the four canned worlds', () => {
  test('delegate-and-build: a correct delegation passes, and each mutation flips its own subgoal', async () => {
    await probe(DELEGATE_AND_BUILD, 'minimal correct', delegateWorld({}), []);
    await probe(DELEGATE_AND_BUILD, 'hires split by a step boundary', delegateWorld({ sequentialHires: true }), ['parallel-delegation']);
    await probe(DELEGATE_AND_BUILD, 'beta file carries the wrong nonce', delegateWorld({ wrongNonce: true }), ['files']);
    await probe(DELEGATE_AND_BUILD, 'relay lowercased', delegateWorld({ lowercaseRelay: true }), ['answers-relayed']);
    await probe(DELEGATE_AND_BUILD, 'plan with two steps', delegateWorld({ twoStepPlan: true }), ['plan-submitted']);
    await probe(DELEGATE_AND_BUILD, 'three system cards in the root chat', delegateWorld({ systemCards: true }), ['no-card-leak']);
    await probe(DELEGATE_AND_BUILD, 'a task left active', delegateWorld({ taskLeftActive: true }), ['tasks-closed']);
    await probe(DELEGATE_AND_BUILD, 'one slate exposed but not served', delegateWorld({ slateNotServed: true }), ['slates-built']);
    await probe(DELEGATE_AND_BUILD, 'reply names the first hire', delegateWorld({ nameFirstHire: true }), ['attribution']);
  });

  test('clone-and-serve: correct routing passes, and each mutation flips its own subgoal', async () => {
    await probe(CLONE_AND_SERVE, 'minimal correct', cloneWorld({}), []);
    await probe(CLONE_AND_SERVE, '8793 also on the workspace', cloneWorld({ viteOnWorkspace: true }), ['routed']);
    await probe(CLONE_AND_SERVE, 'sandbox call before any workspace attempt', cloneWorld({ sandboxFirst: true }), ['boundary-discovered']);
    await probe(CLONE_AND_SERVE, 'reason given in two lines', cloneWorld({ twoLineReason: true }), ['reason-stated']);
    await probe(CLONE_AND_SERVE, 'sandbox /health with a stale token', cloneWorld({ staleToken: true }), ['served-sandbox']);
  });

  test('durable-continuity: correct recall passes, and each mutation flips its own subgoal', async () => {
    await probe(DURABLE_CONTINUITY, 'minimal correct', continuityWorld({}), []);
    await probe(DURABLE_CONTINUITY, 'no memory read after the eviction', continuityWorld({ skipRecall: true }), ['recalled']);
    await probe(DURABLE_CONTINUITY, 'on-call file paraphrased', continuityWorld({ paraphrasedFile: true }), ['files']);
    await probe(DURABLE_CONTINUITY, 'a task left open', continuityWorld({ taskLeftOpen: true }), ['tasks-done']);
    await probe(DURABLE_CONTINUITY, 'reply ends in a question', continuityWorld({ trailingQuestion: true }), ['no-question']);
  });

  test('game-as-slate: a slate passes, and each mutation flips its own subgoal', async () => {
    await probe(GAME_AS_SLATE, 'minimal correct', gameWorld({}), []);
    await probe(GAME_AS_SLATE, 'the 2048 transcript: a static page on an exposed port', gameWorld({ staticPage: true }),
      ['slate', 'playable', 'no-standalone-server', 'read-slates-skill', 'retitled', 'link']);
    await probe(GAME_AS_SLATE, 'a server beside the slate', gameWorld({ serverBeside: true }), ['no-standalone-server']);
    await probe(GAME_AS_SLATE, 'skill read at a path that does not exist', gameWorld({ skillMissed: true }), ['read-slates-skill']);
    await probe(GAME_AS_SLATE, 'title turn changed nothing', gameWorld({ titleUnchanged: true }), ['retitled']);
    await probe(GAME_AS_SLATE, 'link wrapped in a sentence', gameWorld({ proseLink: true }), ['link']);
  });
});

/**
 * EvolutionEngine — manages all 3 timescales of self-evolution.
 *
 * This is NOT a separate "evolve" command — it's baked into the agent loop.
 * After every turn, session, and periodically at the lifetime level,
 * the engine automatically reflects, discovers patterns, and evolves.
 *
 * Architecture reference: docs/EVOLUTION.md — "Three Timescales"
 *
 * Timescale 1 — Turn-level (reviewTurn, Hermes-style forked review):
 *   When user message N+1 arrives IN THE SAME CONVERSATION, turn N is graded
 *   from the user's actual follow-up (accepted / corrected / frustrated). A
 *   turn no follow-up can grade — a programmatic wake, or a one-shot
 *   `proteus exec` whose next invocation is an unrelated task — records no
 *   outcome: an honest absence, never a constant, and never an `accepted`
 *   inferred from the fact that something else happened next.
 *   The outcome populates turn.feedback, drives craft EMA, gates reflection
 *   (corrected/frustrated turns warrant it; accepted turns extract patterns),
 *   and lands in the durable turn_outcomes ledger that GEPA eval splits,
 *   scaffold base-selection priors, and the replay harness read.
 *
 * Timescale 2 — Session-level (onSessionComplete):
 *   Reflect on patterns when the window carries real negative signal —
 *   accepted streaks skip the reflection. The every-N-turns cadence lives in
 *   ONE place — AgentOrchestrator (recordTurn), over the durable window this
 *   engine owns (session-window.ts), so it survives process/instance death.
 *
 * Timescale 3 — Lifetime-level (every N closed session windows):
 *   CraftStore consolidation → MCTS exploration. The replay eval is NOT on
 *   this cadence: it re-executes the same ledger GEPA's seed scoring already
 *   re-executes, for a curve no decision reads. It runs on demand instead.
 */

import type { AgentRuntime } from '../types/agent-runtime.js';
import type { LLM } from '../types/primitives.js';
import type { SessionWriter } from '../mcts/record-node.js';
import type {
  CompletedTurn,
  CompletedSession,
  EvolutionEvent,
  EvolutionListener,
  EvolutionConfig,
} from './types.js';
import { DEFAULT_EVOLUTION_CONFIG } from './types.js';
import { isoDate } from '../utils/date.js';
import { extractJsonObject, jsonObjectOnlyInstruction } from '../prompts/structured.js';
import { upsertCraftedTool } from '../craft/conflict.js';
import { periodicCraftConsolidation } from '../craft/consolidation.js';
import { updateCraftScores } from '../craft/ema.js';
import { initCraftScoreTables } from '../craft/schemas.js';
import { createCraftLedger, type CraftLedger } from '../craft/in-episode.js';
import { readSoul, summarizeSoul } from '../identity/soul.js';
import {
  type TurnOutcome, type TurnOutcomeSource, type OutcomeClassification,
  initTurnOutcomeTables, isTrivialTurn, isNegativeOutcome, classifyTurnOutcome,
  executionVerdict, executionVerdictOutcome, isUserVerdictSource, isPureLookupCall,
  outcomeToFeedback, outcomeQuality, feedbackToQuality,
  recordTurnOutcome, hasNegativeOutcome, takePickOutcome,
  listTurnOutcomes, NEGATIVE_TURN_OUTCOMES,
  realOutcomeScaffoldRates, blendRealOutcomeRates,
  recordLesson, corroborateLessonsForTurn, type LessonRow,
} from './outcomes.js';
import {
  bindPendingImports, settleImportsForTurn, type ImportedExperienceRow,
} from '../experience/imports.js';
import { initReplayTables, runReplayEval, type ReplayEvalSummary } from './replay.js';
import {
  initSessionWindowTable, createSessionWindowStore, type SessionWindowStore,
} from './session-window.js';
import { formatScoreInterval, lossInterval } from '../utils/stats.js';
import { buildChangelog } from './changelog.js';
import { delegationFeatures, renderDelegationFeatures } from './delegation-features.js';
import { renderScaffoldHandbook } from './scaffold-handbook.js';
import {
  clusterPathologies, labelPathologyClusters, renderPathologyBlock,
  describePathology, parsePathologyTag, PATHOLOGY_TAG_EXAMPLE,
  type PathologyCluster,
} from './pathology.js';

// Re-exported here for back-compat: the mapping predates the outcomes module.
export { feedbackToQuality };

/**
 * Built-in tool names — crafted-tool scoring ignores these.
 * Sourced from the canonical registry so CF and CLI share one truth.
 */
import { BUILTIN_TOOL_NAMES as BUILT_IN_TOOL_NAMES } from '../tools/registry.js';
import { modifyScaffold } from '../scaffold/modify.js';
import { SCAFFOLD_HOST_TYPES } from '../scaffold/executor.js';
import { SCAFFOLD_FORBIDDEN_DESCRIPTION } from '../scaffold/safety-patterns.js';
import {
  listScaffoldArchive, listRejectedProposals, selectEvolutionBase,
  type EvolutionBaseSelection, type ScaffoldArchiveEntry,
} from '../scaffold/archive.js';
import { readScaffoldVersion, getCurrentScaffoldVersion } from '../scaffold/shadow.js';
import { runMCTS } from '../mcts/engine.js';
import { createAgentConfigStore, initAgentConfigTable, type AgentConfigStore } from '../config/store.js';

/** The archive context handed to the proposal prompt: which version the
 *  proposal branches from + the variants it may cite as stepping stones. */
export interface ProposalArchiveContext {
  base: EvolutionBaseSelection;
  entries: ReadonlyArray<ScaffoldArchiveEntry>;
  /** Real user-outcome record per version (accepted/negative counts) — shown
   *  alongside the shadow record when present. */
  realRates?: ReadonlyMap<number, { accepted: number; negative: number }>;
  /** Why each refused version was refused (scaffold/archive.ts
   *  listRejectedProposals) — Weng's negative-result preservation, so a
   *  proposal can see what has already failed to work and why. */
  rejections?: ReadonlyMap<number, string>;
}

function renderArchiveBlock(archive: ProposalArchiveContext): string {
  const lines = archive.entries.slice(0, 8).map((e) => {
    const lineage = e.parentVersion != null ? `parent v${e.parentVersion}` : 'root';
    const record = e.trials > 0 ? `${e.wins}-${e.losses}-${e.ties} W-L-T` : 'untried';
    const real = archive.realRates?.get(e.version);
    const realNote = real && real.accepted + real.negative > 0
      ? `, real ${real.accepted}✓/${real.negative}✗`
      : '';
    const targeted = e.pathology !== null ? `, for ${e.pathology}` : '';
    const rejection = archive.rejections?.get(e.version);
    const why = rejection ? `\n    refused: ${rejection}` : '';
    return `  v${e.version} [${e.status}, ${lineage}, ${record}${realNote}${targeted}] — ${e.rationale.slice(0, 80)}${why}`;
  });
  const baseNote = archive.base.mode === 'explore'
    ? `You are branching from ARCHIVED v${archive.base.version} (a stepping stone, not the live current) — its code is shown above.`
    : `You are branching from the live current v${archive.base.version}.`;
  return (
    `Scaffold archive (your prior variants — lineage + shadow record):\n` +
    `${lines.join('\n')}\n` +
    `${baseNote} You may take ideas from any archived variant; cite its version when you do.\n\n`
  );
}

/**
 * The scaffold-proposal prompt — documents the REAL sandbox contract
 * (scaffold/executor.ts): the host runtime never crosses the sandbox
 * boundary, so all host interaction goes through the `host.*` bridge, and
 * both `run(rt, task)` parameters receive the task string. Exported so
 * tests can assert a proposal written against these instructions survives
 * the executor's smoke path. When archive context is given, the prompt shows
 * the variant archive so proposals can cite stepping stones (DGM-style).
 *
 * The handbook (evolution/scaffold-handbook.ts) is prepended beside the host
 * d.ts: the Harness Handbook result is that an agent editing its own harness
 * plans better and cheaper from a behaviour→site map than from raw source.
 *
 * When mined pathologies are supplied, the prompt shows them and requires the
 * proposal to name the one it targets — Self-Harness's mine-weaknesses step,
 * typed. With none mined there is nothing to name, so the requirement is
 * absent rather than answered with a guess.
 */
export function buildScaffoldProposalPrompt(
  baseScaffold: string,
  reflection: string,
  archive?: ProposalArchiveContext,
  pathologies: ReadonlyArray<PathologyCluster> = [],
): string {
  return (
    `${renderScaffoldHandbook(baseScaffold)}\n` +
    `Current agent scaffold (your agentic loop — it runs inside a sandboxed worker):\n` +
    `\`\`\`js\n${baseScaffold}\n\`\`\`\n\n` +
    (archive ? renderArchiveBlock(archive) : '') +
    (pathologies.length > 0 ? renderPathologyBlock(pathologies) : '') +
    `Based on these session patterns:\n${reflection.slice(0, 500)}\n\n` +
    `Propose an improved scaffold. The scaffold MUST:\n` +
    `1. Export exactly \`async function* run(rt, task)\`. There is NO host runtime object in the ` +
    `sandbox — BOTH parameters receive the task STRING; read the task from either.\n` +
    `2. Reach the host ONLY through the global \`host\` bridge:\n` +
    `\`\`\`ts\n${SCAFFOLD_HOST_TYPES}\n\`\`\`\n` +
    `\`await host.defaultInference()\` runs the standard inference loop — build on it or replace it ` +
    `with your own strategy via host.llmStream / host.callTool.\n` +
    `3. Stream text to the user by yielding { type: 'chunk', data: '<text>' }.\n` +
    `4. NOT use ${SCAFFOLD_FORBIDDEN_DESCRIPTION}. Also never reference raw network globals ` +
    `(fetch/WebSocket — use host.callTool for I/O), the scaffold version files/tables, ` +
    `promotion/rollout config keys, or shell-approval/consent settings — any of these is a hard ` +
    `misevolution veto.\n` +
    `5. Be a self-contained agentic loop.\n` +
    (pathologies.length > 0
      ? `6. Name the failure pathology it targets, as a tag line in the code: ` +
        `\`${PATHOLOGY_TAG_EXAMPLE}\`, using one of the ids listed above. The archive is ` +
        `read by pathology — a version that names none cannot be compared with the ones ` +
        `that do, and cannot show whether that failure ever went away.\n`
      : '') +
    `\nReturn ONLY the JavaScript code, no explanation.`
  );
}

export class EvolutionEngine {
  private rt: AgentRuntime;
  private config: EvolutionConfig;
  private listeners: EvolutionListener[] = [];
  /** Operator-tuned agent_config (MCTS overrides for lifetime evolution) —
   *  also the home of the durable closed-window count the lifetime timescale
   *  paces itself by. */
  private agentConfig: AgentConfigStore;
  /** The open reflection window + the turn awaiting its outcome review.
   *  AgentOrchestrator owns the cadence policy; the engine owns the ledger,
   *  as it does for outcomes, lessons and replays. */
  readonly sessionWindow: SessionWindowStore;
  /** The crafted-tool ledger the IN-EPISODE loop writes through (the step
   *  clock, orchestrator/craft-cycle.ts). Same division of labour as the
   *  window above: the orchestrator decides when an observation is taken, the
   *  engine owns the ledger it lands in — so both timescales score crafted
   *  tools through one table and one policy. */
  readonly craftLedger: CraftLedger;

  constructor(rt: AgentRuntime, config?: Partial<EvolutionConfig>) {
    this.rt = rt;
    this.config = { ...DEFAULT_EVOLUTION_CONFIG, ...config };
    this.craftLedger = createCraftLedger({ craftStore: rt.craftStore, sql: rt.storage.sql });

    // The engine owns the outcome + lessons + replay + session-window ledgers,
    // and the config table it paces the lifetime timescale in — created here so
    // both backends (and tests) get them without per-backend schema wiring.
    // `craft_scores` joins them: the engine writes it from the turn clock and
    // the in-episode clock writes it through `craftLedger`, and it was ensured
    // at actor attach on cf but only at `proteus create` on the CLI — so a
    // workspace that predated the table, or one built over a bare database,
    // silently scored nothing at all.
    initCraftScoreTables(rt.storage.execRaw);
    initTurnOutcomeTables(rt.storage.execRaw, rt.storage.sql);
    initReplayTables(rt.storage.execRaw);
    initSessionWindowTable(rt.storage.execRaw);
    initAgentConfigTable(rt.storage.execRaw);
    this.agentConfig = createAgentConfigStore(rt.storage.sql);
    this.sessionWindow = createSessionWindowStore(rt.storage.sql);
  }

  /**
   * The model the MECHANICAL calls run on — outcome classification, pathology
   * labels, the one-sentence turn reflection, the session reflection, and
   * pattern extraction. Short, schema-constrained jobs the chat vendor's small
   * tier does as well as its flagship (providers/fast-model.ts). Falls back to
   * the chat model when the vendor has no smaller tier, which is what every
   * backend did before this existed.
   *
   * Deliberately NOT used for the scaffold proposal: that call authors the
   * agent's own control loop, is rare, and already runs at high reasoning
   * effort — it is the one place in this file where paying for the better
   * model is the point.
   */
  private get fastLlm(): LLM {
    return this.rt.fastLlm ?? this.rt.llm;
  }

  /** Whether auto-evolution is on for this workspace session. Read by
   *  AgentOrchestrator so a `--no-auto-evolve` run records no evolution state
   *  at all, rather than buffering turns for a later host to evolve. */
  get enabled(): boolean {
    return this.config.enabled;
  }

  /** Subscribe to evolution events (for CLI/UI display) */
  onEvent(listener: EvolutionListener): void {
    this.listeners.push(listener);
  }

  private emit(event: EvolutionEvent): void {
    // Persist to SQL so UI can query it
    try {
      this.rt.storage.sql`INSERT INTO evolution_events (type, message, data, created_at)
        VALUES (${event.type}, ${event.message}, ${event.data ? JSON.stringify(event.data) : null}, ${Date.now()})`;
    } catch {
      // Table may not exist yet in test environments — that's fine
    }
    for (const listener of this.listeners) {
      listener(event);
    }
  }

  // ── Timescale 1: Turn-level (outcome-driven forked review) ──────

  /**
   * Grade turn N from the user's follow-up and run turn-level evolution on
   * the result. `followup` is the NEXT user message; null means no
   * conversational follow-up can grade this turn — a programmatic turn (the
   * reactor and job wakes carry no user verdict) or a one-shot invocation
   * (`proteus exec`, where the next prompt is a different task, written by a
   * caller who never saw this answer) — and the turn records no outcome at all.
   *
   * One signal pipeline: explicit thumbs (recorded before the follow-up)
   * beat the classifier; trivial turns (greetings) skip the LLM call; a
   * classifier failure records nothing rather than guessing. An absent
   * outcome is not a neutral one: `turn.hadError` still drives quality and a
   * provisional reflection below, which is the only machine signal a turn
   * nobody graded actually carries.
   */
  async reviewTurn(turn: CompletedTurn, followup: string | null): Promise<void> {
    if (!this.config.enabled) return;

    let outcome: TurnOutcome | null = null;
    let source: TurnOutcomeSource = 'classifier';
    let confidence = 1;
    let evidence = '';
    // An Alternate Takes pick already wrote this turn's ledger row — adopt it
    // for the downstream evolution (EMA, lessons, patterns) without letting
    // the classifier overwrite the explicit preference.
    let preRecorded = false;

    const explicit = this.readExplicitFeedback(turn.turnId);
    const pickedOutcome = explicit ? null : takePickOutcome(this.rt.storage.sql, turn.turnId);
    if (explicit) {
      outcome = explicit === 'positive' ? 'accepted' : 'corrected';
      source = 'explicit';
    } else if (pickedOutcome) {
      outcome = pickedOutcome;
      source = 'take_pick';
      preRecorded = true;
    } else if (isTrivialTurn(turn)) {
      return; // pre-filter: nothing to accept or correct, no LLM call
    } else if (followup !== null) {
      const c: OutcomeClassification | null = await classifyTurnOutcome(this.fastLlm, {
        userMessage: turn.userMessage,
        assistantResponse: turn.assistantResponse,
        followup,
      });
      if (!c) return; // classifier unusable — no signal beats a guessed one
      outcome = c.outcome;
      confidence = c.confidence;
      evidence = c.evidence;
    } else {
      // No follow-up can grade this turn, so no USER signal exists — but the
      // environment may still have returned a verdict on what the turn did.
      // That is the only evidence a headless run produces, and reading it is
      // what makes the headless channel symmetric: before this, a turn that
      // errored fed a punishment and a turn that worked fed nothing at all.
      const verdict = executionVerdict(turn);
      if (verdict) {
        outcome = executionVerdictOutcome(verdict);
        source = 'execution';
        evidence = verdict === 'succeeded'
          ? 'every tool call this turn ran completed'
          : 'the turn ended in an error';
        // The observation is certain — the runtime reported it. That the
        // observation stands in for a verdict is what `source: 'execution'`
        // and the narrower EXECUTION_QUALITY band already say; saying it a
        // third time here would just double-discount the same caveat.
        confidence = 1;
      }
      // With no tool work either, the turn stays ungraded. It is NOT written
      // as 'abandoned': a conversational follow-up may still be coming, and
      // everything that reads the ledger already discounts abandonment —
      // alignmentConvergence counts it as ungraded and buildOutcomeEvalSplit
      // ignores it — so writing it would only pull the crafted-tool EMA toward
      // a neutral 0.5 on evidence nobody has. The ungraded turn is still
      // RECORDED, as the `turn_complete` event below with `graded: false`;
      // what it is not is counted as a success.
    }

    if (outcome) {
      if (!preRecorded) {
        recordTurnOutcome(this.rt.storage.sql, {
          turnId: turn.turnId ?? null,
          sessionId: turn.sessionId ?? 'default',
          outcome, confidence, source,
          userMessage: turn.userMessage,
          assistantResponse: turn.assistantResponse,
          followup,
          scaffoldVersion: this.currentScaffoldVersion(),
        });
      }
      turn.feedback = outcomeToFeedback(outcome);
    }

    // Quality: the outcome IS the signal, priced by where the verdict came
    // from. An abandoned turn (only ever an existing ledger row now) that
    // errored is the one case the error decides; a clean abandonment stays
    // neutral.
    const quality: number | null = outcome
      ? (outcome === 'abandoned' && turn.hadError ? 0.1 : outcomeQuality(outcome, source))
      : (turn.hadError ? 0.1 : null);

    // `source`/`confidence` describe a verdict, so they are null on an
    // ungraded turn rather than reporting the classifier default as if a
    // classification had happened.
    this.emit({
      type: 'turn_complete',
      message: `Turn outcome: ${outcome ?? 'ungraded (no follow-up)'}` +
        (quality !== null ? ` | quality ${quality.toFixed(2)}` : '') +
        ` | ${turn.toolCalls.length} tool calls | ${turn.steps} steps | ${turn.hadError ? 'had errors' : 'clean'}`,
      data: {
        outcome, graded: outcome !== null,
        source: outcome ? source : null,
        confidence: outcome ? confidence : null,
        evidence, quality,
        toolCount: turn.toolCalls.length, steps: turn.steps, durationMs: turn.durationMs,
      },
    });

    if (quality === null) return; // programmatic + clean: nothing to learn from

    // Craft EMA — real-outcome observations on the crafted tools this turn used.
    const craftedToolNames = turn.toolCalls
      .map(tc => tc.name)
      .filter(name => !BUILT_IN_TOOL_NAMES.has(name));
    if (craftedToolNames.length > 0) {
      try {
        updateCraftScores(this.rt.storage.sql, craftedToolNames, quality);
      } catch {
        // Score update failure is non-fatal
      }
    }

    const negative = isNegativeOutcome(outcome);
    // A negative verdict from a PERSON corroborates the provisional lessons
    // waiting on this turn (an earlier error reflection, a session reflection)
    // and lands them in MEMORY.md. The environment's verdict deliberately does
    // not: corroboration is the gate that keeps self-scored prose out of
    // durable memory until something outside the model backs it, and "the turn
    // hit an error" is not a reader confirming the lesson drawn from it. It
    // still warrants the reflection below, provisionally — exactly as an
    // errored ungraded turn always did.
    const corroborated = negative && isUserVerdictSource(source);
    if (corroborated) {
      await this.corroborateLessons(turn.turnId);
    }

    // Imported experience rides this turn's verdict: accepted adopts it into
    // this workspace's own stores, anything else discards it. Only a user
    // verdict settles it — adopting another workspace's craft because a local
    // command exited zero is not the corroboration that trust boundary asks for.
    if (isUserVerdictSource(source)) await this.settleImports(turn.turnId, outcome);

    // Reflection is warranted by negative signal of any provenance — or by an
    // error on a turn nobody graded at all, which stays provisional until a
    // user outcome corroborates it.
    if (negative || ((outcome === 'abandoned' || outcome === null) && turn.hadError)) {
      const reflection = await this.generateTurnReflection(turn, outcome, quality, followup);
      recordLesson(this.rt.storage.sql, {
        turnIds: turn.turnId ? [turn.turnId] : [],
        text: reflection,
        source: 'turn_reflection',
        status: corroborated ? 'corroborated' : 'provisional',
      });
      if (corroborated) {
        await this.rt.memory.append(
          'memory/MEMORY.md',
          `\n### Lesson (${isoDate()}, ${outcome}, quality=${quality.toFixed(2)})\n${reflection}\n`,
        );
        await this.rt.memory.index('memory/MEMORY.md');
      }
      this.emit({ type: 'reflection', message: corroborated ? reflection : `[provisional] ${reflection}` });
    }

    // Acceptance with tool usage → extract pattern to CraftStore. Both
    // provenances qualify: a headless turn whose tools all ran is the one
    // positive a headless workspace can produce, and it is the counterweight
    // that keeps the craft EMA from being driven by failures alone.
    if (outcome === 'accepted' && turn.toolCalls.length > 0) {
      await this.extractPattern(turn, quality);
    }
  }

  /**
   * Explicit thumbs arrived for a completed message (the chat UI's
   * setTurnFeedback path). Upserts the same turn_outcomes ledger the
   * classifier writes — explicit signal overrides — and lets a negative
   * verdict corroborate provisional lessons tied to that turn.
   */
  async applyExplicitFeedback(messageId: string, feedback: 'positive' | 'negative'): Promise<void> {
    let userMessage = '';
    let assistantResponse = '';
    let sessionId = 'default';
    try {
      const row = this.rt.storage.sql<{ response: string; request: string | null; session_id: string }>`
        SELECT m.content AS response, u.content AS request, m.session_id
        FROM messages m LEFT JOIN messages u ON u.id = m.parent_id
        WHERE m.id = ${messageId} LIMIT 1`[0];
      if (row) {
        assistantResponse = row.response;
        userMessage = row.request ?? '';
        sessionId = row.session_id;
      }
    } catch { /* messages mirror unavailable — record the verdict anyway */ }
    recordTurnOutcome(this.rt.storage.sql, {
      turnId: messageId,
      sessionId,
      outcome: feedback === 'positive' ? 'accepted' : 'corrected',
      confidence: 1,
      source: 'explicit',
      userMessage,
      assistantResponse,
      followup: null,
      scaffoldVersion: this.currentScaffoldVersion(),
    });
    if (feedback === 'negative') await this.corroborateLessons(messageId);
  }

  /** An Alternate Takes pick landed (the ledger row is already written by
   *  recordTakePick) — a correction corroborates provisional lessons exactly
   *  like an explicit thumbs-down. */
  async applyTakePick(turnId: string | null, outcome: 'accepted' | 'corrected'): Promise<void> {
    if (outcome === 'corrected' && turnId) await this.corroborateLessons(turnId);
  }

  /** Explicit thumbs recorded for this turn's message, if any. The
   *  turn_feedback table is cf-backend-owned; absent table = no feedback. */
  private readExplicitFeedback(turnId?: string): 'positive' | 'negative' | null {
    if (!turnId) return null;
    try {
      const rows = this.rt.storage.sql<{ feedback: 'positive' | 'negative' }>`
        SELECT feedback FROM turn_feedback WHERE message_id = ${turnId} LIMIT 1`;
      return rows[0]?.feedback ?? null;
    } catch {
      return null;
    }
  }

  private currentScaffoldVersion(): number | null {
    try {
      return getCurrentScaffoldVersion(this.rt.storage.sql);
    } catch {
      return null;
    }
  }

  /** Append newly corroborated lessons to durable memory. */
  private async corroborateLessons(turnId?: string): Promise<void> {
    if (!turnId) return;
    let upgraded: LessonRow[] = [];
    try {
      upgraded = corroborateLessonsForTurn(this.rt.storage.sql, turnId);
    } catch {
      return;
    }
    for (const lesson of upgraded) {
      const header = lesson.source === 'session_reflection'
        ? `## Session reflection (corroborated ${isoDate()})`
        : `### Lesson (corroborated ${isoDate()})`;
      await this.rt.memory.append('memory/MEMORY.md', `\n${header}\n${lesson.text}\n`);
    }
    if (upgraded.length > 0) await this.rt.memory.index('memory/MEMORY.md');
  }

  /**
   * Settle the experience this workspace imported from the owner's other
   * workspaces against the verdict of a turn it has just graded.
   *
   * Imports are staged, never adopted, so this is the only path by which
   * another workspace's craft, lesson or fact becomes part of THIS one — and it
   * runs on the same real-outcome signal that corroborates a lesson. An
   * ungraded turn settles nothing: the imports keep waiting for a turn that
   * carries a verdict.
   */
  private async settleImports(turnId: string | undefined, outcome: TurnOutcome | null): Promise<void> {
    if (!turnId || outcome === null || outcome === 'abandoned') return;
    try {
      bindPendingImports(this.rt.storage.sql, turnId);
      const settled = await settleImportsForTurn(
        this.rt, turnId, outcome === 'accepted' ? 'accepted' : 'rejected',
      );
      if (settled.corroborated.length === 0 && settled.discarded.length === 0) return;
      const describe = (rows: ImportedExperienceRow[]) =>
        rows.map((r) => `${r.kind} "${r.key}" from ${r.sourceWorkspace}`).join(', ');
      this.emit({
        type: 'experience_import',
        message: settled.corroborated.length > 0
          ? `Adopted imported experience after an accepted turn: ${describe(settled.corroborated)}`
          : `Discarded imported experience after a ${outcome} turn: ${describe(settled.discarded)}`,
        data: {
          outcome,
          corroborated: settled.corroborated.map((r) => r.libraryId),
          discarded: settled.discarded.map((r) => r.libraryId),
        },
      });
    } catch {
      // The imports ledger may not exist in minimal runtimes — settling is not
      // allowed to fail the turn review that produced the verdict.
    }
  }

  // ── Timescale 2: Session-level (end of conversation or every N turns) ──

  /**
   * Called by AgentOrchestrator (the single home of the every-N-turns
   * cadence) when a session window closes. Reflects on patterns when the
   * window carries real negative signal — accepted streaks lower the
   * cadence by skipping the reflection entirely.
   */
  async onSessionComplete(session: CompletedSession): Promise<void> {
    if (!this.config.enabled) return;

    const windowsClosed = this.agentConfig.countClosedSessionWindow();

    // Reflect on the entire session (skip trivially short windows)
    if (session.turns.length >= 3 && this.sessionWarrantsReflection(session)) {
      await this.onSessionReflection(session, windowsClosed);
    }

    // Check if lifetime evolution is due
    if (windowsClosed % this.config.lifetimeEvolutionInterval === 0) {
      await this.onLifetimeEvolution();
    }

    // The session-end changelog digest: assemble what the window changed
    // (including anything the reflection/evolution above just landed) and
    // emit it through the normal event stream — the CLI prints it live, the
    // web timeline carries it. Pure read over the ledgers; never blocks.
    this.emitChangelogDigest(session.startedAt);
  }

  /** Emit one "what I changed about myself" line for the closed window. */
  private emitChangelogDigest(since: number): void {
    let entries;
    try {
      entries = buildChangelog(this.rt.storage.sql, { since, limit: 20 });
    } catch {
      return; // the digest is best-effort
    }
    if (entries.length === 0) return;
    const counts = new Map<string, number>();
    for (const e of entries) counts.set(e.kind, (counts.get(e.kind) ?? 0) + 1);
    const parts = [...counts].map(([kind, n]) => `${n} ${kind}`).join(' · ');
    this.emit({
      type: 'changelog_digest',
      message: `Self-change digest: ${entries.length} entr${entries.length === 1 ? 'y' : 'ies'} this session (${parts}) — every line is revertable in the changelog`,
      data: { since, counts: Object.fromEntries(counts) },
    });
  }

  /** Real signal that something in the window went wrong: an error, a
   *  negative feedback mark (reviewTurn populates turn.feedback), or a
   *  recorded corrected/frustrated outcome. All-accepted windows return
   *  false — nothing warrants reflection. */
  private sessionWarrantsReflection(session: CompletedSession): boolean {
    if (session.turns.some(t => t.hadError || t.feedback === 'negative')) return true;
    const turnIds = session.turns.map(t => t.turnId).filter((id): id is string => !!id);
    return hasNegativeOutcome(this.rt.storage.sql, turnIds);
  }

  /** Session-level reflection: patterns, what worked, what didn't. The
   *  reflection prose is self-scored, so it enters MEMORY.md only when a
   *  recorded outcome already backs the window; otherwise it waits in the
   *  lessons ledger as provisional until one corroborates it. */
  private async onSessionReflection(session: CompletedSession, windowsClosed: number): Promise<void> {
    const recentMemory = await this.rt.memory.read('memory/MEMORY.md') ?? '';
    const recentLessons = recentMemory.split('\n### Lesson').slice(-5).join('\n### Lesson');

    if (!recentLessons.trim()) return;

    const reflection = await this.fastLlm.complete(
      `You are reflecting on your recent interactions to improve yourself.\n\n` +
      `Recent lessons:\n${recentLessons.slice(0, 1500)}\n\n` +
      `In 2-3 bullet points, what patterns do you see? What should you do differently?\n` +
      `Focus on actionable changes to your behavior.`,
    );

    const turnIds = session.turns.map(t => t.turnId).filter((id): id is string => !!id);
    const corroborated = hasNegativeOutcome(this.rt.storage.sql, turnIds);
    recordLesson(this.rt.storage.sql, {
      turnIds,
      text: reflection,
      source: 'session_reflection',
      status: corroborated ? 'corroborated' : 'provisional',
    });
    if (corroborated) {
      await this.rt.memory.append(
        'memory/MEMORY.md',
        `\n## Session reflection (${isoDate()})\n${reflection}\n`,
      );
      await this.rt.memory.index('memory/MEMORY.md');
    }

    this.emit({ type: 'reflection', message: `Session reflection${corroborated ? '' : ' [provisional]'}: ${reflection.slice(0, 100)}...` });

    // Propose scaffold mutation after enough closed windows with clear patterns
    if (windowsClosed >= 3) {
      await this.maybeEvolveScaffold(reflection);
    }
  }

  /** Propose a scaffold improvement based on session patterns */
  private async maybeEvolveScaffold(reflection: string): Promise<void> {
    try {
      const scaffoldExists = await this.rt.identity.scaffold.exists();
      if (!scaffoldExists) return;

      // Skip if a pending scaffold is already in flight — consecutive sessions
      // would otherwise orphan earlier pending versions. The current pending
      // must be resolved (promoted or rolled back) before a new proposal.
      const pending = this.rt.storage.sql<{ version: number }>`
        SELECT version FROM scaffold_versions WHERE status = 'pending' LIMIT 1
      `;
      if (pending.length > 0) {
        this.emit({
          type: 'scaffold_proposed',
          message: `Skipped — scaffold v${pending[0].version} is still pending shadow evaluation`,
        });
        return;
      }

      const currentScaffold = await this.rt.identity.scaffold.read();
      if (!currentScaffold || currentScaffold.length < 50) return;

      // DGM archive branching: mostly evolve the live current, with a
      // configurable exploration share drawn from archived stepping stones
      // (policy + justification in scaffold/archive.ts selectEvolutionBase).
      // Selection weights blend the shadow record with how each version's
      // turns ACTUALLY landed with the user (turn_outcomes) — the real-outcome
      // prior the shadow judge alone can't supply — and are then aggregated
      // over each candidate's descendant lineage (clade-metaproductivity).
      const archive = listScaffoldArchive(this.rt.storage.sql, 12);
      const realRates = realOutcomeScaffoldRates(this.rt.storage.sql);
      const base = selectEvolutionBase(blendRealOutcomeRates(archive, realRates), {
        exploreShare: this.agentConfig.getScaffoldExploreShare(),
      });
      // The live file IS the current version's content; only an archived
      // stepping stone needs the versioned-backup read (v0 has no backup).
      const baseCode = base
        ? (base.mode === 'current' ? currentScaffold : await readScaffoldVersion(this.rt, base.version))
        : null;

      // What keeps going wrong, as named cells the proposal can target. The
      // cells are deterministic (evolution/pathology.ts); the model only gets
      // to phrase their titles, and only after they exist.
      const pathologies = await labelPathologyClusters(this.fastLlm, clusterPathologies(
        listTurnOutcomes(this.rt.storage.sql, { limit: 60, outcomes: NEGATIVE_TURN_OUTCOMES }),
      ));
      const rejections = new Map(
        listRejectedProposals(this.rt.storage.sql, 12)
          .flatMap((r) => (r.version === null ? [] : [[r.version, r.reason] as const])),
      );

      const proposed = await this.rt.llm.complete(
        buildScaffoldProposalPrompt(
          baseCode ?? currentScaffold,
          reflection,
          base && baseCode ? { base, entries: archive, realRates, rejections } : undefined,
          pathologies,
        ),
      );

      // Only attempt mutation if the LLM produced something that looks like a scaffold
      if (!proposed.includes('async function* run')) return;

      // Extract just the code from potential markdown fences
      const code = proposed.replace(/```(?:js|javascript)?\n?/g, '').replace(/```\n?$/g, '').trim();

      const branchNote = base && baseCode
        ? `branched from v${base.version}${base.mode === 'explore' ? ' (archive stepping stone)' : ''}`
        : 'branched from the live scaffold';
      const rationale = `Session reflection, ${branchNote}: ${reflection.slice(0, 100)}`;
      const result = await modifyScaffold(
        this.rt, rationale, code,
        base && baseCode ? { baseVersion: base.version } : undefined,
      );
      if (result.ok) {
        // The same parse modifyScaffold stamped the row with, over the same
        // code — the event and the row cannot disagree about what was targeted.
        const targeted = parsePathologyTag(code);
        this.emit({
          type: 'scaffold_proposed',
          message: `Scaffold evolved to v${result.version} (${branchNote}): ${reflection.slice(0, 60)}` +
            (targeted ? ` — targets ${describePathology(targeted)}` : ''),
        });
      }
    } catch {
      // Scaffold mutation failed validation — that's fine, skip silently
    }
  }

  // ── Timescale 3: Lifetime-level (periodic background evolution) ──

  /**
   * Run a full MCTS evolution cycle. Happens automatically every N conversations.
   * Also callable manually via `proteus evolve`.
   */
  async onLifetimeEvolution(session?: SessionWriter): Promise<void> {
    const purpose = summarizeSoul(readSoul(this.rt.storage.sql)) || 'be a helpful assistant';

    this.emit({
      type: 'mcts_started',
      message: `Starting evolution cycle (budget=${this.config.lifetimeMCTSBudget})...`,
    });

    // No replay eval here. It re-executes a 20-turn sample of the SAME
    // `turn_outcomes` ledger, on the SAME cadence, that GEPA's seed scoring
    // already re-executes to measure the current config on its val split — one
    // re-execution bill paid twice for two points on a curve, and the curve is
    // read by inspection RPCs only (listReplayEvals): no decision anywhere
    // consumes it. It stays available on demand (`runReplayEval`, the CLI and
    // DO RPCs) so the number can still be asked for; what it no longer does is
    // spend twenty full completions per cycle unasked.

    // CraftStore consolidation
    await periodicCraftConsolidation(this.rt);
    this.emit({ type: 'consolidation', message: 'CraftStore consolidation complete' });

    // Build a session writer if not provided — enables auto-lifetime MCTS
    const writer = session ?? this.createInternalSessionWriter();

    const task = `Given my purpose: "${purpose}", identify one specific improvement ` +
      `to be more effective. Consider: new tools, knowledge gaps, workflow improvements.`;

    try {
      // Operator MCTS overrides apply here too; the iteration budget stays
      // the lifetime-specific cadence cap (its own knob), not mcts_iterations.
      const overrides = this.agentConfig.getMctsOverrides();
      const result = await runMCTS(this.rt, writer, task, {
        budget: this.config.lifetimeMCTSBudget,
        branches: overrides.branches ?? this.config.lifetimeMCTSBranches,
        ...(overrides.maxDepth !== undefined ? { maxDepth: overrides.maxDepth } : {}),
        ...(overrides.explorationWeight !== undefined ? { explorationWeight: overrides.explorationWeight } : {}),
        ...(overrides.judgeSamples !== undefined ? { judgeSamples: overrides.judgeSamples } : {}),
        ...(overrides.maxEvalLLMCalls !== undefined ? { maxEvalLLMCalls: overrides.maxEvalLLMCalls } : {}),
        onProgress: this.config.onMctsProgress,
      });

      this.emit({
        type: 'mcts_complete',
        message: `Evolution ${result.converged ? 'converged' : 'explored'} (score: ${result.winnerValue.toFixed(2)})`,
        data: result,
      });
    } catch (err) {
      this.emit({
        type: 'mcts_complete',
        message: `Evolution failed: ${(err as Error).message}`,
      });
    }
  }

  /**
   * Replay eval — re-run a sample of outcome-labeled turns against the
   * CURRENT config (the backend's replayTaskRunner: scaffold + prompt +
   * tools) and score against the recorded outcome. The system's loss curve,
   * persisted to replay_evals. No-op when the backend supplies no runner or
   * no labeled turns exist yet.
   *
   * ON DEMAND ONLY — the CLI and DO RPCs. It is deliberately off the lifetime
   * cadence: twenty full re-executions of the same `turn_outcomes` sample that
   * GEPA's seed scoring already re-executes, for a series read by inspection
   * surfaces and by no decision in the system.
   */
  async runReplayEval(sampleSize?: number): Promise<ReplayEvalSummary | null> {
    const runTask = this.config.replayTaskRunner;
    if (!runTask) return null;
    try {
      const summary = await runReplayEval({
        sql: this.rt.storage.sql,
        judge: this.rt.judgeModel ?? this.rt.llm,
        runTask,
        sampleSize,
        scaffoldVersion: this.currentScaffoldVersion(),
      });
      if (summary) {
        this.emit({
          type: 'replay_eval',
          message: `Replay eval: loss ${formatScoreInterval(lossInterval(summary.interval))} ` +
            `over ${summary.sampleSize} labeled turns ` +
            `(${summary.acceptedCount} accepted / ${summary.negativeCount} corrected)`,
          data: summary,
        });
      }
      return summary;
    } catch (err) {
      this.emit({ type: 'replay_eval', message: `Replay eval failed: ${(err as Error).message}` });
      return null;
    }
  }

  /** Minimal in-memory session writer for auto-triggered MCTS */
  private createInternalSessionWriter(): SessionWriter {
    const messages: Array<{ id: string; parentId: string | null; role: string; content: string }> = [];
    return {
      async appendMessage(msg, parentId) {
        const content = msg.parts.map(p => p.text).join('');
        messages.push({ id: msg.id, parentId: parentId ?? null, role: msg.role, content });
      },
      getHistory(leafId) {
        if (!leafId) return messages.map(m => ({ role: m.role, content: m.content }));
        const result: Array<{ role: string; content: string }> = [];
        let current = messages.find(m => m.id === leafId);
        while (current) {
          result.unshift({ role: current.role, content: current.content });
          current = current.parentId ? messages.find(m => m.id === current!.parentId) : undefined;
        }
        return result;
      },
    };
  }

  // ── Internal helpers ────────────────────────────────────────────

  /** Generate a reflection on a turn that went wrong. The user's follow-up
   *  (the correction) is the strongest available context when present. */
  private async generateTurnReflection(
    turn: CompletedTurn, outcome: TurnOutcome | null, quality: number, followup: string | null,
  ): Promise<string> {
    const summary = turn.assistantResponse.slice(0, 300);
    const toolSummary = turn.toolCalls.length > 0
      ? `Tools used: ${turn.toolCalls.map(tc => tc.name).join(', ')}`
      : 'No tools used';

    return this.fastLlm.complete(
      `A recent interaction landed ${outcome ?? 'unobserved'} at ${quality.toFixed(2)}/1.0 quality.\n` +
      `User asked: "${turn.userMessage.slice(0, 200)}"\n` +
      `Response: "${summary}"\n` +
      `${toolSummary}\n` +
      `${renderDelegationFeatures(delegationFeatures(turn))}\n` +
      `Delegation rubric: On corrected/frustrated requests with 2+ independent parts, consider a long linear grind with zero delegation a lesson to decompose and staff subordinates or fork; credit effective staffing/forking on accepted turns; flag delegation overhead when spawned subordinates contributed nothing.\n` +
      `${turn.hadError ? 'An error occurred.\n' : ''}` +
      `${followup ? `The user then replied: "${followup.slice(0, 300)}"\n` : ''}\n` +
      `In one sentence, what specifically should be done differently next time?`,
    );
  }

  /** Extract a successful tool usage pattern into a reusable crafted tool.
   *  Pure-lookup calls (memory.search, fact.recall) are skipped — they read
   *  state but encode no reusable pattern.
   */
  private async extractPattern(turn: CompletedTurn, quality: number): Promise<void> {
    const meaningfulCalls = turn.toolCalls.filter(tc => !isPureLookupCall(tc));
    if (meaningfulCalls.length === 0) return;

    const callSummary = meaningfulCalls
      .map(tc => `${tc.name}(${JSON.stringify(tc.args).slice(0, 200)}) → ${JSON.stringify(tc.result).slice(0, 200)}`)
      .join('\n');

    // Ask the LLM to generalize into a reusable function
    const generalized = await this.fastLlm.complete(
      `A successful interaction used these tool calls:\n${callSummary}\n\n` +
      `The user asked: "${turn.userMessage.slice(0, 200)}"\n\n` +
      `Extract a reusable pattern as a JavaScript async arrow function.\n` +
      `{"name":"snake_case_name","description":"one line description","params":{"type":"object","properties":{...},"required":[...]},"code":"async (args) => { ... }"}\n` +
      `The code must be a self-contained async arrow function that takes an args object.\n` +
      jsonObjectOnlyInstruction(),
    );

    try {
      const parsed = extractJsonObject(generalized) as { name?: string; description?: string; code?: string; params?: unknown };
      if (!parsed.name || !parsed.code || parsed.code.startsWith('//')) return;

      const acceptance = await upsertCraftedTool(this.rt, {
        name: parsed.name,
        description: parsed.description ?? '',
        code: parsed.code,
        score: quality,
      });
      if (!acceptance.accepted) return; // misevolution veto — reason already recorded

      this.emit({
        type: 'craft_discovered',
        message: `Discovered pattern: ${(parsed.description ?? parsed.name).slice(0, 60)}`,
      });
    } catch {
      // LLM returned invalid JSON or conflict — skip
    }
  }
}

/**
 * The compaction-ladder layer slice — the @better-compact ladder that actually
 * rewrites history, driven through this package's proteus codec/spec.
 *
 * Core's layer gate declares `compaction-ladder` but cannot measure it (core
 * cannot import this package without a cycle), so the slice lives HERE, on the
 * same generic Layer/gate contract, with its own locked baseline.
 * `scripts/layergate.ts` merges it into the human-facing report;
 * `tests/unit-layergate.test.ts` runs it in CI.
 *
 * Probes are deterministic by construction: turn keys and stamps are
 * content-derived (codec.ts), summaries are injected as literals, and no
 * store, clock or model is touched — buildPlan/transformTurns/
 * replayPlanSnapshot are pure functions of the turns.
 */

import type { ModelMessage } from 'ai';
import type { Fault, Layer } from '@proteus/core';
import {
  buildPlan,
  matchesPlanSnapshot,
  replayPlanSnapshot,
  toPlanSnapshot,
  transformTurns,
  type BuildPlanInputs,
} from '@better-compact/core';
import { proteusCodec, proteusSpec } from './codec.js';
import { compactionTranscriptPath } from './stores.js';

export interface CompactionLadderSubjects {
  readonly proteusCodec: typeof proteusCodec;
  readonly buildPlan: typeof buildPlan;
  readonly transformTurns: typeof transformTurns;
  readonly replayPlanSnapshot: typeof replayPlanSnapshot;
  readonly matchesPlanSnapshot: typeof matchesPlanSnapshot;
}

export function createCompactionLadderSubjects(): CompactionLadderSubjects {
  return { proteusCodec, buildPlan, transformTurns, replayPlanSnapshot, matchesPlanSnapshot };
}

// ── fixtures ─────────────────────────────────────────────────────

function toolExchange(id: string, output: string): ModelMessage[] {
  return [
    {
      role: 'assistant',
      content: [{ type: 'tool-call', toolCallId: id, toolName: 'run', input: { command: `cat log-${id}` } }],
    },
    {
      role: 'tool',
      content: [{ type: 'tool-result', toolCallId: id, toolName: 'run', output: { type: 'text', value: output } }],
    },
  ];
}

/** A long, tool-heavy session: two old huge outputs, then a fresh tail. */
function toolHeavyConversation(): ModelMessage[] {
  return [
    { role: 'user', content: 'read the logs' },
    ...toolExchange('c1', 'A'.repeat(120_000)),
    { role: 'assistant', content: 'first log read.' },
    { role: 'user', content: 'and the next one' },
    ...toolExchange('c2', 'B'.repeat(120_000)),
    { role: 'assistant', content: 'second log read.' },
    { role: 'user', content: 'now summarize both' },
    ...toolExchange('c3', 'C'.repeat(3_000)),
    { role: 'assistant', content: 'summary of both logs.' },
    { role: 'user', content: 'thanks — keep going' },
  ];
}

const PLAN_INPUTS: Omit<BuildPlanInputs, 'force'> = Object.freeze({
  sessionKey: 'gate-session',
  contextLimit: 20_000,
  triggerRatio: 0.8,
  targetRatio: 0.4,
  recentToolResultBudgetTokens: 2_000,
  citablePath: compactionTranscriptPath,
});

/** The model-visible view of a turn list, for byte-stable comparison. */
function visible(subjects: CompactionLadderSubjects, turns: Parameters<typeof transformTurns>[0]): string {
  return JSON.stringify(subjects.proteusCodec.decode(turns, []));
}

// ── the slice ────────────────────────────────────────────────────

export const COMPACTION_LAYERS: readonly Layer<CompactionLadderSubjects>[] = Object.freeze([
  {
    id: 'compaction-ladder',
    owns: 'the @better-compact ladder that actually rewrites history — the proteus codec, plan construction, ' +
      'the staged transform, and byte-stable snapshot replay',
    subjects: ['proteusCodec', 'buildPlan', 'transformTurns', 'replayPlanSnapshot', 'matchesPlanSnapshot'],
    probes: [
      {
        id: 'compaction-ladder/codec-roundtrip',
        asserts: 'messages encode to content-keyed turns and decode back losslessly; estimation is chars/4',
        observe: (s) => {
          const messages = toolHeavyConversation();
          const turns = s.proteusCodec.encode(messages);
          return {
            shape: turns.map((t) => ({ role: t.role, items: t.items.map((i) => i.kind) })),
            keysContentDerived: JSON.stringify(turns.map((t) => t.key))
              === JSON.stringify(s.proteusCodec.encode(toolHeavyConversation()).map((t) => t.key)),
            roundTrip: JSON.stringify(s.proteusCodec.decode(turns, [])) === JSON.stringify(messages),
            estimate: s.proteusCodec.estimateTurns(turns),
          };
        },
      },
      {
        id: 'compaction-ladder/no-pressure-no-plan',
        asserts: 'a session inside the window is never rewritten',
        observe: (s) => s.buildPlan(
          s.proteusCodec.encode(toolHeavyConversation()),
          { ...PLAN_INPUTS, contextLimit: 10_000_000 },
          proteusSpec,
        ),
      },
      {
        id: 'compaction-ladder/ladder-prunes-under-pressure',
        asserts: 'over the trigger, the staged ladder prunes old tool outputs, protects the raw tail, and shrinks the estimate',
        observe: (s) => {
          const turns = s.proteusCodec.encode(toolHeavyConversation());
          const plan = s.buildPlan(turns, { ...PLAN_INPUTS }, proteusSpec);
          if (!plan) return { plan: null };
          const transformed = s.transformTurns(turns, plan.rawTailStartIndex, plan, proteusSpec);
          return {
            stages: plan.stages.map((r) => ({ name: r.name, status: r.status, cleared: r.clearedTokens > 0 })),
            rawTailStartIndex: plan.rawTailStartIndex,
            turnCountPreserved: transformed.length === turns.length,
            shrank: s.proteusCodec.estimateTurns(transformed) < s.proteusCodec.estimateTurns(turns),
            after: s.proteusCodec.estimateTurns(transformed),
            tailIntact: visible(s, transformed.slice(plan.rawTailStartIndex))
              === visible(s, turns.slice(plan.rawTailStartIndex)),
          };
        },
      },
      {
        id: 'compaction-ladder/replay-byte-stable',
        asserts: 'an unchanged prefix replays the snapshot byte-for-byte; a rewritten history invalidates it',
        observe: (s) => {
          const turns = s.proteusCodec.encode(toolHeavyConversation());
          const plan = s.buildPlan(turns, { ...PLAN_INPUTS }, proteusSpec);
          if (!plan) return { plan: null };
          const snapshot = toPlanSnapshot(plan);
          const transformed = s.transformTurns(turns, plan.rawTailStartIndex, plan, proteusSpec);
          const replayed = s.replayPlanSnapshot(turns, snapshot, proteusSpec);
          const rewritten = s.proteusCodec.encode([
            { role: 'user', content: 'a completely different history' },
          ]);
          return {
            matches: s.matchesPlanSnapshot(turns, snapshot),
            byteStable: replayed !== null && visible(s, replayed) === visible(s, transformed),
            rewrittenMatches: s.matchesPlanSnapshot(rewritten, snapshot),
            rewrittenReplay: s.replayPlanSnapshot(rewritten, snapshot, proteusSpec),
          };
        },
      },
    ],
  },
]);

/** The single-layer fault — its own slice must crater; the merged matrix in
 *  scripts/layergate.ts proves no core layer moves. */
export const COMPACTION_FAULTS: readonly Fault<CompactionLadderSubjects>[] = Object.freeze([
  {
    id: 'compaction-ladder/rewrite-regresses',
    layer: 'compaction-ladder',
    patches: ['transformTurns', 'replayPlanSnapshot'],
    models: 'the staged transform silently no-ops and cached plans always miss — compaction stops compacting',
    inject: (s) => ({
      ...s,
      transformTurns: (turns) => turns,
      replayPlanSnapshot: () => null,
    }),
  },
]);

/**
 * The hosted root changes no durable row and no frame — the parity net for
 * the turn loop moving onto core's ChatSession.
 *
 * The probe drives one scripted conversation over real sockets through the
 * real OrchestratorAgent (`two-turn-probe.ts`, `parityPrepare` and
 * `parityComplete`): an idle send, a send mid-turn carrying a file, an
 * interrupt, a tool-calling turn evicted after its tool step settled and its
 * answer had begun, a send acknowledged mid-turn before that eviction, and the
 * restart that resumes it. `fixtures/chat-session-parity.json` is the record
 * the pre-track tree left, normalized by the same rules the local backend's
 * parity test uses (`@kinu.run/test-utils` parityNormalizer): every minted id
 * by order of appearance, every clock reading blanked.
 *
 * The record is logged on every run as one line prefixed
 * `chat-session-parity snapshot` — that line, on the pre-track tree, is how
 * the fixture was recorded. Re-recorded 2026-09-16 for three changes that
 * MEAN to change the record, each read field by field against the previous
 * fixture (/tmp/parity.diff, 58 changed lines): `tool_call_end.durationMs`
 * is back on every tool row (the switch had dropped it); turn THREE, cut
 * before its first token, writes no assistant row, so FOUR-TOOL's parent is
 * the operator's row; and no `error: true` frame follows a Stop. Every other
 * line of the diff is the opaque-id renumbering those two removals cause.
 * Re-recorded 2026-09-18 for one change that means to change it (6 lines):
 * sleep-time compute runs on a cadence, never after a workspace's first turn,
 * so the `model_call` its compute used to record inside the NEXT run's event
 * space is gone and `<run#7>`'s `step_finish` and `run_end` sit one index
 * earlier. No row, frame or landing changed.
 */
import { abortAllDurableObjects, env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import * as v from 'valibot';
import { JsonValueSchema, type JsonValue } from '@kinu.run/core';
import { parityNormalizer, type ParityNormalizer } from '@kinu.run/test-utils/parity-normalizer';
import recorded from '../../fixtures/chat-session-parity.json';
import {
  ParityCompletedSchema, ParityPreparedSchema,
  type ParityFrame, type ParityRows,
} from '../two-turn-shapes';

const parse = (column: string): JsonValue => v.parse(JsonValueSchema, JSON.parse(column));

function rows(norm: ParityNormalizer, raw: ParityRows): JsonValue {
  return {
    assistantMessages: raw.assistantMessages.map((row) => ({
      id: norm.text(row.id), parentId: row.parentId === null ? null : norm.text(row.parentId), role: row.role,
      content: norm.json(parse(row.content)),
    })),
    pendingSteers: raw.pendingSteers.map((row) => ({ id: norm.text(row.id), turnId: norm.text(row.turnId), mode: row.mode, text: row.text })),
    pendingSteerFiles: raw.pendingSteerFiles.map((row) => ({ steerId: norm.text(row.steerId), filename: row.filename, mediaType: row.mediaType, url: row.url })),
    agentLog: raw.agentLog.map((row) => ({
      id: norm.opaque(row.id, 'log'), kind: row.kind, turnId: row.turnId === null ? null : norm.text(row.turnId),
      variant: row.variant, consumed: row.consumed, payload: norm.json(parse(row.payload)),
    })),
    terminalEffects: raw.terminalEffects.map((row) => ({
      sequenceId: norm.text(row.sequenceId), effectKey: norm.text(row.effectKey), effectName: row.effectName,
      scope: norm.text(row.scope), seq: row.seq, input: norm.json(parse(row.input)), lane: row.lane, status: row.status,
      outcome: row.outcome === null ? null : norm.text(row.outcome), attempts: row.attempts, settled: row.settled,
    })),
    runEvents: raw.runEvents.map((row) => {
      const payload = v.parse(v.record(v.string(), JsonValueSchema), parse(row.payload));
      // The composition measurement rides the step row for the analytics that
      // read it; it is a size, not a durable fact the loop replays.
      const { context: _context, runId: _runId, ...durable } = payload;

      return { runId: norm.opaque(row.runId, 'run'), type: row.type, payload: norm.json(durable) };
    }),
  };
}

/** The chat protocol frames in order, and the state syncs beside them by
 *  count: a `cf_agent_session`/`cf_agent_chat_messages` broadcast is
 *  re-sent whenever state moves, so its position is timing, not protocol. */
function frames(norm: ParityNormalizer, raw: readonly ParityFrame[]): JsonValue {
  const protocol = raw.filter((frame) => !frame.type.startsWith('cf_agent_session') && frame.type !== 'cf_agent_chat_messages'
    && frame.type !== 'cf_agent_identity' && frame.type !== 'cf_agent_mcp_servers');

  const syncs = Object.fromEntries([...new Set(raw.map((frame) => frame.type))].sort()
    .filter((type) => !protocol.some((frame) => frame.type === type))
    .map((type) => [type, raw.filter((frame) => frame.type === type).length]));

  return {
    protocol: protocol.map((frame) => norm.json({
      ...frame,
      ...(frame.body !== undefined && { body: frame.body.startsWith('{') ? parse(frame.body) : frame.body }),
    })),
    syncs,
  };
}

describe('ChatSession parity — the hosted root changes no durable row and no frame', () => {
  it('the scripted conversation leaves the pre-track record, checkpoint by checkpoint', async () => {
    const root = env.TWO_TURN_PROBE.get(env.TWO_TURN_PROBE.idFromName('parity-driver'));
    const prepared = v.parse(ParityPreparedSchema, await root.parityPrepare());

    await abortAllDurableObjects();
    const coldRoot = env.TWO_TURN_PROBE.get(env.TWO_TURN_PROBE.idFromName('parity-driver'));
    const completed = v.parse(ParityCompletedSchema, await coldRoot.parityComplete(prepared));

    const norm = parityNormalizer();

    const snapshot = {
      landings: { ...prepared.landings, ...completed.landings },
      afterTwo: rows(norm, prepared.afterTwo),
      beforeRestart: rows(norm, prepared.beforeRestart),
      end: rows(norm, completed.end),
      framesBefore: frames(norm, prepared.frames),
      framesAfter: frames(norm, completed.frames),
      modelCallsBefore: prepared.modelCallsBefore,
      modelCallsAfter: completed.modelCallsAfter,
      failures: completed.failures,
    };

    console.log(`chat-session-parity snapshot ${JSON.stringify(snapshot)}`);
    expect(completed.failures).toEqual([]);
    expect(snapshot).toEqual(recorded);
  });
});

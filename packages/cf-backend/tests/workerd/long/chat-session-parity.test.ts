/**
 * Parity net: the hosted root on core's ChatSession changes no durable row or frame against `fixtures/chat-session-parity.json`,
 * normalized like the local backend's parity test. Re-record from the logged `chat-session-parity snapshot` line only for a
 * change meant to alter the record, read field by field against the previous fixture (last: 2026-09-24).
 */
import { abortAllDurableObjects, env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import * as v from 'valibot';
import { DYNAMIC_CONTEXT_OPEN_TAG, JsonValueSchema, type JsonValue } from '@kinu.run/core';
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
    pendingSteers: raw.pendingSteers.map((row) => ({
      id: norm.text(row.id), turnId: row.turnId === null ? null : norm.text(row.turnId), mode: row.mode, text: row.text,
    })),
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
      // A size for the analytics, not a durable fact the loop replays.
      const { context: _context, runId: _runId, ...durable } = payload;

      return { runId: norm.opaque(row.runId, 'run'), type: row.type, payload: norm.json(durable) };
    }),
  };
}

/** State syncs are compared by count: they are re-sent whenever state moves, so their position is timing, not protocol. */
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
    // The runtime context the restarted turns re-wove is the model's, never the page's chat.
    expect(completed.seed).toContain('PARITY-FIVE');
    expect(completed.seed).not.toContain(DYNAMIC_CONTEXT_OPEN_TAG);
    expect(snapshot).toEqual(recorded);
  });
});

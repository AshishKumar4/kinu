import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const source = readFileSync(join(import.meta.dir, '..', 'src', 'orchestrator.ts'), 'utf8');

describe('turn-pipeline correctness wiring', () => {
  test('CHAT_CLEAR resets the ephemeral ledger and durable compaction plan after Think handles it', () => {
    const constructor = source.slice(
      source.indexOf('constructor(ctx: AgentContext, env: Env)'),
      source.indexOf('/** Drain batches bound to the LIVE turn'),
    );
    const dispatch = constructor.indexOf('await dispatchMessage.call');
    const reset = constructor.indexOf('this.ephemeralLedger.reset()');
    const clearPlan = constructor.indexOf('this.compactionState.plans.save(this.name, null)');
    expect(constructor).toContain('parseProtocolMessage(message)');
    expect(constructor).toContain("event?.type === 'clear'");
    expect(dispatch).toBeGreaterThan(-1);
    expect(reset).toBeGreaterThan(dispatch);
    expect(clearPlan).toBeGreaterThan(reset);
  });

  test('aborted turns re-enqueue absorbed and leftover batches without continuation retention', () => {
    const hook = source.slice(source.indexOf('async onChatResponse(result: ChatResponseResult)'));
    const preEarlyReturn = hook.slice(0, hook.indexOf('if (result.status !== "completed")'));
    expect(preEarlyReturn).toContain('settle({ retainForContinuation: completed })');
    expect(preEarlyReturn).toContain('[...injectedEvents.absorbed, ...injectedEvents.leftover]');
    expect(preEarlyReturn).toContain("this.reenqueueEventBatch(batch, completed ? 'leftover' : 'aborted')");
  });

  test('leftover fallback compensates skipped and rejected enqueues with every batch event id', () => {
    const helper = source.slice(
      source.indexOf('private async reenqueueEventBatch'),
      source.indexOf('/** Durable per-session compaction state'),
    );
    expect(helper).toContain("if (result.status === 'queued') return");
    expect(helper).toContain('catch (err)');
    expect(helper).toContain('for (const id of batch.ids)');
    expect(helper).toContain('this.eventLog.unbind(id)');
  });

  test('programmatic turns succeed only after Think completes the turn and keep their own drain identity', () => {
    const host = source.slice(
      source.indexOf('private get host(): BackendHost'),
      source.indexOf('/** Executors whose tools ran this turn'),
    );
    expect(host).toContain("result.status === 'completed' ? 'queued' : 'skipped'");
    expect(host).toContain('this._activeDrainTurnId = drainTurnId');
    expect(host).toContain('this._activeProgrammaticUserMessage = message');
    expect(host).toContain('finally {');
    expect(host).toContain('this._activeProgrammaticUserMessage === message');
    const response = source.slice(source.indexOf('async onChatResponse(result: ChatResponseResult)'));
    expect(response).toContain('this._activeDrainTurnId ?? this._pendingDrainReplyTurns.get(result.requestId)');
    expect(response).toContain('const lastUserMsg = programmaticUserMessage ??');
    expect(response).not.toContain('metadata.drainTurnId');
  });

  test('delivery leases close only after reply dispatch completes', () => {
    const helper = source.slice(
      source.indexOf('private async completeEventBatch'),
      source.indexOf('/** Durable per-session compaction state'),
    );
    expect(helper.indexOf('await dispatchEmailRepliesForTurn')).toBeGreaterThan(-1);
    expect(helper).toContain('if (replies.pending)');
    expect(helper).toContain('return false');
    expect(helper.indexOf('this.eventLog.markTurnCompleted')).toBeGreaterThan(
      helper.indexOf('await dispatchEmailRepliesForTurn'),
    );
  });

  test('standalone drain identity survives Think auto-continuations until reply settlement', () => {
    const response = source.slice(source.indexOf('async onChatResponse(result: ChatResponseResult)'));
    expect(response).toContain('this._pendingDrainReplyTurns.set(result.requestId, drainTurnId)');
    expect(response).toContain('this._pendingDrainReplyTurns.delete(result.requestId)');
    const clear = source.slice(
      source.indexOf('constructor(ctx: AgentContext, env: Env)'),
      source.indexOf('/** Drain batches bound to the LIVE turn'),
    );
    expect(clear).toContain('this._pendingDrainReplyTurns.clear()');
  });

  test('activation runs one stale-delivery sweep and schedules the standard drain when it recovers rows', () => {
    const onStart = source.slice(source.indexOf('async onStart()'), source.indexOf('// ── DO alarm'));
    expect(onStart).toContain('this.eventLog.unbindStale(STALE_EVENT_DELIVERY_MS)');
    expect(onStart).toContain('this.orch.scheduleDrain()');
  });

  test('pickAlternateTake returns false unless the awaited enqueue actually queues', () => {
    const pick = source.slice(
      source.indexOf('async pickAlternateTake('),
      source.indexOf('/**\n   * The unified Run Timeline spine'),
    );
    expect(pick).toContain('let continuationQueued = false');
    expect(pick).toContain('const result = await this.host.enqueueTurn');
    expect(pick).toContain("continuationQueued = result.status === 'queued'");
    expect(pick).toContain("if (result.status === 'skipped')");
    expect(pick).toContain('catch (err)');
    expect(pick).not.toContain('continuationQueued = true');
  });
});

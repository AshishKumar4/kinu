import * as v from 'valibot';
import type { JsonValue, RunEvent } from '@kinu.run/core';
import type { TrialEvidence } from '../insights';
import { redact } from '../redact';
import { HarnessRunSchema, type Assertion, type HarnessRun } from '../results';

// Error/argument fields: prod-muse-2/order-book-trial-1/ledger.jsonl:17; identities are neutralized.
export const base = { runId: 'run', eventIndex: 0, timestamp: '2026-09-30T22:31:31.802Z' };

export const start: Extract<RunEvent, { type: 'run_start' }> = { ...base, type: 'run_start', agentId: 'lead', caused_by: 'chat' };

export const end: Extract<RunEvent, { type: 'run_end' }> = { ...base, type: 'run_end', reason: 'completed' };

export const missingFile: Extract<RunEvent, { type: 'tool_call_end' }> = { ...base, type: 'tool_call_end', name: 'file', toolCallId: 'call',
  args: { action: 'list', path: 'slates' }, error: "ENOENT: no such file or directory, scandir '/home/main/slates'", outcome: { success: false, reason: 'missing' } };

export function assertion(turns: HarnessRun['output']['turns'] = []): Assertion {
  return { status: 'failed', duration: 1, meta: { harness: { run: v.parse(HarnessRunSchema, {
    session: { metadata: { taskId: 'order-book', taskVersion: 'v', evalCommit: 'c', productSha: 'p', arm: 'product', trial: 1 } },
    usage: { model: 'test/model' },
    output: { metrics: { modelTurns: 21, toolCalls: 20, toolErrors: 1, badInputCalls: 0, unknownToolCalls: 0, providerWaits: 0, providerWaitMs: 0 }, turns }, errors: [],
  }) } } };
}

export function evidence(rows: readonly (JsonValue | RunEvent)[], extra: Partial<TrialEvidence> = {}): TrialEvidence {
  return { ledger: redact(rows.map((row) => JSON.stringify(row)).join('\n')), timeline: '', transcript: '', ...extra };
}

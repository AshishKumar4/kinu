// The shared turn-context assembly (orchestrator/turn-context.ts) — the ONE
// ordering both backends run: sanitize → extension onTurnStart → awaited
// transformContext → turn-local tail. runChat and the cf beforeTurn both
// delegate here, so these invariants hold on both backends by construction.
// Dynamic context is NOT assembled here (it is woven per step); the array this
// produces is what the ledger's frozen positions are measured against, so it
// must stay free of blocks.
import { describe, expect, test } from 'bun:test';
import type { ModelMessage } from 'ai';
import { Database } from 'bun:sqlite';
import { assembleTurnMessages, measureCompactionTrigger } from '../src/orchestrator/turn-context';
import { ExtensionHost } from '../src/extension';
import { createMemoryVFS } from './helpers';
import type { MediaModality } from '../src/prompting/attachment-sanitizer';

const HISTORY: ModelMessage[] = [
  { role: 'user', content: 'hello' },
  { role: 'assistant', content: 'hi' },
  { role: 'user', content: 'and now?' },
];

function base() {
  return { system: 'SYS', history: HISTORY, sessionKey: 'k', contextWindow: 200_000, trigger: 'auto' as const };
}

describe('assembleTurnMessages', () => {
  test('bare assembly returns the durable history plus nothing', async () => {
    const out = await assembleTurnMessages(base());
    expect(out).toEqual(HISTORY);
    expect(out).not.toBe(HISTORY);
  });

  test('onTurnStart fires before transformContext, and the transform sees the durable history only', async () => {
    const order: string[] = [];
    let transformSaw: readonly ModelMessage[] = [];
    const extensions = new ExtensionHost().register({
      name: 'test.probe',
      onTurnStart: () => { order.push('turn-start'); },
      transformContext: async (ctx) => {
        order.push('transform');
        transformSaw = ctx.messages;
        return undefined;
      },
    });
    await assembleTurnMessages({
      ...base(),
      extensions,
      turnLocal: [{ role: 'user', content: 'turn-local' }],
    });
    expect(order).toEqual(['turn-start', 'transform']);
    // The transform never sees the turn-local tail.
    expect(transformSaw).toEqual(HISTORY);
  });

  test('the turn-local tail lands last, on the TRANSFORMED history', async () => {
    const compacted: ModelMessage[] = [{ role: 'user', content: 'summary' }];
    const extensions = new ExtensionHost().register({
      name: 'test.compact',
      transformContext: async () => compacted,
    });
    const out = await assembleTurnMessages({
      ...base(),
      extensions,
      turnLocal: [{ role: 'user', content: 'turn-local' }],
    });
    expect(out).toEqual([...compacted, { role: 'user', content: 'turn-local' }]);
  });

  test('no dynamic-context block is ever assembled here', async () => {
    // The step pipeline owns them. A block appearing in the turn's initial
    // array would be double-counted by the ledger's frozen indices.
    const out = await assembleTurnMessages({
      ...base(),
      turnLocal: [{ role: 'user', content: 'turn-local' }],
    });
    expect(JSON.stringify(out)).not.toContain('<dynamic_context');
  });

  test('the transform receives sessionKey, window, trigger, and the measured token signal', async () => {
    const seen: Array<{ sessionKey: string; contextWindow: number; trigger: string; providerReportedTokens?: number }> = [];
    const extensions = new ExtensionHost().register({
      name: 'test.ctx',
      transformContext: async (ctx) => {
        seen.push({
          sessionKey: ctx.sessionKey, contextWindow: ctx.contextWindow, trigger: ctx.trigger,
          providerReportedTokens: ctx.providerReportedTokens,
        });
        return undefined;
      },
    });
    await assembleTurnMessages({ ...base(), extensions, providerReportedTokens: 1234, trigger: 'force' });
    expect(seen[0]).toEqual({ sessionKey: 'k', contextWindow: 200_000, trigger: 'force', providerReportedTokens: 1234 });
  });

  test('attachment sanitization preserves message count and feeds the transform sanitized parts', async () => {
    const withFile: ModelMessage[] = [
      { role: 'user', content: [
        { type: 'file', data: 'data:application/pdf;base64,AAAA', mediaType: 'application/pdf', filename: 'a.pdf' },
        { type: 'text', text: 'read this' },
      ] },
    ];
    let transformSaw: readonly ModelMessage[] = [];
    const extensions = new ExtensionHost().register({
      name: 'test.sanitize-order',
      transformContext: async (ctx) => { transformSaw = ctx.messages; return undefined; },
    });
    const out = await assembleTurnMessages({
      ...base(),
      history: withFile,
      extensions,
      // MediaModality excludes 'text' — an empty set is a model that accepts no
      // attachments at all, which is what strips the PDF below.
      attachments: { accepts: new Set<MediaModality>(), vfs: createMemoryVFS(new Database(':memory:')) },
    });
    expect(out.length).toBe(1);
    // The transform saw the sanitized message, not the raw PDF part.
    expect(JSON.stringify(transformSaw)).not.toContain('base64,AAAA');
    expect(JSON.stringify(out)).not.toContain('base64,AAAA');
  });
});

// The trigger fields of that same input, measured out of the durable store.
// Both backends derived these by hand until this owned the order.
describe('measureCompactionTrigger', () => {
  /** The store's read half, recording what the measurement asked it. */
  function reader(tokens: number | null, armed: boolean) {
    const asked: Array<{ key: string; length: number }> = [];
    let flag = armed;
    return {
      asked,
      takes: 0,
      loadPromptTokens(key: string, length: number): number | null {
        asked.push({ key, length });
        return tokens;
      },
      takeForceCompaction(): boolean {
        this.takes += 1;
        const was = flag;
        flag = false;
        return was;
      },
    };
  }

  test('a measured size rides as a present field; the durable length is the bound', () => {
    const state = reader(1234, false);
    expect(measureCompactionTrigger(state, 'session-a', 42))
      .toEqual({ trigger: 'auto', providerReportedTokens: 1234 });
    expect(state.asked).toEqual([{ key: 'session-a', length: 42 }]);
  });

  test('no measurement is an ABSENT field, never a zero one', () => {
    const measured = measureCompactionTrigger(reader(null, false), 'k', 7);
    expect('providerReportedTokens' in measured).toBe(false);
    expect(measured.trigger).toBe('auto');
  });

  test('a provider-reported zero is a measurement and survives as one', () => {
    expect(measureCompactionTrigger(reader(0, false), 'k', 7).providerReportedTokens).toBe(0);
  });

  test('an armed rebuild is consumed exactly once per assembly, so it cannot loop', () => {
    const state = reader(null, true);
    expect(measureCompactionTrigger(state, 'k', 7).trigger).toBe('force');
    expect(measureCompactionTrigger(state, 'k', 7).trigger).toBe('auto');
    expect(state.takes).toBe(2);
  });
});

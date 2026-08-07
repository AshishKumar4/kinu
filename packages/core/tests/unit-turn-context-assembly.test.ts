// The shared turn-context assembly (orchestrator/turn-context.ts) — the ONE
// ordering both backends run: sanitize → extension onTurnStart → awaited
// transformContext → ephemeral ledger weave → turn-local tail. runChat and the
// cf beforeTurn both delegate here, so these invariants hold on both backends
// by construction.
import { describe, expect, test } from 'bun:test';
import type { ModelMessage } from 'ai';
import { Database } from 'bun:sqlite';
import { assembleTurnMessages } from '../src/orchestrator/turn-context.js';
import { ExtensionHost } from '../src/extension.js';
import { EphemeralContextLedger } from '../src/prompting/volatile-context.js';
import { createMemoryVFS } from './helpers.js';

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
      transformContext: (ctx) => {
        order.push('transform');
        transformSaw = ctx.messages;
        return undefined;
      },
    });
    const ledger = new EphemeralContextLedger();
    await assembleTurnMessages({
      ...base(),
      extensions,
      systemState: { ledger, context: { factsBlock: 'a: 1' } },
      turnLocal: [{ role: 'user', content: 'turn-local' }],
    });
    expect(order).toEqual(['turn-start', 'transform']);
    // The transform never sees a ledger block or the turn-local tail.
    expect(transformSaw).toEqual(HISTORY);
  });

  test('the weave runs over the TRANSFORMED history and the turn-local tail lands last', async () => {
    const compacted: ModelMessage[] = [{ role: 'user', content: 'summary' }];
    const extensions = new ExtensionHost().register({
      name: 'test.compact',
      transformContext: () => compacted,
    });
    const ledger = new EphemeralContextLedger();
    const out = await assembleTurnMessages({
      ...base(),
      extensions,
      systemState: { ledger, context: { factsBlock: 'a: 1' } },
      turnLocal: [{ role: 'user', content: 'turn-local' }],
    });
    // compacted history + one ledger block + the turn-local tail
    expect(out.length).toBe(compacted.length + 2);
    expect(out[0]).toEqual(compacted[0]!);
    expect(out.at(-1)).toEqual({ role: 'user', content: 'turn-local' });
    expect(JSON.stringify(out.at(-2))).toContain('a: 1');
  });

  test('the transform receives sessionKey, window, trigger, and the measured token signal', async () => {
    let seen: { sessionKey: string; contextWindow: number; trigger: string; providerReportedTokens?: number } | null = null;
    const extensions = new ExtensionHost().register({
      name: 'test.ctx',
      transformContext: (ctx) => {
        seen = {
          sessionKey: ctx.sessionKey, contextWindow: ctx.contextWindow, trigger: ctx.trigger,
          ...(ctx.providerReportedTokens !== undefined ? { providerReportedTokens: ctx.providerReportedTokens } : {}),
        };
        return undefined;
      },
    });
    await assembleTurnMessages({ ...base(), extensions, providerReportedTokens: 1234, trigger: 'force' });
    expect(seen).toEqual({ sessionKey: 'k', contextWindow: 200_000, trigger: 'force', providerReportedTokens: 1234 });
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
      transformContext: (ctx) => { transformSaw = ctx.messages; return undefined; },
    });
    const out = await assembleTurnMessages({
      ...base(),
      history: withFile,
      extensions,
      attachments: { accepts: new Set(['text']), vfs: createMemoryVFS(new Database(':memory:')) },
    });
    expect(out.length).toBe(1);
    // The transform saw the sanitized message, not the raw PDF part.
    expect(JSON.stringify(transformSaw)).not.toContain('base64,AAAA');
    expect(JSON.stringify(out)).not.toContain('base64,AAAA');
  });
});

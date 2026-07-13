// The stable/ephemeral/turn-local context split (cache-prefix stability):
//  - buildSystemPromptSync is byte-stable across rebuilds with unchanged
//    agent state — live executor labels and skill activation reasons must
//    never leak into it.
//  - System state (facts, memory tail, executor status) rides the
//    EphemeralContextLedger: a block appends only when the state fingerprint
//    changes, and every block freezes at its birth position forever (the
//    cache-stability contract).
//  - Turn-local state (activation reasons, device notice) renders as one
//    per-turn tail message, never captured by the ledger fingerprint.
//  - fnv1a64 (the telemetry + fingerprint hash) changes only on real events.
import { describe, test, expect } from 'bun:test';
import type { ModelMessage } from 'ai';
import {
  buildSystemPromptSync,
  runChat,
  EphemeralContextLedger,
  renderSystemStateBlock,
  renderTurnLocalContext,
  turnLocalContextMessage,
  executorAvailabilityLabel,
  fnv1a64,
  renderActiveSkillsSection,
  EPHEMERAL_CONTEXT_HEADER,
  TURN_CONTEXT_HEADER,
  type PromptExecutorInfo,
} from '../src/index.ts';
import type { ActiveSkillSet, ParsedSkill } from '../src/skills/types.ts';
import { createTestRuntime } from '@proteus/test-utils';

const idleSandbox: PromptExecutorInfo = { name: 'sandbox', available: true, configured: true, active: false, status: 'idle' };
const activeSandbox: PromptExecutorInfo = { name: 'sandbox', available: true, configured: true, active: true, status: 'active' };
const connectedLaptop: PromptExecutorInfo = { name: 'laptop', available: true, configured: true, active: true, status: 'active' };
const workspace: PromptExecutorInfo = { name: 'workspace', available: true, configured: true, active: true, status: 'active' };

function skill(name: string): ParsedSkill {
  return {
    name, description: `${name} skill`, allowed_tools: [], keywords: [],
    auto_activate: false, disable_model_invocation: false, user_invocable: true,
    body: `Body of ${name}`, ext: {}, source: 'vfs',
  };
}

function messageText(m: ModelMessage): string {
  return typeof m.content === 'string'
    ? m.content
    : (m.content as Array<{ type: string; text?: string }>)
        .filter((p) => p.type === 'text').map((p) => p.text ?? '').join('');
}

describe('byte-stable system prefix', () => {
  test('two consecutive builds with unchanged state are byte-identical', () => {
    const { rt } = createTestRuntime();
    const opts = { backend: 'cf' as const, executors: [workspace, idleSandbox, connectedLaptop] };
    expect(buildSystemPromptSync(rt, opts)).toBe(buildSystemPromptSync(rt, opts));
  });

  test('live executor status flips do NOT change the prefix (labels live in the ephemeral block)', () => {
    const { rt } = createTestRuntime();
    const idle = buildSystemPromptSync(rt, { backend: 'cf', executors: [workspace, idleSandbox] });
    const active = buildSystemPromptSync(rt, { backend: 'cf', executors: [workspace, activeSandbox] });
    expect(active).toBe(idle);
    expect(idle).not.toContain('ready on demand');
    expect(idle).not.toContain('(connected)');
    expect(idle).not.toContain('(active)');
  });

  test('the same active skill set renders byte-identically regardless of activation reason or order', () => {
    const { rt } = createTestRuntime();
    const a = skill('alpha');
    const b = skill('beta');
    const byKeyword: ActiveSkillSet = { active: [b, a], reasons: [{ name: 'beta', reason: { kind: 'keyword', matched_keyword: 'deploy' } }] };
    const byExplicit: ActiveSkillSet = { active: [a, b], reasons: [{ name: 'beta', reason: { kind: 'explicit', matched_token: 'beta' } }] };
    const one = buildSystemPromptSync(rt, { activeSkills: byKeyword });
    const two = buildSystemPromptSync(rt, { activeSkills: byExplicit });
    expect(one).toBe(two);
    expect(one).toContain('Body of alpha');   // bodies stay in the prefix
    expect(one).not.toContain('keyword "deploy"'); // reasons do not
  });

  test('hash changes only on real events: stable across rebuilds, changed on soul / skill-set changes', () => {
    const { rt } = createTestRuntime();
    const opts = { backend: 'cf' as const, executors: [workspace, idleSandbox] };
    const h1 = fnv1a64(buildSystemPromptSync(rt, opts));
    const h2 = fnv1a64(buildSystemPromptSync(rt, opts));
    expect(h2).toBe(h1);
    // Executor status flip: NOT a real event — hash must hold.
    const h3 = fnv1a64(buildSystemPromptSync(rt, { backend: 'cf', executors: [workspace, activeSandbox] }));
    expect(h3).toBe(h1);
    // Real events: soul edit and skill activation-set change must bust.
    const soul = fnv1a64(buildSystemPromptSync(rt, { ...opts, soulOverride: 'NEW SOUL' }));
    expect(soul).not.toBe(h1);
    const skills = fnv1a64(buildSystemPromptSync(rt, {
      ...opts,
      activeSkills: { active: [skill('alpha')], reasons: [] },
    }));
    expect(skills).not.toBe(h1);
  });
});

describe('renderSystemStateBlock', () => {
  test('renders facts, memory tail, and live executor labels under the ephemeral header', () => {
    const text = renderSystemStateBlock({
      factsBlock: '- user.tz = Europe/Berlin',
      memoryTail: '### Lesson: verify before claiming',
      executors: [connectedLaptop, idleSandbox, workspace],
    });
    expect(text).not.toBeNull();
    expect(text!).toStartWith(EPHEMERAL_CONTEXT_HEADER);
    expect(text!).toContain('user.tz = Europe/Berlin');
    expect(text!).toContain('verify before claiming');
    expect(text!).toContain('- laptop: connected');
    expect(text!).toContain('- sandbox: ready on demand');
  });

  test('unselectable executors are omitted; empty state renders nothing', () => {
    const offline: PromptExecutorInfo = { name: 'laptop', available: false, configured: true, active: false, status: 'disconnected' };
    expect(renderSystemStateBlock({ executors: [offline] })).toBeNull();
    expect(renderSystemStateBlock({})).toBeNull();
    expect(renderSystemStateBlock({ factsBlock: '  ' })).toBeNull();
  });

  test('executorAvailabilityLabel mirrors the lifecycle states', () => {
    expect(executorAvailabilityLabel(connectedLaptop)).toBe('connected');
    expect(executorAvailabilityLabel(activeSandbox)).toBe('active');
    expect(executorAvailabilityLabel(idleSandbox)).toBe('ready on demand');
    expect(executorAvailabilityLabel({ name: 'nimbus' })).toBe('available');
  });
});

describe('renderTurnLocalContext', () => {
  test('renders activation reasons and the device notice under the turn header', () => {
    const text = renderTurnLocalContext({
      activeSkills: { active: [skill('alpha')], reasons: [{ name: 'alpha', reason: { kind: 'keyword', matched_keyword: 'deploy' } }] },
      deviceNotice: '## Context update\nYour user\'s PC just connected.',
    });
    expect(text).not.toBeNull();
    expect(text!).toStartWith(TURN_CONTEXT_HEADER);
    expect(text!).toContain('alpha (keyword "deploy")');
    expect(text!).toContain('PC just connected');
  });

  test('empty turn-local context renders nothing (and no message)', () => {
    expect(renderTurnLocalContext({})).toBeNull();
    expect(renderTurnLocalContext({ deviceNotice: null })).toBeNull();
    expect(turnLocalContextMessage({})).toBeNull();
  });

  test('turnLocalContextMessage wraps the render as one user message', () => {
    const msg = turnLocalContextMessage({ deviceNotice: 'PC connected.' });
    expect(msg).toMatchObject({ role: 'user' });
    expect(String(msg!.content)).toStartWith(TURN_CONTEXT_HEADER);
  });
});

describe('EphemeralContextLedger (the cache-stability contract)', () => {
  const state = { factsBlock: '- k = v', executors: [idleSandbox] };

  test('(a) empty ledger + first turn → exactly one block at the tail', () => {
    const ledger = new EphemeralContextLedger();
    const history: ModelMessage[] = [{ role: 'user', content: 'hi' }];
    const out = ledger.weave(history, state);
    expect(history).toHaveLength(1); // input never mutated
    expect(out).toHaveLength(2);
    expect(out[1]).toMatchObject({ role: 'user' });
    expect(String(out[1]!.content)).toStartWith(EPHEMERAL_CONTEXT_HEADER);
    expect(ledger.size).toBe(1);
  });

  test('(b) unchanged fingerprint across N turns → still one block, frozen bytes AND index as history grows', () => {
    const ledger = new EphemeralContextLedger();
    const history: ModelMessage[] = [{ role: 'user', content: 'turn-1' }];
    const first = ledger.weave(history, state);
    const frozen = first[1]!;

    history.push({ role: 'assistant', content: 'answer-1' }, { role: 'user', content: 'turn-2' });
    const second = ledger.weave(history, state);
    history.push({ role: 'assistant', content: 'answer-2' }, { role: 'user', content: 'turn-3' });
    const third = ledger.weave(history, state);

    expect(ledger.size).toBe(1);
    // The block sits at its ORIGINAL index with its ORIGINAL bytes (the very
    // same message object), while durable history grows around it.
    expect(second[1]).toBe(frozen);
    expect(third[1]).toBe(frozen);
    expect(third.map(messageText)).toEqual([
      'turn-1', String(frozen.content), 'answer-1', 'turn-2', 'answer-2', 'turn-3',
    ]);
  });

  test('(c) fingerprint change → a SECOND block appends at the new tail; the first stays put', () => {
    const ledger = new EphemeralContextLedger();
    const history: ModelMessage[] = [{ role: 'user', content: 'turn-1' }];
    const first = ledger.weave(history, state);
    const frozen = first[1]!;

    history.push({ role: 'assistant', content: 'answer-1' }, { role: 'user', content: 'turn-2' });
    const changed = { ...state, factsBlock: '- k = v\n- new.fact = learned' };
    const out = ledger.weave(history, changed);

    expect(ledger.size).toBe(2);
    expect(out[1]).toBe(frozen); // old block frozen at its birth position
    const tail = out[out.length - 1]!;
    expect(String(tail.content)).toStartWith(EPHEMERAL_CONTEXT_HEADER);
    expect(String(tail.content)).toContain('new.fact = learned');
    expect(out.map(messageText)).toEqual([
      'turn-1', String(frozen.content), 'answer-1', 'turn-2', String(tail.content),
    ]);
  });

  test('(d) reset (cold start / compaction) → back to exactly one fresh block at the tail', () => {
    const ledger = new EphemeralContextLedger();
    ledger.weave([{ role: 'user', content: 'a' }], state);
    ledger.weave(
      [{ role: 'user', content: 'a' }, { role: 'assistant', content: 'b' }, { role: 'user', content: 'c' }],
      { ...state, factsBlock: '- changed = yes' },
    );
    expect(ledger.size).toBe(2);

    ledger.reset();
    expect(ledger.size).toBe(0);
    const compacted: ModelMessage[] = [{ role: 'user', content: 'summary' }, { role: 'user', content: 'next' }];
    const out = ledger.weave(compacted, state);
    expect(ledger.size).toBe(1);
    expect(out).toHaveLength(3);
    expect(String(out[2]!.content)).toStartWith(EPHEMERAL_CONTEXT_HEADER);
  });

  test('a shorter rewritten history self-heals stale frozen indices without duplicating messages', () => {
    const ledger = new EphemeralContextLedger();
    const oldHistory: ModelMessage[] = [
      { role: 'user', content: 'old-user-1' },
      { role: 'assistant', content: 'old-assistant-1' },
      { role: 'user', content: 'old-user-2' },
    ];
    ledger.weave(oldHistory, state);
    oldHistory.push({ role: 'assistant', content: 'old-assistant-2' });
    ledger.weave(oldHistory, { ...state, factsBlock: '- old = changed' });
    expect(ledger.size).toBe(2);

    const replacement: ModelMessage[] = [{ role: 'user', content: 'new-user-1' }];
    const freshState = { ...state, factsBlock: '- fresh = yes' };
    const freshBlock = renderSystemStateBlock(freshState)!;
    const out = ledger.weave(replacement, freshState);

    expect(out).toEqual([
      { role: 'user', content: 'new-user-1' },
      { role: 'user', content: freshBlock },
    ]);
    expect(ledger.size).toBe(1);
  });

  test('nothing to say → no block is born and none is removed', () => {
    const ledger = new EphemeralContextLedger();
    const out = ledger.weave([{ role: 'user', content: 'hi' }], {});
    expect(out.map(messageText)).toEqual(['hi']);
    expect(ledger.size).toBe(0);

    // A block exists, then the state empties: the frozen block stays
    // (removing a mid-array message would break the provider prefix cache).
    ledger.weave([{ role: 'user', content: 'hi' }], state);
    expect(ledger.size).toBe(1);
    const after = ledger.weave([{ role: 'user', content: 'hi' }, { role: 'assistant', content: 'yo' }], {});
    expect(ledger.size).toBe(1);
    expect(after).toHaveLength(3);
    expect(String(after[1]!.content)).toStartWith(EPHEMERAL_CONTEXT_HEADER);
  });
});

/** A one-step text model that captures every prompt it was handed. */
function promptCapturingModel() {
  const usage = { inputTokens: 1, outputTokens: 1, totalTokens: 2 };
  const prompts: Array<Array<{ role: string; content: unknown }>> = [];
  const model = {
    specificationVersion: 'v2' as const,
    provider: 'fake',
    modelId: 'fake-model',
    supportedUrls: {},
    doStream: async (options: { prompt: Array<{ role: string; content: unknown }> }) => {
      prompts.push(options.prompt);
      return {
        stream: new ReadableStream({
          start(c) {
            c.enqueue({ type: 'stream-start', warnings: [] });
            c.enqueue({ type: 'text-start', id: 't1' });
            c.enqueue({ type: 'text-delta', id: 't1', delta: 'ok' });
            c.enqueue({ type: 'text-end', id: 't1' });
            c.enqueue({ type: 'finish', finishReason: 'stop', usage });
            c.close();
          },
        }),
        response: { headers: {} },
      };
    },
  };
  return { model, prompts };
}

function promptTexts(prompt: Array<{ role: string; content: unknown }>): string[] {
  return prompt
    .filter((m) => m.role !== 'system')
    .map((m) => (m.content as Array<{ type: string; text?: string }>)
      .filter((p) => p.type === 'text').map((p) => p.text ?? '').join(''));
}

describe('the ledger + turn-local split through real runChat turns', () => {
  test('stable state across turns keeps ONE frozen block; turn-local tail re-renders per turn', async () => {
    const { model, prompts } = promptCapturingModel();
    const ledger = new EphemeralContextLedger();
    const history: ModelMessage[] = [];
    const state = { factsBlock: '- k = v' };

    const turn = async (userText: string, deviceNotice?: string) => {
      history.push({ role: 'user', content: userText });
      const tail = turnLocalContextMessage({ deviceNotice });
      for await (const ev of runChat({
        model: model as never,
        system: 'sys',
        history,
        systemState: { ledger, context: state },
        turnLocal: tail ? [tail] : undefined,
        tools: {},
        maxSteps: 1,
      })) {
        if (ev.type === 'done') for (const m of ev.responseMessages) history.push(m);
      }
    };

    await turn('turn-1', 'PC connected.');
    await turn('turn-2');
    await turn('turn-3', 'PC disconnected.');

    const [p1, p2, p3] = prompts.map(promptTexts);
    // Turn 1: user, ephemeral block, turn-local tail.
    expect(p1![0]).toBe('turn-1');
    expect(p1![1]).toStartWith(EPHEMERAL_CONTEXT_HEADER);
    expect(p1![2]).toStartWith(TURN_CONTEXT_HEADER);
    expect(p1![2]).toContain('PC connected.');
    // Turns 2 and 3: the block's bytes AND index are untouched (index 1 —
    // right after turn-1's user message) while history grows after it. The
    // varying turn-local state never spawned a second block.
    expect(ledger.size).toBe(1);
    expect(p2![1]).toBe(p1![1]!);
    expect(p3![1]).toBe(p1![1]!);
    // Turn 2 had nothing turn-local → no tail at all.
    expect(p2!.some((t) => t.startsWith(TURN_CONTEXT_HEADER))).toBe(false);
    // Turn 3's tail is fresh per-turn state at the very end.
    expect(p3![p3!.length - 1]).toContain('PC disconnected.');
  });

  test('a state change mid-conversation appends a second block at the new tail', async () => {
    const { model, prompts } = promptCapturingModel();
    const ledger = new EphemeralContextLedger();
    const history: ModelMessage[] = [];

    const turn = async (userText: string, factsBlock: string) => {
      history.push({ role: 'user', content: userText });
      for await (const ev of runChat({
        model: model as never,
        system: 'sys',
        history,
        systemState: { ledger, context: { factsBlock } },
        tools: {},
        maxSteps: 1,
      })) {
        if (ev.type === 'done') for (const m of ev.responseMessages) history.push(m);
      }
    };

    await turn('turn-1', '- k = v');
    await turn('turn-2', '- k = v\n- learned = later');

    const [p1, p2] = prompts.map(promptTexts);
    expect(ledger.size).toBe(2);
    // First block frozen where it was born; the new block rides the new tail.
    expect(p2![1]).toBe(p1![1]!);
    expect(p2![p2!.length - 1]).toContain('learned = later');
    // The durable history never captured any block.
    expect(history.some((m) => messageText(m).startsWith(EPHEMERAL_CONTEXT_HEADER))).toBe(false);
  });

  test('cold start (fresh ledger over the same durable history) attaches exactly one block', async () => {
    const { model, prompts } = promptCapturingModel();
    const history: ModelMessage[] = [
      { role: 'user', content: 'old-1' },
      { role: 'assistant', content: 'old-2' },
      { role: 'user', content: 'wake up' },
    ];
    for await (const _ of runChat({
      model: model as never,
      system: 'sys',
      history,
      systemState: { ledger: new EphemeralContextLedger(), context: { factsBlock: '- k = v' } },
      tools: {},
      maxSteps: 1,
    })) { /* drain */ }

    const texts = promptTexts(prompts[0]!);
    expect(texts.filter((t) => t.startsWith(EPHEMERAL_CONTEXT_HEADER))).toHaveLength(1);
    expect(texts[texts.length - 1]).toStartWith(EPHEMERAL_CONTEXT_HEADER);
  });
});

describe('fnv1a64', () => {
  test('is deterministic and byte-sensitive', () => {
    expect(fnv1a64('abc')).toBe(fnv1a64('abc'));
    expect(fnv1a64('abc')).not.toBe(fnv1a64('abd'));
    expect(fnv1a64('')).toHaveLength(16);
  });

  test('matches genuine FNV-1a 64 (the limb-multiply rewrite must never drift)', () => {
    // Standard FNV-1a 64 test vectors — persisted compaction rangeHashes and
    // content-hash keys depend on these exact digests.
    expect(fnv1a64('')).toBe('cbf29ce484222325');
    expect(fnv1a64('a')).toBe('af63dc4c8601ec8c');
    expect(fnv1a64('foobar')).toBe('85944171f73967e8');
    // UTF-16 code units above the byte range XOR into the low limb, matching
    // the previous BigInt implementation exactly.
    expect(fnv1a64('🚀 — ✦')).toBe(referenceFnv1a64('🚀 — ✦'));
    const long = 'chunk-of-history '.repeat(5_000) + '端末🚀';
    expect(fnv1a64(long)).toBe(referenceFnv1a64(long));
  });
});

/** The original BigInt implementation, kept as the test oracle. */
function referenceFnv1a64(text: string): string {
  let hash = 0xcbf29ce484222325n;
  const prime = 0x100000001b3n;
  for (let i = 0; i < text.length; i++) {
    hash ^= BigInt(text.charCodeAt(i));
    hash = (hash * prime) & 0xffffffffffffffffn;
  }
  return hash.toString(16).padStart(16, '0');
}

describe('active-skill budget priority (activation precedence, stable render order)', () => {
  test('an alphabetically-early giant skill cannot crowd out an earlier-activated one', () => {
    const giant: ParsedSkill = { ...skill('aaa-giant'), body: 'G'.repeat(20_000) };
    const invoked: ParsedSkill = { ...skill('zzz-invoked'), body: 'THE-INVOKED-BODY '.repeat(10) };
    // Activation precedence: the explicitly-invoked skill came FIRST; the
    // giant keyword skill activated after it.
    const section = renderActiveSkillsSection({ active: [invoked, giant], reasons: [] });
    // Budget follows precedence: the invoked skill keeps its full body and
    // the giant absorbs the truncation…
    expect(section).toContain('THE-INVOKED-BODY');
    expect(section).not.toContain('zzz-invoked"})'); // not truncated/omitted
    expect(section).toContain('[truncated:');
    // …while render order stays name-stable (giant block renders first).
    expect(section.indexOf('### aaa-giant')).toBeLessThan(section.indexOf('### zzz-invoked'));
  });

  test('without overflow, activation order still renders byte-identically', () => {
    const a = skill('alpha');
    const b = skill('beta');
    expect(renderActiveSkillsSection({ active: [a, b], reasons: [] }))
      .toBe(renderActiveSkillsSection({ active: [b, a], reasons: [] }));
  });
});

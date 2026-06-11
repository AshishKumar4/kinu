// The stable/volatile context seam (cache-prefix stability):
//  - buildSystemPromptSync is byte-stable across rebuilds with unchanged
//    agent state — live executor labels and skill activation reasons must
//    never leak into it.
//  - All per-turn state renders in the ONE volatile context message appended
//    at the end of the turn's messages.
//  - hashSystemPrompt (the telemetry invariant) changes only on real events.
import { describe, test, expect } from 'bun:test';
import type { ModelMessage } from 'ai';
import {
  buildSystemPromptSync,
  renderVolatileContext,
  appendVolatileContextMessage,
  executorAvailabilityLabel,
  hashSystemPrompt,
  VOLATILE_CONTEXT_HEADER,
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

describe('byte-stable system prefix', () => {
  test('two consecutive builds with unchanged state are byte-identical', () => {
    const { rt } = createTestRuntime();
    const opts = { backend: 'cf' as const, executors: [workspace, idleSandbox, connectedLaptop] };
    expect(buildSystemPromptSync(rt, opts)).toBe(buildSystemPromptSync(rt, opts));
  });

  test('live executor status flips do NOT change the prefix (labels live in the volatile tail)', () => {
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
    const h1 = hashSystemPrompt(buildSystemPromptSync(rt, opts));
    const h2 = hashSystemPrompt(buildSystemPromptSync(rt, opts));
    expect(h2).toBe(h1);
    // Executor status flip: NOT a real event — hash must hold.
    const h3 = hashSystemPrompt(buildSystemPromptSync(rt, { backend: 'cf', executors: [workspace, activeSandbox] }));
    expect(h3).toBe(h1);
    // Real events: soul edit and skill activation-set change must bust.
    const soul = hashSystemPrompt(buildSystemPromptSync(rt, { ...opts, soulOverride: 'NEW SOUL' }));
    expect(soul).not.toBe(h1);
    const skills = hashSystemPrompt(buildSystemPromptSync(rt, {
      ...opts,
      activeSkills: { active: [skill('alpha')], reasons: [] },
    }));
    expect(skills).not.toBe(h1);
  });
});

describe('renderVolatileContext', () => {
  test('renders facts, live executor labels, activation reasons, and the device notice', () => {
    const text = renderVolatileContext({
      factsBlock: '- user.tz = Europe/Berlin',
      executors: [connectedLaptop, idleSandbox, workspace],
      activeSkills: { active: [skill('alpha')], reasons: [{ name: 'alpha', reason: { kind: 'keyword', matched_keyword: 'deploy' } }] },
      deviceNotice: '## Context update\nYour user\'s PC just connected.',
    });
    expect(text).not.toBeNull();
    expect(text!).toStartWith(VOLATILE_CONTEXT_HEADER);
    expect(text!).toContain('user.tz = Europe/Berlin');
    expect(text!).toContain('- laptop: connected');
    expect(text!).toContain('- sandbox: ready on demand');
    expect(text!).toContain('alpha (keyword "deploy")');
    expect(text!).toContain('PC just connected');
  });

  test('unselectable executors are omitted; empty context renders nothing', () => {
    const offline: PromptExecutorInfo = { name: 'laptop', available: false, configured: true, active: false, status: 'disconnected' };
    expect(renderVolatileContext({ executors: [offline] })).toBeNull();
    expect(renderVolatileContext({})).toBeNull();
    expect(renderVolatileContext({ factsBlock: '  ', deviceNotice: null })).toBeNull();
  });

  test('executorAvailabilityLabel mirrors the lifecycle states', () => {
    expect(executorAvailabilityLabel(connectedLaptop)).toBe('connected');
    expect(executorAvailabilityLabel(activeSandbox)).toBe('active');
    expect(executorAvailabilityLabel(idleSandbox)).toBe('ready on demand');
    expect(executorAvailabilityLabel({ name: 'nimbus' })).toBe('available');
  });
});

describe('appendVolatileContextMessage', () => {
  test('appends ONE trailing user message and never mutates the input', () => {
    const history: ModelMessage[] = [{ role: 'user', content: 'hi' }, { role: 'assistant', content: 'hello' }];
    const out = appendVolatileContextMessage(history, { factsBlock: '- k = v' });
    expect(history).toHaveLength(2);
    expect(out).toHaveLength(3);
    expect(out[2]).toMatchObject({ role: 'user' });
    expect(String(out[2]!.content)).toStartWith(VOLATILE_CONTEXT_HEADER);
    expect(String(out[2]!.content)).toContain('- k = v');
  });

  test('with nothing volatile, returns an equal copy with no extra message', () => {
    const history: ModelMessage[] = [{ role: 'user', content: 'hi' }];
    const out = appendVolatileContextMessage(history, {});
    expect(out).toEqual(history);
    expect(out).not.toBe(history);
  });
});

describe('hashSystemPrompt', () => {
  test('is deterministic and byte-sensitive', () => {
    expect(hashSystemPrompt('abc')).toBe(hashSystemPrompt('abc'));
    expect(hashSystemPrompt('abc')).not.toBe(hashSystemPrompt('abd'));
    expect(hashSystemPrompt('')).toHaveLength(16);
  });
});

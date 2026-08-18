/**
 * Unit tests: sibling diversity at MCTS expansion (DO-NOW #1), and the branch
 * prompt every substrate shares — a facet, a local subprocess and the inline
 * fallback are only comparable if they were asked the same question.
 */

import { describe, test, expect } from 'bun:test';
import { diversityAngle, siblingAngles, diversityDirective } from '../src/mcts/diversity';
import {
  explorePrompt,
  reflectionPrompt,
  type ExplorePromptInput,
} from '../src/mcts/explore-prompt';
import { EVIDENCE_BUDGETS } from '../src/prompts/evidence-window';

describe('diversity angles', () => {
  test('single branch gets no siblings and an empty directive', () => {
    expect(siblingAngles(0, 1)).toEqual([]);
    expect(diversityDirective(siblingAngles(0, 1))).toBe('');
  });

  test('each branch in an N-way expansion is handed every OTHER branch angle', () => {
    const n = 3;
    for (let i = 0; i < n; i++) {
      const sibs = siblingAngles(i, n);
      expect(sibs.length).toBe(n - 1);
      // A branch never sees its own angle in its sibling list.
      expect(sibs).not.toContain(diversityAngle(i, n));
    }
  });

  test('sibling angles are DISTINCT within one expansion (no near-duplicate prompts)', () => {
    const n = 4;
    const angles = Array.from({ length: n }, (_, i) => diversityAngle(i, n));
    expect(new Set(angles).size).toBe(n);
  });

  test('directive names the sibling angles and demands a distinct approach', () => {
    const directive = diversityDirective(['the simplest possible solution']);
    expect(directive).toContain('the simplest possible solution');
    expect(directive).toMatch(/DISTINCT/);
  });
});
describe('explorePrompt — the one question every substrate asks', () => {
  const base = {
    mode: 'build' as const,
    context: 'user: fix the parser', craftedTools: [], siblings: [],
    languages: ['javascript'],
  } satisfies ExplorePromptInput;

  test('asks for a fence in a language the executor declared, which is what makes a branch groundable', () => {
    // The grounded evaluator scores a branch by EXECUTING its code. It only
    // has code to run because the prompt asked for a fence, so this is a
    // correctness property of the prompt, not a style choice — and asking for
    // a language nothing can run is how a whole search ends up ungrounded.
    expect(explorePrompt(base).system).toContain('```javascript code block');
    const polyglot = explorePrompt({ ...base, languages: ['python', 'javascript'] });
    expect(polyglot.system).toContain('```python code block');
    expect(polyglot.system).toContain('javascript, which also run here');
  });

  test('crafted tools ride as prior art; none means no empty heading', () => {
    expect(explorePrompt(base).system).not.toContain('Known patterns');
    const withTools = explorePrompt({
      ...base,
      craftedTools: [{ name: 'parse_log', description: 'split a log into records' }],
    });
    expect(withTools.system).toContain('Known patterns');
    expect(withTools.system).toContain('- parse_log: split a log into records');
  });

  test('the sibling diversity directive rides the user message', () => {
    const solo = explorePrompt(base);
    const withSiblings = explorePrompt({ ...base, siblings: ['the simplest possible solution'] });
    expect(solo.user).not.toContain('DISTINCT');
    expect(withSiblings.user).toContain('the simplest possible solution');
    expect(withSiblings.user).toContain(diversityDirective(['the simplest possible solution']));
  });

  test('the parent context is carried verbatim', () => {
    expect(explorePrompt(base).user).toContain('user: fix the parser');
  });

  test('Plan branches ask for a read-only planning alternative without runnable code', () => {
    const prompt = explorePrompt({ ...base, mode: 'plan' });
    expect(prompt.system).toContain('read-only planning approach');
    expect(prompt.system).not.toContain('code block');
    expect(prompt.user).toContain('Do not implement it');
  });
});

describe('reflectionPrompt', () => {
  test('names the attempt it is reflecting on', () => {
    const prompt = reflectionPrompt('fix the parser', 'tried a regex, it looped');
    expect(prompt).toContain('Task: fix the parser');
    expect(prompt).toContain('Attempt: tried a regex, it looped');
    expect(prompt).toContain('One sentence.');
  });

  test('a substrate with no trace table gets no empty Attempt heading', () => {
    const prompt = reflectionPrompt('fix the parser', '');
    expect(prompt).not.toContain('Attempt:');
    expect(prompt).toContain('Task: fix the parser');
  });

  test('a long attempt is bounded at both ends, not truncated to its opening', () => {
    // A reflection is about how the attempt ENDED; a head-only clamp would
    // hide the failure it is being asked to explain.
    const attempt = `START${'x'.repeat(EVIDENCE_BUDGETS.reflection * 2)}FAILED HERE`;
    const prompt = reflectionPrompt('t', attempt);
    expect(prompt).toContain('START');
    expect(prompt).toContain('FAILED HERE');
    expect(prompt.length).toBeLessThan(attempt.length);
  });
});

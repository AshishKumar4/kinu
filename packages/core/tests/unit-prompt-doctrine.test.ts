import { describe, expect, test } from 'bun:test';
import { createTestRuntime } from '@kinu.run/test-utils';
import { buildSystemPromptSync } from '../src/prompt';

import { PROMPT_MATRIX } from './fixtures/prompt-surface-matrix';

const full = PROMPT_MATRIX.find(({ name }) => name === 'cf-full-surface');

if (!full) throw new Error('Full prompt proof surface is missing');

describe('lead doctrine follows actor authority and available delegation', () => {

  test('a root without hire cannot receive hire doctrine or activate it through an override', () => {
    const { rt } = createTestRuntime();

    const prompt = buildSystemPromptSync(rt, {
      ...full.opts, agentsActions: ['swarm'],
      sectionOverrides: { 'lead/brief': '## Preparing a brief\nUNAVAILABLE_HIRE' },
    });

    expect(prompt).not.toContain('UNAVAILABLE_HIRE');

  });
});

// Staging 5c522f12d: the cloud prompt put `/home/main` beside "relative paths resolve there", and `vfs://` is `/` only 127
// lines on; 23 trials' first skill read dropped `vfs://` and landed in the home.
test('the prompt says a vfs:// path keeps its prefix, where it says how to name a file', () => {
  const { rt } = createTestRuntime();

  expect(buildSystemPromptSync(rt, full.opts)).toContain('and keep the prefix: `vfs://skills/x` starts at that tree\'s root, while `skills/x` is relative.');
});

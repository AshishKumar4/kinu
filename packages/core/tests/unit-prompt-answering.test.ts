import { describe, expect, test } from 'bun:test';
import { createTestRuntime } from '@kinu.run/test-utils';
import { buildSystemPromptSync } from '../src/prompt';
import type { SystemPromptOptions } from '../src/prompt';
import { ANSWERING_SECTION } from '../src/prompting/section-templates';
import { slateUiSegments } from '../src/slates/ui-blocks';
import { answerDrawsPages, TERMINAL_TURN_KEY } from '../src/types/turn-metadata';
import type { PromptExecutorInfo } from '../src/prompting/surface';

const PREVIEWS: PromptExecutorInfo = { name: 'workspace', kind: 'workspace', capabilities: ['net_inbound'], available: true, configured: true, active: true, status: 'active' };

/** A hosted workspace whose chat draws slates (its own executor publishes previews on its origin), read in the web chat. */
const WEB: SystemPromptOptions = {
  backend: 'cf', availableTools: ['eval', 'shell', 'file'], executors: [PREVIEWS], model: { id: 'opencode-go/muse-spark-1.3-contributor' }, pagesInAnswer: true,
};

const HEADING = '## Answering the person';

/** Whether the prompt teaches pages in the answer: the section and the executors section's pointer to it, together. */
function teachesPages(opts: SystemPromptOptions): boolean {
  const prompt = buildSystemPromptSync(createTestRuntime().rt, opts);
  const pointer = prompt.includes('written as "Answering the person" below shows');

  expect(pointer).toBe(prompt.includes(HEADING));

  return prompt.includes(HEADING);
}

describe('an answer is taught pages only where a person reads it with its pages drawn', () => {
  test('the web chat: taught', () => {
    expect(teachesPages(WEB)).toBe(true);
  });

  test('a reader who sees no pages, whatever the workspace can draw: a hirer, a terminal, the local CLI', () => {
    expect(teachesPages({ ...WEB, pagesInAnswer: false })).toBe(false);
    expect(teachesPages({ ...WEB, pagesInAnswer: undefined })).toBe(false);
    expect(teachesPages({ ...WEB, backend: 'cli-local', pagesInAnswer: false })).toBe(false);
  });

  test('a workspace whose own executor publishes no previews, or only its computer does: not taught', () => {
    expect(teachesPages({ ...WEB, executors: [{ ...PREVIEWS, capabilities: [] }] })).toBe(false);
    expect(teachesPages({ ...WEB, executors: [{ ...PREVIEWS, capabilities: [] }, { ...PREVIEWS, name: 'computer', kind: 'computer' }] })).toBe(false);
  });

  test("a turn a terminal opened is read where pages fold to a line; the web chat's are drawn", () => {
    expect([answerDrawsPages({ [TERMINAL_TURN_KEY]: true }), answerDrawsPages({ cwd: '/work' }), answerDrawsPages(undefined)]).toEqual([false, true, true]);
  });

  test('the example answer is one the chat draws: its words, then one page it reads as a block', () => {
    const section = ANSWERING_SECTION.render({});
    const example = section.slice(section.indexOf('<example>\n') + '<example>\n'.length, section.indexOf('\n</example>'));

    expect(slateUiSegments(example).map((segment) => segment.kind)).toEqual(['text', 'slate']);
  });
});

describe('the shared directory is in the file layout every agent is told', () => {
  test('hosted and local alike: vfs://scratch, every agent\'s to read and write, beside each one\'s own home', () => {
    for (const backend of ['cf', 'cli-local'] as const) {
      const prompt = buildSystemPromptSync(createTestRuntime().rt, { ...WEB, backend });

      expect({ backend, told: prompt.includes('`vfs://scratch` is the one directory every agent of it reads and writes') }).toEqual({ backend, told: true });
    }
  });
});


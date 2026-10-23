import { describe, expect, test } from 'bun:test';
import { createTestRuntime } from '@kinu.run/test-utils';
import { buildSystemPromptSync } from '../src/prompt';
import type { SystemPromptOptions } from '../src/prompt';
import { ANSWERING_SECTION } from '../src/prompting/section-templates';
import { blockServer, slateUiSegments } from '../src/slates/ui-blocks';
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

// 1023-ac: a page's server rides in its block, inert in the page, and runs in its process; its data is the workspace's.
describe("a page's own server", () => {
  test('is the slate/server script of its block, taken out of the page the chat draws; a block without one is all page', () => {
    const page = '<p>rows</p><script type="module">import { slate } from "kinu:slate"; slate.load();</script>';
    const server = 'import { SlateObject } from "kinu:slate";\nexport class Slate extends SlateObject { load() { return 1; } }';

    expect(blockServer(`${page}\n<script type="slate/server">${server}</script>`)).toEqual({ page: `${page}\n`, server });
    expect(blockServer(page)).toEqual({ page, server: null });
  });

  test('is taught: data in workspace.db, a server only for logic that runs server-side, and the libraries the page has', () => {
    const section = ANSWERING_SECTION.render({});

    expect(section).toContain('Keep data in `workspace.db` (shared with every agent and page); a block server is for logic that runs server-side.');
    expect(section).toContain('`uplot` for charts');
  });
});

// CODE-8: `\bname=` matched inside `data-name=` and inside another attribute's quoted value.
describe("a drawn block's name", () => {
  test('is its own name attribute, never one inside another attribute or its value', () => {
    const named = (tag: string) => slateUiSegments(`${tag}\n<p>hi</p>\n</slate-ui>`).flatMap((segment) => (segment.kind === 'slate' ? [segment.name] : []));

    expect(named('<slate-ui data-name="evil" name="good">')).toEqual(['good']);
    expect(named(`<slate-ui title="see name='evil'" name=good>`)).toEqual(['good']);
    expect(named('<slate-ui NAME="first" name="second">')).toEqual(['first']);
    expect(named('<slate-ui data-name="only">')).toEqual([]);
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


import { describe, expect, test } from 'bun:test';
import { createTestRuntime } from '@kinu.run/test-utils';
import { buildSystemPromptSync } from '../src/prompt';
import type { SystemPromptOptions } from '../src/prompt';
import { ANSWERING_SECTION } from '../src/prompting/section-templates';
import { slateUiSegments } from '../src/slates/ui-blocks';

/** A hosted workspace whose chat draws slates: its own executor publishes previews on the workspace's origin. */
const DRAWS_SLATES: SystemPromptOptions = {
  backend: 'cf',
  availableTools: ['eval', 'shell', 'file'],
  executors: [{ name: 'workspace', kind: 'workspace', capabilities: ['net_inbound'], available: true, configured: true, active: true, status: 'active' }],
  model: { id: 'opencode-go/muse-spark-1.3-contributor' },
};

const HEADING = '## Answering the person';

function promptOf(opts: SystemPromptOptions, hired = false): string {
  const { rt } = createTestRuntime();

  return buildSystemPromptSync(hired ? { ...rt, actor: { ...rt.actor, parentActorId: rt.actor.actorId } } : rt, opts);
}

describe('an answer the person reads is shown, where the chat draws pages', () => {
  test('the agent the person talks to is told how to write a page in its answer, and to read the skill only for a slate with files', () => {
    const prompt = promptOf(DRAWS_SLATES);

    expect(prompt).toContain(HEADING);
    expect(prompt).toContain('a page in your answer is written as "Answering the person" below shows; for a slate with files, read `vfs://skills/slates/SKILL.md` first.');
  });

  test('a hired agent, whose answer its hirer reads, and a chat that draws no pages, are told nothing of pages in an answer', () => {
    const hired = promptOf(DRAWS_SLATES, true);
    const cli = promptOf({ ...DRAWS_SLATES, backend: 'cli-local', executors: [{ name: 'workspace', kind: 'workspace', available: true, configured: true, active: true, status: 'active' }] });

    expect(hired).not.toContain(HEADING);
    expect(hired).toContain('read `vfs://skills/slates/SKILL.md` first; it says how.');
    expect(cli).not.toContain(HEADING);
    expect(cli).not.toContain('<slate-ui');
  });

  test('the example answer is one the chat draws: its words, then one page it reads as a block', () => {
    const section = ANSWERING_SECTION.render({});
    const example = section.slice(section.indexOf('<example>\n') + '<example>\n'.length, section.indexOf('\n</example>'));
    const segments = slateUiSegments(example);

    expect(segments.map((segment) => segment.kind)).toEqual(['text', 'slate']);
    expect(segments[1]).toMatchObject({ kind: 'slate', name: 'seattle-drizzle' });
  });
});

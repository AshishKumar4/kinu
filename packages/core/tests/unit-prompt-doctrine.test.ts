import { describe, expect, test } from 'bun:test';
import { createTestRuntime } from '@kinu.run/test-utils';
import { buildSystemPromptSync } from '../src/prompt';
import { WorkspaceActorDirectory } from '../src/identity/workspace-actors';
import { PROMPT_SECTIONS } from '../src/prompting/section-templates';
import { PROMPT_MATRIX } from './fixtures/prompt-surface-matrix';

const full = PROMPT_MATRIX.find(({ name }) => name === 'cf-full-surface');

if (!full) throw new Error('Full prompt proof surface is missing');

describe('lead doctrine follows actor authority and available delegation', () => {
  test('a durable-only root is never told to call the unavailable task lifetime', () => {
    const { rt } = createTestRuntime();

    const prompt = buildSystemPromptSync(rt, {
      ...full.opts, temporaryAsk: false, model: { id: 'gpt-5-codex' },
    });

    expect(prompt).not.toContain("lifetime:'task'");
    expect(prompt).toContain('This turn supports durable hires, not task-lifetime calls.');
    expect(prompt).toContain('Concrete implementation packets');
  });

  test('both hired lifetimes retain their subordinate surface even when hire is available', () => {
    const { rt } = createTestRuntime();

    const directory = new WorkspaceActorDirectory(rt.storage.sql, {
      workspaceId: rt.actor.workspaceId, ownerUserId: '',
    });

    const leadSections = PROMPT_SECTIONS.filter(({ id }) => id.startsWith('lead/'));
    const root = buildSystemPromptSync(rt, full.opts);

    expect(leadSections).toHaveLength(7);

    for (const lifetime of ['task', 'durable']) {
      const actor = directory.create({
        parent: directory.main(), name: `worker-${lifetime}`, kind: 'subordinate',
        lifetime: lifetime === 'task' ? 'task' : 'durable', creationId: crypto.randomUUID(),
      });

      const child = buildSystemPromptSync({ ...rt, actor }, { ...full.opts, identity: {} });
      const withoutLead = leadSections.reduce((prompt, section) => prompt.replace(`${section.render({ familyDelta: '', hasTaskHire: true })}\n\n`, ''), root);

      expect(child).toBe(withoutLead);

      for (const section of leadSections) {
        expect(root).toContain(section.render({ familyDelta: '', hasTaskHire: true }));
        expect(child).not.toContain(section.render({ familyDelta: '', hasTaskHire: true }));
      }
    }
  });

  test('a root without hire cannot receive hire doctrine or activate it through an override', () => {
    const { rt } = createTestRuntime();

    const prompt = buildSystemPromptSync(rt, {
      ...full.opts, agentsActions: ['swarm'],
      sectionOverrides: { 'lead/brief': '## Preparing a brief\nUNAVAILABLE_HIRE' },
    });

    expect(prompt).not.toContain('UNAVAILABLE_HIRE');

    for (const section of PROMPT_SECTIONS.filter(({ id }) => id.startsWith('lead/'))) {
      const heading = section.source.split('\n')[0];

      if (!heading) throw new Error(`Missing heading: ${section.id}`);
      expect(prompt).not.toContain(heading);
    }
  });
});

import { describe, expect, test } from 'bun:test';
import { createTestRuntime } from '@kinu.run/test-utils';
import { buildSystemPromptSync } from '../src/prompt';
import { localPlanes } from '../src/vfs/resolve';
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
    expect(prompt).toContain('`hire`');
  });

  test('both hired lifetimes retain their subordinate surface even when hire is available', () => {
    const { rt } = createTestRuntime();

    const directory = new WorkspaceActorDirectory(rt.storage.sql, {
      workspaceId: rt.actor.workspaceId, ownerUserId: '',
    });

    const leadSections = PROMPT_SECTIONS.filter(({ id }) => id.startsWith('lead/'));
    const root = buildSystemPromptSync(rt, full.opts);


    for (const lifetime of ['task', 'durable']) {
      const actor = directory.create({
        parent: directory.main(), name: `worker-${lifetime}`, origin: 'agent',
        lifetime: lifetime === 'task' ? 'task' : 'durable', creationId: crypto.randomUUID(),
      });

      const child = buildSystemPromptSync({ ...rt, actor }, { ...full.opts, identity: {} });
      const withoutLead = leadSections.reduce((prompt, section) => prompt.replace(`\n\n${section.render({ familyDelta: '', hasTaskHire: true })}`, ''), root);

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

// 2026-10-04: the prompt named files as "references" a person reads, never as paths the tools take, and named no real
// path for any plane, so the agent gave its shell vfs:// paths it could not run.
describe('the agent works in prefixed paths, and is told where each plane is', () => {
  const local = PROMPT_MATRIX.find(({ name }) => name === 'cli-local-full-surface');

  if (!local) throw new Error('the local prompt proof surface is missing');

  test('the static block makes prefixes the tools\' paths and a person\'s links; the workspace block names the real roots', () => {
    const { rt } = createTestRuntime();
    const planes = localPlanes({ space: '/home/ana/.kinu/acme', folder: '/home/ana/acme', home: '/home/ana', views: [] });
    const prompt = buildSystemPromptSync({ ...rt, planes }, local.opts);

    expect(prompt).toContain('The `file` tool and `workspace.*` take these as paths');
    expect(prompt).toContain('a link they open');
    expect(prompt).toContain('Prefixes name parts of `vfs://`: `local://` is `vfs://local`. Here `vfs://` is `/home/ana/.kinu/acme` and `vfs://local` is `/home/ana/acme`.');
    expect(prompt.indexOf('Prefixes name parts of')).toBeGreaterThan(prompt.indexOf('## Execution environments'));
    expect(prompt).toContain('read-only at `vfs://agent`');
  });

  // A view has bytes only the file tool renders; the shell is told so, and where the workspace's own skills really are.
  test('locally, the views are named as the file tool\'s alone, with the real path of the workspace\'s own skills', () => {
    const { rt } = createTestRuntime();
    const planes = localPlanes({ space: '/home/ana/.kinu/acme', folder: '/home/ana/acme', home: '/home/ana', views: ['skills', 'context'] });
    const prompt = buildSystemPromptSync({ ...rt, planes }, local.opts);

    expect(prompt).toContain('`vfs://skills` and `vfs://context` are views only the `file` tool and `workspace.*` read; no shell has a path for them.');
    expect(prompt).toContain('The workspace\'s own skills are files at `/home/ana/.kinu/acme/home/main/skills`.');
  });

  test('the cloud is told the same, with its own roots', () => {
    const { rt } = createTestRuntime();
    const prompt = buildSystemPromptSync(rt, full.opts);

    expect(prompt).toContain('The `file` tool and `workspace.*` take these as paths');
    expect(prompt).toContain('Prefixes name parts of `vfs://`: `local://` is `vfs://`, `sandbox://` is `vfs://sandbox` and a machine\'s `<device>://` is `vfs://pc/<device>`. Here `vfs://` is `/`.');
  });

  // 2026-10-04: the prompt named each prefix by hand. A new prefix is one row of the table, and the prompt states it.
  test('a prefix the table gains is stated with no other edit', () => {
    const { rt } = createTestRuntime();
    const planes = { ...rt.planes, prefixes: [...rt.planes.prefixes, { prefix: 'drive', subtree: '/shared' }] };

    expect(buildSystemPromptSync({ ...rt, planes }, full.opts)).toContain('`drive://` is `vfs://shared`');
  });
});

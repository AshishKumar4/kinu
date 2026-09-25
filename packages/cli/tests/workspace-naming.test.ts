/** A workspace has a name; the slug is its address and must not reach `kinu list` or the system prompt. */
import { scratchDir } from '../../test-utils/src/scratch';
import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, rmSync } from 'node:fs';

import { dirname, join } from 'node:path';
import { Database } from 'bun:sqlite';
import type { LanguageModel } from 'ai';
import type { LanguageModelV2CallOptions } from '@ai-sdk/provider';
import {
  initWorkspaceSchema,
  workspaceSlug,
  type HostedAgentRef,
  type LLMProviderConfig,
} from '@kinu.run/core';
import { createWorkspace } from '@kinu.run/core/identity';
import {
  LocalAgentHost,
  makeWorkspaceSchemaSql,
  openWorkspaceCLI,
  type LocalAgentHostOptions,
  type LocalHostedAgent,
  type SessionEvent,
} from '@kinu.run/cli-backend';
// The v2 fixture model is a test helper, not a package export: reuse it rather than keep a second copy.
import { TestLanguageModelV2 } from '../../cli-backend/tests/test-language-model';

// `AGENT_HOME` is resolved once per process at config.ts load and bun shares one process across files, so
// everything below reads `AGENT_HOME` rather than assuming this offer won. Dynamic import: a static one hoists.
const OFFERED_HOME = scratchDir('naming-home');

const inheritedHome = process.env.KINU_HOME;

process.env.KINU_HOME = OFFERED_HOME;

const { listKnownAgents } = await import('../src/agent-list');

const { upsertAgentConfig, AGENT_HOME } = await import('../src/config');

if (inheritedHome === undefined) delete process.env.KINU_HOME;
else process.env.KINU_HOME = inheritedHome;

const DUMMY_LLM: LLMProviderConfig = {
  name: 'fake', baseURL: 'http://localhost:0', headers: {}, model: 'fake-model',
};

/** Names Kinu rather than any workspace, so `planWorkspaceTitle` refuses it and the first prompt names the workspace. */
const PLACEHOLDER_MISSION = 'Help the user with the work they assign.';

const FIRST_PROMPT = 'Audit the OAuth callback flow';

const TITLE = 'Audit the OAuth callback flow';

const SLUG = workspaceSlug('4166c321-1a4e-4e20-9f15-9a7f159a4e20');

afterEach(() => {
  rmSync(join(AGENT_HOME, SLUG), { recursive: true, force: true });
});

interface PromptLog {
  model: LanguageModel;
  systems(): string[];
}

/** "ack" is not JSON, so the deterministic title stands and the expected name is a literal. */
function recordingModel(): PromptLog {
  const usage = { inputTokens: 5, outputTokens: 7, totalTokens: 12 };
  const systems: string[] = [];

  const record = (options: LanguageModelV2CallOptions) => {
    for (const message of options.prompt) {
      if (message.role === 'system') systems.push(message.content);
    }
  };

  const model = new TestLanguageModelV2({
    provider: 'fake',
    modelId: 'fake-model',
    doGenerate: async (options) => {
      record(options);

      return {
        content: [{ type: 'text', text: 'ack' }],
        finishReason: 'stop',
        usage,
        warnings: [],
      };
    },
    doStream: async (options) => {
      record(options);

      return {
        stream: new ReadableStream({
          start(controller) {
            controller.enqueue({ type: 'stream-start', warnings: [] });
            controller.enqueue({ type: 'text-start', id: '0' });
            controller.enqueue({ type: 'text-delta', id: '0', delta: 'ack' });
            controller.enqueue({ type: 'text-end', id: '0' });
            controller.enqueue({ type: 'finish', finishReason: 'stop', usage });
            controller.close();
          },
        }),
        response: { headers: {} },
      };
    },
  });

  return { model, systems: () => [...systems] };
}

/** Seeded under `AGENT_HOME`, where `listKnownAgents` looks. */
async function seedUntitledWorkspace(project: string): Promise<string> {
  const dbPath = join(AGENT_HOME, SLUG, 'agent.db');
  mkdirSync(dirname(dbPath), { recursive: true });
  const db = new Database(dbPath);
  db.exec('PRAGMA journal_mode = WAL');

  try {
    const rt = await createWorkspace(db, { name: SLUG, purpose: PLACEHOLDER_MISSION, llm: DUMMY_LLM });
    initWorkspaceSchema(makeWorkspaceSchemaSql(db));
    rt.actor.config.setDisplayNameOrigin('', 'auto');
  } finally {
    db.close();
  }

  await upsertAgentConfig({ name: SLUG, mode: 'local', localName: SLUG, cwd: project, workspaceId: 'proj' });

  return dbPath;
}

function makeHost(model: LanguageModel, refs: readonly HostedAgentRef[]): LocalAgentHost {
  const options: LocalAgentHostOptions = {
    roster: () => refs,
    dbPath: (name) => join(AGENT_HOME, name, 'agent.db'),
    open: async (ref, db, dbPath) => {
      const openConfig = { llm: DUMMY_LLM, cwd: ref.cwd };
      const { rt } = await openWorkspaceCLI(db, dbPath, openConfig);

      return { rt, openConfig, staticModel: model } satisfies LocalHostedAgent;
    },
  };

  return new LocalAgentHost(options);
}

function makeProject(): string {
  return scratchDir('naming-project');
}

/** The announcement is the auto-title's own write, so waiting on it waits on the fact, not a delay. */
function titled(host: LocalAgentHost): Promise<string> {
  const settled = Promise.withResolvers<string>();

  const unsubscribe = host.subscribe((_who, event: SessionEvent) => {
    if (event.type !== 'broadcast' || event.event.type !== 'workspace_renamed') return;
    unsubscribe();
    settled.resolve(event.event.displayName);
  });

  return settled.promise;
}

describe('a workspace is named by its first prompt, and that name is what a person and a model get', () => {
  test('the surface shows the name and the prompt names the workspace', async () => {
    const project = makeProject();
    await seedUntitledWorkspace(project);
    const log = recordingModel();
    const host = makeHost(log.model, [{ name: SLUG, cwd: project, workspaceId: 'proj' }]);

    try {
      // The first prompt must not claim a name: seeding SOUL.md's heading with the slug would.
      const session = await host.acquire(SLUG);
      const renamed = titled(host);
      await session.send(FIRST_PROMPT, { id: crypto.randomUUID() });
      expect(log.systems()[0]).not.toContain(SLUG);

      expect(await renamed).toBe(TITLE);

      const row = listKnownAgents().find((agent) => agent.name === SLUG);
      expect(row?.label).toBe(TITLE);

      await session.send('and now the token exchange', { id: crypto.randomUUID() });
      const latest = log.systems().at(-1) ?? '';
      expect(latest).toContain(`You work in the workspace "${TITLE}".`);
      expect(latest).not.toContain(SLUG);
    } finally {
      await host.close();
    }
  });

  test('a subagent prompt names the workspace and the subagent', async () => {
    const project = makeProject();
    await seedUntitledWorkspace(project);
    const log = recordingModel();
    const host = makeHost(log.model, [{ name: SLUG, cwd: project, workspaceId: 'proj' }]);

    try {
      const session = await host.acquire(SLUG);
      const renamed = titled(host);
      await session.send(FIRST_PROMPT, { id: crypto.randomUUID() });
      expect(await renamed).toBe(TITLE);

      const team = await host.team(SLUG);

      const created = await team.create({
        role: 'researcher',
        mission: 'Read the callback handler and report what it trusts.',
      });

      expect(created.displayName).toBe('Researcher');
      expect(created.name).not.toBe(created.displayName);

      const before = log.systems().length;
      await team.assign({
        name: created.name,
        task: 'Report what the callback handler trusts.',
        mode: 'build',
      });
      // The child's report wakes the parent: closing the host between turns tears a live turn's database away.
      const childTurn = Promise.withResolvers<void>();
      const parentTurn = Promise.withResolvers<void>();

      const unsubscribe = host.subscribe((who, event) => {
        if (event.type !== 'turn-end') return;

        if (who === `${SLUG}/${created.name}`) childTurn.resolve();

        if (who === SLUG) parentTurn.resolve();
      });

      await Promise.all([childTurn.promise, parentTurn.promise]);
      unsubscribe();

      const childPrompt = log.systems().slice(before)
        .find((system) => system.includes('a subagent in the workspace'));

      expect(childPrompt).toBeDefined();
      expect(childPrompt).toContain(`You are "Researcher", a subagent in the workspace "${TITLE}".`);
      expect(childPrompt).not.toContain(SLUG);
      expect(childPrompt).not.toContain(created.name);
    } finally {
      await host.close();
    }
  });
});

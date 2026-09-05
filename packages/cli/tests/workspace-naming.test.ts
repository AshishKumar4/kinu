/**
 * A workspace has a NAME. The slug is its address.
 *
 * The owner installed Kinu, opened a workspace, and was shown
 * `handwrought-walnut-4166c321` — in the workspace bar, and again at the head
 * of the prompt his own agent was reading. Both came from the same reading:
 * that a workspace with no title yet is "genuinely called" its slug. It is not.
 *
 * These tests drive the real substrate — a real workspace database, a real
 * `LocalAgentHost`, real turns through a real session — and assert on the two
 * things that actually reach somebody:
 *
 *   • the label `kinu list` and the TUI navigator render (`listKnownAgents`);
 *   • the system prompt bytes the model is handed.
 *
 * Nothing here asks the title generator what it would have produced. The
 * generator was already correct when the owner hit this; what was wrong was
 * what the surface and the prompt did with its absence.
 */
import { afterAll, afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { Database } from 'bun:sqlite';
import type { LanguageModel } from 'ai';
import type { LanguageModelV2CallOptions } from '@ai-sdk/provider';
import {
  createAgentConfigStore,
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
// The tree's one hand-rolled v2 fixture model, reached the way
// `local-agent-client.test.ts` reaches it: it is a test helper rather than a
// package export, and a second copy of it here would be a second fixture to
// keep in step with the provider spec.
import { TestLanguageModelV2 } from '../../cli-backend/tests/test-language-model';

// `AGENT_HOME` is resolved ONCE per process at config.ts's module load, and bun
// runs every file of an invocation in one process — so this file offers its own
// home and then works in whichever one the process actually resolved. A sibling
// suite that loaded config.ts first keeps its home, and everything below reads
// `AGENT_HOME` rather than assuming this file won that race.
//
// Dynamic because the offer has to be in place before the import: a static one
// is hoisted above the assignment.
const OFFERED_HOME = mkdtempSync(join(tmpdir(), 'kinu-naming-home-'));
const inheritedHome = process.env.KINU_HOME;
process.env.KINU_HOME = OFFERED_HOME;
const { listKnownAgents } = await import('../src/agent-list');
const { upsertAgentConfig, AGENT_HOME } = await import('../src/config');
if (inheritedHome === undefined) delete process.env.KINU_HOME;
else process.env.KINU_HOME = inheritedHome;
afterAll(() => rmSync(OFFERED_HOME, { recursive: true, force: true }));

const DUMMY_LLM: LLMProviderConfig = {
  name: 'fake', baseURL: 'http://localhost:0', headers: {}, model: 'fake-model',
};

/** The mission a workspace created with nothing said about it carries. It names
 *  Kinu rather than any workspace, so `planWorkspaceTitle` refuses to title
 *  from it and the FIRST PROMPT is what names the workspace instead. */
const PLACEHOLDER_MISSION = 'Help the user with the work they assign.';

/** What the owner types first. The title the workspace ends up with is this
 *  line, so the assertions below can be literal. */
const FIRST_PROMPT = 'Audit the OAuth callback flow';
const TITLE = 'Audit the OAuth callback flow';

/** A real slug, minted the way the product mints one, so "the surface must not
 *  show this" is a claim about the actual string a person was shown. */
const SLUG = workspaceSlug('4166c321-1a4e-4e20-9f15-9a7f159a4e20');

const tempRoots: string[] = [];
afterEach(() => {
  for (const root of tempRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

/** Every system prompt any actor was handed, in call order. */
interface PromptLog {
  model: LanguageModel;
  systems(): string[];
}

/**
 * A model that answers one word and records the system prompt it was handed.
 *
 * "ack" is not JSON, so the naming round-trip's parse finds no title in it and
 * the DETERMINISTIC title stands — which is what makes the expected name a
 * literal here rather than whatever a fake chose to say.
 */
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

/**
 * A workspace in the state the owner's was: a real slug, a placeholder mission,
 * no title, and `auto` origin — so nothing has named it and the first prompt is
 * allowed to.
 *
 * It is seeded UNDER `AGENT_HOME`, because that is where `listKnownAgents`
 * looks and this test's whole point is what that call answers.
 */
async function seedUntitledWorkspace(project: string): Promise<string> {
  const dbPath = join(AGENT_HOME, SLUG, 'agent.db');
  mkdirSync(dirname(dbPath), { recursive: true });
  const db = new Database(dbPath);
  db.exec('PRAGMA journal_mode = WAL');
  try {
    const rt = await createWorkspace(db, { name: SLUG, purpose: PLACEHOLDER_MISSION, llm: DUMMY_LLM });
    initWorkspaceSchema(makeWorkspaceSchemaSql(db));
    createAgentConfigStore(rt.storage.sql).setDisplayNameOrigin('', 'auto');
  } finally {
    db.close();
  }
  upsertAgentConfig({ name: SLUG, mode: 'local', localName: SLUG, cwd: project, workspaceId: 'proj' });
  return dbPath;
}

function makeHost(model: LanguageModel, refs: readonly HostedAgentRef[]): LocalAgentHost {
  const options: LocalAgentHostOptions = {
    roster: () => refs,
    dbPath: (name) => join(AGENT_HOME, name, 'agent.db'),
    childDbPath: (parentDbPath, child) => join(dirname(parentDbPath), 'subordinates', child, 'agent.db'),
    open: async (ref, db, dbPath) => {
      const openConfig = { llm: DUMMY_LLM, cwd: ref.cwd };
      const { rt } = await openWorkspaceCLI(db, dbPath, openConfig);
      return { rt, openConfig, staticModel: model } satisfies LocalHostedAgent;
    },
  };
  return new LocalAgentHost(options);
}

/** The physical project the agent's plane is bound to, plus the workspace
 *  directory this test leaves behind under the shared home. */
function makeProject(): string {
  const project = mkdtempSync(join(tmpdir(), 'kinu-naming-project-'));
  tempRoots.push(project, join(AGENT_HOME, SLUG));
  return project;
}

/** Resolves when the workspace announces the title it just took. That
 *  announcement is the auto-title's own write, so waiting on it is waiting on
 *  the fact rather than on a delay. */
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
      // Nothing has named this workspace yet, so the very first prompt the
      // model reads must not claim a name. The old shape claimed one: SOUL.md
      // opened `# handwrought-walnut-…` because the create path seeded the
      // heading with the slug.
      const session = await host.acquire(SLUG);
      const renamed = titled(host);
      await session.send(FIRST_PROMPT);
      expect(log.systems()[0]).not.toContain(SLUG);

      expect(await renamed).toBe(TITLE);

      // THE SURFACE. `listKnownAgents` is what `kinu list` prints and what the
      // TUI navigator renders; before this it answered with the directory name.
      const row = listKnownAgents().find((agent) => agent.name === SLUG);
      expect(row?.label).toBe(TITLE);

      // THE MODEL. The next turn's prompt names the workspace, and still never
      // spells the slug.
      await session.send('and now the token exchange');
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
      await session.send(FIRST_PROMPT);
      expect(await renamed).toBe(TITLE);

      // A hire with a role and no name of its own: the roster titles it from
      // the role, and the tree ADDRESSES it by a minted slug.
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
      // Both turns, because the child's report WAKES the parent: closing the
      // host between them tears a live turn's database out from under it.
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
      // Neither the workspace's slug nor the subagent's own minted address.
      expect(childPrompt).not.toContain(SLUG);
      expect(childPrompt).not.toContain(created.name);
    } finally {
      await host.close();
    }
  });
});

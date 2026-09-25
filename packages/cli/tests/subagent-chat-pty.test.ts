/**
 * A subagent the open agent hired shows in the Agent Hub, and its conversation opens from there, read from the local
 * workspace database the way the web reads a cloud one. Driven through `bin/cli.ts` on a real pty.
 */
import { expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { initWorkspaceSchema, SubordinateRosterStore, WorkspaceActorDirectory, type LLMProviderConfig } from '@kinu.run/core';
import { createWorkspace } from '@kinu.run/core/workspace-birth';
import { makeSql, makeSqlExec, makeWorkspaceSchemaSql } from '@kinu.run/cli-backend';
import { runToExit, scratchDir } from '@kinu.run/test-utils';

import { runTuiInPty } from './helpers/pty-screen';

const repoRoot = resolve(import.meta.dir, '../../..');

const cliBin = resolve(import.meta.dir, '../bin/cli.ts');

const BIRTH_LLM: LLMProviderConfig = { name: 'fake', baseURL: 'http://localhost:0', headers: {}, model: 'fake-model' };

/** A machine with a default model, so opening the chat reaches no endpoint. */
async function kinuHome(): Promise<string> {
  const home = scratchDir('subagent-chat-home');
  writeFileSync(join(home, 'config.json'), `${JSON.stringify({
    providers: { openaiCompat: { default: { baseURL: 'http://127.0.0.1:9/v1', apiKey: 'unused' } } },
  })}\n`, { mode: 0o600 });

  const tier = await runToExit([process.execPath, '-e', `
    const { updateDefaultTier } = await import('./packages/cli/src/default-model.ts');
    await updateDefaultTier({ model: 'openai-compat/fixture-model' });
  `], { cwd: repoRoot, env: { ...process.env, KINU_HOME: home } });

  expect(tier.exitCode, tier.stderr).toBe(0);

  return home;
}

/** The rows a hire leaves: the child actor in the directory and its entry in the parent's roster. */
async function workspaceThatHired(home: string, name: string, subagent: { name: string; displayName: string }): Promise<void> {
  const dir = join(home, name);
  mkdirSync(dir, { recursive: true });
  const db = new Database(join(dir, 'agent.db'));

  try {
    await createWorkspace(db, { name, purpose: 'Keep the shop running', llm: BIRTH_LLM });
    initWorkspaceSchema(makeWorkspaceSchemaSql(db));
    const identity = db.query<{ id: string; owner_user_id: string | null }, []>('SELECT id, owner_user_id FROM workspace_identity').get();

    if (identity === null) throw new Error('the workspace has no identity');
    const directory = new WorkspaceActorDirectory(makeSql(db), { workspaceId: identity.id, ownerUserId: identity.owner_user_id });
    const main = directory.main();

    const child = directory.apply(main, [], {
      action: 'register', name: subagent.name, creationId: `birth-${subagent.name}`, kind: 'subordinate', lifetime: 'durable',
    });

    const roster = new SubordinateRosterStore(makeSqlExec(db), main);
    roster.ensureSchema();

    roster.create({
      name: subagent.name,
      actorReference: child.reference,
      birth: {
        creationId: `birth-${subagent.name}`,
        seed: { name: subagent.name, displayName: subagent.displayName, nameOrigin: 'user', role: 'task', mission: 'Survey the logs', lifetime: 'durable' },
        assignment: null,
      },
      deleteRequested: false,
      createdBy: 'orchestrator',
      status: 'idle',
      currentTask: null,
      createdAt: Date.now(),
      dismissedAt: null,
      lifetime: 'durable',
      taskEventId: null,
    });
  } finally {
    db.close();
  }
}

test('the Agent Hub lists a hired subagent and Enter opens its conversation', async () => {
  const home = await kinuHome();
  await workspaceThatHired(home, 'shop', { name: 'scout', displayName: 'Scout' });

  const run = await runTuiInPty(cliBin, {
    args: ['chat', 'shop'],
    cwd: scratchDir('subagent-chat-cwd'),
    cols: 120,
    rows: 32,
    env: { KINU_HOME: home, KINU_SKIP_DAEMON: '1', KINU_UPDATE_CHECK: '0' },
    steps: [
      { wait: 'Send a message', timeout: 45 },
      { send: '\u001Ba' },
      { wait: 'Scout · agent', timeout: 15 },
      // One key per write: a burst of keys reads as a paste.
      { send: '\u001B[B' },
      { sleep: 0.3 },
      { send: '\u001B[B' },
      { sleep: 0.3 },
      { send: '\r' },
      { wait: 'Scout · subagent', timeout: 15 },
      { wait: 'No messages yet.', timeout: 15 },
      { send: '\u001B' },
      { gone: 'Scout · subagent', timeout: 10 },
      { wait: 'Agent Hub', timeout: 10 },
    ],
  });

  expect(run.waits.every((wait) => wait.met), run.screen).toBe(true);
});

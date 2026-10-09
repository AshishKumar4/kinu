/**
 * The agent's open questions, answered in the full-screen chat: `/answer` opens them, Enter picks the recommended
 * choice, a question that takes several is ticked and finished with "Other" in the owner's words, and the answer is
 * the one the store records. Driven through `bin/cli.ts` on a real pty.
 */
import { expect, test } from 'bun:test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { initWorkspaceSchema, OwnerQuestionStore, WorkspaceActorDirectory, type JsonObject, type LLMProviderConfig } from '@kinu.run/core';
import { createWorkspace } from '@kinu.run/core/workspace-birth';
import { makeSql, makeWorkspaceSchemaSql, workspaceHome } from '@kinu.run/cli-backend';
import { runToExit, scratchDir, workspaceDatabase } from '@kinu.run/test-utils';

import { placeLocalWorkspace } from './helpers/local-refs';
import { runTuiInPty } from './helpers/pty-screen';

const repoRoot = resolve(import.meta.dir, '../../..');

const cliBin = resolve(import.meta.dir, '../bin/cli.ts');

const BIRTH_LLM: LLMProviderConfig = { name: 'fake', baseURL: 'http://localhost:0', headers: {}, model: 'fake-model' };

const ASK: JsonObject = {
  questions: [
    {
      id: 'storage', header: 'Money', question: 'How should prices be stored?', recommended: 0,
      options: [{ label: 'Integer cents', description: 'Exact sums.' }, { label: 'Decimal', description: 'Reads as written.' }],
    },
    {
      id: 'checks', header: 'Checks', question: 'Which checks run before deploy?', multi: true,
      options: [{ label: 'Cart totals' }, { label: 'Coupon stacking' }],
    },
  ],
};

/** A machine with a default model, so opening the chat reaches no endpoint. */
async function kinuHome(): Promise<string> {
  const home = scratchDir('questions-overlay-home');
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

/** A workspace whose agent asked and waits: the row its asking step left. */
async function workspaceThatAsked(home: string, name: string): Promise<string> {
  const dir = join(home, name);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, 'agent.db');
  const db = workspaceDatabase(path);

  try {
    await createWorkspace(db, { name, purpose: 'Keep the shop running', llm: BIRTH_LLM, home: workspaceHome(db) });
    initWorkspaceSchema(makeWorkspaceSchemaSql(db));
    const identity = db.query<{ id: string; owner_user_id: string | null }, []>('SELECT id, owner_user_id FROM workspace_identity').get();

    if (identity === null) throw new Error('the workspace has no identity');
    const main = new WorkspaceActorDirectory(makeSql(db), { workspaceId: identity.id, ownerUserId: identity.owner_user_id }).main();

    new OwnerQuestionStore(makeSql(db), main).ask([{ toolCallId: 'call-ask', input: ASK }], { turnId: 'turn-ask', mode: 'build', tier: null, reason: { provenance: 'chat' } });
  } finally {
    db.close();
  }

  return path;
}

test('/answer opens the questions; a choice, a tick and "Other" in the owner\'s words are the answer recorded', async () => {
  const home = await kinuHome();
  const path = await workspaceThatAsked(home, 'shop');
  const folder = placeLocalWorkspace(home, 'shop');

  await runTuiInPty(cliBin, {
    args: ['chat', 'shop'],
    cwd: folder,
    cols: 120,
    rows: 36,
    env: { KINU_HOME: home, KINU_SKIP_DAEMON: '1', KINU_UPDATE_CHECK: '0' },
    steps: [
      { wait: 'Send a message', timeout: 45 },
      { send: '/answer' },
      { sleep: 0.5 },
      { send: '\r' },
      { wait: 'How should prices be stored?', timeout: 15 },
      { wait: 'Integer cents (Recommended)', timeout: 5 },
      // The recommended choice is the one Enter takes.
      { send: '\r' },
      { wait: 'Which checks run before deploy?', timeout: 10 },
      { send: '\r' },
      { wait: '[x] Cart totals', timeout: 10 },
      // One key per write: a burst of keys reads as a paste.
      { send: '\u001B[B' },
      { sleep: 0.3 },
      { send: '\u001B[B' },
      { sleep: 0.3 },
      { send: '\r' },
      { wait: 'Enter sends your answer', timeout: 10 },
      { send: 'Refund flow' },
      { sleep: 0.5 },
      { send: '\r' },
      { gone: 'Which checks run before deploy?', timeout: 15 },
    ],
  });

  const db = workspaceDatabase(path);

  try {
    const row = db.query<{ status: string; answers_json: string | null }, []>('SELECT status, answers_json FROM owner_questions').get();

    expect(row?.status).toBe('answered');
    expect(JSON.parse(row?.answers_json ?? 'null')).toEqual([
      { id: 'storage', selected: ['Integer cents'] },
      { id: 'checks', selected: ['Cart totals'], other: 'Refund flow' },
    ]);
  } finally {
    db.close();
  }
});

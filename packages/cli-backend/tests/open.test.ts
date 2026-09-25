// openWorkspaceCLI: the local resume path, reading a workspace's identity and SOUL.md.
import { scratchDir } from '../../test-utils/src/scratch';

import { join } from 'node:path';
import { describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import type { LLMProviderConfig } from '@kinu.run/core';
import { createWorkspace } from '@kinu.run/core/workspace-birth';
import { openWorkspaceCLI } from '../src/open';

const DUMMY_LLM: LLMProviderConfig = {
  name: 'fake', baseURL: 'http://localhost:0', headers: {}, model: 'fake-model',
};

describe('openWorkspaceCLI', () => {
  test('reads the soul out of the workspace filesystem, and its mission onto the identity row', async () => {
    const dir = scratchDir('open');
    const dbPath = join(dir, 'agent.db');
    const db = new Database(dbPath);
    await createWorkspace(db, { name: 'jarvis', purpose: 'Run the household and the lab.', llm: DUMMY_LLM });

    const { info } = await openWorkspaceCLI(db, dbPath, { llm: DUMMY_LLM });

    expect(info.soul).toContain('Run the household and the lab.');
    expect(info.purpose).toBe('Run the household and the lab.');
    db.close();
  });
});

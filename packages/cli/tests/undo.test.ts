/**
 * /undo — the files half of the walk-back pair. performUndo drives the REAL
 * shadow-git engine (createHostCheckpoints + real git on this host) through
 * the AgentClient checkpoint surface, exactly as LocalAgentClient wires it.
 */
import { describe, expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHostCheckpoints } from '@proteus/cli-backend';
import type { FileCheckpointEntry } from '@proteus/core';
import { commandsForClient, executeSlashCommand, groupCheckpointsByTurn, performUndo } from '../src/slash-commands.js';
import type { AgentClient, FileCheckpointSurface } from '../src/agent-client.js';

function realEngineClient(opts: { gitBin?: string } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'proteus-undo-'));
  const work = join(root, 'project');
  mkdirSync(work, { recursive: true });
  const engine = createHostCheckpoints({ agent: 'undo-test', base: join(root, 'shadow'), gitBin: opts.gitBin });
  const checkpoints: FileCheckpointSurface = {
    list: (limit) => engine.list(limit),
    plan: (dir, id) => engine.plan(dir, id),
    restore: (dir, id) => engine.restore(dir, id),
    status: () => engine.status(),
  };
  return { root, work, engine, client: { checkpoints }, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

describe('performUndo', () => {
  test('restores the last turn by default, reporting paths and counts first', async () => {
    const { work, engine, client, cleanup } = realEngineClient();
    try {
      writeFileSync(join(work, 'app.ts'), 'turn zero');
      engine.beginTurn({ turnId: 'turn-1', sessionId: 'default' });
      await engine.ensureCheckpoint(work);
      writeFileSync(join(work, 'app.ts'), 'turn one damage');
      writeFileSync(join(work, 'junk.ts'), 'collateral');

      const result = await performUndo(client);
      expect(result.restored).toBe(true);
      expect(result.text).toContain('1 modified');
      expect(result.text).toContain('1 removed');
      expect(result.text).toContain('~ app.ts');
      expect(result.text).toContain('- junk.ts');
      expect(readFileSync(join(work, 'app.ts'), 'utf8')).toBe('turn zero');
      expect(existsSync(join(work, 'junk.ts'))).toBe(false);
    } finally { cleanup(); }
  });

  test('/undo n walks back n turns; an out-of-range n lists the turns instead', async () => {
    const { work, engine, client, cleanup } = realEngineClient();
    try {
      for (let i = 0; i < 3; i++) {
        writeFileSync(join(work, 'state.txt'), `before turn ${i}`);
        engine.beginTurn({ turnId: `turn-${i}`, sessionId: 'default' });
        await engine.ensureCheckpoint(work);
      }
      writeFileSync(join(work, 'state.txt'), 'final damage');

      const listing = await performUndo(client, '99');
      expect(listing.restored).toBe(false);
      expect(listing.text).toContain('Usage: /undo [n]');

      const result = await performUndo(client, '3'); // back to before turn-0's mutations
      expect(result.restored).toBe(true);
      expect(readFileSync(join(work, 'state.txt'), 'utf8')).toBe('before turn 0');
    } finally { cleanup(); }
  });

  test('"/undo 1" after a restore undoes the restore, as the success hint promises', async () => {
    const { work, engine, client, cleanup } = realEngineClient();
    try {
      writeFileSync(join(work, 'app.ts'), 'turn zero');
      engine.beginTurn({ turnId: 'turn-1', sessionId: 'default' });
      await engine.ensureCheckpoint(work);
      writeFileSync(join(work, 'app.ts'), 'turn one damage');

      // First /undo restores to pre-turn state and advertises its own undo.
      const first = await performUndo(client);
      expect(first.restored).toBe(true);
      expect(first.text).toContain('Undo this with /undo 1.');
      expect(readFileSync(join(work, 'app.ts'), 'utf8')).toBe('turn zero');

      // The promised follow-up: /undo 1 must land on the pre-restore
      // snapshot ("turn one damage"), not re-apply the pre-turn checkpoint.
      const second = await performUndo(client, '1');
      expect(second.restored).toBe(true);
      expect(readFileSync(join(work, 'app.ts'), 'utf8')).toBe('turn one damage');
    } finally { cleanup(); }
  });

  test('reports honestly when nothing changed since the checkpoint', async () => {
    const { work, engine, client, cleanup } = realEngineClient();
    try {
      writeFileSync(join(work, 'a.txt'), 'stable');
      engine.beginTurn({ turnId: 't', sessionId: 'default' });
      await engine.ensureCheckpoint(work);
      const result = await performUndo(client);
      expect(result.restored).toBe(false);
      expect(result.text).toContain('nothing to restore');
    } finally { cleanup(); }
  });

  test('degrades honestly: no checkpoints yet, no surface, and no git', async () => {
    const { client, cleanup } = realEngineClient();
    try {
      const empty = await performUndo(client);
      expect(empty.restored).toBe(false);
      expect(empty.text).toContain('No file checkpoints yet');
    } finally { cleanup(); }

    const noSurface = await performUndo({ checkpoints: null });
    expect(noSurface.restored).toBe(false);
    expect(noSurface.text).toContain('not available');

    const { client: degraded, cleanup: cleanup2 } = realEngineClient({ gitBin: '/nonexistent/git' });
    try {
      const result = await performUndo(degraded);
      expect(result.restored).toBe(false);
      expect(result.text).toBe('checkpoints unavailable: git not found');
    } finally { cleanup2(); }
  });
});

describe('/undo command surface', () => {
  const entry = (id: string, turnId: string | null, at: number): FileCheckpointEntry =>
    ({ id, dir: '/tmp/p', at, turnId, sessionId: 's', reason: 'pre-mutation' });

  test('groups checkpoints by turn, newest first, keeping multi-dir turns together', () => {
    const groups = groupCheckpointsByTurn([
      { ...entry('c3', 'turn-2', 30) },
      { ...entry('c2b', 'turn-1', 21), dir: '/tmp/other' },
      { ...entry('c2a', 'turn-1', 20) },
      { ...entry('c1', null, 10) },
    ]);
    expect(groups.map((g) => g.map((e) => e.id))).toEqual([['c3'], ['c2b', 'c2a'], ['c1']]);
  });

  test('is offered only when the client has a checkpoint surface', async () => {
    const withSurface = { localControls: null, consents: null, checkpoints: {} as FileCheckpointSurface };
    const without = { localControls: null, consents: null, checkpoints: null };
    expect(commandsForClient(withSurface).some((c) => c.name === '/undo')).toBe(true);
    expect(commandsForClient(without).some((c) => c.name === '/undo')).toBe(false);

    const outcome = await executeSlashCommand({ ...without } as AgentClient, '/undo 2');
    expect(outcome).toEqual({ kind: 'unknown', command: '/undo' });
  });

  test('parses /undo [n] into the surface-owned outcome', async () => {
    const client = { checkpoints: {} as FileCheckpointSurface } as AgentClient;
    expect(await executeSlashCommand(client, '/undo')).toEqual({ kind: 'undo', ref: undefined });
    expect(await executeSlashCommand(client, '/undo 3')).toEqual({ kind: 'undo', ref: '3' });
  });
});

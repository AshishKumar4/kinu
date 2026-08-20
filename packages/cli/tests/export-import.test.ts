/**
 * `proteus export` / `proteus import` end to end, as a user runs them.
 *
 * The load-bearing claim is one format: a CLOUD workspace exported over the
 * paged RPC restores through the SAME `proteus import` a local export does,
 * with its content intact. Both directions run the real CLI binary against a
 * throwaway PROTEUS_HOME — the cloud side against a stub origin that answers
 * the export RPC out of a real SQLite workspace.
 */

import { afterEach, describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { archiveSqlFromDatabase, readWorkspaceArchivePage, type ArchiveCursor } from '@kinu/core';
import { JsonArraySchema, JsonObjectSchema } from '@kinu/core';
import * as v from 'valibot';

const ArchiveCursorSchema: v.GenericSchema<ArchiveCursor> = v.variant('phase', [
  v.object({ phase: v.literal('sql'), table: v.string(), after: v.nullable(v.number()), rows: v.number() }),
  v.object({ phase: v.literal('files'), after: v.string(), rows: v.number(), files: v.number() }),
]);

const repoRoot = resolve(__dirname, '../../..');
const cliBin = join(repoRoot, 'packages/cli/bin/cli.ts');
const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function scratch(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

/** A workspace database with the awkward content: text, BLOBs, many rows. */
function seedWorkspace(path: string): void {
  const db = new Database(path, { create: true });
  db.exec(`CREATE TABLE workspace_identity (id TEXT NOT NULL, name TEXT NOT NULL, created_at INTEGER NOT NULL)`);
  db.exec(`CREATE TABLE messages (id TEXT PRIMARY KEY, content TEXT NOT NULL)`);
  db.exec(`CREATE TABLE vfs_files (path TEXT PRIMARY KEY, data BLOB)`);
  db.query(`INSERT INTO workspace_identity (id, name, created_at) VALUES (?, ?, ?)`).run('w1', 'scout', 100);
  for (let i = 0; i < 300; i++) {
    db.query(`INSERT INTO messages (id, content) VALUES (?, ?)`).run(`m${i}`, `note ${i} with "quotes"`);
  }
  const bytes = new Uint8Array(256);
  for (let i = 0; i < bytes.length; i++) bytes[i] = i;
  db.query(`INSERT INTO vfs_files (path, data) VALUES (?, ?)`).run('logo.bin', bytes);
  // Multi-byte text long enough that the reader's 64 KiB chunks land mid-
  // character: a decoder that does not stream corrupts a real transcript here.
  db.query(`INSERT INTO messages (id, content) VALUES (?, ?)`).run('unicode', '→ café 🌍 '.repeat(9000));
  db.close();
}

function runCli(home: string, args: string[], env: Record<string, string> = {}) {
  return Bun.spawn([process.execPath, cliBin, ...args], {
    cwd: repoRoot,
    env: { ...process.env, PROTEUS_HOME: home, NO_COLOR: '1', ...env },
    stdout: 'pipe',
    stderr: 'pipe',
  });
}

async function result(proc: ReturnType<typeof runCli>) {
  const exitCode = await proc.exited;
  return {
    exitCode,
    stdout: await new Response(proc.stdout).text(),
    stderr: await new Response(proc.stderr).text(),
  };
}

function restoredDb(home: string, name: string): Database {
  return new Database(join(home, name, 'agent.db'), { readonly: true });
}

describe('proteus export / import', () => {
  test('a local workspace round-trips through an archive', async () => {
    const home = scratch('proteus-export-local-');
    const out = scratch('proteus-export-out-');
    writeFileSync(join(home, 'config.json'), JSON.stringify({ agents: {}, aliases: {} }));
    seedWorkspace(join(mkdirp(home, 'scout'), 'agent.db'));

    const archive = join(out, 'scout.proteus.jsonl');
    const exported = await result(runCli(home, ['export', 'scout', '-o', archive]));
    expect(exported.stderr).toBe('');
    expect(exported.exitCode).toBe(0);
    expect(exported.stdout).toContain('Exported scout (local)');

    const imported = await result(runCli(home, ['import', archive, '--name', 'scout-restored']));
    expect(imported.stderr).toBe('');
    expect(imported.exitCode).toBe(0);
    expect(imported.stdout).toContain('Imported workspace scout-restored');

    const db = restoredDb(home, 'scout-restored');
    expect(db.query(`SELECT COUNT(*) AS n FROM messages`).get()).toEqual({ n: 301 });
    expect(db.query(`SELECT name FROM workspace_identity`).get()).toEqual({ name: 'scout' });
    expect(db.query(`SELECT content FROM messages WHERE id = 'unicode'`).get())
      .toEqual({ content: '→ café 🌍 '.repeat(9000) });
    const blob = db.query<{ data: Uint8Array }, []>(`SELECT data FROM vfs_files WHERE path = 'logo.bin'`).get();
    if (!blob) throw new Error('restored logo missing');
    expect(Array.from(new Uint8Array(blob.data)).slice(0, 4)).toEqual([0, 1, 2, 3]);
    db.close();
  });

  test('a cloud workspace exports over the paged RPC and imports locally', async () => {
    const cloudDir = scratch('proteus-export-cloud-db-');
    const cloudDb = join(cloudDir, 'cloud.db');
    seedWorkspace(cloudDb);
    const source = archiveSqlFromDatabase(new Database(cloudDb, { readonly: true }));

    const calls: Array<{ method: string; cursor: ArchiveCursor | null }> = [];
    const server = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      async fetch(request) {
        const url = new URL(request.url);
        if (url.pathname !== '/api/cli/workspaces/skywriter/rpc') return new Response('nope', { status: 404 });
        if (request.headers.get('authorization') !== 'Bearer ptc_stored_session') {
          return Response.json({ error: 'unauthorized' }, { status: 401 });
        }
        const body = v.parse(JsonObjectSchema, await request.json());
        const method = v.parse(v.string(), body.method);
        const args = v.parse(JsonArraySchema, body.args);
        calls.push({ method, cursor: v.parse(v.nullable(ArchiveCursorSchema), args[0] ?? null) });
        // Exactly what the orchestrator RPC does, with a page size small
        // enough that the CLI has to walk more than one page.
        const page = await readWorkspaceArchivePage(source, {
          workspace: 'skywriter', source: 'cloud',
          cursor: calls[calls.length - 1]!.cursor, maxBytes: 2048,
        });
        return Response.json({ result: page });
      },
    });

    const home = scratch('proteus-export-cloud-');
    const out = scratch('proteus-export-cloud-out-');
    writeFileSync(join(home, 'config.json'), JSON.stringify({
      origin: `http://127.0.0.1:${server.port}`,
      accessToken: 'ptc_stored_session',
      agents: {
        skywriter: { name: 'skywriter', mode: 'cloud', cloudName: 'skywriter', createdAt: '', updatedAt: '' },
      },
      aliases: {},
    }));

    try {
      const archive = join(out, 'skywriter.proteus.jsonl');
      const exported = await result(runCli(home, ['export', 'skywriter', '-o', archive], {
        PROTEUS_ORIGIN: `http://127.0.0.1:${server.port}`,
      }));
      expect(exported.stderr).toBe('');
      expect(exported.exitCode).toBe(0);
      expect(exported.stdout).toContain('Exported skywriter (cloud)');
      expect(calls.length).toBeGreaterThan(1);
      expect(calls.every((c) => c.method === 'exportWorkspaceArchive')).toBe(true);
      expect(calls[0]!.cursor).toBeNull();

      // No --name: the archive says which workspace it is.
      const imported = await result(runCli(home, ['import', archive]));
      expect(imported.stderr).toBe('');
      expect(imported.exitCode).toBe(0);
      expect(imported.stdout).toContain('Imported workspace skywriter');

      const db = restoredDb(home, 'skywriter');
      expect(db.query(`SELECT COUNT(*) AS n FROM messages`).get()).toEqual({ n: 301 });
      expect(db.query(`SELECT content FROM messages WHERE id = 'm7'`).get())
        .toEqual({ content: 'note 7 with "quotes"' });
      db.close();
    } finally {
      server.stop(true);
    }
  });

  test('a database file from an older export still restores', async () => {
    const home = scratch('proteus-export-legacy-');
    const out = scratch('proteus-export-legacy-out-');
    writeFileSync(join(home, 'config.json'), JSON.stringify({ agents: {}, aliases: {} }));
    const legacy = join(out, 'oldbot.agent.db');
    seedWorkspace(legacy);

    const imported = await result(runCli(home, ['import', legacy]));
    expect(imported.stderr).toBe('');
    expect(imported.exitCode).toBe(0);

    const db = restoredDb(home, 'oldbot');
    expect(db.query(`SELECT COUNT(*) AS n FROM messages`).get()).toEqual({ n: 301 });
    db.close();
  });

  test('a truncated archive leaves no workspace behind', async () => {
    const home = scratch('proteus-export-damaged-');
    const out = scratch('proteus-export-damaged-out-');
    writeFileSync(join(home, 'config.json'), JSON.stringify({ agents: {}, aliases: {} }));
    seedWorkspace(join(mkdirp(home, 'scout'), 'agent.db'));

    const archive = join(out, 'scout.proteus.jsonl');
    await result(runCli(home, ['export', 'scout', '-o', archive]));
    const lines = readFileSync(archive, 'utf8').split('\n').filter(Boolean);
    writeFileSync(archive, `${lines.slice(0, lines.length - 1).join('\n')}\n`);

    const imported = await result(runCli(home, ['import', archive, '--name', 'half']));
    expect(imported.exitCode).toBe(1);
    expect(imported.stderr).toContain('incomplete');
    expect(() => restoredDb(home, 'half')).toThrow();
  });
});

function mkdirp(home: string, name: string): string {
  const dir = join(home, name);
  mkdirSync(dir, { recursive: true });
  return dir;
}

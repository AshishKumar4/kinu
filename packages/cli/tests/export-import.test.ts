/**
 * `kinu export` / `kinu import` end to end, as a user runs them.
 *
 * The load-bearing claim is one format: a CLOUD workspace exported over the
 * paged RPC restores through the SAME `kinu import` a local export does,
 * with its content intact. Both directions run the real CLI binary against a
 * throwaway KINU_HOME — the cloud side against a stub origin that answers
 * the export RPC out of a real SQLite workspace.
 */

import { scratchDir } from '../../test-utils/src/scratch';
import { describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdirSync, readFileSync, writeFileSync, symlinkSync } from 'node:fs';

import { join, resolve } from 'node:path';
import { archiveSqlFromDatabase, initActorClaimTables, readWorkspaceArchivePage, type ArchiveCursor } from '@kinu.run/core';
import { JsonArraySchema, JsonObjectSchema, parseJsonObject } from '@kinu.run/core';
import { createInlineWorkspace } from '@kinu.run/core/identity';
import * as v from 'valibot';

const ArchiveCursorSchema: v.GenericSchema<ArchiveCursor> = v.variant('phase', [
  v.object({ phase: v.literal('sql'), table: v.string(), after: v.nullable(v.number()), rows: v.number() }),
  v.object({ phase: v.literal('files'), after: v.string(), rows: v.number(), files: v.number() }),
]);

const repoRoot = resolve(__dirname, '../../..');

const cliBin = join(repoRoot, 'packages/cli/bin/cli.ts');

function scratch(prefix: string): string {
  const dir = scratchDir(prefix);

  return dir;
}

const ACTOR = 'a1';

/** One conversation entry and the message text it references — the canonical
 *  pair, written straight to SQL because this suite is about what the archive
 *  copies, not about how a turn publishes. */
function seedEntry(db: Database, id: string, text: string, position: number): void {
  db.query(`INSERT INTO session_messages (actor_id, message_id, role, native_content_kind, origin, recorded_at)
    VALUES (?, ?, 'user', 'parts', 'input', ?)`).run(ACTOR, id, 100 + position);
  db.query(`INSERT INTO message_parts (actor_id, message_id, part_no, kind) VALUES (?, ?, 0, 'text')`).run(ACTOR, id);
  db.query(`INSERT INTO message_updates (actor_id, message_id, sequence, part_no, operation, payload_json)
    VALUES (?, ?, 0, 0, 'open', ?)`).run(ACTOR, id, JSON.stringify({ type: 'text', text }));
  db.query(`INSERT INTO conversation_entries (actor_id, session_id, id, parent_id, role, recorded_at)
    VALUES (?, 'default', ?, NULL, 'user', ?)`).run(ACTOR, id, 100 + position);
  db.query(`INSERT INTO conversation_entry_parts (actor_id, session_id, entry_id, position, message_id, part_no, through_sequence)
    VALUES (?, 'default', ?, 0, ?, 0, 0)`).run(ACTOR, id, id);
}

/** The text of one seeded entry, read back the way it was written. */
function entryText(db: Database, id: string): string {
  const row = db.query<{ payload_json: string }, [string]>(
    `SELECT payload_json FROM message_updates WHERE message_id = ?`,
  ).get(id);

  if (!row) throw new Error(`no message payload for ${id}`);

  return v.parse(v.string(), v.parse(JsonObjectSchema, JSON.parse(row.payload_json)).text);
}

/** A workspace database with the awkward content: text, BLOBs, many rows. */
function seedWorkspace(path: string): void {
  const db = new Database(path, { create: true });
  db.exec(`CREATE TABLE workspace_identity (id TEXT NOT NULL, name TEXT NOT NULL, created_at INTEGER NOT NULL)`);
  initActorClaimTables((ddl) => { db.exec(ddl); });
  db.exec(`CREATE TABLE vfs_files (path TEXT PRIMARY KEY, data BLOB)`);
  db.query(`INSERT INTO workspace_identity (id, name, created_at) VALUES (?, ?, ?)`).run('w1', 'scout', 100);

  for (let i = 0; i < 300; i++) seedEntry(db, `m${i}`, `note ${i} with "quotes"`, i);

  const bytes = new Uint8Array(256);

  for (let i = 0; i < bytes.length; i++) bytes[i] = i;
  db.query(`INSERT INTO vfs_files (path, data) VALUES (?, ?)`).run('logo.bin', bytes);
  // Multi-byte text long enough that the reader's 64 KiB chunks land mid-
  // character: a decoder that does not stream corrupts a real transcript here.
  seedEntry(db, 'unicode', '→ café 🌍 '.repeat(9000), 300);
  db.close();
}

function runCli(home: string, args: string[], env: Record<string, string> = {}) {
  return Bun.spawn([process.execPath, cliBin, ...args], {
    // The CLI records its cwd as the agent file plane, so a spawn must never sit in the developer repo.
    cwd: scratch('kinu-test-project-'),
    env: { ...process.env, KINU_HOME: home, NO_COLOR: '1', ...env },
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

function placedWorkspace() {
  const home = scratch('kinu-export-placed-');
  const project = scratch('kinu-export-project-');
  seedWorkspace(join(mkdirp(home, 'scout'), 'agent.db'));
  writeFileSync(join(home, 'config.json'), JSON.stringify({
    agents: { scout: {
      name: 'scout', mode: 'local', localName: 'scout', cwd: project, workspaceId: 'project',
      createdAt: '', updatedAt: '',
    } }, aliases: {},
  }));

  return { home, project };
}

describe('kinu export / import', () => {
  test('a placed local archive includes its real file plane and excludes its own output', async () => {
    const { home, project } = placedWorkspace();
    mkdirSync(join(project, 'docs'));
    mkdirSync(join(project, 'empty'));
    writeFileSync(join(project, 'docs', 'note.txt'), 'project bytes outside SQLite');
    const bytes = new Uint8Array([0, 255, 128, 10]);
    writeFileSync(join(project, 'bytes.bin'), bytes);
    const archive = join(project, 'backup.kinu.jsonl');
    const exported = await result(runCli(home, ['export', 'scout', '-o', archive]));
    expect(exported.exitCode).toBe(0);
    const records = readFileSync(archive, 'utf8').trim().split('\n').map(parseJsonObject);
    expect(records.filter((row) => row.t === 'file').map((row) => row.path))
      .toEqual(['bytes.bin', 'docs/note.txt']);
    expect(records.filter((row) => row.t === 'directory').map((row) => row.path)).toContain('empty');
    const imported = await result(runCli(home, ['import', archive, '--name', 'restored-files']));
    expect(imported.exitCode).toBe(0);
    const db = new Database(join(home, 'restored-files', 'agent.db'));

    try {
      const { vfs } = createInlineWorkspace(db);
      expect(await vfs.readFile('docs/note.txt', { encoding: 'utf8' })).toBe('project bytes outside SQLite');
      expect(await vfs.readFile('bytes.bin')).toEqual(bytes);
      expect(await vfs.exists('empty')).toBe(true);
    } finally {
      db.close();
    }
  });

  test('a local archive refuses unsupported symlinks instead of exporting their targets', async () => {
    const { home, project } = placedWorkspace();
    const outside = join(scratch('kinu-export-outside-'), 'outside.txt');
    writeFileSync(outside, 'not part of this workspace');
    symlinkSync(outside, join(project, 'link'));
    const archive = join(project, 'backup.kinu.jsonl');
    const exported = await result(runCli(home, ['export', 'scout', '-o', archive]));
    expect(exported.exitCode).not.toBe(0);
    expect(exported.stderr).toContain('cannot preserve symlink entry');
    expect(exported.stdout).not.toContain('Exported');
  });

  test('a local workspace round-trips through an archive', async () => {
    const home = scratch('kinu-export-local-');
    const out = scratch('kinu-export-out-');
    writeFileSync(join(home, 'config.json'), JSON.stringify({ agents: {}, aliases: {} }));
    seedWorkspace(join(mkdirp(home, 'scout'), 'agent.db'));

    const archive = join(out, 'scout.kinu.jsonl');
    const exported = await result(runCli(home, ['export', 'scout', '-o', archive]));
    expect(exported.stderr).toBe('');
    expect(exported.exitCode).toBe(0);
    expect(exported.stdout).toContain('Exported scout (local)');

    const imported = await result(runCli(home, ['import', archive, '--name', 'scout-restored']));
    expect(imported.stderr).toBe('');
    expect(imported.exitCode).toBe(0);
    expect(imported.stdout).toContain('Imported workspace scout-restored');

    const db = restoredDb(home, 'scout-restored');
    expect(db.query(`SELECT COUNT(*) AS n FROM conversation_entries`).get()).toEqual({ n: 301 });
    expect(db.query(`SELECT name FROM workspace_identity`).get()).toEqual({ name: 'scout' });
    expect(entryText(db, 'unicode')).toBe('→ café 🌍 '.repeat(9000));
    const blob = db.query<{ data: Uint8Array }, []>(`SELECT data FROM vfs_files WHERE path = 'logo.bin'`).get();

    if (!blob) throw new Error('restored logo missing');
    expect(Array.from(new Uint8Array(blob.data)).slice(0, 4)).toEqual([0, 1, 2, 3]);
    db.close();
  });

  test('a cloud workspace exports over the paged RPC and imports locally', async () => {
    const cloudDir = scratch('kinu-export-cloud-db-');
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

    const home = scratch('kinu-export-cloud-');
    const out = scratch('kinu-export-cloud-out-');
    writeFileSync(join(home, 'config.json'), JSON.stringify({
      origin: `http://127.0.0.1:${server.port}`,
      accessToken: 'ptc_stored_session',
      agents: {
        skywriter: { name: 'skywriter', mode: 'cloud', cloudName: 'skywriter', createdAt: '', updatedAt: '' },
      },
      aliases: {},
    }));

    try {
      const archive = join(out, 'skywriter.kinu.jsonl');

      const exported = await result(runCli(home, ['export', 'skywriter', '-o', archive], {
        KINU_ORIGIN: `http://127.0.0.1:${server.port}`,
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
      expect(db.query(`SELECT COUNT(*) AS n FROM conversation_entries`).get()).toEqual({ n: 301 });
      expect(entryText(db, 'm7')).toBe('note 7 with "quotes"');
      db.close();
    } finally {
      await server.stop(true);
    }
  });

  test('a bare workspace database file imports, not only an archive', async () => {
    const home = scratch('kinu-export-bare-db-');
    const out = scratch('kinu-export-bare-db-out-');
    writeFileSync(join(home, 'config.json'), JSON.stringify({ agents: {}, aliases: {} }));
    const bareDatabase = join(out, 'oldbot.agent.db');
    seedWorkspace(bareDatabase);

    const imported = await result(runCli(home, ['import', bareDatabase]));
    expect(imported.stderr).toBe('');
    expect(imported.exitCode).toBe(0);

    const db = restoredDb(home, 'oldbot');
    expect(db.query(`SELECT COUNT(*) AS n FROM conversation_entries`).get()).toEqual({ n: 301 });
    db.close();
  });

  test('a truncated archive leaves no workspace behind', async () => {
    const home = scratch('kinu-export-damaged-');
    const out = scratch('kinu-export-damaged-out-');
    writeFileSync(join(home, 'config.json'), JSON.stringify({ agents: {}, aliases: {} }));
    seedWorkspace(join(mkdirp(home, 'scout'), 'agent.db'));

    const archive = join(out, 'scout.kinu.jsonl');
    await result(runCli(home, ['export', 'scout', '-o', archive]));
    const lines = readFileSync(archive, 'utf8').split('\n').filter(Boolean);
    writeFileSync(archive, `${lines.slice(0, lines.length - 1).join('\n')}\n`);

    const imported = await result(runCli(home, ['import', archive, '--name', 'half']));
    expect(imported.exitCode).toBe(1);
    expect(imported.stderr).toContain('incomplete');
    expect(() => restoredDb(home, 'half')).toThrow('unable to open database file');
  });
});

function mkdirp(home: string, name: string): string {
  const dir = join(home, name);
  mkdirSync(dir, { recursive: true });

  return dir;
}

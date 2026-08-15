/**
 * `proteus export` / `proteus import` — the user-facing half of workspace
 * backup, for BOTH kinds of workspace.
 *
 * One format (see core `identity/archive.ts`): a local workspace and a cloud
 * one produce the same archive, and `import` restores either into a local
 * workspace. A cloud export walks the orchestrator's paged export RPC and
 * appends each page to the file, so neither side ever holds a
 * workspace-sized string.
 */

import {
  appendFileSync, closeSync, copyFileSync, existsSync, mkdirSync, openSync,
  readSync, renameSync, rmSync, statSync, writeFileSync,
} from 'node:fs';
import { basename } from 'node:path';
import { Database } from 'bun:sqlite';
import {
  WORKSPACE_ARCHIVE_EXTENSION,
  archiveSqlFromDatabase,
  decodeJsonValue,
  readWorkspaceArchivePage,
  restoreWorkspaceArchive,
  type ArchiveCursor,
  type ArchivePage,
} from '@proteus/core';
import { createInlineWorkspace } from '@proteus/core/identity';
import { agentDbPath, agentDir, ensureAgentHome, requireStoredAuthConfig } from '../config.js';
import { resolveAgentTarget } from '../agent-target.js';
import { callAgentRpc } from '../cloud-api.js';
import { formatBytes, printError, OK, ACCENT, DIM } from '../display.js';
import * as v from 'valibot';

interface RestoredArchiveCounts {
  rows: number;
  tables: number;
}

const ArchiveHeaderSchema = v.object({
  t: v.optional(v.string()),
  workspace: v.optional(v.string()),
});
const ArchiveCursorSchema: v.GenericSchema<ArchiveCursor> = v.variant('phase', [
  v.object({ phase: v.literal('sql'), table: v.string(), after: v.nullable(v.number()), rows: v.number() }),
  v.object({ phase: v.literal('files'), after: v.string(), rows: v.number(), files: v.number() }),
]);
const ArchivePageSchema: v.GenericSchema<ArchivePage> = v.object({
  lines: v.array(v.string()),
  next: v.nullable(ArchiveCursorSchema),
});

export async function exportCommand(name: string, opts: { output?: string }): Promise<void> {
  const target = resolveAgentTarget(name);
  const output = opts.output ?? `${target.name}${WORKSPACE_ARCHIVE_EXTENSION}`;
  const pages = target.mode === 'cloud'
    ? cloudArchivePages(target.cloudName)
    : localArchivePages(target.localName);

  writeFileSync(output, '');
  let lines = 0;
  for await (const page of pages) {
    appendFileSync(output, page.lines.map((line) => `${line}\n`).join(''));
    lines += page.lines.length;
    if (page.next && process.stdout.isTTY) {
      process.stdout.write(DIM(`\r  exporting ${target.name}… ${lines} records`));
    }
  }
  if (process.stdout.isTTY) process.stdout.write('\r\x1b[K');
  const size = statSync(output).size;
  console.log(
    `\n${OK('✓')} Exported ${ACCENT(target.name)} (${target.mode}) to ${DIM(output)}`
    + ` ${DIM(`— ${lines} records, ${formatBytes(size)}`)}\n`,
  );
}

export async function importCommand(file: string, opts: { name?: string }): Promise<void> {
  if (!existsSync(file)) {
    printError(`File not found: ${file}`);
    process.exit(1);
  }
  const legacy = isSqliteDatabaseFile(file);
  const name = opts.name ?? (legacy ? nameFromFilename(file) : archiveWorkspaceName(file) ?? nameFromFilename(file));
  ensureAgentHome();
  const dbPath = agentDbPath(name);
  if (existsSync(dbPath)) {
    printError(`Workspace "${name}" already exists.`, 'Use --name to choose a different name');
    process.exit(1);
  }
  mkdirSync(agentDir(name), { recursive: true });

  // Restore into a partial file and rename on success, so a damaged archive
  // never leaves a half-populated workspace behind under a real name.
  const partial = `${dbPath}.partial`;
  rmSync(partial, { force: true });
  let restored: RestoredArchiveCounts;
  try {
    if (legacy) {
      // A database file from a pre-archive `proteus export`. Copying it is
      // still the correct restore for those backups, and they are the kind of
      // file nobody gets to make again.
      copyFileSync(file, partial);
      restored = countRestored(partial);
    } else {
      const db = new Database(partial, { create: true });
      try {
        let files: ReturnType<typeof createInlineWorkspace>['vfs'] | null = null;
        const result = await restoreWorkspaceArchive(archiveSqlFromDatabase(db), readLines(file), {
          files: () => (files ??= createInlineWorkspace(db).vfs),
        });
        restored = { rows: result.rows, tables: result.tables };
      } finally {
        db.close();
      }
    }
  } catch (err) {
    rmSync(partial, { force: true });
    throw err;
  }
  renameSync(partial, dbPath);
  console.log(
    `\n${OK('✓')} Imported workspace ${ACCENT(name)} from ${DIM(file)}`
    + ` ${DIM(`— ${restored.tables} tables, ${restored.rows} records`)}\n`,
  );
}

async function* cloudArchivePages(name: string): AsyncGenerator<ArchivePage> {
  const auth = requireStoredAuthConfig();
  let cursor: ArchiveCursor | null = null;
  do {
    const page: ArchivePage = await callAgentRpc(
      auth.origin, auth.token, name, 'exportWorkspaceArchive', ArchivePageSchema,
      [cursor === null ? null : decodeJsonValue({ value: cursor })],
    );
    yield page;
    cursor = page.next;
  } while (cursor);
}

async function* localArchivePages(name: string): AsyncGenerator<ArchivePage> {
  const dbPath = agentDbPath(name);
  if (!existsSync(dbPath)) {
    throw new Error(`Workspace "${name}" not found.`);
  }
  const db = new Database(dbPath, { readonly: true });
  try {
    const sql = archiveSqlFromDatabase(db);
    let cursor: ArchiveCursor | null = null;
    do {
      const page = await readWorkspaceArchivePage(sql, { workspace: name, source: 'local', cursor });
      yield page;
      cursor = page.next;
    } while (cursor);
  } finally {
    db.close();
  }
}

/** Line-at-a-time read, so restoring a large archive never materializes it.
 *  The decoder streams: a multi-byte character straddling a chunk boundary is
 *  held until its remaining bytes arrive, never decoded into replacement
 *  characters halfway through a transcript. */
function* readLines(path: string): Generator<string> {
  const fd = openSync(path, 'r');
  try {
    const buffer = Buffer.allocUnsafe(64 * 1024);
    const decoder = new TextDecoder();
    let pending = '';
    const emit = function* (): Generator<string> {
      let cut = pending.indexOf('\n');
      while (cut >= 0) {
        yield pending.slice(0, cut);
        pending = pending.slice(cut + 1);
        cut = pending.indexOf('\n');
      }
    };
    for (;;) {
      const read = readSync(fd, buffer, 0, buffer.length, null);
      if (read === 0) break;
      pending += decoder.decode(buffer.subarray(0, read), { stream: true });
      yield* emit();
    }
    pending += decoder.decode();
    yield* emit();
    if (pending) yield pending;
  } finally {
    closeSync(fd);
  }
}

/** Every SQLite database starts with this 16-byte magic — how a backup made by
 *  the pre-archive `proteus export` is recognized. */
function isSqliteDatabaseFile(path: string): boolean {
  const fd = openSync(path, 'r');
  try {
    const header = Buffer.allocUnsafe(16);
    const read = readSync(fd, header, 0, 16, 0);
    return read === 16 && header.toString('latin1') === 'SQLite format 3\0';
  } finally {
    closeSync(fd);
  }
}

/** The workspace an archive came from — a better default name than the file's. */
function archiveWorkspaceName(path: string): string | null {
  for (const line of readLines(path)) {
    try {
      const header = v.parse(ArchiveHeaderSchema, JSON.parse(line));
      return header.t === 'header' ? header.workspace ?? null : null;
    } catch {
      return null;
    }
  }
  return null;
}

function nameFromFilename(file: string): string {
  return basename(file)
    .replace(new RegExp(`${WORKSPACE_ARCHIVE_EXTENSION.replace(/\./g, '\\.')}$`), '')
    .replace(/\.agent\.db$/, '')
    .replace(/\.db$/, '');
}

function countRestored(dbPath: string): RestoredArchiveCounts {
  const db = new Database(dbPath, { readonly: true });
  try {
    const tables = db.query<{ name: string }, []>(
      `SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'`,
    ).all();
    let rows = 0;
    for (const table of tables) {
      const row = db.query<{ n: number }, []>(`SELECT COUNT(*) AS n FROM "${table.name.replace(/"/g, '""')}"`).get();
      if (!row) throw new Error(`Could not count restored table ${table.name}`);
      rows += row.n;
    }
    return { rows, tables: tables.length };
  } finally {
    db.close();
  }
}

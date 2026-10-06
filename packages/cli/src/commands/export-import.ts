/** `kinu export` / `kinu import`: one archive format (core `identity/archive.ts`) for local and cloud workspaces. */

import {
  appendFileSync, closeSync, copyFileSync, existsSync, mkdirSync, openSync,
  readSync, renameSync, rmSync, statSync, writeFileSync,
} from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { Database } from 'bun:sqlite';
import {
  WORKSPACE_ARCHIVE_EXTENSION,
  archiveSqlFromDatabase,
  readWorkspaceArchivePage,
  restoreWorkspaceArchive,
  type ArchiveCursor,
  type ArchivePage,
} from '@kinu.run/core';
import { tolerate } from '@kinu.run/core/obs';
import {
  localArchiveSource, localArchiveTarget, moveIntoFolder, publishStoreFiles, requireSchemaGenesis, stampSchemaGenesis,
} from '@kinu.run/cli-backend';
import { createInlineWorkspace } from '@kinu.run/core/identity';
import { workspaceArchiveTarget } from '@kinu.run/core';
import {
  agentDbPath, agentDir, canonicalProjectRoot, defaultVirtualWorkspaceId, ensureAgentHome,
  placeLocalWorkspace, requireStoredAuthConfig, resolveAgentRef, resolveLocalAgent,
} from '../config';
import { resolveAgentTarget } from '../agent-target';
import { cloudArchivePage } from '../cloud-api';
import { formatBytes, printError, OK, ACCENT, DIM } from '../display';
import * as v from 'valibot';

interface RestoredArchiveCounts {
  rows: number;
  tables: number;
}

const ArchiveHeaderSchema = v.object({
  t: v.optional(v.string()),
  workspace: v.optional(v.string()),
});

export async function exportCommand(name: string, opts: { output?: string }): Promise<void> {
  const target = resolveAgentTarget(name);
  const output = opts.output ?? `${target.name}${WORKSPACE_ARCHIVE_EXTENSION}`;

  const pages = target.mode === 'cloud'
    ? cloudArchivePages(target.cloudName)
    : localArchivePages(target.requestedName, output);

  writeFileSync(output, '');
  let lines = 0;

  for await (const page of pages) {
    if (page === 'snapshot-ended') {
      writeFileSync(output, '');
      lines = 0;
      continue;
    }

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
    + ` ${DIM(`(${lines} records, ${formatBytes(size)})`)}\n`,
  );
}

export async function importCommand(file: string, opts: { name?: string }): Promise<void> {
  if (!existsSync(file)) {
    printError(`File not found: ${file}`);
    process.exit(1);
  }

  const bareDatabase = isSqliteDatabaseFile(file);
  const name = opts.name ?? (bareDatabase ? nameFromFilename(file) : archiveWorkspaceName(file) ?? nameFromFilename(file));
  ensureAgentHome();
  const dbPath = agentDbPath(name);

  if (existsSync(agentDir(name))) {
    printError(`Workspace "${name}" already exists.`, 'Use --name to choose a different name');
    process.exit(1);
  }

  // One config key holds one ref: a name a cloud workspace answers to cannot also name this copy.
  if (resolveAgentRef(name)?.mode === 'cloud') {
    printError(`"${name}" already names a cloud workspace here.`, 'Use --name to choose a different name');
    process.exit(1);
  }

  // Like `kinu create`, the copy works in the folder it was restored from.
  const cwd = canonicalProjectRoot();

  // Restored beside the workspace and moved into place whole, so a damaged archive or a refused folder leaves nothing.
  const staging = { space: join(dirname(agentDir(name)), `.importing-${name}`), folder: join(dirname(agentDir(name)), `.importing-${name}-folder`) };
  const stagedDb = join(staging.space, basename(dbPath));

  const discard = (): void => {
    for (const path of [staging.space, staging.folder]) rmSync(path, { recursive: true, force: true });
  };

  discard();
  mkdirSync(staging.space, { recursive: true });
  let restored: RestoredArchiveCounts;

  try {
    // A bare SQLite database, not an archive: copying the file is the restore.
    if (bareDatabase) copyFileSync(file, stagedDb);
    const db = new Database(stagedDb, { create: true });

    try {
      const files = localArchiveTarget(staging);
      let store: ReturnType<typeof createInlineWorkspace> | null = null;
      const opened = () => (store ??= createInlineWorkspace(db));

      if (bareDatabase) {
        restored = countRestored(db, file);
      } else {
        const result = await restoreWorkspaceArchive(archiveSqlFromDatabase(db), readLines(file), {
          files: () => files, store: () => workspaceArchiveTarget(opened()),
        });

        restored = { rows: result.rows, tables: result.tables };
        stampSchemaGenesis(db);
      }

      // Locally every file is a real one: a cloud archive's own-space files, agent state too, land with a local archive's.
      await publishStoreFiles(opened().vfs, files);
    } finally {
      db.close();
    }

    moveIntoFolder(staging.folder, cwd);
    renameSync(staging.space, agentDir(name));
  } catch (err) {
    discard();
    throw err;
  }

  console.log(
    `\n${OK('✓')} Imported workspace ${ACCENT(name)} from ${DIM(file)}`
    + ` ${DIM(`(${restored.tables} tables, ${restored.rows} records)`)}`,
  );

  const workspaceId = defaultVirtualWorkspaceId(cwd);
  await placeLocalWorkspace({ name, cwd, workspaceId });
  console.log(`  ${DIM('workspace:')} ${workspaceId} ${DIM('in')} ${cwd}\n`);
}

async function* cloudArchivePages(name: string): AsyncGenerator<ArchivePage | 'snapshot-ended'> {
  const auth = requireStoredAuthConfig();
  let cursor: ArchiveCursor | null = null;

  for (;;) {
    const page = await cloudArchivePage(auth.origin, auth.token, name, cursor);

    yield page;

    if (page === 'snapshot-ended') cursor = null;
    else if (page.next === null) return;
    else cursor = page.next;
  }
}

async function* localArchivePages(name: string, output: string): AsyncGenerator<ArchivePage> {
  const local = resolveLocalAgent(name);
  const files = localArchiveSource({ space: dirname(local.dbPath), folder: local.cwd }, resolve(output));

  const db = new Database(local.dbPath, { readonly: true });

  try {
    requireSchemaGenesis(db, local.name);
    const sql = archiveSqlFromDatabase(db);
    let cursor: ArchiveCursor | null = null;

    do {
      const page = await readWorkspaceArchivePage(sql, { workspace: local.name, source: 'local', cursor, files });
      yield page;
      cursor = page.next;
    } while (cursor);
  } finally {
    db.close();
  }
}

/** Streams line by line; the decoder holds a multi-byte character split across chunks. */
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

/** SQLite's 16-byte magic; recognizes backups from the pre-archive `kinu export`. */
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

/** Null when the first line is not an archive header: a domain answer, not a failure. */
function archiveWorkspaceName(path: string): string | null {
  for (const line of readLines(path)) {
    const value: unknown = tolerate(() => JSON.parse(line), 'malformed-input');

    if (value === undefined) return null;
    const parsed = v.safeParse(ArchiveHeaderSchema, value);

    if (!parsed.success || parsed.output.t !== 'header') return null;

    return parsed.output.workspace ?? null;
  }

  return null;
}

function nameFromFilename(file: string): string {
  return basename(file)
    .replace(new RegExp(`${WORKSPACE_ARCHIVE_EXTENSION.replace(/\./g, '\\.')}$`), '')
    .replace(/\.agent\.db$/, '')
    .replace(/\.db$/, '');
}

function countRestored(db: Database, source: string): RestoredArchiveCounts {
  requireSchemaGenesis(db, source);

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
}

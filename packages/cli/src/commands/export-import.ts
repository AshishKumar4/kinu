import { existsSync, copyFileSync, mkdirSync } from 'node:fs';
import { Database } from 'bun:sqlite';
import { agentDbPath, agentDir, ensureAgentHome } from '../config.js';
import { printError, OK, ACCENT, DIM } from '../display.js';

export async function exportCommand(name: string, opts: { output?: string }): Promise<void> {
  const dbPath = agentDbPath(name);
  if (!existsSync(dbPath)) {
    printError(`Agent "${name}" not found.`);
    process.exit(1);
  }
  const output = opts.output ?? `${name}.agent.db`;

  // Flush WAL to main file before copying for a self-contained export
  const db = new Database(dbPath);
  db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  db.close();

  copyFileSync(dbPath, output);
  console.log(`\n${OK('✓')} Exported ${ACCENT(name)} to ${DIM(output)}\n`);
}

export async function importCommand(file: string, opts: { name?: string }): Promise<void> {
  if (!existsSync(file)) {
    printError(`File not found: ${file}`);
    process.exit(1);
  }
  const name = opts.name ?? file.replace(/\.agent\.db$/, '').replace(/\.db$/, '').split('/').pop()!;
  ensureAgentHome();
  const dir = agentDir(name);
  const dbPath = agentDbPath(name);
  if (existsSync(dbPath)) {
    printError(`Agent "${name}" already exists.`, 'Use --name to choose a different name');
    process.exit(1);
  }
  mkdirSync(dir, { recursive: true });
  copyFileSync(file, dbPath);
  console.log(`\n${OK('✓')} Imported agent ${ACCENT(name)} from ${DIM(file)}\n`);
}

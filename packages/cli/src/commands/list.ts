import { statSync } from 'node:fs';
import { Database } from 'bun:sqlite';
import { listAgentDirs, agentDbPath } from '../config.js';
import { printAgentList } from '../display.js';

export async function listCommand(): Promise<void> {
  const agents = listAgentDirs();

  const agentInfos = agents.map(name => {
    const dbPath = agentDbPath(name);
    try {
      const db = new Database(dbPath, { readonly: true });
      const purpose = (db.query('SELECT purpose FROM agent_soul LIMIT 1').get() as { purpose: string } | null)?.purpose ?? '';
      const version = (db.query('SELECT COALESCE(MAX(version), 0) as v FROM scaffold_versions').get() as { v: number })?.v ?? 0;
      const toolCount = (db.query('SELECT COUNT(*) as c FROM crafted_tools').get() as { c: number })?.c ?? 0;
      db.close();
      const dbSize = statSync(dbPath).size;
      return { name, purpose, scaffoldVersion: version, toolCount, dbSize };
    } catch {
      return { name, purpose: '(error reading)', scaffoldVersion: 0, toolCount: 0 };
    }
  });

  printAgentList(agentInfos);
}

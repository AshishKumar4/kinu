import { statSync } from 'node:fs';
import { Database } from 'bun:sqlite';
import { readSoul, summarizeSoul } from '@proteus/core';
import { makeSql } from '@proteus/cli-backend';
import { loadConfigFile, listAgentDirs, agentDbPath } from '../config.js';
import { printAgentList } from '../display.js';

export async function listCommand(): Promise<void> {
  const agents = listAgentDirs();
  const registry = loadConfigFile().agents ?? {};
  const registryOnly = Object.values(registry).filter(a => a.mode === 'cloud' || !agents.includes(a.localName ?? a.name));

  const agentInfos = agents.map(name => {
    const dbPath = agentDbPath(name);
    try {
      const db = new Database(dbPath, { readonly: true });
      const purpose = summarizeSoul(readSoul(makeSql(db)));
      const version = (db.query('SELECT COALESCE(MAX(version), 0) as v FROM scaffold_versions').get() as { v: number })?.v ?? 0;
      const toolCount = (db.query('SELECT COUNT(*) as c FROM crafted_tools').get() as { c: number })?.c ?? 0;
      db.close();
      const dbSize = statSync(dbPath).size;
      return { name, purpose, scaffoldVersion: version, toolCount, dbSize };
    } catch {
      return { name, purpose: '(error reading)', scaffoldVersion: 0, toolCount: 0 };
    }
  });

  for (const agent of registryOnly) {
    agentInfos.push({
      name: agent.alias ? `${agent.name} (${agent.alias})` : agent.name,
      purpose: `${agent.mode} workspace`,
      scaffoldVersion: 0,
      toolCount: 0,
      dbSize: undefined,
    });
  }

  printAgentList(agentInfos);
}

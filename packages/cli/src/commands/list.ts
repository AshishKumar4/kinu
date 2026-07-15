import { statSync } from 'node:fs';
import { Database } from 'bun:sqlite';
import { readSoul, summarizeSoul } from '@proteus/core';
import { makeSql } from '@proteus/cli-backend';
import { listCloudAgents } from '../cloud-api.js';
import { reconcileAgentRefs } from '../agent-list.js';
import { agentDbPath, listAgentDirs, loadConfigFile, resolveCloudSession } from '../config.js';
import { printAgentList } from '../display.js';

export async function listCommand(): Promise<void> {
  const localAgents = listAgentDirs();
  const configuredAgents = Object.values(loadConfigFile().agents ?? {});
  const cloudSession = resolveCloudSession();
  const cloudAgents = cloudSession
    ? await listCloudAgents(cloudSession.origin, cloudSession.token)
    : [];
  const agents = reconcileAgentRefs(localAgents, configuredAgents, cloudAgents);

  const agentInfos = agents.map((agent) => {
    if (agent.mode === 'cloud') {
      return {
        name: agent.name,
        mode: agent.mode,
        purpose: agent.label,
        scaffoldVersion: 0,
        toolCount: 0,
        dbSize: undefined,
      };
    }

    const name = agent.localName ?? agent.name;
    const dbPath = agentDbPath(name);
    try {
      const db = new Database(dbPath, { readonly: true });
      const purpose = summarizeSoul(readSoul(makeSql(db)));
      const version = (db.query('SELECT COALESCE(MAX(version), 0) as v FROM scaffold_versions').get() as { v: number })?.v ?? 0;
      const toolCount = (db.query('SELECT COUNT(*) as c FROM crafted_tools').get() as { c: number })?.c ?? 0;
      db.close();
      const dbSize = statSync(dbPath).size;
      return { name, mode: agent.mode, purpose, scaffoldVersion: version, toolCount, dbSize };
    } catch {
      return { name, mode: agent.mode, purpose: '(error reading)', scaffoldVersion: 0, toolCount: 0 };
    }
  });

  printAgentList(agentInfos);
}

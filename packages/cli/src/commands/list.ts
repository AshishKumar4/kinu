import { statSync } from 'node:fs';
import { diagnostics, renderThrownChain, toKinuError } from '@kinu.run/core/obs';
import { Result } from 'effect';
import { listCloudAgents } from '../cloud-api';
import { listLocalAgentNames, reconcileAgentRefs } from '../agent-list';
import { agentDbPath, loadConfigFile, resolveCloudSession } from '../config';
import { printAgentList } from '../display';
import { getLocalAgentInfo } from '../local-inspection';

/** Undefined when no file exists; any other stat error throws rather than report "size unknown". */
function databaseSize(name: string): number | undefined {
  return statSync(agentDbPath(name), { throwIfNoEntry: false })?.size;
}

export async function listCommand(): Promise<void> {
  // This project's agents.
  const localAgents = listLocalAgentNames();
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
        dbSize: undefined,
      };
    }

    const name = agent.localName;

    if (agent.readError !== undefined) {
      return {
        name,
        mode: agent.mode,
        purpose: agent.label,
        scaffoldVersion: 0,
        dbSize: databaseSize(name),
      };
    }

    // getLocalAgentInfo degrades per field, so only an unopenable database fails the read.
    const read = Result.try({
      try: () => getLocalAgentInfo(name),
      catch: (cause) => toKinuError({ doing: 'reading a local workspace', cause, otherwise: 'io' }),
    });

    if (Result.isSuccess(read)) {
      return {
        name,
        mode: agent.mode,
        purpose: read.success.purpose,
        scaffoldVersion: read.success.scaffoldVersion,
        dbSize: databaseSize(name),
      };
    }

    // One unopenable workspace must not hide the rest; the reason travels with the row.
    const reason = renderThrownChain({ cause: read.failure.cause });
    diagnostics.failure('workspace.read_failed', read.failure, { workspace: name });

    return { name, mode: agent.mode, purpose: `(unreadable: ${reason})`, scaffoldVersion: 0 };
  });

  printAgentList(agentInfos);
}

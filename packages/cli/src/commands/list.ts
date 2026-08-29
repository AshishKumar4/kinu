import { statSync } from 'node:fs';
import { diagnostics, renderThrownChain, toKinuError } from '@kinu.run/core/obs';
import { listCloudAgents } from '../cloud-api';
import { reconcileAgentRefs } from '../agent-list';
import { agentDbPath, listAgentDirs, listLegacyAgentNames, loadConfigFile, resolveCloudSession } from '../config';
import { printAgentList } from '../display';
import { getLocalAgentInfo } from '../local-inspection';

/** The workspace database's size, or undefined when there is no file there.
 *  Asked rather than caught: `throwIfNoEntry: false` makes absence a value, so
 *  a listing does not need a handler that cannot tell a missing file from an
 *  unreadable one. Anything else — a permission error, a broken mount — still
 *  throws, because a row reporting "size unknown" for that would be a listing
 *  that lies quietly. */
function databaseSize(name: string): number | undefined {
  return statSync(agentDbPath(name), { throwIfNoEntry: false })?.size;
}

export async function listCommand(): Promise<void> {
  // This project's agents, then the ones no project claims yet, so listing
  // stays machine-wide while grouping stays honest about placement.
  const localAgents = [...listAgentDirs(), ...listLegacyAgentNames()];
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
    if (agent.readError !== undefined) {
      return {
        name,
        mode: agent.mode,
        purpose: agent.label,
        scaffoldVersion: 0,
        toolCount: 0,
        dbSize: databaseSize(name),
      };
    }
    try {
      // getLocalAgentInfo degrades field by field (a workspace predating a
      // table still reports everything else), so only an unopenable database
      // reaches the catch.
      const info = getLocalAgentInfo(name);
      return {
        name,
        mode: agent.mode,
        purpose: info.purpose,
        scaffoldVersion: info.scaffoldVersion,
        toolCount: info.craftedToolCount,
        dbSize: databaseSize(name),
      };
    } catch (caught) {
      // Handled, and said so: one unopenable workspace must not hide the other
      // nine, but a bare `catch {}` here is how three of the owner's real
      // workspaces read `(error reading)` for months while the actual cause was
      // `no such column: mission`. The reason travels with the row.
      const reason = renderThrownChain({ cause: caught });
      diagnostics.failure(
        'workspace.read_failed',
        toKinuError({ doing: 'reading a local workspace', cause: caught, otherwise: 'io' }),
        { workspace: name },
      );
      return { name, mode: agent.mode, purpose: `(unreadable: ${reason})`, scaffoldVersion: 0, toolCount: 0 };
    }
  });

  printAgentList(agentInfos);
}

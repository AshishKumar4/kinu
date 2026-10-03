import { statSync } from 'node:fs';
import { Cause, Effect } from 'effect';
import { diagnostics, renderThrownChain, settle, toKinuError } from '@kinu.run/core/obs';
import { listCloudAgents } from '../cloud-api';
import { listLocalAgentNames, reconcileAgentRefs } from '../agent-list';
import { agentDbPath, loadConfigFile, resolveCloudSession } from '../config';
import { printAgentList } from '../display';
import { getLocalAgentInfo } from '../local-inspection';

/** Undefined when no file exists; any other stat error throws rather than report "size unknown". */
function databaseSize(name: string): number | undefined {
  return statSync(agentDbPath(name), { throwIfNoEntry: false })?.size;
}

export function listCommand(): Promise<void> {
  return settle(Effect.gen(function* () {
    // This project's agents, then the ones no project claims.
    const localAgents = listLocalAgentNames();
    const configuredAgents = Object.values(loadConfigFile().agents ?? {});
    const cloudSession = resolveCloudSession();

    const cloudAgents = cloudSession
      ? yield* Effect.promise(() => listCloudAgents(cloudSession.origin, cloudSession.token))
      : [];

    const agents = reconcileAgentRefs(localAgents, configuredAgents, cloudAgents);

    const agentInfos = yield* Effect.forEach(agents, (agent) => {
      if (agent.mode === 'cloud') {
        return Effect.succeed({
          name: agent.name,
          mode: agent.mode,
          purpose: agent.label,
          scaffoldVersion: 0,
          dbSize: undefined,
        });
      }

      const name = agent.localName ?? agent.name;

      if (agent.readError !== undefined) {
        return Effect.succeed({
          name,
          mode: agent.mode,
          purpose: agent.label,
          scaffoldVersion: 0,
          dbSize: databaseSize(name),
        });
      }

      return Effect.catchCause(Effect.sync(() => {
        // getLocalAgentInfo degrades per field, so only an unopenable database reaches the catch.
        const info = getLocalAgentInfo(name);

        return {
          name,
          mode: agent.mode,
          purpose: info.purpose,
          scaffoldVersion: info.scaffoldVersion,
          dbSize: databaseSize(name),
        };
      }), (failed) => Effect.sync(() => {
        // One unopenable workspace must not hide the rest; the reason travels with the row.
        const caught = Cause.squash(failed);
        const reason = renderThrownChain({ cause: caught });
        diagnostics.failure(
          'workspace.read_failed',
          toKinuError({ doing: 'reading a local workspace', cause: caught, otherwise: 'io' }),
          { workspace: name },
        );

        return { name, mode: agent.mode, purpose: `(unreadable: ${reason})`, scaffoldVersion: 0 };
      }));
    });

    printAgentList(agentInfos);
  }));
}

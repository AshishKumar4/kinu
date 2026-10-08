// A service that does not come back on a wake reaches the agent through the one channel it has, the
// incident inbox, and through nothing else (devbox D67). The path is the agent's own: its commands go
// through the sandbox executor and adaptCloudflareSandbox to a real Devbox (on the devbox package's
// container harness), and the box's incidents go through the restatement KinuDevbox makes to a real
// workspace's `acceptSandboxLifecycleIncident`, whose inbox turns are counted.
import { describe, expect, test } from 'bun:test';
import { Effect } from 'effect';
import { CHAT_SESSION_ID, PROGRAMMATIC_MESSAGE_ID_PREFIX, createSandboxExecutor } from '@kinu.run/core';
import type { DevboxIncident, IncidentDisposition } from '@kinu.run/devbox';
import type { KinuDevbox } from '../src/kinu-devbox';
import { adaptCloudflareSandbox } from '../src/sandbox-exec-lane';
import { lifecycleIncident } from '../src/sandbox-lifecycle';
import { chatSessionTurns, historyOver, orchestratorHarness, unstartedOrchestratorHarness, type ActorHarness, type HarnessOrchestratorAgent } from './helpers/actor-harness';
// Relative paths: the devbox package's container harness and its disk chain's contract.
import type { DiskChain, DiskChainPorts } from '../../devbox/src/disk-chain';
import type { StoredValue } from '../../devbox/src/storage';
import { ChainTestBox, chainBox } from '../../devbox/tests/support/chain-box';
import type { FakeSandbox, StartFault } from '../../devbox/tests/support/devbox-harness';
import { SandboxFailure } from '../../devbox/tests/support/devbox-harness';
import { processResult } from '../../devbox/tests/support/native-process';

type Workspace = ActorHarness<HarnessOrchestratorAgent>;

/** The workspace and the container the box under test reports to; set per test. */
let workspace: Workspace | undefined;

let disk: FakeSandbox | undefined;

/** The workspace files a commit saved, restored by an image start: the chain the box would recover. */
let saved = new Map<string, string>();

function filesChain(ports: DiskChainPorts): DiskChain {
  return {
    attach: (fromSnapshot) => Effect.promise(async () => {
      if (fromSnapshot) return { kind: 'attached', detail: 'disk', recoveredTo: undefined };
      const state = await ports.readState();

      if (state === null) return { kind: 'empty', detail: 'no record', recoveredTo: undefined };

      for (const [path, content] of saved) disk?.files.set(path, content);

      return { kind: 'attached', detail: 'lazy', recoveredTo: state.committedAt };
    }),
    commit: () => Effect.promise(async () => {
      const state = await ports.readState();
      const at = ports.now();
      saved = new Map([...disk?.files ?? []].filter(([path]) => path.startsWith('/workspace/')));
      await ports.writeState({ format: 'disk-chain/2', rev: (state?.rev ?? 0) + 1, base: { key: 'base', bytes: 1, committedAt: at }, deltas: [], committedAt: at }, state?.rev ?? null);

      return { kind: 'committed', reason: undefined, bytes: 1, movedBytes: 1 };
    }),
  };
}

class RepairBox extends ChainTestBox {
  protected override diskChain(ports: DiskChainPorts): DiskChain {
    return filesChain(ports);
  }

  protected override get snapshotWakeCutoverMs(): number {
    return 50;
  }

  // What KinuDevbox does with an incident, minus the lookup of its workspace.
  protected override async onIncident(incident: DevboxIncident, attempt: number): Promise<IncidentDisposition> {
    if (workspace === undefined) return 'rejected';

    return (await workspace.agent.acceptSandboxLifecycleIncident(lifecycleIncident(incident, attempt))).status;
  }
}

/** A start the container refuses having created nothing. */
const refused = (code: string): StartFault => ({ error: new SandboxFailure({ code, message: `the container reported ${code}` }), created: false });

/** The agent's inbox turns, as the workspace's conversation stores them, once its queue drains. */
async function inboxTurns(): Promise<string[]> {
  if (workspace === undefined) return [];
  await chatSessionTurns(workspace.agent).drainEnqueued();
  const stored = await historyOver(workspace).transcript(CHAT_SESSION_ID).history();

  return stored
    .filter((message) => message.role === 'user' && message.id.startsWith(PROGRAMMATIC_MESSAGE_ID_PREFIX))
    .map((message) => message.parts.flatMap((part) => part.type === 'text' ? [part.text] : []).join(''));
}

/** A box running service `p1`, with two files the agent wrote, rested: committed, snapshotted, stopped. */
async function restedWithService() {
  workspace = orchestratorHarness();
  saved = new Map();

  const made = chainBox(RepairBox);
  disk = made.container;
  made.rows.set('devbox:proc:p1', { processId: 'p1', command: 'bun run server.ts', cwd: '/workspace', createdAt: 1 });
  // KinuDevbox is a DO class a test cannot construct; the box under test serves each member the agent's
  // commands and files reach, called on the box itself, whose private state a derived object would lack.
  const { box } = made;

  const sdk: KinuDevbox = Object.create({
    resolveReadiness: () => box.resolveReadiness(),
    execUntimed: (...args: Parameters<RepairBox['execUntimed']>) => box.execUntimed(...args),
    execUntimedStream: (...args: Parameters<RepairBox['execUntimedStream']>) => box.execUntimedStream(...args),
    killUntimed: (...args: Parameters<RepairBox['killUntimed']>) => box.killUntimed(...args),
    readFile: (...args: Parameters<RepairBox['readFile']>) => box.readFile(...args),
    writeFile: (...args: Parameters<RepairBox['writeFile']>) => box.writeFile(...args),
  });

  const agent = createSandboxExecutor(adaptCloudflareSandbox(sdk, async () => {}, null));
  await agent.tools.writeFile?.execute('/workspace/app.ts', 'export const port = 3000;\n');
  await agent.tools.writeFile?.execute('/workspace/notes.md', 'the server is p1\n');
  await made.box.quiesce();

  return { ...made, agent };
}

/** Each command the agent's exec reaches the container with, and the restoration row it ran under. */
function watchCommands(container: FakeSandbox, rows: Map<string, StoredValue>): { command: string; restoration: StoredValue }[] {
  const seen: { command: string; restoration: StoredValue }[] = [];

  container.nativeExec = async (args) => {
    seen.push({ command: String(args.at(-1)), restoration: rows.get('devbox:restoration') });

    return processResult(Promise.resolve({ stdout: `ran ${String(args.at(-1))}\n`, stderr: '', exitCode: 0 }), 4242);
  };

  return seen;
}

describe('a service that does not come back on a wake', () => {
  for (const wake of ['from its snapshot', 'with its snapshot lost'] as const) {
    test(`${wake}: the agent's command runs only once the gate settled, its files are exact, and one inbox notice names the service`, async () => {
      const { box, container, rows, agent } = await restedWithService();

      if (wake === 'with its snapshot lost') container.snapshots.clear();
      container.startFaults.push(refused('PROCESS_ERROR'));
      const commands = watchCommands(container, rows);

      // The agent's first command is what wakes the box.
      const answer = await agent.tools.exec?.execute('cat app.ts');
      const files = [await agent.tools.readFile?.execute('/workspace/app.ts'), await agent.tools.readFile?.execute('/workspace/notes.md')];
      await box.devboxIncidents();
      // A second delivery pass finds nothing left to tell.
      await box.devboxIncidents();
      const turns = await inboxTurns();
      const service = turns.filter(turn => turn.includes('(process p1)'));
      // A recovery is told too, as what it is: the workspace came back, from its backup.
      const recovery = turns.filter(turn => turn.includes('restored from its backup'));

      expect({
        answer, commands, files, service: service.length, cause: service[0]?.includes('PROCESS_ERROR'), others: turns.length - service.length - recovery.length,
        recovery: recovery.map(turn => ({ failed: turn.includes('container failed'), refused: turn.includes('tools are refused'), rebuild: turn.includes('node_modules') })),
      }).toEqual({
        answer: 'ran cat app.ts\n', commands: [{ command: 'cat app.ts', restoration: { phase: 'repair', incomplete: 'process p1 did not restart; no port was exposed' } }],
        files: ['export const port = 3000;\n', 'the server is p1\n'], service: 1, cause: true, others: 0,
        recovery: wake === 'from its snapshot' ? [] : [{ failed: false, refused: false, rebuild: true }],
      });
    });
  }
});

// Staging beaf28a46, 2026-10-08: six boxes of deleted eval workspaces re-offered one incident every five minutes for
// hours, because the gone workspace threw on it and a throw is `undelivered`.
describe('an incident for a workspace that no longer exists', () => {
  test('is refused, so its box stops offering it', async () => {
    const gone = unstartedOrchestratorHarness({ workspace: 'deleted-eval' });

    const answer = await gone.agent.acceptSandboxLifecycleIncident(lifecycleIncident({
      incidentId: 'incident-1', stage: 'process', reason: 'the container stopped', processId: 'p1', port: undefined, at: 1,
    }, 1));

    expect(answer.status).toBe('rejected');
  });
});

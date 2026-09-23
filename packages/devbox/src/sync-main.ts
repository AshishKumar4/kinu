/** The image's `sync.js` (D30): `run` ticks in the background; `flush` is a stop's final
 *  checkpoint. Logs go to stderr, which the box's commands route to the container's stdout. */
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { snapshotChainStorage } from './snapshot-chain';
import { DEVBOX_RUNTIME_DIR, type CheckpointKind, type CheckpointOutcome } from './storage';
import {
  BOOT_ID_PATH, DEVBOX_SYNC_HOST, DEVBOX_SYNC_PROGRAM, SYNC_PID_PATH, SYNC_SOCKET_PATH,
  containerChainPorts, decodeSyncConfig, parseCheckpointKind, parseSyncOutcome, runSyncLoop, syncCaller, syncWorker,
  type SyncConfig, type SyncLoop, type SyncWorker,
} from './sync';

const log = (line: string): void => {
  process.stderr.write(`${line}\n`);
};

const exec = async (command: string): Promise<{ stdout: string; stderr: string; exitCode: number }> => {
  const child = Bun.spawn(['bash', '-c', command], { cwd: DEVBOX_RUNTIME_DIR, stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' });
  const [stdout, stderr, exitCode] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);

  return { stdout, stderr, exitCode };
};

const generation = async (): Promise<string | undefined> => {
  if (!existsSync(BOOT_ID_PATH)) return undefined;

  return readFileSync(BOOT_ID_PATH, 'utf8').trim() || undefined;
};

const transport = async (body: string): Promise<{ status: number; text: string }> => {
  const reply = await fetch(`http://${DEVBOX_SYNC_HOST}/v1/sync`, { method: 'POST', body, headers: { 'content-type': 'application/json' } });

  return { status: reply.status, text: await reply.text() };
};

function syncing(config: SyncConfig): SyncWorker {
  return syncWorker(snapshotChainStorage(containerChainPorts(config, { exec, call: syncCaller(transport, generation), generation, log })));
}

function runningProgram(): boolean {
  if (!existsSync(SYNC_PID_PATH)) return false;
  const cmdline = `/proc/${readFileSync(SYNC_PID_PATH, 'utf8').trim()}/cmdline`;

  return existsSync(cmdline) && readFileSync(cmdline, 'utf8').includes(DEVBOX_SYNC_PROGRAM);
}

/** An unreachable running program is a failed flush, never a second writer beside it. */
async function flushThroughProgram(kind: CheckpointKind): Promise<CheckpointOutcome | undefined> {
  if (!runningProgram()) return undefined;

  // No client timeout: a final checkpoint may take minutes.
  const init = { method: 'POST', unix: SYNC_SOCKET_PATH, timeout: false };

  try {
    const reply = await fetch(`http://sync/flush?kind=${kind}`, init);

    return parseSyncOutcome(await reply.text(), '', reply.ok ? 0 : reply.status);
  } catch (error) {
    return { kind: 'failed', reason: `the running sync did not answer the flush: ${String(error)}`, bytes: undefined, movedBytes: undefined };
  }
}

/** SIGTERM cuts short the wait between ticks, never a tick. */
function termination(): Pick<SyncLoop, 'sleep' | 'stopped'> {
  let stopped = false;
  let wake = (): void => undefined;

  process.on('SIGTERM', () => {
    stopped = true;
    wake();
  });

  return {
    stopped: () => stopped,
    sleep: async (ms) => {
      if (stopped) return;

      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, ms);

        wake = () => {
          clearTimeout(timer);
          resolve();
        };
      });
    },
  };
}

async function run(config: SyncConfig): Promise<void> {
  const worker = syncing(config);
  const term = termination();
  writeFileSync(SYNC_PID_PATH, String(process.pid));
  rmSync(SYNC_SOCKET_PATH, { force: true });

  const server = Bun.serve({
    unix: SYNC_SOCKET_PATH,
    fetch: async (request, served) => {
      // Bun closes a connection idle for 10 s by default.
      served.timeout(request, 0);

      return Response.json(await worker.run(parseCheckpointKind(new URL(request.url).searchParams.get('kind'))));
    },
  });

  log(JSON.stringify({ event: 'devbox.sync.start', pid: process.pid, periodMs: config.periodMs }));
  await runSyncLoop(worker.run, { periodMs: config.periodMs, sleep: term.sleep, log, stopped: term.stopped });
  // A publication cut short would leave its upload behind.
  await worker.drained();
  await server.stop();
  rmSync(SYNC_PID_PATH, { force: true });
  log(JSON.stringify({ event: 'devbox.sync.exit', reason: 'the box stopped it' }));
}

async function main(argv: readonly string[]): Promise<number> {
  const config = decodeSyncConfig(process.env.DEVBOX_SYNC_CONFIG);

  if (argv[0] === 'run') {
    await run(config);
    // The stop waits for this exit; an idle keep-alive connection must not hold it.
    process.exit(0);
  }

  if (argv[0] === 'flush') {
    const kind = parseCheckpointKind(argv[1]);
    const outcome = (await flushThroughProgram(kind)) ?? (await syncing(config).run(kind));
    process.stdout.write(`${JSON.stringify(outcome)}\n`);

    return 0;
  }

  process.stderr.write(`usage: bun ${DEVBOX_SYNC_PROGRAM} run | flush <tick|quiesce>\n`);

  return 2;
}

if (import.meta.main) process.exitCode = await main(process.argv.slice(2));

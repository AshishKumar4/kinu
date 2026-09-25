/** `kinu acp`: serve one workspace over ACP on stdio; each session opens the same AgentClient `kinu chat` uses. */

import { Writable } from 'node:stream';
import { ndJsonStream } from '@agentclientprotocol/sdk';
import { createAcpAgent } from '../acp/agent';
import { createAgentClient } from '../client-factory';
import { requireAgentTarget } from '../local-target';
import { ensureLocalDaemonRunning } from './daemon';
import { VERSION } from '../display';

interface AcpCommandOptions {
  model?: string;
  baseUrl?: string;
  auth?: string;
  noAutoEvolve?: boolean;
  transcriptDir?: string;
}

export async function acpCommand(name: string, opts: AcpCommandOptions): Promise<void> {
  // stdout is the protocol channel; diagnostics must never touch it.
  const target = requireAgentTarget(name);

  if (target.mode === 'local') ensureLocalDaemonRunning();

  const app = createAcpAgent({
    name: 'kinu',
    version: VERSION,
    openClient: async () => await createAgentClient(target, {
      model: opts.model,
      baseUrl: opts.baseUrl,
      auth: opts.auth,
      noAutoEvolve: opts.noAutoEvolve,
      transcriptDir: opts.transcriptDir,
    }),
  });

  // node:stream's web types do not unify with the lib.dom ones the SDK expects; the byte streams are the same.
  const connection = app.connect(ndJsonStream(
    Writable.toWeb(process.stdout),
    stdinBytes(),
  ));

  await connection.closed;
}

function stdinBytes(): ReadableStream<Uint8Array> {
  let dataListener: ((chunk: Buffer) => void) | null = null;
  let endListener: (() => void) | null = null;
  let errorListener: ((error: Error) => void) | null = null;

  return new ReadableStream<Uint8Array>({
    start(controller) {
      dataListener = (chunk) => controller.enqueue(chunk);
      endListener = () => controller.close();
      errorListener = (error) => controller.error(error);
      process.stdin.on('data', dataListener);
      process.stdin.once('end', endListener);
      process.stdin.once('error', errorListener);
      process.stdin.resume();
    },
    cancel() {
      if (dataListener) process.stdin.off('data', dataListener);

      if (endListener) process.stdin.off('end', endListener);

      if (errorListener) process.stdin.off('error', errorListener);
      process.stdin.pause();
    },
  });
}

/**
 * `kinu acp` — serve one workspace over the Agent Client Protocol on stdio,
 * so editors (Zed, JetBrains, neovim, Marimo) can drive it as their agent.
 *
 * The process is a transport, not a second brain: every ACP session opens the
 * same AgentClient `kinu chat` uses.
 */

import { existsSync } from 'node:fs';
import { Writable } from 'node:stream';
import { ndJsonStream } from '@agentclientprotocol/sdk';
import { createAcpAgent } from '../acp/agent';
import { createAgentClient } from '../client-factory';
import { resolveAgentTarget } from '../agent-target';
import { agentDbPath, resolveAgentRef } from '../config';
import { ensureLocalDaemonRunning } from './daemon';
import { VERSION } from '../display';

export interface AcpCommandOptions {
  model?: string;
  baseUrl?: string;
  auth?: string;
  noAutoEvolve?: boolean;
  sessionDir?: string;
}

export async function acpCommand(name: string, opts: AcpCommandOptions): Promise<void> {
  if (!resolveAgentRef(name) && !existsSync(agentDbPath(name))) {
    // stdout is the protocol channel — diagnostics must never touch it.
    console.error(`Workspace "${name}" not found. Create it with: kinu create ${name}`);
    process.exit(1);
  }
  const target = resolveAgentTarget(name);
  if (target.mode === 'local') ensureLocalDaemonRunning();

  const app = createAcpAgent({
    name: 'kinu',
    version: VERSION,
    // Each ACP session is its own recorded conversation on this workspace.
    openClient: async () => await createAgentClient(target, {
      model: opts.model,
      baseUrl: opts.baseUrl,
      auth: opts.auth,
      noAutoEvolve: opts.noAutoEvolve,
      sessionDir: opts.sessionDir,
    }),
  });

  // node:stream's toWeb returns its own structurally-identical stream types,
  // which do not unify with the lib.dom ones the SDK is typed against. The
  // conversion is real at this one boundary; the byte streams are the same.
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

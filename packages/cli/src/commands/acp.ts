/**
 * `proteus acp` — serve one workspace over the Agent Client Protocol on stdio,
 * so editors (Zed, JetBrains, neovim, Marimo) can drive it as their agent.
 *
 * The process is a transport, not a second brain: every ACP session opens the
 * same AgentClient `proteus chat` uses.
 */

import { existsSync } from 'node:fs';
import { Readable, Writable } from 'node:stream';
import { ndJsonStream } from '@agentclientprotocol/sdk';
import { createAcpAgent } from '../acp/agent.js';
import { createAgentClient } from '../client-factory.js';
import { resolveAgentTarget } from '../agent-target.js';
import { agentDbPath, resolveAgentRef } from '../config.js';
import { ensureLocalDaemonRunning } from './daemon.js';
import { VERSION } from '../display.js';

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
    console.error(`Workspace "${name}" not found. Create it with: proteus create ${name}`);
    process.exit(1);
  }
  const target = resolveAgentTarget(name);
  if (target.mode === 'local') ensureLocalDaemonRunning();

  const app = createAcpAgent({
    name: 'proteus',
    version: VERSION,
    // Each ACP session is its own recorded conversation on this workspace.
    openClient: async () => createAgentClient(target, {
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
    Writable.toWeb(process.stdout) as unknown as WritableStream<Uint8Array>,
    Readable.toWeb(process.stdin) as unknown as ReadableStream<Uint8Array>,
  ));
  await connection.closed;
}

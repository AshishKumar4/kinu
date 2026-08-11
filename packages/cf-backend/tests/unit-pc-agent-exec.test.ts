/**
 * The PC daemon's `exec` RPC — the cf backend's `laptop` runtime.
 *
 * `packages/pc-agent/src/index.js` is the other end of the device tunnel: when
 * a cloud agent calls `run laptop`, this is the process that actually runs the
 * command on the user's machine. It ships as one dependency-free file the user
 * downloads, it had no suite at all, and it carried the same two defects as the
 * local host shell — which is the point. The bug was never "a mistake in one
 * function", it was one contract implemented three times with nobody checking
 * that the copies agreed.
 *
 * Tested through the exported RPC entry point (`handle`) with a fake socket,
 * so these assert what the cloud agent receives, not how the daemon is built.
 */

import { describe, expect, test } from 'bun:test';
import { createRequire } from 'node:module';
import { join } from 'node:path';

const require_ = createRequire(import.meta.url);
const { handle } = require_(join(import.meta.dir, '../../pc-agent/src/index.js')) as {
  handle: (msg: unknown, ws: { send(data: string): void }, ctx?: unknown) => void;
};

interface ExecReply {
  id: string;
  result?: { stdout: string; stderr: string; exitCode: number };
  error?: string;
}

/** Issue one `exec` RPC and resolve with the daemon's reply. */
function exec(command: string, timeoutMs = 30_000): Promise<{ reply: ExecReply; elapsed: number }> {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const timer = setTimeout(() => reject(new Error(`no reply within ${timeoutMs}ms`)), timeoutMs);
    const ws = {
      send(data: string) {
        clearTimeout(timer);
        resolve({ reply: JSON.parse(data) as ExecReply, elapsed: Date.now() - started });
      },
    };
    handle({ id: 'rpc-1', method: 'exec', params: [command] }, ws);
  });
}

describe('pc-agent exec RPC', () => {
  test('answers with stdout, stderr and the exit code', async () => {
    const { reply } = await exec('echo out; echo err 1>&2; exit 4');

    expect(reply.id).toBe('rpc-1');
    expect(reply.error).toBeUndefined();
    expect(reply.result?.stdout).toContain('out');
    expect(reply.result?.stderr).toContain('err');
    expect(reply.result?.exitCode).toBe(4);
  });

  test('answers when the COMMAND finishes, not when a backgrounded server does', async () => {
    // The cloud-side symptom of settling on `close`: the agent asks the laptop
    // to start a dev server, the server starts fine, and the tool call never
    // returns — the turn hangs for as long as the server runs. Same defect as
    // cli-backend's createHostShell, on the other backend.
    const { reply, elapsed } = await exec('sleep 20 & echo started');

    expect(reply.result?.stdout).toContain('started');
    expect(reply.result?.exitCode).toBe(0);
    expect(elapsed).toBeLessThan(3_000);
  }, 40_000);

  test('output the command wrote is complete, not cut short by the early answer', async () => {
    const { reply } = await exec('seq 1 20000');

    expect(reply.result?.exitCode).toBe(0);
    expect(reply.result?.stdout.trimEnd().split('\n')).toHaveLength(20_000);
  }, 40_000);

  test('answers exactly once', async () => {
    // Two settle paths (`close` and the drained `exit`) race on every call. A
    // double reply corrupts the tunnel's request/response pairing, so the
    // cloud agent would attribute one command's output to the next command.
    const sends: string[] = [];
    handle({ id: 'rpc-once', method: 'exec', params: ['echo hi'] }, { send: (d) => sends.push(d) });
    await new Promise((r) => setTimeout(r, 1_500));

    expect(sends).toHaveLength(1);
  }, 20_000);
});

import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, test } from 'bun:test';
import * as v from 'valibot';

import { JOURNAL_READY_PROBE, journalReadyRunCommand } from '../bench/journal-ready-probe';

/** One stats reply the fake journal can serve: the correlated success, or a refusal. */
interface StatsAnswer {
  readonly id: string;
  readonly ok: boolean;
  readonly sequence?: number;
  readonly error?: string;
}

const StatsRequestSchema = v.looseObject({ id: v.string() });

const dirs: string[] = [];

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

/** A fake journal control socket answering one `stats` request like the daemon:
 *  one JSON line in, one JSON line out, over a Unix socket. */
async function statsServer(answer: (id: string) => StatsAnswer): Promise<{
  socket: string;
  close: () => Promise<void>;
}> {
  const dir = await mkdtemp(join(tmpdir(), 'journal-ready-'));
  dirs.push(dir);
  const socket = join(dir, 'control.sock');
  const conns = new Set<Socket>();
  const server = createServer((conn) => {
    conns.add(conn);
    conn.on('close', () => {
      conns.delete(conn);
    });
    let received = '';
    conn.on('data', (chunk: Buffer) => {
      received += chunk.toString();
      const newline = received.indexOf('\n');
      if (newline === -1) return;
      const incoming = v.safeParse(StatsRequestSchema, JSON.parse(received.slice(0, newline)));
      if (!incoming.success) {
        conn.destroy();
        return;
      }
      conn.write(`${JSON.stringify(answer(incoming.output.id))}\n`);
    });
  });
  await new Promise<void>((resolve) => {
    server.listen(socket, resolve);
  });
  return {
    socket,
    close: async () => {
      for (const conn of conns) conn.destroy();
      await new Promise<void>((resolve, reject) => {
        server.close((error?: Error) => {
          if (error === undefined) resolve();
          else reject(error);
        });
      });
    },
  };
}

/** Run exactly the bytes the fixture stages, against one socket. */
async function runProbe(socket: string): Promise<{ code: number; stdout: string; stderr: string }> {
  const dir = await mkdtemp(join(tmpdir(), 'journal-ready-probe-'));
  dirs.push(dir);
  const script = join(dir, 'probe.mjs');
  await writeFile(script, JOURNAL_READY_PROBE);
  const child = Bun.spawn([process.execPath, script, socket], { stdout: 'pipe', stderr: 'pipe' });
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  return { code, stdout, stderr };
}

describe('the journal readiness probe', () => {
  test('an answering journal exits zero with its correlated reply', async () => {
    const journal = await statsServer((id) => ({ id, ok: true, sequence: 7 }));
    try {
      const run = await runProbe(journal.socket);
      expect(run.code).toBe(0);
      expect(run.stderr).toBe('');
      const reply = v.safeParse(v.looseObject({ id: v.string(), ok: v.boolean() }), JSON.parse(run.stdout));
      expect(reply.success).toBe(true);
      if (reply.success) expect(reply.output.id.length).toBeGreaterThan(0);
      if (reply.success) expect(reply.output).toMatchObject({ ok: true });
    } finally {
      await journal.close();
    }
  });

  test('a refusing journal exits nonzero with no reply on stdout', async () => {
    const journal = await statsServer((id) => ({ id, ok: false, error: 'nope' }));
    try {
      const run = await runProbe(journal.socket);
      expect(run.code).not.toBe(0);
      expect(run.stdout).toBe('');
    } finally {
      await journal.close();
    }
  });

  test('no listener exits nonzero', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'journal-ready-absent-'));
    dirs.push(dir);
    const run = await runProbe(join(dir, 'control.sock'));
    expect(run.code).not.toBe(0);
    expect(run.stdout).toBe('');
  });

  test('the run command names the staged path, never the probe bytes', () => {
    expect(journalReadyRunCommand('/var/tmp/devbox/candidate-journal/state/control.sock')).toBe(
      "bun /tmp/kinu-journal-ready-probe.mjs '/var/tmp/devbox/candidate-journal/state/control.sock'",
    );
  });

  test('the worker stages probe bytes instead of shell-quoting them', async () => {
    // The deployed probe died on a shell-quoted -e invocation, whose double-quotes
    // mangle real newlines into literal backslash-n sequences that Bun's
    // parser rejects. The bytes travel by file now; this pins that.
    const worker = await readFile(new URL('../bench/worker.ts', import.meta.url), 'utf8');
    expect(worker).not.toContain('bun -e ${');
    expect(worker).toContain('writeFile(JOURNAL_READY_PROBE_PATH');
  });
});

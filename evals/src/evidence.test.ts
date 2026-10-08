import { describe, expect, test } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import * as v from 'valibot';
import type { JsonValue } from '@kinu.run/core';
import { scratchDir } from '@kinu.run/test-utils';
import { gatherEvidence, writeEvidence, type EvidenceSession } from './evidence';
import { HarnessRunSchema } from './results';

/** A workspace as the Files plane and the slate RPC serve it. */
function workspace(tree: Readonly<Record<string, string | Uint8Array>>): EvidenceSession {
  const entries = (dir: string) => [...new Set(Object.keys(tree).filter((path) => path.startsWith(`${dir}/`))
    .map((path) => path.slice(dir.length + 1).split('/')))]
    .map((parts) => ({ name: parts[0] ?? '', type: parts.length > 1 ? 'dir' as const : 'file' as const }))
    .filter((entry, index, all) => all.findIndex((other) => other.name === entry.name) === index);

  return {
    listFiles: (dir) => Promise.resolve(entries(dir)),
    readBytes: (path) => {
      const content = tree[path];

      if (content === undefined) throw new Error(`no ${path}`);

      return Promise.resolve(content instanceof Uint8Array ? content : new TextEncoder().encode(content));
    },
    listSlates: () => Promise.resolve({ slates: [{ id: 'exchange', title: 'Exchange' }], problems: [] }),
    slateOp: (operation: JsonValue): Promise<JsonValue> => {
      const { op, method } = v.parse(v.looseObject({ op: v.string(), method: v.optional(v.string()) }), operation);

      if (op === 'history') return Promise.resolve({ ok: true, value: { versions: [{ id: 'v-1' }] } });

      if (method === 'book') return Promise.resolve({ ok: true, value: { bids: [], asks: [] } });

      return Promise.resolve({ ok: false, reason: 'bad_input', error: 'Slate compilation failed' });
    },
  };
}

const RUN = v.parse(HarnessRunSchema, {
  session: {
    metadata: { taskId: 'order-book', taskVersion: 'v', evalCommit: 'c', productSha: 'p', arm: 'product', trial: 2 },
    events: [{ type: 'message', role: 'user', content: 'Build it.' }],
  },
  usage: { model: 'test/model' },
  output: { metrics: { modelTurns: 1, toolCalls: 0, toolErrors: 0, badInputCalls: 0, unknownToolCalls: 0, providerWaits: 0, providerWaitMs: 0 }, turns: [] },
  errors: [],
});

describe('a trial\'s evidence', () => {
  test('keeps every file of the home and the slates, the slates\' histories and the data they served', async () => {
    const binary = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0xff, 0x00]);

    const session = workspace({
      '/home/main/SOUL.md': 'Fernhill Bakery.',
      '/home/main/exports/q3.zip': binary,
      '/home/main/node_modules/left-pad/index.js': 'module.exports = 1;',
      '/slates/exchange/server.ts': 'export class Slate {}\n',
      '/slates/exchange/package.json': '{"main":"server.ts"}',
    });

    const gathered = await gatherEvidence(session, async (call) => {
      await call('exchange', 'book', { symbol: 'ACME' });
      await call('exchange', 'trades', { symbol: 'ACME' });
    });

    const directory = join(scratchDir('eval-evidence'), 'trial-2');

    writeEvidence(directory, { run: RUN, verdict: { status: 'failed', durationMs: 60_000 }, events: [], workspace: gathered, timeline: [] });

    expect(readFileSync(join(directory, 'files/slates/exchange/server.ts'), 'utf8')).toBe('export class Slate {}\n');
    expect(readFileSync(join(directory, 'files/home/main/SOUL.md'), 'utf8')).toBe('Fernhill Bakery.');
    expect(new Uint8Array(readFileSync(join(directory, 'files/home/main/exports/q3.zip')))).toEqual(binary);
    expect(existsSync(join(directory, 'files/home/main/node_modules'))).toBe(false);
    expect(JSON.parse(readFileSync(join(directory, 'slates.json'), 'utf8')).histories)
      .toEqual([{ id: 'exchange', history: [{ ok: true, value: { versions: [{ id: 'v-1' }] } }] }]);
    expect(JSON.parse(readFileSync(join(directory, 'data.json'), 'utf8'))).toEqual([
      { slate: 'exchange', method: 'book', input: { symbol: 'ACME' }, answer: { ok: true, value: { bids: [], asks: [] } } },
      { slate: 'exchange', method: 'trades', input: { symbol: 'ACME' }, answer: { ok: false, reason: 'bad_input', error: 'Slate compilation failed' } },
    ]);
    expect(readFileSync(join(directory, 'transcript.md'), 'utf8')).toContain('order-book \u00b7 test/model \u00b7 product \u00b7 trial 2 \u2014 failed');
  });

  test('a data read that resets the workspace keeps the files, the slates, the transcript and the ledger, and says why', async () => {
    // Measured 2026-09-30 on kinu.run: the request-logs reads reset the workspace, and all ten trials lost their files.
    const served = workspace({ '/home/main/logs/2027-06-01.log': 'GET /api 200 3ms FRA\n', '/slates/logs/server.ts': 'export class Slate {}\n' });

    const reset: EvidenceSession = {
      ...served,
      slateOp: (operation) => v.is(v.object({ op: v.literal('call') }), operation)
        ? Promise.reject(new Error('the workspace socket closed (code 1006, Connection ended)'))
        : served.slateOp(operation),
    };

    const gathered = await gatherEvidence(reset, async (call) => { await call('logs', 'days'); });
    const directory = join(scratchDir('eval-evidence'), 'trial-1');

    writeEvidence(directory, {
      run: RUN, verdict: { status: 'failed', durationMs: 1 },
      events: [{ runId: 'run-1', eventIndex: 1, timestamp: '2026-09-26T00:00:00.000Z', type: 'run_start', agentId: 'root' }],
      workspace: gathered, timeline: [],
    });

    expect(readFileSync(join(directory, 'files/home/main/logs/2027-06-01.log'), 'utf8')).toBe('GET /api 200 3ms FRA\n');
    expect(readFileSync(join(directory, 'files/slates/logs/server.ts'), 'utf8')).toBe('export class Slate {}\n');
    expect(existsSync(join(directory, 'slates.json'))).toBe(true);
    expect(readFileSync(join(directory, 'workspace.txt'), 'utf8')).toContain('data: ');
    expect(readFileSync(join(directory, 'workspace.txt'), 'utf8')).toContain('code 1006');
    expect(JSON.parse(readFileSync(join(directory, 'ledger.jsonl'), 'utf8'))).toMatchObject({ type: 'run_start', runId: 'run-1' });
    expect(existsSync(join(directory, 'transcript.md'))).toBe(true);
  });
});

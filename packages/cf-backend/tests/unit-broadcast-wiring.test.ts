/**
 * Every broadcast channel must be read by somebody.
 *
 * `BackendHost.broadcast` is a fire-and-forget fan-out to connected clients,
 * and it is typed `{ type: string; [key: string]: unknown }` — so a channel
 * nobody listens to is not a type error, not a runtime error, and not visible
 * in any log. It is a feature that is fully built, fully tested, and does
 * nothing.
 *
 * The defect this locks: `broadcast({ type: 'background_event_injected', … })`
 * shipped with zero consumers repo-wide. It even had a test —
 * `unit-agent-orchestrator.test.ts` asserted the broadcast fired — which is the
 * part worth sitting with. The test passed, the assertion was true, and the
 * feature was dead. Asserting that a producer produced is not evidence that
 * anything happens; only the other end is.
 *
 * So this walks both ends. It is a source-level gate on purpose: producer and
 * consumer are in different processes (a Durable Object and a browser), so no
 * runtime test can span them, and the failure is precisely an absence.
 */

import { describe, expect, test } from 'bun:test';
import { readFileSync, readdirSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

const REPO = resolve(import.meta.dir, '../../..');

/** Where broadcasts are produced: the core loop and the CF backend. */
const PRODUCER_ROOTS = ['packages/core/src', 'packages/cf-backend/src'] as const;
/** Where they are consumed: the browser client and the CLI, the two surfaces a
 *  `BackendHost` fans out to. */
const CONSUMER_ROOTS = ['packages/cf-backend/src', 'packages/cli/src'] as const;

function sourceFiles(root: string, exts: readonly string[]): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name !== 'node_modules' && entry.name !== 'dist') walk(full);
      } else if (exts.some((e) => entry.name.endsWith(e))) {
        out.push(full);
      }
    }
  };
  walk(join(REPO, root));
  return out.sort();
}

/** The balanced argument text of a call whose `(` is at `open`. */
function callArgument(text: string, open: number): string {
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    const c = text[i]!;
    if (c === '(' || c === '[' || c === '{') depth++;
    else if (c === ')' || c === ']' || c === '}') {
      depth--;
      if (depth === 0) return text.slice(open + 1, i);
    }
  }
  return '';
}

/** Discriminants declared at the TOP level of a broadcast argument's object
 *  literal. Depth matters: `parts: [{ type: 'text' }]` is a message part, not a
 *  channel, and counting it would make the gate assert nonsense. */
function channelsIn(argument: string): string[] {
  const found: string[] = [];
  let depth = 0;
  const token = /[{}]|type:\s*['"]([A-Za-z0-9_.-]+)['"]/g;
  for (let m = token.exec(argument); m; m = token.exec(argument)) {
    if (m[0] === '{') depth++;
    else if (m[0] === '}') depth--;
    else if (depth === 1 && m[1]) found.push(m[1]);
  }
  return found;
}

/** channel name → the files that broadcast it. */
function broadcastChannels(): Map<string, string[]> {
  const channels = new Map<string, string[]>();
  for (const root of PRODUCER_ROOTS) {
    for (const file of sourceFiles(root, ['.ts'])) {
      const text = readFileSync(file, 'utf8');
      for (const m of text.matchAll(/\bbroadcast\s*\(/g)) {
        for (const name of channelsIn(callArgument(text, m.index + m[0].length - 1))) {
          const at = channels.get(name) ?? [];
          if (!at.includes(file)) at.push(file);
          channels.set(name, at);
        }
      }
    }
  }
  return channels;
}

const CHANNELS = broadcastChannels();

/**
 * Consumer evidence must be COMPARISON-shaped: `.type === 'x'`, `!== 'x'`,
 * `case 'x':`. A bare quoted-substring match is not evidence — producers
 * construct `{ type: 'x' }` (colon form, also via helpers this scan cannot
 * trace), type declarations declare `type: 'x';`, and SQL DDL can contain the
 * same word as a table name. Under the old substring match every one of those
 * counted as a consumer, so the gate was passing for the wrong reason: a
 * channel whose real handler was deleted stayed green off its own producer.
 */
function readsChannel(text: string, channel: string): boolean {
  const name = channel.replace(/[.*+?^${}()|[\]\\-]/g, '\\$&');
  return new RegExp(
    `[!=]==?\\s*['"]${name}['"]` +      // msg.type === 'x' / value.type !== "x"
    `|['"]${name}['"]\\s*[!=]==?` +     // 'x' === msg.type
    `|case\\s+['"]${name}['"]\\s*:`,    // switch (msg.type) { case 'x': }
  ).test(text);
}

/** The AI chat hook owns this framework protocol frame internally. Its
 * registration against the same Agent connection is the consumer evidence;
 * application code does not receive the frame through its own switch. */
function readsFrameworkChannel(text: string, channel: string): boolean {
  return channel === 'cf_agent_chat_messages'
    && /\buseAgentChat\s*\(\s*\{\s*agent\s*,/.test(text);
}

describe('broadcast channels reach a consumer', () => {
  test('the scan finds the broadcast surface at all', () => {
    // Guards the guard: if `broadcast(` is renamed or the object shape changes,
    // every per-channel assertion below would silently vanish and this file
    // would pass while checking nothing.
    expect(CHANNELS.size).toBeGreaterThanOrEqual(8);
    expect([...CHANNELS.keys()]).toContain('signal_card');
  });

  test('the consumer predicate can fail (canaries)', () => {
    // Producer/declaration shapes must NOT count as consumption…
    expect(readsChannel(`broadcast({ type: 'ghost_channel', x: 1 })`, 'ghost_channel')).toBe(false);
    expect(readsChannel(`interface P { type: 'ghost_channel'; }`, 'ghost_channel')).toBe(false);
    expect(readsChannel(`CREATE TABLE ghost_channel (id TEXT)`, 'ghost_channel')).toBe(false);
    // …and no file in the consumer roots reads a channel nobody broadcasts.
    const readers = CONSUMER_ROOTS
      .flatMap((root) => sourceFiles(root, ['.ts', '.tsx']))
      .filter((file) => readsChannel(readFileSync(file, 'utf8'), 'channel_nobody_ever_broadcast'));
    expect(readers).toEqual([]);
  });

  for (const [channel, producers] of [...CHANNELS].sort(([a], [b]) => a.localeCompare(b))) {
    test(`"${channel}" is read by a client surface`, () => {
      const consumers = CONSUMER_ROOTS
        .flatMap((root) => sourceFiles(root, ['.ts', '.tsx']))
        .filter((file) => !producers.includes(file))
        .filter((file) => {
          const text = readFileSync(file, 'utf8');
          return readsChannel(text, channel) || readsFrameworkChannel(text, channel);
        })
        .map((file) => relative(REPO, file));

      // The failure names the channel and where it is broadcast from, because
      // the fix is always one of two things: wire it up, or delete it.
      expect({
        channel,
        broadcastFrom: producers.map((p) => relative(REPO, p)),
        hasConsumer: consumers.length > 0,
      }).toEqual({
        channel,
        broadcastFrom: producers.map((p) => relative(REPO, p)),
        hasConsumer: true,
      });
    });
  }
});

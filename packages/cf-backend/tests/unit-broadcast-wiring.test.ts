/**
 * Defends: a `broadcast` channel with zero consumers (`background_event_injected` shipped dead);
 * the payload type cannot catch it. Source-level because producer (DO) and consumer (browser) never share a process.
 */

import { describe, expect, test } from 'bun:test';
import { readFileSync, readdirSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

const REPO = resolve(import.meta.dir, '../../..');

const PRODUCER_ROOTS = ['packages/core/src', 'packages/cf-backend/src'] as const;

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

function callArgument(text: string, open: number): string {
  let depth = 0;

  for (let i = open; i < text.length; i++) {
    const c = text[i];

    if (c === '(' || c === '[' || c === '{') depth++;
    else if (c === ')' || c === ']' || c === '}') {
      depth--;

      if (depth === 0) return text.slice(open + 1, i);
    }
  }

  return '';
}

/** Top-level discriminants only: `parts: [{ type: 'text' }]` is a message part, not a channel. */
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

function recordProducers(channels: Map<string, string[]>, argument: string, file: string): void {
  for (const name of channelsIn(argument)) {
    const at = channels.get(name) ?? [];

    if (!at.includes(file)) at.push(file);
    channels.set(name, at);
  }
}

function broadcastChannels(): Map<string, string[]> {
  const channels = new Map<string, string[]>();

  for (const root of PRODUCER_ROOTS) {
    for (const file of sourceFiles(root, ['.ts'])) {
      const text = readFileSync(file, 'utf8');

      for (const m of text.matchAll(/\bbroadcast\s*\(/g)) {
        recordProducers(channels, callArgument(text, m.index + m[0].length - 1), file);
      }
    }
  }

  return channels;
}

const CHANNELS = broadcastChannels();

/** Consumer evidence must be comparison-shaped (`=== 'x'`, `case 'x':`); a bare substring also matches
 *  producers, type declarations and SQL DDL. */
function readsChannel(text: string, channel: string): boolean {
  const name = channel.replace(/[.*+?^${}()|[\]\\-]/g, '\\$&');

  return new RegExp(
    `[!=]==?\\s*['"]${name}['"]` +      // msg.type === 'x' / value.type !== "x"
    `|['"]${name}['"]\\s*[!=]==?` +     // 'x' === msg.type
    `|case\\s+['"]${name}['"]\\s*:`,    // switch (msg.type) { case 'x': }
  ).test(text);
}

/** The AI chat hook consumes this protocol frame internally; its registration is the evidence. */
function readsFrameworkChannel(text: string, channel: string): boolean {
  return channel === 'cf_agent_chat_messages'
    && /\buseAgentChat\s*\(\s*\{\s*agent\s*,/.test(text);
}

describe('broadcast channels reach a consumer', () => {
  test('the scan finds the broadcast surface at all', () => {
    // Guards the guard: a rename of `broadcast(` must not let every assertion vanish.
    expect(CHANNELS.size).toBeGreaterThanOrEqual(8);
    expect([...CHANNELS.keys()]).toContain('signal_card');
  });

  test('the consumer predicate can fail (canaries)', () => {
    expect(readsChannel(`broadcast({ type: 'ghost_channel', x: 1 })`, 'ghost_channel')).toBe(false);
    expect(readsChannel(`interface P { type: 'ghost_channel'; }`, 'ghost_channel')).toBe(false);
    expect(readsChannel(`CREATE TABLE ghost_channel (id TEXT)`, 'ghost_channel')).toBe(false);

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

/** Every `useNodeTranscript` caller must arm the fallback re-read after a missed `head_activity`
 *  frame; a branch chip has one node and cannot recover by hand. */
describe('every open node transcript can recover a missed head_activity frame', () => {
  const READERS = sourceFiles('packages/cf-backend/src', ['.ts', '.tsx'])
    .flatMap((file) => {
      const text = readFileSync(file, 'utf8');
      const calls: Array<{ file: string; argument: string }> = [];

      for (let at = text.indexOf('useNodeTranscript('); at !== -1; at = text.indexOf('useNodeTranscript(', at + 1)) {
        calls.push({ file: relative(REPO, file), argument: callArgument(text, text.indexOf('(', at)) });
      }

      // The hook's own declaration is not a call.
      return calls.filter((call) => !call.argument.includes(': {'));
    });

  test('the scan finds the readers at all', () => {
    expect(READERS.length).toBeGreaterThanOrEqual(2);
    expect(READERS.map((r) => r.file)).toContain('packages/cf-backend/src/components/AlternateTakes.tsx');
  });

  test('each reader passes `running`, so the fallback clock can arm', () => {
    const unarmed = READERS.filter((reader) => !/\brunning\s*:/.test(reader.argument)).map((r) => r.file);
    expect(unarmed).toEqual([]);
  });
});

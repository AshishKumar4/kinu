#!/usr/bin/env bun
/**
 * Minecraft trials, 2026-10-22: the box's desktop actions under a captured pointer, proved on the box's own stack
 * (Debian's Chromium, an X server, openbox and xdotool, in `scripts/fixtures/pointer-lock/`), each action run as the
 * box runs it (`xdotoolOf`). A page captures the pointer and records the motion Chromium reports. It proves that:
 * - a move by a distance reports exactly that distance, every time, the hidden pointer re-centred or not;
 * - a move to one point near the screen's edge turns the view again each time it is sent, so a point aims nothing;
 * - a click at no point moves nothing first.
 *
 *   bun scripts/pointer-lock-proof.ts      (needs docker; builds the image once)
 */
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import * as v from 'valibot';
import { xdotoolOf } from '../packages/devbox/src/desktop-input';
import type { DesktopAction } from '../packages/devbox/src/wire';

const FIXTURE = join(import.meta.dir, 'fixtures', 'pointer-lock');

const IMAGE = 'kinu-pointer-lock-proof';

/** What the page recorded, in order. */
const EventsSchema = v.array(v.variant('t', [
  v.object({ t: v.literal('down'), button: v.number() }),
  v.object({ t: v.literal('lock'), locked: v.boolean() }),
  v.object({ t: v.literal('move'), dx: v.number(), dy: v.number() }),
]));

type Acting = Exclude<DesktopAction, { kind: 'screenshot' | 'watch' }>;

/** Each step: a label, and the action run as the box runs it. */
const STEPS: ReadonlyArray<readonly [string, Acting]> = [
  ['capture', { kind: 'click', at: [640, 360], button: 'left', count: 1, hold: [] }],
  ...Array.from({ length: 5 }, (_, at): [string, Acting] => [`by-${String(at)}`, { kind: 'move', by: [0, 100] }]),
  ...Array.from({ length: 3 }, (_, at): [string, Acting] => [`edge-${String(at)}`, { kind: 'move', at: [640, 700] }]),
  ['in-place', { kind: 'click', button: 'left', count: 1, hold: [] }],
];

const shell = (argv: readonly string[]): string => argv.map((word) => `'${word.replaceAll("'", "'\\''")}'`).join(' ');

/** The run inside the container: the desktop up, then each step, a marker in the page's log between them. */
function script(): string {
  return ['set -u', 'export DISPLAY=:0', 'Xvfb :0 -screen 0 1280x720x24 >/dev/null 2>&1 &', 'sleep 1', 'openbox >/dev/null 2>&1 &', 'sleep 0.5',
    'chromium --no-sandbox --app=file:///proof/page.html --start-maximized --no-first-run --user-data-dir=/tmp/p >/dev/null 2>&1 &',
    'for _ in $(seq 1 100); do xdotool search --onlyvisible --class chromium >/dev/null 2>&1 && break; sleep 0.1; done', 'sleep 2',
    'title() { xdotool getwindowname $(xdotool search --onlyvisible --class chromium | head -1); }',
    // Read once the page's log has grown and then stopped growing: every step adds an event (a move, or a click's press),
    // so its events have all reached the page, not merely some time gone by.
    'settled() { local now; for _ in $(seq 1 50); do sleep 0.1; now=$(title); [ "$now" != "$1" ] && break; done; local last=""; '
      + 'for _ in $(seq 1 20); do sleep 0.2; last=$now; now=$(title); [ "$now" = "$last" ] && break; done; echo "log $now"; }',
    ...STEPS.flatMap(([label, action]) => [`echo "step ${label}"`, 'before=$(title)', shell(xdotoolOf(action)), 'settled "$before"']),
  ].join('\n');
}

/** The motion the page recorded during each step, as [dx, dy], the re-centring's zero-distance events left out. */
function motionByStep(output: string): Map<string, { readonly moved: Array<readonly [number, number]>; readonly downs: number }> {
  const seen = new Map<string, { readonly moved: Array<readonly [number, number]>; readonly downs: number }>();
  let step = '';
  let before = 0;

  for (const line of output.split('\n')) {
    if (line.startsWith('step ')) step = line.slice('step '.length);

    if (!line.startsWith('log L')) continue;
    const events = v.parse(EventsSchema, JSON.parse(Buffer.from(line.slice('log L'.length), 'base64').toString('utf8')));
    const fresh = events.slice(before);

    before = events.length;
    seen.set(step, {
      moved: fresh.flatMap((event) => (event.t === 'move' && (event.dx !== 0 || event.dy !== 0) ? [[event.dx, event.dy] as const] : [])),
      downs: fresh.filter((event) => event.t === 'down').length,
    });
  }

  return seen;
}

function main(): number {
  const built = spawnSync('docker', ['build', '-q', '-t', IMAGE, FIXTURE], { encoding: 'utf8' });

  if (built.status !== 0) throw new Error(`docker build: ${built.stderr}`);
  const ran = spawnSync('docker', ['run', '--rm', '-v', `${FIXTURE}:/proof:ro`, IMAGE, 'bash', '-c', script()], { encoding: 'utf8', timeout: 120_000 });

  if (ran.status !== 0) throw new Error(`docker run: ${ran.stderr}`);
  const motion = motionByStep(ran.stdout);
  const of = (label: string) => motion.get(label) ?? { moved: [], downs: 0 };
  const by = STEPS.filter(([label]) => label.startsWith('by-')).map(([label]) => of(label).moved);
  // Each move to the edge point, its motion summed: every one after the first turns again.
  const edge = STEPS.filter(([label]) => label.startsWith('edge-')).map(([label]) => of(label).moved.reduce((sum, [, dy]) => sum + dy, 0));

  const findings = [
    ...by.every((moved) => JSON.stringify(moved) === '[[0,100]]') ? [] : [`a move by [0, 100] reported ${JSON.stringify(by)}, not [0, 100] each time`],
    ...edge.slice(1).every((turned) => turned !== 0) ? [] : [`a move to [640, 700] sent again turned nothing (${JSON.stringify(edge)}): the edge's re-centring did not show`],
    ...of('in-place').moved.length === 0 && of('in-place').downs === 1 ? [] : [`a click at no point moved ${JSON.stringify(of('in-place').moved)} or did not click`],
  ];

  console.log(`pointer-lock proof: by [0, 100] five times reported ${JSON.stringify(by)}; [640, 700] three times turned ${JSON.stringify(edge)}; `
    + `a click in place moved ${JSON.stringify(of('in-place').moved)}, ${String(of('in-place').downs)} click`);

  for (const finding of findings) console.error(`pointer-lock proof: ${finding}`);

  return findings.length === 0 ? 0 : 1;
}

if (import.meta.main) process.exitCode = main();

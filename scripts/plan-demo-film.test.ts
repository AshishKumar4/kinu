/**
 * The plan-demo recorder's seams.
 *
 * The walkthrough itself is a browser row in the live-app tier — it drives the
 * product, and only the product can prove it. What is left here is what a
 * binary and a script can be wrong about on their own: the GIF the muxer
 * produces (geometry, per-frame holds, frame count), the shipped film against
 * the README that displays it, and the scripted model's branch table, which
 * decides what the recorded agent does and must never answer a request with a
 * tool the request never offered, nor take the live state the product sends
 * after an ask for the ask.
 */
import { describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { DYNAMIC_CONTEXT_OPEN_TAG, WORKSPACE_INSTRUCTIONS_TAG } from '@kinu.run/core';

import { scratchDir } from '../packages/test-utils/src/scratch';

import { GIF_WIDTH, VIEWPORT, OPENING_LINE, concatManifest, filmScript, muxGif, probeGif } from './plan-demo-film';
import {
  FALLBACK_ANSWER, KEPT_TAB_NOTE, PLAN_MISSION, SLATE_TITLE, keptTabProbe, planWalkthrough, readScriptedRequest,
} from './scripted-model';

const REPO = resolve(import.meta.dir, '..');

const FILM = join(REPO, 'docs/assets/kinu-plan-demo.gif');

/** One solid frame of the recorder's own viewport, drawn by ffmpeg so the mux
 *  is measured without a browser. */
function viewportFrame(path: string, colour: string): void {
  execFileSync('ffmpeg', [
    '-y', '-v', 'error',
    '-f', 'lavfi', '-i', `color=c=${colour}:s=${String(VIEWPORT.width)}x${String(VIEWPORT.height)}`,
    '-frames:v', '1', path,
  ]);
}

/** The width and height the README's own image tag reserves for the film. */
function readmeFilmBox() {
  const readme = readFileSync(join(REPO, 'README.md'), 'utf8');
  const tag = /<img[^>]*kinu-plan-demo\.gif"[^>]*>/u.exec(readme)?.[0];

  if (tag === undefined) throw new Error('the README does not display the plan demo');

  const width = /width="(\d+)"/u.exec(tag)?.[1];
  const height = /height="(\d+)"/u.exec(tag)?.[1];

  if (width === undefined || height === undefined) throw new Error('the README reserves no box for the plan demo');

  return { width: Number(width), height: Number(height) };
}

describe('the recorder publishes the film at the width the README shows', () => {
  test("held frames mux to a GIF of the published width, at the viewport's aspect", () => {
    const dir = scratchDir(`plan-demo-film-test-${String(process.pid)}`);
    viewportFrame(join(dir, 'a.png'), 'black');
    viewportFrame(join(dir, 'b.png'), 'gray');

    const manifest = join(dir, 'frames.txt');
    writeFileSync(manifest, concatManifest([
      { file: 'a.png', holdMs: 400 },
      { file: 'b.png', holdMs: 600 },
    ]));

    const gif = join(dir, 'two-frames.gif');
    muxGif(dir, manifest, gif);

    const facts = probeGif(gif);

    // Two held frames, plus the concat demuxer's constant 40ms trailing
    // phantom — the known artifact the manifest comment names.
    expect(facts.frames).toBe(3);
    expect(facts.width).toBe(GIF_WIDTH);
    expect(facts.height).toBe(Math.round(GIF_WIDTH * VIEWPORT.height / VIEWPORT.width));
    // The manifest's holds, per packet, in ffprobe's own seconds.
    expect(facts.packetDurations[0]).toBeCloseTo(0.4, 2);
    expect(facts.packetDurations[1]).toBeCloseTo(0.6, 2);
    expect(facts.packetDurations[2]).toBeCloseTo(0.04, 2);
  });

  /**
   * THE PREMISE THE RECORDER SNAPS ITS HOLDS ONTO, MEASURED HERE.
   *
   * The recorder rounds every hold down to a whole 1/25 s tick. The reason is
   * a claim about ffmpeg, so it is measured rather than asserted in a
   * comment: the concat demuxer snaps each frame's CUMULATIVE timestamp onto
   * that grid, so an off-grid hold reaches the GIF as a delay the film never
   * planned — and which delay depends on every hold before it, which is why
   * the recorder's plan-versus-packet check failed on one beat out of 24.
   * Holds already on the grid pass through byte-exact.
   *
   * ffmpeg 8.0.1 / ffprobe, this host, 2026-09-18.
   */
  test("an off-grid hold reaches the GIF as a delay the film never planned", () => {
    const dir = scratchDir(`plan-demo-film-tick-${String(process.pid)}`);
    viewportFrame(join(dir, 'a.png'), 'black');
    viewportFrame(join(dir, 'b.png'), 'gray');

    const holds = (first: number, second: number): readonly number[] => {
      const manifest = join(dir, `frames-${String(first)}.txt`);
      writeFileSync(manifest, concatManifest([
        { file: 'a.png', holdMs: first },
        { file: 'b.png', holdMs: second },
      ]));

      const gif = join(dir, `holds-${String(first)}.gif`);
      muxGif(dir, manifest, gif);

      return probeGif(gif).packetDurations;
    };

    // 70ms and 110ms: cumulative 0.07s and 0.18s snap to 0.08s and 0.20s,
    // so the film would have shown 0.08s and 0.12s.
    const offGrid = holds(70, 110);
    expect(offGrid[0]).toBeCloseTo(0.08, 2);
    expect(offGrid[1]).toBeCloseTo(0.12, 2);

    // The same pair snapped down onto the grid arrives as planned.
    const onGrid = holds(40, 80);
    expect(onGrid[0]).toBeCloseTo(0.04, 2);
    expect(onGrid[1]).toBeCloseTo(0.08, 2);
  });

  test('the shipped film is the size the README reserves for it', () => {
    const facts = probeGif(FILM);

    expect({ width: facts.width, height: facts.height }).toEqual(readmeFilmBox());
  });

  test("the shipped film's first frame is fully opaque", () => {
    const facts = probeGif(FILM);
    // Decoding, not the GCE flag: a transparent index in the palette says
    // nothing about whether the base frame's pixels use it. Every pixel of
    // frame 0 must carry its own colour, or whatever the compositor keeps
    // beneath it shows through the whole loop.

    const rgba = execFileSync('ffmpeg', [
      '-v', 'error', '-i', FILM,
      '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'rgba', '-',
    ], { encoding: 'buffer', maxBuffer: 64 * 1024 * 1024 });

    expect(rgba.byteLength, 'the decode must yield width*height RGBA pixels')
      .toBe(facts.width * facts.height * 4);
    expect(rgba.every((byte, i) => i % 4 !== 3 || byte === 0xff), 'frame 0 has a transparent pixel')
      .toBe(true);
  });
});

/** One request as the provider sends it, through the server's own reader. */
function request(input: {
  messages: { role: string; content?: string; tools?: string[] }[]; available: string[];
}) {
  const messages = input.messages.map((message) => {
    const tools = message.tools;

    if (tools === undefined) return { role: message.role, content: message.content ?? null };

    return {
      role: message.role,
      content: message.content ?? null,
      tool_calls: tools.map((name) => ({ function: { name } })),
    };
  });

  return readScriptedRequest(JSON.stringify({
    messages,
    tools: input.available.map((name) => ({ function: { name } })),
  }));
}

const MISSION = { role: 'user', content: PLAN_MISSION };

const PLAN_TOOLS = ['file', 'shell', 'submit_plan'];

const BUILD_TOOLS = ['file', 'shell'];

describe('the recorded agent follows the walkthrough', () => {
  test('a request that offers no tools is answered with prose, whatever it asks', () => {
    // The workspace's own titling call carries the mission and no tools. A
    // script that read only the text would answer it with a tool call.
    expect(planWalkthrough(request({ messages: [MISSION], available: [] })))
      .toEqual({ text: FALLBACK_ANSWER });
  });

  test('the film answers its first request with the opening line', () => {
    // The create queues the genesis turn before the browser opens and nothing
    // else has spoken, so the run's first model request IS that turn: the film
    // script counts, it does not match on text. Later requests delegate, and
    // the shared walkthrough still serves the fallback — the live tier waits
    // on those words.
    const script = filmScript();
    const any = request({ messages: [MISSION], available: PLAN_TOOLS });

    expect(script(any)).toEqual({ text: OPENING_LINE });
    expect(script(any)).toEqual(planWalkthrough(any));
    expect(planWalkthrough(request({ messages: [MISSION], available: [] })))
      .toEqual({ text: FALLBACK_ANSWER });
  });

  test('a Plan turn submits the plan once, then ends its turn', () => {
    const first = planWalkthrough(request({ messages: [MISSION], available: PLAN_TOOLS }));

    expect(first.toolCall?.name).toBe('submit_plan');

    const after = planWalkthrough(request({
      messages: [MISSION, { role: 'assistant', tools: ['submit_plan'] }, { role: 'tool', content: '{"ok":true}' }],
      available: PLAN_TOOLS,
    }));

    expect(after.toolCall).toBeUndefined();
    expect(after.text).toBeTruthy();
  });

  test('the approved turn writes the slate and says where it is', () => {
    const history = [
      MISSION,
      { role: 'assistant', tools: ['submit_plan'] },
      { role: 'user', content: 'The owner approved plan p1 revision 1.' },
    ];

    const manifest = planWalkthrough(request({ messages: history, available: BUILD_TOOLS }));

    const server = planWalkthrough(request({
      messages: [...history, { role: 'assistant', tools: ['file'] }],
      available: BUILD_TOOLS,
    }));

    const settled = planWalkthrough(request({
      messages: [...history, { role: 'assistant', tools: ['file', 'file'] }],
      available: BUILD_TOOLS,
    }));

    for (const step of [manifest, server]) expect(step.toolCall?.name).toBe('file');

    expect(String(JSON.stringify(manifest.toolCall?.arguments))).toContain(SLATE_TITLE);
    expect(settled.toolCall).toBeUndefined();
    expect(settled.text).toContain(SLATE_TITLE);
  });
});

describe('a script reads what was asked, not the live state sent after it', () => {
  test('an ask the dynamic context and the unapproved instructions follow is still the ask', () => {
    // integration/0924: every request ended in the product's `<dynamic_context>` block, so the kept-tab script,
    // taking the last user message for the ask, answered the save with prose and the row waited out its tier.
    const asked = request({
      messages: [
        { role: 'user', content: KEPT_TAB_NOTE },
        { role: 'user', content: `${DYNAMIC_CONTEXT_OPEN_TAG} fingerprint="1" kind="delta">\n## Work mode\nMode: build\n</dynamic_context>` },
        { role: 'user', content: `<${WORKSPACE_INSTRUCTIONS_TAG}>\nFiles read from the workspace.\n</${WORKSPACE_INSTRUCTIONS_TAG}>` },
      ],
      available: ['file', 'memory'],
    });

    expect(keptTabProbe(asked)?.toolCall?.name).toBe('memory');
  });
});

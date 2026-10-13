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
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DYNAMIC_CONTEXT_OPEN_TAG, WORKSPACE_INSTRUCTIONS_TAG } from '@kinu.run/core';

import { scratchDir } from '../packages/test-utils/src/scratch';

import { VIEWPORT, concatManifest, filmScript, muxGif, probeGif } from './plan-demo-film';
import { KEPT_TAB_NOTE, PLAN_MISSION, keptTabProbe, planWalkthrough } from './scripted-model';
import { FALLBACK_ANSWER, readScriptedRequest } from './scripted-protocol';
import { runOk } from '../packages/test-utils/src/spawn';

/** One solid frame of the recorder's own viewport, drawn by ffmpeg so the mux
 *  is measured without a browser. */
async function viewportFrame(path: string, colour: string): Promise<void> {
  await runOk(['ffmpeg', '-y', '-v', 'error',
    '-f', 'lavfi', '-i', `color=c=${colour}:s=${String(VIEWPORT.width)}x${String(VIEWPORT.height)}`,
    '-frames:v', '1', path,
  ]);
}

describe('the recorder publishes the film at the width the README shows', () => {
  test("held frames mux to a GIF of the published width, at the viewport's aspect", async () => {
    const dir = scratchDir(`plan-demo-film-test-${String(process.pid)}`);
    await viewportFrame(join(dir, 'a.png'), 'black');
    await viewportFrame(join(dir, 'b.png'), 'gray');

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
  test("an off-grid hold reaches the GIF as a delay the film never planned", async () => {
    const dir = scratchDir(`plan-demo-film-tick-${String(process.pid)}`);
    await viewportFrame(join(dir, 'a.png'), 'black');
    await viewportFrame(join(dir, 'b.png'), 'gray');

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

  const read = readScriptedRequest(JSON.stringify({
    messages,
    tools: input.available.map((name) => ({ function: { name } })),
  }));

  if ('refusal' in read) throw new Error(read.refusal.body);

  return read.request;
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

    const opening = script(any);
    expect(opening.toolCall).toBeUndefined();
    expect(opening.text).toBeTruthy();
    expect(script(any).toolCall?.name).toBe('submit_plan');
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

    for (const step of [manifest, server]) expect(step.toolCall?.arguments).toMatchObject({ op: 'write' });
    expect(settled.toolCall).toBeUndefined();
    expect(settled.text).toBeTruthy();
  });
});

describe('a script reads what was asked, not the live state sent after it', () => {
  test('an ask the dynamic context and the unapproved instructions follow is still the ask', () => {
    // integration/0924: every request ended in the product's `<dynamic_context>` block, so the kept-tab script,
    // taking the last user message for the ask, answered the save with prose and the row waited out its tier.
    const asked = request({
      messages: [
        { role: 'user', content: KEPT_TAB_NOTE },
        { role: 'user', content: `${DYNAMIC_CONTEXT_OPEN_TAG} fingerprint="1" state="0">\n## Work mode\nMode: build\n</dynamic_context>` },
        { role: 'user', content: `<${WORKSPACE_INSTRUCTIONS_TAG}>\nFiles read from the workspace.\n</${WORKSPACE_INSTRUCTIONS_TAG}>` },
      ],
      available: ['file', 'memory'],
    });

    expect(keptTabProbe(asked)?.toolCall?.name).toBe('memory');
  });
});

/**
 * The plan-demo recorder's seam test: does a seek on the real timeline
 * photograph the beat it says it does, and does the GIF it muxes measure
 * what ffprobe measures?
 *
 * Both halves need the real gallery: the first because a cue only means
 * anything on the DOM the landing renders, the second because a GIF is a
 * binary whose correctness lives in its frame count and geometry — a
 * snapshot of "it ran" would pass on an empty file.
 */
import { describe, expect, test } from 'bun:test';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { scratchDir } from '../packages/test-utils/src/scratch';

import { withGallery } from './gallery-harness';
import { captureCueFrame, concatManifest, muxGif, probeGif } from './plan-demo-film';

/** Width/height out of a PNG's IHDR — the file's own claim, not ours. */
function pngSize(png: Uint8Array) {
  const signature = [0x89, 0x50, 0x4e, 0x47];
  const isPng = signature.every((byte, i) => png[i] === byte);

  if (!isPng) throw new Error('captureCueFrame did not return a PNG');

  const view = new DataView(png.buffer, png.byteOffset, png.byteLength);

  return { width: view.getUint32(16), height: view.getUint32(20) };
}

describe('plan-demo-film', () => {
  test('a named cue photographs that beat, and the muxed GIF measures what was shot', async () => {
    const dir = scratchDir(`plan-demo-film-test-${String(process.pid)}`);

    await withGallery(async ({ browser, origin }) => {
      const page = await browser.newPage();

      try {
        // The cue is resolved off the movie's own published table, so the
        // test follows the timeline when beats move. `planReady` is the
        // beat that puts the review on screen awaiting its decision.
        const { png, phase, stage } = await captureCueFrame(page, origin, { cue: 'planReady' });
        const size = pngSize(png);

        expect(phase).toBe('plan-review');
        expect(size).toEqual({ width: stage.width, height: stage.height });

        // Two distinct held frames — the asking state and the review —
        // mux into a two-frame GIF of exactly the stage's geometry.
        const asking = await captureCueFrame(page, origin, { at: 0 });
        writeFileSync(join(dir, 'a.png'), asking.png);
        writeFileSync(join(dir, 'b.png'), png);

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
        expect(facts.width).toBe(stage.width);
        expect(facts.height).toBe(stage.height);
        // The manifest's holds, per packet, in ffprobe's own seconds.
        expect(facts.packetDurations[0]).toBeCloseTo(0.4, 2);
        expect(facts.packetDurations[1]).toBeCloseTo(0.6, 2);
        expect(facts.packetDurations[2]).toBeCloseTo(0.04, 2);
      } finally {
        await page.close();
      }
    });
  }, 120_000);
});

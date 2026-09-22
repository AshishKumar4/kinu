import {
  draw, effect, frame, geometry, init, sampler, surface, target, VGPUError,
  type Draw, type Effect, type Geometry, type Gpu, type Surface, type Target,
} from 'vgpu';

import { VGPUError as CoreVGPUError } from '@vgpu/core';

import { renderThrownChain } from '@kinu.run/core/obs';
import { type ArtFrame, type ArtPalette, type ArtRenderer, NODE_STRIDE, PULSE_STRIDE, RECESS, STROKE_STRIDE } from '@kinu.run/core/web/art';
import blurSource from './blur.wgsl';
import brightSource from './bright.wgsl';
import compositeSource from './composite.wgsl';
import nodesSource from './nodes.wgsl';
import pulsesSource from './pulses.wgsl';
import strokesSource from './strokes.wgsl';

/** Instance capacity, sized above what any picture reaches: the search
 *  tree in an hour, the connectome's full mat (`MESH_SEGMENTS` plus its
 *  fusions) at birth. A frame past it draws its first strokes and drops
 *  the rest. */
const STROKE_CAPACITY = 16_384;

const NODE_CAPACITY = 1_024;

const PULSE_CAPACITY = 1_024;

const STROKE_SEGMENTS = 14;

/** The halo's weight over the scene: enough to read as light, not enough to lift the ground under the copy. */
const BLOOM_STRENGTH: Record<ArtPalette['mode'], number> = { dark: 0.7, light: 0.35 };

export type WebGpuRendererOutcome =
  | { readonly kind: 'renderer'; readonly renderer: ArtRenderer }
  | { readonly kind: 'unsupported'; readonly reason: string }
  | { readonly kind: 'failed'; readonly reason: string };

function paletteUniform(palette: ArtPalette) {
  const unit = ([red, green, blue]: ArtPalette['accent']): readonly number[] => [red / 255, green / 255, blue / 255, 1];

  return {
    accent: unit(palette.accent),
    bright: unit(palette.bright),
    ash: unit(palette.ash),
    ground: unit(palette.ground),
    mode: palette.mode === 'light' ? 1 : 0,
    recess: RECESS,
    pad1: 0,
    pad2: 0,
  };
}

function bloomSize(width: number, height: number): readonly [number, number] {
  return [Math.max(1, Math.ceil(width / 2)), Math.max(1, Math.ceil(height / 2))];
}

/**
 * The WebGPU drawing of the search tree, through vgpu: instanced stroke
 * strips and point quads into an HDR scene target, a bright pass and a
 * separable blur at half resolution, and a composite that adds the halo back
 * over a transparent canvas so the page's ground shows through.
 *
 * `init()` throwing `VGPU-RING1-UNSUPPORTED` is the one absence this module
 * expects — no WebGPU, or no adapter — and it comes back `unsupported`. Every
 * other way starting up can fail (no device, a shader the driver rejects,
 * init's own defect) comes back `failed` with the cause attached: the hero
 * falls back to Canvas2D on both, so nothing in here throws. A fault that
 * lands after a renderer exists is `onFault`'s, never a thrown listener.
 */
interface WebGpuRendererRequest {
  readonly canvas: HTMLCanvasElement;
  readonly initialPalette: ArtPalette;
  readonly width: number;
  readonly height: number;
  /** Device pixels per CSS pixel at the mount, before any resize. */
  readonly ratio: number;
}

export async function createWebGpuRenderer({
  canvas, initialPalette, width, height, ratio,
}: WebGpuRendererRequest): Promise<WebGpuRendererOutcome> {
  // `attempted` lets the catch release a gpu `init` already produced.
  let attempted: Gpu | null = null;
  // The live scale: every resize brings the ratio measured at that moment.
  let scale = ratio;

  try {
    const gpu = await init();
    attempted = gpu;

    const physical = (w: number, h: number): readonly [number, number] => [Math.max(1, Math.round(w * scale)), Math.max(1, Math.round(h * scale))];
    let size = physical(width, height);

    const canvasSurface: Surface = surface(gpu, canvas, {
      size, alphaMode: 'premultiplied', clearColor: [0, 0, 0, 0], label: 'hero',
    });

    const scene: Target = target(gpu, { size, format: 'rgba16float', clearColor: [0, 0, 0, 0], label: 'hero-scene' });
    const bloomA: Target = target(gpu, { size: bloomSize(size[0], size[1]), format: 'rgba16float', clearColor: [0, 0, 0, 0], label: 'hero-bloom-a' });
    const bloomB: Target = target(gpu, { size: bloomSize(size[0], size[1]), format: 'rgba16float', clearColor: [0, 0, 0, 0], label: 'hero-bloom-b' });
    const linear = sampler(gpu, { minFilter: 'linear', magFilter: 'linear', addressModeU: 'clamp-to-edge', addressModeV: 'clamp-to-edge' });

    const strokeData = new Float32Array(new ArrayBuffer(4 * STROKE_CAPACITY * STROKE_STRIDE));
    const nodeData = new Float32Array(new ArrayBuffer(4 * NODE_CAPACITY * NODE_STRIDE));
    const pulseData = new Float32Array(new ArrayBuffer(4 * PULSE_CAPACITY * PULSE_STRIDE));

    const strokeGeometry: Geometry = geometry(gpu, {
      buffers: [{ attributes: { curve: 'float32x4', tip: 'float32x4', look: 'float32x4' }, data: strokeData, stepMode: 'instance' }],
      vertexCount: (STROKE_SEGMENTS + 1) * 2,
      topology: 'triangle-strip',
      label: 'hero-strokes',
    });

    const nodeGeometry: Geometry = geometry(gpu, {
      buffers: [{ attributes: { point: 'float32x4', look: 'float32x4' }, data: nodeData, stepMode: 'instance' }],
      vertexCount: 6,
      label: 'hero-nodes',
    });

    const pulseGeometry: Geometry = geometry(gpu, {
      buffers: [{ attributes: { curve: 'float32x4', span: 'float32x4', look: 'float32x4', identity: 'float32x4' }, data: pulseData, stepMode: 'instance' }],
      vertexCount: (STROKE_SEGMENTS + 1) * 2,
      topology: 'triangle-strip',
      label: 'hero-pulses',
    });

    const view = () => ({ resolution: size, ratio: scale, time: 0 });

    const strokes: Draw = draw(gpu, {
      shader: strokesSource,
      geometry: strokeGeometry,
      blend: 'premultiplied',
      label: 'hero-strokes',
      set: { view: view(), palette: paletteUniform(initialPalette) },
    });

    const nodes: Draw = draw(gpu, {
      shader: nodesSource,
      geometry: nodeGeometry,
      blend: 'premultiplied',
      label: 'hero-nodes',
      set: { view: view(), palette: paletteUniform(initialPalette) },
    });

    const pulses: Draw = draw(gpu, {
      shader: pulsesSource,
      geometry: pulseGeometry,
      blend: 'premultiplied',
      label: 'hero-pulses',
      set: { view: view(), palette: paletteUniform(initialPalette) },
    });

    const bright: Effect = effect(gpu, brightSource, { label: 'hero-bright', set: { scene, samp: linear } });

    const blurH: Effect = effect(gpu, blurSource, {
      label: 'hero-blur-h',
      set: { source: bloomA, samp: linear, blur: { direction: [1, 0], texel: bloomA.texelSize } },
    });

    const blurV: Effect = effect(gpu, blurSource, {
      label: 'hero-blur-v',
      set: { source: bloomB, samp: linear, blur: { direction: [0, 1], texel: bloomB.texelSize } },
    });

    const composite: Effect = effect(gpu, compositeSource, {
      label: 'hero-composite',
      set: { scene, bloom: bloomA, samp: linear, composite: { strength: BLOOM_STRENGTH[initialPalette.mode], pad0: 0, pad1: 0, pad2: 0 } },
    });

    // A surface is only a target inside a frame; its signature pre-warms the
    // composite pipeline the same way.
    await Promise.all([
      strokes.compile(scene), pulses.compile(scene), nodes.compile(scene), bright.compile(bloomA),
      blurH.compile(bloomB), blurV.compile(bloomA), composite.compile({ colors: [canvasSurface.format] }),
    ]);

    let disposed = false;

    /** The fault the renderer died of, until `onFault` hands it to the mount. */
    let fault: Error | null = null;

    let faultHandler: ((error: Error) => void) | null = null;

    const renderer: ArtRenderer = {
      kind: 'webgpu',
      resize(nextWidth, nextHeight, nextRatio) {
        if (disposed) return;
        scale = nextRatio;
        size = physical(nextWidth, nextHeight);
        canvasSurface.resize(size);
        scene.resize(size);
        bloomA.resize(bloomSize(size[0], size[1]));
        bloomB.resize(bloomSize(size[0], size[1]));
        strokes.set({ view: view() });
        pulses.set({ view: view() });
        nodes.set({ view: view() });
        blurH.set({ blur: { texel: bloomA.texelSize } });
        blurV.set({ blur: { texel: bloomB.texelSize } });
      },
      setPalette(palette) {
        if (disposed) return;
        strokes.set({ palette: paletteUniform(palette) });
        pulses.set({ palette: paletteUniform(palette) });
        nodes.set({ palette: paletteUniform(palette) });
        composite.set({ composite: { strength: BLOOM_STRENGTH[palette.mode] } });
      },
      render(current: ArtFrame) {
        if (disposed) return;
        const strokeCount = Math.min(current.count, STROKE_CAPACITY);
        const nodeCount = Math.min(current.nodeCount, NODE_CAPACITY);
        const pulseCount = Math.min(current.pulseCount, PULSE_CAPACITY);

        try {
          // The writes are inside the try on purpose: `geometry.write` asserts
          // the device is usable too, and a device that died between ticks
          // throws the same DISPOSED/LOST here as `frame()` does below.
          if (strokeCount > 0) strokeGeometry.write(current.strokes.subarray(0, strokeCount * STROKE_STRIDE));

          if (nodeCount > 0) nodeGeometry.write(current.nodes.subarray(0, nodeCount * NODE_STRIDE));

          if (pulseCount > 0) pulseGeometry.write(current.pulses.subarray(0, pulseCount * PULSE_STRIDE));

          frame(gpu, (pass) => {
            pass.pass({ target: scene, clear: [0, 0, 0, 0] }, (encoder) => {
              encoder.draw(strokes, { instances: strokeCount });
              encoder.draw(pulses, { instances: pulseCount });
              encoder.draw(nodes, { instances: nodeCount });
            });
            pass.pass({ target: bloomA }, bright);
            pass.pass({ target: bloomB }, blurH);
            pass.pass({ target: bloomA }, blurV);
            pass.pass({ target: canvasSurface, clear: [0, 0, 0, 0] }, composite);
          });
        } catch (thrown) {
          // A dead device does not reach `gpu.onError` — `frame()` asserts
          // usability and throws. The guard's own type is @vgpu/core's
          // ValidationError, a sibling of vgpu's VGPUError rather than an
          // instance of it, so the check has to name the shared base class —
          // checking vgpu's VGPUError lets every real device loss escape,
          // the playback loop dies, and the mount stays on 'webgpu' with a
          // frozen frame. `DISPOSED` arriving while this renderer is alive
          // can only be a device the GPU half killed under itself, so both
          // codes are one fault here; anything else is a real bug and
          // propagates.
          if (thrown instanceof CoreVGPUError
            && (thrown.code === 'VGPU-DEVICE-LOST' || thrown.code === 'VGPU-DEVICE-DISPOSED')) {
            fault = thrown;
            renderer.dispose();
            faultHandler?.(thrown);

            return;
          }

          throw thrown;
        }
      },
      onFault(handler) {
        faultHandler = handler;

        if (fault !== null) handler(fault);
      },
      dispose() {
        if (disposed) return;
        disposed = true;
        stopListening();
        strokeGeometry.destroy();
        pulseGeometry.destroy();
        nodeGeometry.destroy();
        canvasSurface.dispose();
        gpu.dispose();
      },
    };

    // Registered once the renderer exists: a fault before this point is a
    // start failure the catch below already owns; after it, the renderer
    // stops itself and hands the mount its swap. A listener may not throw —
    // nothing out there catches it.
    const stopListening = gpu.onError((error) => {
      if (disposed) return;
      fault = error;
      renderer.dispose();
      faultHandler?.(error);
    });

    return { kind: 'renderer', renderer };
  } catch (cause) {
    if (cause instanceof VGPUError && cause.code === 'VGPU-RING1-UNSUPPORTED') {
      return { kind: 'unsupported', reason: cause.message };
    }

    let reason = `the hero could not start WebGPU: ${renderThrownChain({ cause })}`;

    try {
      attempted?.dispose();
    } catch (disposal) {
      reason = `${reason}; releasing it failed too: ${renderThrownChain({ cause: disposal })}`;
    }

    return { kind: 'failed', reason };
  }
}

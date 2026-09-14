import {
  draw, effect, frame, geometry, init, sampler, surface, target, VGPUError,
  type Draw, type Effect, type Geometry, type Gpu, type Surface, type Target,
} from 'vgpu';

import { NODE_STRIDE, STROKE_STRIDE, type HeroPalette, type SearchTreeFrame, type SearchTreeRenderer } from '@kinu.run/core/web/hero-art';
import blurSource from './blur.wgsl';
import brightSource from './bright.wgsl';
import compositeSource from './composite.wgsl';
import nodesSource from './nodes.wgsl';
import strokesSource from './strokes.wgsl';

/** Instance capacity, sized above what the simulation reaches in an hour;
 *  a frame past it draws its first strokes and drops the rest. */
const STROKE_CAPACITY = 2_048;

const NODE_CAPACITY = 1_024;

const STROKE_SEGMENTS = 14;

const BLOOM_STRENGTH: Record<HeroPalette['mode'], number> = { dark: 1.15, light: 0.55 };

export type WebGpuRendererOutcome =
  | { readonly kind: 'renderer'; readonly renderer: SearchTreeRenderer }
  | { readonly kind: 'unsupported'; readonly reason: string };

function paletteUniform(palette: HeroPalette) {
  const unit = ([red, green, blue]: HeroPalette['accent']): readonly number[] => [red / 255, green / 255, blue / 255, 1];

  return {
    accent: unit(palette.accent),
    bright: unit(palette.bright),
    ash: unit(palette.ash),
    mode: palette.mode === 'light' ? 1 : 0,
    pad0: 0,
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
 * expects — no WebGPU, or no adapter — and it comes back as an outcome the
 * hero falls back on. Any other failure is a defect and is rethrown.
 */
export async function createWebGpuRenderer(
  canvas: HTMLCanvasElement,
  initialPalette: HeroPalette,
  width: number,
  height: number,
  ratio: number,
): Promise<WebGpuRendererOutcome> {
  let gpu: Gpu;

  try {
    gpu = await init();
  } catch (cause) {
    if (cause instanceof VGPUError && cause.code === 'VGPU-RING1-UNSUPPORTED') {
      return { kind: 'unsupported', reason: cause.message };
    }

    throw new Error('the hero could not start WebGPU', { cause });
  }

  const stopListening = gpu.onError((error) => {
    throw new Error('the hero renderer failed on the GPU', { cause: error });
  });

  const physical = (w: number, h: number): readonly [number, number] => [Math.max(1, Math.round(w * ratio)), Math.max(1, Math.round(h * ratio))];
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

  const view = () => ({ resolution: size, ratio, time: 0 });

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
    strokes.compile(scene), nodes.compile(scene), bright.compile(bloomA),
    blurH.compile(bloomB), blurV.compile(bloomA), composite.compile({ colors: [canvasSurface.format] }),
  ]);

  let disposed = false;

  return {
    kind: 'renderer',
    renderer: {
      kind: 'webgpu',
      resize(nextWidth, nextHeight, nextRatio) {
        if (disposed) return;
        ratio = nextRatio;
        size = physical(nextWidth, nextHeight);
        canvasSurface.resize(size);
        scene.resize(size);
        bloomA.resize(bloomSize(size[0], size[1]));
        bloomB.resize(bloomSize(size[0], size[1]));
        strokes.set({ view: view() });
        nodes.set({ view: view() });
        blurH.set({ blur: { texel: bloomA.texelSize } });
        blurV.set({ blur: { texel: bloomB.texelSize } });
      },
      setPalette(palette) {
        if (disposed) return;
        strokes.set({ palette: paletteUniform(palette) });
        nodes.set({ palette: paletteUniform(palette) });
        composite.set({ composite: { strength: BLOOM_STRENGTH[palette.mode] } });
      },
      render(current: SearchTreeFrame) {
        if (disposed) return;
        const strokeCount = Math.min(current.count, STROKE_CAPACITY);
        const nodeCount = Math.min(current.nodeCount, NODE_CAPACITY);

        if (strokeCount > 0) strokeGeometry.write(current.strokes.subarray(0, strokeCount * STROKE_STRIDE));

        if (nodeCount > 0) nodeGeometry.write(current.nodes.subarray(0, nodeCount * NODE_STRIDE));

        frame(gpu, (pass) => {
          pass.pass({ target: scene, clear: [0, 0, 0, 0] }, (encoder) => {
            encoder.draw(strokes, { instances: strokeCount });
            encoder.draw(nodes, { instances: nodeCount });
          });
          pass.pass({ target: bloomA }, bright);
          pass.pass({ target: bloomB }, blurH);
          pass.pass({ target: bloomA }, blurV);
          pass.pass({ target: canvasSurface, clear: [0, 0, 0, 0] }, composite);
        });
      },
      dispose() {
        if (disposed) return;
        disposed = true;
        stopListening();
        strokeGeometry.destroy();
        nodeGeometry.destroy();
        canvasSurface.dispose();
        gpu.dispose();
      },
    },
  };
}

/**
 * The living search tree: attempts branch rightward from one seed, every tip
 * carries the score its verifier returned, weak attempts dim to embers and
 * are pruned, the best lineage brightens and keeps growing, and every so
 * often the search restarts from the best frontier — the evolution loop.
 *
 * Pure and deterministic: the same seed and the same sequence of `step(dt)`
 * calls produce the same frames on any runtime. There is no DOM here and no
 * drawing; a renderer reads `frame()` and draws what it says. The pointer
 * never touches the random stream, so a pointer can bend the picture without
 * changing what the search does.
 *
 * Coordinates are view-normalised: x and y run 0..1 across the drawn box,
 * x left to right, y top to bottom. `aspect` (height / width) makes distances
 * isotropic on screen, so a radius reads the same in both directions.
 */

export const STROKE_STRIDE = 12;

/** Seven fields and one pad, so a node is two vec4 attributes on the GPU. */
export const NODE_STRIDE = 8;

/** How far the pointer may displace a tip, in view width units. */
const MAX_BEND = 0.028;

/** The pointer's reach, in view width units. */
const POINTER_RADIUS = 0.17;

export type BranchPhase = 'growing' | 'alive' | 'ember' | 'ash';

/** The stroke tone a renderer resolves through the palette. */
const TONE_ACCENT = 0;

export const TONE_BRIGHT = 1;

export const TONE_ASH = 2;

export const TONE_EMBER = 3;

interface Branch {
  readonly id: number;
  readonly parent: number;
  readonly layer: number;
  readonly depth: number;
  /** World coordinates: the layer's camera offset is applied at frame time. */
  readonly x0: number;
  readonly y0: number;
  readonly cx: number;
  readonly cy: number;
  readonly x1: number;
  readonly y1: number;
  readonly angle: number;
  /** This attempt's own result, fixed at birth: verifier progress, unbounded. */
  readonly score: number;
  readonly growthSeconds: number;
  readonly grace: number;
  /** The best result anywhere under this branch, backed up as children land. */
  value: number;
  progress: number;
  phase: BranchPhase;
  phaseAge: number;
  liveChildren: number;
  expanded: boolean;
  spawnAt: number;
  onPath: boolean;
  bendX: number;
  bendY: number;
  boost: number;
  /** The drawn look, eased toward what the phase asks so a cut fades. */
  tone: number;
  glow: number;
  alpha: number;
  width: number;
  outX0: number;
  outY0: number;
  outCx: number;
  outCy: number;
  outX1: number;
  outY1: number;
}

interface Spark {
  readonly layer: number;
  x: number;
  y: number;
  readonly vx: number;
  readonly vy: number;
  age: number;
  readonly life: number;
  readonly size: number;
}

interface LayerRules {
  readonly foreground: boolean;
  /** Seconds between evolution restarts. */
  readonly generationSeconds: number;
  readonly rootX: number;
  readonly rootY: number;
  readonly stepLength: number;
  readonly growthSeconds: number;
  readonly population: number;
  readonly width: number;
  readonly alpha: number;
  /** Pointer parallax: how far the layer drifts with the pointer. */
  readonly drift: number;
}

/** The seed sits right of the copy's column and below the headline's band
 *  (the mount hands the tree that band as a keep-out); the deeper layers
 *  start from their own seeds, smaller, slower, and fainter, and drift with
 *  the pointer the way a far plane does. */
const LAYERS: readonly LayerRules[] = [
  { foreground: true, generationSeconds: 24, rootX: 0.5, rootY: 0.58, stepLength: 0.062, growthSeconds: 1.15, population: 240, width: 1.25, alpha: 0.8, drift: 0 },
  { foreground: false, generationSeconds: 31, rootX: 0.58, rootY: 0.72, stepLength: 0.05, growthSeconds: 1.5, population: 120, width: 0.9, alpha: 0.34, drift: 0.012 },
  { foreground: false, generationSeconds: 37, rootX: 0.74, rootY: 0.3, stepLength: 0.042, growthSeconds: 2, population: 80, width: 0.7, alpha: 0.2, drift: 0.026 },
];

/** Scores are unbounded verifier progress: root 0, each attempt its parent's
 *  plus a gain that is usually small and sometimes negative. Margins below are
 *  in the same units, so pruning behaves the same at every depth. */
const ROOT_SCORE = 0;

/** Below this distance behind the best result a lineage is cut. */
const PRUNE_MARGIN = 0.4;

/** An attempt this far below its parent failed and dims on its own. */
const FAIL_MARGIN = 0.12;

/** How far behind the frontier a branch is still drawn bright. */
const GLOW_SPAN = 0.5;

const EMBER_SECONDS = 1.3;

const ASH_SECONDS = 4;

/** Past this the picture has left the view; a branch there spawns nothing. */
const RIGHT_EDGE = 0.94;

/** The camera follows the best frontier once it reaches this far across,
 *  so the search keeps advancing and its history recedes to the left. */
const FOLLOW_X = 0.8;

/** The camera parks the best frontier here after a restart, or right of
 *  the keep-out when one is set, so the strongest branch never sits behind
 *  the headline. */
const REGROW_X = 0.5;

/** History recedes: left of here a branch fades, gone before the edge. */
const HISTORY_X = 0.34;

const REGROW_DELAY = 1.1;

/** The camera is a critically damped follow: it leaves rest gently, never
 *  passes PAN_SPEED (view widths per second) or changes speed faster than
 *  PAN_ACCEL, and settles on its target without overshoot. Measured
 *  2026-09-14: a first-order ease moved the picture 0.014 view widths in
 *  the one frame after a restart, from near rest; the cap here is 0.004. */
const PAN_OMEGA = 1.3;

const PAN_SPEED = 0.25;

const PAN_ACCEL = 0.6;

/** How fast a branch's drawn look follows its phase: a prune or a restart
 *  reads as a fade of about a quarter second, never a one-frame cut. */
const LOOK_RATE = 4;

const BEND_RATE = 7;

const Y_MIN = 0.07;

const Y_MAX = 0.93;

/** How far outside the keep-out a tip must land, in view units. */
const KEEP_OUT_MARGIN = 0.03;

/** Every stroke colour recedes this far toward the page's ground before it
 *  is drawn, on the GPU and on the CPU alike: the art sits behind the copy.
 *  Measured 2026-09-14 on the dark ground: the kept path's gold reads 8.9:1
 *  against the ground unmixed and 4.6:1 at this mix. */
export const RECESS = 0.32;

interface LayerState {
  readonly rules: LayerRules;
  readonly branches: Map<number, Branch>;
  readonly random: () => number;
  offset: number;
  offsetTarget: number;
  /** The camera's speed, view widths per second. */
  velocity: number;
  generationStart: number;
  regrowAt: number;
  bestId: number;
  pruned: number;
  hidden: number;
}

export interface SearchTreeFrame {
  /** `count` strokes of STROKE_STRIDE floats: x0 y0 cx cy x1 y1 t width glow tone alpha layer. */
  readonly strokes: Float32Array<ArrayBuffer>;
  readonly count: number;
  /** `nodeCount` points of NODE_STRIDE floats: x y radius glow tone alpha layer pad. */
  readonly nodes: Float32Array<ArrayBuffer>;
  readonly nodeCount: number;
  readonly time: number;
  readonly generation: number;
  /** Cumulative branches the search pruned, foreground layer. */
  readonly pruned: number;
  /** Cumulative descendants cut with a pruned ancestor, foreground layer. */
  readonly hidden: number;
}

export interface SearchTreeOptions {
  readonly seed: number;
  /** Height over width of the drawn box. */
  readonly aspect: number;
}

/** A box in view units no tip may land in: the headline's, so no branch
 *  crosses behind the copy. Growth that would enter it turns away, the
 *  way it turns at the top and bottom of the view. */
export interface KeepOut {
  readonly left: number;
  readonly top: number;
  readonly right: number;
  readonly bottom: number;
}

/** The pointer's contract: it reaches this far and displaces at most this much. */
export interface PointerReach {
  readonly radius: number;
  readonly maxBend: number;
}

/** The camera's contract: the picture never moves faster than this, in view widths per second. */
export interface PanReach {
  readonly maxSpeed: number;
}

/** mulberry32: small, fast, and identical on every engine. */
export function seededRandom(seed: number): () => number {
  let state = seed >>> 0;

  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let mixed = Math.imul(state ^ (state >>> 15), 1 | state);
    mixed = (mixed + Math.imul(mixed ^ (mixed >>> 7), 61 | mixed)) ^ mixed;

    return ((mixed ^ (mixed >>> 14)) >>> 0) / 4_294_967_296;
  };
}

function clamp(value: number, low: number, high: number): number {
  return value < low ? low : value > high ? high : value;
}

/** Growth eased so a branch shoots out and settles, as a stroke of ink would. */
function easeGrowth(progress: number): number {
  return 1 - (1 - progress) ** 2.6;
}

function pointOnCurve(branch: Branch, t: number): readonly [number, number] {
  const inverse = 1 - t;
  const weight0 = inverse * inverse;
  const weight1 = 2 * inverse * t;
  const weight2 = t * t;

  return [
    weight0 * branch.x0 + weight1 * branch.cx + weight2 * branch.x1,
    weight0 * branch.y0 + weight1 * branch.cy + weight2 * branch.y1,
  ];
}

export class SearchTree {
  static readonly pointer: PointerReach = { radius: POINTER_RADIUS, maxBend: MAX_BEND };

  static readonly pan: PanReach = { maxSpeed: PAN_SPEED };

  private readonly layers: LayerState[];

  private readonly sparks: Spark[] = [];

  private aspect: number;

  private nextId = 1;

  private elapsed = 0;

  private generation = 0;

  private pointerX: number | null = null;

  private pointerY: number | null = null;

  /** The parallax the far layers drift by, eased toward the pointer so a
   *  pointer entering or leaving the stage never moves them in one frame. */
  private driftX = 0;

  private driftY = 0;

  private keepOut: KeepOut | null = null;

  private strokes = new Float32Array(new ArrayBuffer(4 * STROKE_STRIDE * 512));

  private nodes = new Float32Array(new ArrayBuffer(4 * NODE_STRIDE * 256));

  constructor(options: SearchTreeOptions) {
    this.aspect = options.aspect;
    this.layers = LAYERS.map((rules, index) => this.seedLayer(rules, index, options.seed + index * 7919));
  }

  get time(): number {
    return this.elapsed;
  }

  setAspect(aspect: number): void {
    this.aspect = aspect;
  }

  setKeepOut(box: KeepOut | null): void {
    this.keepOut = box;
  }

  setPointer(x: number, y: number): void {
    this.pointerX = x;
    this.pointerY = y;
  }

  clearPointer(): void {
    this.pointerX = null;
    this.pointerY = null;
  }

  /** The ids of the best lineage, root first, foreground layer. */
  bestPath(): number[] {
    const layer = this.layers[0];

    if (layer === undefined) return [];
    const path: number[] = [];

    for (let branch = layer.branches.get(layer.bestId); branch !== undefined; branch = layer.branches.get(branch.parent)) {
      path.push(branch.id);
    }

    return path.reverse();
  }

  /** The score and backed-up value of one foreground branch, for tests. */
  inspect(id: number): { readonly score: number; readonly value: number; readonly phase: BranchPhase; readonly parent: number } | undefined {
    const branch = this.layers[0]?.branches.get(id);

    return branch === undefined ? undefined : { score: branch.score, value: branch.value, phase: branch.phase, parent: branch.parent };
  }

  /** Every foreground branch still in the picture, with its phase. */
  living(): readonly { readonly id: number; readonly phase: BranchPhase; readonly value: number; readonly age: number }[] {
    const layer = this.layers[0];

    if (layer === undefined) return [];

    return [...layer.branches.values()].map((branch) => ({ id: branch.id, phase: branch.phase, value: branch.value, age: branch.phaseAge }));
  }

  /** Plant a new attempt at the frontier tip nearest the given view point. */
  plant(x: number, y: number): void {
    const layer = this.layers[0];

    if (layer === undefined) return;
    let nearest: Branch | undefined;
    let nearestDistance = Number.POSITIVE_INFINITY;

    for (const branch of layer.branches.values()) {
      if (branch.phase !== 'alive' || branch.liveChildren > 0) continue;
      const distance = this.distance(branch.x1 - layer.offset, branch.y1, x, y);

      if (distance < nearestDistance) {
        nearestDistance = distance;
        nearest = branch;
      }
    }

    if (nearest === undefined) return;
    const toward = Math.atan2((y - nearest.y1) * this.aspect, x + layer.offset - nearest.x1);
    this.spawn(layer, nearest, clamp(toward, -1.1, 1.1), 1.15);
  }

  /** Force the foreground's evolution restart now, for tests. */
  evolve(): void {
    const layer = this.layers[0];

    if (layer !== undefined) this.restart(layer);
  }

  step(dt: number): void {
    this.elapsed += dt;
    this.settleDrift(dt);

    for (const layer of this.layers) this.stepLayer(layer, dt);
    this.stepSparks(dt);
  }

  frame(): SearchTreeFrame {
    let count = 0;
    let nodeCount = 0;

    for (const layer of this.layers) {
      const shiftX = -layer.offset - this.driftX * layer.rules.drift;
      const shiftY = -this.driftY * layer.rules.drift * this.aspect;

      for (const branch of layer.branches.values()) {
        const parent = layer.branches.get(branch.parent);
        branch.outX1 = branch.x1 + shiftX + branch.bendX;
        branch.outY1 = branch.y1 + shiftY + branch.bendY;
        branch.outCx = branch.cx + shiftX + branch.bendX * 0.6;
        branch.outCy = branch.cy + shiftY + branch.bendY * 0.6;

        if (parent === undefined) {
          branch.outX0 = branch.outX1;
          branch.outY0 = branch.outY1;
        } else {
          branch.outX0 = parent.outX1;
          branch.outY0 = parent.outY1;
        }

        if (branch.parent < 0) {
          nodeCount = this.pushNode(nodeCount, branch.outX1, branch.outY1, 3.4 * layer.rules.width, 0.6, TONE_BRIGHT, 0.8 * layer.rules.alpha, branch.layer);
          continue;
        }

        if (branch.outX1 < -0.05 && branch.outX0 < -0.05) continue;
        const glow = clamp(branch.glow + branch.boost * 0.5, 0, 1);
        const recede = clamp((branch.outX1 + 0.04) / HISTORY_X, 0, 1);
        const alpha = clamp(branch.alpha + branch.boost * 0.3, 0, 1) * layer.rules.alpha * recede;
        count = this.pushStroke(count, branch, easeGrowth(branch.progress), branch.width, glow, branch.tone, alpha);

        if (branch.phase === 'alive' && (branch.liveChildren === 0 || branch.id === layer.bestId)) {
          const radius = branch.id === layer.bestId ? 3.2 * layer.rules.width : 1.9 * layer.rules.width;
          nodeCount = this.pushNode(nodeCount, branch.outX1, branch.outY1, radius, glow, branch.tone, alpha, branch.layer);
        }
      }
    }

    for (const spark of this.sparks) {
      const layer = this.layers[spark.layer];

      if (layer === undefined) continue;
      const life = 1 - spark.age / spark.life;
      const shiftX = -layer.offset - this.driftX * layer.rules.drift;
      const shiftY = -this.driftY * layer.rules.drift * this.aspect;
      nodeCount = this.pushNode(nodeCount, spark.x + shiftX, spark.y + shiftY, spark.size * life, 0.7 * life, TONE_EMBER, 0.75 * life * layer.rules.alpha, spark.layer);
    }

    const foreground = this.layers[0];

    return {
      strokes: this.strokes,
      count,
      nodes: this.nodes,
      nodeCount,
      time: this.elapsed,
      generation: this.generation,
      pruned: foreground?.pruned ?? 0,
      hidden: foreground?.hidden ?? 0,
    };
  }

  private pushStroke(count: number, branch: Branch, t: number, width: number, glow: number, tone: number, alpha: number): number {
    if ((count + 1) * STROKE_STRIDE > this.strokes.length) {
      const grown = new Float32Array(new ArrayBuffer(this.strokes.byteLength * 2));
      grown.set(this.strokes);
      this.strokes = grown;
    }

    const at = count * STROKE_STRIDE;
    const strokes = this.strokes;
    strokes[at] = branch.outX0;
    strokes[at + 1] = branch.outY0;
    strokes[at + 2] = branch.outCx;
    strokes[at + 3] = branch.outCy;
    strokes[at + 4] = branch.outX1;
    strokes[at + 5] = branch.outY1;
    strokes[at + 6] = t;
    strokes[at + 7] = width;
    strokes[at + 8] = glow;
    strokes[at + 9] = tone;
    strokes[at + 10] = alpha;
    strokes[at + 11] = branch.layer;

    return count + 1;
  }

  private pushNode(count: number, x: number, y: number, radius: number, glow: number, tone: number, alpha: number, layer: number): number {
    if ((count + 1) * NODE_STRIDE > this.nodes.length) {
      const grown = new Float32Array(new ArrayBuffer(this.nodes.byteLength * 2));
      grown.set(this.nodes);
      this.nodes = grown;
    }

    const at = count * NODE_STRIDE;
    const nodes = this.nodes;
    nodes[at] = x;
    nodes[at + 1] = y;
    nodes[at + 2] = radius;
    nodes[at + 3] = glow;
    nodes[at + 4] = tone;
    nodes[at + 5] = alpha;
    nodes[at + 6] = layer;
    nodes[at + 7] = 0;

    return count + 1;
  }

  /** Lengths are fractions of the width; a box taller than wide (a phone)
   *  would grow a tree too small to read, so they scale up with the aspect. */
  private reach(): number {
    return Math.max(1, this.aspect);
  }

  private distance(x0: number, y0: number, x1: number, y1: number): number {
    const dx = x1 - x0;
    const dy = (y1 - y0) * this.aspect;

    return Math.sqrt(dx * dx + dy * dy);
  }

  private seedLayer(rules: LayerRules, index: number, seed: number): LayerState {
    const random = seededRandom(seed);
    const id = this.nextId++;

    const root: Branch = {
      id,
      parent: -1,
      layer: index,
      depth: 0,
      x0: rules.rootX,
      y0: rules.rootY,
      cx: rules.rootX,
      cy: rules.rootY,
      x1: rules.rootX,
      y1: rules.rootY,
      angle: 0,
      score: ROOT_SCORE,
      growthSeconds: 1,
      grace: 0,
      value: ROOT_SCORE,
      progress: 1,
      phase: 'alive',
      phaseAge: 0,
      liveChildren: 0,
      expanded: false,
      spawnAt: 0.15 * (index + 1),
      onPath: true,
      bendX: 0,
      bendY: 0,
      boost: 0,
      tone: TONE_BRIGHT,
      glow: 0,
      alpha: 0,
      width: 0,
      outX0: 0,
      outY0: 0,
      outCx: 0,
      outCy: 0,
      outX1: 0,
      outY1: 0,
    };

    return {
      rules,
      branches: new Map([[id, root]]),
      random,
      offset: 0,
      offsetTarget: 0,
      velocity: 0,
      generationStart: 0,
      regrowAt: -1,
      bestId: id,
      pruned: 0,
      hidden: 0,
    };
  }

  private stepLayer(layer: LayerState, dt: number): void {
    this.pan(layer, dt);
    let population = 0;

    for (const branch of layer.branches.values()) {
      branch.phaseAge += dt;

      if (branch.phase === 'growing') {
        branch.progress = Math.min(1, branch.progress + dt / branch.growthSeconds);

        if (branch.progress >= 1) {
          branch.phase = 'alive';
          branch.phaseAge = 0;
          branch.spawnAt = this.elapsed + 0.2 + 0.45 * layer.random();
        }
      }

      if (branch.phase === 'growing' || branch.phase === 'alive') population += 1;
    }

    this.backUp(layer);
    this.markPath(layer);
    this.prune(layer);
    this.settleLooks(layer, dt);

    // Children spawned here join the walk at its end, still growing, and
    // match none of the branches below; a deleted entry is simply skipped.
    for (const branch of layer.branches.values()) {
      if (branch.phase === 'alive' && !branch.expanded && this.elapsed >= branch.spawnAt && population < layer.rules.population) {
        population += this.expand(layer, branch);
      }

      if (branch.phase === 'ember' && branch.phaseAge >= EMBER_SECONDS) {
        branch.phase = 'ash';
        branch.phaseAge = 0;
      } else if (branch.phase === 'ash' && branch.phaseAge >= ASH_SECONDS) {
        layer.branches.delete(branch.id);
      } else if (!branch.onPath && branch.x1 - layer.offset < -0.2 && branch.x0 - layer.offset < -0.2) {
        layer.branches.delete(branch.id);
      }
    }

    if (layer.rules.foreground) this.bend(layer, dt);
    const best = layer.branches.get(layer.bestId);

    if (best !== undefined && best.x1 - layer.offsetTarget > FOLLOW_X) layer.offsetTarget = best.x1 - FOLLOW_X;

    if (layer.regrowAt >= 0 && this.elapsed >= layer.regrowAt) {
      layer.regrowAt = -1;
      this.regrow(layer);
    } else if (layer.regrowAt < 0 && this.elapsed - layer.generationStart >= layer.rules.generationSeconds) {
      this.restart(layer);
    }
  }

  /** A critically damped follow with a speed cap: the camera leaves rest
   *  gently and settles on its target without overshoot, so the picture
   *  never moves faster than `SearchTree.pan.maxSpeed`. */
  private pan(layer: LayerState, dt: number): void {
    const gap = layer.offsetTarget - layer.offset;
    const pull = clamp(PAN_OMEGA * PAN_OMEGA * gap - 2 * PAN_OMEGA * layer.velocity, -PAN_ACCEL, PAN_ACCEL);
    layer.velocity = clamp(layer.velocity + pull * dt, -PAN_SPEED, PAN_SPEED);
    layer.offset += layer.velocity * dt;
  }

  /** The far layers' parallax follows the pointer at the bend's own rate,
   *  and returns to rest when it leaves. */
  private settleDrift(dt: number): void {
    const ease = 1 - Math.exp(-dt * BEND_RATE);
    const targetX = this.pointerX === null ? 0 : this.pointerX - 0.5;
    const targetY = this.pointerY === null ? 0 : this.pointerY - 0.5;
    this.driftX += (targetX - this.driftX) * ease;
    this.driftY += (targetY - this.driftY) * ease;
  }

  /** What a branch's phase asks it to look like this instant. */
  private lookOf(layer: LayerState, branch: Branch, bestValue: number): readonly [tone: number, glow: number, alpha: number, width: number] {
    if (branch.phase === 'ember') {
      const fade = 1 - branch.phaseAge / EMBER_SECONDS;

      return [TONE_EMBER, 0.2 + 0.3 * fade, 0.18 + 0.34 * fade, layer.rules.width * 0.9];
    }

    if (branch.phase === 'ash') return [TONE_ASH, 0, 0.1 * (1 - branch.phaseAge / ASH_SECONDS), layer.rules.width * 0.75];

    if (branch.onPath) {
      const lead = clamp(1 - (bestValue - branch.value) / (GLOW_SPAN * 3), 0, 1);

      return [TONE_BRIGHT, 0.5 + 0.35 * lead, 0.78, layer.rules.width * (1.4 + 0.7 * lead)];
    }

    const strength = clamp(1 - (bestValue - branch.value) / GLOW_SPAN, 0, 1);

    return [TONE_ACCENT, 0.12 + 0.68 * strength, 0.34 + 0.3 * strength, layer.rules.width * (0.85 + 0.65 * strength)];
  }

  private bestValueOf(layer: LayerState): number {
    return layer.branches.get(layer.bestId)?.value ?? ROOT_SCORE;
  }

  /** Move a branch's drawn look toward what its phase asks by `mix` of the gap. */
  private dress(layer: LayerState, branch: Branch, bestValue: number, mix: number): void {
    const [tone, glow, alpha, width] = this.lookOf(layer, branch, bestValue);
    branch.tone = tone;
    branch.glow += (glow - branch.glow) * mix;
    branch.alpha += (alpha - branch.alpha) * mix;
    branch.width += (width - branch.width) * mix;
  }

  /** Every branch's drawn look eases toward what its phase asks, so a prune
   *  or a restart is a fade and never a one-frame cut. */
  private settleLooks(layer: LayerState, dt: number): void {
    const bestValue = this.bestValueOf(layer);
    const ease = 1 - Math.exp(-dt * LOOK_RATE);

    for (const branch of layer.branches.values()) this.dress(layer, branch, bestValue, ease);
  }

  private backUp(layer: LayerState): void {
    let bestId = layer.bestId;
    let bestValue = Number.NEGATIVE_INFINITY;

    for (const branch of layer.branches.values()) branch.value = branch.score;

    // Children carry larger ids than their parents, so a reverse walk backs
    // every subtree's best result up before its parent is read.
    for (const branch of [...layer.branches.values()].reverse()) {
      if (branch.phase !== 'growing' && branch.phase !== 'alive') continue;
      const parent = layer.branches.get(branch.parent);

      if (parent !== undefined && branch.value > parent.value) parent.value = branch.value;

      if (branch.score > bestValue || (branch.score === bestValue && branch.id < bestId)) {
        bestValue = branch.score;
        bestId = branch.id;
      }
    }

    layer.bestId = bestId;
  }

  /** Follow the backed-up value down from the root: the kept lineage. */
  private markPath(layer: LayerState): void {
    for (const branch of layer.branches.values()) branch.onPath = false;
    let current = layer.branches.get(layer.bestId);

    while (current !== undefined) {
      current.onPath = true;
      current = layer.branches.get(current.parent);
    }
  }

  private prune(layer: LayerState): void {
    const bestValue = this.bestValueOf(layer);

    for (const branch of layer.branches.values()) {
      if (branch.phase !== 'alive' || branch.onPath || branch.phaseAge < branch.grace) continue;
      const parent = layer.branches.get(branch.parent);
      const failed = parent !== undefined && branch.score < parent.score - FAIL_MARGIN && branch.liveChildren === 0;
      const outrun = branch.value < bestValue - PRUNE_MARGIN;

      if (failed || outrun) this.cut(layer, branch, true);
    }
  }

  private cut(layer: LayerState, branch: Branch, counted: boolean): void {
    if (branch.phase === 'ember' || branch.phase === 'ash') return;
    branch.phase = 'ember';
    branch.phaseAge = 0;
    const parent = layer.branches.get(branch.parent);

    if (parent !== undefined) parent.liveChildren -= 1;

    if (counted) layer.pruned += 1;

    for (const child of layer.branches.values()) {
      if (child.parent !== branch.id) continue;

      if (child.phase === 'growing' || child.phase === 'alive') {
        layer.hidden += 1;
        this.cut(layer, child, false);
      }
    }

    const sparkCount = 1 + Math.floor(layer.random() * 3);

    for (let index = 0; index < sparkCount; index += 1) {
      const along = 0.3 + 0.7 * layer.random();
      const [x, y] = pointOnCurve(branch, along);

      this.sparks.push({
        layer: branch.layer,
        x,
        y,
        vx: 0.004 + layer.random() * 0.012,
        vy: -(0.008 + layer.random() * 0.02),
        age: 0,
        life: 0.7 + layer.random() * 0.7,
        size: (0.9 + layer.random() * 1.1) * layer.rules.width,
      });
    }
  }

  private expand(layer: LayerState, branch: Branch): number {
    branch.expanded = true;
    const parent = layer.branches.get(branch.parent);
    const improved = parent === undefined || branch.score >= parent.score;
    const roll = layer.random();
    let children: number;

    if (parent === undefined) children = 4;
    else if (improved) children = roll < 0.2 ? 2 : roll < 0.7 ? 3 : 4;
    else children = roll < 0.4 ? 0 : roll < 0.8 ? 1 : 2;

    // Past the view's edge, or behind the headline, an attempt spawns nothing.
    if (branch.x1 - layer.offset > RIGHT_EDGE || this.inKeepOut(branch.x1 - layer.offset, branch.y1)) children = 0;

    // Siblings fan out around the parent's own heading, so a subtree keeps
    // to its band instead of crossing its neighbours.
    let spawned = 0;

    for (let index = 0; index < children; index += 1) {
      const fan = children === 1 ? 0 : (index / (children - 1) - 0.5) * 0.85;
      const jitter = (layer.random() - 0.5) * 0.3;

      if (this.spawn(layer, branch, branch.angle * 0.55 + fan + jitter, 1)) spawned += 1;
    }

    return spawned;
  }

  /** Grow one attempt from `parent`; false when the only place it could
   *  land is behind the headline, in which case nothing is grown. */
  private spawn(layer: LayerState, parent: Branch, angle: number, reach: number): boolean {
    const rules = layer.rules;
    const length = rules.stepLength * this.reach() * reach * (0.8 + layer.random() * 0.5);
    let heading = clamp(angle, -1.2, 1.2);
    let y1 = parent.y1 + Math.sin(heading) * length / this.aspect;

    if (y1 < Y_MIN || y1 > Y_MAX) {
      heading = -heading * 0.7;
      y1 = clamp(parent.y1 + Math.sin(heading) * length / this.aspect, Y_MIN, Y_MAX);
    }

    const away = this.turnAway(layer, parent, heading, length, y1);

    if (away !== null) {
      heading = away;
      y1 = clamp(parent.y1 + Math.sin(heading) * length / this.aspect, Y_MIN, Y_MAX);
    }

    const x1 = parent.x1 + Math.cos(heading) * length;

    if (this.inKeepOut(x1 - layer.offset, y1)) return false;
    // A branch bows away from its parent's line, the way a fan opens.
    const bow = (0.1 + layer.random() * 0.35) * length * Math.sign(heading - parent.angle || 1);
    const noise = (layer.random() + layer.random() + layer.random() - 1.5) * 0.35;
    const score = parent.score + 0.03 + noise;
    const id = this.nextId++;

    const branch: Branch = {
      id,
      parent: parent.id,
      layer: parent.layer,
      depth: parent.depth + 1,
      x0: parent.x1,
      y0: parent.y1,
      cx: (parent.x1 + x1) / 2 - Math.sin(heading) * bow,
      cy: (parent.y1 + y1) / 2 + Math.cos(heading) * bow / this.aspect,
      x1,
      y1,
      angle: heading,
      score,
      // The first levels shoot out fast so the picture is alive at once.
      growthSeconds: rules.growthSeconds * (0.8 + layer.random() * 0.5) * (parent.depth < 3 ? 0.55 : 1),
      grace: 0.7 + layer.random() * 1.1,
      value: score,
      progress: 0,
      phase: 'growing',
      phaseAge: 0,
      liveChildren: 0,
      expanded: false,
      spawnAt: 0,
      onPath: false,
      bendX: 0,
      bendY: 0,
      boost: 0,
      tone: TONE_ACCENT,
      glow: 0,
      alpha: 0,
      width: 0,
      outX0: 0,
      outY0: 0,
      outCx: 0,
      outCy: 0,
      outX1: 0,
      outY1: 0,
    };

    parent.liveChildren += 1;
    layer.branches.set(id, branch);
    this.dress(layer, branch, this.bestValueOf(layer), 1);

    return true;
  }

  /** Whether a view point lies in the keep-out, its margin included. */
  private inKeepOut(x: number, y: number): boolean {
    const box = this.keepOut;

    return box !== null
      && x >= box.left - KEEP_OUT_MARGIN && x <= box.right + KEEP_OUT_MARGIN
      && y >= box.top - KEEP_OUT_MARGIN && y <= box.bottom + KEEP_OUT_MARGIN;
  }

  /** Where the camera parks the frontier after a restart: REGROW_X, or past the keep-out. */
  private parkX(): number {
    return this.keepOut === null ? REGROW_X : Math.max(REGROW_X, this.keepOut.right + KEEP_OUT_MARGIN);
  }

  /** The heading that keeps a tip out of the keep-out, or null when the
   *  one given already does. A tip that would land inside turns to the side
   *  of the box its parent is on, at least a shallow angle, still rightward. */
  private turnAway(layer: LayerState, parent: Branch, heading: number, length: number, y1: number): number | null {
    const box = this.keepOut;

    if (box === null || !this.inKeepOut(parent.x1 + Math.cos(heading) * length - layer.offset, y1)) return null;
    const side = parent.y1 >= (box.top + box.bottom) / 2 ? 1 : -1;

    return side * Math.max(0.35, Math.abs(heading) * 0.8);
  }

  private bend(layer: LayerState, dt: number): void {
    const pointerX = this.pointerX;
    const pointerY = this.pointerY;
    const ease = 1 - Math.exp(-dt * BEND_RATE);

    for (const branch of layer.branches.values()) {
      let targetX = 0;
      let targetY = 0;
      let targetBoost = 0;

      if (pointerX !== null && pointerY !== null) {
        const viewX = branch.x1 - layer.offset;
        const distance = this.distance(viewX, branch.y1, pointerX, pointerY);

        if (distance < POINTER_RADIUS && distance > 1e-6) {
          const falloff = (1 - distance / POINTER_RADIUS) ** 2;
          const pull = Math.min(MAX_BEND, distance) * falloff;
          targetX = (pointerX - viewX) / distance * pull;
          targetY = (pointerY - branch.y1) / distance * pull;
          targetBoost = falloff;
        }
      }

      branch.bendX += (targetX - branch.bendX) * ease;
      branch.bendY += (targetY - branch.bendY) * ease;
      branch.boost += (targetBoost - branch.boost) * ease;
    }
  }

  /** The evolution loop: keep the best lineage, let the rest go to ash, pan
   *  the camera so the kept frontier has room, and grow again from there. */
  private restart(layer: LayerState): void {
    layer.generationStart = this.elapsed;
    layer.regrowAt = this.elapsed + REGROW_DELAY;

    if (layer.rules.foreground) this.generation += 1;

    for (const branch of layer.branches.values()) {
      if (!branch.onPath) this.cut(layer, branch, true);
    }

    const best = layer.branches.get(layer.bestId);

    if (best !== undefined) layer.offsetTarget = Math.max(layer.offsetTarget, best.x1 - this.parkX());
  }

  private regrow(layer: LayerState): void {
    const path: Branch[] = [];

    for (let branch = layer.branches.get(layer.bestId); branch !== undefined; branch = layer.branches.get(branch.parent)) {
      path.push(branch);
    }

    const frontier = path[0];

    if (frontier === undefined) return;
    frontier.expanded = false;
    frontier.spawnAt = this.elapsed;
    const ancestors = path.slice(1).filter((branch) => branch.x1 - layer.offsetTarget > 0.02 && !this.inKeepOut(branch.x1 - layer.offsetTarget, branch.y1));

    for (let index = 0; index < 2 && ancestors.length > 0; index += 1) {
      const pick = ancestors.splice(Math.floor(layer.random() * ancestors.length), 1)[0];

      if (pick !== undefined) this.spawn(layer, pick, (layer.random() - 0.5) * 1.6, 1);
    }
  }

  private stepSparks(dt: number): void {
    for (let index = this.sparks.length - 1; index >= 0; index -= 1) {
      const spark = this.sparks[index];

      if (spark === undefined) continue;
      spark.age += dt;

      if (spark.age >= spark.life) {
        this.sparks.splice(index, 1);
        continue;
      }

      spark.x += spark.vx * dt;
      spark.y += spark.vy * dt;
    }
  }
}

export type Rgb = readonly [red: number, green: number, blue: number];

/** The theme's own tokens, read from the document: accent is the gold,
 *  bright is `--c-accent-fg` (silk on dark, deep gold on paper), ash is the
 *  dim text role a pruned branch fades into, ground is the page behind the
 *  art, which every tone recedes toward by RECESS. No colour is invented here. */
export interface HeroPalette {
  readonly mode: 'dark' | 'light';
  readonly accent: Rgb;
  readonly bright: Rgb;
  readonly ash: Rgb;
  readonly ground: Rgb;
}

/** The CSS colour string a Canvas2D fill or stroke takes. */
export function cssRgba(rgb: Rgb, alpha: number): string {
  const [red, green, blue] = rgb;

  return `rgba(${String(Math.round(red))},${String(Math.round(green))},${String(Math.round(blue))},${String(alpha)})`;
}

/** What the hero asks of whichever renderer it picked: both draw the same
 *  `SearchTreeFrame`, and neither knows how the frame came to be. */
export interface SearchTreeRenderer {
  readonly kind: 'canvas' | 'webgpu';
  /** CSS pixel size of the box and the device pixel ratio to draw at. */
  resize(width: number, height: number, ratio: number): void;
  setPalette(palette: HeroPalette): void;
  render(frame: SearchTreeFrame): void;
  /** A renderer that can die after it has started — the GPU half — takes one
   *  fault handler; a fault that landed before the call replays at subscribe.
   *  The renderer has already disposed itself by then. A renderer that cannot
   *  fault leaves this absent. */
  onFault?(handler: (error: Error) => void): void;
  dispose(): void;
}

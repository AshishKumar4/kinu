import { Button } from '@cloudflare/kumo';
import { useEffect, useRef, useState, type ReactElement } from 'react';

import { useCopy } from '@/hooks/use-copy';
import { LandingActionLink } from './LandingActionLink';

interface TreeNode {
  readonly id: number;
  readonly parent: number | null;
  readonly depth: number;
  readonly x: number;
  readonly y: number;
  readonly phase: number;
  readonly children: number[];
  appear: number;
  pruned: boolean;
  hidden: boolean;
}

interface TreeState {
  readonly nodes: TreeNode[];
  readonly winner: number;
  readonly winningPath: ReadonlySet<number>;
  readonly lastAppear: number;
}

type Rgb = readonly [red: number, green: number, blue: number];

function cssRgb(name: string): Rgb {
  const value = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  const hex = /^#([0-9a-f]{6})$/iu.exec(value)?.[1];
  if (hex !== undefined) {
    const number = Number.parseInt(hex, 16);
    return [(number >> 16) & 255, (number >> 8) & 255, number & 255];
  }
  const channels = value.match(/[\d.]+/gu)?.slice(0, 3).map(Number);
  if (channels === undefined) return [224, 164, 88];
  const [red, green, blue] = channels;
  return red === undefined || green === undefined || blue === undefined
    ? [224, 164, 88]
    : [red, green, blue];
}

function rgba([red, green, blue]: Rgb, alpha: number): string {
  return `rgba(${String(red)},${String(green)},${String(blue)},${String(alpha)})`;
}


function pseudoRandom(seed: number): () => number {
  let value = seed;
  return () => {
    value = (value * 16_807) % 2_147_483_647;
    return value / 2_147_483_647;
  };
}

function buildTree(width: number, height: number): TreeState {
  const random = pseudoRandom(417);
  const nodes: TreeNode[] = [];
  const levels = 5;
  const left = width * 0.04;
  const right = width * 0.97;
  const addNode = (parent: number | null, depth: number, top: number, bottom: number): void => {
    const span = bottom - top;
    const node: TreeNode = {
      id: nodes.length,
      parent,
      depth,
      x: left + (right - left) * (depth / (levels - 1))
        + (depth === 0 ? 0 : (random() - 0.5) * width * 0.03),
      y: top + span * (0.34 + random() * 0.32),
      phase: random() * Math.PI * 2,
      children: [],
      appear: 0,
      pruned: false,
      hidden: false,
    };
    nodes.push(node);
    if (parent !== null) nodes[parent]?.children.push(node.id);
    if (depth >= levels - 1) return;
    const childCount = depth === 0 ? 3 : random() < 0.46 ? 2 : random() < 0.8 ? 3 : 1;
    for (let index = 0; index < childCount; index += 1) {
      if (depth > 1 && random() < 0.18) continue;
      addNode(
        node.id,
        depth + 1,
        top + index * span / childCount,
        top + (index + 1) * span / childCount,
      );
    }
  };
  addNode(null, 0, height * 0.06, height * 0.94);
  const leaves = nodes.filter((node) => (
    node.children.length === 0
    && node.depth >= levels - 2
    && node.y > height * 0.25
    && node.y < height * 0.75
  ));
  const winnerNode = leaves[Math.floor(random() * leaves.length)] ?? nodes.at(-1);
  if (winnerNode === undefined) throw new Error('landing tree has no nodes');
  const winningPath = new Set<number>();
  for (let node: TreeNode | undefined = winnerNode; node !== undefined;) {
    winningPath.add(node.id);
    node = node.parent === null ? undefined : nodes[node.parent];
  }
  for (const node of nodes) {
    if (node.depth < 2 || winningPath.has(node.id)) continue;
    const parent = node.parent === null ? undefined : nodes[node.parent];
    if (parent?.pruned === true || parent?.hidden === true) {
      node.hidden = true;
      continue;
    }
    const probability = node.children.length === 0 ? 0.32 : 0.23;
    node.pruned = random() < probability;
  }
  const visibleNodes = nodes.filter((node) => !node.hidden);
  [...visibleNodes].sort((a, b) => a.depth - b.depth || a.y - b.y)
    .forEach((node, index) => { node.appear = 180 + index * 105 + random() * 55; });
  const lastAppear = Math.max(...visibleNodes.map((node) => node.appear));
  return { nodes, winner: winnerNode.id, winningPath, lastAppear };
}

function drawTree(
  context: CanvasRenderingContext2D,
  state: TreeState,
  elapsed: number,
  width: number,
  height: number,
  ratio: number,
  ink: Rgb,
): void {
  context.setTransform(ratio, 0, 0, ratio, 0, 0);
  context.clearRect(0, 0, width, height);
  const time = Math.min(elapsed, state.lastAppear + 2_000);
  const winningProgress = Math.max(0, Math.min(1, (time - state.lastAppear - 500) / 1_200));
  const sway = (node: TreeNode): number => Math.sin(elapsed / 3_600 + node.phase) * (0.6 + node.depth * 0.35);

  for (const node of state.nodes) {
    if (node.hidden || node.parent === null) continue;
    const parent = state.nodes[node.parent];
    if (parent === undefined) continue;
    const startY = parent.y + sway(parent);
    const endY = node.y + sway(node);
    const distance = node.x - parent.x;
    const pruned = node.pruned || parent.pruned;
    const selected = !pruned && state.winningPath.has(node.id) && state.winningPath.has(parent.id);
    const arrival = Math.min(1, Math.max(0, (time - node.appear) / 700));
    context.beginPath();
    context.moveTo(parent.x, startY);
    context.bezierCurveTo(parent.x + distance * 0.55, startY, parent.x + distance * 0.45, endY, node.x, endY);
    context.setLineDash(pruned ? [2, 5] : []);
    context.strokeStyle = rgba(ink, pruned ? 0.17 : selected ? 0.2 + 0.65 * winningProgress : 0.12 + 0.17 * arrival);
    context.lineWidth = selected ? 1 + winningProgress : 0.8;
    context.stroke();
    context.setLineDash([]);

    if (selected && winningProgress > 0.9) {
      const t = (elapsed / 3_400 - node.depth * 0.19) % 1;
      const u = 1 - t;
      const x = u ** 3 * parent.x + 3 * u ** 2 * t * (parent.x + distance * 0.55)
        + 3 * u * t ** 2 * (parent.x + distance * 0.45) + t ** 3 * node.x;
      const y = (u ** 3 + 3 * u ** 2 * t) * startY + (3 * u * t ** 2 + t ** 3) * endY;
      context.beginPath();
      context.arc(x, y, 2, 0, Math.PI * 2);
      context.fillStyle = rgba(ink, 0.9);
      context.fill();
    }
  }

  for (const node of state.nodes) {
    if (node.hidden) continue;
    const arrival = Math.min(1, Math.max(0, (time - node.appear) / 620));
    const y = node.y + sway(node);
    const root = node.parent === null;
    const winner = node.id === state.winner;
    const selected = state.winningPath.has(node.id);
    const radius = root ? 6 : winner ? 5 : node.pruned ? 2 : 2.6;
    if (root || (winner && winningProgress > 0.1)) {
      context.beginPath();
      context.arc(node.x, y, radius + 6, 0, Math.PI * 2);
      context.strokeStyle = rgba(ink, 0.2);
      context.lineWidth = 1;
      context.stroke();
    }
    context.beginPath();
    context.arc(node.x, y, radius, 0, Math.PI * 2);
    context.fillStyle = rgba(ink, node.pruned ? 0.25 : selected ? 0.3 + 0.7 * arrival : 0.15 + 0.25 * arrival);
    context.fill();
  }
}

const STATIC_TREE = buildTree(720, 520);

function SearchCanvas(): ReactElement {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const controlsRef = useRef<{ replay(): void; pause(): void } | null>(null);
  const [ready, setReady] = useState(false);
  const [playing, setPlaying] = useState(true);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (canvas === null) return;
    const context = canvas.getContext('2d');
    if (context === null) return;
    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)');
    let timer = 0;
    let visible = false;
    let paused = false;
    let contextLost = false;
    let lastTick = performance.now();
    let elapsed = 180;
    let dimensions = { width: 720, height: 520, ratio: 1 };
    let tree = STATIC_TREE;
    let ink = cssRgb('--c-accent-fg');

    const paint = (): void => {
      if (contextLost) return;
      drawTree(context, tree, elapsed, dimensions.width, dimensions.height, dimensions.ratio, ink);
      canvas.dataset.settled = String(elapsed >= tree.lastAppear + 2_000);
    };
    const stop = (): void => { window.clearTimeout(timer); timer = 0; };
    const tick = (): void => {
      const now = performance.now();
      elapsed += now - lastTick;
      lastTick = now;
      paint();
      timer = window.setTimeout(tick, 34);
    };
    const syncPlayback = (): void => {
      stop();
      if (reduced.matches) { elapsed = tree.lastAppear + 2_000; paint(); }
      if (!visible || document.hidden || paused || reduced.matches || contextLost) return;
      lastTick = performance.now();
      timer = window.setTimeout(tick, 34);
    };
    const resize = (): void => {
      const box = canvas.getBoundingClientRect();
      if (box.width < 4 || box.height < 4) return;
      const ratio = Math.min(2, window.devicePixelRatio || 1);
      const width = Math.round(box.width * ratio);
      const height = Math.round(box.height * ratio);
      if (canvas.width === width && canvas.height === height) return;
      canvas.width = width;
      canvas.height = height;
      dimensions = { width: box.width, height: box.height, ratio };
      tree = buildTree(box.width, box.height);
      canvas.dataset.pruned = String(tree.nodes.filter((node) => node.pruned).length);
      canvas.dataset.hidden = String(tree.nodes.filter((node) => node.hidden).length);
      if (reduced.matches) elapsed = tree.lastAppear + 2_000;
      paint();
    };
    const modeChanged = (): void => { ink = cssRgb('--c-accent-fg'); paint(); };
    const lost = (event: Event): void => { event.preventDefault(); contextLost = true; stop(); setReady(false); };
    const restored = (): void => { contextLost = false; resize(); paint(); setReady(true); syncPlayback(); };
    const sizeObserver = new ResizeObserver(resize);
    const modeObserver = new MutationObserver(modeChanged);
    const visibilityObserver = new IntersectionObserver(([entry]) => {
      visible = entry?.isIntersecting === true;
      if (visible && !contextLost) { resize(); setReady(true); }
      syncPlayback();
    });
    sizeObserver.observe(canvas);
    modeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['data-mode'] });
    visibilityObserver.observe(canvas);
    document.addEventListener('visibilitychange', syncPlayback);
    reduced.addEventListener('change', syncPlayback);
    canvas.addEventListener('contextlost', lost);
    canvas.addEventListener('contextrestored', restored);
    controlsRef.current = {
      replay() { elapsed = 180; paused = false; setPlaying(true); paint(); syncPlayback(); },
      pause() { paused = !paused; setPlaying(!paused); syncPlayback(); },
    };
    return () => {
      stop();
      controlsRef.current = null;
      sizeObserver.disconnect();
      modeObserver.disconnect();
      visibilityObserver.disconnect();
      document.removeEventListener('visibilitychange', syncPlayback);
      reduced.removeEventListener('change', syncPlayback);
      canvas.removeEventListener('contextlost', lost);
      canvas.removeEventListener('contextrestored', restored);
    };
  }, []);

  return (
    <figure data-hero-graph className="landing-search">
      <div className="landing-search-heading p-annotation p-text-3"><span>Explore alternatives</span><span className="p-accent">Keep the measured result</span></div>
      <div className="landing-search-field">
        <svg viewBox="0 0 720 520" preserveAspectRatio="none" aria-hidden="true" className={ready ? 'hidden' : 'absolute inset-0 size-full'}>
          {STATIC_TREE.nodes.filter((node) => !node.hidden).map((node) => {
            const parent = node.parent === null ? undefined : STATIC_TREE.nodes[node.parent];
            return <g key={node.id} fill="var(--c-accent-fg)" stroke="var(--c-accent-fg)" opacity={STATIC_TREE.winningPath.has(node.id) ? 0.8 : 0.25}>
              {parent !== undefined && <path d={`M ${parent.x} ${parent.y} C ${parent.x + (node.x - parent.x) * 0.55} ${parent.y}, ${parent.x + (node.x - parent.x) * 0.45} ${node.y}, ${node.x} ${node.y}`} fill="none" strokeWidth={STATIC_TREE.winningPath.has(node.id) ? 1.8 : 0.8} strokeDasharray={node.pruned ? '2 5' : undefined} />}
              <circle cx={node.x} cy={node.y} r={node.parent === null ? 5 : 2.5} stroke="none" />
            </g>;
          })}
        </svg>
        <canvas ref={canvasRef} aria-hidden="true" className={`absolute inset-0 size-full ${ready ? 'opacity-100' : 'opacity-0'}`} />
      </div>
      <figcaption className="landing-search-caption">
        <span className="p-annotation p-text-3">Search, score, and improve.</span>
        <div className="flex gap-1 motion-reduce:hidden">
          <Button type="button" size="sm" variant="ghost" disabled={!ready} aria-label={playing ? 'Pause search animation' : 'Play search animation'} onClick={() => controlsRef.current?.pause()}>{playing ? 'Pause' : 'Play'}</Button>
          <Button type="button" size="sm" variant="ghost" disabled={!ready} aria-label="Replay search animation" onClick={() => controlsRef.current?.replay()}>Replay</Button>
        </div>
      </figcaption>
    </figure>
  );
}

export function LandingHero({ install }: { install: string }): ReactElement {
  const { status, copy } = useCopy();
  return (
    <section id="top" className="relative overflow-hidden">
      {/* Base column is an explicit minmax(0,1fr): with no template, the
          implicit auto track takes the install row's ~519px min-content and
          the root's overflow-x-clip hides the clipping from scrollWidth. */}
      <div className="landing-shell relative grid grid-cols-1 items-center lg:grid-cols-[minmax(0,540px)_minmax(0,1fr)]">
        <div className="min-w-0 py-[72px] lg:py-[88px]">
          <div className="mb-7 inline-flex items-center gap-2 rounded-full border p-border p-surface px-3.5 py-1.5 text-xs p-text-2">
            <span className="size-[5px] rounded-full p-dot-accent" />
            The self-evolving agent platform
          </div>
          <h1 className="mb-6 text-[clamp(40px,5.2vw,68px)] font-semibold leading-[.99] tracking-[-.04em] text-pretty p-text">
            Agents that{' '}
            <span className="block p-accent">learn from feedback.</span>
          </h1>
          <p className="mb-8 max-w-[520px] text-[17.5px] leading-[1.65] text-pretty p-text-3">
            Give each agent a durable computer. Run it locally or in the cloud. Executable checks choose among competing approaches.
          </p>
          <div className="flex max-w-[540px] items-center justify-between gap-4 rounded-xl border p-border p-recessed px-4 py-3.5">
            <code className="min-w-0 flex-1 whitespace-pre-wrap break-all font-mono text-[12.5px] leading-relaxed p-text-2"><span aria-hidden="true" className="p-accent">$</span> <span data-install-command>{install}</span></code>
            <Button type="button" variant="ghost" size="sm" onClick={() => copy(install)} aria-label="Copy install command">
              {status === 'copied' ? 'Copied' : status === 'failed' ? 'Retry copy' : 'Copy'}
            </Button>
          </div>
          <div className="mt-[22px] flex flex-wrap items-center gap-3">
            <LandingActionLink href="/login" primary>Try cloud agents →</LandingActionLink>
            <LandingActionLink href="#deploy">Deploy your own</LandingActionLink>
            <span className="text-[12.5px] p-text-4">MIT · open source</span>
          </div>
        </div>
        <SearchCanvas />
      </div>
    </section>
  );
}

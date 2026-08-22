import { Button } from '@cloudflare/kumo';
import { useEffect, useRef, useState, type ReactElement } from 'react';

import { useCopy } from '@/hooks/use-copy';
import { LandingActionLink } from './LandingActionLink';

const PHRASES = [
  'get better with use.',
  'work while you sleep.',
  'build their own tools.',
  'run close to your code.',
  'search, score, and improve.',
] as const;

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
}

interface TreeState {
  readonly nodes: TreeNode[];
  readonly winner: number;
  readonly winningPath: ReadonlySet<number>;
  readonly lastAppear: number;
}

type Rgb = readonly [red: number, green: number, blue: number];
interface TreePalette {
  readonly accent: Rgb;
  readonly bright: Rgb;
  readonly text: Rgb;
  readonly danger: Rgb;
}

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

function treePalette(): TreePalette {
  return {
    accent: cssRgb('--c-accent'),
    bright: cssRgb('--c-accent-fg'),
    text: cssRgb('--c-text'),
    danger: cssRgb('--c-danger'),
  };
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
  const levels = 6;
  const left = width * 0.12;
  const right = width * 0.9;
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
  [...nodes].sort((a, b) => a.depth - b.depth || a.y - b.y)
    .forEach((node, index) => { node.appear = 120 + index * 45 + random() * 35; });
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
    const parentPruned = node.parent === null ? false : nodes[node.parent]?.pruned === true;
    const probability = node.children.length === 0 ? 0.72 : 0.42;
    node.pruned = parentPruned || random() < probability;
  }
  const lastAppear = Math.max(...nodes.map((node) => node.appear));
  return { nodes, winner: winnerNode.id, winningPath, lastAppear };
}

function drawTree(
  context: CanvasRenderingContext2D,
  state: TreeState,
  elapsed: number,
  width: number,
  height: number,
  ratio: number,
  palette: TreePalette,
): void {
  context.setTransform(ratio, 0, 0, ratio, 0, 0);
  context.clearRect(0, 0, width, height);
  const settledAt = state.lastAppear + 2_000;
  const time = Math.min(elapsed, settledAt);
  const winningProgress = Math.max(0, Math.min(1, (time - state.lastAppear - 500) / 1_200));
  const sway = (node: TreeNode): number => Math.sin(elapsed / 2_400 + node.phase) * (1.5 + node.depth * 0.9);

  for (const node of state.nodes) {
    if (node.parent === null) continue;
    const parent = state.nodes[node.parent];
    if (parent === undefined) continue;
    const arrival = Math.min(1, Math.max(0, (time - node.appear) / 700));
    if (arrival <= 0) continue;
    const eased = arrival < 1 ? 1 - (1 - arrival) ** 3 : 1;
    const startX = parent.x;
    const startY = parent.y + sway(parent);
    const endX = startX + (node.x - startX) * eased;
    const endY = startY + (node.y + sway(node) - startY) * eased;
    const pruned = node.pruned || parent.pruned;
    const selected = !pruned && state.winningPath.has(node.id) && state.winningPath.has(parent.id);
    if (pruned) {
      context.setLineDash([3, 5]);
      context.strokeStyle = rgba(palette.danger, 0.32);
      context.lineWidth = 0.8;
    } else {
      context.setLineDash([]);
      const strength = selected ? 0.2 + 0.6 * winningProgress : 0.17;
      const gradient = context.createLinearGradient(startX, startY, endX, endY);
      gradient.addColorStop(0, rgba(palette.accent, strength * 0.45));
      gradient.addColorStop(1, rgba(palette.bright, strength));
      context.strokeStyle = gradient;
      context.lineWidth = selected ? 0.9 + 0.9 * winningProgress : 0.85;
    }
    context.beginPath();
    context.moveTo(startX, startY);
    const controlX = startX + (endX - startX) * 0.55;
    context.bezierCurveTo(controlX, startY, startX + (endX - startX) * 0.45, endY, endX, endY);
    context.stroke();
    context.setLineDash([]);
  }

  for (const node of state.nodes) {
    const arrival = Math.min(1, Math.max(0, (time - node.appear) / 620));
    if (arrival <= 0) continue;
    const x = node.x;
    const y = node.y + sway(node);
    const root = node.parent === null;
    const winner = node.id === state.winner;
    const selected = state.winningPath.has(node.id);
    const pruned = node.pruned;
    const leaf = node.children.length === 0;
    const radius = (root ? 5 : leaf ? 3.6 : 2.6) * (0.5 + 0.5 * arrival);
    if (pruned) {
      context.beginPath();
      context.arc(x, y, radius + 1, 0, Math.PI * 2);
      context.fillStyle = rgba(palette.danger, 0.13);
      context.fill();
      context.strokeStyle = rgba(palette.danger, 0.58);
      context.lineWidth = 1;
      context.stroke();
      context.beginPath();
      context.moveTo(x - radius - 2, y + radius + 2);
      context.lineTo(x + radius + 2, y - radius - 2);
      context.stroke();
      continue;
    }
    context.beginPath();
    context.arc(x, y, winner ? radius * (1 + 0.5 * winningProgress) : radius, 0, Math.PI * 2);
    context.fillStyle = winner && winningProgress > 0.1
      ? rgba(palette.text, 0.5 + 0.5 * winningProgress)
      : selected && winningProgress > 0.1
        ? rgba(palette.accent, 0.3 + 0.45 * winningProgress)
        : root
          ? rgba(palette.bright, 0.6)
          : rgba(palette.accent, leaf ? 0.5 : 0.36);
    context.fill();
  }
}

function SearchCanvas(): ReactElement {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (canvas === null) return;
    const context = canvas.getContext('2d');
    if (context === null) return;
    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    let timer = 0;
    let started = performance.now();
    let dimensions = { width: 520, height: 620, ratio: 1 };
    let tree = buildTree(dimensions.width, dimensions.height);
    let lastElapsed = 700;

    const resize = (): boolean => {
      const box = canvas.getBoundingClientRect();
      if (box.width < 4 || box.height < 4) return false;
      const ratio = Math.min(2, window.devicePixelRatio || 1);
      const width = Math.round(box.width * ratio);
      const height = Math.round(box.height * ratio);
      if (canvas.width === width && canvas.height === height) return false;
      canvas.width = width;
      canvas.height = height;
      dimensions = { width: box.width, height: box.height, ratio };
      tree = buildTree(box.width, box.height);
      canvas.dataset.pruned = String(tree.nodes.filter((node) => node.pruned).length);
      return true;
    };
    const paint = (elapsed: number): void => {
      lastElapsed = elapsed;
      drawTree(context, tree, elapsed, dimensions.width, dimensions.height, dimensions.ratio, treePalette());
      if (elapsed >= tree.lastAppear + 2_000) canvas.dataset.settled = "true";
      else delete canvas.dataset.settled;
    };
    const draw = (now: number): void => {
      const settledAt = tree.lastAppear + 2_000;
      const elapsed = reduced ? settledAt : now - started;
      paint(elapsed);
      if (!reduced) timer = window.setTimeout(() => draw(performance.now()), 34);
    };

    resize();
    const initialElapsed = reduced ? tree.lastAppear + 2_000 : 700;
    started = performance.now() - initialElapsed;
    paint(initialElapsed);
    if (!reduced) timer = window.setTimeout(() => draw(performance.now()), 34);

    const observer = new ResizeObserver(() => {
      if (!resize()) return;
      paint(tree.lastAppear + 2_000);
    });
    observer.observe(canvas);
    const modeObserver = new MutationObserver(() => paint(lastElapsed));
    modeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ["data-mode"] });
    return () => {
      window.clearTimeout(timer);
      observer.disconnect();
      modeObserver.disconnect();
    };
  }, []);

  return (
    <div data-hero-graph className="relative hidden min-h-[620px] min-w-0 lg:block">
      <canvas
        ref={canvasRef}
        aria-hidden="true"
        className="absolute inset-0 size-full opacity-80 [mask-image:radial-gradient(ellipse_88%_82%_at_55%_50%,black_48%,transparent_96%)]"
      />
    </div>
  );
}

function useTypewriter(): string {
  const [phrase, setPhrase] = useState('');
  useEffect(() => {
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      setPhrase(PHRASES[0]);
      return;
    }
    let phraseIndex = 0;
    let length = 0;
    let typing = true;
    let timer = 0;
    const step = () => {
      const current = PHRASES[phraseIndex];
      let delay = 50;
      if (typing && length < current.length) {
        length += 1;
        delay = 42 + Math.random() * 46;
      } else if (typing) {
        typing = false;
        delay = 2_600;
      } else if (length > 0) {
        length -= 1;
        delay = 20;
      } else {
        typing = true;
        phraseIndex = (phraseIndex + 1) % PHRASES.length;
        delay = 420;
      }
      setPhrase(current.slice(0, length));
      timer = window.setTimeout(step, delay);
    };
    timer = window.setTimeout(step, 700);
    return () => window.clearTimeout(timer);
  }, []);
  return phrase;
}

export function LandingHero({ install }: { install: string }): ReactElement {
  const phrase = useTypewriter();
  const { status, copy } = useCopy();
  return (
    <section id="top" className="relative overflow-hidden">
      <div className="landing-shell relative grid items-center gap-10 lg:grid-cols-[minmax(0,600px)_minmax(0,1fr)]">
        <div className="py-[72px] lg:py-[88px]">
          <div className="mb-7 inline-flex items-center gap-2 rounded-full border p-border p-surface px-3.5 py-1.5 text-xs p-text-2">
            <span className="size-[5px] rounded-full p-dot-accent" />
            The self-evolving agent platform
          </div>
          <h1 className="mb-6 text-[clamp(40px,5.2vw,68px)] font-semibold leading-[.99] tracking-[-.04em] text-pretty p-text">
            Agents that <span className="block h-[2.02em] overflow-hidden p-gold">{phrase}<span aria-hidden className="ml-[.06em] inline-block h-[.8em] w-[.075em] translate-y-[.1em] bg-[var(--c-accent)] motion-safe:animate-pulse" /></span>
          </h1>
          <p className="mb-8 max-w-[520px] text-[17.5px] leading-[1.65] text-pretty p-text-3">
            Persistent workspaces with files, sessions, and memory. Hosted on Cloudflare, so tasks keep running after you close the laptop — or fully native on your machine, in the terminal or your editor.
          </p>
          <div className="flex max-w-[540px] items-center justify-between gap-4 rounded-xl border p-border p-recessed px-4 py-3.5">
            <code className="min-w-0 flex-1 truncate font-mono text-[12.5px] p-text-2"><span className="p-gold">$</span> <span data-install-command>{install}</span></code>
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

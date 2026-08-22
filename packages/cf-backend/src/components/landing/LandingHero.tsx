import { Button } from '@cloudflare/kumo';
import { useEffect, useRef, useState, type CSSProperties, type ReactElement } from 'react';

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
}

interface TreeState {
  readonly nodes: TreeNode[];
  readonly winner: number;
  readonly winningPath: ReadonlySet<number>;
  readonly lastAppear: number;
  readonly cycle: number;
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
    };
    nodes.push(node);
    if (parent !== null) nodes[parent]?.children.push(node.id);
    if (depth >= levels - 1) return;
    const childCount = depth === 0 ? 3 : random() < 0.46 ? 2 : random() < 0.8 ? 3 : 1;
    for (let index = 0; index < childCount; index += 1) {
      if (depth > 1 && random() < 0.3) continue;
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
    .forEach((node, index) => { node.appear = 160 + index * 165 + random() * 90; });
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
  const lastAppear = Math.max(...nodes.map((node) => node.appear));
  return { nodes, winner: winnerNode.id, winningPath, lastAppear, cycle: lastAppear + 5_600 };
}

function drawTree(
  context: CanvasRenderingContext2D,
  state: TreeState,
  elapsed: number,
  width: number,
  height: number,
  ratio: number,
): void {
  context.setTransform(ratio, 0, 0, ratio, 0, 0);
  context.clearRect(0, 0, width, height);
  const time = elapsed % state.cycle;
  const winningProgress = Math.max(0, Math.min(1, (time - state.lastAppear - 700) / 1_300));
  const fade = Math.max(0, Math.min(1, (time - (state.cycle - 1_000)) / 1_000));
  const alpha = 1 - fade;
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
    const selected = state.winningPath.has(node.id) && state.winningPath.has(parent.id);
    const strength = selected ? 0.2 + 0.6 * winningProgress : 0.17;
    const gradient = context.createLinearGradient(startX, startY, endX, endY);
    gradient.addColorStop(0, `rgba(224,164,88,${String(strength * 0.35 * alpha)})`);
    gradient.addColorStop(1, `rgba(227,210,174,${String(strength * alpha)})`);
    context.strokeStyle = gradient;
    context.lineWidth = selected ? 0.9 + 0.9 * winningProgress : 0.85;
    context.beginPath();
    context.moveTo(startX, startY);
    const controlX = startX + (endX - startX) * 0.55;
    context.bezierCurveTo(controlX, startY, startX + (endX - startX) * 0.45, endY, endX, endY);
    context.stroke();
  }

  for (const node of state.nodes) {
    const arrival = Math.min(1, Math.max(0, (time - node.appear) / 620));
    if (arrival <= 0) continue;
    const x = node.x;
    const y = node.y + sway(node);
    const root = node.parent === null;
    const winner = node.id === state.winner;
    const selected = state.winningPath.has(node.id);
    const leaf = node.children.length === 0;
    const radius = (root ? 5 : leaf ? 3.6 : 2.6) * (0.5 + 0.5 * arrival);
    if (winner && winningProgress > 0) {
      const halo = context.createRadialGradient(x, y, 0, x, y, 62);
      halo.addColorStop(0, `rgba(224,164,88,${String(0.22 * winningProgress * alpha)})`);
      halo.addColorStop(1, 'rgba(224,164,88,0)');
      context.fillStyle = halo;
      context.fillRect(x - 62, y - 62, 124, 124);
    }
    context.beginPath();
    context.arc(x, y, winner ? radius * (1 + 0.5 * winningProgress) : radius, 0, Math.PI * 2);
    context.fillStyle = winner && winningProgress > 0.1
      ? `rgba(240,228,205,${String((0.5 + 0.5 * winningProgress) * alpha)})`
      : selected && winningProgress > 0.1
        ? `rgba(224,164,88,${String((0.3 + 0.45 * winningProgress) * alpha)})`
        : root
          ? `rgba(227,210,174,${String(0.6 * alpha)})`
          : `rgba(224,164,88,${String((leaf ? 0.5 : 0.36) * alpha)})`;
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
    let frame = 0;
    let started = performance.now();
    let dimensions = { width: 480, height: 620, ratio: 1 };
    let tree = buildTree(dimensions.width, dimensions.height);

    const resize = () => {
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
      started = performance.now();
    };
    const draw = (now: number) => {
      resize();
      drawTree(
        context,
        tree,
        reduced ? tree.lastAppear + 2_200 : now - started,
        dimensions.width,
        dimensions.height,
        dimensions.ratio,
      );
      if (!reduced) frame = requestAnimationFrame(draw);
    };
    resize();
    const initialElapsed = reduced ? tree.lastAppear + 2_200 : 700;
    drawTree(
      context,
      tree,
      initialElapsed,
      dimensions.width,
      dimensions.height,
      dimensions.ratio,
    );
    if (!reduced) {
      started = performance.now() - initialElapsed;
      frame = requestAnimationFrame(draw);
    }
    return () => cancelAnimationFrame(frame);
  }, []);

  const mask: CSSProperties = {
    WebkitMaskImage: 'radial-gradient(ellipse 78% 82% at 58% 50%, #000 44%, transparent 86%)',
    maskImage: 'radial-gradient(ellipse 78% 82% at 58% 50%, #000 44%, transparent 86%)',
  };
  return (
    <canvas
      ref={canvasRef}
      aria-hidden="true"
      className="pointer-events-none absolute right-[max(24px,calc(50%-580px))] top-[4%] hidden h-[92%] w-[min(38%,480px)] lg:block"
      style={mask}
    />
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
    <>
      <section id="top" className="relative overflow-hidden">
        <SearchCanvas />
        <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(ellipse_46%_50%_at_84%_46%,rgba(224,164,88,0.07),transparent_72%)]" />
        <div className="landing-shell relative">
          <div className="max-w-[640px] py-[72px] lg:py-[104px] lg:pb-24">
            <div className="mb-7 inline-flex items-center gap-2 rounded-full border p-border p-surface px-3.5 py-1.5 text-xs p-text-2">
              <span className="size-[5px] rounded-full p-dot-accent" />
              The self-evolving agent platform
            </div>
            <h1 className="mb-6 text-[clamp(40px,5.6vw,72px)] font-semibold leading-[.99] tracking-[-.04em] text-pretty p-text">
              Agents that <span className="block min-h-[1.06em] p-gold">{phrase}<span aria-hidden className="ml-[.06em] inline-block h-[.8em] w-[.075em] translate-y-[.1em] bg-[var(--c-accent)] motion-safe:animate-pulse" /></span>
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
        </div>
      </section>
    </>
  );
}

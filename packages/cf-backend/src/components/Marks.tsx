import { useId, type CSSProperties } from "react";
import { Tooltip } from "@cloudflare/kumo";
import type { AgentActivity } from "@kinu.run/core";

const HUES = [
  ["#FFC48A", "#F08A4B", "#C2602A"], ["#FFB3C4", "#F07A98", "#C2506E"], ["#D3C2FF", "#9E86F0", "#7058C8"],
  ["#BFE6A6", "#7FC468", "#4F9640"], ["#B4DCFF", "#6EAEEB", "#3F7FC0"], ["#FFE08A", "#F2BC3C", "#C08A12"],
  ["#A8EBD8", "#4FC7A6", "#27957A"], ["#F7C1F0", "#D97BD0", "#A84E9F"], ["#FFBBA8", "#F27F66", "#C2523A"],
  ["#ADE3F2", "#55B6D3", "#2A85A3"], ["#C9D1FF", "#8797F0", "#5566C4"], ["#E4EDA6", "#B8CE58", "#87A02A"],
] as const;

function hashOf(seed: string): number {
  let hash = 0x811c9dc5;

  for (let i = 0; i < seed.length; i += 1) hash = Math.imul(hash ^ seed.charCodeAt(i), 0x01000193);

  hash = Math.imul(hash ^ (hash >>> 16), 0x85ebca6b);
  hash = Math.imul(hash ^ (hash >>> 13), 0xc2b2ae35);

  return (hash ^ (hash >>> 16)) >>> 0;
}

export const mascotSeed = (workspace: string, chat: string): string => `${workspace}/${chat}`;

export const MASCOT_COLOURS = HUES.length;

/**
 * Which of the {@link MASCOT_COLOURS} an agent's tile is drawn in: a workspace's agents take the palette in birth order
 * (`PanelAgent.colour`) from a point its name picks, so {@link MASCOT_COLOURS} agents in a row never share one and an
 * agent's never changes. A hash of each agent alone gave two of a workspace's few agents one colour.
 */
export function mascotColour(workspace: string, rank: number): number {
  return (hashOf(workspace) + rank) % HUES.length;
}

type Face = "idle" | "working" | "waiting" | "failed" | "done";

const FACE: Record<AgentActivity, Face> = {
  idle: "idle", stopped: "idle", dismissed: "idle", working: "working", waiting: "waiting", failed: "failed", done: "done",
};

const STATUS: Partial<Record<Face, string>> = { working: "Working", waiting: "Needs you", failed: "Last turn failed", done: "Done" };

function Eyes({ face }: { face: Face }) {
  if (face === "failed") return <path d="M10.4 13.4l3.2 3.2M13.6 13.4l-3.2 3.2M18.4 13.4l3.2 3.2M21.6 13.4l-3.2 3.2" stroke="#fff" strokeWidth={1.8} strokeLinecap="round" />;

  if (face === "done") return <path d="M10.2 16.4q1.8-3 3.6 0M18.2 16.4q1.8-3 3.6 0" stroke="#fff" strokeWidth={2} strokeLinecap="round" fill="none" />;

  return (
    <g className="p-mascot-eyes" fill="#fff">
      <rect className="p-mascot-eye" x={10.4} y={11} width={3.2} height={8} rx={1.6} />
      <rect className="p-mascot-eye" x={18.4} y={11} width={3.2} height={8} rx={1.6} />
    </g>
  );
}

/** A chat's tile; its eyes carry its state. */
export function ChatMascot({ seed, colour, activity, size = 16 }: { seed: string; colour: number; activity: AgentActivity | undefined; size?: number }) {
  const hash = hashOf(seed);
  const hue = HUES[colour % HUES.length] ?? HUES[0];
  const id = `mascot${useId().replace(/[^\w-]/g, "")}`;
  const face = FACE[activity ?? "idle"];
  const status = STATUS[face];
  const style: CSSProperties & { readonly "--mascot-phase": string } = { "--mascot-phase": `-${String((hash >>> 9) % 40 / 10)}s` };

  const tile = (
    <svg width={size} height={size} viewBox="0 0 32 32" aria-hidden>
      <defs>
        <radialGradient id={id} cx="0.38" cy="0.3" r="0.85">
          <stop offset="0" stopColor={hue[0]} />
          <stop offset="0.65" stopColor={hue[1]} />
          <stop offset="1" stopColor={hue[2]} />
        </radialGradient>
        <clipPath id={`${id}c`}><rect x={4} y={4} width={24} height={24} rx={9} /></clipPath>
      </defs>
      <g className="p-mascot-tile">
        <rect x={4} y={4} width={24} height={24} rx={9} fill={`url(#${id})`} />
        {face === "working" && (
          <g clipPath={`url(#${id}c)`}><g className="p-mascot-sheen"><rect x={10} y={0} width={6} height={32} fill="#fff" opacity={0.32} transform="skewX(-18)" /></g></g>
        )}
        <path d="M9 8.6q4-2.4 9-1.6" stroke="#fff" strokeWidth={1.6} strokeLinecap="round" opacity={0.45} fill="none" />
        <Eyes face={face} />
      </g>
      {face === "waiting" && <circle className="p-mascot-badge" cx={26.4} cy={5.6} r={4} fill="var(--c-danger)" stroke="var(--mascot-ring, var(--c-bg))" strokeWidth={1.6} />}
    </svg>
  );

  if (status === undefined) return <span className="p-mascot" data-face={face} style={style}>{tile}</span>;

  return (
    <Tooltip content={status} side="bottom"
      render={<span className="p-mascot" data-face={face} style={style} role="img" aria-label={status} />}>
      {tile}
    </Tooltip>
  );
}

/** Only ever an image: nothing in a drawn logo runs. */
export function WorkspaceLogo({ title, logo, size = 16 }: { title: string; logo: string | null | undefined; size?: number }) {
  const radius = Math.round(size * 0.28);

  if (logo !== null && logo !== undefined) {
    return (
      <img src={`data:image/svg+xml;charset=utf-8,${encodeURIComponent(logo)}`} alt="" aria-hidden width={size} height={size}
        className="shrink-0 object-contain" style={{ borderRadius: radius }} data-workspace-logo="drawn" />
    );
  }

  return (
    <span aria-hidden data-workspace-logo="monogram" className="p-monogram"
      style={{ width: size, height: size, borderRadius: radius, fontSize: Math.round(size * 0.56) }}>
      {(title.trim()[0] ?? "?").toUpperCase()}
    </span>
  );
}

import { useId, type CSSProperties } from "react";
import { Tooltip } from "@cloudflare/kumo";
import { hueStops, rankHue, type AgentActivity } from "@kinu.run/core";

function hashOf(seed: string): number {
  let hash = 0x811c9dc5;

  for (let i = 0; i < seed.length; i += 1) hash = Math.imul(hash ^ seed.charCodeAt(i), 0x01000193);

  hash = Math.imul(hash ^ (hash >>> 16), 0x85ebca6b);
  hash = Math.imul(hash ^ (hash >>> 13), 0xc2b2ae35);

  return (hash ^ (hash >>> 16)) >>> 0;
}

export const mascotSeed = (workspace: string, chat: string): string => `${workspace}/${chat}`;

/**
 * The hue an agent's tile is drawn in: a workspace's agents step round the wheel in birth order (`PanelAgent.colour`)
 * from a point its name picks (`rankHue`), so no two of them ever share one and an agent's never changes.
 */
export function mascotColour(workspace: string, rank: number): number {
  return rankHue(hashOf(workspace), rank);
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

/** What a mascot wears; `null`, nothing. */
export type MascotAccessory = "crown" | "party" | "beanie" | "tophat" | "cap" | "bow" | "headphones" | "glasses" | "flower";

/** The accessories worn by chance; the crown is Main's alone. A few agents wear nothing, so a strip stays calm. */
const WORN: readonly (MascotAccessory | null)[] = [
  "party", "beanie", "tophat", "cap", "bow", "headphones", "glasses", "flower", null, null, null,
];

/**
 * What an agent wears, from its seed: the same on every reload and device, and apart from its colour, which its
 * workspace and birth rank pick. Main, whose seed is `<workspace>/main`, wears the crown.
 */
export function mascotAccessory(seed: string): MascotAccessory | null {
  if (seed.endsWith("/main")) return "crown";

  return WORN[(hashOf(seed) >>> 20) % WORN.length] ?? null;
}

/** Each accessory's colours are its own, read on both themes; a ring of the ground keeps it apart from the tile. */
const RING = { stroke: "var(--mascot-ring, var(--c-bg))", strokeWidth: 1.2, paintOrder: "stroke" } as const;

const INK = "#4A4366";

const GOLD = "#F2BE45";

/** Drawn on the tile's 32-unit grid: its top edge runs at y 4 and its eyes at x 12 and 20. Hats sit left of centre,
 *  away from the waiting dot at the top right, which is drawn over anything that reaches it. */
function Accessory({ kind }: { kind: MascotAccessory }) {
  switch (kind) {
    case "crown":
      return (
        <g {...RING}>
          <path d="M9.6 6.8 9 -0.4l3.5 3 3.5-5 3.5 5 3.5-3-.6 7.2z" fill={GOLD} strokeLinejoin="round" />
          <circle cx={16} cy={4.2} r={1.2} fill="#E0524F" stroke="none" />
        </g>
      );
    case "party":
      return (
        <g {...RING}>
          <path d="M9.4 6.8 20.8 5.6 14.2 -4.6z" fill={GOLD} strokeLinejoin="round" />
          <path d="M12.1 2.2l4.6-.6M10.8 4.6l7.6-.9" stroke="#E0524F" strokeWidth={1.3} fill="none" paintOrder="normal" />
          <circle cx={14.2} cy={-4.8} r={1.9} fill="#E0524F" />
        </g>
      );
    case "beanie":
      return (
        <g {...RING}>
          <path d="M8 7.4Q8-1.6 16-1.6t8 9z" fill="#4C86E0" />
          <rect x={7.4} y={4.4} width={17.2} height={3.6} rx={1.8} fill="#3366B5" />
          <circle cx={16} cy={-2.4} r={2.2} fill={GOLD} />
        </g>
      );
    case "tophat":
      return (
        <g {...RING}>
          <rect x={10.6} y={-3.4} width={10.8} height={9.4} rx={1} fill={INK} />
          <rect x={7.6} y={4.6} width={16.8} height={2.6} rx={1.3} fill={INK} />
          <rect x={10.6} y={1.6} width={10.8} height={2.2} fill={GOLD} stroke="none" />
        </g>
      );
    case "cap":
      return (
        <g {...RING}>
          <path d="M3 7.6q4-3 10-2.2V7.4q-6-.6-10 .2z" fill="#1F7A72" strokeLinejoin="round" />
          <path d="M9.6 6.6q0-7.6 7.2-7.6t7.2 7.6z" fill="#2FA39A" />
          <circle cx={16.8} cy={-1.1} r={1.1} fill="#1F7A72" stroke="none" />
        </g>
      );
    case "bow":
      return (
        <g {...RING} transform="rotate(-18 9.6 5.6)">
          <path d="M9.6 5.6 3.4 1.2v8.8zM9.6 5.6l6.2-4.4v8.8z" fill="#EC6FA8" strokeLinejoin="round" />
          <circle cx={9.6} cy={5.6} r={2.1} fill="#C94F88" />
        </g>
      );
    case "flower":
      return (
        <g {...RING}>
          {[0, 72, 144, 216, 288].map((turn) => (
            <circle key={turn} cx={9.4 + 2.8 * Math.cos((turn - 90) * Math.PI / 180)} cy={5.2 + 2.8 * Math.sin((turn - 90) * Math.PI / 180)} r={2.3} fill="#F07FAE" />
          ))}
          <circle cx={9.4} cy={5.2} r={1.8} fill={GOLD} stroke="none" />
        </g>
      );
    case "headphones":
      return (
        <g>
          <path d="M5.6 15Q5.6 1.4 16 1.4T26.4 15" stroke="#8C86A3" strokeWidth={2.2} fill="none" strokeLinecap="round" />
          <g {...RING}>
            <rect x={2} y={11.6} width={4.8} height={8.4} rx={2.2} fill="#E0524F" />
            <rect x={25.2} y={11.6} width={4.8} height={8.4} rx={2.2} fill="#E0524F" />
          </g>
        </g>
      );
    case "glasses":
      return (
        <g stroke={INK} strokeWidth={1.3} fill="#fff" fillOpacity={0.14}>
          <circle cx={12} cy={15} r={4.2} />
          <circle cx={20} cy={15} r={4.2} />
          <path d="M3.8 13.4l4-.6M28.2 13.4l-4-.6" fill="none" strokeLinecap="round" />
        </g>
      );
  }
}

/** How much larger than its box the tile's grid is drawn: the tile, 24 of its 32 units, nearly fills the box. */
const DRAWN = 1.25;

/**
 * A chat's tile, in `colour`, a hue ({@link mascotColour}); its eyes carry its state, and it wears what its seed picks
 * ({@link mascotAccessory}). It takes `size` in a row, as it always has; the grid's empty margin and what it wears
 * spill past that box.
 */
export function ChatMascot({ seed, colour, activity, size = 16 }: { seed: string; colour: number; activity: AgentActivity | undefined; size?: number }) {
  const hash = hashOf(seed);
  const accessory = mascotAccessory(seed);
  const drawn = size * DRAWN;
  const hue = hueStops(colour);
  const id = `mascot${useId().replace(/[^\w-]/g, "")}`;
  const face = FACE[activity ?? "idle"];
  const status = STATUS[face];
  const style: CSSProperties & { readonly "--mascot-phase": string } = { "--mascot-phase": `-${String((hash >>> 9) % 40 / 10)}s` };

  const tile = (
    <svg width={drawn} height={drawn} viewBox="0 0 32 32" style={{ margin: (size - drawn) / 2 }} aria-hidden>
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
        {accessory !== null && <Accessory kind={accessory} />}
      </g>
      {face === "waiting" && <circle className="p-mascot-badge" cx={26.4} cy={5.6} r={4} fill="var(--c-danger)" stroke="var(--mascot-ring, var(--c-bg))" strokeWidth={1.6} />}
    </svg>
  );

  if (status === undefined) return <span className="p-mascot" data-face={face} data-accessory={accessory ?? undefined} style={style}>{tile}</span>;

  return (
    <Tooltip content={status} side="bottom"
      render={<span className="p-mascot" data-face={face} data-accessory={accessory ?? undefined} style={style} role="img" aria-label={status} />}>
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

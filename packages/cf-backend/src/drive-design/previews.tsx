import type { CSSProperties, ReactNode } from "react";
import { FileIcon } from "@phosphor-icons/react";
import { tileBadge, tileWash } from "@/components/ui/cover";

export type SlateArt = "coupons" | "perf" | "ledger" | "release" | "palette" | "issues" | "inbox" | "game";

export type Preview =
  | { readonly kind: "slate"; readonly art: SlateArt }
  | { readonly kind: "cover"; readonly hue: number; readonly letter: string }
  | { readonly kind: "doc"; readonly heading: string; readonly lines: readonly string[] }
  | { readonly kind: "code"; readonly lines: readonly string[] }
  | { readonly kind: "sheet"; readonly rows: readonly (readonly string[])[] }
  | { readonly kind: "diagram" }
  | { readonly kind: "pdf"; readonly heading: string }
  | { readonly kind: "generic"; readonly ext: string }
  | { readonly kind: "upload"; readonly progress: number };

const ink = (token: string): CSSProperties => ({ fill: `var(--c-${token})` });

const line = (token: string): CSSProperties => ({ stroke: `var(--c-${token})`, fill: "none" });

const MONO: CSSProperties = { fontFamily: "var(--font-mono)" };

function Frame({ children, ground = "bg" }: { children: ReactNode; ground?: string }) {
  return (
    <svg viewBox="0 0 320 200" preserveAspectRatio="xMidYMid slice" aria-hidden="true" className="absolute inset-0 size-full">
      <rect width="320" height="200" style={ink(ground)} />
      {children}
    </svg>
  );
}

function Title({ text, caption }: { text: string; caption?: string }) {
  return (
    <>
      <text x="20" y="31" fontSize="13" fontWeight="600" style={ink("text")}>{text}</text>
      {caption !== undefined && <text x="300" y="31" fontSize="8.5" textAnchor="end" style={ink("text-3")}>{caption}</text>}
    </>
  );
}

const COUPONS = [
  { code: "SAVE20", type: "percent", used: 0.72, live: true },
  { code: "FREESHIP", type: "shipping", used: 0.45, live: true },
  { code: "LEGACY15", type: "percent", used: 0.9, live: false },
  { code: "WELCOME", type: "fixed", used: 0.3, live: true },
  { code: "SPRING10", type: "percent", used: 0.58, live: true },
];

function Coupons() {
  return (
    <Frame>
      <Title text="Coupon board" caption="4 active · 1 paused" />
      {COUPONS.map((row, index) => (
        <g key={row.code} transform={`translate(20 ${String(44 + index * 30)})`}>
          <rect width="280" height="24" rx="6" style={{ ...ink("surface"), stroke: "var(--c-border)" }} />
          <text x="11" y="15.5" fontSize="8.5" style={{ ...ink("text-2"), ...MONO }}>{row.code}</text>
          <text x="86" y="15.5" fontSize="8" style={ink("text-3")}>{row.type}</text>
          <rect x="146" y="10" width="68" height="4" rx="2" style={ink("border-strong")} />
          <rect x="146" y="10" width={68 * row.used} height="4" rx="2" style={ink("accent")} />
          <rect x="230" y="5.5" width="40" height="13" rx="6.5" style={{ fill: row.live ? "var(--c-success-tint)" : "var(--c-warning-tint)" }} />
          <text x="250" y="14.5" fontSize="7" textAnchor="middle" style={ink(row.live ? "success" : "warning")}>{row.live ? "active" : "paused"}</text>
        </g>
      ))}
    </Frame>
  );
}

const VITALS = [
  { label: "LCP", value: "1.8 s", share: 0.78, tone: "success" },
  { label: "INP", value: "120 ms", share: 0.7, tone: "success" },
  { label: "CLS", value: "0.02", share: 0.9, tone: "success" },
  { label: "TBT", value: "310 ms", share: 0.42, tone: "warning" },
];

function Perf() {
  const radius = 38;
  const round = 2 * Math.PI * radius;

  return (
    <Frame>
      <Title text="Landing performance" caption="mobile · p75" />
      <circle cx="78" cy="112" r={radius} strokeWidth="9" style={line("border-strong")} />
      <circle cx="78" cy="112" r={radius} strokeWidth="9" strokeLinecap="round" transform="rotate(-90 78 112)"
        strokeDasharray={`${String(round * 0.92)} ${String(round)}`} style={line("success")} />
      <text x="78" y="118" fontSize="22" fontWeight="600" textAnchor="middle" style={ink("text")}>92</text>
      <text x="78" y="166" fontSize="8" textAnchor="middle" style={ink("text-3")}>score</text>
      {VITALS.map((row, index) => (
        <g key={row.label} transform={`translate(148 ${String(62 + index * 32)})`}>
          <text x="0" y="9" fontSize="8" style={{ ...ink("text-3"), ...MONO }}>{row.label}</text>
          <text x="152" y="9" fontSize="10" fontWeight="600" textAnchor="end" style={ink("text")}>{row.value}</text>
          <rect x="0" y="16" width="152" height="4" rx="2" style={ink("border-strong")} />
          <rect x="0" y="16" width={152 * row.share} height="4" rx="2" style={ink(row.tone)} />
        </g>
      ))}
    </Frame>
  );
}

const RECEIPTS = [
  { who: "Figma", tag: "Software", amount: "$45.00" },
  { who: "United Airlines", tag: "Travel", amount: "$412.80" },
  { who: "Blue Bottle", tag: "Meals", amount: "$18.50" },
  { who: "AWS", tag: "Infra", amount: "$233.10" },
  { who: "Notion", tag: "Software", amount: "$16.00" },
];

function Ledger() {
  return (
    <Frame>
      <Title text="Receipts · September" caption="$1,284.50" />
      <text x="20" y="54" fontSize="7" style={{ ...ink("text-4"), ...MONO }}>MERCHANT</text>
      <text x="150" y="54" fontSize="7" style={{ ...ink("text-4"), ...MONO }}>CATEGORY</text>
      <text x="300" y="54" fontSize="7" textAnchor="end" style={{ ...ink("text-4"), ...MONO }}>AMOUNT</text>
      {RECEIPTS.map((row, index) => (
        <g key={row.who} transform={`translate(0 ${String(62 + index * 27)})`}>
          <line x1="20" x2="300" y1="0" y2="0" strokeDasharray="2 2" style={line("dash")} />
          <text x="20" y="17" fontSize="8.5" style={ink("text-2")}>{row.who}</text>
          <rect x="148" y="7" width={row.tag.length * 4.6 + 12} height="13" rx="6.5" style={ink("neutral-tint")} />
          <text x="154" y="16.5" fontSize="7" style={ink("text-3")}>{row.tag}</text>
          <text x="300" y="17" fontSize="8.5" textAnchor="end" style={{ ...ink("text"), ...MONO }}>{row.amount}</text>
        </g>
      ))}
    </Frame>
  );
}

const CHECKS = [
  { text: "Migrations applied", done: true },
  { text: "Coupon guard tests pass", done: true },
  { text: "Canary at 5%", done: true },
  { text: "Error rate under 0.1%", done: true },
  { text: "Canary at 50%", done: false },
];

function Release() {
  return (
    <Frame>
      <Title text="Release 2.14" caption="4 of 5" />
      <rect x="20" y="42" width="280" height="4" rx="2" style={ink("border-strong")} />
      <rect x="20" y="42" width={280 * 0.8} height="4" rx="2" style={ink("accent")} />
      {CHECKS.map((row, index) => (
        <g key={row.text} transform={`translate(20 ${String(62 + index * 27)})`}>
          {row.done
            ? <><circle cx="8" cy="8" r="7" style={ink("success")} /><path d="M4.6 8.2l2.3 2.3 4.4-4.6" strokeWidth="1.6" style={line("bg")} /></>
            : <circle cx="8" cy="8" r="6.5" strokeWidth="1.2" style={line("text-4")} />}
          <text x="24" y="11" fontSize="9" style={ink(row.done ? "text-3" : "text")}>{row.text}</text>
        </g>
      ))}
    </Frame>
  );
}

const SWATCHES = [
  { hex: "#0F0D0B", name: "ground" }, { hex: "#181512", name: "card" }, { hex: "#332C23", name: "line" },
  { hex: "#9C9184", name: "dim" }, { hex: "#EDE5D8", name: "ink" }, { hex: "#E0A458", name: "gold" },
  { hex: "#E3D2AE", name: "silk" }, { hex: "#8FBC8B", name: "good" }, { hex: "#C97B6B", name: "bad" }, { hex: "#8FB6D6", name: "info" },
];

function Palette() {
  return (
    <Frame>
      <Title text="Warm tokens" caption="10 colours" />
      {SWATCHES.map((swatch, index) => {
        const x = 20 + (index % 5) * 57;
        const y = index < 5 ? 46 : 120;

        return (
          <g key={swatch.name}>
            <rect x={x} y={y} width="52" height="50" rx="7" fill={swatch.hex} style={{ stroke: "var(--c-border)" }} />
            <text x={x} y={y + 62} fontSize="7" style={{ ...ink("text-3"), ...MONO }}>{swatch.name}</text>
          </g>
        );
      })}
    </Frame>
  );
}

const LANES = [
  { title: "Triage", cards: [0.8, 0.55, 0.7] },
  { title: "Doing", cards: [0.65, 0.85] },
  { title: "Done", cards: [0.7, 0.5, 0.6] },
];

const LABEL_TONES = ["info", "warning", "success", "accent"];

function Issues() {
  return (
    <Frame>
      <Title text="Issues" caption="8 open" />
      {LANES.map((lane, column) => {
        const x = 20 + column * 95;

        return (
          <g key={lane.title}>
            <text x={x} y="55" fontSize="8" style={ink("text-3")}>{lane.title}</text>
            <text x={x + 88} y="55" fontSize="7.5" textAnchor="end" style={{ ...ink("text-4"), ...MONO }}>{lane.cards.length}</text>
            {lane.cards.map((width, row) => (
              <g key={row} transform={`translate(${String(x)} ${String(63 + row * 42)})`}>
                <rect width="88" height="36" rx="6" style={{ ...ink("surface"), stroke: "var(--c-border)" }} />
                <rect x="8" y="9" width={72 * width} height="4" rx="2" style={ink("text-3")} />
                <rect x="8" y="17" width={48 * width} height="4" rx="2" style={ink("border-strong")} />
                <circle cx="12" cy="28" r="2.5" style={ink(LABEL_TONES[(column + row) % LABEL_TONES.length] ?? "info")} />
              </g>
            ))}
          </g>
        );
      })}
    </Frame>
  );
}

const MAIL = [
  { who: "Maya Chen", about: "Roadmap review moved to Thursday", at: "8:02", hue: 20, unread: true },
  { who: "GitHub", about: "3 pull requests need your review", at: "7:45", hue: 250, unread: true },
  { who: "Stripe", about: "A payout of $4,210 is on its way", at: "7:30", hue: 280, unread: false },
  { who: "Priya Nair", about: "Notes from the design crit", at: "6:58", hue: 150, unread: false },
  { who: "Linear", about: "Your weekly cycle summary", at: "6:30", hue: 200, unread: false },
];

function Inbox() {
  return (
    <Frame>
      <Title text="Morning digest" caption="Tue 23 Sep" />
      {MAIL.map((row, index) => (
        <g key={row.who} transform={`translate(20 ${String(46 + index * 30)})`}>
          <circle cx="10" cy="11" r="10" style={{ fill: `oklch(62% 0.12 ${String(row.hue)} / 0.35)` }} />
          <text x="10" y="14.5" fontSize="8.5" fontWeight="600" textAnchor="middle" style={{ fill: `color-mix(in oklch, oklch(62% 0.14 ${String(row.hue)}) 60%, var(--c-text))` }}>
            {row.who.charAt(0)}
          </text>
          <text x="28" y="9" fontSize="8.5" fontWeight={row.unread ? "600" : "400"} style={ink(row.unread ? "text" : "text-2")}>{row.who}</text>
          <text x="28" y="20" fontSize="7.5" style={ink("text-3")}>{row.about}</text>
          <text x="280" y="9" fontSize="7" textAnchor="end" style={{ ...ink("text-4"), ...MONO }}>{row.at}</text>
          {row.unread && <circle cx="276" cy="17" r="2.5" style={ink("accent")} />}
        </g>
      ))}
    </Frame>
  );
}

type GameTile = 0 | 2 | 4 | 8 | 16 | 32 | 64 | 128 | 256 | 512;

const BOARD: readonly (readonly GameTile[])[] = [
  [0, 2, 0, 4],
  [2, 8, 16, 2],
  [4, 32, 64, 8],
  [8, 128, 256, 512],
];

const TILE_FILL: Record<Exclude<GameTile, 0>, string> = {
  2: "#EEE4DA", 4: "#EDE0C8", 8: "#F2B179", 16: "#F59563", 32: "#F67C5F", 64: "#F65E3B",
  128: "#EDCF72", 256: "#EDCC61", 512: "#EDC850",
};

function Game() {
  return (
    <Frame>
      <Title text="2048" caption="Score 3,412 · Best 4,096" />
      <rect x="92" y="48" width="136" height="136" rx="6" style={ink("border-strong")} />
      {BOARD.flatMap((row, y) => row.map((value, x) => {
        const left = 96 + x * 33;
        const top = 52 + y * 33;
        const size = value < 100 ? 13 : 10.5;

        return (
          <g key={`${String(y)}-${String(x)}`}>
            <rect x={left} y={top} width="29" height="29" rx="4" style={value === 0 ? ink("recessed") : { fill: TILE_FILL[value] }} />
            {value > 0 && (
              <text x={left + 14.5} y={top + 14.5 + size * 0.36} fontSize={size} fontWeight="700" textAnchor="middle"
                fill={value <= 4 ? "#776E65" : "#F9F6F2"}>{value}</text>
            )}
          </g>
        );
      }))}
    </Frame>
  );
}

const ART: Record<SlateArt, () => ReactNode> = {
  coupons: Coupons, perf: Perf, ledger: Ledger, release: Release, palette: Palette, issues: Issues, inbox: Inbox, game: Game,
};

function Cover({ hue, letter }: { hue: number; letter: string }) {
  return (
    <span className="absolute inset-0 flex items-center justify-center p-recessed" style={tileWash(hue)}>
      <span className="flex size-11 items-center justify-center rounded-xl text-lg font-semibold" style={tileBadge(hue)}>
        {letter}
      </span>
    </span>
  );
}

function Page({ heading, lines, band }: { heading: string; lines: readonly string[]; band?: boolean }) {
  return (
    <Frame ground="recessed">
      <rect x="44" y="18" width="232" height="200" rx="6" style={{ ...ink("surface"), stroke: "var(--c-border)" }} />
      {band === true && <rect x="44.5" y="18.5" width="231" height="34" rx="5.5" style={{ fill: "var(--c-danger-tint)" }} />}
      <text x="62" y={band === true ? 40 : 46} fontSize="13" fontWeight="600" style={ink(band === true ? "danger" : "text")}>{heading}</text>
      {lines.map((text, index) => (
        <text key={index} x="62" y={(band === true ? 70 : 66) + index * 13} fontSize="8" style={ink("text-3")}>{text}</text>
      ))}
    </Frame>
  );
}

const KEYWORDS: ReadonlySet<string> = new Set(["import", "export", "async", "function", "const", "for", "await", "return", "set", "echo"]);

function Code({ lines }: { lines: readonly string[] }) {
  return (
    <Frame ground="recessed">
      {lines.map((text, index) => {
        const indent = text.length - text.trimStart().length;
        const body = text.trimStart();
        const first = body.split(" ", 1)[0] ?? "";
        const keyword = KEYWORDS.has(first) ? first : undefined;

        return (
          <text key={index} x={20 + indent * 5.4} y={30 + index * 17} fontSize="9" style={MONO}>
            <tspan x="20" style={ink("text-4")} textAnchor="start">{String(index + 1).padStart(2, " ")}</tspan>
            {keyword === undefined
              ? <tspan x={40 + indent * 5.4} style={ink("text-2")}>{body}</tspan>
              : <><tspan x={40 + indent * 5.4} style={ink("accent-fg")}>{keyword}</tspan><tspan style={ink("text-2")}>{body.slice(keyword.length)}</tspan></>}
          </text>
        );
      })}
    </Frame>
  );
}

function Sheet({ rows }: { rows: readonly (readonly string[])[] }) {
  const widths = [60, 72, 72, 64];

  return (
    <Frame ground="surface">
      <rect x="0" y="0" width="320" height="30" style={ink("recessed")} />
      {rows.map((cells, row) => {
        let x = 20;

        return (
          <g key={row} transform={`translate(0 ${String(row * 26)})`}>
            {row > 0 && <line x1="0" x2="320" y1="4" y2="4" style={line("border")} />}
            {cells.map((cell, column) => {
              const at = x;
              x += widths[column] ?? 64;

              const style = row === 0 ? ink("text-2") : { ...ink("text-3"), ...MONO };

              return (
                <text key={column} x={column === 0 ? at : at + (widths[column] ?? 64) - 12} y="21" fontSize="8.5"
                  textAnchor={column === 0 ? "start" : "end"} fontWeight={row === 0 ? "600" : "400"} style={style}>{cell}</text>
              );
            })}
          </g>
        );
      })}
    </Frame>
  );
}

function Diagram() {
  return (
    <svg viewBox="0 0 320 200" preserveAspectRatio="xMidYMid slice" aria-hidden="true" className="absolute inset-0 size-full">
      <rect width="320" height="200" fill="#F5F0E6" />
      <g fill="none" stroke="#9A8F80" strokeWidth="1.4">
        <path d="M96 64 H140" /><path d="M200 64 H232" /><path d="M170 82 V118" /><path d="M170 150 V160 H96 V150" /><path d="M170 160 H244 V150" />
      </g>
      <g fontSize="9" fontWeight="600" textAnchor="middle">
        <rect x="28" y="46" width="68" height="36" rx="8" fill="#E7DCC8" stroke="#B9A98C" /><text x="62" y="68" fill="#4A3F31">Browser</text>
        <rect x="140" y="46" width="60" height="36" rx="8" fill="#F2D2A4" stroke="#D39A4E" /><text x="170" y="68" fill="#6B4312">Worker</text>
        <rect x="232" y="46" width="64" height="36" rx="8" fill="#D8E4EE" stroke="#7FA2C0" /><text x="264" y="68" fill="#2F4F6B">Auth</text>
        <rect x="128" y="118" width="84" height="32" rx="8" fill="#DDE9D9" stroke="#86AD82" /><text x="170" y="138" fill="#2F5A2E">Workspace DO</text>
        <rect x="54" y="118" width="60" height="32" rx="8" fill="#EDE3F3" stroke="#A98CC0" /><text x="84" y="138" fill="#4E3566">Drive</text>
        <rect x="222" y="118" width="62" height="32" rx="8" fill="#EFE0D6" stroke="#C49376" /><text x="253" y="138" fill="#6A3D25">Sandbox</text>
      </g>
    </svg>
  );
}

function Generic({ ext }: { ext: string }) {
  return (
    <span className="absolute inset-0 flex flex-col items-center justify-center gap-2 p-recessed">
      <FileIcon size={34} weight="light" className="p-text-4" />
      <span className="p-annotation uppercase p-text-3">{ext}</span>
    </span>
  );
}

function Upload({ progress }: { progress: number }) {
  return (
    <span className="absolute inset-0 flex flex-col items-center justify-center gap-2.5 p-recessed">
      <span className="p-meta tabular-nums p-text-2">{Math.round(progress * 100)}%</span>
      <span className="h-1 w-1/2 overflow-hidden rounded-full bg-[var(--c-border-strong)]">
        <span className="block h-full rounded-full bg-[var(--c-accent)]" style={{ width: `${String(progress * 100)}%` }} />
      </span>
    </span>
  );
}

export function PreviewPicture({ preview }: { preview: Preview }) {
  switch (preview.kind) {
    case "slate": {
      const Art = ART[preview.art];

      return <Art />;
    }

    case "cover": return <Cover hue={preview.hue} letter={preview.letter} />;
    case "doc": return <Page heading={preview.heading} lines={preview.lines} />;
    case "code": return <Code lines={preview.lines} />;
    case "sheet": return <Sheet rows={preview.rows} />;
    case "diagram": return <Diagram />;
    case "pdf": return <Page heading={preview.heading} band lines={["Voice, type and colour for every", "surface we ship.", "", "1. Voice", "2. Type", "3. Colour", "4. Motion"]} />;
    case "generic": return <Generic ext={preview.ext} />;
    case "upload": return <Upload progress={preview.progress} />;
  }
}

export function SkillPicture({ name, description, steps }: { name: string; description: string; steps: readonly string[] }) {
  const lead: string[] = [];
  let current = "";

  for (const word of description.split(" ")) {
    if (`${current} ${word}`.trim().length > 30) {
      lead.push(current);
      current = word;
    } else {
      current = `${current} ${word}`.trim();
    }
  }

  if (current !== "") lead.push(current);
  const stepsAt = 70 + lead.length * 15 + 14;

  return (
    <Frame ground="recessed">
      <rect x="44" y="16" width="232" height="200" rx="6" style={{ ...ink("surface"), stroke: "var(--c-border)" }} />
      <text x="62" y="46" fontSize="16" fontWeight="600" style={ink("text")}>{name}</text>
      {lead.map((text, index) => <text key={index} x="62" y={70 + index * 15} fontSize="10" style={ink("text-2")}>{text}</text>)}
      <text x="62" y={stepsAt} fontSize="9" fontWeight="600" style={ink("text-3")}>Steps</text>
      {steps.map((text, index) => (
        <text key={text} x="62" y={stepsAt + 16 + index * 14} fontSize="9" style={ink("text-3")}>{`${String(index + 1)}. ${text}`}</text>
      ))}
    </Frame>
  );
}

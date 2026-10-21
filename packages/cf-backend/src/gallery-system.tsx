/**
 * The design system on one page (`?frame=system`; docs/DESIGN-SYSTEM.md §5), for the owner to approve as a whole: every
 * token and component, each section drawn four times, once per look (Graphite and Warm, dark and light), each quadrant
 * scoped by its own `data-theme` and `data-mode`. Every number on it (a hex, a ratio, a size) is read from the live
 * computed style, so the page cannot say one thing while the code does another.
 */
import { createContext, useCallback, useContext, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";
import {
  ArrowSquareOutIcon, DesktopTowerIcon, GearSixIcon, GridFourIcon, HardDrivesIcon, ListIcon, PencilSimpleIcon,
  PlugsConnectedIcon, PlusIcon, PuzzlePieceIcon, SquaresFourIcon, TrashIcon, TrayIcon, UserCircleIcon,
} from "@phosphor-icons/react";
import { Avatar } from "@/components/ui/Avatar";
import { Badge } from "@/components/ui/Badge";
import { BrandMark } from "@/components/ui/BrandMark";
import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { Checkbox, RadioGroup } from "@/components/ui/Check";
import { Chip } from "@/components/ui/Chip";
import { CopyField } from "@/components/ui/CopyField";
import { Empty } from "@/components/ui/Empty";
import { FlowStep } from "@/components/ui/FlowCard";
import { Field, TextArea, TextInput } from "@/components/ui/Field";
import { Group } from "@/components/ui/Group";
import { Loader, Skeleton } from "@/components/ui/Loader";
import { Menu } from "@/components/ui/Menu";
import { Meter } from "@/components/ui/Meter";
import { DialogBox } from "@/components/ui/Modal";
import { Notice } from "@/components/ui/Notice";
import { Popover } from "@/components/ui/Popover";
import { Pressable } from "@/components/ui/Pressable";
import { Row, ROW_ACTION, RowTile } from "@/components/ui/Row";
import { SaveBar } from "@/components/ui/SaveBar";
import { Segmented } from "@/components/ui/Segmented";
import { Select } from "@/components/ui/Select";
import { Status, type StatusTone } from "@/components/ui/Status";
import { Switch } from "@/components/ui/Switch";
import { Table } from "@/components/ui/Table";
import { Tabs } from "@/components/ui/Tabs";
import { CaptureMat, TILE, TILE_GRID, TileShell, TypesetCover } from "@/components/ui/Tiles";
import { Tooltip } from "@/components/ui/Tooltip";
import { ChatMascot, personMascot, WorkspaceLogo } from "@/components/Marks";
import { KumoPortalProvider } from "@cloudflare/kumo";
import { THEME_NAMES, type ThemeName } from "@kinu.run/core";
import { GALLERY_PICTURE, galleryPicture } from "@/gallery-pictures";

/** The face the frame's mascots wear: a person's assistant, as Home's tile draws it. */
const ADA = personMascot("Ada Lovelace");

const LOOKS = THEME_NAMES.flatMap((look) => (["light", "dark"] as const).map((mode) => ({ look, mode })));

const LOOK_NAME: Record<ThemeName, string> = { graphite: "Graphite", warm: "Warm" };

const GROUNDS = ["--c-bg", "--c-sidebar", "--c-sunken", "--c-surface", "--c-field", "--c-fill", "--c-overlay"] as const;

const WASHES = ["--c-hover", "--c-pressed", "--c-selected"] as const;

const LINES = ["--c-border", "--c-border-strong", "--c-field-border", "--c-dash", "--c-button-line"] as const;

/** Each ink and the least ratio docs/DESIGN-SYSTEM.md §1.1 holds it to on a ground. */
const INKS = [["--c-text", 12], ["--c-text-2", 7], ["--c-text-3", 4.5], ["--c-accent-fg", 4.5]] as const;

const TEXT_GROUNDS = [...GROUNDS, "--c-hover", "--c-selected"] as const;

const TYPE_ROLES = ["t-hero", "t-page-title", "t-title", "t-nav", "t-label", "t-item", "t-body", "t-control", "t-meta", "t-status", "t-micro", "t-composer", "t-code"] as const;

const SPACING = [4, 8, 12, 16, 20, 24, 32, 48, 64] as const;

const RADII = ["--r-check", "--r-inner", "--r-control", "--r-row", "--r-card", "--r-pill"] as const;

const ELEVATION = [["0 · card, tile, group", "none"], ["1 · buttons, thumb", "var(--shadow-button)"], ["2 · menu, popover, save bar", "var(--shadow-menu)"], ["3 · dialog", "var(--shadow-overlay)"]] as const;

const STATUS_TONES = ["success", "warning", "danger", "info", "neutral", "accent"] as const satisfies readonly StatusTone[];

const VARIANTS = ["primary", "secondary", "ghost", "danger", "destructive"] as const;

const STATES = ["rest", "hover", "active", "focus", "disabled", "busy"] as const;

type Rgba = readonly [number, number, number, number];

/** A colour as the engine computed it: `rgb(…)`, `rgba(…)` or `color(srgb …)`. */
function parse(value: string): Rgba {
  const numbers = value.match(/[\d.]+/gu)?.map(Number) ?? [];

  if (value.startsWith("color(")) return [(numbers[0] ?? 0) * 255, (numbers[1] ?? 0) * 255, (numbers[2] ?? 0) * 255, numbers[3] ?? 1];

  return [numbers[0] ?? 0, numbers[1] ?? 0, numbers[2] ?? 0, numbers[3] ?? 1];
}

function over(top: Rgba, under: Rgba): Rgba {
  const alpha = top[3];

  return [top[0] * alpha + under[0] * (1 - alpha), top[1] * alpha + under[1] * (1 - alpha), top[2] * alpha + under[2] * (1 - alpha), 1];
}

function luminance([r, g, b]: Rgba): number {
  const channel = (value: number) => {
    const s = value / 255;

    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };

  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

function ratio(ink: Rgba, paper: Rgba): number {
  const a = luminance(over(ink, paper));
  const b = luminance(paper);

  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}

function hex([r, g, b, a]: Rgba): string {
  const two = (value: number) => Math.round(value).toString(16).padStart(2, "0").toUpperCase();

  return a < 1 ? `${two(r)}${two(g)}${two(b)} @${String(Math.round(a * 100))}%` : `#${two(r)}${two(g)}${two(b)}`;
}

/** Every token's colour in the look `scope` sits in, read through a probe that paints in it. */
function useLook(): [React.RefObject<HTMLDivElement | null>, (token: string) => Rgba] {
  const scope = useRef<HTMLDivElement | null>(null);
  const [read, setRead] = useState<Record<string, Rgba>>({});

  useLayoutEffect(() => {
    const root = scope.current;

    if (root === null) return;

    const probe = document.createElement("span");
    const seen: Record<string, Rgba> = {};

    // `appendChild`: the Workers types' HTMLRewriter `Element.append` shadows the DOM's here.
    root.appendChild(probe);

    for (const token of [...GROUNDS, ...WASHES, ...LINES, ...INKS.map(([ink]) => ink), "--c-accent", "--c-accent-on", "--c-focus", "--c-danger", "--c-danger-on"]) {
      probe.style.color = `var(${token})`;
      seen[token] = parse(getComputedStyle(probe).color);
    }

    probe.remove();
    setRead(seen);
  }, []);

  return [scope, (token) => read[token] ?? [0, 0, 0, 0]];
}

const WASHED: ReadonlySet<string> = new Set(WASHES);

function groundOf(colour: (token: string) => Rgba, ground: string): Rgba {
  return WASHED.has(ground) ? over(colour(ground), colour("--c-bg")) : colour(ground);
}

/** One look's quadrant: its name, then the section drawn in it. */
function Quadrant({ look, mode, children }: { look: ThemeName; mode: "light" | "dark"; children: (colour: (token: string) => Rgba) => ReactNode }) {
  const [scope, colour] = useLook();

  // Kumo's popups (a menu, a select, a popover) open inside the quadrant, so they wear its look and not the page's.
  return (
    <div ref={scope} data-theme={look} data-mode={mode} data-system-look={`${look}-${mode}`} className="relative min-w-0 rounded-[var(--r-card)] border p-border p-bg p-text p-6">
      <p className="mb-4 t-label">{LOOK_NAME[look]} {mode}</p>
      <KumoPortalProvider container={scope}>{children(colour)}</KumoPortalProvider>
    </div>
  );
}

function Section({ id, title, note, children }: { id: string; title: string; note?: string; children: (colour: (token: string) => Rgba) => ReactNode }) {
  return (
    <section id={id} className="space-y-3" data-system-section={id}>
      <h2 className="t-page-title">{title}</h2>
      {note !== undefined && <p className="max-w-3xl t-body">{note}</p>}
      <div className="grid gap-4 xl:grid-cols-2">
        {LOOKS.map(({ look, mode }) => <Quadrant key={`${look}-${mode}`} look={look} mode={mode}>{children}</Quadrant>)}
      </div>
    </section>
  );
}

/** A measure as the engine computed it on the element it labels: `read` of the element `children` draws. */
function Measured({ read, children }: { read: (style: CSSStyleDeclaration) => string; children: ReactNode }) {
  const box = useRef<HTMLSpanElement | null>(null);
  const [value, setValue] = useState("");

  useLayoutEffect(() => {
    const first = box.current?.firstElementChild;

    if (first instanceof HTMLElement) setValue(read(getComputedStyle(first)));
  }, [read]);

  return (
    <span ref={box} className="flex min-w-0 flex-col gap-1">
      {children}
      <span className="t-meta t-mono">{value}</span>
    </span>
  );
}

function Pass({ value, floor }: { value: number; floor: number }) {
  return <span className={`t-meta t-mono ${value >= floor ? "p-success" : "p-danger"}`}>{value.toFixed(2)}{value >= floor ? "" : ` < ${String(floor)}`}</span>;
}

function Grounds() {
  return (
    <Section id="grounds" title="Grounds and washes" note="Each ground with its hex and its ratio against the page; each wash over the page and over a card.">
      {(colour) => (
        <div className="space-y-4">
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
            {GROUNDS.map((ground) => (
              <div key={ground} className="rounded-[var(--r-control)] border p-border p-3" style={{ background: `var(${ground})` }}>
                <p className="t-item">{ground.slice(4)}</p>
                <p className="t-meta t-mono">{hex(colour(ground))}</p>
                <p className="t-meta t-mono">{ratio(colour(ground), colour("--c-bg")).toFixed(2)} on bg</p>
              </div>
            ))}
          </div>
          <div className="grid grid-cols-3 gap-2">
            {WASHES.map((wash) => (
              <div key={wash} className="space-y-1">
                <p className="t-meta">{wash.slice(4)}</p>
                <div className="h-8 rounded-[var(--r-row)]" style={{ background: `var(${wash})` }} />
                <div className="rounded-[var(--r-row)] p-surface p-1"><div className="h-6 rounded-[var(--r-control)]" style={{ background: `var(${wash})` }} /></div>
              </div>
            ))}
          </div>
        </div>
      )}
    </Section>
  );
}

function Lines() {
  return (
    <Section id="lines" title="Lines" note="Each line as a 1 px rule on the page and on a card, with its ratio on each.">
      {(colour) => (
        <div className="space-y-2">
          {LINES.map((line) => (
            <div key={line} className="grid grid-cols-[120px_1fr_1fr] items-center gap-3">
              <p className="t-meta">{line.slice(4)}</p>
              <span className="flex items-center gap-2"><span className="h-px flex-1" style={{ background: `var(${line})` }} /><span className="t-meta t-mono">{ratio(colour(line), colour("--c-bg")).toFixed(2)}</span></span>
              <span className="flex items-center gap-2 rounded-[var(--r-control)] p-surface px-2 py-3"><span className="h-px flex-1" style={{ background: `var(${line})` }} /><span className="t-meta t-mono">{ratio(colour(line), colour("--c-surface")).toFixed(2)}</span></span>
            </div>
          ))}
        </div>
      )}
    </Section>
  );
}

function Text() {
  return (
    <Section id="text" title="Text" note="Each ink on every ground it can land on, with its measured ratio, green when it clears its floor (text 12, text-2 7, text-3 and accent-fg 4.5).">
      {(colour) => (
        <div className="overflow-x-auto">
          <table className="w-full">
            <thead><tr><th className="pb-2 text-left t-meta">ground</th>{INKS.map(([ink]) => <th key={ink} className="pb-2 text-left t-meta">{ink.slice(4)}</th>)}</tr></thead>
            <tbody>
              {TEXT_GROUNDS.map((ground) => (
                <tr key={ground} style={{ background: `var(${ground})` }}>
                  <td className="px-2 py-1 t-meta">{ground.slice(4)}</td>
                  {INKS.map(([ink, floor]) => (
                    <td key={ink} className="px-2 py-1">
                      <span className="mr-2 t-item" style={{ color: `var(${ink})` }}>Aa</span>
                      <Pass value={ratio(colour(ink), groundOf(colour, ground))} floor={ink === "--c-text-2" && !["--c-bg", "--c-surface"].includes(ground) ? 4.5 : floor} />
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Section>
  );
}

function AccentAndStatus() {
  return (
    <Section id="accent" title="Accent, focus and status" note="The accent fill with its ink, the focus ring on the page and on a card, and each status as ink, Status, Chip and Notice.">
      {(colour) => (
        <div className="space-y-4">
          <div className="flex flex-wrap items-center gap-3">
            <span className="rounded-[var(--r-control)] px-3 py-1 t-control" style={{ background: "var(--c-accent)", color: "var(--c-accent-on)" }}>accent-on on accent · {ratio(colour("--c-accent-on"), colour("--c-accent")).toFixed(2)}</span>
            <span className="rounded-[var(--r-control)] px-3 py-1 t-control" style={{ background: "var(--c-danger)", color: "var(--c-danger-on)" }}>danger-on on danger · {ratio(colour("--c-danger-on"), colour("--c-danger")).toFixed(2)}</span>
            <Button data-force="focus">Focus on the page · {ratio(colour("--c-focus"), colour("--c-bg")).toFixed(2)}</Button>
            <span className="rounded-[var(--r-control)] p-surface p-2"><Button data-force="focus">on a card · {ratio(colour("--c-focus"), colour("--c-surface")).toFixed(2)}</Button></span>
          </div>
          {(["success", "warning", "danger", "info"] as const).map((tone) => (
            <div key={tone} className="flex flex-wrap items-center gap-3">
              <Status tone={tone}>{tone}</Status>
              <Chip tone={tone}>{tone}</Chip>
              <div className="min-w-0 flex-1"><Notice tone={tone}>A {tone} notice says what applies here.</Notice></div>
            </div>
          ))}
        </div>
      )}
    </Section>
  );
}

/** A role as it renders: weight, size over line, tracking where it has one, and the face it lands on. */
function typeOf(role: string, style: CSSStyleDeclaration): string {
  const face = style.fontFamily.split(",")[0]?.replaceAll('"', "").trim() ?? "";
  const tracking = style.letterSpacing === "normal" ? "" : ` · ${style.letterSpacing}`;

  return `${role} · ${style.fontWeight} ${style.fontSize}/${style.lineHeight}${tracking} · ${face}`;
}

function Type() {
  return (
    <Section id="type" title="Type" note="Each role as it renders: its size, line, weight and tracking read from the page.">
      {() => (
        <div className="space-y-3">
          {TYPE_ROLES.map((role) => (
            <Measured key={role} read={(style) => typeOf(role, style)}>
              <span className={`${role} truncate`}>Kinu ships what you ask for — 0123456789</span>
            </Measured>
          ))}
          <p className="prose-chat">Production is fixed. <code>/api/health</code> has answered 200 since 14:32, and p95 is back to 38 ms.</p>
          <pre className="p-code p-t-code overflow-x-auto rounded-[var(--r-control)] p-3">{"export default {\n  fetch: () => new Response(\"ok\"),\n};"}</pre>
        </div>
      )}
    </Section>
  );
}

function Measures() {
  return (
    <Section id="shape" title="Spacing, radii, elevation and motion">
      {() => (
        <div className="space-y-5">
          <div className="space-y-1">
            {SPACING.map((space) => (
              <Measured key={space} read={(style) => style.width}><span className="block h-2 rounded-[var(--r-pill)]" style={{ width: space, background: "var(--c-accent)" }} /></Measured>
            ))}
          </div>
          <div className="flex flex-wrap gap-3">
            {RADII.map((radius) => (
              <Measured key={radius} read={(style) => `${radius.slice(4)} ${style.borderTopLeftRadius}`}>
                <span className="block size-16 border p-border p-surface" style={{ borderRadius: `var(${radius})` }} />
              </Measured>
            ))}
          </div>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            {ELEVATION.map(([name, shadow]) => <div key={name} className="rounded-[var(--r-card)] border p-border p-surface p-4 t-meta" style={{ boxShadow: shadow }}>{name}</div>)}
          </div>
          <div className="grid gap-3">
            <Group><Row tile={<RowTile icon={SquaresFourIcon} />} title="Hover me" meta="A row's wash comes in over --dur-state" action={null} attributes={{}} /></Group>
            <div className="flex items-center gap-2 t-meta"><Menu label="Open the menu" items={[{ label: "Rename", icon: PencilSimpleIcon, run: () => undefined }, { label: "Delete", icon: TrashIcon, run: () => undefined, danger: true, apart: true }]} />--dur-enter</div>
            <Fold />
          </div>
        </div>
      )}
    </Section>
  );
}

function Fold() {
  const [open, setOpen] = useState(true);

  return (
    <div className="space-y-2">
      <Button size="sm" variant="ghost" onClick={() => setOpen((shown) => !shown)}>{open ? "Fold" : "Unfold"} · --dur-fold</Button>
      <div className="p-fold" data-folded={open ? undefined : ""}><div><p className="t-body">A block that folds away and comes back.</p></div></div>
    </div>
  );
}

function Buttons() {
  return (
    <Section id="buttons" title="Buttons" note="Five looks at md 32 and sm 28, in every state; the state is drawn at rest. Icon-only at the end of each row.">
      {() => (
        <div className="space-y-3 overflow-x-auto">
          {VARIANTS.map((variant) => (["md", "sm"] as const).map((size) => (
            <div key={`${variant}-${size}`} className="flex items-center gap-2">
              <span className="w-28 shrink-0 t-meta">{variant} {size}</span>
              {STATES.map((state) => (
                <Button key={state} variant={variant} size={size} disabled={state === "disabled"} busy={state === "busy"}
                  {...(["hover", "active", "focus"].includes(state) ? { "data-force": state } : {})}>{state}</Button>
              ))}
              <Button variant={variant} size={size} icon={<PlusIcon size={14} />} aria-label="Add" />
            </div>
          )))}
        </div>
      )}
    </Section>
  );
}

function Inputs() {
  return (
    <Section id="inputs" title="Inputs" note="Fields at md and sm in every state; a field stacked and inline; checkbox, radio and switch; Segmented and Tabs.">
      {() => <InputsIn />}
    </Section>
  );
}

function InputsIn() {
  const [tick, setTick] = useState(true);
  const [pick, setPick] = useState<"one" | "two">("one");
  const [on, setOn] = useState(true);
  const [seg, setSeg] = useState("all");
  const [sort, setSort] = useState<"new" | "old">("new");

  return (
    <div className="space-y-4">
      {(["md", "sm"] as const).map((size) => (
        <div key={size} className="grid grid-cols-2 gap-2 sm:grid-cols-5">
          <TextInput size={size} placeholder={`${size} rest`} />
          <TextInput size={size} placeholder="hover" data-force="hover" />
          <TextInput size={size} placeholder="focus" data-force="focus" />
          <TextInput size={size} defaultValue="invalid" invalid />
          <TextInput size={size} placeholder="disabled" disabled />
        </div>
      ))}
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Display name" hint="Shown in the sidebar."><TextInput defaultValue="API Worker" /></Field>
        <Field label="Address" error="That address is taken."><TextInput defaultValue="api-worker" invalid /></Field>
        <Field label="SOUL.md"><TextArea mono defaultValue={"# API Worker\n\nI look after the api Worker."} /></Field>
        <div className="space-y-3">
          <Field label="Sort"><Select label="Sort" value={sort} onChange={setSort} options={[{ value: "new", label: "Newest" }, { value: "old", label: "Oldest" }]} /></Field>
          <Field label="Sound" inline><Switch on={on} onChange={setOn} label="Sound" /></Field>
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-6">
        <Checkbox checked={tick} onChange={setTick} label="Checked" />
        <Checkbox checked={false} onChange={() => undefined} label="Off" />
        <Checkbox checked={false} mixed onChange={() => undefined} label="Mixed" />
        <Checkbox checked onChange={() => undefined} label="Disabled" disabled />
        <RadioGroup label="Pick" value={pick} onChange={setPick} options={[{ value: "one", label: "One" }, { value: "two", label: "Two" }]} />
        <span className="flex items-center gap-2 t-body"><Switch on={false} onChange={() => undefined} label="Off" />Off</span>
        <span className="flex items-center gap-2 t-body"><Switch on onChange={() => undefined} label="Disabled" disabled />Disabled</span>
      </div>
      <div className="flex flex-wrap items-center gap-3">
        <Segmented label="Two" value={seg === "all" ? "all" : "new"} onChange={setSeg} segments={[{ id: "all", label: "All" }, { id: "new", label: "New" }]} />
        <Segmented label="Three" value={seg} onChange={setSeg} segments={[{ id: "all", label: "All" }, { id: "needs", label: "Needs you" }, { id: "idle", label: "Idle" }]} />
        <Segmented label="Four" value={seg} onChange={setSeg} segments={[{ id: "all", label: "All" }, { id: "needs", label: "Needs you" }, { id: "working", label: "Working" }, { id: "idle", label: "Idle" }]} />
        <Segmented label="View" value="grid" onChange={() => undefined} segments={[{ id: "list", label: "List", icon: <ListIcon size={16} /> }, { id: "grid", label: "Grid", icon: <GridFourIcon size={16} /> }]} />
      </div>
      <Tabs label="Settings" current="account" onChoose={() => undefined} items={[{ id: "account", label: "Account", icon: UserCircleIcon }, { id: "devices", label: "Devices", icon: DesktopTowerIcon }, { id: "plugins", label: "Plugins", icon: PuzzlePieceIcon }]} />
    </div>
  );
}

function StatusSet() {
  return (
    <Section id="status" title="Status, chips, badges and marks">
      {() => (
        <div className="space-y-3">
          <div className="flex flex-wrap gap-4">{STATUS_TONES.map((tone) => <Status key={tone} tone={tone}>{tone}</Status>)}</div>
          <div className="flex flex-wrap gap-2">
            <Chip>api-worker</Chip>
            <Chip onRemove={() => undefined} removeLabel="Revoke api-worker's access">api-worker</Chip>
            <Chip tone="danger" onRemove={() => undefined} removeLabel="Remove the saved denial">landing-page · denied</Chip>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Badge>App</Badge><Badge tone="accent">Workspace</Badge>
            <span className="relative inline-flex h-10 w-32 items-center justify-center rounded-[var(--r-control)] p-sunken"><Badge tone="onPicture">On a picture</Badge></span>
          </div>
          <div className="flex flex-wrap items-center gap-3">
            {[20, 24, 32].map((size) => <Avatar key={size} name="Ada Lovelace" size={size} />)}
            {[20, 24, 32].map((size) => <WorkspaceLogo key={size} title="API Worker" logo={null} size={size} />)}
            {[20, 24, 32].map((size) => <ChatMascot key={size} seed={ADA.seed} colour={ADA.colour} activity={undefined} size={size} />)}
          </div>
        </div>
      )}
    </Section>
  );
}

function Rows() {
  return (
    <Section id="rows" title="Rows, groups and menus" note="A connected row, an addable one, a device and a selected one; four rows in a group; the phone row is in its own frame.">
      {() => (
        <div className="space-y-3">
          <Row tile={<BrandMark brand="github" size={18} />} title="GitHub" meta="Issues, pull requests and code" status={<Status tone="success">Connected</Status>}
            action={<Menu label="More for GitHub" items={[{ label: "Docs", icon: ArrowSquareOutIcon, run: () => undefined }, { label: "Remove", icon: TrashIcon, run: () => undefined, danger: true, apart: true }]} />} attributes={{}} />
          <Row tile={<BrandMark brand="google" size={18} />} title="Gmail" meta="Read and search your mail"
            action={<button type="button" aria-label="Add Gmail" className={ROW_ACTION}><PlusIcon size={16} /></button>} attributes={{}} />
          <Row tile={<RowTile icon={DesktopTowerIcon} />} title="Workstation" meta="workstation · linux · nvidia0" status={<Status tone="success">Connected</Status>}
            control={<><span className="t-item p-text-2">Sandbox</span><Switch on onChange={() => undefined} label="Sandbox on Workstation" /></>}
            action={<Menu label="Workstation options" items={[{ label: "Rename", icon: PencilSimpleIcon, run: () => undefined }]} />}
            below={<div className="flex flex-wrap gap-2"><Chip onRemove={() => undefined} removeLabel="Revoke">api-worker</Chip><Chip tone="danger" onRemove={() => undefined} removeLabel="Remove">landing-page · denied</Chip></div>} attributes={{}} />
          <Row selected tile={<RowTile icon={PlugsConnectedIcon} />} title="Linear" meta="Selected" status={<Status tone="warning">Needs sign-in</Status>} action={null} attributes={{}} />
          <Group>
            {["Skills", "data", "notes", "projects"].map((name) => <Row key={name} tile={<RowTile icon={TrayIcon} />} title={name} meta="Folder" action={null} attributes={{}} />)}
          </Group>
          <Pressable className="flex items-center gap-3 px-3 py-2"><RowTile icon={SquaresFourIcon} /><span className="t-item">A whole row to press</span><span className="ml-auto t-meta">Pressable</span></Pressable>
        </div>
      )}
    </Section>
  );
}

function Tiles() {
  const capture = galleryPicture(GALLERY_PICTURE.prBoard) ?? "";

  return (
    <Section id="tiles" title="Cards and tiles" note="A card with its label and an action; a flow step at 520; tiles with a capture, a typeset cover with a logo, with a mascot and with a badge, at rest and hovered.">
      {() => (
        <div className="space-y-4">
          <Card title="Identity" actions={<Button size="sm">Draw a new one</Button>}>
            <Field label="Display name"><TextInput defaultValue="API Worker" /></Field>
          </Card>
          <div className="mx-auto max-w-[var(--layout-flow)] py-4">
            <FlowStep title="Your own Kinu" steps={["Sign in", "Name it", "Deploy"]} at={1}
              footer={<><Button variant="ghost" size="sm">Back</Button><Button variant="primary">Continue</Button></>}>
              <div className="space-y-4 p-5"><Field label="Name" hint="Its address is this name on workers.dev."><TextInput defaultValue="ada-kinu" /></Field></div>
            </FlowStep>
          </div>
          <div className={TILE_GRID}>
            {(["rest", "hover"] as const).map((state) => (
              <div key={state} className="contents">
                <div className={TILE} data-force={state === "hover" ? "hover" : undefined}><TileShell title={`Capture · ${state}`} cover={<CaptureMat><img src={capture} alt="" className="absolute inset-0 size-full object-cover object-top" /></CaptureMat>}><span className="t-meta">PR review board</span></TileShell></div>
                <div className={TILE} data-force={state === "hover" ? "hover" : undefined}><TileShell title={`Logo · ${state}`} cover={<TypesetCover title="API Worker" line="Keep the api Worker deployed and healthy." />}><Status tone="success">Idle</Status></TileShell></div>
                <div className={TILE} data-force={state === "hover" ? "hover" : undefined}><TileShell title={`Mascot · ${state}`} cover={<TypesetCover title="Kinu" line={null} mark={<ChatMascot seed={ADA.seed} colour={ADA.colour} activity={undefined} size={32} />} />}><Status tone="neutral">Idle</Status></TileShell></div>
                <div className={TILE} data-force={state === "hover" ? "hover" : undefined}><TileShell title={`Badge · ${state}`} cover={<><TypesetCover title="Issue triage" line="Labels every new issue." mark={false} /><Badge tone="onPicture" className="absolute left-2.5 top-2.5">Workspace</Badge></>}><span className="t-meta">Lina Park</span></TileShell></div>
              </div>
            ))}
          </div>
        </div>
      )}
    </Section>
  );
}

/**
 * The page's framed apps load one after another, each once the one before it has: thirty-odd whole apps at once run a
 * browser out of resources. `turn` is the next frame allowed to load.
 */
const FrameQueue = createContext<{ turn: number; loaded: (order: number) => void }>({ turn: Number.POSITIVE_INFINITY, loaded: () => undefined });

function QueuedFrame({ order, title, src, className, style }: { order: number; title: string; src: string; className: string; style?: CSSProperties }) {
  const { turn, loaded } = useContext(FrameQueue);

  if (order > turn) return <div aria-hidden className={`${className} p-sunken`} style={style} data-frame-waiting />;

  return <iframe title={title} src={src} className={className} style={style} onLoad={() => loaded(order)} />;
}

/** The width a page kind is drawn at before it is scaled into its quadrant: a laptop's, so it lays out as a desk does. */
const DESK = 1280;

/** A real page of the whole app in a look, at a desk's width scaled to fit, cropped to `height` of its own pixels. */
function PageCrop({ order, at, look, mode, height, label }: { order: number; at: string; look: ThemeName; mode: "light" | "dark"; height: number; label: string }) {
  const src = `gallery.html?frame=whole&look=${look}&mode=${mode}&bar=off&at=${encodeURIComponent(at)}`;
  const box = useRef<HTMLDivElement | null>(null);
  const [scale, setScale] = useState(0.5);

  useLayoutEffect(() => {
    const element = box.current;

    if (element === null) return;

    const watch = new ResizeObserver(() => setScale(element.clientWidth / DESK));

    watch.observe(element);

    return () => watch.disconnect();
  }, []);

  return (
    <figure className="space-y-1">
      <figcaption className="t-meta">{label}</figcaption>
      <div ref={box} className="overflow-hidden rounded-[var(--r-control)] border p-border" style={{ height: height * scale }}>
        <QueuedFrame order={order} title={`${label}, ${LOOK_NAME[look]} ${mode}`} src={src} className="origin-top-left"
          style={{ width: DESK, height, transform: `scale(${String(scale)})` }} />
      </div>
    </figure>
  );
}

const PAGE_KINDS = [
  { at: "/workspaces", height: 240, label: "Frame page header" },
  { at: "/gallery/ravi/pr-board", height: 240, label: "With a back link and actions" },
  { at: "/mail", height: 220, label: "Tool bar: Mail" },
  { at: "/drive", height: 220, label: "Tool bar: Drive" },
  { at: "/", height: 200, label: "Chat bar, Focus: no rule, a fade" },
  { at: "/workspace/api-worker-v2", height: 200, label: "Chat bar, Workbench: tabs on a rule" },
] as const;

function PageKinds() {
  return (
    <section id="pages" className="space-y-3" data-system-section="pages">
      <h2 className="t-page-title">Page kinds</h2>
      <p className="max-w-3xl t-body">Each kind as the whole app draws it, cropped to its top, in every look; then the flow card.</p>
      <div className="grid gap-4 xl:grid-cols-2">
        {LOOKS.map(({ look, mode }, quadrant) => (
          <div key={`${look}-${mode}`} className="space-y-2 rounded-[var(--r-card)] border p-border p-4" data-theme={look} data-mode={mode}>
            <p className="t-label">{LOOK_NAME[look]} {mode}</p>
            {PAGE_KINDS.map((kind, at) => <PageCrop key={kind.at} order={PHONE_FRAMES + quadrant * (PAGE_KINDS.length + 1) + at} look={look} mode={mode} {...kind} />)}
            <PageCrop order={PHONE_FRAMES + quadrant * (PAGE_KINDS.length + 1) + PAGE_KINDS.length} at="/welcome" look={look} mode={mode} height={640} label="Flow card" />
          </div>
        ))}
      </div>
    </section>
  );
}

function SaveBarCycle() {
  const [phase, setPhase] = useState<"dirty" | "saving" | "clean">("dirty");

  // A live demo, round and round: unsaved, saving, saved and gone.
  useLayoutEffect(() => {
    const next = { dirty: "saving", saving: "clean", clean: "dirty" } as const;
    const timer = setTimeout(() => setPhase(next[phase]), phase === "clean" ? 2600 : 1400);

    return () => clearTimeout(timer);
  }, [phase]);

  return <div className="relative h-20"><SaveBar dirty={phase === "dirty"} saving={phase === "saving"} onSave={() => undefined} onDiscard={() => undefined} /></div>;
}

function Overlays() {
  return (
    <Section id="overlays" title="Overlays and waiting" note="The save bar in each state (the last one cycles); dialogs at rest; a popover and a tooltip; empty, loading, meters, a table and a copy field.">
      {() => (
        <div className="space-y-4">
          <div className="relative h-16"><SaveBar dirty saving={false} onSave={() => undefined} onDiscard={() => undefined} /></div>
          <div className="relative h-16"><SaveBar dirty saving onSave={() => undefined} onDiscard={() => undefined} /></div>
          <div className="relative h-16"><SaveBar dirty saving={false} error="Could not save: the workspace is asleep." onSave={() => undefined} onDiscard={() => undefined} /></div>
          <SaveBarCycle />
          <div className="grid gap-3">
            <DialogBox title="Rename the workspace" width="sm" footer={<><Button size="sm" variant="ghost">Cancel</Button><Button variant="primary">Rename</Button></>}>
              <Field label="Name"><TextInput defaultValue="API Worker" /></Field>
            </DialogBox>
            <DialogBox title="Disconnect Groq?" width="sm" footer={<><Button size="sm" variant="ghost">Cancel</Button><Button variant="destructive">Disconnect</Button></>}>
              <p className="t-body">Its key and the model it serves go together.</p>
            </DialogBox>
          </div>
          <div className="flex flex-wrap items-center gap-3">
            <Popover trigger={<Button size="sm">Open a popover</Button>} title="Public link"><p className="t-body">Anyone with the link can open it.</p></Popover>
            <Tooltip content="Workspace settings"><Button size="sm" variant="ghost" icon={<GearSixIcon size={16} />} aria-label="Workspace settings" /></Tooltip>
            <span className="p-tooltip rounded-[var(--r-control)] px-2 py-1">A tooltip at rest</span>
          </div>
          <Empty icon={HardDrivesIcon} title="Nothing in your Drive yet" action={<Button size="sm" variant="secondary">Upload a file</Button>}>Files here are in every workspace you own.</Empty>
          <div className="flex items-center gap-4"><Loader size="sm" /><div className="flex-1"><Skeleton /></div></div>
          <div className="space-y-3">{[40, 85, 100].map((value) => <Meter key={value} label={`${String(value)}% used`} value={value} shown={`${String(value)}%`} />)}</div>
          <Table>
            <Table.Header><Table.Row><Table.Head>Model</Table.Head><Table.Head>Turns</Table.Head></Table.Row></Table.Header>
            <Table.Body>
              <Table.Row><Table.Cell>Muse Spark 1.3</Table.Cell><Table.Cell>412</Table.Cell></Table.Row>
              <Table.Row><Table.Cell>glm-5.3</Table.Cell><Table.Cell>88</Table.Cell></Table.Row>
            </Table.Body>
          </Table>
          <CopyField value="curl -fsSL https://kinu.run/install.sh | sh" what="the install command" />
        </div>
      )}
    </Section>
  );
}

const CONTENTS = [["grounds", "Grounds"], ["lines", "Lines"], ["text", "Text"], ["accent", "Accent and status"], ["type", "Type"], ["shape", "Shape and motion"],
  ["buttons", "Buttons"], ["inputs", "Inputs"], ["status", "Status set"], ["rows", "Rows"], ["tiles", "Cards and tiles"], ["pages", "Page kinds"], ["overlays", "Overlays"]] as const;

/** The phone row alone, for its own 390 frame. */
function PhoneRow() {
  return (
    <div className="p-bg p-4">
      <Row tile={<RowTile icon={DesktopTowerIcon} />} title="Workstation" meta="workstation · linux · nvidia0" status={<Status tone="success">Connected</Status>}
        control={<><span className="t-item p-text-2">Sandbox</span><Switch on onChange={() => undefined} label="Sandbox on Workstation" /></>}
        action={<Menu label="Workstation options" items={[{ label: "Rename", icon: PencilSimpleIcon, run: () => undefined }]} />} attributes={{}} />
    </div>
  );
}

/** The phone rows load first, then the page kinds, look by look. */
const PHONE_FRAMES = LOOKS.length;

function SystemPage() {
  const [turn, setTurn] = useState(0);
  const loaded = useCallback((order: number) => setTurn((next) => Math.max(next, order + 1)), []);
  const queue = useMemo(() => ({ turn, loaded }), [turn, loaded]);

  return (
    <FrameQueue.Provider value={queue}>
    <div className="h-full overflow-y-auto p-bg p-text" data-system-frame>
      <div className="mx-auto w-full max-w-[1600px] space-y-12 px-8 py-12">
        <header className="space-y-3">
          <h1 className="t-hero">The Kinu design system</h1>
          <p className="max-w-3xl t-body">Every token and component in the four looks. Numbers are read from the page as it renders. docs/DESIGN-SYSTEM.md states the rules.</p>
          <nav className="flex flex-wrap gap-2">{CONTENTS.map(([id, name]) => <a key={id} href={`#${id}`} className="t-meta underline-offset-2 hover:underline">{name}</a>)}</nav>
        </header>
        <Grounds /><Lines /><Text /><AccentAndStatus /><Type /><Measures /><Buttons /><Inputs /><StatusSet /><Rows />
        <section className="space-y-3">
          <h2 className="t-title">The row on a phone</h2>
          <div className="flex flex-wrap gap-4">
            {LOOKS.map(({ look, mode }, order) => (
              <QueuedFrame key={`${look}-${mode}`} order={order} title={`Phone row, ${LOOK_NAME[look]} ${mode}`} src={`gallery.html?frame=system&part=phone-row&look=${look}&mode=${mode}`}
                className="h-36 w-[390px] rounded-[var(--r-control)] border p-border" />
            ))}
          </div>
        </section>
        <Tiles /><PageKinds /><Overlays />
      </div>
    </div>
    </FrameQueue.Provider>
  );
}

/** `?frame=system`, or `&part=phone-row` for the row alone at a phone's width (the page frames it four times). */
export function SystemFrame() {
  const part = new URLSearchParams(location.search).get("part");
  const style: CSSProperties = { height: "100vh" };

  return <div style={style}>{part === "phone-row" ? <PhoneRow /> : <SystemPage />}</div>;
}

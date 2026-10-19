/**
 * Today, above the assistant's chat on Home: what waits on you across your workspaces, the mail the assistant marked
 * Important, the workspaces it runs for you and how far each has come, and what it watches. Every row is a read Kinu
 * already keeps: the roster's tiles, Mail's Important, the assistant's own triggers. A tile opens its list beneath.
 */
import { useState, type ReactNode } from "react";
import { Effect } from "effect";
import { detach } from "@kinu.run/core/obs";
import { Link, useNavigate } from "react-router-dom";
import { CaretDownIcon, EnvelopeSimpleIcon, EyeIcon, HandPalmIcon, SquaresFourIcon } from "@phosphor-icons/react";
import { rosterHeadline, workspaceDisplayTitle, type RosterEntry } from "@kinu.run/core";
import { WorkspaceOverviewCard } from "@/components/workspaces/WorkspaceOverviewCard";
import { ImportantMailRow } from "@/components/mail/ImportantMailRow";
import type { ImportantMail } from "@/lib/mail-api";
import { StatusDot } from "@/components/ui/Status";
import { workspaceStatusTone } from "@/components/workspaces/workspace-status-tone";
import { WorkspaceLogo } from "@/components/Marks";
import { MAIL_ROUTE } from "@/components/SidebarFooter";

/** One thing the assistant watches: a trigger of its own, and the last thing it found. */
export interface Watch {
  readonly id: string;
  readonly label: string;
  /** What it watches, in a few words: a repository, a mailbox, a calendar. */
  readonly what: string;
  /** Its last finding, from the turn its last firing began. */
  readonly found: string | null;
  readonly last: number | null;
  readonly next: number | null;
  readonly icon: ReactNode;
}

/** What the assistant itself waits on you for: the Needs-you cards in its own composer. */
export interface OwnAsk {
  readonly title: string;
  readonly detail: string | null;
  /** The few words its tile shows: what it is about. */
  readonly glance: string;
}

export type TodayTile = "needs" | "mail" | "workspaces" | "watching";

export interface TodayProps {
  readonly now: number;
  readonly greeting: string;
  readonly own: readonly OwnAsk[];
  readonly roster: readonly RosterEntry[];
  /** The workspaces the assistant made and coordinates, in the order it last touched them. */
  readonly goals: readonly string[];
  readonly mail: { readonly unread: number; readonly items: readonly ImportantMail[] };
  readonly watching: readonly Watch[];
  readonly opened?: TodayTile | null;
}

const clock = (at: number) => new Date(at).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });

/** `8:00`, `tomorrow 8:00`, or a date. */
export function whenNext(at: number, now: number): string {
  const day = new Date(at).toDateString();

  if (day === new Date(now).toDateString()) return clock(at);

  if (day === new Date(now + 864e5).toDateString()) return `tomorrow ${clock(at)}`;

  return new Date(at).toLocaleDateString("en-GB", { weekday: "short", hour: "2-digit", minute: "2-digit" });
}

function Progress({ done, total }: { done: number; total: number }) {
  const share = total === 0 ? 0 : Math.round((done / total) * 100);

  return (
    <span className="flex items-center gap-2" aria-label={`${String(done)} of ${String(total)} done`}>
      <span className="h-1 w-16 overflow-hidden rounded-full bg-[var(--c-neutral-tint)]">
        <span className="block h-full rounded-full bg-[var(--c-accent)]" style={{ width: `${String(share)}%` }} />
      </span>
      <span className="p-meta tabular-nums p-text-3">{done}/{total}</span>
    </span>
  );
}

function Tile({ id, label, count, icon, opened, onOpen, children }: {
  id: TodayTile; label: string; count: number | null; icon: ReactNode; opened: boolean; onOpen: (tile: TodayTile) => void; children: ReactNode;
}) {
  return (
    <button type="button" onClick={() => onOpen(id)} aria-expanded={opened} data-today-tile={id}
      className={`group flex min-w-[196px] flex-1 snap-start flex-col gap-2 rounded-[14px] border px-3 pb-2.5 pt-2.5 text-left transition-colors md:min-w-0 ${opened
        ? "border-[var(--c-accent)] bg-[var(--c-surface)]"
        : "p-border bg-[var(--c-surface)] hover:border-[var(--c-border-strong)]"}`}>
      <span className="flex items-center gap-1.5">
        <span className={opened ? "p-accent" : "p-text-3"}>{icon}</span>
        <span className="p-eyebrow">{label}</span>
        {count !== null && count > 0 && <span className="ml-auto rounded-full bg-[var(--c-neutral-tint)] px-1.5 text-[11px] font-semibold tabular-nums leading-[18px] p-text-2">{count}</span>}
      </span>
      <span className="flex min-w-0 flex-col gap-1">{children}</span>
    </button>
  );
}

function Line({ children, quiet = false }: { children: ReactNode; quiet?: boolean }) {
  return <span className={`block truncate text-[12.5px] leading-[18px] ${quiet ? "p-text-3" : "p-text"}`}>{children}</span>;
}

export function Today({ now, greeting, own, roster, goals, mail, watching, opened: initiallyOpened = null }: TodayProps) {
  const [opened, setOpened] = useState<TodayTile | null>(initiallyOpened);
  const [shut, setShut] = useState(false);
  const navigate = useNavigate();
  const waiting = roster.filter((entry) => (entry.overview?.decisionsWaiting ?? entry.decisions) > 0);
  const needsCount = own.length + waiting.reduce((sum, entry) => sum + (entry.overview?.decisionsWaiting ?? entry.decisions), 0);
  const coordinated = goals.flatMap((name) => roster.filter((entry) => entry.name === name));
  const toggle = (tile: TodayTile) => setOpened((shown) => (shown === tile ? null : tile));
  const date = new Date(now).toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "long" });

  return (
    <section aria-label="Today" data-today className="relative z-[1] shrink-0 border-b p-border bg-[var(--c-bg)] shadow-[0_12px_18px_-16px_rgba(0,0,0,0.55)]">
      <div className="mx-auto w-full max-w-[820px] px-3 pt-3 sm:px-5">
        <div className="flex items-baseline gap-2">
          <h2 className="text-[15px] font-semibold tracking-[-0.01em] p-text">{greeting}</h2>
          <span className="p-meta p-text-3">{date}</span>
          <button type="button" onClick={() => setShut((closed) => !closed)} aria-expanded={!shut} data-today-shut
            className="ml-auto flex items-center gap-1 rounded-md px-1.5 py-0.5 p-meta p-text-3 transition-colors hover:p-text">
            {shut ? "Show today" : "Hide"}<CaretDownIcon size={11} className={shut ? "" : "rotate-180"} />
          </button>
        </div>
        {!shut && (
          <>
            <div className="-mx-3 mt-2.5 flex snap-x gap-2 overflow-x-auto px-3 pb-3 sm:-mx-5 sm:px-5 md:grid md:grid-cols-4 md:overflow-visible" style={{ scrollbarWidth: "none" }}>
              <Tile id="needs" label="Needs you" count={needsCount} icon={<HandPalmIcon size={14} weight="bold" />} opened={opened === "needs"} onOpen={toggle}>
                {own[0] !== undefined && <Line>{own[0].glance}<span className="p-text-3"> · here</span></Line>}
                {waiting.slice(0, own.length > 0 ? 1 : 2).map((entry) => (
                  <Line key={entry.name}>{workspaceDisplayTitle(entry)}<span className="p-text-3"> · {entry.overview?.decisionsWaiting ?? entry.decisions} waiting</span></Line>
                ))}
                {needsCount === 0 && <Line quiet>Nothing waits on you</Line>}
              </Tile>
              <Tile id="mail" label="Important" count={mail.unread} icon={<EnvelopeSimpleIcon size={14} weight="bold" />} opened={opened === "mail"} onOpen={toggle}>
                {mail.items.slice(0, 2).map((item) => (
                  <Line key={item.thread}><span className={item.unread ? "font-semibold" : ""}>{item.from.name}</span><span className="p-text-3"> · {item.subject}</span></Line>
                ))}
                {mail.items.length === 0 && <Line quiet>I'll mark what matters as it comes</Line>}
              </Tile>
              <Tile id="workspaces" label="Workspaces" count={coordinated.length} icon={<SquaresFourIcon size={14} weight="bold" />} opened={opened === "workspaces"} onOpen={toggle}>
                {coordinated.slice(0, 2).map((entry) => {
                  const plan = entry.overview?.plan ?? null;
                  const headline = rosterHeadline(entry.overview, entry.decisions);

                  return (
                    <span key={entry.name} className="flex min-w-0 items-center gap-2">
                      <StatusDot tone={workspaceStatusTone(headline.status)} />
                      <span className="min-w-0 flex-1 truncate text-[12.5px] leading-[18px] p-text">{workspaceDisplayTitle(entry)}</span>
                      {plan !== null && <span className="shrink-0 p-meta tabular-nums p-text-3">{plan.done}/{plan.total}</span>}
                    </span>
                  );
                })}
                {coordinated.length === 0 && <Line quiet>Ask me to start one</Line>}
              </Tile>
              <Tile id="watching" label="Watching" count={watching.length} icon={<EyeIcon size={14} weight="bold" />} opened={opened === "watching"} onOpen={toggle}>
                {watching.slice(0, 2).map((watch) => (
                  <Line key={watch.id}>{watch.label}<span className="p-text-3"> · {watch.found ?? (watch.next === null ? "paused" : `next ${whenNext(watch.next, now)}`)}</span></Line>
                ))}
              </Tile>
            </div>
            {opened === "mail" && (
              <div className="mb-3" data-today-list="mail">
                <div className="p-group">
                  {mail.items.map((item) => (
                    <ImportantMailRow key={item.thread} mail={item}
                      onOpen={() => { detach(Effect.promise(async () => navigate(`${MAIL_ROUTE}?thread=${encodeURIComponent(item.thread)}`))); }} />
                  ))}
                </div>
                <Link to={MAIL_ROUTE} className="block px-2 pt-2 p-meta p-accent hover:underline">All Important mail →</Link>
              </div>
            )}
            {opened !== null && opened !== "mail" && (
              <div className="mb-3 overflow-hidden rounded-[14px] border p-border p-surface" data-today-list={opened}>
                {opened === "needs" && (
                  <>
                    {own.map((ask) => (
                      <div key={ask.title} className="flex items-center gap-3 border-b p-border px-4 py-2.5 last:border-b-0">
                        <span className="min-w-0 flex-1">
                          <span className="block truncate p-row-text font-medium p-text">{ask.title}</span>
                          {ask.detail !== null && <span className="block truncate p-meta p-text-3">{ask.detail}</span>}
                        </span>
                        <span className="shrink-0 p-meta p-accent">Below, in this chat</span>
                      </div>
                    ))}
                    {waiting.map((entry, at) => <WorkspaceOverviewCard key={entry.name} workspace={entry} variant="line" first={own.length === 0 && at === 0} />)}
                  </>
                )}
                {opened === "workspaces" && coordinated.map((entry, at) => <GoalRow key={entry.name} entry={entry} first={at === 0} />)}
                {opened === "watching" && watching.map((watch, at) => <WatchRow key={watch.id} watch={watch} now={now} first={at === 0} />)}
              </div>
            )}
          </>
        )}
      </div>
    </section>
  );
}

/** A workspace the assistant runs for you: its status, what it is doing, and how far its plan has come. */
function GoalRow({ entry, first }: { entry: RosterEntry; first: boolean }) {
  const title = workspaceDisplayTitle(entry);
  const headline = rosterHeadline(entry.overview, entry.decisions);
  const plan = entry.overview?.plan ?? null;
  const task = entry.overview?.latestRun?.task ?? null;

  return (
    <Link to={`/workspace/${entry.name}`} data-today-goal={entry.name}
      className={`flex items-center gap-3 px-4 py-2.5 transition-colors p-card-hover ${first ? "" : "border-t p-border"}`}>
      <WorkspaceLogo title={title} logo={entry.logo} size={22} />
      <span className="min-w-0 flex-1">
        <span className="flex items-center gap-2">
          <span className="truncate p-row-text font-medium p-text">{title}</span>
          <StatusDot tone={workspaceStatusTone(headline.status)} />
          <span className="shrink-0 p-meta p-text-3">{headline.label}</span>
        </span>
        <span className="block truncate p-meta p-text-3">{plan?.title ?? task ?? "No plan yet"}</span>
      </span>
      {plan !== null && <Progress done={plan.done} total={plan.total} />}
    </Link>
  );
}

/** One watch: what it looks at, its last finding, and when it looks next. */
function WatchRow({ watch, now, first }: { watch: Watch; now: number; first: boolean }) {
  const times = [watch.last !== null && `checked ${clock(watch.last)}`, watch.next !== null && `next ${whenNext(watch.next, now)}`].filter((part) => part !== false);

  return (
    <div className={`flex items-start gap-3 px-4 py-2.5 ${first ? "" : "border-t p-border"}`} data-today-watch={watch.id}>
      <span className="mt-0.5 flex size-[22px] shrink-0 items-center justify-center rounded-md bg-[var(--c-neutral-tint)] p-text-2">{watch.icon}</span>
      <span className="min-w-0 flex-1">
        <span className="flex flex-wrap items-baseline gap-x-2">
          <span className="p-row-text font-medium p-text">{watch.label}</span>
          <span className="p-meta p-text-3">{watch.what}</span>
        </span>
        {watch.found !== null && <span className="block p-meta p-text-2">{watch.found}</span>}
        {times.length > 0 && <span className="block p-meta tabular-nums p-text-3 sm:hidden">{times.join(" · ")}</span>}
      </span>
      <span className="hidden shrink-0 text-right p-meta tabular-nums p-text-3 sm:block">
        {times.map((part) => <span key={part} className="block">{part}</span>)}
      </span>
    </div>
  );
}

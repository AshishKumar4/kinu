/**
 * A workspace's activity (1018-xao, Muse's activity log): what its agent is doing now, what it will look at next, and
 * what it did, turn by turn, each with what set it off and what it changed. Read from the chat's own pages and the
 * agent's own triggers (core `activity.ts`, `focus-line.ts`); it stores nothing of its own.
 */
import { useCallback, useMemo, useState } from "react";
import { Effect } from "effect";
import { ClockCounterClockwiseIcon } from "@phosphor-icons/react";
import { activityOf, clockTime, type ActivityCause, type ActivityEntry, type ChatHistoryEntry, type PositionCursor, type Watch } from "@kinu.run/core";
import { detach, showing } from "@kinu.run/core/obs";
import { lastValue, useAsyncResource } from "@/hooks/use-async-resource";
import type { WorkspaceRpc } from "@/lib/workspace-rpc";
import { Page } from "@/components/ui/PageHeader";
import { Group } from "@/components/ui/Group";
import { LoadFailure } from "@/components/ui/LoadFailure";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";

/** A page of the chat as the chat itself reads it; the newest first, then each older one on asking. */
const PAGE = 200;

const DAY = new Intl.DateTimeFormat("en-US", { weekday: "long", month: "long", day: "numeric" });

const NEAR_DAYS = new Map([[-1, "Tomorrow"], [0, "Today"], [1, "Yesterday"]]);

/** "Today", "Yesterday" or "Tomorrow", else the day's own name and date. */
function dayOf(at: number, now: number): string {
  return NEAR_DAYS.get(Math.round((midnight(now) - midnight(at)) / 864e5)) ?? DAY.format(at);
}

/** When a watch next looks: its time today, else its day and time. */
function nextLook(at: number, now: number): string {
  const day = dayOf(at, now);

  return day === "Today" ? clockTime(at) : `${day}, ${clockTime(at)}`;
}

function midnight(at: number): number {
  const day = new Date(at);

  return new Date(day.getFullYear(), day.getMonth(), day.getDate()).getTime();
}

/** The entries, newest first, under the day each began. */
function byDay(entries: readonly ActivityEntry[], now: number): [string, ActivityEntry[]][] {
  const days = new Map<string, ActivityEntry[]>();

  for (const entry of entries) {
    const day = dayOf(entry.at, now);

    days.set(day, [...(days.get(day) ?? []), entry]);
  }

  return [...days];
}

/** What set a turn off, in a word, and the rest of what it said. */
interface CauseWords { readonly tag: string; readonly said: string }

function causeWords(cause: ActivityCause): CauseWords {
  if (cause.kind === "you") return { tag: "You", said: cause.text };

  if (cause.kind === "self") return { tag: "On its own", said: "" };

  // A source names its own in parentheses ("email (priya@cloudflare.com)", "schedule (Morning brief)"); said once.
  const from = /\(([^)]+)\)/u.exec(cause.source)?.[1] ?? cause.source;
  const said = from === cause.brief ? from : `${from}: ${cause.brief}`;

  return { tag: cause.label, said: `${said}${cause.more > 0 ? ` (and ${String(cause.more)} more)` : ""}` };
}

function Entry({ entry }: { entry: ActivityEntry }) {
  const { tag, said } = causeWords(entry.cause);

  return (
    <li className="grid grid-cols-[var(--layout-label-row)] gap-x-3 px-4 py-3 max-sm:grid-cols-1" data-activity-entry={entry.id} data-cause={entry.cause.kind}>
      <time className="t-meta tabular-nums p-text-3 max-sm:hidden" dateTime={new Date(entry.at).toISOString()}>{clockTime(entry.at)}</time>
      <div className="flex min-w-0 flex-col gap-1">
        <span className="t-body min-w-0 line-clamp-2 p-text" data-activity-did>{entry.did}</span>
        <span className="t-meta flex min-w-0 items-center gap-2 p-text-3">
          <Badge tone={entry.cause.kind === "event" ? "info" : "neutral"}>{tag}</Badge>
          <span className="min-w-0 truncate" title={said}>{said}</span>
          <time className="ml-auto shrink-0 tabular-nums sm:hidden" dateTime={new Date(entry.at).toISOString()}>{clockTime(entry.at)}</time>
        </span>
        {entry.changed.length > 0 && (
          <ul className="t-meta flex flex-col gap-px p-text-2" data-activity-changed>
            {entry.changed.map((change) => <li key={change} className="min-w-0 truncate">{change}</li>)}
          </ul>
        )}
        {entry.failed !== null && <span className="t-meta p-danger" data-activity-failed>Stopped: {entry.failed}</span>}
      </div>
    </li>
  );
}

/** The next things the agent looks at, soonest first: each armed watch with a time of its own. */
function Upcoming({ watches, now }: { watches: readonly Watch[]; now: number }) {
  const due = watches.filter((watch) => watch.state === "active" && watch.next_fire_at !== null)
    .sort((a, b) => (a.next_fire_at ?? 0) - (b.next_fire_at ?? 0));

  if (due.length === 0) return null;

  return (
    <section aria-labelledby="activity-upcoming" className="flex flex-col gap-3">
      <h2 id="activity-upcoming" className="t-label">Upcoming</h2>
      <Group list label="Upcoming" data-activity-upcoming>
        {due.map((watch, index) => (
          <li key={`${String(index)}:${String(watch.next_fire_at)}`} className="flex items-baseline gap-3 px-4 py-3">
            <span className="t-body min-w-0 flex-1 truncate p-text">{typeof watch.spec.label === "string" ? watch.spec.label : "A scheduled look"}</span>
            <span className="t-meta shrink-0 tabular-nums p-text-3">{nextLook(watch.next_fire_at ?? now, now)}</span>
          </li>
        ))}
      </Group>
    </section>
  );
}

/** The chat's pages as the activity reads them: newest first, each older one on asking. */
function useChatPages(rpc: WorkspaceRpc) {
  const [older, setOlder] = useState<{ rows: ChatHistoryEntry[]; next: PositionCursor | null }>({ rows: [], next: null });
  const [reading, setReading] = useState(false);
  const [failed, setFailed] = useState<string | null>(null);

  const load = useCallback(async () => {
    const page = await rpc("getChatHistoryPage", [{ limit: PAGE }]);

    setOlder({ rows: [], next: page.status === "more" ? page.next : null });

    return page.items;
  }, [rpc]);

  const { resource, reload } = useAsyncResource(load);

  const more = useCallback((cursor: PositionCursor) => Effect.gen(function* () {
    setReading(true);
    setFailed(null);

    return yield* Effect.ensuring(Effect.catchCause(Effect.gen(function* () {
      const page = yield* Effect.promise(async () => rpc("getChatHistoryPage", [{ cursor, limit: PAGE }]));

      setOlder((before) => ({ rows: [...page.items, ...before.rows], next: page.status === "more" ? page.next : null }));
    }), showing(setFailed)), Effect.sync(() => setReading(false)));
  }), [rpc]);

  return { newest: lastValue(resource), resource, reload, older, reading, failed, more };
}

export function ActivityView({ workspace, title, rpc, now }: { workspace: string; title: string; rpc: WorkspaceRpc; now: string | null }) {
  const pages = useChatPages(rpc);
  const triggers = useAsyncResource(useCallback(async () => (await rpc("listTriggers", [])).triggers, [rpc]));
  const at = Date.now();

  const entries = useMemo(
    () => (pages.newest === null ? [] : activityOf([...pages.older.rows, ...pages.newest])),
    [pages.newest, pages.older.rows],
  );

  const next = pages.older.next;

  return (
    <Page fill back={{ to: `/workspace/${encodeURIComponent(workspace)}`, label: `Back to ${title}` }} icon={<ClockCounterClockwiseIcon size={18} />} title="Activity" data-activity>
      {now !== null && (
        <section aria-labelledby="activity-now" className="flex flex-col gap-3">
          <h2 id="activity-now" className="t-label">Now</h2>
          <p className="t-body p-text" data-activity-now>{now}</p>
        </section>
      )}

      <Upcoming watches={lastValue(triggers.resource) ?? []} now={at} />

      {pages.resource.status === "error" && pages.newest === null && <LoadFailure what="this workspace's activity" message={pages.resource.message} onRetry={pages.reload} />}
      {pages.newest !== null && entries.length === 0 && <p className="t-body p-text-3" data-activity-empty>Nothing yet. What it does shows here, turn by turn.</p>}

      {byDay(entries, at).map(([day, shown]) => (
        <section key={day} aria-label={day} className="flex flex-col gap-3" data-activity-day={day}>
          <h2 className="t-label">{day}</h2>
          <Group list label={day}>{shown.map((entry) => <Entry key={entry.id} entry={entry} />)}</Group>
        </section>
      ))}

      {pages.failed !== null && next !== null && <LoadFailure what="earlier activity" message={pages.failed} onRetry={() => detach(pages.more(next))} />}
      {next !== null && (
        <div className="flex justify-center">
          <Button variant="secondary" disabled={pages.reading} onClick={() => detach(pages.more(next))} data-activity-earlier>Show earlier</Button>
        </div>
      )}
    </Page>
  );
}

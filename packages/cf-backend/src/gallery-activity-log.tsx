/**
 * The single activity log, proposed for the owner's review (1018-xao, Muse's "full activity log of what it did and plans
 * to do"): one page per workspace where everything its agents do is told, in place of three. Today a workspace's work is
 * read in Activity (its chat's turns, by day, and its watches), in the inspector's Work (helpers, jobs, the journal) and
 * on the chat's background pill. Here they are one list, newest first: what is happening now, what waits on the owner,
 * what is coming, and what was done, each by whom and why, with what it changed.
 *
 * Drawn from the real components over a fixture. It stands in for the shipped ActivityView in the gallery's build
 * (gallery.vite.config.ts aliases it here), so the whole app's design bar switches it in where Activity is drawn, under
 * the workspace's own bar (`activity=log`), with its states (`&activitystate=`) and how its times are worded (`times=`,
 * audit #23). `?frame=activity-review` draws the same place alone.
 */
import { useState, type ComponentProps, type ReactNode } from "react";
import { useLocation } from "react-router-dom";
import {
  BellRingingIcon, CalendarBlankIcon, ChatCircleIcon, ClockCounterClockwiseIcon, GitPullRequestIcon,
  RobotIcon, TerminalWindowIcon, type Icon,
} from "@phosphor-icons/react";
import { clockTime, countOf, workspaceRoute } from "@kinu.run/core";
import { Page } from "@/components/ui/PageHeader";
import { Group } from "@/components/ui/Group";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Dot } from "@/components/ui/Dot";
import { Empty } from "@/components/ui/Empty";
import { LoadFailure } from "@/components/ui/LoadFailure";
import { Loader } from "@/components/ui/Loader";
import { Segmented } from "@/components/ui/Segmented";
import { Status } from "@/components/ui/Status";
import { ACTIVITY_STATES, useDesign } from "@/gallery-design-bar";
import { ActivityView as Shipped } from "./components/workspaces/ActivityView";

/** The surface whose wording a moment carries today, which "ships" keeps. */
type Surface = "chat" | "pill" | "jobs" | "watch" | "roster";

const MINUTE = 60_000;

const HOUR = 60 * MINUTE;

const DAY = 24 * HOUR;

const midnight = (at: number): number => new Date(at).setHours(0, 0, 0, 0);

const WEEKDAY = new Intl.DateTimeFormat("en-US", { weekday: "short" });

const DATE = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric" });

/**
 * The one rule (audit #23): near, it counts ("just now", "12 min ago", "in 20 min"); the same day, its clock; a day
 * either side, the day's name and clock ("Yesterday, 4:10 PM"); within the week, the weekday; else the date.
 */
function whenWords(at: number, now: number): string {
  const delta = at - now;
  const minutes = Math.round(Math.abs(delta) / MINUTE);

  if (minutes < 1) return delta < 0 ? "just now" : "in a moment";

  if (minutes < 60) return delta < 0 ? `${String(minutes)} min ago` : `in ${String(minutes)} min`;

  const days = Math.round((midnight(at) - midnight(now)) / DAY);

  if (days === 0) return clockTime(at);

  if (days === -1) return `Yesterday, ${clockTime(at)}`;

  if (days === 1) return `Tomorrow, ${clockTime(at)}`;

  return Math.abs(days) < 7 ? `${WEEKDAY.format(at)}, ${clockTime(at)}` : DATE.format(at);
}

/** Each surface's wording as it ships: the chat's clock, the pill's "3 min", the jobs' "in 3m", the roster's "3m ago". */
function shippedWords(at: number, now: number, surface: Surface): string {
  const seconds = Math.round((at - now) / 1000);
  const ago = Math.max(0, -seconds);

  if (surface === "chat") return clockTime(at);

  if (surface === "watch") return midnight(at) === midnight(now) ? clockTime(at) : `Tomorrow, ${clockTime(at)}`;

  if (surface === "jobs") return seconds < 60 ? `in ${String(seconds)}s` : `in ${String(Math.ceil(seconds / 60))}m`;

  if (ago < 60) return "just now";

  if (surface === "pill") return ago < 3600 ? `${String(Math.round(ago / 60))} min` : `${String(Math.round(ago / 3600))} h`;

  return ago < 3600 ? `${String(Math.floor(ago / 60))}m ago` : `${String(Math.floor(ago / 3600))}h ago`;
}

function useWhen(): (at: number, surface: Surface) => string {
  const { times } = useDesign();

  return (at, surface) => (times === "one" ? whenWords(at, NOW) : shippedWords(at, NOW, surface));
}

/** The fixture's clock: 9:40 AM on a weekday, so "today" holds a morning and "yesterday" a full day. */
const NOW = new Date(2026, 10, 5, 9, 40).getTime();

/** Who did it: the workspace's own agent, a helper it started, a job it runs, a watch of its. */
type Actor = "agent" | "helper" | "job" | "watch";

const ACTOR_ICON: Record<Actor, Icon> = { agent: ChatCircleIcon, helper: RobotIcon, job: TerminalWindowIcon, watch: BellRingingIcon };

/** What set it off, in a word: the owner, something that arrived, a time, or the agent itself. */
type Cause = { readonly tag: "You" | "Mail" | "GitHub" | "Schedule" | "On its own"; readonly said: string };

interface Done {
  readonly id: string;
  readonly at: number;
  readonly surface: Surface;
  readonly actor: Actor;
  readonly who: string;
  readonly did: string;
  readonly cause: Cause;
  readonly changed: readonly string[];
  readonly failed?: string;
}

interface Waiting { readonly id: string; readonly at: number; readonly ask: string; readonly detail: string; readonly action: string }

interface Coming { readonly id: string; readonly at: number; readonly surface: Surface; readonly what: string; readonly icon: Icon }

interface Running { readonly id: string; readonly since: number; readonly who: string; readonly actor: Actor; readonly step: string }

interface Log {
  readonly now: readonly Running[];
  readonly waiting: readonly Waiting[];
  readonly coming: readonly Coming[];
  readonly done: readonly Done[];
}

const LIVE: Log = {
  now: [
    { id: "n1", since: NOW - 3 * MINUTE, who: "Kinu", actor: "agent", step: "Running bun test in api-worker" },
    { id: "n2", since: NOW - 11 * MINUTE, who: "release-notes", actor: "helper", step: "Reading the 14 PRs merged since v1.9" },
  ],
  waiting: [
    { id: "w1", at: NOW - 6 * MINUTE, ask: "Send the reply to Priya?", detail: "Re: Dynamic Workers demo on Thursday · draft ready, 16:30", action: "Review" },
    { id: "w2", at: NOW - 40 * MINUTE, ask: "Which branch should release/v2 be cut from?", detail: "API Worker v2 release asks before it cuts", action: "Answer" },
  ],
  coming: [
    { id: "c1", at: NOW + 20 * MINUTE, surface: "jobs", what: "Check GitHub for reviews asked of you", icon: GitPullRequestIcon },
    { id: "c2", at: NOW + 2 * HOUR, surface: "watch", what: "Look at api-worker's error rate", icon: BellRingingIcon },
    { id: "c3", at: midnight(NOW) + DAY + 8 * HOUR, surface: "watch", what: "Daily brief", icon: CalendarBlankIcon },
  ],
  done: [
    { id: "d1", at: NOW - 8 * MINUTE, surface: "pill", actor: "job", who: "test-suite", did: "Ran the Worker's tests: 3 failing in routes/webhooks", cause: { tag: "On its own", said: "" }, changed: [], failed: "3 tests failing" },
    { id: "d2", at: NOW - 34 * MINUTE, surface: "chat", actor: "agent", who: "Kinu", did: "Moved the demo to 16:30 and started API Worker v2 release", cause: { tag: "You", said: "Make it 16:30. And start a workspace for the API Worker v2 release" }, changed: ["Draft: Re: Dynamic Workers demo", "Workspace: API Worker v2 release"] },
    { id: "d3", at: NOW - 52 * MINUTE, surface: "roster", actor: "agent", who: "Kinu", did: "Drafted a reply to Priya offering Thursday 16:00", cause: { tag: "Mail", said: "priya@cloudflare.com: Dynamic Workers demo on Thursday?" }, changed: ["Draft: Re: Dynamic Workers demo"] },
    { id: "d4", at: midnight(NOW) + 8 * HOUR + MINUTE, surface: "chat", actor: "watch", who: "Daily brief", did: "Sent your morning brief: 3 mails, 2 reviews, one failing deploy", cause: { tag: "Schedule", said: "Daily brief, 8:00 AM" }, changed: [] },
    { id: "d5", at: midnight(NOW) - 7 * HOUR + 50 * MINUTE, surface: "chat", actor: "watch", who: "GitHub check", did: "Told you PR #212 asks for your review", cause: { tag: "GitHub", said: "AshishKumar4/api-worker: PR #212 review requested" }, changed: [] },
    { id: "d6", at: midnight(NOW) - 9 * HOUR, surface: "chat", actor: "helper", who: "triage", did: "Sorted 23 issues into 4 areas and wrote the triage note", cause: { tag: "On its own", said: "" }, changed: ["Memory: Issue triage, Nov 4"] },
  ],
};

type ActivityState = (typeof ACTIVITY_STATES)[number]["id"];

const stateIn = (search: string): ActivityState => ACTIVITY_STATES.find((state) => state.id === new URLSearchParams(search).get("activitystate"))?.id ?? "live";

function logFor(state: ActivityState): Log | null {
  if (state === "rest") return { now: [], waiting: [], coming: LIVE.coming, done: LIVE.done.filter((entry) => entry.failed === undefined) };

  if (state === "fresh") return { now: [], waiting: [], coming: [], done: [] };

  return state === "live" ? LIVE : null;
}

type Shown = "all" | "waiting" | "coming" | "done";

function Section({ id, title, count, children }: { id: string; title: string; count?: number; children: ReactNode }) {
  return (
    <section aria-labelledby={`log-${id}`} className="flex flex-col gap-3" data-log-section={id}>
      <h2 id={`log-${id}`} className="t-label flex items-center gap-2">{title}{count !== undefined && count > 0 && <span className="p-text-3 tabular-nums">{count}</span>}</h2>
      {children}
    </section>
  );
}

function ActorMark({ actor }: { actor: Actor }) {
  const Mark = ACTOR_ICON[actor];

  return <Mark size={16} className="mt-0.5 shrink-0 p-text-3" aria-hidden />;
}

function Row({ when, mark, children }: { when: string; mark: ReactNode; children: ReactNode }) {
  return (
    <li className="grid grid-cols-[136px_20px_minmax(0,1fr)] gap-x-3 px-4 py-3 max-sm:grid-cols-[20px_minmax(0,1fr)]">
      <time className="t-meta pt-px tabular-nums p-text-3 max-sm:hidden">{when}</time>
      {mark}
      <div className="flex min-w-0 flex-col gap-1">
        {children}
        <span className="t-meta tabular-nums p-text-3 sm:hidden">{when}</span>
      </div>
    </li>
  );
}

function NowRows({ running }: { running: readonly Running[] }) {
  const when = useWhen();

  return (
    <Group list label="Now">
      {running.map((run) => (
        <Row key={run.id} when={when(run.since, "pill")} mark={<span className="flex h-5 items-center justify-center"><Dot tone="live" /></span>}>
          <span className="t-body p-text">{run.step}</span>
          <span className="t-meta flex items-center gap-2 p-text-3"><Badge>{run.actor === "agent" ? "Agent" : "Helper"}</Badge>{run.who}</span>
        </Row>
      ))}
    </Group>
  );
}

function WaitingRows({ waiting }: { waiting: readonly Waiting[] }) {
  const when = useWhen();

  return (
    <Group list label="Needs you">
      {waiting.map((ask) => (
        <Row key={ask.id} when={when(ask.at, "roster")} mark={<span className="flex h-5 items-center justify-center"><Dot tone="warning" /></span>}>
          <span className="flex items-start gap-3">
            <span className="flex min-w-0 flex-1 flex-col gap-1">
              <span className="t-body p-text">{ask.ask}</span>
              <span className="t-meta p-text-3">{ask.detail}</span>
            </span>
            <Button size="sm" variant="secondary" className="shrink-0">{ask.action}</Button>
          </span>
        </Row>
      ))}
    </Group>
  );
}

function ComingRows({ coming }: { coming: readonly Coming[] }) {
  const when = useWhen();

  return (
    <Group list label="Upcoming">
      {coming.map((next) => {
        const Mark = next.icon;

        return (
          <Row key={next.id} when={when(next.at, next.surface)} mark={<Mark size={16} className="mt-0.5 p-text-3" aria-hidden />}>
            <span className="t-body p-text">{next.what}</span>
          </Row>
        );
      })}
    </Group>
  );
}

const DAY_NAME = new Intl.DateTimeFormat("en-US", { weekday: "long", month: "long", day: "numeric" });

function dayTitle(at: number): string {
  const days = Math.round((midnight(NOW) - midnight(at)) / DAY);

  if (days === 0) return "Today";

  return days === 1 ? "Yesterday" : DAY_NAME.format(at);
}

function DoneRows({ done }: { done: readonly Done[] }) {
  const when = useWhen();
  const days = [...new Set(done.map((entry) => dayTitle(entry.at)))];

  return days.map((day) => (
    <Section key={day} id={day.toLowerCase()} title={day}>
      <Group list label={day}>
        {done.filter((entry) => dayTitle(entry.at) === day).map((entry) => (
          <Row key={entry.id} when={when(entry.at, entry.surface)} mark={<ActorMark actor={entry.actor} />}>
            <span className="t-body p-text">{entry.did}</span>
            <span className="t-meta flex min-w-0 items-center gap-2 p-text-3">
              <Badge tone={entry.cause.tag === "You" ? "neutral" : "info"}>{entry.cause.tag}</Badge>
              <span className="min-w-0 truncate">{entry.cause.said === "" ? entry.who : `${entry.who} · ${entry.cause.said}`}</span>
            </span>
            {entry.changed.length > 0 && (
              <ul className="t-meta flex flex-col gap-px p-text-2">{entry.changed.map((change) => <li key={change} className="truncate">{change}</li>)}</ul>
            )}
            {entry.failed !== undefined && <Status tone="danger">Stopped: {entry.failed}</Status>}
          </Row>
        ))}
      </Group>
    </Section>
  ));
}

/** The log at a workspace's Activity, where the shipped one stands. */
function ActivityLogMockup({ workspace, title }: { workspace: string; title: string }) {
  const state = stateIn(useLocation().search);
  const log = logFor(state);
  const [shown, setShown] = useState<Shown>("all");
  const show = (part: Shown): boolean => shown === "all" || shown === part;

  return (
    <Page fill back={{ to: workspaceRoute(workspace), label: `Back to ${title}` }} icon={<ClockCounterClockwiseIcon size={18} />} title="Activity" data-activity-log={state}>
      {state === "reading" && <div className="flex justify-center py-12"><Loader size="base" /></div>}
      {state === "failed" && <LoadFailure what="this workspace's activity" message="The workspace did not answer: it is waking. Try again in a moment." onRetry={() => undefined} />}
      {log !== null && log.done.length === 0 && log.coming.length === 0 && log.now.length === 0 && (
        <Empty icon={ClockCounterClockwiseIcon} title="Nothing yet">What its agents do, and what they will do next, shows here as it happens.</Empty>
      )}
      {log !== null && (log.done.length > 0 || log.coming.length > 0 || log.now.length > 0) && (
        <>
          <Segmented label="Show" value={shown} onChange={setShown} segments={[
            { id: "all", label: "All" },
            { id: "waiting", label: "Needs you", ...(log.waiting.length > 0 && { count: log.waiting.length }) },
            { id: "coming", label: "Upcoming", ...(log.coming.length > 0 && { count: log.coming.length }) },
            { id: "done", label: "Done" },
          ]} />
          {show("done") && log.now.length > 0 && <Section id="now" title="Now"><NowRows running={log.now} /></Section>}
          {show("waiting") && log.waiting.length > 0 && <Section id="waiting" title="Needs you" count={log.waiting.length}><WaitingRows waiting={log.waiting} /></Section>}
          {show("waiting") && shown === "waiting" && log.waiting.length === 0 && <p className="t-body p-text-3">Nothing waits on you.</p>}
          {show("coming") && log.coming.length > 0 && <Section id="coming" title="Upcoming"><ComingRows coming={log.coming} /></Section>}
          {show("done") && <DoneRows done={log.done} />}
          {show("done") && log.done.length > 0 && <p className="t-meta text-center p-text-3">{countOf(log.done.length, "thing")} done in two days · <button type="button" className="p-link">Show earlier</button></p>}
        </>
      )}
    </Page>
  );
}

/** The gallery's ActivityView: the shipped one, or the single log when the design bar says so. */
export function ActivityView(props: ComponentProps<typeof Shipped>) {
  const { activity } = useDesign();

  return activity === "log" ? <ActivityLogMockup workspace={props.workspace} title={props.title} /> : <Shipped {...props} />;
}

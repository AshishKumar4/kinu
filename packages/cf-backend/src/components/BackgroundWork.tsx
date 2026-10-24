/**
 * What works out of sight while the chat rests (1024-l): the workspace's other agents, and Main's background jobs. A
 * quiet pill over the composer counts them; it opens a sheet with each agent (its helpers under it) and each job, what
 * it is doing, and a way to it. Nothing runs: no pill. It reads the workspace's one agent list and its one job list,
 * and draws no list of its own; what finished while the person looked away is the one thing it remembers, until they
 * open the sheet.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { CaretRightIcon, ClockIcon, TerminalWindowIcon } from "@phosphor-icons/react";
import { jobPhase, type AgentActivity, type BackgroundJob, type PanelAgent } from "@kinu.run/core";
import { AgentStatusMark } from "@/components/AgentStatus";
import { ChatMascot } from "@/components/ui/Marks";
import { Pressable } from "@/components/ui/Pressable";
import { Surface } from "@/components/ui/Surface";
import { useMascotOf } from "@/hooks/use-chat-mascot";
import { useCloseOnOutsideClick } from "@/hooks/use-close-on-outside-click";

/** What a row says of its agent, and the order the sheet keeps: what needs the person first. */
type Shown = "waiting" | "failed" | "working" | "finished";

const ORDER: readonly Shown[] = ["waiting", "failed", "working", "finished"];

const SAID: Record<Shown, string> = { waiting: "Needs you", failed: "Failed", working: "Working", finished: "Finished" };

interface Row {
  readonly agent: PanelAgent;
  readonly shown: Shown;
  readonly depth: number;
}

/** An agent as the sheet shows it, or null when it rests: at rest, done, stopped or dismissed. */
function shownOf(activity: AgentActivity, finished: boolean): Shown | null {
  if (activity === "waiting" || activity === "failed" || activity === "working") return activity;

  return finished ? "finished" : null;
}

/** Each agent the sheet shows, its helpers under it, busiest first: Main is the chat itself and never a row. */
function rowsOf(agents: readonly PanelAgent[], finished: ReadonlySet<string>): Row[] {
  const shown = new Map(agents.flatMap((agent) => {
    const state = agent.category === "main" ? null : shownOf(agent.activity, finished.has(agent.key));

    return state === null ? [] : [[agent.key, state] as const];
  }));

  const rank = (agent: PanelAgent): number => ORDER.indexOf(shown.get(agent.key) ?? "finished");
  const listed = agents.filter((agent) => shown.has(agent.key)).sort((a, b) => rank(a) - rank(b));
  const rows: Row[] = [];

  const add = (agent: PanelAgent, depth: number): void => {
    rows.push({ agent, shown: shown.get(agent.key) ?? "finished", depth });

    for (const child of listed.filter((each) => each.parent === agent.key)) add(child, depth + 1);
  };

  for (const agent of listed.filter((each) => !shown.has(each.parent ?? ""))) add(agent, 0);

  return rows;
}

/** The agents seen working that have since come to rest, until the person has seen them in the sheet, which they have
 *  once it closes: the one thing this remembers. */
function useFinished(agents: readonly PanelAgent[], sheet: boolean): ReadonlySet<string> {
  const working = useRef(new Set<string>());
  const opened = useRef(false);
  const [finished, setFinished] = useState<ReadonlySet<string>>(new Set());

  useEffect(() => {
    const now = new Set(agents.filter((agent) => agent.activity === "working").map((agent) => agent.key));
    const rested = [...working.current].filter((key) => !now.has(key) && agents.some((agent) => agent.key === key && shownOf(agent.activity, false) === null));

    working.current = now;

    if (rested.length > 0) setFinished((prior) => new Set([...prior, ...rested]));
  }, [agents]);

  useEffect(() => {
    if (opened.current && !sheet) setFinished(new Set());
    opened.current = sheet;
  }, [sheet]);

  return finished;
}

const plural = (n: number, one: string, many: string): string => `${String(n)} ${n === 1 ? one : many}`;

function sinceLine(createdAt: number, now: number): string {
  const minutes = Math.max(0, Math.round((now - createdAt) / 60_000));

  if (minutes < 1) return "just now";

  return minutes < 60 ? `${String(minutes)} min` : `${String(Math.round(minutes / 60))} h`;
}

/** The pill's one mark: what most needs the person, among what is at work. */
function markOf(needs: number, failed: number): AgentActivity {
  if (needs > 0) return "waiting";

  return failed > 0 ? "failed" : "working";
}

export function BackgroundWork({ workspace, agents, jobs, open, openWork }: {
  workspace: string;
  agents: readonly PanelAgent[];
  jobs: readonly BackgroundJob[];
  /** Goes to an agent's chat (or its node), as the agents list does. */
  open: (agent: PanelAgent) => void;
  /** Opens the inspector's Work, where each job is drawn whole. */
  openWork: () => void;
}) {
  const [sheet, setSheet] = useState(false);
  const finished = useFinished(agents, sheet);
  const rows = useMemo(() => rowsOf(agents, finished), [agents, finished]);
  const now = Date.now();
  const running = jobs.filter((job) => jobPhase(job, now) !== "settled");
  const ref = useRef<HTMLDivElement>(null);
  const look = useMascotOf(workspace);

  useCloseOnOutsideClick(sheet, ref, () => setSheet(false));

  if (rows.length === 0 && running.length === 0) return null;
  const count = (state: Shown): number => rows.filter((row) => row.shown === state).length;
  const needs = count("waiting");
  const failed = count("failed");
  const working = count("working");

  const parts = [
    needs > 0 ? `${String(needs)} need${needs === 1 ? "s" : ""} you` : null,
    failed > 0 ? `${String(failed)} failed` : null,
    working > 0 ? plural(working, "agent", "agents") : null,
    count("finished") > 0 ? `${String(count("finished"))} finished` : null,
    running.length > 0 ? plural(running.length, "job", "jobs") : null,
  ].filter((part) => part !== null);

  const mark = markOf(needs, failed);

  return (
    <div ref={ref} className="p-background-work" data-background-work>
      {sheet && (
        <Surface look="panel" className="p-background-sheet p-shadow-menu" role="dialog" aria-label="Work in the background" data-background-sheet>
          {rows.length > 0 && (
            <section aria-label="Agents">
              <h3 className="t-meta p-text-3 px-2 pb-1 pt-1">Agents</h3>
              <ul>
                {rows.map(({ agent, shown, depth }) => {
                  const face = look(agent.key, agent.colour);

                  return (
                    <li key={agent.key}>
                      <Pressable className="p-background-row" style={{ paddingLeft: `${String(8 + depth * 14)}px` }} data-background-agent={agent.key}
                        data-shown={shown} onClick={() => { setSheet(false); open(agent); }}>
                        <ChatMascot seed={face.seed} colour={face.colour} activity={agent.activity} />
                        <span className="flex min-w-0 flex-1 flex-col">
                          <span className="t-body truncate p-text">{agent.label}</span>
                          {agent.doing !== undefined && <span className="t-meta truncate p-text-3">{agent.doing}</span>}
                        </span>
                        <span className="t-meta shrink-0 p-text-3">{SAID[shown]}</span>
                        <CaretRightIcon size={12} className="shrink-0 p-text-3" aria-hidden />
                      </Pressable>
                    </li>
                  );
                })}
              </ul>
            </section>
          )}
          {running.length > 0 && (
            <section aria-label="Jobs">
              <h3 className="t-meta p-text-3 px-2 pb-1 pt-2">Jobs</h3>
              <ul>
                {running.map((job) => (
                  <li key={job.id}>
                    <Pressable className="p-background-row" data-background-job={job.id} onClick={() => { setSheet(false); openWork(); }}>
                      {jobPhase(job, now) === "waiting"
                        ? <ClockIcon size={14} className="shrink-0 p-text-3" aria-hidden />
                        : <TerminalWindowIcon size={14} className="shrink-0 p-text-3" aria-hidden />}
                      <span className="t-body min-w-0 flex-1 truncate p-text">{job.label ?? job.kind}</span>
                      <span className="t-meta shrink-0 p-text-3">{jobPhase(job, now) === "waiting" ? "Waiting" : sinceLine(job.createdAt, now)}</span>
                      <CaretRightIcon size={12} className="shrink-0 p-text-3" aria-hidden />
                    </Pressable>
                  </li>
                ))}
              </ul>
            </section>
          )}
        </Surface>
      )}
      <Pressable className="p-background-pill" aria-expanded={sheet} aria-label={`Work in the background: ${parts.join(", ")}`}
        data-background-pill data-needs={needs} data-failed={failed} data-working={working} data-finished={count("finished")} data-jobs={running.length}
        onClick={() => setSheet((shown) => !shown)}>
        {(needs > 0 || failed > 0 || working > 0) && <AgentStatusMark activity={mark} />}
        <span className="t-meta">{parts.join(" · ")}</span>
      </Pressable>
    </div>
  );
}

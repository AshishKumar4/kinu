/**
 * The operators' accounts (the owner's board, operator A): on a desktop one table with every limit a column, on a
 * phone a list; each account on its own page. Invite lifts every limit; Suspend signs one out with a reason, and its
 * data stays. Every change runs through `/api/control/actions`, so the audit log holds it before it shows here.
 */
import { useState, type ReactNode } from "react";
import { Effect } from "effect";
import { detach } from "@kinu.run/core/obs";
import { ProhibitIcon, UserPlusIcon } from "@phosphor-icons/react";
import { shownBytes, type AccountLimits, type LimitReading } from "@kinu.run/core";
import { runAction, type AccountRow, type ControlAction } from "@/lib/control-api";
import { Button } from "@/components/ui/Button";
import { CopyField } from "@/components/ui/CopyField";
import { Field, TextInput } from "@/components/ui/Field";
import { Group } from "@/components/ui/Group";
import { Modal } from "@/components/ui/Modal";
import { Select } from "@/components/ui/Select";
import { Status, type StatusTone } from "@/components/ui/Status";
import { Surface } from "@/components/ui/Surface";
import { Spent, toneOf, wordsOf, type ShownLimit } from "@/components/limits/limit-words";
import { when } from "./panels";

const COLUMNS: readonly { readonly id: ShownLimit; readonly name: string }[] = [
  { id: "workspaces", name: "Workspaces" },
  { id: "computer_hours", name: "Computer" },
  { id: "stored_bytes", name: "Storage" },
  { id: "model_tokens", name: "Models today" },
];

type Shown = "Free" | "Invited" | "Operator" | "Eval" | "Suspended" | "Unread";

const CLASS_WORD = { free: "Free", invited: "Invited", operator: "Operator", eval: "Eval" } as const;

function shownClass(limits: AccountLimits | null): Shown {
  if (limits === null) return "Unread";

  return limits.report.suspended === null ? CLASS_WORD[limits.report.class] : "Suspended";
}

function classTone(shown: Shown): StatusTone {
  if (shown === "Suspended") return "danger";

  return shown === "Free" || shown === "Unread" ? "neutral" : "accent";
}

export function ClassPill({ limits }: { limits: AccountLimits | null }) {
  const shown = shownClass(limits);

  return <Status tone={classTone(shown)} hooks={{ "data-account-class": shown.toLowerCase() }}>{shown}</Status>;
}

/** A limit's use alone, for an account no limit binds: "7", "63 h", "5.8 GB". */
function plain(reading: LimitReading): string {
  switch (reading.id) {
    case "workspaces":
    case "computers_running":
      return String(reading.used);
    case "computer_hours":
      return `${String(Math.floor(reading.used / 3600))} h`;
    case "stored_bytes":
      return shownBytes(reading.used);
    case "model_tokens":
      return `${reading.used.toLocaleString()} tokens`;
  }
}

/** One limit of one account: a free account's share and bar, any other's use alone; a dash where nothing was read. */
function LimitCell({ limits, id }: { limits: AccountLimits | null; id: ShownLimit }) {
  const reading = limits?.use.find((each) => each.id === id);

  if (limits === null || reading === undefined) return <span className="t-meta p-text-3">—</span>;

  if (limits.report.limits.length === 0) return <span className="t-meta tabular-nums p-text-3">{plain(reading)}</span>;
  const { shown, percent } = wordsOf(reading);
  const ink = { danger: "p-danger", warning: "p-warning", accent: "p-text-2" }[toneOf(percent)];

  return (
    <span className="block w-24 space-y-1">
      <span className={`t-meta block tabular-nums ${ink}`}>{shown}</span>
      <Spent percent={percent} />
    </span>
  );
}

type Filter = "all" | "near" | "reached" | "invited" | "suspended";

const FILTERS: readonly { readonly id: Filter; readonly label: string; readonly keeps: (row: AccountRow) => boolean }[] = [
  { id: "all", label: "All", keeps: () => true },
  { id: "near", label: "Near a limit", keeps: (row) => (row.limits?.report.limits ?? []).some((reading) => reading.near && !reading.reached) },
  { id: "reached", label: "At a limit", keeps: (row) => (row.limits?.report.limits ?? []).some((reading) => reading.reached) },
  { id: "invited", label: "Invited", keeps: (row) => row.limits?.report.class === "invited" },
  { id: "suspended", label: "Suspended", keeps: (row) => (row.limits?.report.suspended ?? null) !== null },
];

/** The table on a desktop, the list on a phone, filtered as the operator chose; a row opens its account. */
export function AccountsTable({ rows, onOpen, onChanged }: { rows: readonly AccountRow[]; onOpen: (userId: string) => void; onChanged: () => void }) {
  const [filter, setFilter] = useState<Filter>("all");
  const [inviting, setInviting] = useState(false);
  const keeps = FILTERS.find((each) => each.id === filter)?.keeps ?? (() => true);
  const shown = rows.filter(keeps);

  return (
    <div className="space-y-4" data-accounts>
      <div className="flex flex-wrap items-center gap-1">
        {FILTERS.map((each) => (
          <Button key={each.id} variant={each.id === filter ? "secondary" : "ghost"} size="sm" onClick={() => setFilter(each.id)} aria-pressed={each.id === filter}>
            {each.label} {rows.filter(each.keeps).length}
          </Button>
        ))}
        <Button variant="primary" size="sm" icon={<UserPlusIcon size={12} />} className="ml-auto" onClick={() => setInviting(true)}>Invite</Button>
      </div>
      {shown.length === 0
        ? <Surface look="panel" as="section" className="t-meta p-8 text-center p-text-3">No accounts here.</Surface>
        : (
          <>
            <Surface look="panel" as="section" className="hidden overflow-x-auto md:block">
              <table className="t-body w-full">
                <thead className="border-b p-border">
                  <tr>
                    {["Account", "Class", ...COLUMNS.map((column) => column.name), "Seen"].map((head) => <th key={head} className="t-label px-4 py-2 text-left p-text-3">{head}</th>)}
                  </tr>
                </thead>
                <tbody>
                  {shown.map((row) => (
                    <tr key={row.userId} onClick={() => onOpen(row.userId)} data-opens="" data-account={row.email} className="border-b p-border last:border-b-0">
                      <td className="max-w-64 truncate px-4 py-2.5 p-text">{row.email}</td>
                      <td className="px-4 py-2.5"><ClassPill limits={row.limits} /></td>
                      {COLUMNS.map((column) => <td key={column.id} className="px-4 py-2.5 align-middle"><LimitCell limits={row.limits} id={column.id} /></td>)}
                      <td className="t-meta whitespace-nowrap px-4 py-2.5 p-text-3">{when(row.lastSeenAt)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </Surface>
            <div className="md:hidden">
              <Group list>
                {shown.map((row) => (
                  <li key={row.userId}>
                    <button type="button" className="flex w-full items-center gap-3 px-4 py-2.5 text-left" onClick={() => onOpen(row.userId)} data-account={row.email}>
                      <span className="min-w-0 flex-1">
                        <span className="t-body block truncate p-text">{row.email}</span>
                        <span className="t-meta block p-text-3">{listLine(row)}</span>
                      </span>
                      <ClassPill limits={row.limits} />
                    </button>
                  </li>
                ))}
              </Group>
            </div>
          </>
        )}
      {inviting && <InviteDialog onClose={() => setInviting(false)} onInvited={onChanged} />}
    </div>
  );
}

/** A phone's one line for an account: its fullest limit, or that none binds it. */
function listLine(row: AccountRow): string {
  const readings = row.limits?.report.limits ?? [];

  if (row.limits === null) return "Its limits could not be read";

  if (readings.length === 0) return "No limits";
  const fullest = readings.filter((reading) => reading.id !== "computers_running").reduce((most, reading) => (reading.used / reading.limit > most.used / most.limit ? reading : most));
  const { name, shown } = wordsOf(fullest);

  return `${name} ${shown}`;
}

/** What an action answered, as the operator reads it. */
interface Said {
  readonly ok: boolean;
  readonly text: string;
}

async function act(action: ControlAction): Promise<Said & { readonly result?: unknown }> {
  const answer = await runAction(action);

  if (answer.status !== "ok") return { ok: false, text: answer.status === "stale-auth" ? `${answer.reason} Sign in again, then retry.` : answer.reason };

  return { ok: answer.value.outcome === "ok", text: answer.value.detail, result: answer.value.result };
}

function InviteDialog({ onClose, onInvited }: { onClose: () => void; onInvited: () => void }) {
  const [email, setEmail] = useState("");
  const [busy, setBusy] = useState(false);
  const [said, setSaid] = useState<Said | null>(null);
  const [link, setLink] = useState<string | null>(null);

  const run = (action: ControlAction) => detach(Effect.promise(async () => {
    setBusy(true);
    const answer = await act(action);

    setBusy(false);
    setSaid(answer);

    if (!answer.ok) return;
    onInvited();
    const path = typeof answer.result === "object" && answer.result !== null && "path" in answer.result ? answer.result.path : null;

    if (typeof path === "string") setLink(`${window.location.origin}${path}`);
  }));

  return (
    <Modal title="Invite someone" icon={<UserPlusIcon size={16} />} width="md" onClose={onClose} busy={busy}
      footer={(
        <>
          <Button variant="ghost" size="sm" onClick={onClose}>Close</Button>
          <Button variant="secondary" size="sm" disabled={busy} onClick={() => run({ action: "invite.link" })}>Make a link instead</Button>
          <Button variant="primary" size="sm" disabled={busy || email.trim() === ""} onClick={() => run({ action: "invite.email", email: email.trim() })}>Invite</Button>
        </>
      )}>
      <div className="space-y-3">
        <Field label="Their email">
          <TextInput type="email" value={email} onChange={(event) => setEmail(event.target.value)} placeholder="name@example.com" aria-label="Their email" autoComplete="off" />
        </Field>
        <p className="t-meta p-text-3">An invited account has no limits, from its first sign-in. A link works once, for 7 days, for whoever opens it signed in.</p>
        {link !== null && <CopyField value={link} what="the invite link" />}
        {said !== null && <p role={said.ok ? "status" : "alert"} className={`t-meta ${said.ok ? "p-text-2" : "p-danger"}`}>{said.text}</p>}
      </div>
    </Modal>
  );
}

function SuspendDialog({ email, userId, onClose, onDone }: { email: string; userId: string; onClose: () => void; onDone: () => void }) {
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState<string | null>(null);

  const suspend = () => detach(Effect.promise(async () => {
    setBusy(true);
    const answer = await act({ action: "account.suspend", userId, reason: reason.trim() });

    setBusy(false);

    if (!answer.ok) {
      setFailed(answer.text);

      return;
    }

    onDone();
    onClose();
  }));

  return (
    <Modal title={`Suspend ${email}?`} icon={<ProhibitIcon size={16} className="p-danger" />} width="md" onClose={onClose} busy={busy}
      footer={(
        <>
          <Button variant="ghost" size="sm" onClick={onClose}>Cancel</Button>
          <Button variant="destructive" size="sm" disabled={busy || reason.trim() === ""} onClick={suspend}>Suspend</Button>
        </>
      )}>
      <div className="space-y-3">
        <p className="t-body p-text-2">They&apos;re signed out everywhere and can&apos;t sign in. Nothing new starts in their workspaces; their data stays. You can lift it from this page.</p>
        <Field label="Why (only operators see it)">
          <TextInput value={reason} onChange={(event) => setReason(event.target.value)} maxLength={300} aria-label="Why" />
        </Field>
        {failed !== null && <p role="alert" className="t-meta p-danger">{failed}</p>}
      </div>
    </Modal>
  );
}

/** One account on its own page: its class, each limit, and the operator's changes to its standing. */
export function AccountStanding({ userId, email, seen, limits, onChanged }: {
  userId: string;
  email: string;
  seen: number | null;
  limits: AccountLimits;
  onChanged: () => void;
}): ReactNode {
  const [suspending, setSuspending] = useState(false);
  const [busy, setBusy] = useState(false);
  const [said, setSaid] = useState<Said | null>(null);
  const { report } = limits;
  // An operator's and an eval account's class is the deployment's, never set here.
  const settable = report.class === "free" || report.class === "invited";
  const stored = report.class === "invited" ? "invited" : "free";

  const run = (action: ControlAction) => detach(Effect.promise(async () => {
    setBusy(true);
    const answer = await act(action);

    setBusy(false);
    setSaid(answer);

    if (answer.ok) onChanged();
  }));

  return (
    <section className="space-y-4" data-account-standing={report.class}>
      <div className="flex flex-wrap items-center gap-2">
        <h3 className="t-title p-text">{email}</h3>
        <ClassPill limits={limits} />
        {seen !== null && <span className="t-meta p-text-3">seen {when(seen)}</span>}
      </div>
      {report.suspended !== null && <p className="t-meta p-danger">Suspended {when(report.suspended.at)}: {report.suspended.reason}</p>}
      {limits.use.length > 0 && (
        <Group>
          {COLUMNS.map((column) => {
            const reading = limits.use.find((each) => each.id === column.id);

            return (
              <div key={column.id} className="flex items-center gap-3 px-4 py-2.5">
                <span className="p-text-2">{reading === undefined ? null : wordsOf(reading).icon}</span>
                <span className="t-body flex-1 p-text">{column.name}</span>
                <span className="w-32"><LimitCell limits={limits} id={column.id} /></span>
              </div>
            );
          })}
        </Group>
      )}
      <div className="flex flex-wrap items-center gap-2">
        {settable && (
          <Select label="Class" size="sm" value={stored} disabled={busy}
            options={[{ value: "free", label: "Class: Free" }, { value: "invited", label: "Class: Invited" }]}
            onChange={(chosen) => run({ action: "account.class", userId, class: chosen })} />
        )}
        {report.suspended === null
          ? <Button variant="danger" size="sm" icon={<ProhibitIcon size={12} />} disabled={busy} onClick={() => setSuspending(true)}>Suspend</Button>
          : <Button variant="secondary" size="sm" disabled={busy} onClick={() => run({ action: "account.unsuspend", userId })}>Lift the suspension</Button>}
      </div>
      <p className="t-meta p-text-3">Invited lifts every limit. Suspended can&apos;t sign in; their data stays until you lift it or remove the account.</p>
      {said !== null && <p role={said.ok ? "status" : "alert"} className={`t-meta ${said.ok ? "p-text-2" : "p-danger"}`}>{said.text}</p>}
      {suspending && <SuspendDialog email={email} userId={userId} onClose={() => setSuspending(false)} onDone={onChanged} />}
    </section>
  );
}

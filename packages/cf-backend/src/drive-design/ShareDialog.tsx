import { useState, type ReactNode } from "react";
import { Button } from "@cloudflare/kumo";
import {
  ArrowLeftIcon, CaretDownIcon, CaretRightIcon, CheckIcon, GitForkIcon, GlobeIcon, LinkSimpleIcon, LockSimpleIcon,
  ShareNetworkIcon, SquaresFourIcon, UsersIcon, WarningIcon, XIcon,
} from "@phosphor-icons/react";
import { Modal } from "@/components/ui/Modal";
import { FilledButton } from "@/components/ui/FilledButton";
import { inputCls } from "@/components/ui/form";
import { Segmented } from "@/components/ui/Segmented";
import type { Access, Person } from "./tiles";

export type SharePane = "live" | "blueprint" | "reach" | "limits" | "activity" | "workspace";

export interface ShareSubject {
  readonly kind: "slate" | "workspace";
  readonly title: string;
  readonly owner: Person;
  readonly access: Access;
}

export function namedPeople(access: Access): readonly Person[] {
  return access.kind === "people" ? access.people : [];
}

function Avatar({ person }: { person: Person }) {
  return (
    <span aria-hidden="true" className="flex size-7 shrink-0 items-center justify-center rounded-full p-fill text-[11px] font-semibold p-text-2">
      {person.name.charAt(0)}
    </span>
  );
}

function PersonRow({ person, role }: { person: Person; role: "Owner" | "Can use" | "Can view" }) {
  const owner = role === "Owner";

  return (
    <li className="flex items-center gap-3 py-1.5">
      <Avatar person={person} />
      <span className="min-w-0 flex-1">
        <span className="block truncate p-row-text font-medium p-text">{owner ? `${person.name} (you)` : person.name}</span>
        <span className="block truncate p-meta p-text-3">{person.email}</span>
      </span>
      <span className="shrink-0 p-meta p-text-3">{role}</span>
      {!owner
        ? <button type="button" aria-label={`Remove ${person.name}`} className="-mr-1 shrink-0 rounded-md p-1 p-text-4 transition-colors hover:bg-[var(--c-elevated)] hover:p-text"><XIcon size={13} /></button>
        : <span className="w-[21px] shrink-0" />}
    </li>
  );
}

function InviteField() {
  return (
    <div className="flex gap-2">
      <input placeholder="Add people by email" aria-label="Add people by email" className={inputCls} />
      <Button variant="secondary" size="sm" className="!h-[38px] shrink-0 px-3">Invite</Button>
    </div>
  );
}

interface AccessOption {
  readonly id: "private" | "people" | "link";
  readonly icon: ReactNode;
  readonly label: string;
  readonly detail: string;
}

const LIVE_ACCESS: readonly AccessOption[] = [
  { id: "private", icon: <LockSimpleIcon size={15} />, label: "Only you", detail: "Nobody else can open it. The people above keep their place." },
  { id: "people", icon: <UsersIcon size={15} />, label: "Only people you add", detail: "Anyone else who gets the link sees nothing." },
  { id: "link", icon: <GlobeIcon size={15} />, label: "Anyone with the link", detail: "No sign-in needed. It still runs as you." },
];

const BLUEPRINT_ACCESS: readonly AccessOption[] = [
  { id: "people", icon: <UsersIcon size={15} />, label: "Only people you add", detail: "They sign in to read it and fork a copy." },
  { id: "link", icon: <GlobeIcon size={15} />, label: "Anyone with the link", detail: "They can read it without signing in; a fork needs a Kinu account." },
];

function AccessPicker({ options, initial, initiallyOpen = false }: {
  options: readonly AccessOption[];
  initial: AccessOption["id"];
  initiallyOpen?: boolean;
}) {
  const [open, setOpen] = useState(initiallyOpen);
  const [value, setValue] = useState(initial);
  const chosen = options.find((option) => option.id === value) ?? options[0];

  if (chosen === undefined) return null;

  return (
    <div className="relative flex items-start gap-3">
      <span className="mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-full p-fill p-text-2">{chosen.icon}</span>
      <span className="min-w-0 flex-1">
        <button type="button" aria-haspopup="listbox" aria-expanded={open} onClick={() => setOpen((shown) => !shown)}
          className="-ml-1.5 inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 p-row-text font-medium p-text transition-colors hover:bg-[var(--c-elevated)]">
          {chosen.label} <CaretDownIcon size={12} className="p-text-3" />
        </button>
        <span className="block p-meta p-text-3">{chosen.detail}</span>
      </span>
      {open && (
        <div role="listbox" aria-label="Who can open it" className="absolute left-8 top-12 z-10 w-[21rem] max-w-[calc(100%-2rem)] p-card border p-border p-1.5 p-shadow-menu animate-fade-in">
          {options.map((option) => (
            <button key={option.id} type="button" role="option" aria-selected={option.id === value}
              onClick={() => { setValue(option.id); setOpen(false); }}
              className="flex w-full items-start gap-2.5 rounded-md px-2 py-2 text-left transition-colors hover:bg-[var(--c-elevated)]">
              <span className="mt-0.5 flex shrink-0 p-text-3">{option.icon}</span>
              <span className="min-w-0 flex-1">
                <span className="block text-sm font-medium p-text">{option.label}</span>
                <span className="block p-meta p-text-3">{option.detail}</span>
              </span>
              <span className="mt-0.5 flex w-4 shrink-0">{option.id === value && <CheckIcon size={14} weight="bold" className="p-accent" />}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function SummaryRow({ label, value, onOpen }: { label: string; value: ReactNode; onOpen: () => void }) {
  return (
    <button type="button" onClick={onOpen} className="flex w-full items-center gap-3 px-3.5 py-2.5 text-left transition-colors hover:bg-[var(--c-elevated)]">
      <span className="w-[4.5rem] shrink-0 p-row-text font-medium p-text">{label}</span>
      <span className="min-w-0 flex-1 truncate p-meta p-text-3">{value}</span>
      <CaretRightIcon size={13} className="shrink-0 p-text-4" />
    </button>
  );
}

function Footer({ left, children }: { left?: ReactNode; children: ReactNode }) {
  return (
    <div className="flex items-center gap-2 border-t p-border pt-4">
      {left}
      <div className="ml-auto flex items-center gap-2">{children}</div>
    </div>
  );
}

const COPY_LINK = <Button variant="ghost" size="sm" icon={<LinkSimpleIcon size={14} />}>Copy link</Button>;

function StopSharingButton({ onStop }: { onStop: () => void }) {
  return (
    <button type="button" onClick={onStop} className="rounded-md px-2 py-1 text-xs font-medium p-danger transition-colors hover:bg-[var(--c-danger-tint)]">
      Stop sharing
    </button>
  );
}

function DoneButton({ onClose }: { onClose: () => void }) {
  return <FilledButton className="h-8 px-4 text-sm" onClick={onClose}>Done</FilledButton>;
}

function LivePane({ subject, go, onClose, onStop, accessOpen }: {
  subject: ShareSubject;
  go: (pane: SharePane) => void;
  onClose: () => void;
  onStop: () => void;
  accessOpen: boolean;
}) {
  const people = namedPeople(subject.access);
  const shared = subject.access.kind !== "people" || people.length > 0;

  return (
    <>
      <p className="p-row-text p-text-2">People open your slate and use it. It runs in your workspace, as you.</p>
      <InviteField />
      <ul>
        <PersonRow person={subject.owner} role="Owner" />
        {people.map((person) => <PersonRow key={person.email} person={person} role="Can use" />)}
      </ul>
      <AccessPicker options={LIVE_ACCESS} initial={subject.access.kind} initiallyOpen={accessOpen} />
      <div className="p-group">
        <SummaryRow label="Reach" value="GitHub, notes, files · 1 change allowed" onOpen={() => go("reach")} />
        <SummaryRow label="Limits" value="120 a minute each · $2 a day" onOpen={() => go("limits")} />
        {shared && <SummaryRow label="Activity" value="14 opens by 2 people this week" onOpen={() => go("activity")} />}
      </div>
      <Footer left={COPY_LINK}>
        {shared && <StopSharingButton onStop={onStop} />}
        <DoneButton onClose={onClose} />
      </Footer>
    </>
  );
}

const PATHS = [
  { name: "package.json", on: true, fixed: true },
  { name: "src", on: true, fixed: false },
  { name: "assets", on: true, fixed: false },
  { name: "scratch", on: false, fixed: false },
];

function BlueprintPane({ onClose }: { onClose: () => void }) {
  return (
    <>
      <p className="p-row-text p-text-2">People get their own copy to fork. Nothing of yours comes with it: no connections, chats or data.</p>
      <dl className="space-y-3">
        <div className="flex items-center gap-3">
          <dt className="w-20 shrink-0 p-meta p-text-3">Version</dt>
          <dd className="min-w-0 flex-1">
            <button type="button" className={`${inputCls} flex items-center justify-between text-left`}>
              <span><span className="p-num p-text">v2k9q1c</span> <span className="p-text-3">· latest, 12m ago</span></span>
              <CaretDownIcon size={12} className="p-text-3" />
            </button>
          </dd>
        </div>
        <div className="flex items-start gap-3">
          <dt className="mt-1 w-20 shrink-0 p-meta p-text-3">Includes</dt>
          <dd className="flex min-w-0 flex-1 flex-wrap gap-1.5">
            {PATHS.map((path) => (
              <label key={path.name} className={`inline-flex items-center gap-1.5 rounded-md border px-2 py-1 text-xs ${path.on ? "p-border p-text" : "border-dashed p-border p-text-3"}`}>
                <input type="checkbox" defaultChecked={path.on} disabled={path.fixed} className="accent-[var(--c-accent)]" />
                <span className="font-mono">{path.name}</span>
              </label>
            ))}
          </dd>
        </div>
        <div className="flex items-start gap-3">
          <dt className="w-20 shrink-0 p-meta p-text-3">They connect</dt>
          <dd className="min-w-0 flex-1 p-meta p-text-2">Their own GitHub, notes and files, when they fork it.</dd>
        </div>
      </dl>
      <div className="p-notice-warning flex items-start gap-2 px-3 py-2 text-xs">
        <WarningIcon size={14} className="mt-px shrink-0" />
        <span><span className="font-medium">Looks like a key in src/config.ts, line 4.</span> A blueprint carries its source as written. Remove it before you publish.</span>
      </div>
      <AccessPicker options={BLUEPRINT_ACCESS} initial="link" />
      <Footer>
        <Button variant="ghost" size="sm" onClick={onClose}>Cancel</Button>
        <FilledButton className="h-8 px-4 text-sm"><GitForkIcon size={14} weight="bold" /> Publish</FilledButton>
      </Footer>
    </>
  );
}

const REACH = [
  {
    binding: "GitHub", kind: "MCP server", members: [
      { name: "read_issue", what: "Reads issues", change: false, allowed: true },
      { name: "create_issue", what: "Opens issues in your repositories", change: true, allowed: false },
    ],
  },
  {
    binding: "Notes", kind: "workspace memory", members: [
      { name: "recall", what: "Reads your notes", change: false, allowed: true },
      { name: "remember", what: "Writes to your notes", change: true, allowed: false },
    ],
  },
  {
    binding: "Files", kind: "Checkout coupon bug", members: [
      { name: "readFile", what: "Reads files in the workspace", change: false, allowed: true },
      { name: "writeFile", what: "Changes files in the workspace", change: true, allowed: true },
    ],
  },
];

function ReachPane({ go }: { go: (pane: SharePane) => void }) {
  return (
    <>
      <p className="p-row-text p-text-2">Everything here uses your connections. Reading is on. Each change stays off until you allow it.</p>
      <div className="space-y-3">
        {REACH.map((group) => (
          <section key={group.binding} className="p-group">
            <header className="flex items-baseline gap-2 px-3.5 py-2">
              <span className="p-row-text font-medium p-text">{group.binding}</span>
              <span className="p-meta p-text-4">{group.kind}</span>
            </header>
            {group.members.map((member) => (
              <label key={member.name} className="flex items-center gap-3 px-3.5 py-2">
                <span className="min-w-0 flex-1">
                  <span className="block font-mono text-xs p-text-2">{member.name}</span>
                  <span className="block p-meta p-text-3">{member.what}</span>
                </span>
                {member.change
                  ? <input type="checkbox" defaultChecked={member.allowed} aria-label={`Allow ${member.name}`} className="size-4 accent-[var(--c-accent)]" />
                  : <span className="p-meta p-text-4">Always on</span>}
              </label>
            ))}
          </section>
        ))}
      </div>
      <Footer>
        <FilledButton className="h-8 px-4 text-sm" onClick={() => go("live")}>Done</FilledButton>
      </Footer>
    </>
  );
}

function LimitField({ label, detail, value, unit }: { label: string; detail: string; value: string; unit: string }) {
  return (
    <label className="flex items-center gap-4">
      <span className="min-w-0 flex-1">
        <span className="block p-row-text font-medium p-text">{label}</span>
        <span className="block p-meta p-text-3">{detail}</span>
      </span>
      <span className="flex shrink-0 items-center gap-1.5">
        <span className="w-24"><input defaultValue={value} aria-label={label} className={`${inputCls} text-right`} /></span>
        <span className="w-14 p-meta p-text-3">{unit}</span>
      </span>
    </label>
  );
}

function LimitsPane({ go }: { go: (pane: SharePane) => void }) {
  return (
    <>
      <p className="p-row-text p-text-2">Every call someone makes runs on your account. These keep a busy link from running up a bill.</p>
      <div className="space-y-4">
        <LimitField label="Requests" detail="For each person, every minute" value="120" unit="a minute" />
        <LimitField label="Model spend" detail="For everyone together, each day (UTC)" value="$2.00" unit="a day" />
      </div>
      <p className="p-meta p-text-3">At a limit, people see a short pause page until it resets. You are never paused.</p>
      <Footer>
        <Button variant="ghost" size="sm" onClick={() => go("live")}>Cancel</Button>
        <FilledButton className="h-8 px-4 text-sm" onClick={() => go("live")}>Save</FilledButton>
      </Footer>
    </>
  );
}

const SAMPLE_VISITS = [{ opens: "9 opens", last: "2h ago" }, { opens: "5 opens", last: "Yesterday" }];

function ActivityPane({ go, workspace, people }: { go: (pane: SharePane) => void; workspace: boolean; people: readonly Person[] }) {
  const rows = workspace
    ? people.slice(0, 1).map((person) => ({ person, opens: "3 views", last: "2h ago" }))
    : SAMPLE_VISITS.flatMap((visit, index) => {
      const person = people[index];

      return person === undefined ? [] : [{ person, ...visit }];
    });

  return (
    <>
      <div className="grid grid-cols-2 gap-3">
        <div className="rounded-lg border p-border p-surface px-3.5 py-3">
          <span className="block p-meta p-text-3">{workspace ? "Views" : "Opens"} this week</span>
          <span className="mt-0.5 block text-xl font-semibold p-text">{workspace ? "3" : "14"}</span>
        </div>
        <div className="rounded-lg border p-border p-surface px-3.5 py-3">
          <span className="block p-meta p-text-3">{workspace ? "Last viewed" : "Spent today"}</span>
          {workspace
            ? <span className="mt-0.5 block text-xl font-semibold p-text">2h ago</span>
            : (
              <>
                <span className="mt-0.5 block text-xl font-semibold p-text">$0.42 <span className="text-sm font-normal p-text-3">of $2.00</span></span>
                <span className="mt-2 block h-1 overflow-hidden rounded-full bg-[var(--c-border-strong)]"><span className="block h-full w-[21%] rounded-full bg-[var(--c-accent)]" /></span>
              </>
            )}
        </div>
      </div>
      <ul className="space-y-0.5">
        {rows.map((row) => (
          <li key={row.person.email} className="flex items-center gap-3 py-1.5">
            <Avatar person={row.person} />
            <span className="min-w-0 flex-1 truncate p-row-text font-medium p-text">{row.person.name}</span>
            <span className="shrink-0 p-meta tabular-nums p-text-3">{row.opens}</span>
            <span className="w-20 shrink-0 text-right p-meta p-text-4">{row.last}</span>
          </li>
        ))}
      </ul>
      <p className="p-meta p-text-3">{workspace ? "A view is one visit to the chat or files." : "An open is one visit. Every request inside it is in the workspace's activity log."}</p>
      <Footer>
        <FilledButton className="h-8 px-4 text-sm" onClick={() => go(workspace ? "workspace" : "live")}>Done</FilledButton>
      </Footer>
    </>
  );
}

function WorkspacePane({ subject, go, onClose, onStop }: {
  subject: ShareSubject;
  go: (pane: SharePane) => void;
  onClose: () => void;
  onStop: () => void;
}) {
  const people = namedPeople(subject.access);
  const [first] = people;

  return (
    <>
      <p className="p-row-text p-text-2">People you add can read the chat and files. Nothing runs for them, and they can't change anything.</p>
      <InviteField />
      <ul>
        <PersonRow person={subject.owner} role="Owner" />
        {people.map((person) => <PersonRow key={person.email} person={person} role="Can view" />)}
      </ul>
      <label className="flex items-start gap-3">
        <input type="checkbox" defaultChecked className="mt-1 size-4 shrink-0 accent-[var(--c-accent)]" />
        <span>
          <span className="block p-row-text font-medium p-text">Let them fork it</span>
          <span className="block p-meta p-text-3">A fork copies the chat and files into a workspace of their own, on their own models and connections.</span>
        </span>
      </label>
      {first !== undefined && (
        <div className="p-group">
          <SummaryRow label="Activity" value={`${first.name} viewed it 2h ago`} onOpen={() => go("activity")} />
        </div>
      )}
      <Footer left={COPY_LINK}>
        {first !== undefined && <StopSharingButton onStop={onStop} />}
        <DoneButton onClose={onClose} />
      </Footer>
    </>
  );
}

const PANE_TITLE: Partial<Record<SharePane, string>> = {
  reach: "What people can reach",
  limits: "Limits",
  activity: "Activity",
};

export function ShareDialog({ subject, initialPane, accessOpen = false, onClose, onStop }: {
  subject: ShareSubject;
  initialPane: SharePane;
  accessOpen?: boolean;
  onClose: () => void;
  onStop: () => void;
}) {
  const [pane, setPane] = useState<SharePane>(initialPane);
  const workspace = subject.kind === "workspace";
  const sub = PANE_TITLE[pane];
  const home: SharePane = workspace ? "workspace" : "live";

  let icon = workspace ? <SquaresFourIcon size={18} className="p-accent" /> : <ShareNetworkIcon size={18} className="p-accent" />;

  if (sub !== undefined) {
    icon = (
      <button type="button" aria-label="Back" onClick={() => setPane(home)}
        className="-ml-1 rounded-md p-1 p-text-3 transition-colors hover:bg-[var(--c-elevated)] hover:p-text">
        <ArrowLeftIcon size={16} />
      </button>
    );
  }

  return (
    <Modal title={sub ?? `Share ${subject.title}`} icon={icon} onClose={onClose} maxWidthClass="max-w-[520px]">
      {!workspace && (pane === "live" || pane === "blueprint") && (
        <div className="w-fit">
          <Segmented label="How to share" value={pane} onChange={setPane}
            segments={[{ id: "live", label: "Live" }, { id: "blueprint", label: "Blueprint" }]} />
        </div>
      )}
      {pane === "live" && <LivePane subject={subject} go={setPane} onClose={onClose} onStop={onStop} accessOpen={accessOpen} />}
      {pane === "blueprint" && <BlueprintPane onClose={onClose} />}
      {pane === "reach" && <ReachPane go={setPane} />}
      {pane === "limits" && <LimitsPane go={setPane} />}
      {pane === "activity" && <ActivityPane go={setPane} workspace={workspace} people={namedPeople(subject.access)} />}
      {pane === "workspace" && <WorkspacePane subject={subject} go={setPane} onClose={onClose} onStop={onStop} />}
    </Modal>
  );
}

export function StopSharingDialog({ title, who, onClose }: { title: string; who: string; onClose: () => void }) {
  return (
    <Modal title={`Stop sharing ${title}?`} onClose={onClose} maxWidthClass="max-w-sm"
      footer={<><Button variant="ghost" size="sm" onClick={onClose}>Cancel</Button><FilledButton danger className="h-8 px-3 text-sm" onClick={onClose}>Stop sharing</FilledButton></>}>
      <p className="p-row-text p-text-2">{who} lose access right away, and the link stops working. You can share it again later.</p>
    </Modal>
  );
}

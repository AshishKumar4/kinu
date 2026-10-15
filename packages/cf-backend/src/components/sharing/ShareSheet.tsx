/**
 * The share sheet, the owner's own (security §2.5: adding people, the link and the Gallery are the owner's acts). One
 * live slate, used together: people the owner adds can edit or use it, anyone with the link can use it. Each lend is one
 * line and one switch; who used them is listed per person, and Remove takes that person off the slate. A secret's shape
 * in the code keeps the link off, since anyone who can open the slate can fork it.
 *
 * It reads the room's sheet and calls the room; the next view shows each call's effect.
 */
import { useState, type ReactNode } from "react";
import { Effect } from "effect";
import { Button } from "@cloudflare/kumo";
import { CaretDownIcon, CheckIcon, GlobeHemisphereWestIcon, KeyIcon, LinkSimpleIcon, LockSimpleIcon, ShareNetworkIcon, UsersThreeIcon } from "@phosphor-icons/react";
import {
  GALLERY_CATEGORIES, type GalleryCategory, type RoomAudience, type RoomCall, type RoomPerson, type RoomRole, type SheetLend, type SheetLendUse,
  type SheetMember, type SheetView,
} from "@kinu.run/core";
import { detach, renderThrownChain, type KinuError } from "@kinu.run/core/obs";
import { Avatar } from "@/components/ui/Avatar";
import { FilledButton } from "@/components/ui/FilledButton";
import { Modal } from "@/components/ui/Modal";
import { Switch } from "@/components/ui/Switch";
import { useCopy } from "@/hooks/use-copy";
import { ago, nameOf, possessives, reachOf } from "./words";

const AUDIENCES: readonly { id: RoomAudience; icon: ReactNode; label: string; hint: string | null }[] = [
  { id: "only-you", icon: <LockSimpleIcon size={15} />, label: "Only you", hint: null },
  { id: "people", icon: <UsersThreeIcon size={15} />, label: "People you add", hint: "Each can edit or use it" },
  { id: "anyone", icon: <GlobeHemisphereWestIcon size={15} />, label: "Anyone with the link", hint: "Can use it" },
];

const ROLES: Record<RoomRole, { readonly label: string; readonly hint: string }> = {
  edit: { label: "Edit", hint: "Can change the slate" },
  use: { label: "Use", hint: "Can use it" },
};

const CATEGORY_WORDS: Record<GalleryCategory, string> = { work: "Work", money: "Money", home: "Home", developer: "Developer", fun: "Fun" };

/** One menu open at a time, by key. */
function useMenu() {
  const [open, setOpen] = useState<string | null>(null);

  return (key: string) => ({ open: open === key, setOpen: (now: boolean) => setOpen(now ? key : null) });
}

type Menu = ReturnType<ReturnType<typeof useMenu>>;

function AudienceSelect({ value, onChoose, locked, menu }: { value: RoomAudience; onChoose: (audience: RoomAudience) => void; locked: boolean; menu: Menu }) {
  const chosen = AUDIENCES.find((each) => each.id === value) ?? AUDIENCES[0];

  if (chosen === undefined) return null;

  return (
    <div className="relative">
      <button type="button" aria-haspopup="listbox" aria-expanded={menu.open} disabled={locked} data-share-audience={chosen.id} onClick={() => menu.setOpen(!menu.open)}
        className="flex h-9 w-full items-center gap-2.5 rounded-lg border p-border bg-[var(--c-input-bg)] px-3 text-left disabled:opacity-60">
        <span className="flex shrink-0 p-text-3">{chosen.icon}</span>
        <span className="min-w-0 flex-1 p-row-text p-text">{chosen.label}</span>
        <CaretDownIcon size={13} className="p-text-3" />
      </button>
      {menu.open && (
        <div role="listbox" aria-label="Who can open it" className="absolute inset-x-0 top-10 z-10 p-card border p-border p-1 p-shadow-menu animate-fade-in">
          {AUDIENCES.map((option) => (
            <button key={option.id} type="button" role="option" aria-selected={option.id === value} data-share-audience-option={option.id}
              onClick={() => { onChoose(option.id); menu.setOpen(false); }}
              className={`flex min-h-9 w-full items-center gap-2.5 rounded-md px-2.5 py-1.5 text-left ${option.id === value ? "bg-[var(--c-elevated)]" : "hover:bg-[var(--c-elevated)]"}`}>
              <span className="flex shrink-0 p-text-3">{option.icon}</span>
              <span className="min-w-0 flex-1">
                <span className="block p-row-text p-text">{option.label}</span>
                {option.hint !== null && <span className="block p-meta p-text-3">{option.hint}</span>}
              </span>
              {option.id === value && <CheckIcon size={14} weight="bold" className="p-accent" />}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/** A role, from its own small menu; a person's menu also removes them. */
function RoleMenu({ role, onRole, onRemove, menu }: { role: RoomRole; onRole: (role: RoomRole) => void; onRemove?: () => void; menu: Menu }) {
  return (
    <div className="relative shrink-0">
      <button type="button" aria-haspopup="menu" aria-expanded={menu.open} data-share-role={role} onClick={() => menu.setOpen(!menu.open)}
        className="inline-flex h-7 items-center gap-1 rounded-md px-2 p-meta p-text-2 hover:bg-[var(--c-elevated)]">
        {ROLES[role].label}<CaretDownIcon size={11} />
      </button>
      {menu.open && (
        <div role="menu" className="absolute right-0 top-8 z-20 w-52 p-card border p-border p-1 p-shadow-menu animate-fade-in">
          {(["edit", "use"] as const).map((each) => (
            <button key={each} type="button" role="menuitemradio" aria-checked={each === role} data-share-role-option={each}
              onClick={() => { onRole(each); menu.setOpen(false); }} className="flex w-full items-start gap-2 rounded-md px-2.5 py-1.5 text-left hover:bg-[var(--c-elevated)]">
              <span className="min-w-0 flex-1">
                <span className="block p-row-text p-text">{ROLES[each].label}</span>
                <span className="block p-meta p-text-3">{ROLES[each].hint}</span>
              </span>
              {each === role && <CheckIcon size={14} weight="bold" className="mt-0.5 p-accent" />}
            </button>
          ))}
          {onRemove !== undefined && (
            <>
              <div className="my-1 border-t p-border" />
              <button type="button" role="menuitem" data-share-remove onClick={() => { onRemove(); menu.setOpen(false); }}
                className="flex w-full items-center rounded-md px-2.5 py-1.5 text-left p-row-text p-danger hover:bg-[var(--c-elevated)]">Remove</button>
            </>
          )}
        </div>
      )}
    </div>
  );
}

/** The people: an invitation by email with its role, then the owner and each person. */
function People({ owner, people, send, menu }: { owner: RoomPerson; people: readonly SheetMember[]; send: (call: RoomCall) => void; menu: (key: string) => Menu }) {
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<RoomRole>("use");

  return (
    <div className="space-y-2">
      <form className="flex items-center gap-1.5 rounded-lg border p-border bg-[var(--c-input-bg)] py-1 pl-3 pr-1"
        onSubmit={(event) => {
          event.preventDefault();

          if (email.trim() === "") return;
          send({ op: "invite", email: email.trim(), role });
          setEmail("");
        }}>
        <input value={email} onChange={(event) => setEmail(event.target.value)} type="email" placeholder="Add by email" aria-label="Add by email" data-share-invite-email
          className="min-w-0 flex-1 bg-transparent p-row-text p-text outline-none placeholder:text-[var(--c-text-4)]" />
        <RoleMenu role={role} onRole={setRole} menu={menu("invite")} />
        <Button size="sm" variant="secondary" type="submit" data-share-invite>Invite</Button>
      </form>
      <ul>
        <li className="flex items-center gap-2.5 py-1.5">
          <Avatar name={nameOf(owner)} size={26} />
          <span className="min-w-0 flex-1 truncate p-row-text p-text">{nameOf(owner)} (you)</span>
          <span className="px-2 p-meta p-text-3">Owner</span>
        </li>
        {people.map(({ person, role: given }) => (
          <li key={person.email} data-share-person={person.email} className="flex items-center gap-2.5 py-1.5">
            <Avatar name={nameOf(person)} size={26} />
            <span className="min-w-0 flex-1">
              <span className="block truncate p-row-text p-text">{nameOf(person)}</span>
              <span className="block truncate p-meta p-text-3">{person.name === null ? "Invited" : person.email}</span>
            </span>
            <RoleMenu role={given} menu={menu(person.email)}
              onRole={(next) => send({ op: "setRole", email: person.email, role: next })} onRemove={() => send({ op: "remove", email: person.email })} />
          </li>
        ))}
      </ul>
    </div>
  );
}

/** The Gallery: listed by a line and a category, both asked for before it lists. */
function Gallery({ listing, send }: { listing: SheetView["listing"]; send: (call: RoomCall) => void }) {
  const [drafting, setDrafting] = useState(false);
  const [line, setLine] = useState("");
  const [category, setCategory] = useState<GalleryCategory>("work");
  const on = listing !== null || drafting;

  // On asks for its line first; off unlists a listed slate, or drops the draft.
  const turn = (next: boolean) => {
    setDrafting(next);

    if (!next && listing !== null) send({ op: "unlist" });
  };

  return (
    <div className="space-y-2">
      <div className="flex min-h-9 items-center gap-3">
        <span className="min-w-0 flex-1 p-row-text p-text">List in the Gallery</span>
        <Switch on={on} label="List in the Gallery" data-share-gallery
          onChange={turn} />
      </div>
      {listing !== null && <p className="p-meta p-text-3">{listing.line} · {CATEGORY_WORDS[listing.category]}</p>}
      {listing === null && drafting && (
        <form className="space-y-2 rounded-lg border p-border p-2.5" onSubmit={(event) => {
          event.preventDefault();

          if (line.trim() === "") return;
          send({ op: "list", line: line.trim(), category });
          setDrafting(false);
        }}>
          <input value={line} onChange={(event) => setLine(event.target.value)} placeholder="One line about it" aria-label="One line about it" data-share-gallery-line maxLength={120}
            className="w-full rounded-md border p-border bg-[var(--c-input-bg)] px-2.5 py-1.5 p-row-text p-text outline-none placeholder:text-[var(--c-text-4)]" />
          <div role="radiogroup" aria-label="Category" className="flex flex-wrap gap-1.5">
            {GALLERY_CATEGORIES.map((each) => (
              <button key={each} type="button" role="radio" aria-checked={each === category} data-share-gallery-category={each} onClick={() => setCategory(each)}
                className={`rounded-full px-2.5 py-0.5 text-xs ${each === category ? "bg-[var(--c-accent-subtle)] p-accent font-medium" : "p-fill p-text-2"}`}>{CATEGORY_WORDS[each]}</button>
            ))}
          </div>
          <div className="flex justify-end"><Button size="sm" variant="secondary" type="submit" data-share-gallery-list>List it</Button></div>
        </form>
      )}
    </div>
  );
}

/** A row's detail, each part whole and its separator kept with it: a narrow sheet wraps between parts. */
function Parts({ parts }: { parts: readonly string[] }) {
  return (
    <span className="flex flex-wrap gap-x-1 p-meta p-text-3">
      {parts.map((part, at) => <span key={part} className="whitespace-nowrap">{part}{at < parts.length - 1 ? " ·" : ""}</span>)}
    </span>
  );
}

function LendRow({ lend, send }: { lend: SheetLend; send: (call: RoomCall) => void }) {
  const seen = lend.shown === "holder" ? "only you see what it returns" : "people see what it returns";

  return (
    <div data-share-lend={lend.fn} className="flex items-start gap-3 py-2">
      <span className="min-w-0 flex-1">
        <span className="flex flex-wrap gap-x-1 p-row-text p-text">
          <span className="whitespace-nowrap font-mono text-[12.5px]">{lend.fn} ·</span>
          <span className="whitespace-nowrap p-text-2">{reachOf(lend.reach)} ·</span>
          {lend.reach.effect && <span className="whitespace-nowrap p-text-2">each waits for you ·</span>}
          <button type="button" data-share-lend-shown={lend.shown} onClick={() => send({ op: "setLendShown", fn: lend.fn, shown: lend.shown === "holder" ? "everyone" : "holder" })}
            className="inline-flex items-center gap-0.5 whitespace-nowrap p-text-2 underline decoration-dotted underline-offset-2 hover:p-text">{seen}<CaretDownIcon size={10} /></button>
        </span>
        {lend.free && lend.on && <span className="block p-meta p-warning">Others can type anything here, and it reaches {lend.reach.service.title}.</span>}
        {lend.suspendedBy !== null && <span className="block p-meta p-warning">{nameOf(lend.suspendedBy)} changed it. Off until you lend it again.</span>}
      </span>
      {lend.suspendedBy === null
        ? <Switch on={lend.on} onChange={(on) => send({ op: "setLend", fn: lend.fn, on })} label={lend.fn} data-share-lend-on={lend.fn} />
        : <Button size="sm" variant="secondary" data-share-lend-again onClick={() => send({ op: "setLend", fn: lend.fn, on: true })}>Lend again</Button>}
    </div>
  );
}

/** The lends, one line each with one switch; who used them, with Remove. */
function Lends({ lends, uses, send }: { lends: readonly SheetLend[]; uses: readonly SheetLendUse[]; send: (call: RoomCall) => void }) {
  const [who, setWho] = useState(false);

  return (
    <div className="space-y-1">
      <div className="p-meta font-medium p-text-3">Others can use, as you</div>
      <div className="divide-y divide-[var(--c-border)]">{lends.map((lend) => <LendRow key={lend.fn} lend={lend} send={send} />)}</div>
      {uses.length > 0 && (
        <button type="button" onClick={() => setWho(!who)} aria-expanded={who} data-share-who className="inline-flex items-center gap-1 py-1 p-meta p-accent">
          Who used it<CaretDownIcon size={11} className={who ? "rotate-180" : ""} />
        </button>
      )}
      {uses.length > 0 && who && (
        <>
          <ul className="rounded-lg border p-border">
            {uses.map((use) => (
              <li key={`${use.person.email} ${use.fn}`} className="flex items-center gap-2.5 border-b p-border px-3 py-2 last:border-b-0">
                <Avatar name={nameOf(use.person)} size={20} />
                <span className="min-w-0 flex-1">
                  <span className="block truncate p-row-text p-text">{nameOf(use.person)}</span>
                  <Parts parts={[use.fn, use.calls === 1 ? "1 call" : `${String(use.calls)} calls`, ago(use.lastAt, Date.now())]} />
                </span>
                <Button size="sm" variant="ghost" data-share-who-remove={use.person.email} onClick={() => send({ op: "remove", email: use.person.email })}>Remove</Button>
              </li>
            ))}
          </ul>
          <p className="p-meta p-text-3">Remove takes them off this slate at once. What they already saw stays with them.</p>
        </>
      )}
    </div>
  );
}

/** A secret's shape in the code keeps the link off, since anyone who can open the slate can fork it. */
function SecretInCode({ secret, onFix }: { secret: NonNullable<SheetView["secret"]>; onFix: () => void }) {
  return (
    <div data-share-secret className="flex items-start gap-3 rounded-lg p-notice-warning px-3 py-2.5">
      <KeyIcon size={16} className="mt-0.5 shrink-0" />
      <span className="min-w-0 flex-1">
        <span className="block p-row-text font-medium">{secret.file} line {secret.line} looks like {secret.kind}</span>
        <span className="block p-meta">People can fork the code, so only you can open it until that&apos;s gone.</span>
      </span>
      <Button size="sm" variant="secondary" data-share-secret-fix onClick={onFix}>Fix with the agent</Button>
    </div>
  );
}

function LinkRow({ url }: { url: string | null }) {
  const { status, copy } = useCopy();

  return (
    <div className="flex items-center gap-2 rounded-lg border p-border bg-[var(--c-input-bg)] py-1.5 pl-3 pr-1.5">
      <LinkSimpleIcon size={14} className="shrink-0 p-text-3" />
      <span data-share-url className="min-w-0 flex-1 truncate font-mono text-xs p-text-2">{url ?? "The link is off"}</span>
      <FilledButton className="h-7 px-3 text-xs" disabled={url === null} data-share-copy onClick={() => { if (url !== null) copy(url); }}>
        {status === "copied" ? "Copied" : "Copy link"}
      </FilledButton>
    </div>
  );
}

export function ShareSheet({ title, owner, sheet, call, onFixSecret, onClose }: {
  title: string;
  owner: RoomPerson;
  sheet: SheetView;
  call: (call: RoomCall) => Effect.Effect<void, KinuError>;
  /** Starts the owner's agent on the secret the code holds. */
  onFixSecret: (secret: NonNullable<SheetView["secret"]>) => void;
  onClose: () => void;
}) {
  const menus = useMenu();
  const [failure, setFailure] = useState<string | null>(null);
  const [busy, setBusy] = useState(0);
  const shared = sheet.audience !== "only-you";

  const send = (sent: RoomCall) => {
    setFailure(null);
    setBusy((count) => count + 1);
    detach(call(sent).pipe(
      Effect.catch((refused) => Effect.sync(() => setFailure(renderThrownChain({ cause: refused })))),
      Effect.ensuring(Effect.sync(() => setBusy((count) => count - 1))),
    ));
  };

  return (
    <Modal title={`Share ${title}`} icon={<ShareNetworkIcon size={18} className="p-accent" />} onClose={onClose} busy={busy > 0} maxWidthClass="max-w-[460px]"
      footer={<div className="flex justify-end"><FilledButton onClick={onClose}>Done</FilledButton></div>}>
      {sheet.secret !== null && <SecretInCode secret={sheet.secret} onFix={() => onFixSecret(sheet.secret ?? { file: "", line: 0, kind: "" })} />}
      <LinkRow url={sheet.url} />
      <div className="space-y-2">
        <div className="p-meta font-medium p-text-3">Who can open it</div>
        <AudienceSelect value={sheet.audience} locked={sheet.secret !== null} menu={menus("audience")} onChoose={(audience) => send({ op: "setAudience", audience })} />
        {sheet.audience === "anyone" && sheet.privateOf.length > 0 && (
          <p data-share-private-hidden className="flex items-center gap-1.5 p-meta p-text-2"><LockSimpleIcon size={13} className="shrink-0" />{possessives(sheet.privateOf)} private items stay hidden from link visitors.</p>
        )}
        {shared && <People owner={owner} people={sheet.people} send={send} menu={menus} />}
      </div>
      {sheet.audience === "anyone" && <Gallery listing={sheet.listing} send={send} />}
      {shared && sheet.lends.length > 0 && <Lends lends={sheet.lends} uses={sheet.uses} send={send} />}
      {failure !== null && <div role="alert" className="p-notice-danger rounded-md px-3 py-2 text-xs">{failure}</div>}
    </Modal>
  );
}

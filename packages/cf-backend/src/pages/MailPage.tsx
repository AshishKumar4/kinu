import { useCallback, useEffect, useState, type FormEvent, type ReactNode } from "react";
import { Link, useLocation, useNavigate, useNavigationType, useParams, useSearchParams } from "react-router-dom";
import { Loader } from "@/components/ui/Loader";
import { Button, ICON_ON_PHONE, buttonClass } from "@/components/ui/Button";
import { EnvelopeSimpleIcon, MagnifyingGlassIcon, NotePencilIcon, SparkleIcon } from "@phosphor-icons/react";
import { APP_ROUTES, MAIL_VIEWS, suggestedMailUsername, type MailBox, type MailListing, type MailView } from "@kinu.run/core";
import { ImportantMailRow } from "@/components/mail/ImportantMailRow";
import { MAIL_VIEW_LABEL, MailRow, mailBoxLabel } from "@/components/mail/MailRow";
import { MailThreadReader } from "@/components/mail/MailThreadReader";
import { Compose } from "@/components/mail/MailEditor";
import { ToolPage } from "@/components/ui/PageHeader";
import { Segmented } from "@/components/ui/Segmented";
import { Choice, inputCls } from "@/components/ui/form";
import { Modal } from "@/components/ui/Modal";
import { LoadFailure } from "@/components/ui/LoadFailure";
import { useLabelledStep } from "@/components/ui/ConfirmDialog";
import { lastValue, useAsyncResource, type AsyncResource } from "@/hooks/use-async-resource";
import { useAccount } from "@/hooks/use-account";
import { useMediaQuery } from "@/hooks/use-media-query";
import { createMailAddress, listMailThreads, readMailBoxes, type MailBoxes } from "@/lib/mail-api";
import { MailAddressField, useMailUsername } from "@/components/mail/MailAddressField";



/** Where the mailbox would be, for a person with no address yet: the address they create, as setup offers it. */
function CreateAddress({ domain, suggested, onCreated }: { domain: string; suggested: string | null; onCreated: () => void }) {
  const { username, setUsername, state } = useMailUsername(suggested);
  const { busy, error, run } = useLabelledStep(onCreated);

  const create = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    run("Creating", async () => { await createMailAddress(username); });
  };

  return (
    <form data-mail-create onSubmit={create} className="p-card mt-5 max-w-md space-y-3 p-4">
      <h2 className="t-item p-text">Your email address</h2>
      <MailAddressField domain={domain} username={username} state={state} onChange={setUsername} disabled={busy !== null} />
      {error !== null && <p role="alert" className="t-body p-danger">{error}</p>}
      <Button variant="primary" size="md" type="submit" disabled={busy !== null || state !== "available"}>{busy === null ? "Create address" : "Creating…"}</Button>
    </form>
  );
}

function InstallAssistant({ address, onClose }: { address: string; onClose: () => void }) {
  return (
    <Modal title="Your personal assistant" icon={<SparkleIcon size={18} weight="fill" className="p-accent" />} onClose={onClose}
      footer={<><Button variant="ghost" size="sm" onClick={onClose}>Not now</Button><Link to={APP_ROUTES.explore} className={buttonClass({ variant: "primary", size: "sm" })}>Install</Link></>}>
      <p data-mail-install className="t-body p-text-2">Kinu reads <span className="font-mono p-text">{address}</span>, picks what's important, and drafts your replies.</p>
    </Modal>
  );
}

interface Inbox {
  readonly listing: MailListing;
  readonly important: number;
  readonly drafts: number;
}

function mailLocation(params: URLSearchParams, boxes: readonly MailBox[], splat: string | undefined) {
  const view = MAIL_VIEWS.find((name) => name === params.get("view")) ?? "important";
  const address = params.get("address");
  const path = params.get("path") ?? boxes.find((box) => box.address === address || box.path === address)?.path;
  const query = params.get("q") ?? "";
  const before = params.has("before") ? Number(params.get("before")) : undefined;
  const opened = splat === "" || splat === undefined ? params.get("thread") : splat;

  return { view, path, query, before, opened };
}

function ThreadList({ resource, view, boxes, path, owner, reading, onOpen, onRetry }: {
  resource: AsyncResource<Inbox>; view: MailView; boxes: readonly MailBox[]; path: string | undefined;
  owner: string; reading: string | null; onOpen: (id: string) => void; onRetry: () => void;
}) {
  const loaded = lastValue(resource);
  const threads = loaded?.listing.threads ?? [];

  return <>
    {resource.status === "loading" && <div role="status" aria-label="Loading mail" className="p-4"><Loader /></div>}
    {resource.status === "error" && <LoadFailure what="your mail" message={resource.message} onRetry={onRetry} className="p-4" />}
    {loaded !== null && <div data-mail-list aria-label={view} className="divide-y divide-dashed divide-[var(--c-dash)] border-b border-dashed border-[var(--c-dash)]">
      {threads.map((thread) => {
        const box = boxes.find((each) => each.path === thread.path);
        const from = thread.from[0];

        return view === "important"
          ? <ImportantMailRow key={thread.id} open={reading === thread.id} onOpen={() => onOpen(thread.id)} mail={{ thread: thread.id, from: { name: from?.name ?? from?.address ?? "", address: from?.address ?? "" }, to: box?.address ?? "", subject: thread.subject, reason: thread.important ?? "", at: thread.at, unread: thread.unread }} />
          : <MailRow key={thread.id} thread={thread} open={reading === thread.id} onOpen={() => onOpen(thread.id)} owner={owner} drafts={view === "drafts"} box={path === undefined && box?.kind !== "person" ? box : undefined} />;
      })}
      {threads.length === 0 && <p className="t-body px-4 py-8 text-center p-text-3">Nothing here.</p>}
    </div>}
  </>;
}

/** A view's segment: its count beside it where it has one (Important's unread once there is an assistant, Drafts). */
function viewSegment(id: MailView, loaded: Inbox | null, waiting: boolean): { id: MailView; label: string; count?: number } {
  let count = 0;

  if (id === "important" && !waiting) count = loaded?.important ?? 0;

  if (id === "drafts") count = loaded?.drafts ?? 0;

  return count > 0 ? { id, label: MAIL_VIEW_LABEL[id], count } : { id, label: MAIL_VIEW_LABEL[id] };
}

/** Where the views, search and addresses go: in the bar where the whole set fits, else the row under it. */
function placed({ narrow, views, search, addresses }: { narrow: boolean; views: ReactNode; search: ReactNode; addresses: ReactNode }) {
  if (narrow) return { below: <div className="p-tool-row">{views}{search}{addresses}</div>, inBar: null };

  return { view: views, inBar: <>{search}{addresses}</> };
}

function MailInbox({ account, owner }: { account: MailBoxes; owner: string }) {
  const [params, setParams] = useSearchParams();
  const location = useLocation();
  const navigate = useNavigate();
  const route = useParams();
  const { view, path, query: routedQuery, before, opened } = mailLocation(params, account.boxes, route["*"]);
  const navigationType = useNavigationType();
  const [query, setQuery] = useState(routedQuery);
  const [composing, setComposing] = useState(false);
  const [installing, setInstalling] = useState(false);
  const navigation = useLabelledStep(() => undefined);
  const roomy = useMediaQuery("(min-width: 1024px)");
  // The bar holds the views, search and addresses only where the whole set fits beside the sidebar; narrower, they are a
  // row of their own under it, drawn once wherever they are.
  const narrow = !useMediaQuery("(min-width: 1280px)");
  const waiting = view === "important" && account.boxes.find((box) => box.kind === "person")?.workspace === null;

  // Router navigations transition; a controlled text input cannot wait for them.
  useEffect(() => { if (navigationType !== "REPLACE") setQuery(routedQuery); }, [navigationType, routedQuery]);

  const load = useCallback(async (): Promise<Inbox> => {
    const scope = { path, query };

    const [important, drafts, other] = await Promise.all([
      listMailThreads({ ...scope, view: "important" }), listMailThreads({ ...scope, view: "drafts" }),
      view === "important" || view === "drafts" ? null : listMailThreads({ ...scope, view, before }),
    ]);

    let listing = other ?? important;

    if (view === "drafts") listing = drafts;

    if (before !== undefined && (view === "important" || view === "drafts")) listing = await listMailThreads({ ...scope, view, before });

    return { listing, important: important.unread, drafts: drafts.threads.length };
  }, [path, query, view, before]);

  const inbox = useAsyncResource(load, undefined, JSON.stringify([path, query, view, before]));
  const loaded = lastValue(inbox.resource);
  const threads = loaded?.listing.threads ?? [];
  const reading = opened ?? (roomy && !waiting ? threads[0]?.id ?? null : null);

  const at = (changes: Record<string, string | null>): void => {
    const next = new URLSearchParams(location.search);
    next.delete("thread");
    next.delete("before");

    for (const [key, value] of Object.entries(changes)) {
      if (value === null) next.delete(key);
      else next.set(key, value);
    }

    setParams(next, { replace: true });

    if (opened !== null) navigation.run("Opening", async () => navigate(`${APP_ROUTES.mail}?${next.toString()}`, { replace: true }));
  };

  const back = (): void => {
    const next = new URLSearchParams(location.search);
    next.delete("thread");
    navigation.run("Opening", async () => {
      await navigate(`${APP_ROUTES.mail}?${next.toString()}`);
      inbox.reload();
    });
  };

  const choose = (id: string): void => {
    const next = new URLSearchParams(location.search);
    next.delete("thread");
    navigation.run("Opening", async () => navigate(`${APP_ROUTES.mail}/${encodeURIComponent(id)}?${next.toString()}`));
  };

  const views = (
    <Segmented label="Mail views" size="sm" value={view} onChange={(next) => at({ view: next })} segments={MAIL_VIEWS.map((id) => viewSegment(id, loaded, waiting))} />
  );

  const search = (
    <label className="relative w-60 min-w-0 shrink">
      <MagnifyingGlassIcon size={13} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 p-text-3" aria-hidden />
      <input value={query} onChange={(event) => { setQuery(event.target.value); at({ q: event.target.value || null }); }} placeholder="Search mail" aria-label="Search mail" data-mail-search
        className={`${inputCls} h-7 rounded-[var(--r-control)] py-0 pl-6`} />
    </label>
  );

  const addresses = (
    <div className="w-40 shrink-0" data-mail-address><Choice label="Address" size="sm" className="!h-7" value={path ?? "*"} onChange={(next) => at({ path: next === "*" ? null : next, address: null })}
      options={[{ value: "*", label: "All addresses" }, ...account.boxes.map((box) => ({ value: box.path, label: mailBoxLabel(box) }))]} /></div>
  );

  const controls = placed({ narrow, views, search, addresses });

  // A tool (design review 2026-10-20, A2): the list a full-height column with its own rule, the thread read beside it on
  // the ground; below `lg` one of the two at a time.
  return (
    <ToolPage icon={<EnvelopeSimpleIcon size={18} />} title="Mail" view={controls.view} below={controls.below}
      actions={(
        <>
          {controls.inBar}
          <Button variant="primary" size="sm" data-mail-compose aria-label="Compose" className={ICON_ON_PHONE} onClick={() => setComposing(true)}><NotePencilIcon size={15} /><span className="max-sm:hidden">Compose</span></Button>
        </>
      )}
>
      <section className={`min-w-0 overflow-y-auto p-border lg:w-[400px] lg:shrink-0 lg:border-r ${opened === null ? "flex-1 lg:flex-none" : "hidden lg:block"}`}>
        {navigation.error !== null && <p role="alert" className="t-body px-4 pt-3 p-danger">{navigation.error}</p>}
        {waiting ? <div data-mail-no-assistant className="flex flex-wrap items-center justify-between gap-3 px-4 py-3">
          <p className="t-body p-text-2">No assistant yet</p><Button variant="primary" size="md" onClick={() => setInstalling(true)}>Set up your assistant</Button>
        </div> : <>
          <ThreadList resource={inbox.resource} view={view} boxes={account.boxes} path={path} owner={owner} reading={reading} onOpen={choose} onRetry={inbox.reload} />
          {loaded !== null && <div className="flex justify-between gap-2 px-2 py-2">
            {before !== undefined && <Button variant="ghost" size="sm" onClick={() => at({ before: null })}>Newest</Button>}
            {threads.length === 50 && <Button variant="ghost" size="sm" className="ml-auto" onClick={() => at({ before: String(threads.at(-1)?.at) })}>Older</Button>}
          </div>}
        </>}
      </section>
      {reading !== null && (
        <div className={`min-w-0 flex-1 overflow-y-auto p-5 sm:p-8 ${opened === null ? "hidden lg:block" : ""}`}>
          <MailThreadReader id={reading} boxes={account.boxes} owner={owner} drafts={view === "drafts"} onBack={back} onChanged={inbox.reload} />
        </div>
      )}
      {composing && <Compose boxes={account.boxes} initialPath={path ?? account.boxes[0]?.path ?? ""} onClose={() => setComposing(false)} onSaved={inbox.reload} />}
      {installing && <InstallAssistant address={account.address ?? ""} onClose={() => setInstalling(false)} />}
    </ToolPage>
  );
}

export default function MailPage() {
  const boxes = useAsyncResource(readMailBoxes);
  const { profile } = useAccount();
  const account = lastValue(boxes.resource);
  const person = lastValue(profile);

  return (
    <div data-mail-page className="h-full">
      {account?.address != null ? <MailInbox account={account} owner={person?.email ?? ""} /> : <ToolPage icon={<EnvelopeSimpleIcon size={18} />} title="Mail"><div className="flex-1 overflow-y-auto p-6">
        {boxes.resource.status === "loading" && <div role="status" aria-label="Loading mail" className="mt-5"><Loader /></div>}
        {account !== null && !account.enabled && <p data-mail-off className="t-body mt-5 p-text-2">Mail is off on this deployment.</p>}
        {account?.enabled === true && account.canCreate && person !== null && (
          <CreateAddress domain={account.domain ?? ""} suggested={suggestedMailUsername(person)} onCreated={boxes.reload} />
        )}
        {account?.enabled === true && !account.canCreate && <p className="t-body mt-5 p-text-2">Addresses on this deployment are its operators' only.</p>}
        {boxes.resource.status === "error" && <LoadFailure what="your addresses" message={boxes.resource.message} onRetry={boxes.reload} className="mt-5" />}
      </div></ToolPage>}
    </div>
  );
}

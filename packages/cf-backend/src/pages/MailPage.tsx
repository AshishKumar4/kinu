import { useCallback, useState, type FormEvent } from "react";
import { Link, useLocation, useNavigate, useParams, useSearchParams } from "react-router-dom";
import { Button, Loader } from "@cloudflare/kumo";
import { EnvelopeSimpleIcon, MagnifyingGlassIcon, NotePencilIcon, SparkleIcon } from "@phosphor-icons/react";
import { APP_ROUTES, type MailBox, type MailListing, type MailView } from "@kinu.run/core";
import { ImportantMailRow } from "@/components/mail/ImportantMailRow";
import { MailRow, mailBoxLabel } from "@/components/mail/MailRow";
import { MailThreadReader } from "@/components/mail/MailThreadReader";
import { Compose } from "@/components/mail/MailEditor";
import { PageHeader, PAGE_BODY } from "@/components/ui/PageHeader";
import { Segmented } from "@/components/ui/Segmented";
import { Choice, inputCls } from "@/components/ui/form";
import { FilledButton } from "@/components/ui/FilledButton";
import { Modal } from "@/components/ui/Modal";
import { LoadFailure } from "@/components/ui/LoadFailure";
import { useLabelledStep } from "@/components/ui/ConfirmDialog";
import { lastValue, useAsyncResource, type AsyncResource } from "@/hooks/use-async-resource";
import { useAccount } from "@/hooks/use-account";
import { useMediaQuery } from "@/hooks/use-media-query";
import { claimMailAddress, listMailThreads, readMailBoxes, type MailBoxes } from "@/lib/mail-api";

const VIEWS: readonly MailView[] = ["important", "all", "sent", "drafts", "trash"];

const LABELS: Record<MailView, string> = { important: "Important", all: "All", sent: "Sent", drafts: "Drafts", trash: "Trash" };

function Claim({ email, onClaimed }: { email: string; onClaimed: () => void }) {
  const [username, setUsername] = useState(email.split("@")[0].toLowerCase());
  const { busy, error, run } = useLabelledStep(onClaimed);

  const claim = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    run("Claiming", async () => { await claimMailAddress(username); });
  };

  return (
    <form onSubmit={claim} className="p-card mt-5 max-w-sm space-y-3 p-4">
      <label className="block space-y-1 p-row-text p-text-2">Username
        <input value={username} onChange={(event) => setUsername(event.target.value.toLowerCase())} aria-label="Username" autoComplete="username" autoCapitalize="none"
          pattern="[a-z0-9]([a-z0-9-]{0,18}[a-z0-9])?" maxLength={20} required disabled={busy !== null} className={inputCls} />
      </label>
      {error !== null && <p role="alert" className="p-row-text p-danger">{error}</p>}
      <FilledButton type="submit" disabled={busy !== null}>{busy === null ? "Claim address" : "Claiming…"}</FilledButton>
    </form>
  );
}

function InstallAssistant({ address, onClose }: { address: string; onClose: () => void }) {
  return (
    <Modal title="Your personal assistant" icon={<SparkleIcon size={18} weight="fill" className="p-accent" />} onClose={onClose}
      footer={<><Button variant="ghost" size="sm" onClick={onClose}>Not now</Button><Link to={APP_ROUTES.explore} className="p-btn inline-flex h-6.5 items-center justify-center gap-1 px-2 text-xs">Install</Link></>}>
      <p data-mail-install className="p-row-text p-text-2">Kinu reads <span className="font-mono p-text">{address}</span>, picks what's important, and drafts your replies.</p>
    </Modal>
  );
}

interface Inbox {
  readonly listing: MailListing;
  readonly important: number;
  readonly drafts: number;
}

function mailLocation(params: URLSearchParams, boxes: readonly MailBox[], splat: string | undefined) {
  const view = VIEWS.find((name) => name === params.get("view")) ?? "important";
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
    {resource.status === "error" && <LoadFailure what="your mail" message={resource.message} onRetry={onRetry} className="p-card p-4" />}
    {loaded !== null && <div data-mail-list aria-label={view} className="p-group">
      {threads.map((thread) => {
        const box = boxes.find((each) => each.path === thread.path);
        const from = thread.from[0];

        return view === "important"
          ? <ImportantMailRow key={thread.id} open={reading === thread.id} onOpen={() => onOpen(thread.id)} mail={{ thread: thread.id, from: { name: from?.name ?? from?.address ?? "", address: from?.address ?? "" }, to: box?.address ?? "", subject: thread.subject, reason: thread.important ?? "", at: thread.at, unread: thread.unread }} />
          : <MailRow key={thread.id} thread={thread} open={reading === thread.id} onOpen={() => onOpen(thread.id)} owner={owner} drafts={view === "drafts"} box={path === undefined && box?.kind !== "person" ? box : undefined} />;
      })}
      {threads.length === 0 && <p className="px-4 py-8 text-center p-row-text p-text-3">Nothing here.</p>}
    </div>}
  </>;
}

function MailInbox({ account, owner }: { account: MailBoxes; owner: string }) {
  const [params, setParams] = useSearchParams();
  const location = useLocation();
  const navigate = useNavigate();
  const route = useParams();
  const { view, path, query, before, opened } = mailLocation(params, account.boxes, route["*"]);
  const [composing, setComposing] = useState(false);
  const [installing, setInstalling] = useState(false);
  const navigation = useLabelledStep(() => undefined);
  const roomy = useMediaQuery("(min-width: 1024px)");
  const waiting = view === "important" && account.boxes.find((box) => box.kind === "person")?.workspace === null;

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
  const controls = opened === null ? "flex" : "hidden lg:flex";

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

  return (
    <>
      <PageHeader icon={<EnvelopeSimpleIcon size={22} />} title="Mail">
        <FilledButton data-mail-compose onClick={() => setComposing(true)}><NotePencilIcon size={15} />Compose</FilledButton>
      </PageHeader>
      {navigation.error !== null && <p role="alert" className="mt-3 p-row-text p-danger">{navigation.error}</p>}
      <div className="mt-5 grid grid-cols-[minmax(0,1fr)] items-start gap-x-5 gap-y-3 lg:grid-cols-[minmax(0,26rem)_minmax(0,1fr)]">
        <div className={`max-w-full overflow-x-auto ${controls}`}>
          <Segmented label="Mail views" value={view} onChange={(next) => at({ view: next })} segments={VIEWS.map((id) => {
            let count = 0;

            if (id === "important" && !waiting) count = loaded?.important ?? 0;

            if (id === "drafts") count = loaded?.drafts ?? 0;

            return count > 0 ? { id, label: LABELS[id], count } : { id, label: LABELS[id] };
          })} />
        </div>
        <div className={`items-center gap-2 lg:justify-end ${controls}`}>
          <label className="relative min-w-0 flex-1 lg:max-w-72">
            <MagnifyingGlassIcon size={13} className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 p-text-3" aria-hidden />
            <input value={query} onChange={(event) => at({ q: event.target.value || null })} placeholder="Search mail" aria-label="Search mail" data-mail-search className={`${inputCls} h-[34px] py-0 pl-8`} />
          </label>
          <div className="w-40 shrink-0" data-mail-address><Choice label="Address" value={path ?? "all"} onChange={(next) => at({ path: next === "all" ? null : next, address: null })}
            options={[{ value: "all", label: "All addresses" }, ...account.boxes.map((box) => ({ value: box.path, label: mailBoxLabel(box) }))]} /></div>
        </div>
        <section className={opened === null ? "min-w-0" : "hidden min-w-0 lg:block"}>
          {waiting ? <div data-mail-no-assistant className="p-card flex flex-wrap items-center justify-between gap-3 px-4 py-3.5">
            <p className="p-row-text p-text-2">No assistant yet</p><FilledButton onClick={() => setInstalling(true)}>Set up your assistant</FilledButton>
          </div> : <>
            <ThreadList resource={inbox.resource} view={view} boxes={account.boxes} path={path} owner={owner} reading={reading} onOpen={choose} onRetry={inbox.reload} />
            {loaded !== null && <div className="mt-2 flex justify-between gap-2">
              {before !== undefined && <Button variant="ghost" size="sm" onClick={() => at({ before: null })}>Newest</Button>}
              {threads.length === 50 && <Button variant="ghost" size="sm" className="ml-auto" onClick={() => at({ before: String(threads.at(-1)?.at) })}>Older</Button>}
            </div>}
          </>}
        </section>
        {reading !== null && <MailThreadReader id={reading} boxes={account.boxes} owner={owner} drafts={view === "drafts"} onBack={back} onChanged={inbox.reload} />}
      </div>
      {composing && <Compose boxes={account.boxes} initialPath={path ?? account.boxes[0]?.path ?? ""} onClose={() => setComposing(false)} onSaved={inbox.reload} />}
      {installing && <InstallAssistant address={account.address ?? ""} onClose={() => setInstalling(false)} />}
    </>
  );
}

export default function MailPage() {
  const boxes = useAsyncResource(readMailBoxes);
  const { profile } = useAccount();
  const account = lastValue(boxes.resource);
  const person = lastValue(profile);

  return (
    <div data-mail-page className="h-full overflow-y-auto"><div className={`w-full ${PAGE_BODY}`}>
      {account?.address != null ? <MailInbox account={account} owner={person?.email ?? ""} /> : <>
        <PageHeader icon={<EnvelopeSimpleIcon size={22} />} title="Mail" />
        {boxes.resource.status === "loading" && <div role="status" aria-label="Loading mail" className="mt-5"><Loader /></div>}
        {account !== null && account.canClaim && profile.status !== "loading" && <Claim email={person?.email ?? ""} onClaimed={boxes.reload} />}
        {account !== null && !account.canClaim && <p className="mt-5 p-row-text p-text-2">Addresses on this deployment are its operators' only.</p>}
      </>}
      {boxes.resource.status === "error" && <LoadFailure what="your addresses" message={boxes.resource.message} onRetry={boxes.reload} className="mt-5" />}
    </div></div>
  );
}

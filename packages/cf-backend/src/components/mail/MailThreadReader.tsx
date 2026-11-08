import { useCallback, useEffect, useState } from "react";
import { Loader } from "@/components/ui/Loader";
import { ArrowSquareOutIcon, CaretLeftIcon, TrashIcon, TrayIcon } from "@phosphor-icons/react";
import type { MailArchivedBox, MailBox, MailThreadSummary, MailThreadView } from "@kinu.run/core";
import { Menu, type MenuItem } from "@/components/ui/Menu";
import { LoadFailure } from "@/components/ui/LoadFailure";
import { useLabelledStep } from "@/hooks/use-labelled-step";
import { lastValue, useAsyncResource } from "@/hooks/use-async-resource";
import { readMailThread, updateMailThread } from "@/lib/mail-api";
import { MailMessage } from "./MailMessage";
import { ReplyBox } from "./MailEditor";
import { archivedBoxLabel, mailBoxLabel } from "./MailRow";
import { SendToWorkspace } from "./SendToWorkspace";
import { Button } from "@/components/ui/Button";
import { Chip } from "@/components/ui/Chip";
import { Notice } from "@/components/ui/Notice";

/** `archived`: the boxes of deleted workspaces, whose kept mail is read here and answered from nowhere. */
export function MailThreadReader({ id, boxes, archived, owner, drafts, onBack, onChanged }: {
  id: string; boxes: readonly MailBox[]; archived: readonly MailArchivedBox[]; owner: string; drafts: boolean; onBack: () => void; onChanged: () => void;
}) {
  const load = useCallback(async (): Promise<MailThreadView> => {
    const mail = await readMailThread(id);

    if (!mail.thread.unread) return mail;
    const thread = await updateMailThread(id, { read: true });

    return { thread, messages: mail.messages.map((message) => ({ ...message, read: true })) };
  }, [id]);

  const { resource, reload } = useAsyncResource(load, undefined, id);
  const mail = lastValue(resource);

  useEffect(() => { if (mail !== null) onChanged(); }, [mail, onChanged]);

  return (
    <div className="min-w-0">
      {mail === null && <Button variant="ghost" size="sm" className="mb-3 lg:hidden" data-mail-back onClick={onBack} icon={<CaretLeftIcon size={14} />}>Mail</Button>}
      {resource.status === "loading" && <div role="status" aria-label="Loading thread"><Loader /></div>}
      {resource.status === "error" && <LoadFailure what="this thread" message={resource.message} onRetry={reload} />}
      {mail !== null && <Reader key={`${id}:${String(drafts)}`} mail={mail} box={boxes.find((box) => box.path === mail.thread.path)}
        retired={archived.find((box) => box.path === mail.thread.path)} owner={owner} drafts={drafts} onBack={onBack} onChanged={reload} />}
    </div>
  );
}

/** The box a thread reached, as its chips name it: its address, and who reads it there (none for a box gone unnamed). */
function readerChips(path: string, box: MailBox | undefined, retired: MailArchivedBox | undefined) {
  if (box?.kind === "person") return { address: box.address, reader: box.workspace === null ? "no assistant yet" : "Kinu" };

  if (box !== undefined) return { address: box.address, reader: mailBoxLabel(box) };

  return retired === undefined ? { address: path, reader: null } : { address: retired.address, reader: archivedBoxLabel(retired) };
}

/** A thread's menu: one in Trash is restored; any other is sent to a workspace or deleted. */
function threadMenu(thread: MailThreadSummary, change: (trashed: boolean) => void, hand: () => void): MenuItem[] {
  if (thread.trashedAt !== null) return [{ label: "Restore", icon: <TrayIcon size={15} />, onSelect: () => change(false) }];

  return [
    { label: "Send to a workspace…", icon: <ArrowSquareOutIcon size={15} />, onSelect: hand },
    { label: "Delete", icon: <TrashIcon size={15} />, danger: true, apart: true, onSelect: () => change(true) },
  ];
}

function Reader({ mail, box, retired, owner, drafts, onBack, onChanged }: {
  mail: MailThreadView; box: MailBox | undefined; retired: MailArchivedBox | undefined; owner: string; drafts: boolean; onBack: () => void; onChanged: () => void;
}) {
  const { thread } = mail;
  const messages = mail.messages.filter((message) => message.sendState !== "draft");
  const last = messages.at(-1);
  const [opened, setOpened] = useState<ReadonlyMap<string, boolean>>(new Map());
  const [handing, setHanding] = useState(false);
  const { busy, error, run } = useLabelledStep(onChanged);
  const toggle = (id: string): void => setOpened((previous) => new Map(previous).set(id, !(previous.get(id) ?? id === last?.id)));

  const change = (trashed: boolean): void => run(trashed ? "Deleting" : "Restoring", async () => {
    await updateMailThread(thread.id, { trashed });
    onBack();
  });

  const menu = threadMenu(thread, change, () => setHanding(true));

  const { address, reader } = readerChips(thread.path, box, retired);

  return (
    <article data-mail-reader={thread.id} aria-busy={busy !== null} className="min-w-0 max-w-[var(--layout-reader)] space-y-4">
      <Button variant="ghost" size="sm" className="lg:hidden" data-mail-back onClick={onBack} icon={<CaretLeftIcon size={14} />}>Mail</Button>
      <header className="space-y-2">
        <div className="flex items-start gap-2">
          <h2 data-mail-subject className="t-title min-w-0 flex-1 p-text wrap-anywhere">{thread.subject || "(No subject)"}</h2>
          {busy === null && <Menu name="Thread" items={menu} className="relative shrink-0" />}
        </div>
        <div className="flex flex-wrap gap-2">
          <Chip><span className="truncate t-mono">{address}</span></Chip>
          {reader !== null && <Chip><span className="truncate">{reader}</span></Chip>}
        </div>
      </header>
      {thread.important !== null && <p data-mail-why className="t-body p-text-2">{thread.important}</p>}
      {last !== undefined && !last.verified && <Notice tone="warning" data-mail-unverified-banner>
        {last.from.address.toLowerCase() === owner.toLowerCase() ? "Not verified · claims to be you" : "Not verified"}
      </Notice>}
      {messages.length > 0 && <div className="p-rows-dashed border-y border-dashed p-border-dash">
        {messages.map((message) => <MailMessage key={message.id} mail={message} box={box} owner={owner} open={opened.get(message.id) ?? message.id === last?.id} onToggle={() => toggle(message.id)} />)}
      </div>}
      {error !== null && <p role="alert" className="t-body p-danger">{error}</p>}
      {box !== undefined && thread.trashedAt === null && (last?.verified !== false || thread.draft) && <ReplyBox mail={mail} box={box} drafts={drafts} onChanged={onChanged} onSent={drafts ? onBack : () => undefined} />}
      {handing && <SendToWorkspace thread={thread.id} onClose={() => setHanding(false)} />}
    </article>
  );
}

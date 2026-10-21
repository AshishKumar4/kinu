import { useCallback, useEffect, useState } from "react";
import { Loader } from "@/components/ui/Loader";
import { ArrowSquareOutIcon, CaretLeftIcon, ShieldWarningIcon, TrashIcon, TrayIcon } from "@phosphor-icons/react";
import type { MailBox, MailThreadSummary, MailThreadView } from "@kinu.run/core";
import { Menu, type MenuItem } from "@/components/ui/Menu";
import { LoadFailure } from "@/components/ui/LoadFailure";
import { useLabelledStep } from "@/components/ui/ConfirmDialog";
import { lastValue, useAsyncResource } from "@/hooks/use-async-resource";
import { readMailThread, updateMailThread } from "@/lib/mail-api";
import { MailMessage } from "./MailMessage";
import { ReplyBox } from "./MailEditor";
import { mailBoxLabel } from "./MailRow";
import { SendToWorkspace } from "./SendToWorkspace";

export function MailThreadReader({ id, boxes, owner, drafts, onBack, onChanged }: {
  id: string; boxes: readonly MailBox[]; owner: string; drafts: boolean; onBack: () => void; onChanged: () => void;
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
      {mail === null && <button type="button" data-mail-back onClick={onBack} className="t-meta mb-3 flex items-center gap-1 p-text-3 hover:p-text lg:hidden"><CaretLeftIcon size={13} />Mail</button>}
      {resource.status === "loading" && <div role="status" aria-label="Loading thread"><Loader /></div>}
      {resource.status === "error" && <LoadFailure what="this thread" message={resource.message} onRetry={reload} />}
      {mail !== null && <Reader key={`${id}:${String(drafts)}`} mail={mail} box={boxes.find((box) => box.path === mail.thread.path)} owner={owner} drafts={drafts} onBack={onBack} onChanged={reload} />}
    </div>
  );
}

/** A thread's menu: one in Trash is restored; any other is sent to a workspace or deleted. */
function threadMenu(thread: MailThreadSummary, change: (trashed: boolean) => void, hand: () => void): MenuItem[] {
  if (thread.trashedAt !== null) return [{ label: "Restore", icon: <TrayIcon size={15} />, onSelect: () => change(false) }];

  return [
    { label: "Send to a workspace…", icon: <ArrowSquareOutIcon size={15} />, onSelect: hand },
    { label: "Delete", icon: <TrashIcon size={15} />, danger: true, apart: true, onSelect: () => change(true) },
  ];
}

function Reader({ mail, box, owner, drafts, onBack, onChanged }: {
  mail: MailThreadView; box: MailBox | undefined; owner: string; drafts: boolean; onBack: () => void; onChanged: () => void;
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

  let reader = box === undefined ? "" : mailBoxLabel(box);

  if (box?.kind === "person") reader = box.workspace === null ? "no assistant yet" : "Kinu";

  return (
    <article data-mail-reader={thread.id} aria-busy={busy !== null} className="min-w-0 max-w-[760px] space-y-4">
      <button type="button" data-mail-back onClick={onBack} className="t-meta flex items-center gap-1 p-text-3 hover:p-text lg:hidden"><CaretLeftIcon size={13} />Mail</button>
      <header className="space-y-2">
        <div className="flex items-start gap-2">
          <h2 data-mail-subject className="t-title min-w-0 flex-1 p-text [overflow-wrap:anywhere]">{thread.subject || "(No subject)"}</h2>
          {busy === null && <Menu name="Thread" items={menu} className="relative shrink-0" />}
        </div>
        <div className="flex flex-wrap gap-2">
          <span className="t-meta t-mono inline-flex h-6 max-w-full items-center truncate rounded-full bg-[var(--c-hover)] px-2 p-text-2">{box?.address ?? thread.path}</span>
          {box !== undefined && <span className="t-meta inline-flex h-6 max-w-full items-center truncate rounded-full bg-[var(--c-hover)] px-2 p-text-2">{reader}</span>}
        </div>
      </header>
      {thread.important !== null && <p data-mail-why className="t-body p-text-2">{thread.important}</p>}
      {last !== undefined && !last.verified && <p data-mail-unverified-banner className="t-body flex items-center gap-2 rounded-lg bg-[var(--c-warning-tint)] px-3 py-2 p-text">
        <ShieldWarningIcon size={15} weight="fill" className="shrink-0 p-warning" />
        {last.from.address.toLowerCase() === owner.toLowerCase() ? "Not verified · claims to be you" : "Not verified"}
      </p>}
      {messages.length > 0 && <div className="divide-y divide-dashed divide-[var(--c-dash)] border-y border-dashed border-[var(--c-dash)]">
        {messages.map((message) => <MailMessage key={message.id} mail={message} box={box} owner={owner} open={opened.get(message.id) ?? message.id === last?.id} onToggle={() => toggle(message.id)} />)}
      </div>}
      {error !== null && <p role="alert" className="t-body p-danger">{error}</p>}
      {box !== undefined && thread.trashedAt === null && (last?.verified !== false || thread.draft) && <ReplyBox mail={mail} box={box} drafts={drafts} onChanged={onChanged} onSent={drafts ? onBack : () => undefined} />}
      {handing && <SendToWorkspace thread={thread.id} onClose={() => setHanding(false)} />}
    </article>
  );
}

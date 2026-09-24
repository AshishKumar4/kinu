import { useState } from "react";
import { Link } from "react-router-dom";
import { CaretLeftIcon, EyeIcon, FilesIcon, FileTextIcon, FolderSimpleIcon, GitForkIcon, XIcon } from "@phosphor-icons/react";
import { FilledButton } from "@/components/ui/FilledButton";
import { Segmented } from "@/components/ui/Segmented";
import { TileMenu } from "@/components/drive/DriveTiles";
import type { Person } from "./tiles";

function UserTurn({ text }: { text: string }) {
  return (
    <div className="flex justify-end">
      <p className="max-w-[85%] rounded-2xl rounded-br-[4px] p-user-bubble px-4 py-2.5 p-t-chat">{text}</p>
    </div>
  );
}

function ToolLine({ text }: { text: string }) {
  return (
    <p className="flex items-center gap-2 p-meta p-text-3">
      <FilesIcon size={14} className="shrink-0" /> {text}
    </p>
  );
}

function Transcript() {
  return (
    <div className="mx-auto max-w-2xl space-y-6 px-4 py-8 sm:px-6">
      <UserTurn text="Turn the notes in /shared/notes/launch into a one-page Q3 launch plan, and list the open risks." />
      <div className="space-y-3">
        <ToolLine text="Read 4 files in notes/launch" />
        <div className="prose-chat">
          <p>Here is the plan. It is also in <code className="p-code-inline">plan.md</code>.</p>
          <p><strong>Goal.</strong> Self-serve checkout in every EU store by 30 September.</p>
          <ul>
            <li>9 Sep: pricing page and coupon rules frozen</li>
            <li>16 Sep: payments in SEK and NOK</li>
            <li>23 Sep: 10% of EU traffic</li>
            <li>30 Sep: every EU store</li>
          </ul>
          <p><strong>Open risks.</strong> VAT invoices for Norway are still made by hand; the coupon guard fix has to land before 16 Sep; support has no runbook for failed payouts.</p>
        </div>
      </div>
      <UserTurn text="Give each risk an owner." />
      <div className="space-y-3">
        <ToolLine text="Edited plan.md" />
        <div className="prose-chat">
          <p>Done. Maya owns the VAT invoices, Sam the coupon guard, and Priya the payouts runbook. Each has a date in the plan.</p>
        </div>
      </div>
    </div>
  );
}

const FILES = [
  { name: "plan.md", depth: 0, folder: false, meta: "3 KB · 3d" },
  { name: "notes", depth: 0, folder: true, meta: "" },
  { name: "launch", depth: 1, folder: true, meta: "" },
  { name: "brief.md", depth: 2, folder: false, meta: "2 KB" },
  { name: "pricing.md", depth: 2, folder: false, meta: "4 KB" },
  { name: "risks.md", depth: 2, folder: false, meta: "1 KB" },
  { name: "timeline.md", depth: 2, folder: false, meta: "2 KB" },
];

function FileList() {
  return (
    <ul className="px-2 py-2">
      {FILES.map((file) => (
        <li key={`${String(file.depth)}:${file.name}`} style={{ paddingLeft: `${String(10 + file.depth * 16)}px` }}
          className="flex items-center gap-2 rounded-lg py-1.5 pr-3 transition-colors hover:bg-[var(--c-elevated)]">
          {file.folder
            ? <FolderSimpleIcon size={15} weight="fill" className="shrink-0 p-info" />
            : <FileTextIcon size={15} className="shrink-0 p-text-3" />}
          <span className="min-w-0 flex-1 truncate p-row-text p-text-2">{file.name}</span>
          <span className="shrink-0 p-meta p-text-4">{file.meta}</span>
        </li>
      ))}
    </ul>
  );
}

export function SharedWorkspaceView({ title, owner }: { title: string; owner: Person }) {
  const [tab, setTab] = useState<"chat" | "files">("chat");

  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="flex h-14 shrink-0 items-center gap-2 border-b p-border pl-2 pr-3 sm:pl-3 sm:pr-4">
        <Link to="/shared" aria-label="Back to Shared"
          className="flex size-8 shrink-0 items-center justify-center rounded-md p-text-3 transition-colors hover:bg-[var(--c-elevated)] hover:p-text">
          <CaretLeftIcon size={16} />
        </Link>
        <h1 className="min-w-0 truncate p-heading text-[17px] p-text">{title}</h1>
        <span className="ml-1 flex shrink-0 items-center gap-1.5 p-meta p-text-3" title={`Shared by ${owner.name}`}>
          <span aria-hidden="true" className="flex size-5 items-center justify-center rounded-full p-fill text-[10px] font-semibold p-text-2">{owner.name.charAt(0)}</span>
          <span className="hidden sm:inline">{owner.name}</span>
        </span>
        <span className="ml-1 shrink-0 rounded-full px-2 p-badge-neutral">View only</span>
        <div className="relative ml-auto size-7 shrink-0">
          <TileMenu name={title} className="right-0 top-0"
            items={[{ label: "Remove from Drive", icon: <XIcon size={15} />, onSelect: () => undefined }]} />
        </div>
      </header>

      <div className="flex min-h-0 flex-1">
        <section aria-label="Chat" className="flex min-w-0 flex-1 flex-col">
          <div className="border-b p-border px-4 py-2 lg:hidden">
            <div className="w-fit">
              <Segmented label="Show" value={tab} onChange={setTab} segments={[{ id: "chat", label: "Chat" }, { id: "files", label: "Files" }]} />
            </div>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto">
            <div className={tab === "files" ? "hidden lg:block" : ""}><Transcript /></div>
            {tab === "files" && <div className="lg:hidden"><FileList /></div>}
          </div>
          <footer className="px-4 pb-4 pt-2 sm:px-6">
            <div className="mx-auto flex max-w-2xl items-center gap-3 rounded-[14px] border p-border p-surface py-2.5 pl-4 pr-2.5">
              <EyeIcon size={16} className="shrink-0 p-text-3" />
              <p className="min-w-0 flex-1 p-row-text p-text-2">
                <span className="hidden sm:inline">You're reading {owner.name}'s workspace. </span>Fork it to continue in a workspace of your own.
              </p>
              <FilledButton className="h-8 gap-1.5 px-3 text-sm"><GitForkIcon size={14} weight="bold" /> Fork</FilledButton>
            </div>
          </footer>
        </section>

        <aside aria-label="Files" className="hidden w-[320px] shrink-0 flex-col border-l p-border lg:flex">
          <div className="flex h-[45px] shrink-0 items-end border-b p-border px-3">
            <span className="p-tab p-tab-active -mb-px flex items-center gap-1.5 px-2.5 py-[12px] p-t-control">Files</span>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto"><FileList /></div>
          <p className="border-t p-border px-4 py-3 p-meta p-text-4">Read only. A fork gets its own copy.</p>
        </aside>
      </div>
    </div>
  );
}

import { useEffect, useMemo, useRef, useState } from "react";
import { CaretDownIcon, XIcon } from "@phosphor-icons/react";
import { Segmented } from "@/components/ui/Segmented";
import { ChangeMark, Counts, folderOf, nameOf, reading, type ChangedFile, type ChangeSet } from "./diff";
import { FileBody } from "./ChangesPanel";
import { FileTree, IconButton, MarkReviewed, Since, Summary, typing } from "./parts";

type Layout = "unified" | "split";

function FileCard({ file, git, split, register }: {
  file: ChangedFile;
  git: boolean;
  split: boolean;
  register: (path: string, element: HTMLElement | null) => void;
}) {
  const [folded, setFolded] = useState(false);

  return (
    <section ref={(element) => register(file.path, element)} data-file-card={file.path} aria-label={file.path}
      className="scroll-mt-3 overflow-clip rounded-xl border p-border p-sidebar">
      <header className={`sticky top-0 z-[1] flex h-10 items-center gap-2 p-sidebar pl-2 pr-3.5 ${folded ? "" : "border-b p-border"}`}>
        <IconButton label={folded ? `Show ${file.path}` : `Fold ${file.path}`} onClick={() => setFolded((value) => !value)}>
          <CaretDownIcon size={12} className={`transition-transform ${folded ? "-rotate-90" : ""}`} />
        </IconButton>
        <ChangeMark status={file.status} />
        <span className="shrink-0 p-row-text font-medium p-text">{nameOf(file.path)}</span>
        <span className="min-w-0 truncate p-meta p-text-3">{folderOf(file.path)}</span>
        <Counts added={file.added} removed={file.removed} className="ml-auto pl-2" />
      </header>
      {!folded && <FileBody file={file} git={git} stacked split={split} onOpenInFiles={() => {}} />}
    </section>
  );
}

export function ReviewSheet({ set, now, file, layout: initialLayout = "unified", onClose, onReviewed }: {
  set: ChangeSet;
  now: number;
  file: string | null;
  layout?: Layout;
  onClose: () => void;
  onReviewed: () => void;
}) {
  const [layout, setLayout] = useState<Layout>(initialLayout);
  const files = useMemo(() => reading(set.files), [set]);
  const [current, setCurrent] = useState<string | null>(file ?? files[0]?.path ?? null);
  const cards = useRef(new Map<string, HTMLElement>());
  const stack = useRef<HTMLDivElement>(null);

  const register = (path: string, element: HTMLElement | null): void => {
    if (element === null) cards.current.delete(path);
    else cards.current.set(path, element);
  };

  const show = (path: string, smooth: boolean): void => {
    setCurrent(path);
    cards.current.get(path)?.scrollIntoView({ block: "start", behavior: smooth ? "smooth" : "instant" });
  };

  useEffect(() => {
    if (file !== null) cards.current.get(file)?.scrollIntoView({ block: "start", behavior: "instant" });
  }, [file]);

  // The file whose card has reached the top of the stack is the one being read.
  const follow = (): void => {
    const top = stack.current?.getBoundingClientRect().top ?? 0;
    let reached = files[0]?.path ?? null;

    for (const each of files) {
      const card = cards.current.get(each.path);

      if (card !== undefined && card.getBoundingClientRect().top - top <= 24) reached = each.path;
    }

    setCurrent(reached);
  };

  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.metaKey || event.ctrlKey || event.altKey || typing(event.target)) return;

      const at = files.findIndex((each) => each.path === current);
      const target = event.key === "j" ? files[at + 1] : files[at - 1];

      if (event.key === "Escape") onClose();
      else if ((event.key === "j" || event.key === "k") && target !== undefined) show(target.path, true);
      else return;

      event.preventDefault();
    };

    window.addEventListener("keydown", onKey);

    return () => window.removeEventListener("keydown", onKey);
  });

  return (
    <div className="fixed inset-0 z-50 animate-fade-in max-md:hidden" role="dialog" aria-modal="true" aria-label="Changes" data-review-sheet>
      <div className="p-scrim absolute inset-0" onClick={onClose} aria-hidden="true" />
      <div className="absolute inset-3 flex flex-col overflow-hidden rounded-2xl border p-border p-bg p-shadow-overlay">
        <header className="flex h-14 shrink-0 items-center gap-3 border-b p-border p-sidebar pl-5 pr-3">
          <Summary set={set} />
          <span className="p-meta p-text-3"><Since set={set} now={now} /></span>
          <div className="ml-auto flex items-center gap-2">
            <Segmented label="Layout" value={layout} onChange={setLayout}
              segments={[{ id: "unified", label: "Unified" }, { id: "split", label: "Split" }]} />
            {set.mode === "vfs-baseline" && <MarkReviewed onClick={onReviewed} />}
            <IconButton label="Close (Esc)" onClick={onClose}><XIcon size={15} /></IconButton>
          </div>
        </header>
        <div className="flex min-h-0 flex-1">
          <nav aria-label="Changed files" className="w-64 shrink-0 overflow-y-auto border-r p-border p-sidebar">
            <FileTree files={files} current={current} onOpen={(path) => show(path, true)} />
          </nav>
          <div ref={stack} onScroll={follow} className="min-w-0 flex-1 overflow-y-auto" data-review-stack>
            <div className="space-y-4 px-5 py-4">
              {files.map((each) => <FileCard key={each.path} file={each} git={set.mode === "git"} split={layout === "split"} register={register} />)}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

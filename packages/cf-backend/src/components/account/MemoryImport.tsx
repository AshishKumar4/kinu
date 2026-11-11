/**
 * What a person brings into their account's memory, in one place for onboarding and Settings → Memory: what another AI
 * remembers of them (a prompt to copy, its answer pasted back), a file they wrote, or the data export ChatGPT or Claude
 * made of their conversations. An export is read here, in their browser: only their own words leave it, dated and oldest
 * first (`import-sources.ts`). Each import is read by the account's fast model into a batch of facts they keep in one act.
 */
import { useRef, useState } from "react";
import { Effect } from "effect";
import { ANOTHER_AI_PROMPT, IMPORT_CARRIED_CHARS, readExport, type ExportPieces } from "@kinu.run/core";
import { attempt, detach, renderThrownChain } from "@kinu.run/core/obs";
import { accountDocumentText, importAccountMemory } from "../../lib/user-api";
import { Button } from "@/components/ui/Button";
import { CopyButton } from "@/components/ui/CopyButton";
import { FilePicker } from "@/components/ui/FilePicker";
import { Segmented } from "@/components/ui/Segmented";
import { TextArea } from "@/components/ui/Field";
import { Surface } from "@/components/ui/Surface";

type Source = "ai" | "file" | "export";

const SOURCES = [
  { id: "ai", label: "From another AI" },
  { id: "file", label: "A file" },
  { id: "export", label: "An AI export" },
] as const;

/** Files the browser reads as text; any other (a PDF, an office document) the platform converts first. */
const TEXT_FILE = /\.(md|markdown|txt|json)$/iu;

const count = (n: number): string => n.toLocaleString("en-US");

/** What is ready to import, and the line the person reads before they do. */
type Ready = { readonly source: { document: string } | { conversations: string[] }; readonly preview: string } | null;

function exportPreview(read: ExportPieces): string {
  const scope = read.read === read.conversations
    ? `${count(read.conversations)} conversations`
    : `the newest ${count(read.read)} of your ${count(read.conversations)} conversations (one import carries at most ${count(IMPORT_CARRIED_CHARS)} characters)`;

  return `About ${count(read.pieces.length)} pieces from ${scope}: ${count(read.chars)} characters of your own words.`;
}

const documentPreview = (text: string): string => `${count(text.trim().length)} characters, kept as notes your agents can search.`;

/** One thing done at a time, said while it runs, its failure kept in its own words: `act`'s effect does it. */
export function useActing(after?: () => void) {
  const [busy, setBusy] = useState<{ readonly what: string } | null>(null);
  const [failure, setFailure] = useState<string | null>(null);

  const act = (what: string, run: () => Promise<void>): Effect.Effect<void> => Effect.sync(() => {
    setBusy({ what });
    setFailure(null);
  }).pipe(
    Effect.andThen(attempt({ doing: what, otherwise: "io" }, run)),
    Effect.tap(() => Effect.sync(() => after?.())),
    Effect.catch((failed) => Effect.sync(() => { setFailure(renderThrownChain({ cause: failed })); })),
    Effect.ensuring(Effect.sync(() => { setBusy(null); })),
  );

  return { busy, failure, act };
}

/** The three ways in, and Import. `onImported` hears the import's id once it is filed; `onCancel`, where shown, closes it. */
export function MemoryImport({ onImported, onCancel }: {
  readonly onImported: (id: string) => void;
  readonly onCancel?: () => void;
}) {
  const acting = useActing();
  const busy = acting.busy !== null;
  const { failure } = acting;
  const [source, setSource] = useState<Source>("ai");
  const [text, setText] = useState("");
  const [ready, setReady] = useState<Ready>(null);
  const filePicker = useRef<HTMLInputElement>(null);
  const exportPicker = useRef<HTMLInputElement>(null);

  const typed = (value: string) => {
    setText(value);
    setReady(value.trim() === "" ? null : { source: { document: value }, preview: documentPreview(value) });
  };

  return (
    <div className="space-y-3" data-memory-import={source}>
      {/* Held while a file is read, so its text can only land in the tab it was chosen in. */}
      <Segmented label="What to import" segments={SOURCES} value={source} size="sm" disabled={busy}
        onChange={(next) => { setSource(next); setText(""); setReady(null); }} />

      {source === "ai" && (
        <div className="space-y-2">
          <p className="t-meta p-text-3">Ask the AI you use now what it remembers about you, then paste its answer here.</p>
          <Surface look="tile" className="px-3 py-2 flex items-start gap-2">
            <p className="t-body p-text-2 flex-1 min-w-0" data-memory-import-prompt>{ANOTHER_AI_PROMPT}</p>
            <CopyButton value={ANOTHER_AI_PROMPT} what="the prompt" />
          </Surface>
          <TextArea rows={6} aria-label="What the other AI answered" placeholder="Paste its answer" value={text} onChange={(event) => typed(event.target.value)} />
        </div>
      )}

      {source === "file" && (
        <div className="space-y-2">
          <p className="t-meta p-text-3">Notes about yourself, in Markdown, text, JSON or a PDF. Its text is kept as notes your agents can search.</p>
          <FilePicker ref={filePicker} accept=".md,.markdown,.txt,.json,.pdf,text/plain,text/markdown,application/json,application/pdf"
            onChange={(event) => detach(acting.act("reading this file", async () => {
              const file = event.target.files?.[0];

              if (file === undefined) return;
              typed(TEXT_FILE.test(file.name) ? await file.text() : (await accountDocumentText(file)).text);
            }))} />
          <Button size="sm" disabled={busy} onClick={() => filePicker.current?.click()}>Choose a file</Button>
          {text !== "" && <TextArea rows={6} aria-label="The file's text" value={text} onChange={(event) => typed(event.target.value)} />}
        </div>
      )}

      {source === "export" && (
        <div className="space-y-2">
          <p className="t-meta p-text-3">
            The zip ChatGPT or Claude sends when you export your data. It is read here, on your device: only what you wrote leaves it.
          </p>
          <FilePicker ref={exportPicker} accept=".zip,.json,application/zip,application/json"
            onChange={(event) => detach(acting.act("reading your export", async () => {
              const file = event.target.files?.[0];

              if (file === undefined) return;

              const read = await readExport({ size: file.size, read: async (offset, length) => new Uint8Array(await file.slice(offset, offset + length).arrayBuffer()) },
                !file.name.toLowerCase().endsWith(".json"));

              setReady(read.pieces.length === 0 ? null : { source: { conversations: [...read.pieces] }, preview: exportPreview(read) });
            }))} />
          <Button size="sm" disabled={busy} onClick={() => exportPicker.current?.click()}>Choose the export</Button>
        </div>
      )}

      {failure !== null && <p className="t-meta p-danger">{failure}</p>}
      {ready !== null && <p className="t-meta p-text-2" data-memory-import-preview>{ready.preview}</p>}
      <div className="flex flex-wrap gap-2">
        <Button variant="primary" size="sm" disabled={busy || ready === null}
          onClick={() => detach(acting.act("importing", async () => {
            if (ready !== null) onImported((await importAccountMemory(ready.source)).id);
          }))}>Import</Button>
        {onCancel !== undefined && <Button variant="ghost" size="sm" onClick={onCancel}>Cancel</Button>}
      </div>
    </div>
  );
}


import { useEffect, useRef, useState } from "react";
import { ClockCounterClockwiseIcon, SealCheckIcon } from "@phosphor-icons/react";
import { Effect } from "effect";
import * as v from "valibot";
import { JsonValueSchema, type AccountMemoryProposal, type JsonValue } from "@kinu.run/core";
import { attempt, detach, renderThrownChain, tolerate } from "@kinu.run/core/obs";
import { Card } from "@/components/ui/Card";
import { CardSlot } from "@/components/ui/CardSlot";
import { useWorkspaceRoster } from "@/hooks/use-workspace-roster";
import { useAsyncResource } from "@/hooks/use-async-resource";
import {
  forgetAccountFact, forgetAccountNote, getAccountMemory, importAccountMemory, putAccountFact, retryAccountImport,
  type AccountMemoryState, type KeptImportFact,
} from "../../lib/user-api";
import { Button } from "@/components/ui/Button";
import { Checkbox } from "@/components/ui/Check";
import { FilePicker } from "@/components/ui/FilePicker";
import { Group } from "@/components/ui/Group";
import { Meter, ProgressBar } from "@/components/ui/Meter";
import { Notice } from "@/components/ui/Notice";
import { TextArea, TextInput } from "@/components/ui/Field";
import { MemoryFact, MemoryProvenance, MemoryValue } from "@/components/MemoryFact";

/** Editing keeps JSON values structured and strings literal. */
function editableValueText(value: JsonValue): string {
  return typeof value === "string" ? value : JSON.stringify(value);
}

/**
 * The edited text as the value it replaces: words for a string, JSON for anything else, so editing a number or a flag
 * keeps its type. Undefined when JSON was expected and the text is not JSON.
 */
function editedValue(was: JsonValue, text: string): JsonValue | undefined {
  if (typeof was === "string") return text;
  const parsed = v.safeParse(JsonValueSchema, tolerate(() => JSON.parse(text), "malformed-input"));

  return parsed.success ? parsed.output : undefined;
}

type Busy = { readonly what: string } | null;

type Decide = (id: string, decision: "accept" | "decline", facts?: KeptImportFact[]) => Promise<void>;

const count = (n: number): string => n.toLocaleString("en-US");

/** Settings → Memory: what every workspace and agent of the account reads, what waits on the owner, and every revision. */
export function AccountMemoryCard() {
  const { resource, reload } = useAsyncResource(getAccountMemory);
  // What waits is the account socket's newest, the list the attention stack shows; a proposal decided anywhere can keep
  // a fact or a note, so each frame reads the whole memory again.
  const { accountProposals, decideAccountProposal } = useWorkspaceRoster();
  const framed = useRef(accountProposals);

  useEffect(() => {
    if (framed.current === accountProposals) return;
    framed.current = accountProposals;
    reload();
  }, [accountProposals, reload]);
  const [busy, setBusy] = useState<Busy>(null);
  const [failure, setFailure] = useState<string | null>(null);
  // The facts chosen to import as one document; null when none are being chosen.
  const [selected, setSelected] = useState<ReadonlySet<string> | null>(null);
  const [composing, setComposing] = useState(false);

  /** One change to the account's memory, as an effect each control detaches on its press. */
  const act = (what: string, run: () => Promise<void>) => Effect.sync(() => {
    setBusy({ what });
    setFailure(null);
  }).pipe(
    Effect.andThen(attempt({ doing: what, otherwise: "io" }, run)),
    Effect.tap(() => Effect.sync(reload)),
    Effect.catch((failed) => Effect.sync(() => { setFailure(renderThrownChain({ cause: failed })); })),
    Effect.ensuring(Effect.sync(() => { setBusy(null); })),
  );

  return (
    <Card title="Account memory">
      <CardSlot resource={resource} what="your account memory" onRetry={reload}>
        {(state) => (
          <div className="space-y-4" data-account-memory>
            {failure !== null && <div className="t-meta p-danger">{failure}</div>}
            <Profile state={state} onImportUnshown={() => setSelected(new Set(state.profile.unshown.map((fact) => fact.key)))} />
            <Imports state={state} busy={busy} act={act} decide={decideAccountProposal} />
            <Pending pending={accountProposals ?? state.pending} busy={busy} act={act} decide={decideAccountProposal} />
            {composing && <ImportDocument busy={busy} act={act} onDone={() => setComposing(false)} />}
            <Facts state={state} busy={busy} act={act} selected={selected} select={setSelected} compose={composing ? null : () => setComposing(true)} />
            <Notes state={state} busy={busy} act={act} />
          </div>
        )}
      </CardSlot>
    </Card>
  );
}

interface SectionProps {
  readonly state: AccountMemoryState;
  readonly busy: Busy;
  readonly act: (what: string, run: () => Promise<void>) => Effect.Effect<void>;
}

/** What every agent reads of the account's facts, against its budget, and the facts too long to be among them. */
function Profile({ state, onImportUnshown }: { readonly state: AccountMemoryState; readonly onImportUnshown: () => void }) {
  const { used, budget, unshown } = state.profile;

  if (state.facts.length === 0) return null;

  return (
    <section className="space-y-2" data-account-memory-profile>
      <Meter label="What every agent reads in each turn" value={Math.round((used / budget) * 100)} shown={`${count(used)} of ${count(budget)} characters`} />
      {unshown.length > 0 && (
        <Notice tone="warning" data-account-memory-unshown={String(unshown.length)}
          action={<Button size="sm" onClick={onImportUnshown}>Import as notes and facts</Button>}>
          {unshown.length === 1 ? "1 fact is" : `${count(unshown.length)} facts are`} too long for your agents to read in each turn.
          Importing reads long facts into short ones and keeps their text as notes your agents can search.
        </Notice>
      )}
    </section>
  );
}

/** Imports still reading their document, or stopped on a failure, in its provider's words. */
function Imports({ state, busy, act, decide }: SectionProps & { readonly decide: Decide }) {
  if (state.imports.length === 0) return null;

  return (
    <section className="space-y-2" data-account-memory-imports>
      <div className="t-label">Importing</div>
      <Group>
      {state.imports.map((each) => (
        <div key={each.id} className="px-3 py-2 space-y-2" data-account-memory-import={each.id}>
          <div className="t-body p-text">
            {each.parked ? "Stopped at" : "Reading"} part {count(Math.min(each.read + 1, each.pieces))} of {count(each.pieces)} · {count(each.facts)} facts so far
          </div>
          {!each.parked && <ProgressBar value={each.read} max={each.pieces} label="How much of the document is read" />}
          {each.failure !== null && <div className={`t-meta ${each.parked ? "p-danger" : "p-text-3"}`}>{each.parked ? each.failure : `Trying again shortly: ${each.failure}`}</div>}
          <div className="flex flex-wrap gap-2">
            {each.parked && (
              <Button variant="primary" size="sm" disabled={busy !== null}
                onClick={() => detach(act("retrying this import", async () => { await retryAccountImport(each.id); }))}>Retry</Button>
            )}
            <Button size="sm" disabled={busy !== null} onClick={() => detach(act("discarding this import", () => decide(each.id, "decline")))}>Discard</Button>
          </div>
        </div>
      ))}
      </Group>
    </section>
  );
}

/** A document pasted or chosen, to import. */
function ImportDocument({ busy, act, onDone }: Omit<SectionProps, "state"> & { readonly onDone: () => void }) {
  const [text, setText] = useState("");
  const picker = useRef<HTMLInputElement>(null);

  return (
    <section className="space-y-2" data-account-memory-import-document>
      <div className="t-label">Import a document</div>
      <div className="t-meta p-text-3">
        What every agent of yours should know about you. Its text is kept as notes your agents can search, and read into short facts you review before they are kept.
      </div>
      <TextArea rows={8} aria-label="Document to import" value={text} onChange={(event) => setText(event.target.value)} />
      <FilePicker ref={picker} accept=".md,.txt,.json,text/plain,text/markdown,application/json" onChange={(event) => detach(act("reading this file", async () => {
        const file = event.target.files?.[0];

        if (file !== undefined) setText(await file.text());
      }))} />
      <div className="flex flex-wrap gap-2">
        <Button variant="primary" size="sm" disabled={busy !== null || text.trim() === ""}
          onClick={() => detach(act("importing this document", async () => {
            await importAccountMemory({ document: text });
            onDone();
          }))}>Import</Button>
        <Button size="sm" disabled={busy !== null} onClick={() => picker.current?.click()}>Choose a file</Button>
        <Button variant="ghost" size="sm" onClick={onDone}>Cancel</Button>
      </div>
    </section>
  );
}

/** An import's facts as the owner keeps them: each value editable, each removable, all kept in one act. */
function ImportBatch({ item, busy, act, decide }: Omit<SectionProps, "state"> & {
  readonly item: AccountMemoryProposal & { readonly proposal: { readonly kind: "import" } };
  readonly decide: Decide;
}) {
  const { proposal } = item;
  const [rows, setRows] = useState(() => proposal.facts.map((fact) => ({ ...fact, text: editableValueText(fact.value), invalid: false })));

  /** Keeps the batch as edited, or marks the values that are not the JSON their fact holds. */
  const keep = (): Effect.Effect<void> => {
    const edited = rows.map((row) => ({ row, value: editedValue(row.value, row.text) }));

    if (edited.some(({ value }) => value === undefined)) return Effect.sync(() => { setRows(edited.map(({ row, value }) => ({ ...row, invalid: value === undefined }))); });

    return act("keeping this import for every workspace", () => decide(item.id, "accept", edited.map(({ row, value }) => ({
      key: row.key, value: value ?? row.value, ...(row.importance !== undefined && { importance: row.importance }),
    }))));
  };

  return (
    <div className="px-3 py-2 space-y-2" data-account-memory-proposal={item.id}>
      <div className="t-body p-text">
        {count(rows.length)} facts read from a document you imported
        {proposal.replaces.length > 0 && `, in place of ${count(proposal.replaces.length)} facts`}
      </div>
      <div className="space-y-1" data-account-memory-batch>
        {rows.map((row, at) => (
          <div key={row.key} className="flex flex-wrap items-center gap-2">
            <span className="t-body t-mono basis-48 shrink-0 wrap-anywhere">{row.key}</span>
            <TextInput size="sm" aria-label={`Value of ${row.key}`} invalid={row.invalid} className="flex-1 min-w-0 basis-48" value={row.text}
              title={row.invalid ? "This fact holds JSON: write a number, true, false, null, a list or an object." : undefined}
              onChange={(event) => setRows(rows.map((each, index) => (index === at ? { ...each, text: event.target.value, invalid: false } : each)))} />
            <Button variant="ghost" size="sm" disabled={busy !== null} onClick={() => setRows(rows.filter((_, index) => index !== at))}>Remove</Button>
          </div>
        ))}
      </div>
      <div className="t-meta p-text-3"><MemoryProvenance origin={item.origin} /></div>
      <div className="flex flex-wrap gap-2">
        <Button variant="primary" size="sm" disabled={busy !== null} onClick={() => detach(keep())}>Keep all for every workspace</Button>
        <Button size="sm" disabled={busy !== null}
          onClick={() => detach(act("declining this import", () => decide(item.id, "decline")))}>Decline</Button>
      </div>
    </div>
  );
}

function Pending({ pending, busy, act, decide }: Omit<SectionProps, "state"> & {
  readonly pending: readonly AccountMemoryProposal[];
  readonly decide: Decide;
}) {
  if (pending.length === 0) return null;

  return (
    <section className="space-y-2" data-account-memory-pending>
      <div className="t-label">Waiting for you</div>
      <Group>
      {pending.map((item) => (item.proposal.kind === "import"
        ? <ImportBatch key={item.id} item={{ ...item, proposal: item.proposal }} busy={busy} act={act} decide={decide} />
        : (
        <div key={item.id} className="px-3 py-2 space-y-1" data-account-memory-proposal={item.id}>
          <div className="t-body p-text break-words">
            {item.proposal.kind === "fact" ? <MemoryFact factKey={item.proposal.key} value={item.proposal.value} /> : item.proposal.content}
          </div>
          <div className="t-meta p-text-3"><MemoryProvenance origin={item.origin} /></div>
          <div className="flex flex-wrap gap-2">
            <Button variant="primary" size="sm" disabled={busy !== null}
              onClick={() => detach(act("keeping this for every workspace", () => decide(item.id, "accept")))}>Keep for every workspace</Button>
            <Button size="sm" disabled={busy !== null}
              onClick={() => detach(act("declining this proposal", () => decide(item.id, "decline")))}>Decline</Button>
          </div>
        </div>
        )))}
      </Group>
    </section>
  );
}

/**
 * The account's facts. Choosing facts imports them as one document, which the batch replaces once kept: those too long to
 * show come chosen, and a key's beginning chooses every fact it starts.
 */
function Facts({ state, busy, act, selected, select, compose }: SectionProps & {
  readonly selected: ReadonlySet<string> | null;
  readonly select: (selected: ReadonlySet<string> | null) => void;
  /** Opens the document import; null while it is open. */
  readonly compose: (() => void) | null;
}) {
  const [editing, setEditing] = useState<{ key: string; text: string; invalid: boolean } | null>(null);
  const [opened, setOpened] = useState<string | null>(null);
  const [prefix, setPrefix] = useState("");
  const unshown = new Map(state.profile.unshown.map((fact) => [fact.key, fact.chars]));

  return (
    <section className="space-y-1" data-account-memory-facts>
      <div className="flex flex-wrap items-center gap-2">
        <div className="t-label">Facts</div>
        {selected === null && (
          <div className="ml-auto flex gap-1">
            {compose !== null && <Button variant="ghost" size="sm" onClick={compose}>Import a document</Button>}
            {state.facts.length > 0 && <Button variant="ghost" size="sm" onClick={() => select(new Set())}>Choose facts to import</Button>}
          </div>
        )}
      </div>
      {selected !== null && (
        <div className="flex flex-wrap items-center gap-2 py-1" data-account-memory-choosing>
          <TextInput size="sm" aria-label="Choose every fact whose key starts with" placeholder="Choose keys starting with…" className="flex-1 min-w-0 basis-48" value={prefix}
            onChange={(event) => {
              setPrefix(event.target.value);

              if (event.target.value !== "") select(new Set(state.facts.filter((fact) => fact.key.startsWith(event.target.value)).map((fact) => fact.key)));
            }} />
          <Button variant="primary" size="sm" disabled={busy !== null || selected.size === 0}
            onClick={() => detach(act("importing these facts", async () => {
              await importAccountMemory({ facts: [...selected] });
              setPrefix("");
              select(null);
            }))}>Import {count(selected.size)} as notes and facts</Button>
          <Button variant="ghost" size="sm" onClick={() => { setPrefix(""); select(null); }}>Cancel</Button>
        </div>
      )}
      {state.facts.length === 0 && <div className="t-meta p-text-3">None yet. A fact an agent proposes, or one you promote from a workspace's world model, appears here once kept.</div>}
      {state.facts.map((fact) => (
        <div key={fact.key} className="py-1 space-y-1" data-account-memory-fact={fact.key}>
          <div className="flex flex-wrap items-start gap-2">
            {selected === null ? <SealCheckIcon size={14} className="p-text-3 shrink-0 mt-px" /> : (
              <Checkbox label={<span className="sr-only">Import {fact.key}</span>} checked={selected.has(fact.key)}
                onChange={(checked) => select(new Set(checked ? [...selected, fact.key] : [...selected].filter((key) => key !== fact.key)))} />
            )}
            <div className="min-w-0 flex-1 basis-48">
              {unshown.has(fact.key) && (
                <div className="t-meta p-warning" data-account-memory-fact-unshown>Too long for your agents to read in each turn: {count(unshown.get(fact.key) ?? 0)} characters</div>
              )}
              {editing?.key === fact.key ? (
                <form className="flex flex-wrap gap-2" onSubmit={(event) => {
                  event.preventDefault();
                  const value = editedValue(fact.value, editing.text);

                  if (value === undefined) {
                    setEditing({ ...editing, invalid: true });

                    return;
                  }

                  detach(act("saving this fact", async () => { await putAccountFact(fact.key, value); }));
                  setEditing(null);
                }}>
                  <span className="t-body t-mono w-full wrap-anywhere">{fact.key}:</span>
                  <TextInput size="sm" aria-label={`Value of ${fact.key}`} invalid={editing.invalid} className="flex-1 min-w-0" value={editing.text}
                    title={editing.invalid ? "This fact holds JSON: write a number, true, false, null, a list or an object." : undefined}
                    onChange={(event) => setEditing({ key: fact.key, text: event.target.value, invalid: false })} />
                  <Button variant="primary" size="sm" type="submit" disabled={busy !== null}>Save</Button>
                </form>
              ) : (
                <MemoryFact factKey={fact.key} value={fact.value} />
              )}
              <div className="t-meta p-text-3"><MemoryProvenance origin={fact.origin} /></div>
            </div>
            <div className="ml-auto flex gap-1 shrink-0">
              <Button variant="ghost" size="sm" icon={<ClockCounterClockwiseIcon size={14} />} aria-expanded={opened === fact.key} onClick={() => setOpened(opened === fact.key ? null : fact.key)} title="Every value it held" aria-label="Every value it held" />
              <Button variant="ghost" size="sm" disabled={busy !== null}
                onClick={() => setEditing({ key: fact.key, text: editableValueText(fact.value), invalid: false })}>Edit</Button>
              <Button variant="danger" size="sm" disabled={busy !== null}
                onClick={() => detach(act("forgetting this fact", async () => { await forgetAccountFact(fact.key); }))}>Forget</Button>
            </div>
          </div>
          {opened === fact.key && (
            <ol className="ml-6 space-y-px" data-account-memory-history={fact.key}>
              {fact.history.map((revision) => (
                <li key={revision.at} className="min-w-0 space-y-1 py-1">
                  <div className="t-meta p-text-3">{new Date(revision.at).toLocaleString()}</div>
                  <div className="t-body p-text-2">{revision.forgotten ? '(forgotten)' : <MemoryValue value={revision.value} />}</div>
                  <div className="t-meta p-text-3"><MemoryProvenance origin={revision.origin} /></div>
                </li>
              ))}
            </ol>
          )}
        </div>
      ))}
    </section>
  );
}

function Notes({ state, busy, act }: SectionProps) {
  if (state.notes.length === 0) return null;

  return (
    <section className="space-y-1" data-account-memory-notes>
      <div className="t-label">Notes</div>
      {state.notes.map((note) => (
        <div key={note.id} className="flex items-start gap-2 py-1">
          <div className="min-w-0 flex-1">
            <div className="t-body p-text whitespace-pre-wrap break-words">{note.content}</div>
            <div className="t-meta p-text-3"><MemoryProvenance origin={note.origin} /></div>
          </div>
          <Button variant="danger" size="sm" className="shrink-0" disabled={busy !== null}
            onClick={() => detach(act("forgetting this note", async () => { await forgetAccountNote(note.id); }))}>Forget</Button>
        </div>
      ))}
    </section>
  );
}

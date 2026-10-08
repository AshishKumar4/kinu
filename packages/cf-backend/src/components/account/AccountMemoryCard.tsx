import { useState } from "react";
import { ClockCounterClockwiseIcon, NotebookIcon, SealCheckIcon } from "@phosphor-icons/react";
import { Effect } from "effect";
import * as v from "valibot";
import { JsonValueSchema, type JsonValue } from "@kinu.run/core";
import { attempt, detach, renderThrownChain, tolerate } from "@kinu.run/core/obs";
import { Card } from "@/components/ui/form";
import { CardSlot } from "@/components/ui/CardSlot";
import { useAsyncResource } from "@/hooks/use-async-resource";
import {
  decideAccountMemory, forgetAccountFact, forgetAccountNote, getAccountMemory, putAccountFact,
  type AccountMemoryState, type MemoryOrigin,
} from "../../lib/user-api";

/** "Said in Research, kept by Kinu" / "You, in Settings": where a value came from, in the owner's words. */
function originText(origin: MemoryOrigin): string {
  if (origin === null) return "Origin not recorded";
  const where = origin.workspace === undefined ? "" : ` in ${origin.workspace}`;

  if (origin.by === "owner") return origin.workspace === undefined ? "You, in Settings" : `You promoted it from ${origin.workspace}`;

  if (origin.by === "agent") return `Said${where}, kept by ${origin.agent ?? "an agent"}`;

  return origin.by === "background" ? `Noticed${where} in your own words` : `Copied${where}`;
}

function valueText(value: JsonValue | null): string {
  if (value === null) return "(forgotten)";

  return typeof value === "string" ? value : JSON.stringify(value);
}

/** Edits a fact's value as text: an object or list when it parses as one, the text itself otherwise. */
function parsedValue(text: string): JsonValue {
  const trimmed = text.trim();

  if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) return trimmed;
  const parsed = v.safeParse(JsonValueSchema, tolerate(() => JSON.parse(trimmed), "malformed-input"));

  return parsed.success ? parsed.output : trimmed;
}

type Busy = { readonly what: string } | null;

/** Settings → Memory: what every workspace and agent of the account reads, what waits on the owner, and every revision. */
export function AccountMemoryCard() {
  const { resource, reload } = useAsyncResource(getAccountMemory);
  const [busy, setBusy] = useState<Busy>(null);
  const [failure, setFailure] = useState<string | null>(null);

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
    <Card title="Account memory" icon={NotebookIcon}
      description="What every workspace and agent of yours reads alongside its own memory. Agents only propose: nothing is kept here until you accept it.">
      <CardSlot resource={resource} what="your account memory" onRetry={reload}>
        {(state) => (
          <div className="space-y-4" data-account-memory>
            {failure !== null && <div className="p-meta p-danger">{failure}</div>}
            <Pending state={state} busy={busy} act={act} />
            <Facts state={state} busy={busy} act={act} />
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

function Pending({ state, busy, act }: SectionProps) {
  if (state.pending.length === 0) return null;

  return (
    <section className="space-y-2" data-account-memory-pending>
      <div className="p-t-label p-text-2">Waiting for you</div>
      {state.pending.map((item) => (
        <div key={item.id} className="rounded-md px-3 py-2 p-elevated space-y-1" data-account-memory-proposal={item.id}>
          <div className="p-row-text p-text break-words">
            {item.proposal.kind === "fact" ? <><span className="font-mono">{item.proposal.key}</span>: {valueText(item.proposal.value)}</> : item.proposal.content}
          </div>
          <div className="p-meta p-text-3">{originText(item.origin)}</div>
          <div className="flex gap-1.5">
            <button type="button" disabled={busy !== null} className="px-2 py-1 rounded-md p-t-control p-accent-fill"
              onClick={() => detach(act("keeping this for every workspace", async () => { await decideAccountMemory(item.id, "accept"); }))}>Keep for every workspace</button>
            <button type="button" disabled={busy !== null} className="px-2 py-1 rounded-md p-t-control p-text-2 p-fill hover:p-text"
              onClick={() => detach(act("declining this proposal", async () => { await decideAccountMemory(item.id, "decline"); }))}>Decline</button>
          </div>
        </div>
      ))}
    </section>
  );
}

function Facts({ state, busy, act }: SectionProps) {
  const [editing, setEditing] = useState<{ key: string; text: string } | null>(null);
  const [opened, setOpened] = useState<string | null>(null);

  return (
    <section className="space-y-1" data-account-memory-facts>
      <div className="p-t-label p-text-2">Facts</div>
      {state.facts.length === 0 && <div className="p-meta p-text-3">None yet. A fact an agent proposes, or one you promote from a workspace's world model, appears here once kept.</div>}
      {state.facts.map((fact) => (
        <div key={fact.key} className="py-1.5 space-y-1" data-account-memory-fact={fact.key}>
          <div className="flex items-start gap-2">
            <SealCheckIcon size={14} className="p-text-3 shrink-0 mt-0.5" />
            <div className="min-w-0 flex-1">
              {editing?.key === fact.key ? (
                <form className="flex gap-1.5" onSubmit={(event) => {
                  event.preventDefault();
                  const text = editing.text;

                  detach(act("saving this fact", async () => { await putAccountFact(fact.key, parsedValue(text)); }));
                  setEditing(null);
                }}>
                  <span className="font-mono p-row-text">{fact.key}:</span>
                  <input aria-label={`Value of ${fact.key}`} className="flex-1 min-w-0 px-1.5 rounded p-fill p-row-text" value={editing.text}
                    onChange={(event) => setEditing({ key: fact.key, text: event.target.value })} />
                  <button type="submit" disabled={busy !== null} className="px-2 rounded-md p-t-control p-accent-fill">Save</button>
                </form>
              ) : (
                <div className="p-row-text p-text break-words"><span className="font-mono">{fact.key}</span>: {valueText(fact.value)}</div>
              )}
              <div className="p-meta p-text-3">{originText(fact.origin)}</div>
            </div>
            <div className="flex gap-1 shrink-0">
              <button type="button" className="px-1.5 rounded p-t-control p-text-2 hover:p-text" aria-expanded={opened === fact.key}
                onClick={() => setOpened(opened === fact.key ? null : fact.key)} title="Every value it held">
                <ClockCounterClockwiseIcon size={14} />
              </button>
              <button type="button" className="px-1.5 rounded p-t-control p-text-2 hover:p-text" disabled={busy !== null}
                onClick={() => setEditing({ key: fact.key, text: valueText(fact.value) })}>Edit</button>
              <button type="button" className="px-1.5 rounded p-t-control p-danger" disabled={busy !== null}
                onClick={() => detach(act("forgetting this fact", async () => { await forgetAccountFact(fact.key); }))}>Forget</button>
            </div>
          </div>
          {opened === fact.key && (
            <ol className="ml-6 space-y-0.5" data-account-memory-history={fact.key}>
              {fact.history.map((revision) => (
                <li key={revision.at} className="p-meta p-text-2">
                  {new Date(revision.at).toLocaleString()}: {valueText(revision.value)} <span className="p-text-3">({originText(revision.origin)})</span>
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
      <div className="p-t-label p-text-2">Notes</div>
      {state.notes.map((note) => (
        <div key={note.id} className="flex items-start gap-2 py-1">
          <div className="min-w-0 flex-1">
            <div className="p-row-text p-text whitespace-pre-wrap break-words">{note.content}</div>
            <div className="p-meta p-text-3">{originText(note.origin)}</div>
          </div>
          <button type="button" className="px-1.5 rounded p-t-control p-danger shrink-0" disabled={busy !== null}
            onClick={() => detach(act("forgetting this note", async () => { await forgetAccountNote(note.id); }))}>Forget</button>
        </div>
      ))}
    </section>
  );
}

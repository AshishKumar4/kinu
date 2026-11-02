import { useEffect, useRef, useState } from "react";
import { ClockCounterClockwiseIcon, SealCheckIcon } from "@phosphor-icons/react";
import { Effect } from "effect";
import * as v from "valibot";
import { JsonValueSchema, type AccountMemoryProposal, type JsonValue } from "@kinu.run/core";
import { attempt, detach, renderThrownChain, tolerate } from "@kinu.run/core/obs";
import { Card } from "@/components/ui/form";
import { CardSlot } from "@/components/ui/CardSlot";
import { useWorkspaceRoster } from "@/hooks/use-workspace-roster";
import { useAsyncResource } from "@/hooks/use-async-resource";
import {
  forgetAccountFact, forgetAccountNote, getAccountMemory, putAccountFact,
  type AccountMemoryState,
} from "../../lib/user-api";
import { Button } from "@/components/ui/Button";
import { Group } from "@/components/ui/Group";
import { TextInput } from "@/components/ui/Field";
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
            <Pending pending={accountProposals ?? state.pending} busy={busy} act={act} decide={decideAccountProposal} />
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

function Pending({ pending, busy, act, decide }: Omit<SectionProps, "state"> & {
  readonly pending: readonly AccountMemoryProposal[];
  readonly decide: (id: string, decision: "accept" | "decline") => Promise<void>;
}) {
  if (pending.length === 0) return null;

  return (
    <section className="space-y-2" data-account-memory-pending>
      <div className="t-label">Waiting for you</div>
      <Group>
      {pending.map((item) => (
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
      ))}
      </Group>
    </section>
  );
}

function Facts({ state, busy, act }: SectionProps) {
  const [editing, setEditing] = useState<{ key: string; text: string; invalid: boolean } | null>(null);
  const [opened, setOpened] = useState<string | null>(null);

  return (
    <section className="space-y-1" data-account-memory-facts>
      <div className="t-label">Facts</div>
      {state.facts.length === 0 && <div className="t-meta p-text-3">None yet. A fact an agent proposes, or one you promote from a workspace's world model, appears here once kept.</div>}
      {state.facts.map((fact) => (
        <div key={fact.key} className="py-1 space-y-1" data-account-memory-fact={fact.key}>
          <div className="flex flex-wrap items-start gap-2">
            <SealCheckIcon size={14} className="p-text-3 shrink-0 mt-px" />
            <div className="min-w-0 flex-1 basis-48">
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

/** The blueprint half of the share dialog; every binding ships unmapped. The live half is `LiveShareForm`. */
import { useCallback, useEffect, useState } from "react";
import { Button, Loader } from "@cloudflare/kumo";
import * as v from "valibot";
import {
  BlueprintInspectionSchema, SlateShareRecordSchema, blueprintPagePath,
  type BlueprintInspection, type Rpc, type SlateAnswer, type SlateShareRecord,
} from "@kinu.run/core";
import { renderThrownChain } from "@kinu.run/core/obs";
import { FilledButton } from "@/components/ui/FilledButton";
import { CopyButton } from "@/components/ui/CopyButton";
import { inputCls } from "@/components/ui/form";
import { SecretWarning } from "@/pages/BlueprintPage";
import { publishBlueprint, revokeShare, type Published } from "@/lib/shared-api";
import { EmailsField, emailsOf, Failure, Lead, StopButton } from "./ShareParts";

const HistorySchema = v.object({ versions: v.array(v.object({ id: v.string() })) });

export function answered<Schema extends v.GenericSchema>(result: SlateAnswer<unknown>, schema: Schema): v.InferOutput<Schema> {
  if (!result.ok) throw new Error(`${result.reason}: ${result.error}`);

  return v.parse(schema, result.value);
}

export interface BlueprintFixture {
  versions: string[];
  inspection: BlueprintInspection;
  shares: SlateShareRecord[];
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-1.5 sm:flex-row sm:items-start sm:gap-3">
      <dt className="shrink-0 p-meta p-text-3 sm:w-24 sm:pt-1.5">{label}</dt>
      <dd className="min-w-0 flex-1">{children}</dd>
    </div>
  );
}

export function BlueprintShareForm({ workspace, slate, rpc, onClose, onBusy, fixture }: {
  workspace: string;
  slate: string;
  rpc: Rpc;
  onClose: () => void;
  /** The dialog owns the busy state so its backdrop stops dismissing mid-write. */
  onBusy: (busy: boolean) => void;
  fixture?: BlueprintFixture;
}) {
  const [versions, setVersions] = useState<string[] | null>(fixture?.versions ?? null);
  const [version, setVersion] = useState<string | null>(fixture?.versions.at(-1) ?? null);
  const [include, setInclude] = useState<Set<string> | null>(null);
  const [inspection, setInspection] = useState<BlueprintInspection | null>(fixture?.inspection ?? null);
  const [shares, setShares] = useState<SlateShareRecord[]>(fixture?.shares ?? []);
  const [emails, setEmails] = useState("");
  const [busy, setBusyState] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [published, setPublished] = useState<Published | null>(null);
  const setBusy = useCallback((next: boolean) => { setBusyState(next); onBusy(next); }, [onBusy]);

  useEffect(() => {
    if (fixture !== undefined) return;
    let live = true;
    const failed = (...rejection: [unknown]): void => { if (live) setErr(renderThrownChain({ cause: rejection[0] })); };

    Promise.all([rpc<SlateAnswer<unknown>>("slate", [{ op: "history", id: slate }]), rpc<SlateAnswer<unknown>>("slate", [{ op: "shares" }])]).then(([history, rows]) => {
      if (!live) return;
      const ids = answered(history, HistorySchema).versions.map((entry) => entry.id);
      setVersions(ids);
      setVersion(ids.at(-1) ?? null);
      setShares(answered(rows, v.array(SlateShareRecordSchema)).filter((share) => share.slate === slate && share.revokedAt === null));
    }).catch(failed);

    return () => { live = false; };
  }, [fixture, rpc, slate]);

  // Every choice re-inspects: the warnings describe exactly the bytes that would ship.
  useEffect(() => {
    if (fixture !== undefined || version === null) return;
    let live = true;
    const failed = (...rejection: [unknown]): void => { if (live) setErr(renderThrownChain({ cause: rejection[0] })); };

    rpc<SlateAnswer<unknown>>("slate", [{ op: "inspect", id: slate, version, include: include === null ? undefined : [...include] }])
      .then((result) => { if (live) setInspection(answered(result, BlueprintInspectionSchema)); })
      .catch(failed);

    return () => { live = false; };
  }, [fixture, rpc, slate, version, include]);

  const topLevel = inspection === null ? [] : [...new Set(inspection.entries.map((entry) => entry.path.split("/")[0] ?? entry.path))];
  const includes = (name: string) => include === null ? true : include.has(name);

  const toggle = (name: string) => {
    if (name === "package.json") return;
    setInclude((previous) => {
      const next = new Set(previous ?? topLevel);

      if (next.has(name)) next.delete(name); else next.add(name);

      return next;
    });
  };

  const publish = useCallback(async () => {
    if (busy || version === null) return;
    setBusy(true);
    setErr(null);

    try {
      setPublished(await publishBlueprint({ workspace, slate, version, include: include === null ? undefined : [...include], emails: emailsOf(emails) }));
    } catch (cause) {
      setErr(renderThrownChain({ cause }));
    } finally {
      setBusy(false);
    }
  }, [busy, version, emails, workspace, slate, include, setBusy]);

  const unshare = useCallback(async (share: string) => {
    setErr(null);

    try {
      await revokeShare({ workspace, share });
      setShares((previous) => previous.filter((row) => row.id !== share));
    } catch (cause) {
      setErr(renderThrownChain({ cause }));
    }
  }, [workspace]);

  if (published !== null) {
    const link = `${location.origin}${blueprintPagePath(published.id)}`;

    return (
      <>
        <div className="space-y-3 text-xs">
          <p className="p-notice-success rounded-md px-3 py-2" data-blueprint-published>Published. Anyone with the link can read it and fork a copy.</p>
          <div className="flex items-center gap-2">
            <a href={blueprintPagePath(published.id)} className="min-w-0 flex-1 break-all font-mono p-accent" target="_blank" rel="noopener noreferrer">{link}</a>
            <CopyButton value={link} what="the blueprint link" className="p-btn-quiet rounded p-1" />
          </div>
          {published.users.length > 0 && <p className="p-text-3">It is in the Drive of {published.users.join(", ")}.</p>}
        </div>
        <div className="flex justify-end"><FilledButton className="h-8 px-4 text-sm" onClick={onClose}>Done</FilledButton></div>
      </>
    );
  }

  return (
    <>
      <div className="space-y-4">
        <Lead>People get their own copy to fork. Nothing of yours comes with it: no connections, chats or data.</Lead>
        {versions === null && err === null && <div className="flex justify-center py-2"><Loader size="sm" /></div>}
        {versions !== null && versions.length === 0 && <div className="p-notice-info rounded-md px-3 py-2 text-xs">Commit this slate first: a blueprint is cut from a committed version.</div>}
        {versions !== null && versions.length > 0 && (
          <dl className="space-y-3">
            <Field label="Version">
              <select value={version ?? ""} onChange={(event) => { setVersion(event.target.value); setInclude(null); }} className={inputCls} disabled={busy}>
                {versions.map((id, index) => <option key={id} value={id}>{index === versions.length - 1 ? `${id} (latest)` : id}</option>)}
              </select>
            </Field>
            {inspection !== null && (
              <Field label="Includes">
                <span className="flex flex-wrap gap-1.5">
                  {topLevel.map((name) => (
                    <label key={name} className={`inline-flex items-center gap-1.5 rounded-md border px-2 py-1 text-xs ${includes(name) ? "p-border p-text" : "border-dashed p-border p-text-3"}`}>
                      <input type="checkbox" checked={includes(name)} onChange={() => toggle(name)} disabled={busy || name === "package.json"} className="accent-[var(--c-accent)]" />
                      <span className="font-mono">{name}</span>
                    </label>
                  ))}
                </span>
              </Field>
            )}
            {inspection !== null && inspection.credentialed.length > 0 && (
              <Field label="They connect">
                <span className="block pt-1.5 p-meta p-text-2" data-blueprint-connect>
                  Their own {inspection.credentialed.map((binding) => binding.name).join(", ")}, when they fork it.
                </span>
              </Field>
            )}
          </dl>
        )}
        {inspection !== null && <SecretWarning warnings={inspection.warnings} />}
        <EmailsField value={emails} onChange={setEmails} disabled={busy} placeholder="Add people by email (optional)" />
        <p className="p-meta p-text-3">Anyone with the link can read it; a fork needs a Kinu account.</p>
        {shares.length > 0 && (
          <div className="space-y-1.5">
            <p className="p-meta font-medium p-text-3">Published</p>
            <ul className="p-group">
              {shares.map((share) => (
                <li key={share.id} data-blueprint-share={share.id} className="flex items-center gap-3 px-3.5 py-2">
                  <span className="min-w-0 flex-1 truncate p-meta p-text-2">
                    {new Date(share.createdAt).toLocaleDateString()}{share.users.length > 0 ? ` · ${share.users.join(", ")}` : ""}
                  </span>
                  <StopButton onStop={() => void unshare(share.id)} disabled={busy} />
                </li>
              ))}
            </ul>
          </div>
        )}
        <Failure message={err} />
      </div>
      <div className="flex justify-end gap-2 border-t p-border pt-4">
        <Button size="sm" variant="ghost" onClick={onClose} disabled={busy}>Cancel</Button>
        <FilledButton className="h-8 px-4 text-sm" onClick={() => void publish()} disabled={busy || version === null || inspection === null} data-blueprint-publish>
          {busy ? <><Loader size="sm" /><span className="ml-1">Publishing…</span></> : "Publish"}
        </FilledButton>
      </div>
    </>
  );
}

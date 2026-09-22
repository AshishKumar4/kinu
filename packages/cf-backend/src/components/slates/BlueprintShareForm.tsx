/**
 * The blueprint half of the share dialog: publish a committed version with
 * every binding unmapped, choosing which top-level paths ship, seeing the
 * credentialed set a forker must connect and the secret-shaped lines the scan
 * found, and naming users by email. Nothing of the owner's is reachable
 * afterwards; the live half is `LiveShareForm`.
 */
import { useCallback, useEffect, useState } from "react";
import { Button, Loader } from "@cloudflare/kumo";
import * as v from "valibot";
import {
  BlueprintInspectionSchema, SlateShareRecordSchema, blueprintPagePath,
  type BlueprintInspection, type Rpc, type SlateAnswer, type SlateShareRecord,
} from "@kinu.run/core";
import { renderThrownChain } from "@kinu.run/core/obs";
import { FilledButton } from "@/components/ui/FilledButton";
import { inputCls } from "@/components/ui/form";
import { SecretWarning } from "@/pages/BlueprintPage";
import { publishBlueprint, type Published } from "@/lib/shared-api";

const HistorySchema = v.object({ versions: v.array(v.object({ id: v.string() })) });

/** Reads an answered slate operation, or throws its refusal. */
export function answered<Schema extends v.GenericSchema>(result: SlateAnswer<unknown>, schema: Schema): v.InferOutput<Schema> {
  if (!result.ok) throw new Error(`${result.reason}: ${result.error}`);

  return v.parse(schema, result.value);
}

export interface BlueprintFixture {
  versions: string[];
  inspection: BlueprintInspection;
  shares: SlateShareRecord[];
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
  const [listed, setListed] = useState(false);
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

  // Every choice re-inspects: the credentialed set and the warning are about
  // exactly the bytes that would ship.
  useEffect(() => {
    if (fixture !== undefined || version === null) return;
    let live = true;
    const failed = (...rejection: [unknown]): void => { if (live) setErr(renderThrownChain({ cause: rejection[0] })); };

    rpc<SlateAnswer<unknown>>("slate", [{ op: "inspect", id: slate, version, include: include === null ? undefined : [...include] }])
      .then((result) => { if (live) setInspection(answered(result, BlueprintInspectionSchema)); })
      .catch(failed);

    return () => { live = false; };
  }, [fixture, rpc, slate, version, include]);

  const topLevel = inspection === null ? [] : [...new Set(inspection.entries.map((entry) => entry.path.split("/")[0]))];
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
      const list = emails.split(/[\s,;]+/).map((email) => email.trim()).filter(Boolean);
      setPublished(await publishBlueprint({ workspace, slate, version, include: include === null ? undefined : [...include], emails: list, public: listed }));
    } catch (cause) {
      setErr(renderThrownChain({ cause }));
    } finally {
      setBusy(false);
    }
  }, [busy, version, emails, workspace, slate, include, listed]);

  const unshare = useCallback(async (share: string) => {
    setErr(null);

    try {
      answered(await rpc<SlateAnswer<unknown>>("slate", [{ op: "unshare", share }]), SlateShareRecordSchema);
      setShares((previous) => previous.filter((row) => row.id !== share));
    } catch (cause) {
      setErr(renderThrownChain({ cause }));
    }
  }, [rpc]);

  const footer = published === null ? (
    <>
      <Button size="sm" variant="ghost" onClick={onClose} disabled={busy}>Cancel</Button>
      <FilledButton onClick={publish} disabled={busy || version === null || inspection === null}>
        {busy ? <><Loader size="sm" /><span className="ml-1">Publishing…</span></> : "Publish blueprint"}
      </FilledButton>
    </>
  ) : <Button size="sm" variant="ghost" onClick={onClose}>Done</Button>;

  return (
    <>
      {published !== null ? (
        <div className="space-y-2 text-xs">
          <div className="p-notice-success rounded-md px-3 py-2">Published. Anyone with the link can read it and fork it into their own workspace.</div>
          <a href={blueprintPagePath(published.id)} className="block break-all font-mono p-accent" target="_blank" rel="noopener noreferrer">{location.origin}{blueprintPagePath(published.id)}</a>
          {published.users.length > 0 && <p className="p-text-3">Shared with {published.users.join(", ")}.</p>}
        </div>
      ) : (
        <div className="space-y-4 text-xs">
          <p className="p-text-2 leading-relaxed">
            A blueprint is a committed version exported with every binding unmapped: source, package.json, assets and nothing else. Your connections, keys and vault stay here; a forker connects their own.
          </p>
          {versions === null && err === null && <div className="flex justify-center py-4"><Loader size="sm" /></div>}
          {versions !== null && versions.length === 0 && <div className="p-notice-info rounded-md px-3 py-2">Commit this slate first; a blueprint is cut from a committed version.</div>}
          {versions !== null && versions.length > 0 && (
            <label className="block space-y-1">
              <span className="p-meta p-text-3">Committed version</span>
              <select value={version ?? ""} onChange={(event) => { setVersion(event.target.value); setInclude(null); }} className={inputCls} disabled={busy}>
                {versions.map((id, index) => <option key={id} value={id}>{index === versions.length - 1 ? `${id} (latest)` : id}</option>)}
              </select>
            </label>
          )}
          {inspection !== null && (
            <>
              <fieldset className="space-y-1">
                <legend className="p-meta p-text-3 mb-1">Paths the blueprint includes</legend>
                {topLevel.map((name) => (
                  <label key={name} className="flex items-center gap-2 font-mono p-text">
                    <input type="checkbox" checked={includes(name)} onChange={() => toggle(name)} disabled={busy || name === "package.json"} />
                    {name}{name === "package.json" && <span className="p-text-4 font-sans">always</span>}
                  </label>
                ))}
              </fieldset>
              <div className="space-y-1">
                <div className="p-meta p-text-3">A forker must connect</div>
                {inspection.credentialed.length === 0 ? (
                  <p className="p-text-3">Nothing: this slate reaches none of your connections.</p>
                ) : (
                  <ul className="space-y-0.5">
                    {inspection.credentialed.map((binding) => (
                      <li key={binding.name}><span className="font-mono p-text">{binding.name}</span> <span className="p-text-3">({binding.kind}{binding.target ? `: ${binding.target}` : ""})</span></li>
                    ))}
                  </ul>
                )}
              </div>
              <SecretWarning warnings={inspection.warnings} />
            </>
          )}
          <label className="block space-y-1">
            <span className="p-meta p-text-3">Share with users (emails, optional)</span>
            <input value={emails} onChange={(event) => setEmails(event.target.value)} className={inputCls} placeholder="pat@example.com, sam@example.com" disabled={busy} />
          </label>
          <label className="flex items-center gap-2 p-text">
            <input type="checkbox" checked={listed} onChange={(event) => setListed(event.target.checked)} disabled={busy} />
            List publicly <span className="p-text-3">— on the Shared page's public list, for anyone signed in to find</span>
          </label>
          {shares.length > 0 && (
            <div className="space-y-1">
              <div className="p-meta p-text-3">Already published from this slate</div>
              <ul className="space-y-1">
                {shares.map((share) => (
                  <li key={share.id} className="flex items-center gap-2">
                    <span className="min-w-0 flex-1 truncate p-text-2">{new Date(share.createdAt).toLocaleString()}{share.users.length > 0 ? ` · ${share.users.join(", ")}` : ""}</span>
                    <button type="button" onClick={() => unshare(share.id)} className="p-btn-quiet rounded-md px-2 py-0.5" disabled={busy}>Stop sharing</button>
                  </li>
                ))}
              </ul>
            </div>
          )}
          {err && <div className="p-notice-danger rounded-md px-3 py-2">{err}</div>}
        </div>
      )}
      <div className="mt-5 flex justify-end gap-2">{footer}</div>
    </>
  );
}

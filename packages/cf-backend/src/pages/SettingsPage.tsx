import { startTransition, useState, useEffect, useCallback, useRef } from "react";
import { useParams, Link } from "react-router-dom";
import { Loader } from "@cloudflare/kumo";
import {
  FloppyDiskIcon, BrainIcon, CheckIcon, ArrowLeftIcon,
  ShieldIcon, TreeStructureIcon, KeyIcon, PlugIcon, SparkleIcon,
  DownloadSimpleIcon, EyeIcon,
} from "@phosphor-icons/react";
import {
  ADVISOR_SEVERITIES, ADVISOR_SEVERITY_LABEL, DEFAULT_ADVISOR_MIN_SEVERITY,
  WORKSPACE_ARCHIVE_EXTENSION, formatScoreInterval,
  type ApprovalGrant, type ArchiveCursor, type ArchivePage, type EvolutionConfigView,
  type JsonValue, type InstructionSourceRow, type InstructionSourceView,
  type Page, type SeekCursor,
  ArchiveCursorSchema,
} from "@kinu.run/core";
import { executorLabel } from "@kinu.run/core";
import { useKinu } from "@/hooks/use-kinu";
import { Card, Field, inputCls } from "@/components/ui/form";
import { CopyButton } from "@/components/ui/CopyButton";
import { FilledButton } from "@/components/ui/FilledButton";
import { LoadFailure } from "@/components/ui/LoadFailure";
import { type AsyncResource, lastValue, loadFailed, loadSucceeded, useAsyncResource } from "@/hooks/use-async-resource";
import type { Rpc } from '@kinu.run/core';
import * as v from 'valibot';
import { renderThrownChain } from '@kinu.run/core/obs';

const ArchivePageSchema = v.object({ lines: v.array(v.string()), next: v.nullable(ArchiveCursorSchema) });

const ScoreIntervalSchema = v.object({ mean: v.number(), lo: v.number(), hi: v.number(), n: v.number() });

const GepaRunSchema = v.object({
  runId: v.string(), target: v.string(), status: v.picklist(['running', 'completed', 'aborted']),
  stopReason: v.nullable(v.string()), iterations: v.number(), metricCalls: v.number(), startedAt: v.number(),
});

const GepaOptimizationResultSchema = v.object({
  ok: v.boolean(), error: v.optional(v.string()), proposed: v.optional(v.boolean()),
  pendingVersion: v.nullable(v.optional(v.number())), skipReason: v.optional(v.string()),
  bestScore: v.optional(ScoreIntervalSchema), seedScore: v.optional(ScoreIntervalSchema),
  selection: v.optional(v.object({ heldOutNegatives: v.number(), guards: v.number() })),
  selectionWarning: v.optional(v.string()),
});

const SkillNamesSchema = v.object({ names: v.array(v.string()) });

type ApprovalMode = "strict" | "allow_all" | "deny_all";

const APPROVAL_LABEL: Record<ApprovalMode, string> = {
  strict: "Strict (review)",
  allow_all: "Allow all",
  deny_all: "Deny all",
};

interface MctsConfig {
  explorationConstant: number;
  maxIterations: number;
  maxDepth: number;
  branchBudget: number;
}

type AdvisorConfig = Pick<EvolutionConfigView, "advisorEnabled" | "advisorMinSeverity">;


/** A field that never loaded has nothing to save: an unconditional write before hydration wipes stored settings. */
interface SettingField<T> {
  resource: AsyncResource<T>;
  value: T | null;
  dirty: boolean;
  edit: (value: T) => void;
  hydrate: (value: T) => void;
  fail: (thrown: { cause: unknown }) => void;
  markSaved: (value: T) => void;
}

function useSettingField<T>(): SettingField<T> {
  const [resource, setResource] = useState<AsyncResource<T>>({ status: "loading" });
  // Boxed so `null` stays a legal edited value and absence stays distinguishable.
  const [edited, setEdited] = useState<{ value: T } | null>(null);

  const edit = useCallback((next: T) => setEdited({ value: next }), []);
  // A later refresh updates the stored value without disturbing an edit in progress.
  const hydrate = useCallback((next: T) => setResource(loadSucceeded(next)), []);
  const fail = useCallback((thrown: { cause: unknown }) => setResource((prev) => loadFailed(prev, thrown)), []);

  const markSaved = useCallback((saved: T) => {
    setResource(loadSucceeded(saved));
    setEdited(null);
  }, []);

  return {
    resource,
    value: edited ? edited.value : lastValue(resource),
    dirty: edited !== null,
    edit, hydrate, fail, markSaved,
  };
}

function FieldState<T>({ field, what, onRetry, children }: {
  field: SettingField<T>;
  what: string;
  onRetry: () => void;
  children: (value: T) => React.ReactNode;
}) {
  if (field.value !== null) return <>{children(field.value)}</>;

  if (field.resource.status === "error") {
    return <LoadFailure what={what} message={field.resource.message} onRetry={onRetry} />;
  }

  return <p className="text-xs p-text-3">Loading {what}…</p>;
}

function saveLabel(saving: boolean, saved: boolean): string {
  if (saving) return "Saving…";

  if (saved) return "Saved";

  return "Save";
}

export default function SettingsPage() {
  const { agentId } = useParams();
  const state = useKinu(agentId);
  // Stable pieces only: `state` is a fresh object every render, and depending on it loops refetches that clobber edits.
  const { rpc, connectionStatus, agentStatus, error: snapshotError, retryLoad } = state;

  const displayName = useSettingField<string>();
  const soul = useSettingField<string>();
  const approval = useSettingField<ApprovalMode>();
  const mcts = useSettingField<MctsConfig>();
  const advisor = useSettingField<AdvisorConfig>();

  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  // Identity rides the workspace snapshot, so it hydrates or fails with it.
  const { hydrate: hydrateDisplayName, fail: failDisplayName } = displayName;
  const { hydrate: hydrateSoul, fail: failSoul } = soul;
  useEffect(() => {
    if (agentStatus) {
      hydrateDisplayName(agentStatus.displayName || "");
      hydrateSoul(agentStatus.soul || "");
    } else if (snapshotError) {
      failDisplayName({ cause: snapshotError });
      failSoul({ cause: snapshotError });
    }
  }, [agentStatus, snapshotError, hydrateDisplayName, hydrateSoul, failDisplayName, failSoul]);

  const { hydrate: hydrateApproval, fail: failApproval } = approval;
  const { hydrate: hydrateMcts, fail: failMcts } = mcts;
  const { hydrate: hydrateAdvisor, fail: failAdvisor } = advisor;

  // A failed field is recorded in place rather than given a value Save could write over the stored setting.
  const loadRpcFields = useCallback((): void => {
    startTransition(async () => {
      try {
        const [mode, config, evolution] = await Promise.allSettled([
          rpc<{ mode: ApprovalMode }>("getShellApprovalMode", []),
          rpc<MctsConfig>("getMctsConfig", []),
          rpc<EvolutionConfigView>("getEvolutionConfig", []),
        ]);

        if (mode.status === "rejected") failApproval({ cause: mode.reason });
        else hydrateApproval(mode.value?.mode ?? "strict");

        if (config.status === "rejected") failMcts({ cause: config.reason });
        else if (config.value) hydrateMcts(config.value);
        else failMcts({ cause: "the agent returned no MCTS config" });

        if (evolution.status === "rejected") failAdvisor({ cause: evolution.reason });
        else hydrateAdvisor({
          advisorEnabled: evolution.value?.advisorEnabled ?? false,
          advisorMinSeverity: evolution.value?.advisorMinSeverity ?? DEFAULT_ADVISOR_MIN_SEVERITY,
        });
      } catch (cause) {
        failApproval({ cause }); failMcts({ cause }); failAdvisor({ cause });
      }
    });
  }, [
    rpc, hydrateApproval, failApproval, hydrateMcts, failMcts,
    hydrateAdvisor, failAdvisor,
  ]);

  const loaded = useRef(false);
  useEffect(() => {
    if (connectionStatus !== "connected" || loaded.current) return;
    loaded.current = true;
    loadRpcFields();
  }, [connectionStatus, loadRpcFields]);

  const dirty = displayName.dirty || soul.dirty || approval.dirty || mcts.dirty
    || advisor.dirty;

  const save = useCallback(async () => {
    // Only edited fields are written; the form has no authority over fields still loading or failed.
    const writes: Array<Promise<JsonValue | undefined | void>> = [];
    const commits: Array<() => void> = [];

    const write = <T,>(field: SettingField<T>, put: (value: T) => Promise<JsonValue | undefined | void>) => {
      const { value } = field;

      if (!field.dirty || value === null) return;
      writes.push(put(value));
      commits.push(() => field.markSaved(value));
    };

    write(displayName, (name) => rpc("setDisplayName", [name]));
    write(soul, (text) => rpc("setSoul", [text]));
    write(approval, (mode) => rpc("setShellApprovalMode", [mode]));
    write(mcts, (config) => rpc("setMctsConfig", [config]));
    write(advisor, (config) => rpc("setEvolutionConfig", [config]));

    if (writes.length === 0) return;

    setSaving(true);
    setErr(null);

    try {
      await Promise.all(writes);

      for (const commit of commits) commit();
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    } catch (e) {
      setErr(renderThrownChain({ cause: e }));
    } finally {
      setSaving(false);
    }
  }, [rpc, displayName, soul, approval, mcts, advisor]);

  if (connectionStatus !== "connected") {
    return (
      <div className="h-full flex flex-col items-center justify-center gap-3 text-sm p-text-2">
        {connectionStatus === "connecting" ? (
          <><Loader size="base" /><span>Connecting to {agentId}…</span></>
        ) : (
          <>
            <span className="p-danger">Not connected to this workspace. Settings cannot load or save until it reconnects.</span>
            <Link to={`/workspace/${agentId}`} className="text-xs p-accent underline">Back to chat</Link>
          </>
        )}
      </div>
    );
  }

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto max-w-3xl space-y-8 px-5 py-8 sm:px-6">
        <header className="flex flex-wrap items-end justify-between gap-4 border-b p-border pb-6">
          <div className="min-w-0">
            <Link to={`/workspace/${agentId}`} className="p-btn-ghost -ml-2 mb-4 inline-flex h-6.5 items-center gap-1 rounded-md px-2 text-xs">
              <ArrowLeftIcon size={12} /> Back to chat
            </Link>
            <p className="p-eyebrow">Workspace</p>
            <h1 className="p-display mt-1 text-[26px] leading-8">Workspace settings</h1>
            <p className="mt-1.5 flex flex-wrap items-center gap-x-1.5 gap-y-1 p-row-text p-text-3">
              <span className="font-mono">{agentId}</span>
              <CopyButton value={agentId ?? ""} what="the workspace slug" size={11}
                className="rounded-sm p-0.5 p-card-hover hover:p-text transition-colors" />
              <span>·</span>
              <Link to="/user/settings" className="hover:p-text inline-flex items-center gap-1">
                <KeyIcon size={11} /> Account settings and credentials
              </Link>
              <span>·</span>
              <Link to={`/workspace/${agentId}?altitude=supervise`} className="hover:p-text inline-flex items-center gap-1">
                <PlugIcon size={11} /> Automations (webhooks, timers)
              </Link>
            </p>
          </div>
          <FilledButton
            onClick={save}
            disabled={saving || !dirty}
            title={dirty ? undefined : "No unsaved changes"}
            className="px-3"
          >
            {saved ? <CheckIcon size={14} /> : <FloppyDiskIcon size={14} />}
            <span>{saveLabel(saving, saved)}</span>
          </FilledButton>
        </header>

        {err && <div className="p-notice-danger px-4 py-3 text-xs">{err}</div>}

        <div className="space-y-5">
        <Card title="Identity" icon={BrainIcon}>
          <Field label="Display name">
            <FieldState field={displayName} what="the display name" onRetry={retryLoad}>
              {(value) => (
                <input value={value} onChange={(e) => displayName.edit(e.target.value)} className={inputCls} />
              )}
            </FieldState>
          </Field>
          <Field label="SOUL.md">
            <FieldState field={soul} what="SOUL.md" onRetry={retryLoad}>
              {(value) => (
                <textarea value={value} onChange={(e) => soul.edit(e.target.value)} rows={8}
                  className={`${inputCls} font-mono`} placeholder={"# Agent name\n\n## Mission\n\nWhat is this agent for?"} />
              )}
            </FieldState>
          </Field>
        </Card>


        <Card title="Advisor" icon={EyeIcon}>
          <FieldState field={advisor} what="the advisor settings" onRetry={loadRpcFields}>
            {(value) => (
              <>
                <div className="space-y-1.5">
                  <label className="text-xs p-text-2 font-medium">Second opinion</label>
                  <div className="grid grid-cols-2 gap-2">
                    {([false, true] as const).map((on) => (
                      <button
                        key={on ? "on" : "off"}
                        onClick={() => advisor.edit({ ...value, advisorEnabled: on })}
                        className={`p-2 rounded-md text-xs ${value.advisorEnabled === on ? "p-accent-bg p-accent" : "p-card p-card-hover"}`}
                      >{on ? "On" : "Off"}</button>
                    ))}
                  </div>
                  <p className="p-meta p-text-3">
                    Off by default. When on, a second model reads each turn and can add one note. That is one extra model call per turn.
                  </p>
                </div>
                <div className="space-y-1.5">
                  <label className="text-xs p-text-2 font-medium">Minimum severity</label>
                  <div className="grid grid-cols-3 gap-2">
                    {ADVISOR_SEVERITIES.map((severity) => (
                      <button
                        key={severity}
                        onClick={() => advisor.edit({ ...value, advisorMinSeverity: severity })}
                        className={`p-2 rounded-md text-xs ${value.advisorMinSeverity === severity ? "p-accent-bg p-accent" : "p-card p-card-hover"}`}
                      >{ADVISOR_SEVERITY_LABEL[severity]}</button>
                    ))}
                  </div>
                  <p className="p-meta p-text-3">
                    Notes at or above this severity show in the conversation. Lower ones go to the Changelog. The default is concern.
                  </p>
                </div>
              </>
            )}
          </FieldState>
        </Card>


        <Card title="Shell-command approval" icon={ShieldIcon}>
          <FieldState field={approval} what="the approval mode" onRetry={loadRpcFields}>
            {(value) => (
              <div className="grid grid-cols-3 gap-2">
                {(['strict', 'allow_all', 'deny_all'] satisfies ApprovalMode[]).map((m) => (
                  <button
                    key={m}
                    onClick={() => approval.edit(m)}
                    className={`p-2 rounded-md text-xs ${value === m ? 'p-accent-bg p-accent' : 'p-card p-card-hover'}`}
                  >{APPROVAL_LABEL[m]}</button>
                ))}
              </div>
            )}
          </FieldState>
        </Card>
        <StandingApprovalsCard rpc={rpc} />
        <InstructionApprovalsCard rpc={rpc} />

        <Card title="MCTS settings" icon={TreeStructureIcon}>
          <FieldState field={mcts} what="the MCTS settings" onRetry={loadRpcFields}>
            {(value) => (
              <div className="grid grid-cols-2 gap-3">
                <NumField label="Exploration constant" value={value.explorationConstant} step={0.1} onChange={(next) => mcts.edit({ ...value, explorationConstant: next })} />
                <NumField label="Max iterations" value={value.maxIterations} step={1} onChange={(next) => mcts.edit({ ...value, maxIterations: next })} />
                <NumField label="Branch budget" value={value.branchBudget} step={1} onChange={(next) => mcts.edit({ ...value, branchBudget: next })} />
              </div>
            )}
          </FieldState>
        </Card>


        <AlwaysActiveSkillsCard rpc={rpc} />

        <WorkspaceBackupCard rpc={rpc} workspace={agentId ?? ""} />

        <GepaOptimizationCard rpc={rpc} />
        </div>
      </div>
    </div>
  );
}


/** A grant is scoped to one rule on one executor: it stops the asking, never widens reach, and cannot soften a refused rule. */
export function StandingApprovalsCard({ rpc }: { rpc: Rpc }) {
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const load = useCallback(
    async () => (await rpc<{ grants: ApprovalGrant[] }>("getShellApprovalGrants", [])).grants,
    [rpc],
  );

  const { resource, reload } = useAsyncResource(load);
  const grants = lastValue(resource);

  const revoke = async (grant: ApprovalGrant) => {
    setBusy(`${grant.rule}@${grant.executor}`);
    setErr(null);

    try {
      await rpc("revokeShellApprovalGrants", [[grant]]);
      reload();
    } catch (e) {
      setErr(renderThrownChain({ cause: e }));
    } finally {
      setBusy(null);
    }
  };

  if (resource.status !== "error" && grants !== null && grants.length === 0) return null;

  return (
    <Card title="Standing approvals" icon={ShieldIcon}>
      <p className="p-meta p-text-3">
        “Always” stops Kinu asking about this check in this environment. It does not give the agent any more access.
      </p>
      {resource.status === "error" && grants === null && (
        <LoadFailure what="your standing approvals" message={resource.message} onRetry={reload} />
      )}
      {resource.status !== "error" && grants === null && <p className="text-xs p-text-3">Loading…</p>}
      {grants !== null && (
        <div className="space-y-1">
          {grants.map((grant) => (
            <div key={`${grant.rule}@${grant.executor}`}
              className="flex items-center gap-2 text-xs rounded-md px-2 py-1.5 p-card">
              <code className="font-mono p-text">{grant.rule}</code>
              <span className="p-text-3">on</span>
              <span className="p-text-2">{executorLabel(grant.executor)}</span>
              <button
                type="button"
                onClick={async () => { await revoke(grant); }}
                disabled={busy !== null}
                className="ml-auto px-2 py-0.5 rounded-sm p-card-hover p-text-3 hover:p-text disabled:opacity-50"
                title={`Ask again next time a command trips ${grant.rule} on ${grant.executor}`}
              >{busy === `${grant.rule}@${grant.executor}` ? "…" : "Revoke"}</button>
            </div>
          ))}
        </div>
      )}
      {err && <div className="p-meta p-danger mt-1">{err}</div>}
    </Card>
  );
}


const DECISION_WORD: Record<InstructionSourceRow["decision"], string> = {
  grandfathered: "carried over",
  approved: "approved",
  revoked: "refused",
  none: "not decided",
};

/** Approval binds the exact bytes: any later edit stops matching the digest and drops the file back to reference material. */
function InstructionApprovalsCard({ rpc }: { rpc: Rpc }) {
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [open, setOpen] = useState<InstructionSourceView | null>(null);
  const [cursor, setCursor] = useState<SeekCursor | undefined>(undefined);

  const load = useCallback(
    async () => await rpc<Page<InstructionSourceRow>>(
      "listInstructionApprovals", [cursor ? { cursor } : {}],
    ),
    [rpc, cursor],
  );

  const { resource, reload } = useAsyncResource(load);
  const page = lastValue(resource);

  // Opening a row reads that file only; the listing carries no bytes.
  const read = async (row: InstructionSourceRow) => {
    if (open?.path === row.path) {
      setOpen(null);

      return;
    }

    setBusy(row.path);
    setErr(null);

    try {
      setOpen(await rpc<InstructionSourceView | null>("readInstructionApproval", [row.path]));
    } catch (e) {
      setErr(renderThrownChain({ cause: e }));
    } finally {
      setBusy(null);
    }
  };

  const decide = async (row: InstructionSourceRow, action: "approve" | "revoke") => {
    setBusy(row.path);
    setErr(null);

    try {
      if (action === "approve") {
        // Approval binds the digest the owner was just shown; if the file moved on, nothing is granted.
        const opened = open?.path === row.path
          ? open
          : await rpc<InstructionSourceView | null>("readInstructionApproval", [row.path]);

        if (!opened) {
          setErr("Kinu could not read that file, so nothing was approved. Try again.");

          return;
        }

        await rpc("approveInstruction", [row.path, opened.digest]);
      } else {
        await rpc("revokeInstruction", [row.path]);
      }

      setOpen(null);
      reload();
    } catch (e) {
      setErr(renderThrownChain({ cause: e }));
    } finally {
      setBusy(null);
    }
  };

  const rows = page?.items ?? null;

  if (resource.status !== "error" && rows !== null && rows.length === 0 && !cursor) return null;

  return (
    <Card title="Workspace instruction files" icon={ShieldIcon}>
      <p className="p-meta p-text-3">
        Your agent can write these files. Kinu follows a file as instructions only when you approve its
        contents. After any edit it becomes reference material again until you approve it again.
      </p>
      {resource.status === "error" && rows === null && (
        <LoadFailure what="this workspace's instruction files" message={resource.message} onRetry={reload} />
      )}
      {resource.status !== "error" && rows === null && <p className="text-xs p-text-3">Loading…</p>}
      {rows !== null && (
        <div className="space-y-1">
          {rows.map((row) => {
            const opened = open?.path === row.path ? open : null;
            const state = row.reason === undefined ? DECISION_WORD[row.decision] : `not readable: ${row.reason}`;
            const followed = row.decision === "approved" || row.decision === "grandfathered";
            const readWord = opened === null ? "Read" : "Hide";

            return (
              <div key={row.path} className="rounded-md px-2 py-1.5 p-card space-y-1">
                <div className="flex items-center gap-2 text-xs">
                  <code className="font-mono p-text truncate" title={row.path}>{row.path}</code>
                  <span className="p-text-3 shrink-0">
                    {row.kind === "skill" ? "skill" : "AGENTS.md"} · {row.bytes} bytes
                  </span>
                  <span className="p-text-3 shrink-0">{state}</span>
                  {row.reason === undefined && (
                    <button
                      type="button"
                      onClick={async () => { await read(row); }}
                      disabled={busy !== null}
                      className="ml-auto px-2 py-0.5 rounded-sm p-card-hover p-text-3 hover:p-text disabled:opacity-50 shrink-0"
                    >{busy === row.path ? "…" : readWord}</button>
                  )}
                  {followed && (
                    <button
                      type="button"
                      onClick={async () => { await decide(row, "revoke"); }}
                      disabled={busy !== null}
                      className={`${row.reason === undefined ? "" : "ml-auto "}px-2 py-0.5 rounded-sm p-card-hover p-text-3 hover:p-text disabled:opacity-50 shrink-0`}
                      title="Stop following this file as instructions"
                    >Revoke</button>
                  )}
                  {!followed && row.reason === undefined && (
                    <button
                      type="button"
                      onClick={async () => { await decide(row, "approve"); }}
                      disabled={busy !== null}
                      className="px-2 py-0.5 rounded-sm p-card-hover p-text-2 hover:p-text disabled:opacity-50 shrink-0"
                      title="Follow these exact contents as instructions"
                    >Approve</button>
                  )}
                </div>
                {opened && (
                  <>
                    <pre className="p-t-code p-text-2 whitespace-pre-wrap break-words
                      max-h-64 overflow-auto rounded-sm px-2 py-1.5 p-card-hover">{opened.preview}</pre>
                    <div className="p-meta p-text-3 font-mono break-all">{opened.digest}</div>
                  </>
                )}
              </div>
            );
          })}
        </div>
      )}
      {(page?.status === "more" || cursor) && (
        <div className="flex gap-2 pt-1">
          {cursor && (
            <button type="button" onClick={() => { setCursor(undefined); setOpen(null); }}
              className="p-meta px-2 py-0.5 rounded-sm p-card-hover p-text-3 hover:p-text">First page</button>
          )}
          {page?.status === "more" && (
            <button type="button" onClick={() => { setCursor(page.next); setOpen(null); }}
              className="p-meta px-2 py-0.5 rounded-sm p-card-hover p-text-3 hover:p-text">More</button>
          )}
        </div>
      )}
      {err && <div className="p-meta p-danger mt-1">{err}</div>}
    </Card>
  );
}


/** The export RPC answers one bounded page at a time, so the browser walks the cursor and assembles the archive. */
function WorkspaceBackupCard({
  rpc, workspace,
}: {
  rpc: Rpc;
  workspace: string;
}) {
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const download = useCallback(async () => {
    setBusy(true);
    setErr(null);
    setStatus("Exporting…");

    try {
      const parts: string[] = [];
      let cursor: ArchiveCursor | null = null;
      let records = 0;

      do {
        const page: ArchivePage = v.parse(ArchivePageSchema, await rpc("exportWorkspaceArchive", [cursor]));
        parts.push(page.lines.map((line) => `${line}\n`).join(""));
        records += page.lines.length;
        cursor = page.next;
        setStatus(`Exporting… ${records} records`);
      } while (cursor);

      const url = URL.createObjectURL(new Blob(parts, { type: "application/x-ndjson" }));

      try {
        const link = document.createElement("a");
        link.href = url;
        link.download = `${workspace}${WORKSPACE_ARCHIVE_EXTENSION}`;
        link.click();
      } finally {
        URL.revokeObjectURL(url);
      }

      setStatus(`Downloaded ${records} records.`);
    } catch (e) {
      setStatus(null);
      setErr(renderThrownChain({ cause: e }));
    } finally {
      setBusy(false);
    }
  }, [rpc, workspace]);

  return (
    <Card title="Backup" icon={DownloadSimpleIcon}>
      <p className="p-meta p-text-3">
        Download an archive of this workspace: transcripts, memory, files and evolution history. Restore it
        with <code className="font-mono">kinu import &lt;file&gt;</code>. Download one before you delete a
        workspace. The archive holds everything in the workspace, so keep it as safe as a password.
      </p>
      <button
        type="button"
        onClick={async () => { await download(); }}
        disabled={busy || !workspace}
        className="px-3 py-1.5 rounded-md text-xs font-medium p-accent-bg p-accent hover:opacity-90 disabled:opacity-50"
      >{busy ? "Exporting…" : "Download archive"}</button>
      {status && <div className="p-meta p-text-2 mt-1">{status}</div>}
      {err && <div className="p-meta p-danger mt-1">Export failed: {err}</div>}
    </Card>
  );
}


const GEPA_DOT = {
  completed: 'p-dot-success', running: 'p-dot-warning', aborted: 'p-dot-neutral',
} satisfies Record<v.InferOutput<typeof GepaRunSchema>['status'], string>;

function GepaOptimizationCard({
  rpc,
}: {
  rpc: Rpc;
}) {
  const [running, setRunning] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  // "No optimisation runs yet" may only be claimed about a listing that actually came back.
  const load = useCallback(
    async () => v.parse(v.array(GepaRunSchema), await rpc('getGepaRuns', [10])),
    [rpc],
  );

  const { resource, reload } = useAsyncResource(load);
  const runs = lastValue(resource) ?? [];

  const run = useCallback(async () => {
    setRunning(true);
    setMsg('Testing candidate scaffolds against recent tasks. This can take a few minutes.');

    try {
      // No evalSize override: a budget smaller than the configured one cannot resolve a winner.
      const r = v.parse(GepaOptimizationResultSchema,
        await rpc('runScaffoldGepaOptimization', [{ maxIterations: 4 }]));

      const scores = r.bestScore && r.seedScore
        ? `best ${formatScoreInterval(r.bestScore)} vs seed ${formatScoreInterval(r.seedScore)}`
        : '';

      const scoredOn = r.selection
        ? ` Scored on ${r.selection.heldOutNegatives} unseen failure(s) + ${r.selection.guards} accepted guard(s).`
        : '';

      const caveat = r.selectionWarning ? ` Caveat: ${r.selectionWarning}.` : '';

      if (!r.ok) setMsg(`The run failed: ${r.error}`);
      else if (r.proposed) {
        setMsg(`Proposed scaffold v${r.pendingVersion} (${scores}). After shadow evaluation, promote it under Agent → Evolution.${scoredOn}${caveat}`);
      } else {
        setMsg(`No improvement found (${r.skipReason ?? 'seed already best'}; ${scores}).${scoredOn}${caveat}`);
      }

      reload();
    } catch (e) {
      setMsg(`Optimisation failed: ${renderThrownChain({ cause: e })}`);
    } finally {
      setRunning(false);
    }
  }, [rpc, reload]);

  return (
    <Card title="Scaffold self-tuning" icon={SparkleIcon}>
      <p className="p-meta p-text-3">
        Tests candidate agent loops against recent tasks and may propose a better one for shadow
        evaluation. Each run makes several model calls.
      </p>
      <button
        type="button"
        onClick={run}
        disabled={running}
        className="px-3 py-1.5 rounded-md text-xs font-medium p-accent-bg p-accent hover:opacity-90 disabled:opacity-50"
      >{running ? 'Optimising…' : 'Run optimisation'}</button>
      {msg && <div className="p-meta p-text-2 mt-1">{msg}</div>}
      {resource.status === "error" && (
        <LoadFailure what="the optimisation history" message={resource.message} onRetry={reload} className="mt-2" />
      )}
      {runs.length > 0 && (
        <div className="mt-2 space-y-1">
          {runs.slice(0, 5).map(r => (
            <div key={r.runId} className="p-meta p-text-3 flex items-center gap-2">
              <span className={`size-1.5 rounded-full ${GEPA_DOT[r.status]}`} />
              <span className="font-mono">{r.iterations} iters</span>
              <span>· {r.metricCalls} evals</span>
              <span className="ml-auto">{r.stopReason ?? r.status}</span>
            </div>
          ))}
        </div>
      )}
    </Card>
  );
}



function AlwaysActiveSkillsCard({
  rpc,
}: {
  rpc: Rpc;
}) {
  const [names, setNames] = useState<string[]>([]);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  // React owns the async transition so a malformed response reaches this card's visible error.
  const refresh = useCallback((): void => {
    startTransition(async () => {
      try {
        const raw = await rpc('getAlwaysActiveSkills', []);
        setNames(v.parse(SkillNamesSchema, raw).names);
      } catch (cause) {
        setErr(renderThrownChain({ cause }));
      }
    });
  }, [rpc]);

  useEffect(() => { refresh(); }, [refresh]);

  const save = useCallback(async (next: string[]) => {
    setBusy(true);
    setErr(null);

    try {
      const r = v.parse(SkillNamesSchema, await rpc('setAlwaysActiveSkills', [next]));
      setNames(r.names);
    } catch (e) { setErr(renderThrownChain({ cause: e })); }
    finally { setBusy(false); }
  }, [rpc]);

  const add = useCallback(async () => {
    const n = input.trim();

    if (!n) return;

    if (names.includes(n)) {
      setInput('');

      return;
    }

    setInput('');
    await save([...names, n]);
  }, [input, names, save]);

  const remove = useCallback(async (n: string) => {
    await save(names.filter(x => x !== n));
  }, [names, save]);

  return (
    <Card title="Always-active skills" icon={KeyIcon}>
      <p className="p-meta p-text-3">
        Pin a workflow skill, such as <code className="font-mono">audit-implementation</code>, and it runs
        every turn without you typing /name.
      </p>
      <div className="flex flex-wrap gap-1.5">
        {names.length === 0
          ? <span className="p-meta p-text-3">No skills pinned.</span>
          : names.map(n => (
            <span key={n} className="inline-flex items-center gap-1 px-2 py-0.5 rounded-sm p-card p-meta font-mono">
              {n}
              <button type="button" onClick={async () => { await remove(n); }} aria-label={`Unpin ${n}`} className="p-text-3 hover:p-text">×</button>
            </span>
          ))}
      </div>
      <div className="flex gap-2 mt-2">
        <input
          type="text"
          value={input}
          placeholder="skill-name"
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={async (e) => { if (e.key === 'Enter') await add(); }}
          className={inputCls + " text-xs"}
        />
        <button
          type="button"
          onClick={async () => { await add(); }}
          disabled={busy || !input.trim()}
          className="px-3 py-1.5 rounded-md text-xs font-medium p-accent-bg p-accent hover:opacity-90 disabled:opacity-50 shrink-0"
        >Pin</button>
      </div>
      {err && <div className="p-meta p-danger mt-1">{err}</div>}
    </Card>
  );
}



function NumField({ label, value, step, onChange }: { label: string; value: number; step: number; onChange: (v: number) => void }) {
  return (
    <div className="space-y-1">
      <label className="p-meta p-text-2">{label}</label>
      <input
        type="number"
        step={step}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        className={inputCls}
      />
    </div>
  );
}

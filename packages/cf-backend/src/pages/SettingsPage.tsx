import { Effect, Cause } from 'effect';
import { startTransition, useState, useEffect, useCallback, useRef } from "react";
import { Link } from "react-router-dom";
import { Loader } from "@cloudflare/kumo";
import { Button, buttonClass } from "@/components/ui/Button";
import { FloppyDiskIcon, CheckIcon, GearSixIcon, KeyIcon, TrashIcon } from "@phosphor-icons/react";
import { Page } from "@/components/ui/PageHeader";
import {
  ADVISOR_SEVERITIES, ADVISOR_SEVERITY_LABEL, DEFAULT_ADVISOR_MIN_SEVERITY,
  WORKSPACE_ARCHIVE_EXTENSION,
  type ApprovalGrant, type ArchiveCursor, type EvolutionConfigView,
  type InstructionSourceRow, type InstructionSourceView, type SeekCursor, type ShellApprovalMode, WORKSPACE_TITLE_MAX,
} from "@kinu.run/core";
import { useWorkspaceRoster } from "@/hooks/use-workspace-roster";
import { executorLabel } from "@kinu.run/core";
import type { ConnectionStatus } from "@/hooks/use-chat-owner";
import type { AgentStatus, WorkspaceLayout, WorkspaceNotice } from "@kinu.run/core";
import { WorkspaceAutomations } from "@/components/WorkspaceAutomations";
import { Card, Field, composing, inputCls } from "@/components/ui/form";
import { CopyButton } from "@/components/ui/CopyButton";
import { Segmented } from "@/components/ui/Segmented";
import { LoadFailure } from "@/components/ui/LoadFailure";
import { CardSlot } from "@/components/ui/CardSlot";
import { WorkspaceLogo } from "@/components/Marks";
import { type AsyncResource, lastValue, loadFailed, loadSucceeded, useAsyncResource } from "@/hooks/use-async-resource";
import { showing, detach, settle } from '@kinu.run/core/obs';
import type { WorkspaceRpc } from "@/lib/workspace-rpc";

const APPROVAL_LABEL: Record<ShellApprovalMode, string> = {
  strict: "Strict (review)",
  allow_all: "Allow all",
  deny_all: "Deny all",
};

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

/** The field's slot: the owner's edit while there is one, else its read as every card shows a read. */
function FieldState<T>({ field, what, onRetry, children }: {
  field: SettingField<T>;
  what: string;
  onRetry: () => void;
  children: (value: T) => React.ReactNode;
}) {
  if (field.value !== null) return <>{children(field.value)}</>;

  return <CardSlot resource={field.resource} what={what} onRetry={onRetry}>{children}</CardSlot>;
}

const LAYOUT_CHOICES: { id: WorkspaceLayout; label: string }[] = [{ id: "workbench", label: "Workbench" }, { id: "focus", label: "Focus" }];

const ADVISOR_SWITCH = [{ id: "off", label: "Off" }, { id: "on", label: "On" }] as const;

function saveLabel(saving: boolean, saved: boolean): string {
  if (saving) return "Saving…";

  if (saved) return "Saved";

  return "Save";
}

/** The workspace socket's pieces settings read; the page shares the chat's socket rather than opening its own. */
interface SettingsSource {
  readonly rpc: WorkspaceRpc;
  readonly connectionStatus: ConnectionStatus;
  /** The workspace as a whole, from its opening. */
  readonly status: AgentStatus | null;
  readonly error: WorkspaceNotice | null;
  readonly retryLoad: () => void;
}

function LogoField({ title, logo, rpc }: { title: string; logo: string | null | undefined; rpc: WorkspaceRpc }) {
  const [drawing, setDrawing] = useState(false);
  const [note, setNote] = useState<string | null>(null);

  const redraw = useCallback(() => {
    setDrawing(true);
    setNote(null);
    detach(Effect.ensuring(Effect.catchCause(Effect.gen(function* () {
      const { drawn, refusal } = yield* Effect.promise(() => rpc("regenerateWorkspaceLogo", []));

      if (!drawn) setNote(refusal ?? "The model's drawing could not be used; the monogram stays. Try again.");
    }), showing(setNote)), Effect.sync(() => setDrawing(false))));
  }, [rpc]);

  return (
    <Field label="Logo">
      <div className="flex items-center gap-3" data-logo-field>
        <WorkspaceLogo title={title} logo={logo} size={40} />
        <button type="button" onClick={redraw} disabled={drawing} className={buttonClass({ size: "sm" })}>
          {drawing ? <><Loader size="sm" /> Drawing…</> : "Draw a new one"}
        </button>
      </div>
      {note && <p className="text-xs p-text-3">{note}</p>}
    </Field>
  );
}

/** `clearMain` asks the one Clear Main dialog the chat tab's × opens. `titleDraft` is the roster's title as an edit
 *  starts from it, null until its row is read. */
export function WorkspaceSettings({ workspace: agentId, title, titleDraft, logo, state, clearMain }: {
  workspace: string; title: string; titleDraft: string | null; logo: string | null | undefined; state: SettingsSource; clearMain: () => void;
}) {
  const { rename } = useWorkspaceRoster();
  // Stable pieces only: `state` is a fresh object every render, and depending on it loops refetches that clobber edits.
  const { rpc, connectionStatus, status, error: snapshotError, retryLoad } = state;

  const displayName = useSettingField<string>();
  const soul = useSettingField<string>();
  const approval = useSettingField<ShellApprovalMode>();
  const layout = useSettingField<WorkspaceLayout>();
  const advisor = useSettingField<AdvisorConfig>();

  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  // The title is the roster's; the soul rides the workspace snapshot, so it hydrates or fails with it.
  const { hydrate: hydrateDisplayName } = displayName;
  const { hydrate: hydrateSoul, fail: failSoul } = soul;

  useEffect(() => {
    if (titleDraft !== null) hydrateDisplayName(titleDraft);
  }, [titleDraft, hydrateDisplayName]);

  useEffect(() => {
    if (status) hydrateSoul(status.soul || "");
    else if (snapshotError) failSoul({ cause: snapshotError });
  }, [status, snapshotError, hydrateSoul, failSoul]);

  const { hydrate: hydrateLayout, fail: failLayout } = layout;

  useEffect(() => {
    if (status) hydrateLayout(status.layout);
    else if (snapshotError) failLayout({ cause: snapshotError });
  }, [status, snapshotError, hydrateLayout, failLayout]);

  const { hydrate: hydrateApproval, fail: failApproval } = approval;
  const { hydrate: hydrateAdvisor, fail: failAdvisor } = advisor;

  // A failed field is recorded in place rather than given a value Save could write over the stored setting.
  const loadRpcFields = useCallback((): void => {
    startTransition(() => settle(Effect.catchCause(Effect.gen(function* () {
      const [mode, evolution] = yield* Effect.promise(async () => Promise.allSettled([
        rpc("getShellApprovalMode", []),
        rpc("getEvolutionConfig", []),
      ]));

      if (mode.status === "rejected") failApproval({ cause: mode.reason });
      else hydrateApproval(mode.value?.mode ?? "strict");

      if (evolution.status === "rejected") failAdvisor({ cause: evolution.reason });
      else hydrateAdvisor({
        advisorEnabled: evolution.value?.advisorEnabled ?? false,
        advisorMinSeverity: evolution.value?.advisorMinSeverity ?? DEFAULT_ADVISOR_MIN_SEVERITY,
      });
    }), (failed) => Effect.sync(() => {
      const cause = Cause.squash(failed);
      failApproval({ cause }); failAdvisor({ cause });
    }))));
  }, [
    rpc, hydrateApproval, failApproval,
    hydrateAdvisor, failAdvisor,
  ]);

  const loaded = useRef(false);
  useEffect(() => {
    if (connectionStatus !== "connected" || loaded.current) return;
    loaded.current = true;
    loadRpcFields();
  }, [connectionStatus, loadRpcFields]);

  const dirty = displayName.dirty || soul.dirty || layout.dirty || approval.dirty || advisor.dirty;

  const save = useCallback(() => detach(Effect.gen(function* () {
    // Only edited fields are written; the form has no authority over fields still loading or failed.
    const writes: Array<Promise<object>> = [];
    const commits: Array<() => void> = [];

    const write = <T,>(field: SettingField<T>, put: (value: T) => Promise<object>) => {
      const { value } = field;

      if (!field.dirty || value === null) return;
      writes.push(put(value));
      commits.push(() => field.markSaved(value));
    };

    write(displayName, async (name) => {
      const titled = await rpc("setDisplayName", [name]);

      rename(agentId, titled.displayName);

      return titled;
    });
    write(soul, (text) => rpc("setSoul", [text]));
    write(layout, (chosen) => rpc("setLayout", [chosen]));
    write(approval, (mode) => rpc("setShellApprovalMode", [mode]));
    write(advisor, (config) => rpc("setEvolutionConfig", [config]));

    if (writes.length === 0) return;

    setSaving(true);
    setErr(null);

    return yield* Effect.ensuring(Effect.catchCause(Effect.gen(function* () {
      yield* Effect.promise(async () => Promise.all(writes));

      for (const commit of commits) commit();
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    }), showing(setErr)), Effect.sync(() => {
      setSaving(false);
    }));
  })), [rpc, rename, agentId, displayName, soul, layout, approval, advisor]);

  if (connectionStatus !== "connected") {
    return (
      <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-3 text-sm p-text-2">
        {connectionStatus === "connecting" ? (
          <><Loader size="base" /><span>Connecting to {agentId}…</span></>
        ) : (
          <span className="p-danger">Not connected to this workspace. Settings cannot load or save until it reconnects.</span>
        )}
      </div>
    );
  }

  return (
    <Page fill icon={<GearSixIcon size={22} />} title="Settings" data-workspace-settings>
      <p className="flex flex-wrap items-center gap-x-1.5 gap-y-1 p-row-text p-text-3">
        <span className="font-mono">{agentId}</span>
        <CopyButton value={agentId} what="the workspace slug" size={11}
          className="rounded-sm p-0.5 p-card-hover hover:p-text transition-colors" />
        <span>·</span>
        <Link to="/user/settings" className="hover:p-text inline-flex items-center gap-1">
          <KeyIcon size={11} /> Account settings and credentials
        </Link>
      </p>

      {err && <div className="p-notice-danger px-4 py-3 text-xs">{err}</div>}

      <div className="space-y-5">
      <Card title="Identity">
        <LogoField title={title} logo={logo} rpc={rpc} />
        <Field label="Display name">
          <FieldState field={displayName} what="the display name" onRetry={retryLoad}>
            {(value) => (
              <input value={value} maxLength={WORKSPACE_TITLE_MAX} onChange={(e) => displayName.edit(e.target.value)} className={inputCls} />
            )}
          </FieldState>
        </Field>
        <Field label="Layout">
          <FieldState field={layout} what="the layout" onRetry={retryLoad}>
            {(value) => (
              <div className="flex">
                <Segmented label="Layout" value={value} segments={LAYOUT_CHOICES} onChange={(chosen) => layout.edit(chosen)} />
              </div>
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


      <Card title="Advisor">
        <FieldState field={advisor} what="the advisor settings" onRetry={loadRpcFields}>
          {(value) => (
            <>
              <div className="space-y-1.5">
                <label className="block text-xs p-text-2 font-medium">Second opinion</label>
                <div className="flex">
                  <Segmented label="Second opinion" value={value.advisorEnabled ? "on" : "off"} segments={ADVISOR_SWITCH}
                    onChange={(id) => advisor.edit({ ...value, advisorEnabled: id === "on" })} />
                </div>
              </div>
              <div className="space-y-1.5">
                <label className="block text-xs p-text-2 font-medium">Minimum severity</label>
                <div className="flex">
                  <Segmented label="Minimum severity" value={value.advisorMinSeverity}
                    segments={ADVISOR_SEVERITIES.map((severity) => ({ id: severity, label: ADVISOR_SEVERITY_LABEL[severity] }))}
                    onChange={(severity) => advisor.edit({ ...value, advisorMinSeverity: severity })} />
                </div>
              </div>
            </>
          )}
        </FieldState>
      </Card>


      <Card title="Shell-command approval">
        <FieldState field={approval} what="the approval mode" onRetry={loadRpcFields}>
          {(value) => (
            <div className="grid grid-cols-3 gap-2">
              {(['strict', 'allow_all', 'deny_all'] satisfies ShellApprovalMode[]).map((m) => (
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


      <AlwaysActiveSkillsCard rpc={rpc} />

      <div className="p-card border p-border p-5" id="automations"><WorkspaceAutomations rpc={rpc} workspace={agentId} /></div>

      <WorkspaceBackupCard rpc={rpc} workspace={agentId} />

      <Card title="Main's conversation">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <p className="p-meta p-text-3">Clearing removes Main's messages. Memory, SOUL.md, learned tools and evolution stay.</p>
          <Button size="sm" variant="secondary" icon={<TrashIcon size={12} />} onClick={clearMain}>Clear history</Button>
        </div>
      </Card>
      </div>
      {/* Where the edits are: the bar rises from the page's foot once there is something to save. */}
      {(dirty || saving || saved) && (
        <div className="sticky bottom-4 z-10 flex items-center justify-between gap-3 rounded-[14px] border p-border p-overlay py-2.5 pl-4 pr-2.5 p-shadow-menu animate-fade-in">
          <span className="p-row-text p-text-2">{saved && !dirty ? "Changes saved." : "You have unsaved changes."}</span>
          <Button variant="primary" size="sm" onClick={save} disabled={saving || !dirty} >
            {saved && !dirty ? <CheckIcon size={14} /> : <FloppyDiskIcon size={14} />}
            <span>{saveLabel(saving, saved && !dirty)}</span>
          </Button>
        </div>
      )}
    </Page>
  );
}

/** A grant is scoped to one rule on one executor: it stops the asking, never widens reach, and cannot soften a refused rule. */
export function StandingApprovalsCard({ rpc }: { rpc: WorkspaceRpc }) {
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const load = useCallback(
    async () => (await rpc("getShellApprovalGrants", [])).grants,
    [rpc],
  );

  const { resource, reload } = useAsyncResource(load);
  const grants = lastValue(resource);

  const revoke = (grant: ApprovalGrant) => Effect.gen(function* () {
    setBusy(`${grant.rule}@${grant.executor}`);
    setErr(null);

    return yield* Effect.ensuring(Effect.catchCause(Effect.gen(function* () {
      yield* Effect.promise(async () => rpc("revokeShellApprovalGrants", [[grant]]));
      reload();
    }), showing(setErr)), Effect.sync(() => {
      setBusy(null);
    }));
  });

  if (resource.status !== "error" && grants !== null && grants.length === 0) return null;

  return (
    <Card title="Standing approvals">
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
                onClick={() => detach(revoke(grant))}
                disabled={busy !== null}
                className="ml-auto px-2 py-0.5 rounded-sm p-card-hover p-text-3 hover:p-text disabled:opacity-50"
                title={`Ask again next time a command trips ${grant.rule} on ${executorLabel(grant.executor)}`}
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
  approved: "approved",
  revoked: "refused",
  none: "not decided",
};

function decisionWord(row: InstructionSourceRow): string {
  return row.byDream ? "added by a dream" : DECISION_WORD[row.decision];
}

/** Approval binds the exact bytes: any later edit stops matching the digest and drops the file back to reference material. */
function InstructionApprovalsCard({ rpc }: { rpc: WorkspaceRpc }) {
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [open, setOpen] = useState<InstructionSourceView | null>(null);
  const [cursor, setCursor] = useState<SeekCursor | undefined>(undefined);

  const load = useCallback(
    async () => await rpc(
      "listInstructionApprovals", [cursor ? { cursor } : {}],
    ),
    [rpc, cursor],
  );

  const { resource, reload } = useAsyncResource(load);
  const page = lastValue(resource);

  // Opening a row reads that file only; the listing carries no bytes.
  const read = (row: InstructionSourceRow) => Effect.gen(function* () {
    if (open?.path === row.path) {
      setOpen(null);

      return;
    }

    setBusy(row.path);
    setErr(null);

    return yield* Effect.ensuring(Effect.catchCause(Effect.gen(function* () {
      setOpen(yield* Effect.promise(async () => rpc("readInstructionApproval", [row.path])));
    }), showing(setErr)), Effect.sync(() => {
      setBusy(null);
    }));
  });

  const decide = (row: InstructionSourceRow, action: "approve" | "revoke") => Effect.gen(function* () {
    setBusy(row.path);
    setErr(null);

    return yield* Effect.ensuring(Effect.catchCause(Effect.gen(function* () {
      if (action === "approve") {
        // Approval binds the digest the owner was just shown; if the file moved on, nothing is granted.
        const opened = open?.path === row.path
          ? open
          : (yield* Effect.promise(async () => rpc("readInstructionApproval", [row.path])));

        if (!opened) {
          setErr("Kinu could not read that file, so nothing was approved. Try again.");

          return;
        }

        yield* Effect.promise(async () => rpc("approveInstruction", [row.path, opened.digest]));
      } else {
        yield* Effect.promise(async () => rpc("revokeInstruction", [row.path]));
      }

      setOpen(null);
      reload();
    }), showing(setErr)), Effect.sync(() => {
      setBusy(null);
    }));
  });

  const rows = page?.items ?? null;

  if (resource.status !== "error" && rows !== null && rows.length === 0 && !cursor) return null;

  return (
    <Card title="Workspace instruction files">
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
            const state = row.reason === undefined ? decisionWord(row) : `not readable: ${row.reason}`;
            const followed = row.decision === "approved";
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
                      onClick={() => detach(read(row))}
                      disabled={busy !== null}
                      className="ml-auto px-2 py-0.5 rounded-sm p-card-hover p-text-3 hover:p-text disabled:opacity-50 shrink-0"
                    >{busy === row.path ? "…" : readWord}</button>
                  )}
                  {followed && (
                    <button
                      type="button"
                      onClick={() => detach(decide(row, "revoke"))}
                      disabled={busy !== null}
                      className={`${row.reason === undefined ? "" : "ml-auto "}px-2 py-0.5 rounded-sm p-card-hover p-text-3 hover:p-text disabled:opacity-50 shrink-0`}
                      title="Stop following this file as instructions"
                    >Revoke</button>
                  )}
                  {!followed && row.reason === undefined && (
                    <button
                      type="button"
                      onClick={() => detach(decide(row, "approve"))}
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
  rpc: WorkspaceRpc;
  workspace: string;
}) {
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const download = useCallback(() => detach(Effect.gen(function* () {
    setBusy(true);
    setErr(null);
    setStatus("Exporting…");

    return yield* Effect.ensuring(Effect.catchCause(Effect.gen(function* () {
      const parts: string[] = [];
      let cursor: ArchiveCursor | null = null;
      let records = 0;

      do {
        const page = yield* Effect.promise(async () => rpc("exportWorkspaceArchive", [cursor]));
        parts.push(page.lines.map((line) => `${line}\n`).join(""));
        records += page.lines.length;
        cursor = page.next;
        setStatus(`Exporting… ${records} records`);
      } while (cursor);

      const url = URL.createObjectURL(new Blob(parts, { type: "application/x-ndjson" }));

      yield* Effect.ensuring(Effect.sync(() => {
        const link = document.createElement("a");
        link.href = url;
        link.download = `${workspace}${WORKSPACE_ARCHIVE_EXTENSION}`;
        link.click();
      }), Effect.sync(() => {
        URL.revokeObjectURL(url);
      }));

      setStatus(`Downloaded ${records} records.`);
    }), showing((chain) => {
      setStatus(null);
      setErr(chain);
    })), Effect.sync(() => {
      setBusy(false);
    }));
  })), [rpc, workspace]);

  return (
    <Card title="Backup">
      <p className="p-meta p-text-3">
        Download an archive of this workspace: transcripts, memory, files and evolution history. Restore it
        with <code className="font-mono">kinu import &lt;file&gt;</code>. Download one before you delete a
        workspace. The archive holds everything in the workspace, so keep it as safe as a password.
      </p>
      <Button variant="primary" size="sm" onClick={() => detach(Effect.promise(async () => { await download(); }))} disabled={busy || !workspace}>
        {busy ? "Exporting…" : "Download archive"}
      </Button>
      {status && <div className="p-meta p-text-2 mt-1">{status}</div>}
      {err && <div className="p-meta p-danger mt-1">Export failed: {err}</div>}
    </Card>
  );
}

function AlwaysActiveSkillsCard({
  rpc,
}: {
  rpc: WorkspaceRpc;
}) {
  const load = useCallback(async () => (await rpc('getAlwaysActiveSkills', [])).names, [rpc]);
  const pinned = useAsyncResource(load);
  const names = lastValue(pinned.resource) ?? [];
  const publish = pinned.set;
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [saveErr, setErr] = useState<string | null>(null);
  const err = saveErr ?? (pinned.resource.status === 'error' ? pinned.resource.message : null);

  const save = useCallback((next: string[]) => settle(Effect.gen(function* () {
    setBusy(true);
    setErr(null);

    return yield* Effect.ensuring(Effect.catchCause(Effect.gen(function* () {
      publish((yield* Effect.promise(async () => rpc('setAlwaysActiveSkills', [next]))).names);
    }), showing(setErr)), Effect.sync(() => { setBusy(false); }));
  })), [rpc, publish]);

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
    <Card title="Always-active skills">
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
              <button type="button" onClick={() => detach(Effect.promise(async () => { await remove(n); }))} aria-label={`Unpin ${n}`} className="p-text-3 hover:p-text">×</button>
            </span>
          ))}
      </div>
      <div className="flex gap-2 mt-2">
        <input
          type="text"
          value={input}
          placeholder="skill-name"
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => detach(Effect.promise(async () => { if (e.key === 'Enter' && !composing(e.nativeEvent)) await add(); }))}
          className={inputCls + " text-xs"}
        />
        <Button variant="primary" size="sm" onClick={() => detach(Effect.promise(async () => { await add(); }))} disabled={busy || !input.trim()}>Pin</Button>
      </div>
      {err && <div className="p-meta p-danger mt-1">{err}</div>}
    </Card>
  );
}


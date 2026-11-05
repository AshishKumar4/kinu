import { Effect, Cause } from 'effect';
import { SaveBar } from "@/components/ui/SaveBar";
import { startTransition, useState, useEffect, useCallback, useRef } from "react";
import { Link } from "react-router-dom";
import { Loader } from "@/components/ui/Loader";
import { Button, buttonClass } from "@/components/ui/Button";
import { GearSixIcon, KeyIcon, TrashIcon } from "@phosphor-icons/react";
import { Page } from "@/components/ui/PageHeader";
import {
  ADVISOR_SEVERITIES, ADVISOR_SEVERITY_LABEL, DEFAULT_ADVISOR_MIN_SEVERITY,
  type ApprovalGrant, type EvolutionConfigView,
  type InstructionSourceRow, type InstructionSourceView, type SeekCursor, type ShellApprovalMode, WORKSPACE_TITLE_MAX,
} from "@kinu.run/core";
import { useWorkspaceRoster } from "@/hooks/use-workspace-roster";
import { executorLabel } from "@kinu.run/core";
import type { ConnectionStatus } from "@/hooks/use-chat-owner";
import type { AgentStatus, WorkspaceLayout, WorkspaceNotice } from "@kinu.run/core";
import { WorkspaceAutomations } from "@/components/WorkspaceAutomations";
import { Card } from "@/components/ui/Card";
import { CopyField } from "@/components/ui/CopyField";
import { Chip } from "@/components/ui/Chip";
import { Group } from "@/components/ui/Group";
import { Preformatted } from "@/components/ui/Preformatted";
import { Segmented } from "@/components/ui/Segmented";
import { LoadFailure } from "@/components/ui/LoadFailure";
import { CardSlot } from "@/components/ui/CardSlot";
import { WorkspaceLogo } from "@/components/ui/Marks";
import { type AsyncResource, lastValue, loadFailed, loadSucceeded, useAsyncResource } from "@/hooks/use-async-resource";
import { renderThrownChain, settle } from '@kinu.run/core/obs';
import { useLabelledStep } from '@/hooks/use-labelled-step';
import type { WorkspaceRpc } from "@/lib/workspace-rpc";
import { downloadWorkspaceArchive } from "@/lib/workspace-archive";
import { Notice } from "@/components/ui/Notice";
import { TextArea, TextInput, Field, composing } from "@/components/ui/Field";

const APPROVAL_LABEL: Record<ShellApprovalMode, string> = {
  strict: "Strict",
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
  /** Puts the read value back: the edit is dropped. */
  discard: () => void;
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
    edit, hydrate, fail, markSaved, discard: () => setEdited(null),
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
  const { busy, error: note, run } = useLabelledStep();

  const redraw = (): void => run("draw", () => Effect.gen(function* () {
    const { drawn, refusal } = yield* Effect.promise(() => rpc("regenerateWorkspaceLogo", []));

    if (!drawn) return yield* Effect.fail(refusal ?? "The model's drawing could not be used; the monogram stays. Try again.");
  }));

  return (
    <Field label="Logo">
      <div className="flex items-center gap-3" data-logo-field>
        <WorkspaceLogo title={title} logo={logo} size={40} />
        <Button size="sm" onClick={redraw} busy={busy !== null}>
          {busy !== null ? "Drawing…" : "Draw a new one"}
        </Button>
      </div>
      {note && <p className="t-meta p-text-3">{note}</p>}
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

  const { busy, error: err, run } = useLabelledStep();
  const saving = busy !== null;

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

  // Each field is marked saved as its own write lands, so a failed one is all that stays dirty and is named.
  const save = (): void => {
    // Only edited fields are written; the form has no authority over fields still loading or failed.
    const writes: Array<{ readonly what: string; readonly run: () => Promise<void> }> = [];

    const write = <T,>(what: string, field: SettingField<T>, put: (value: T) => Promise<object>) => {
      const { value } = field;

      if (!field.dirty || value === null) return;
      writes.push({ what, run: async () => { await put(value); field.markSaved(value); } });
    };

    write("the name", displayName, async (name) => {
      const titled = await rpc("setDisplayName", [name]);

      rename(agentId, titled.displayName);

      return titled;
    });
    write("SOUL.md", soul, (text) => rpc("setSoul", [text]));
    write("the layout", layout, (chosen) => rpc("setLayout", [chosen]));
    write("shell approval", approval, (mode) => rpc("setShellApprovalMode", [mode]));
    write("the advisor", advisor, (config) => rpc("setEvolutionConfig", [config]));

    if (writes.length === 0) return;

    run("save", () => Effect.gen(function* () {
      const settled = yield* Effect.promise(async () => Promise.allSettled(writes.map((each) => each.run())));
      const unsaved = settled.flatMap((result, at) => (result.status === "rejected" ? [`${writes[at]?.what ?? "a field"}: ${renderThrownChain({ cause: result.reason })}`] : []));

      if (unsaved.length > 0) return yield* Effect.fail(`Not saved: ${unsaved.join("; ")}`);
    }));
  };

  if (connectionStatus !== "connected") {
    return (
      <div className="t-body flex min-h-0 flex-1 flex-col items-center justify-center gap-3 p-text-2">
        {connectionStatus === "connecting" ? (
          <><Loader size="base" /><span>Connecting to {agentId}…</span></>
        ) : (
          <span className="p-danger">Not connected to this workspace. Settings cannot load or save until it reconnects.</span>
        )}
      </div>
    );
  }

  return (
    <Page fill icon={<GearSixIcon size={22} />} title="Settings" data-workspace-settings
      actions={<Link to="/user/settings" className={buttonClass({ variant: "ghost" })}><KeyIcon size={14} />Account settings</Link>}>
      {err && <Notice tone="danger">{err}</Notice>}

      <div className="space-y-5">
      <Card title="Identity">
        <LogoField title={title} logo={logo} rpc={rpc} />
        <Field label="Address">
          <CopyField value={agentId} what="the workspace's address" />
        </Field>
        <Field label="Display name">
          <FieldState field={displayName} what="the display name" onRetry={retryLoad}>
            {(value) => (
              <TextInput aria-label="Display name" value={value} maxLength={WORKSPACE_TITLE_MAX} onChange={(e) => displayName.edit(e.target.value)} />
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
              <TextArea mono value={value} onChange={(e) => soul.edit(e.target.value)} rows={8} placeholder={"# Agent name\n\n## Mission\n\nWhat is this agent for?"} />
            )}
          </FieldState>
        </Field>
      </Card>


      <Card title="Advisor">
        <FieldState field={advisor} what="the advisor settings" onRetry={loadRpcFields}>
          {(value) => (
            <>
              <div className="space-y-2">
                <label className="t-status block p-text-2">Second opinion</label>
                <div className="flex">
                  <Segmented label="Second opinion" value={value.advisorEnabled ? "on" : "off"} segments={ADVISOR_SWITCH}
                    onChange={(id) => advisor.edit({ ...value, advisorEnabled: id === "on" })} />
                </div>
              </div>
              <div className="space-y-2">
                <label className="t-status block p-text-2">Minimum severity</label>
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
            <div className="flex">
              <Segmented label="Shell-command approval" value={value} onChange={(chosen) => approval.edit(chosen)}
                segments={(['strict', 'allow_all', 'deny_all'] satisfies ShellApprovalMode[]).map((mode) => ({ id: mode, label: APPROVAL_LABEL[mode] }))} />
            </div>
          )}
        </FieldState>
      </Card>
      <StandingApprovalsCard rpc={rpc} />
      <InstructionApprovalsCard rpc={rpc} />


      <AlwaysActiveSkillsCard rpc={rpc} />

      <div id="automations"><Card><WorkspaceAutomations rpc={rpc} workspace={agentId} /></Card></div>

      <WorkspaceBackupCard rpc={rpc} workspace={agentId} />

      <Card title="Main's conversation">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <p className="t-meta p-text-3">Clearing removes Main's messages. Memory, SOUL.md, learned tools and evolution stay.</p>
          <Button size="sm" variant="secondary" icon={<TrashIcon size={12} />} onClick={clearMain}>Clear history</Button>
        </div>
      </Card>
      </div>
      <SaveBar dirty={dirty} saving={saving} onSave={save}
        onDiscard={() => { for (const field of [displayName, soul, layout, approval, advisor]) field.discard(); }} />
    </Page>
  );
}

/** A grant is scoped to one rule on one executor: it stops the asking, never widens reach, and cannot soften a refused rule. */
export function StandingApprovalsCard({ rpc }: { rpc: WorkspaceRpc }) {

  const load = useCallback(
    async () => (await rpc("getShellApprovalGrants", [])).grants,
    [rpc],
  );

  const { resource, reload } = useAsyncResource(load);
  const grants = lastValue(resource);

  const { busy, error: err, run } = useLabelledStep(reload);
  const revoke = (grant: ApprovalGrant): void => run(`${grant.rule}@${grant.executor}`, async () => rpc("revokeShellApprovalGrants", [[grant]]));

  if (resource.status !== "error" && grants !== null && grants.length === 0) return null;

  return (
    <Card title="Standing approvals">
      <p className="t-meta p-text-3">
        “Always” stops Kinu asking about this check in this environment. It does not give the agent any more access.
      </p>
      {resource.status === "error" && grants === null && (
        <LoadFailure what="your standing approvals" message={resource.message} onRetry={reload} />
      )}
      {resource.status !== "error" && grants === null && <p className="t-meta p-text-3">Loading…</p>}
      {grants !== null && (
        <Group>
          {grants.map((grant) => (
            <div key={`${grant.rule}@${grant.executor}`} className="t-meta flex items-center gap-2 py-2">
              <code className="t-mono p-text">{grant.rule}</code>
              <span className="p-text-3">on</span>
              <span className="p-text-2">{executorLabel(grant.executor)}</span>
              <Button variant="ghost" size="sm" className="ml-auto" onClick={() => revoke(grant)} disabled={busy !== null}
                busy={busy === `${grant.rule}@${grant.executor}`}
                title={`Ask again next time a command trips ${grant.rule} on ${executorLabel(grant.executor)}`}>Revoke</Button>
            </div>
          ))}
        </Group>
      )}
      {err && <div className="t-meta p-danger mt-1">{err}</div>}
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

  const { busy, error: err, run } = useLabelledStep();

  // Opening a row reads that file only; the listing carries no bytes.
  const read = (row: InstructionSourceRow): void => {
    if (open?.path === row.path) {
      setOpen(null);

      return;
    }

    run(row.path, async () => setOpen(await rpc("readInstructionApproval", [row.path])));
  };

  const decide = (row: InstructionSourceRow, action: "approve" | "revoke"): void => run(row.path, () => Effect.gen(function* () {
    if (action === "approve") {
      // Approval binds the digest the owner was just shown; if the file moved on, nothing is granted.
      const opened = open?.path === row.path
        ? open
        : (yield* Effect.promise(async () => rpc("readInstructionApproval", [row.path])));

      if (!opened) return yield* Effect.fail("Kinu could not read that file, so nothing was approved. Try again.");

      yield* Effect.promise(async () => rpc("approveInstruction", [row.path, opened.digest]));
    } else {
      yield* Effect.promise(async () => rpc("revokeInstruction", [row.path]));
    }

    setOpen(null);
    reload();
  }));

  const rows = page?.items ?? null;

  if (resource.status !== "error" && rows !== null && rows.length === 0 && !cursor) return null;

  return (
    <Card title="Workspace instruction files">
      <p className="t-meta p-text-3">
        Your agent can write these files. Kinu follows a file as instructions only when you approve its
        contents. After any edit it becomes reference material again until you approve it again.
      </p>
      {resource.status === "error" && rows === null && (
        <LoadFailure what="this workspace's instruction files" message={resource.message} onRetry={reload} />
      )}
      {resource.status !== "error" && rows === null && <p className="t-meta p-text-3">Loading…</p>}
      {rows !== null && (
        <div className="space-y-1">
          {rows.map((row) => {
            const opened = open?.path === row.path ? open : null;
            const state = row.reason === undefined ? decisionWord(row) : `not readable: ${row.reason}`;
            const followed = row.decision === "approved";
            const readWord = opened === null ? "Read" : "Hide";

            return (
              <div key={row.path} className="space-y-1 py-2">
                <div className="t-meta flex items-center gap-2">
                  <code className="t-mono p-text truncate" title={row.path}>{row.path}</code>
                  <span className="p-text-3 shrink-0">
                    {row.kind === "skill" ? "skill" : "AGENTS.md"} · {row.bytes} bytes
                  </span>
                  <span className="p-text-3 shrink-0">{state}</span>
                  {row.reason === undefined && (
                    <Button variant="ghost" size="sm" className="ml-auto shrink-0" onClick={() => read(row)} disabled={busy !== null}
                      busy={busy === row.path}>{readWord}</Button>
                  )}
                  {followed && (
                    <Button variant="ghost" size="sm" className={row.reason === undefined ? "shrink-0" : "ml-auto shrink-0"} onClick={() => decide(row, "revoke")}
                      disabled={busy !== null} title="Stop following this file as instructions">Revoke</Button>
                  )}
                  {!followed && row.reason === undefined && (
                    <Button size="sm" className="shrink-0" onClick={() => decide(row, "approve")} disabled={busy !== null}
                      title="Follow these exact contents as instructions">Approve</Button>
                  )}
                </div>
                {opened && (
                  <>
                    <Preformatted className="max-h-64">{opened.preview}</Preformatted>
                    <div className="t-meta t-mono p-text-3 break-all">{opened.digest}</div>
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
            <Button variant="ghost" size="sm" onClick={() => { setCursor(undefined); setOpen(null); }}>First page</Button>
          )}
          {page?.status === "more" && (
            <Button variant="ghost" size="sm" onClick={() => { setCursor(page.next); setOpen(null); }}>More</Button>
          )}
        </div>
      )}
      {err && <div className="t-meta p-danger mt-1">{err}</div>}
    </Card>
  );
}

function WorkspaceBackupCard({
  rpc, workspace,
}: {
  rpc: WorkspaceRpc;
  workspace: string;
}) {
  const [status, setStatus] = useState<string | null>(null);
  const { busy, error: err, run } = useLabelledStep();

  const download = (): void => run("export", () => Effect.gen(function* () {
    setStatus("Exporting…");
    const records = yield* downloadWorkspaceArchive(rpc, workspace, (read) => setStatus(`Exporting… ${read} records`));

    setStatus(`Downloaded ${records} records.`);
  }).pipe(Effect.tapCause(() => Effect.sync(() => setStatus(null)))));

  return (
    <Card title="Backup">
      <p className="t-meta p-text-3">
        Download an archive of this workspace: transcripts, memory, files and evolution history. Restore it
        with <code className="font-mono">kinu import &lt;file&gt;</code>. Download one before you delete a
        workspace. The archive holds everything in the workspace, so keep it as safe as a password.
      </p>
      <Button variant="primary" size="sm" onClick={download} busy={busy !== null} disabled={!workspace}>
        {busy !== null ? "Exporting…" : "Download archive"}
      </Button>
      {status && <div className="t-meta p-text-2 mt-1">{status}</div>}
      {err && <div className="t-meta p-danger mt-1">Export failed: {err}</div>}
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
  const { busy, error: saveErr, run } = useLabelledStep();
  const err = saveErr ?? (pinned.resource.status === 'error' ? pinned.resource.message : null);

  const save = (next: string[]): void => run('save', async () => publish((await rpc('setAlwaysActiveSkills', [next])).names));

  const add = (): void => {
    const n = input.trim();

    if (!n) return;
    setInput('');

    if (!names.includes(n)) save([...names, n]);
  };

  return (
    <Card title="Always-active skills">
      <p className="t-meta p-text-3">
        Pin a workflow skill, such as <code className="font-mono">audit-implementation</code>, and it runs
        every turn without you typing /name.
      </p>
      <div className="flex flex-wrap gap-2">
        {names.length === 0
          ? <span className="t-meta p-text-3">No skills pinned.</span>
          : names.map(n => (
            <Chip key={n} removeLabel={`Unpin ${n}`} onRemove={() => save(names.filter((x) => x !== n))}><span className="t-mono">{n}</span></Chip>
          ))}
      </div>
      <div className="flex gap-2 mt-2">
        <TextInput size="sm" value={input} placeholder="skill-name" onChange={(e) => setInput(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter' && !composing(e.nativeEvent)) add(); }} />
        <Button variant="primary" size="sm" onClick={add} disabled={busy !== null || !input.trim()}>Pin</Button>
      </div>
      {err && <div className="t-meta p-danger mt-1">{err}</div>}
    </Card>
  );
}


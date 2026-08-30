/**
 * Per-agent settings page. Credentials + defaults live in /user/settings;
 * this page covers concerns scoped to ONE agent: identity, model choice,
 * MCTS knobs, shell-approval mode, GEPA optimisation, pinned skills.
 * (Scaffold promote/rollback + the per-trial verdict live on the Self surface.)
 */
import { useState, useEffect, useCallback, useRef } from "react";
import { useParams, Link } from "react-router-dom";
import { Loader } from "@cloudflare/kumo";
import {
  FloppyDiskIcon, BrainIcon, CheckIcon, ArrowLeftIcon,
  ShieldIcon, TreeStructureIcon, KeyIcon, PlugIcon, SparkleIcon,
  DesktopTowerIcon, DownloadSimpleIcon, EyeIcon,
} from "@phosphor-icons/react";
import {
  ADVISOR_SEVERITIES, ADVISOR_SEVERITY_LABEL, DEFAULT_ADVISOR_MIN_SEVERITY,
  WORKSPACE_ARCHIVE_EXTENSION, formatScoreInterval,
  type ApprovalGrant, type ArchiveCursor, type ArchivePage, type EvolutionConfigView,
  type JsonValue, type InstructionSourceRow, type InstructionSourceView,
  type Page, type SeekCursor,
} from "@kinu.run/core";
import { executorLabel } from "@/lib/executors";
import { useKinu } from "@/hooks/use-kinu";
import {
  listDevices, listDeviceConsents, setDeviceConsentScope,
  type UserDevice, type DeviceConsentScope,
} from "../lib/user-api";
import { Card, inputCls } from "@/components/ui/form";
import { CopyButton } from "@/components/ui/CopyButton";
import { LoadFailure } from "@/components/ui/LoadFailure";
import { type AsyncResource, lastValue, loadFailed, loadSucceeded, useAsyncResource } from "@/hooks/use-async-resource";
import type { Rpc } from '@/lib/protocol';
import * as v from 'valibot';
import { renderThrownChain } from '@kinu.run/core/obs';

const ArchiveCursorSchema = v.variant('phase', [
  v.object({ phase: v.literal('sql'), table: v.string(), after: v.nullable(v.number()), rows: v.number() }),
  v.object({ phase: v.literal('files'), after: v.string(), rows: v.number(), files: v.number() }),
]);
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

interface MctsConfig {
  explorationConstant: number;
  maxIterations: number;
  maxDepth: number;
  branchBudget: number;
}

/** The advisor's two knobs, as the slice of the evolution config they ride on. */
type AdvisorConfig = Pick<EvolutionConfigView, "advisorEnabled" | "advisorMinSeverity">;


/**
 * One settings field: an AsyncResource read from the server with the user's
 * in-progress edit layered on top, written back only when that edit exists.
 *
 * Save used to write every field unconditionally, gated on the socket being
 * open rather than on the data having arrived — so saving before hydration, or
 * after a read whose `.catch` substituted a default, wiped SOUL.md and reset
 * tuned MCTS values to whatever placeholder the form happened to hold. A field
 * that never loaded has nothing to save, and says so instead of guessing.
 */
interface SettingField<T> {
  resource: AsyncResource<T>;
  /** What the form shows: the pending edit if there is one, else what loaded. */
  value: T | null;
  dirty: boolean;
  edit: (value: T) => void;
  hydrate: (value: T) => void;
  fail: <Failure>(error: Failure) => void;
  /** Commit a written value: it is now both the stored value and clean. */
  markSaved: (value: T) => void;
}

function useSettingField<T>(): SettingField<T> {
  const [resource, setResource] = useState<AsyncResource<T>>({ status: "loading" });
  // Boxed so `null` stays a legal edited value and absence stays distinguishable.
  const [edited, setEdited] = useState<{ value: T } | null>(null);

  const edit = useCallback((next: T) => setEdited({ value: next }), []);
  // A later refresh updates the stored value without disturbing the edit in
  // progress — the form keeps showing what the user typed.
  const hydrate = useCallback((next: T) => setResource(loadSucceeded(next)), []);
  const fail = useCallback(<Failure,>(error: Failure) => setResource((prev) => loadFailed(prev, error)), []);
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

/**
 * The tri-state around one editable field, so no card renders a placeholder as
 * if it were the stored setting.
 */
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

export default function SettingsPage() {
  const { agentId } = useParams();
  const state = useKinu(agentId);
  // Stable pieces only — `state` itself is a fresh object every render, so
  // depending on it from load/save creates a self-sustaining refetch loop
  // that clobbers in-progress edits.
  const { rpc, connectionStatus, agentStatus, error: snapshotError, retryLoad } = state;

  const displayName = useSettingField<string>();
  const soul = useSettingField<string>();
  const approval = useSettingField<ApprovalMode>();
  const mcts = useSettingField<MctsConfig>();
  const advisor = useSettingField<AdvisorConfig>();

  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  // Identity rides the workspace snapshot, so it hydrates — or fails — with it.
  const { hydrate: hydrateDisplayName, fail: failDisplayName } = displayName;
  const { hydrate: hydrateSoul, fail: failSoul } = soul;
  useEffect(() => {
    if (agentStatus) {
      hydrateDisplayName(agentStatus.displayName || "");
      hydrateSoul(agentStatus.soul || "");
    } else if (snapshotError) {
      failDisplayName(snapshotError);
      failSoul(snapshotError);
    }
  }, [agentStatus, snapshotError, hydrateDisplayName, hydrateSoul, failDisplayName, failSoul]);

  const { hydrate: hydrateApproval, fail: failApproval } = approval;
  const { hydrate: hydrateMcts, fail: failMcts } = mcts;
  const { hydrate: hydrateAdvisor, fail: failAdvisor } = advisor;
  // A `(): void` reader, the same shape `useAsyncResource` uses: one effect and
  // three retry buttons detach this read and none of them has an `await` to put
  // it in, so the settlement is consumed right here. `allSettled` never
  // rejects, so the trailing `.catch` can only be a defect in the hydrate arm
  // below — and a field the defect skipped would otherwise sit on "Loading…"
  // for the life of the page with nothing said.
  //
  // Named for the fields it reads rather than `load`: four card components in
  // this file declare a `load` of their own, and they are async loaders that
  // DO propagate a rejection, so sharing the name makes both this call and
  // theirs unreadable to anything reasoning by name.
  const loadRpcFields = useCallback((): void => {
    // A read that fails leaves its field unloaded — and so unsaveable — and
    // says so in place of the editor. It never substitutes a default that Save
    // would then write over the stored value.
    Promise.allSettled([
      rpc<{ mode: ApprovalMode }>("getShellApprovalMode", []),
      rpc<MctsConfig>("getMctsConfig", []),
      rpc<EvolutionConfigView>("getEvolutionConfig", []),
    ]).then(([mode, config, evolution]) => {
      if (mode.status === "rejected") failApproval(mode.reason);
      else hydrateApproval(mode.value?.mode ?? "strict");

      if (config.status === "rejected") failMcts(config.reason);
      else if (config.value) hydrateMcts(config.value);
      else failMcts("the agent returned no MCTS config");

      if (evolution.status === "rejected") failAdvisor(evolution.reason);
      else hydrateAdvisor({
        advisorEnabled: evolution.value?.advisorEnabled ?? false,
        advisorMinSeverity: evolution.value?.advisorMinSeverity ?? DEFAULT_ADVISOR_MIN_SEVERITY,
      });
    }).catch((cause: unknown) => {
      failApproval(cause); failMcts(cause); failAdvisor(cause);
    });
  }, [
    rpc, hydrateApproval, failApproval, hydrateMcts, failMcts,
    hydrateAdvisor, failAdvisor,
  ]);

  // Fetch once per agent connection — not on every render.
  const loaded = useRef(false);
  useEffect(() => {
    if (connectionStatus !== "connected" || loaded.current) return;
    loaded.current = true;
    loadRpcFields();
  }, [connectionStatus, loadRpcFields]);

  const dirty = displayName.dirty || soul.dirty || approval.dirty || mcts.dirty
    || advisor.dirty;

  const save = useCallback(async () => {
    // Only edited fields are written. Everything else is either still loading
    // or failed to load, and the form has no authority over it.
    const writes: Array<Promise<JsonValue | undefined | void>> = [];
    const commits: Array<() => void> = [];
    const write = <T,>(field: SettingField<T>, put: (value: T) => Promise<JsonValue | undefined | void>) => {
      const { value } = field;
      if (!field.dirty || value === null) return;
      writes.push(put(value));
      commits.push(() => field.markSaved(value));
    };
    write(displayName, (v) => rpc("setDisplayName", [v]));
    write(soul, (v) => rpc("setSoul", [v]));
    write(approval, (v) => rpc("setShellApprovalMode", [v]));
    write(mcts, (v) => rpc("setMctsConfig", [v]));
    write(advisor, (v) => rpc("setEvolutionConfig", [v]));
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
            <span className="p-danger">Not connected to this workspace. Settings can't be read or saved.</span>
            <Link to={`/workspace/${agentId}`} className="text-xs p-accent underline">Back to chat</Link>
          </>
        )}
      </div>
    );
  }

  return (
    <div className="h-full overflow-y-auto">
      <div className="max-w-3xl mx-auto px-6 py-8 space-y-6">
        <header className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <Link to={`/workspace/${agentId}`} className="text-xs p-text-3 flex items-center gap-1 hover:p-text mb-2">
              <ArrowLeftIcon size={12} /> Back to chat
            </Link>
            <h1 className="p-display text-2xl">Workspace settings</h1>
            <p className="text-xs p-text-3 mt-1 flex flex-wrap items-center gap-x-1.5 gap-y-1">
              <span className="font-mono">{agentId}</span>
              <CopyButton value={agentId ?? ""} what="the workspace slug" size={11}
                className="rounded-sm p-0.5 p-card-hover hover:p-text transition-colors" />
              <span>·</span>
              <Link to="/user/settings" className="hover:p-text inline-flex items-center gap-1">
                <KeyIcon size={11} /> Account settings & credentials
              </Link>
              <span>·</span>
              <Link to={`/workspace/${agentId}?altitude=supervise`} className="hover:p-text inline-flex items-center gap-1">
                <PlugIcon size={11} /> Automations (webhooks, timers)
              </Link>
            </p>
          </div>
          <button
            onClick={save}
            disabled={saving || !dirty}
            title={dirty ? undefined : "No unsaved changes"}
            className="px-4 py-2 rounded-md p-accent-bg p-accent text-xs font-medium hover:opacity-90 transition-opacity disabled:opacity-50 flex items-center gap-2"
          >
            {saved ? <CheckIcon size={14} /> : <FloppyDiskIcon size={14} />}
            <span>{saving ? "Saving…" : saved ? "Saved" : "Save"}</span>
          </button>
        </header>

        {err && <div className="p-card p-3 text-xs p-danger">{err}</div>}

        {/* Identity */}
        <Card title="Identity" icon={BrainIcon}>
          <div className="space-y-1.5">
            <label className="text-xs p-text-2 font-medium">Display name</label>
            <FieldState field={displayName} what="the display name" onRetry={retryLoad}>
              {(value) => (
                <input value={value} onChange={(e) => displayName.edit(e.target.value)} className={inputCls} />
              )}
            </FieldState>
          </div>
          <div className="space-y-1.5">
            <label className="text-xs p-text-2 font-medium">SOUL.md</label>
            <FieldState field={soul} what="SOUL.md" onRetry={retryLoad}>
              {(value) => (
                <textarea value={value} onChange={(e) => soul.edit(e.target.value)} rows={8}
                  className={`${inputCls} font-mono`} placeholder={"# Agent name\n\n## Mission\n\nWhat is this agent for?"} />
              )}
            </FieldState>
          </div>
        </Card>


        {/* Advisor */}
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
                    Off by default. When on, a second model reads each finished turn and can add one note. This adds one model call per turn.
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
                    Notes at or above this severity reach the conversation. Notes below it become Changelog rows. The default is concern.
                  </p>
                </div>
              </>
            )}
          </FieldState>
        </Card>


        {/* Approval */}
        <Card title="Shell-command approval" icon={ShieldIcon}>
          <FieldState field={approval} what="the approval mode" onRetry={loadRpcFields}>
            {(value) => (
              <div className="grid grid-cols-3 gap-2">
                {(['strict', 'allow_all', 'deny_all'] satisfies ApprovalMode[]).map((m) => (
                  <button
                    key={m}
                    onClick={() => approval.edit(m)}
                    className={`p-2 rounded-md text-xs ${value === m ? 'p-accent-bg p-accent' : 'p-card p-card-hover'}`}
                  >{m === 'strict' ? 'Strict (review)' : m === 'allow_all' ? 'Allow all' : 'Deny all'}</button>
                ))}
              </div>
            )}
          </FieldState>
        </Card>
        <StandingApprovalsCard rpc={rpc} />
        <InstructionApprovalsCard rpc={rpc} />

        {/* MCTS knobs */}
        <Card title="MCTS tunables" icon={TreeStructureIcon}>
          <FieldState field={mcts} what="the MCTS tunables" onRetry={loadRpcFields}>
            {(value) => (
              <div className="grid grid-cols-2 gap-3">
                <NumField label="Exploration constant" value={value.explorationConstant} step={0.1} onChange={(v) => mcts.edit({ ...value, explorationConstant: v })} />
                <NumField label="Max iterations" value={value.maxIterations} step={1} onChange={(v) => mcts.edit({ ...value, maxIterations: v })} />
                {/* No depth field. It sat here beside "Max iterations" offering a
                    second spelling of one limit, which is the reading the owner
                    gave it; the engine's own cap owns depth now. */}
                <NumField label="Branch budget" value={value.branchBudget} step={1} onChange={(v) => mcts.edit({ ...value, branchBudget: v })} />
              </div>
            )}
          </FieldState>
        </Card>

        {/* Scaffold shadow rollout — promote/rollback + per-trial verdict now
            live on the agent's Self surface (single source of truth). */}

        {/* Per-agent device file-access tier */}
        {agentId && <DeviceAccessCard agentName={agentId} />}

        {/* Always-active skills */}
        <AlwaysActiveSkillsCard rpc={rpc} />

        {/* Backup */}
        <WorkspaceBackupCard rpc={rpc} workspace={agentId ?? ""} />

        {/* GEPA offline scaffold optimisation */}
        <GepaOptimizationCard rpc={rpc} />
      </div>
    </div>
  );
}

// ── Standing shell approvals ─────────────────────────────────────

/**
 * The grants "Always" minted, and the only way to take one back.
 *
 * `getShellApprovalGrants` / `revokeShellApprovalGrants` have been live
 * `@callable`s with no caller: the queue could hand out a standing permission
 * that nothing in the product could show you or withdraw. It sits under the
 * approval mode because it is the same decision at a finer grain — the mode
 * says whether to ask, and these are the specific questions already answered.
 *
 * A grant is scoped to one rule on one executor and nothing wider. It stops
 * the asking; it never widens what a command can reach, and it cannot soften
 * a rule the gate refuses outright.
 */
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

  // Nothing granted is the common case and says all it has to say in the
  // card above; a permanently empty card is furniture.
  if (resource.status !== "error" && grants !== null && grants.length === 0) return null;
  return (
    <Card title="Standing approvals" icon={ShieldIcon}>
      <p className="p-meta p-text-3">
        Answers you gave with “Always”. Each one stops Kinu asking about that check on that
        environment again. None of them gives it access it did not already have.
      </p>
      {resource.status === "error" && grants === null ? (
        <LoadFailure what="your standing approvals" message={resource.message} onRetry={reload} />
      ) : grants === null ? (
        <p className="text-xs p-text-3">Loading…</p>
      ) : (
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

// ── Workspace instruction files ──────────────────────────────────

/**
 * Which instruction files in this workspace may speak as system instructions
 * (KINU-N028).
 *
 * AGENTS.md and the files under /workspace/skills are read on every turn, and
 * the agent can write all of them with its own file tool and shell. So an
 * approval binds the exact BYTES: the digest below is what was approved, and any
 * later edit stops matching it and drops the file back to reference material
 * without anyone having to notice.
 *
 * "Carried over" rows are the files that were already in the workspace when
 * trust arrived. They were kept at full force so nobody's project rules went
 * quiet on upgrade, but they were never read by you — which is why they say so,
 * and why revoking one is a click.
 */
export function InstructionApprovalsCard({ rpc }: { rpc: Rpc }) {
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

  // Opening a row reads THAT file and nothing else; the listing itself carries
  // no bytes, so a workspace full of agent-written skills costs one page.
  const read = async (row: InstructionSourceRow) => {
    if (open?.path === row.path) { setOpen(null); return; }
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
        // Approval binds the digest the owner was just shown. If the file has
        // moved on, nothing is granted and the row stays reference material.
        const opened = open?.path === row.path
          ? open
          : await rpc<InstructionSourceView | null>("readInstructionApproval", [row.path]);
        if (!opened) { setErr("That file could not be read, so nothing was approved."); return; }
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
        The agent can write these files itself, so only the exact contents you approve are
        followed as instructions. Everything else is passed to it as reference material.
        Editing an approved file drops it back to reference until you approve it again.
      </p>
      {resource.status === "error" && rows === null ? (
        <LoadFailure what="this workspace's instruction files" message={resource.message} onRetry={reload} />
      ) : rows === null ? (
        <p className="text-xs p-text-3">Loading…</p>
      ) : (
        <div className="space-y-1">
          {rows.map((row) => {
            const opened = open?.path === row.path ? open : null;
            const state = row.reason !== undefined
              ? `not readable: ${row.reason}`
              : row.decision === "grandfathered"
                ? "carried over"
                : row.decision === "approved"
                  ? "approved"
                  : row.decision === "revoked" ? "refused" : "not decided";
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
                    >{busy === row.path ? "…" : opened ? "Hide" : "Read"}</button>
                  )}
                  {row.decision === "approved" || row.decision === "grandfathered" ? (
                    <button
                      type="button"
                      onClick={async () => { await decide(row, "revoke"); }}
                      disabled={busy !== null}
                      className={`${row.reason === undefined ? "" : "ml-auto "}px-2 py-0.5 rounded-sm p-card-hover p-text-3 hover:p-text disabled:opacity-50 shrink-0`}
                      title="Stop following this file as instructions"
                    >Revoke</button>
                  ) : row.reason === undefined ? (
                    <button
                      type="button"
                      onClick={async () => { await decide(row, "approve"); }}
                      disabled={busy !== null}
                      className="px-2 py-0.5 rounded-sm p-card-hover p-text-2 hover:p-text disabled:opacity-50 shrink-0"
                      title="Follow these exact contents as instructions"
                    >Approve</button>
                  ) : null}
                </div>
                {opened && (
                  <>
                    <pre className="text-[11px] leading-[16px] p-text-2 whitespace-pre-wrap break-words
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

// ── Per-agent device file-access tier ────────────────────────────

/** The grant surface for the laptop executor's full-filesystem consent tier — a workspace
 *  concern (this agent's tier on your connected device), while device
 *  registration itself is account-level (Account settings → Devices). By
 *  default the laptop file plane reaches only the consented folder (connect dir /
 *  home); this flips THIS agent's tier via setDeviceConsentScope — the same
 *  remembered policy the hub enforces. */
function DeviceAccessCard({ agentName }: { agentName: string }) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  // `null` = the listing succeeded and no device is connected. A failed
  // listing must not render that same "register a device" state — it sends the
  // user off to re-enrol a device that is already there.
  const load = useCallback(async (): Promise<{ device: UserDevice; scope: DeviceConsentScope } | null> => {
    const connected = (await listDevices()).find((d) => d.connected);
    if (!connected) return null;
    const consents = await listDeviceConsents();
    const row = consents.find((c) => c.agentName === agentName && c.deviceId === connected.id);
    return { device: connected, scope: row?.scope ?? "all_local_actions" };
  }, [agentName]);
  const { resource, reload } = useAsyncResource(load);
  const current = lastValue(resource);

  const full = current?.scope === "full_filesystem";
  const toggle = async () => {
    if (!current) return;
    setBusy(true);
    setErr(null);
    try {
      await setDeviceConsentScope(current.device.id, agentName, full ? "all_local_actions" : "full_filesystem");
      reload();
    } catch (e) {
      setErr(renderThrownChain({ cause: e }));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card title="Device access" icon={DesktopTowerIcon}>
      <p className="p-meta p-text-3">
        By default this workspace can use native file actions only inside the
        connected folder. Full access also enables the unrestricted shell.
      </p>
      {resource.status === "error" && !current ? (
        <LoadFailure what="your connected devices" message={resource.message} onRetry={reload} />
      ) : resource.status === "loading" ? (
        <p className="text-xs p-text-3">Checking connected devices…</p>
      ) : !current ? (
        <p className="text-xs p-text-3">
          No device connected. Register one under{" "}
          <Link to="/user/settings#devices" className="p-accent underline">Account settings → Devices</Link>.
        </p>
      ) : (
        <div className="flex items-center gap-2 text-xs">
          <span className="p-text-3">Access on {current.device.label}:</span>
          <span className={`font-medium ${full ? "p-warning" : "p-text-2"}`}>
            {full ? "Full filesystem + shell" : "Consented folder; no shell"}
          </span>
          {err && <span className="p-danger truncate">{err}</span>}
          <button
            onClick={async () => { await toggle(); }}
            disabled={busy}
            className="ml-auto px-2 py-1 rounded-sm p-card p-card-hover p-text-2 disabled:opacity-50"
            title={full
              ? "Restrict this agent to native file actions inside the consented folder"
              : "Allow this agent to use the full filesystem and unrestricted shell"}
          >
            {busy ? "…" : full ? "Restrict to folder" : "Allow full access"}
          </button>
        </div>
      )}
    </Card>
  );
}

// ── Workspace backup ─────────────────────────────────────────────

/** Download this workspace's archive — the same format `kinu export`
 *  writes and `kinu import` restores. The export RPC answers one bounded
 *  page at a time, so the browser walks the cursor and assembles the file
 *  locally; a workspace with a long history takes several pages, and the
 *  record count is shown while it does. */
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
        Download everything this workspace holds (transcripts, memory, files, evolution
        history) as a portable archive. Restore it on any machine with{" "}
        <code className="font-mono">kinu import &lt;file&gt;</code>. Take one before you
        delete a workspace: deletion is permanent. The archive contains your workspace's
        full contents, so keep it somewhere you'd keep a password.
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

// ── GEPA offline optimisation ────────────────────────────────────

function GepaOptimizationCard({
  rpc,
}: {
  rpc: Rpc;
}) {
  const [running, setRunning] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  // "No optimisation runs yet" is a claim about the agent's own tuning
  // history, so it may only be made about a listing that actually came back.
  const load = useCallback(
    async () => v.parse(v.array(GepaRunSchema), await rpc('getGepaRuns', [10])),
    [rpc],
  );
  const { resource, reload } = useAsyncResource(load);
  const runs = lastValue(resource) ?? [];

  const run = useCallback(async () => {
    setRunning(true);
    setMsg('Optimising: running candidate scaffolds against recent tasks (this can take a few minutes)…');
    try {
      // No evalSize override — the agent's configured budget is the one
      // tuned against cost, and a smaller one cannot resolve a winner.
      const r = v.parse(GepaOptimizationResultSchema,
        await rpc('runScaffoldGepaOptimization', [{ maxIterations: 4 }]));
      const scores = r.bestScore && r.seedScore
        ? `best ${formatScoreInterval(r.bestScore)} vs seed ${formatScoreInterval(r.seedScore)}`
        : '';
      const scoredOn = r.selection
        ? ` Scored on ${r.selection.heldOutNegatives} unseen failure(s) + ${r.selection.guards} accepted guard(s).`
        : '';
      const caveat = r.selectionWarning ? ` Caveat: ${r.selectionWarning}.` : '';
      if (!r.ok) setMsg(`No run: ${r.error}`);
      else if (r.proposed) {
        setMsg(`Improved scaffold proposed as v${r.pendingVersion} (${scores}). It will shadow-eval, then you can promote it from the agent's Self surface.${scoredOn}${caveat}`);
      } else {
        setMsg(`No improvement found (${r.skipReason ?? 'seed already best'}; ${scores}).${scoredOn}${caveat}`);
      }
      reload();
    } catch (e) {
      setMsg(`Error: ${renderThrownChain({ cause: e })}`);
    } finally {
      setRunning(false);
    }
  }, [rpc, reload]);

  return (
    <Card title="Scaffold self-tuning" icon={SparkleIcon}>
      <p className="p-meta p-text-3">
        Offline genetic-Pareto optimisation: runs candidate inference loops against your
        agent's recent tasks, judges each, and proposes an improved scaffold for shadow eval.
        Costs several LLM calls per run.
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
              <span className={`size-1.5 rounded-full ${r.status === 'completed' ? 'p-dot-success' : r.status === 'running' ? 'p-dot-warning' : 'p-dot-neutral'}`} />
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

// ── Scaffold pending detail + promote/rollback controls ──────────

// ── Always-active skills pinning ─────────────────────────────────

function AlwaysActiveSkillsCard({
  rpc,
}: {
  rpc: Rpc;
}) {
  const [names, setNames] = useState<string[]>([]);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  // The card's own `(): void` reader — see the page-level `load` above. The
  // terminal `.catch` also covers a schema failure raised from the success
  // arm, which is exactly what the try/catch it replaced covered.
  const refresh = useCallback((): void => {
    rpc('getAlwaysActiveSkills', [])
      .then((raw) => { setNames(v.parse(SkillNamesSchema, raw).names); })
      .catch((cause: unknown) => { setErr(renderThrownChain({ cause })); });
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
    if (names.includes(n)) { setInput(''); return; }
    setInput('');
    await save([...names, n]);
  }, [input, names, save]);

  const remove = useCallback(async (n: string) => {
    await save(names.filter(x => x !== n));
  }, [names, save]);

  return (
    <Card title="Always-active skills" icon={KeyIcon}>
      <p className="p-meta p-text-3">
        Skills pinned here are activated every turn for this agent. Use to lock-in
        workflow conventions (e.g., <code className="font-mono">audit-implementation</code>) without typing /name.
      </p>
      <div className="flex flex-wrap gap-1.5">
        {names.length === 0
          ? <span className="p-meta p-text-3 italic">(none pinned)</span>
          : names.map(n => (
            <span key={n} className="inline-flex items-center gap-1 px-2 py-0.5 rounded-sm p-card p-meta font-mono">
              {n}
              <button type="button" onClick={async () => { await remove(n); }} className="p-text-3 hover:p-text">×</button>
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

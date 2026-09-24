/** Shared UI domain types for the agent RPC surface (@callable methods). */

import type { ActivityLogEntry } from './identity/activity-log';
import type { ContextComposition } from './context-meter';
import type { HeadReportStatus, HeadUnsettledStatus } from './heads/types';
import type { StepTelemetry } from './events/step-stats';
import type { Usage } from './usage';
import type { WorkspaceSpend } from './read-models/workspace-spend';
import type { CommandResult } from './execution/exec-result';
import type { MemoryNote } from './memory/note';

/** A journalled branch's lifecycle in the head journal's own vocabulary; distinct from the drawing vocabulary of {@link ForkNode.status}. */
export type ForkNodeLifecycle = HeadReportStatus | HeadUnsettledStatus;

/** One branch of a fork: a search is a deep scored tree, a merge is depth 1. `value`/`visits` are null when branches were not scored. */
export interface ForkNode {
	id: string;
	parentId: string | null;
	depth: number;
	/** The node's own score in [0,1] (`search_node_scores`), not its rollout mean; null when the fork did
	 *  not compete its branches or nothing scored this one. */
	value: number | null;
	/** Rollouts spent here; null when the fork did not compete its branches. */
	visits: number | null;
	/** Drawing vocabulary: `running` is heads only; `terminal` is the branch a competition settled on. */
	status: "open" | "pruned" | "terminal" | "failed" | "running";
	action: string;
	children: ForkNode[];
	task?: string;
	observation?: string;
	codeUsed?: string | null;
	createdAt?: number;
	/** The head journal's recorded word, shown to the reader; absent for a search node. */
	lifecycle?: ForkNodeLifecycle;
}

/** Whether the gated right-pane tabs have content (`getWorkspaceTabPresence`, also seeded into `getWorkspaceSnapshot`). */
export interface TabPresence {
	/** Plans, tasks (retained history counts), pending actions, jobs, changes, or notes. */
	work: boolean;
	/** At least one change. */
	releases: boolean;
	explorations: boolean;
}

export interface ToolInfo {
	name: string;
	/** One-line headline for a list row; never derived by splitting `description`. */
	summary: string;
	/** Full docstring the model sees; shown on demand. */
	description: string;
	/** Crafted by the agent rather than shipped. */
	learned: boolean;
	/** Reach as declared by `TOOL_REACH`; a crafted tool is `codemode`. */
	exposure: "native" | "codemode" | "both";
	/** Whether this agent actually wires it (e.g. `report` only on a subordinate). */
	wired: boolean;
	qualityScore: number;
	usageCount: number;
}

/** A memory-pane row: a note or a hybrid-search hit; plain notes score 1. */
export interface MemoryEntry extends MemoryNote {
	matchScore: number;
}

export interface ExecutorCommandResult {
	stdout?: string;
	stderr?: string;
	exitCode?: number;
	error?: string;
	refusal?: Exclude<CommandResult, string>;
}

export type SubordinateStatus = "idle" | "working" | "awaiting_input" | "dismissed";

/** Parent-owned roster from listSubordinates and the subordinates_changed socket event. */
export interface SubordinateRosterEntry {
	name: string;
	/** Actor whose conversation `getChatHistoryPage({ actor })` pages; null until birth confirms one. */
	actorId: string | null;
	displayName: string;
	role: string;
	nameOrigin?: "user" | "auto";
	createdBy: "orchestrator" | "user";
	status: SubordinateStatus;
	currentTask: string | null;
	createdAt: number;
	dismissedAt: number | null;
}

/** A task assignment or report mirrored into the main chat as a linked card. */
export interface SubordinateActivityEvent {
	type: "subordinate_event";
	id: string;
	kind: "task" | "report";
	subordinate: string;
	status?: string;
	content: string;
	task?: string;
	timestamp: number;
}

/** Typed agent RPC; the one unknown → T cast lives in the hook's wrapper. */
export type Rpc = <T = unknown>(method: string, args?: unknown[]) => Promise<T>;

/** A background job (auto-detached >30s tool call), from listBackgroundJobs. */
export interface BackgroundJob {
	id: string;
	kind: string;
	label: string | null;
	workMode: "plan" | "build";
	status: "running" | "completed" | "failed" | "cancelled";
	result: string | null;
	error: string | null;
	createdAt: number;
	settledAt: number | null;
	retriedBy?: string | null;
	/** Times a platform interruption re-drove this job. */
	resumeAttempts?: number;
	/** When the next attempt may start; null while nothing is owed, including during a running attempt. */
	resumeAfter?: number | null;
}

export type ReleaseStatus =
	| "draft" | "planning" | "patching" | "validating" | "preview_ready" | "awaiting_approval"
	| "applying" | "deployed" | "rejected" | "rolled_back" | "failed";

export interface ReleaseSource {
	id: string;
	kind: "local" | "github";
	label: string;
	repoUrl: string | null;
	defaultBranch: string | null;
	localDeviceId: string | null;
	localRoot: string | null;
	deployTarget: string | null;
	createdAt: number;
	updatedAt: number;
}

export interface ReleaseChange {
	id: string;
	agentName: string;
	bindingId: string;
	status: ReleaseStatus;
	userPrompt: string;
	plan: string | null;
	summary: string | null;
	patch: string | null;
	previewUrl: string | null;
	createdAt: number;
	updatedAt: number;
}

export interface ReleaseCheck {
	id: string;
	changeId: string;
	name: string;
	status: "pending" | "running" | "passed" | "failed" | "skipped";
	stdout: string | null;
	stderr: string | null;
	durationMs: number | null;
	createdAt: number;
	updatedAt: number;
}

export interface ReleaseApproval {
	id: string;
	changeId: string;
	approvalType: "apply" | "deploy_staging" | "deploy_production" | "rollback";
	decision: "pending" | "approved" | "rejected";
	approvedBy: string | null;
	note: string | null;
	createdAt: number;
	decidedAt: number | null;
}

export interface ReleaseDeployment {
	id: string;
	changeId: string;
	environment: "local" | "staging" | "production";
	workerVersionId: string | null;
	deploymentId: string | null;
	rollbackTarget: string | null;
	deployedAt: number;
}

export interface ReleaseBoard {
	bindings: ReleaseSource[];
	changes: ReleaseChange[];
	checks: ReleaseCheck[];
	approvals: ReleaseApproval[];
	deployments: ReleaseDeployment[];
}

/** A pending device request (method `connect` asks for a device to exist); `always` is the per-workspace binding. */
export interface PendingConsent {
	consentId: string;
	deviceLabel: string;
	method: string;
	command: string;
	createdAt: number;
	/** The workspace whose binding is being decided, when a workspace asked. */
	workspaceName?: string;
}

/** The Activity surface's payload. `latest.usage` and `latest.context` do not reconcile; unsourced values are null, never estimated. */
export interface ActivitySnapshot {
	/** Newest step with provider usage; null before the first measured step. */
	latest: {
		at: number;
		runId: string;
		stepIndex: number;
		/** Only fields the provider reported are present; render absent ones as unreported. */
		usage: Usage;
		/** Null for steps recorded before the meter existed or never measured. */
		context: ContextComposition | null;
	} | null;
	/** Resolved model's context window; null when the catalog has not answered. */
	contextWindow: number | null;
	/** The orchestrator's own `step_finish` turns only; workspace-wide totals are `spend`. */
	telemetry: StepTelemetry;
	/** All accounted model calls, by producer and by mission; `spend.missions` comes from `mission_budget`, the enforced ledger. */
	spend: WorkspaceSpend;
	log: ActivityLogEntry[];
}

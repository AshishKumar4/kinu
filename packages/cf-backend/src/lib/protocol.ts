/**
 * Shared UI domain types for the agent RPC surface (@callable methods).
 */

import type {
	ActivityLogEntry, ContextComposition, MissionBudgetSnapshot, StepTelemetry, StepUsage,
} from "@proteus/core";

/**
 * One branch of a fork, as the tree view draws it.
 *
 * A fork is a tree whatever settled it: a competition (settle=mcts) is a deep
 * tree whose branches were scored against each other, and a merge
 * (settle=merge) is the same tree at depth 1 — the task at the root, one head
 * per child. One shape, one renderer, depth varying.
 *
 * `value` and `visits` are nullable BECAUSE of that: only a competition scores
 * its branches and counts rollouts. A merge has neither, and the encodings
 * that carry them (fill ramp, radius, the winning spine, the score in the
 * label) must be absent rather than drawn from a zero no branch earned.
 */
export interface ForkNode {
	id: string;
	parentId: string | null;
	depth: number;
	/** Branch score in [0,1] — null when the fork did not compete its branches. */
	value: number | null;
	/** Rollouts spent here — null for the same reason. */
	visits: number | null;
	/**
	 * `running` is the one state a search node never reaches (search_nodes
	 * constrains its column to the other four) and the one a head is in for
	 * most of its life, so the view union is the superset of both mechanisms.
	 * `terminal` means "the branch the fork settled on" and only a competition
	 * has one.
	 */
	status: "open" | "pruned" | "terminal" | "failed" | "running";
	action: string;
	children: ForkNode[];
	task?: string;
	observation?: string;
	codeUsed?: string | null;
	branchAgentKey?: string | null;
	msgId?: string | null;
	createdAt?: number;
}

export interface MCTSNodeSummary {
	id: string;
	parentId: string | null;
	depth: number;
	value: number;
	visits: number;
	status: ForkNode["status"];
	action: string;
	createdAt?: number;
}

export interface MCTSNodeDetail extends MCTSNodeSummary {
	task: string;
	observation: string;
	codeUsed: string | null;
	branchAgentKey: string | null;
	msgId: string | null;
	path: MCTSNodeSummary[];
	children: MCTSNodeSummary[];
}

export interface ToolInfo {
	name: string;
	/** The one-line headline — what a list row shows. For a builtin this is the
	 *  registry's own `summary`; a crafted tool's description is already one
	 *  line, so it is its own summary. Never derived by splitting
	 *  `description`: the docstring's shape is the model's contract, not the
	 *  UI's. */
	summary: string;
	/** The full docstring the model sees — summary, when-to-use, doctrine,
	 *  returns. Shown on demand, never as a list row's body. */
	description: string;
	/** Where the tool came from: shipped with the agent, or crafted by it. */
	learned: boolean;
	/**
	 * How the model reaches it — a tool definition in the turn's ToolSet
	 * (`native`), or only from inside an `execute_tools` program (`codemode`).
	 * Derived by the orchestrator from the assembled surface, never declared.
	 */
	exposure: "native" | "codemode";
	qualityScore: number;
	usageCount: number;
}

export interface MemoryEntry {
	path: string;
	content: string;
	matchScore: number;
	updatedAt: string;
}

/** One agent in the workspace roster (getWorkspaceAgents). The orchestrator
 *  is the workspace's default agent; durable subordinate facets follow it. */
export interface WorkspaceAgent {
	name: string;
	displayName: string;
	role: "orchestrator" | "subordinate";
}

export type SubordinateStatus = "idle" | "working" | "awaiting_input" | "dismissed";

/** Parent-owned product roster delivered by listSubordinates and the
 * subordinates_changed socket event. */
export interface SubordinateRosterEntry {
	name: string;
	displayName: string;
	role: string;
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

/** Typed agent RPC. The single boundary cast (unknown → T) lives in the hook's
 *  wrapper, so call sites read `rpc<Foo>("getFoo", [])` cast-free. */
export type Rpc = <T = unknown>(method: string, args?: unknown[]) => Promise<T>;

/** A background job (auto-detached >30s tool call). Mirrors core BackgroundJob;
 *  surfaced by listBackgroundJobs for the Jobs surface + chat event cards. */
export interface BackgroundJob {
	id: string;
	kind: string;
	label: string | null;
	status: "running" | "completed" | "failed" | "cancelled";
	result: string | null;
	error: string | null;
	createdAt: number;
	settledAt: number | null;
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

/** A pending device-consent request — an agent wants to run a command on a
 *  connected device; the user decides (Allow once / Always / Deny). */
export interface PendingConsent {
	consentId: string;
	deviceLabel: string;
	method: string;
	command: string;
	scope: "all_local_actions";
	createdAt: number;
}

/**
 * The Activity surface's whole payload — one round trip, refreshed per step.
 *
 * The split down the middle is the point: `latest.usage` is what the provider
 * said the newest request cost, `latest.context` is what that request was
 * locally measured to be made of, and the two are carried separately because
 * they do not reconcile. Anything the agent could not source is null, never a
 * plausible-looking stand-in.
 */
export interface ActivitySnapshot {
	/** The newest step the provider reported usage for. Null before the first
	 *  measured step of the workspace's life. */
	latest: {
		at: number;
		runId: string;
		stepIndex: number;
		usage: StepUsage;
		/** Absent for steps recorded before the meter existed, or when the
		 *  turn driver never measured. */
		context: ContextComposition | null;
	} | null;
	/** The resolved model's context window, or null when the catalog has not
	 *  answered — a percentage against a guessed window would be fiction. */
	contextWindow: number | null;
	telemetry: StepTelemetry;
	/** Mission budgets, empty when the workspace runs under no mission label
	 *  (the default). `pricing.source` says how honest each USD figure is. */
	budgets: MissionBudgetSnapshot[];
	log: ActivityLogEntry[];
}

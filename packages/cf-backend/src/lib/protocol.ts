/**
 * Shared UI domain types for the agent RPC surface (@callable methods).
 */

import type {
	ActivityLogEntry, ContextComposition, StepTelemetry, Usage,
	WorkspaceSpend,
} from "@kinu.run/core";

/**
 * One branch of a fork, as the tree view draws it.
 *
 * A fork is a tree whatever produced it: a search (`action:'swarm'` with a
 * `depth`) is a deep tree whose branches were scored against each other, and a
 * merge (`action:'fork'`) is the same tree at depth 1 — the task at the root,
 * one head per child. One shape, one renderer, depth varying.
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
	 * How the model reaches it, as the registry DECLARES it (`TOOL_REACH`):
	 * `native` = a tool definition in the turn's ToolSet, `codemode` = only from
	 * inside an `execute_tools` program, `both` = both, over one dispatcher.
	 *
	 * This used to be derived as `nativeNames.has(name) ? "native" : "codemode"`,
	 * a binary with no way to say "neither" — so the one deps-gated builtin
	 * (`report`) read "code mode" on an orchestrator, which has it on no surface
	 * at all. A crafted tool has no registry row and is codemode by construction.
	 */
	exposure: "native" | "codemode" | "both";
	/**
	 * Whether THIS agent actually wires it. Reach is what the capability is;
	 * this is what this actor has. `report` is declared `both` and is wired only
	 * on a subordinate — the orchestrator IS the report sink — so its row is
	 * honestly `both` + `wired: false` rather than silently mislabelled.
	 */
	wired: boolean;
	qualityScore: number;
	usageCount: number;
}

export interface MemoryEntry {
	path: string;
	content: string;
	matchScore: number;
	updatedAt: string;
}

export interface ExecutorCommandResult {
	stdout?: string;
	stderr?: string;
	exitCode?: number;
	error?: string;
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

/** Typed agent RPC. The single boundary cast (unknown → T) lives in the hook's
 *  wrapper, so call sites read `rpc<Foo>("getFoo", [])` cast-free. */
export type Rpc = <T = unknown>(method: string, args?: unknown[]) => Promise<T>;

/** A background job (auto-detached >30s tool call). Mirrors core BackgroundJob;
 *  surfaced by listBackgroundJobs for the Jobs surface + chat event cards. */
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
		/** What the provider said this step cost. Only the fields it actually
		 *  reported are present, and a surface must render an absent one as
		 *  unreported rather than showing an invented default — the same rule
		 *  `context` below follows. `latest` is null when no step in the
		 *  workspace's life reported anything, so this is never an empty report. */
		usage: Usage;
		/** Absent for steps recorded before the meter existed, or when the
		 *  turn driver never measured. */
		context: ContextComposition | null;
	} | null;
	/** The resolved model's context window, or null when the catalog has not
	 *  answered — a percentage against a guessed window would be fiction. */
	contextWindow: number | null;
	/** The orchestrator's OWN turns, over a window of `step_finish` rows: what a
	 *  step cost, and how the prefix cache has behaved. Deliberately not widened
	 *  to the whole workspace — a judge's cold prompt in this window would read
	 *  as a cache regression the agent never had. `spend` below is the workspace. */
	telemetry: StepTelemetry;
	/** Every model call the workspace can account for, on both axes: grouped by
	 *  the producer that spent it, and grouped by the mission it was spent on.
	 *  This is the answer to "is this ALL of the usage": `spend.coverage.reported`
	 *  says what share of known calls the providers measured, and
	 *  `spend.coverage.silent` names the producers that measured none.
	 *
	 *  `spend.missions` is the ONE mission-spend figure the panel reads. It comes
	 *  from `mission_budget`, the ledger the caps are enforced against, and it
	 *  covers every declared label rather than only the ones the turn in flight
	 *  happens to be running under. */
	spend: WorkspaceSpend;
	log: ActivityLogEntry[];
}

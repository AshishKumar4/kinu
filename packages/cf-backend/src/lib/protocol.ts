/**
 * Shared UI domain types for the agent RPC surface (@callable methods).
 */

export interface MCTSNode {
	id: string;
	parentId: string | null;
	depth: number;
	value: number;
	visits: number;
	status: "open" | "pruned" | "terminal" | "failed";
	action: string;
	children: MCTSNode[];
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
	status: MCTSNode["status"];
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
	description: string;
	scope: "local" | "global";
	qualityScore: number;
	usageCount: number;
	lastUsed: string;
}

export interface MemoryEntry {
	path: string;
	content: string;
	matchScore: number;
	updatedAt: string;
}

/** One directory entry in the per-executor file manager (getExecutorFiles).
 *  Normalized across executors (each provider's readdir has its own format). */
export interface DirEntry {
	name: string;
	type: "file" | "dir";
	size?: number;
}

/** One agent in the workspace roster (getWorkspaceAgents). The orchestrator
 *  is the workspace's default agent — always present; peers are agents of the
 *  owner's other workspaces, reachable (and spawnable) via the team tool. */
export interface WorkspaceAgent {
	name: string;
	displayName: string;
	role: "orchestrator" | "peer";
}

/** Typed agent RPC. The single boundary cast (unknown → T) lives in the hook's
 *  wrapper, so call sites read `rpc<Foo>("getFoo", [])` cast-free. */
export type Rpc = <T = unknown>(method: string, args?: unknown[]) => Promise<T>;

/** One typed span on the unified Run Timeline spine (getRunTimeline). The
 *  server merges run_events + evolution_events + search_nodes into this single
 *  ordered shape so the client never re-merges three sources (no drift). */
export type TimelineKind =
	| "llm-turn" | "tool-call" | "runtime-exec" | "mcts" | "scaffold" | "shadow-eval"
	| "craft" | "reflection" | "head-split" | "head-merge" | "gepa" | "skills"
	| "curriculum" | "trigger" | "event-ingress" | "background" | "error" | "abort" | "recovery" | "other";

export interface TimelineSpan {
	ts: number;
	kind: TimelineKind;
	label: string;
	detail?: string;
	/** Latency in ms when known (tool calls, activity timings). */
	elapsedMs?: number;
	/** Preserved structured payload (e.g. evolution_events.data) for drill-in. */
	data?: unknown;
	source: "run" | "evolution" | "mcts" | "background";
	/** Id for driving the work surface (node id, run-event id, root id…). */
	refId?: string;
	/** Original backend event type, for finer UI affordances. */
	rawType?: string;
}

/** A background task (auto-detached >30s tool call). Mirrors core BackgroundJob;
 *  surfaced by listBackgroundJobs for the Tasks surface + chat event cards. */
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

export type ProductChangeStatus =
	| "draft" | "planning" | "patching" | "validating" | "preview_ready" | "awaiting_approval"
	| "applying" | "deployed" | "rejected" | "rolled_back" | "failed";

export interface ProductSourceBinding {
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

export interface ProductChangeRequest {
	id: string;
	agentName: string;
	bindingId: string;
	status: ProductChangeStatus;
	userPrompt: string;
	plan: string | null;
	summary: string | null;
	patch: string | null;
	previewUrl: string | null;
	createdAt: number;
	updatedAt: number;
}

export interface ProductChangeCheck {
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

export interface ProductChangeApproval {
	id: string;
	changeId: string;
	approvalType: "apply" | "deploy_staging" | "deploy_production" | "rollback";
	decision: "pending" | "approved" | "rejected";
	approvedBy: string | null;
	note: string | null;
	createdAt: number;
	decidedAt: number | null;
}

export interface ProductDeploymentRecord {
	id: string;
	changeId: string;
	environment: "local" | "staging" | "production";
	workerVersionId: string | null;
	deploymentId: string | null;
	rollbackTarget: string | null;
	deployedAt: number;
}

export interface ProductChangeBoard {
	bindings: ProductSourceBinding[];
	changes: ProductChangeRequest[];
	checks: ProductChangeCheck[];
	approvals: ProductChangeApproval[];
	deployments: ProductDeploymentRecord[];
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

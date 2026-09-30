export interface AgentFacetAnswer {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

export interface OnePlaneObservation {
  readonly home: string;
  /** The agent's `pwd; id -u` from its own isolate. */
  readonly agentShell: AgentFacetAnswer;
  /** What the workspace's own view reads back of the file the agent wrote. */
  readonly mainRead: string | null;
  readonly mainCat: AgentFacetAnswer;
  /** The agent's isolate and the workspace object's are two isolates. */
  readonly sameIsolate: boolean;
}

export interface AgentFacetClaim {
  readonly actorId: string;
  readonly turnId: string;
  readonly outcome: string | null;
  readonly programKind: string;
}

export interface SwarmFacetObservation {
  readonly actorId: string;
  readonly home: string;
  readonly sameIsolate: boolean;
  readonly workspaceClaims: number;
  readonly claims: readonly AgentFacetClaim[];
  readonly retired: boolean;
  readonly summary: string;
  readonly candidate: string;
  readonly reportedItself: boolean;
}

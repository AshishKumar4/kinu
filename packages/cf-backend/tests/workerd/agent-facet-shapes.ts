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

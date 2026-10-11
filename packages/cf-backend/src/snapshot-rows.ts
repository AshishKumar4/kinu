/**
 * The tables an agent's snapshot copies from its workspace into its own isolate (`OrchestratorAgent.agentSnapshot`,
 * `AgentDatabase.adopt`). A statement that writes one moves every copy of them held on either side.
 */
const SNAPSHOT_SOURCE_WRITE = /\b(?:INSERT\s+(?:OR\s+\w+\s+)?INTO|REPLACE\s+INTO|UPDATE|DELETE\s+FROM)\s+(?:workspace_actors|workspace_identity|actor_config|scaffold_versions)\b/iu;

const WRITES = new WeakMap<TemplateStringsArray, boolean>();

/** Whether the statement writes a table a snapshot copies; decided once per statement text. */
export function writesSnapshotRows(strings: TemplateStringsArray): boolean {
  const known = WRITES.get(strings);

  if (known !== undefined) return known;
  const writes = SNAPSHOT_SOURCE_WRITE.test(strings.join('?'));

  WRITES.set(strings, writes);

  return writes;
}

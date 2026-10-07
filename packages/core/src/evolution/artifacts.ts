/**
 * The one store of an agent's evolved text (docs/EVOLUTION-REDESIGN.md §3): a prompt section, a built-in tool's
 * description, or its input fields' descriptions, by artifact id. Assembly reads each artifact's current version, else
 * the bundled text; an override changes only the agent that promoted it. The scaffold keeps `scaffold_versions`.
 */
import * as v from 'valibot';
import { jsonSchema } from 'ai';
import type { ActorHandle } from '../identity/actor-handle';
import { ARTIFACT_STATUSES } from './artifact-schema';
import type { SqlExecutor } from '../types/primitives';
import { nowMs } from '../utils/date';
import { parseJsonValue } from '../utils/json';
import { tolerate } from '../obs/index';
import { checkMisevolutionForSurface, recordMisevolutionVeto } from '../safety/misevolution';
import { templateContract } from '../prompting/template';
import { PROMPT_SECTIONS, type PromptSectionOverrides } from '../prompting/section-templates';
import { BUILTIN_TOOL_DESCRIPTIONS } from '../tools/registry';
import { fieldDescriptions, type ToolTextOverrides } from '../tools/tool-text';
import { FILE } from '../operations/file';
import { MEMORY } from '../operations/memory';
import { nativeToolSchema } from '../tools/operation-surfaces';
import { inputJsonSchema } from '../operations/operation';
import { REPORT } from '../operations/report';
import { TASKS } from '../operations/tasks';
import { WEB } from '../operations/web';
import { codemodeInputSchema } from '../tools/sandbox-contract';
import { SHELL } from '../operations/shell';

/** About twice the largest shipped section, so a runaway is refused before it is judged. */
const PROMPT_SECTION_MAX_BYTES = 4800;

/** An edit's reach: one artifact, a bounded change. */
const MAX_EDIT_CHARS = 600;

export type ArtifactStatus = (typeof ARTIFACT_STATUSES)[number];

export const sectionArtifact = (sectionId: string): string => `section:${sectionId}`;

export const toolArtifact = (tool: string, part: 'description' | 'schema'): string => `tool:${tool}.${part}`;

const ArtifactIdSchema = v.union([
  v.object({ kind: v.literal('section'), id: v.string() }),
  v.object({ kind: v.literal('tool'), id: v.string(), part: v.picklist(['description', 'schema']) }),
]);

export type ParsedArtifactId = v.InferOutput<typeof ArtifactIdSchema>;

function parseArtifactId(artifactId: string): ParsedArtifactId | null {
  const section = /^section:(.+)$/.exec(artifactId);

  if (section?.[1] !== undefined) return { kind: 'section', id: section[1] };
  const tool = /^tool:([a-z_]+)\.(description|schema)$/.exec(artifactId);

  if (tool?.[1] === undefined || (tool[2] !== 'description' && tool[2] !== 'schema')) return null;

  return { kind: 'tool', id: tool[1], part: tool[2] };
}

/** Why an edit was proposed: its turns, the reason or struggle they share, and the search's numbers. */
export const ArtifactEvidenceSchema = v.object({
  turns: v.array(v.string()),
  reason: v.string(),
  fixes: v.optional(v.number()),
  harms: v.optional(v.number()),
  bad: v.optional(v.number()),
  regression: v.optional(v.number()),
});

export type ArtifactEvidence = v.InferOutput<typeof ArtifactEvidenceSchema>;

export interface ArtifactVersion {
  readonly artifactId: string;
  readonly version: number;
  readonly body: string;
  readonly status: ArtifactStatus;
  readonly parent: number | null;
  readonly rationale: string;
  readonly evidence: ArtifactEvidence | null;
  readonly writtenAt: number;
  readonly decidedAt: number | null;
}

interface ArtifactRow {
  artifact_id: string; version: number; body: string; status: string; parent: number | null; rationale: string;
  evidence: string | null; written_at: number; decided_at: number | null;
}

const versionOf = (row: ArtifactRow): ArtifactVersion => ({
  artifactId: row.artifact_id,
  version: row.version,
  body: row.body,
  status: v.parse(v.picklist(ARTIFACT_STATUSES), row.status),
  parent: row.parent,
  rationale: row.rationale,
  evidence: row.evidence === null ? null : v.parse(ArtifactEvidenceSchema, parseJsonValue(row.evidence)),
  writtenAt: row.written_at,
  decidedAt: row.decided_at,
});

/** The built-in input schemas whose field text evolves; the agents tool's is built per account and does not. */
const BUILTIN_INPUT_SCHEMAS = {
  eval: codemodeInputSchema(),
  shell: jsonSchema(inputJsonSchema(SHELL.run)),
  file: jsonSchema(nativeToolSchema(Object.values(FILE))),
  tasks: jsonSchema(nativeToolSchema(Object.values(TASKS))),
  memory: jsonSchema(nativeToolSchema(Object.values(MEMORY))),
  web: jsonSchema(nativeToolSchema([WEB.search, WEB.fetch, WEB.screenshot])),
  report: jsonSchema(inputJsonSchema(REPORT.send)),
};

function builtinFieldDescriptions(tool: string): Record<string, string> | null {
  const schema = Object.entries(BUILTIN_INPUT_SCHEMAS).find(([name]) => name === tool)?.[1];

  return schema === undefined ? null : fieldDescriptions(schema);
}

/** The bundled text an artifact starts from; null for an id no assembly reads. */
export function bundledArtifact(artifactId: string): string | null {
  const parsed = parseArtifactId(artifactId);

  if (parsed === null) return null;

  if (parsed.kind === 'section') return PROMPT_SECTIONS.find((section) => section.id === parsed.id)?.source ?? null;

  if (parsed.part === 'description') return Object.entries(BUILTIN_TOOL_DESCRIPTIONS).find(([name]) => name === parsed.id)?.[1] ?? null;
  const fields = builtinFieldDescriptions(parsed.id);

  return fields === null ? null : JSON.stringify(fields, null, 2);
}

/** Each artifact's promoted body, by id. */
export function currentArtifacts(sql: SqlExecutor, actor: ActorHandle): Readonly<Record<string, string>> {
  actor.assertCurrent();

  return Object.fromEntries(sql<{ artifact_id: string; body: string }>`
    SELECT artifact_id, body FROM artifact_versions WHERE actor_id = ${actor.actorId} AND status = 'current'`
    .map((row) => [row.artifact_id, row.body]));
}

/** The text a turn runs now: the promoted body, else the bundled one. */
export function artifactBody(sql: SqlExecutor, actor: ActorHandle, artifactId: string): string | null {
  return currentArtifacts(sql, actor)[artifactId] ?? bundledArtifact(artifactId);
}

export function listArtifactVersions(sql: SqlExecutor, actor: ActorHandle, artifactId?: string): ArtifactVersion[] {
  actor.assertCurrent();

  return (artifactId === undefined
    ? sql<ArtifactRow>`SELECT * FROM artifact_versions WHERE actor_id = ${actor.actorId} ORDER BY written_at DESC, version DESC`
    : sql<ArtifactRow>`SELECT * FROM artifact_versions WHERE actor_id = ${actor.actorId} AND artifact_id = ${artifactId}
      ORDER BY version DESC`).map(versionOf);
}

export function artifactVersion(sql: SqlExecutor, actor: ActorHandle, artifactId: string, version: number): ArtifactVersion | null {
  actor.assertCurrent();

  const [row] = sql<ArtifactRow>`SELECT * FROM artifact_versions
    WHERE actor_id = ${actor.actorId} AND artifact_id = ${artifactId} AND version = ${version}`;

  return row === undefined ? null : versionOf(row);
}

/** The oldest candidate waiting for a trial. */
export function waitingCandidate(sql: SqlExecutor, actor: ActorHandle): ArtifactVersion | null {
  actor.assertCurrent();

  const [row] = sql<ArtifactRow>`SELECT * FROM artifact_versions
    WHERE actor_id = ${actor.actorId} AND status = 'candidate' ORDER BY written_at ASC, version ASC LIMIT 1`;

  return row === undefined ? null : versionOf(row);
}

/** Characters an edit changes: what lies between the common prefix and suffix, on the longer side. */
function changedChars(before: string, after: string): number {
  let head = 0;

  while (head < before.length && head < after.length && before[head] === after[head]) head++;
  let tail = 0;

  while (tail < before.length - head && tail < after.length - head
    && before[before.length - 1 - tail] === after[after.length - 1 - tail]) tail++;

  return Math.max(before.length - head - tail, after.length - head - tail);
}

const FieldTextSchema = v.record(v.string(), v.string());

function fieldText(body: string): Record<string, string> | null {
  const parsed = v.safeParse(FieldTextSchema, tolerate(() => parseJsonValue(body), 'malformed-input'));

  return parsed.success ? parsed.output : null;
}

/** Why a section edit cannot ship, or null: the byte cap, then its slots and flags against the bundled section's. */
function sectionRefusal(sectionId: string, before: string, after: string): string | null {
  const bytes = new TextEncoder().encode(after).length;

  if (bytes > PROMPT_SECTION_MAX_BYTES) {
    return `${String(bytes)} bytes exceeds the ${String(PROMPT_SECTION_MAX_BYTES)}-byte section ceiling`;
  }

  const wanted = templateContract(sectionId, before);
  const offered = tolerate(() => templateContract(sectionId, after), 'malformed-input');

  if (offered === undefined) return 'the section does not parse as a template';

  if (wanted.slots.join('|') !== offered.slots.join('|') || wanted.flags.join('|') !== offered.flags.join('|')) {
    return `slot contract changed: the builder supplies {slots: ${wanted.slots.join(', ') || '(none)'}; flags: ${wanted.flags.join(', ') || '(none)'}}`;
  }

  return null;
}

/** The schema rule: the same fields, only their words changed. */
function schemaRefusal(before: string, after: string): string | null {
  const was = fieldText(before);
  const now = fieldText(after);

  if (was === null || now === null) return 'field text is not a JSON map of field name to description';

  const same = Object.keys(was).sort().join('|') === Object.keys(now).sort().join('|');

  return same ? null : `the fields changed: ${Object.keys(was).sort().join(', ')} must stay exactly`;
}

/** A description is prose with no rule of its own; field text keeps its fields. */
function toolRefusal(part: 'description' | 'schema', before: string, after: string): string | null {
  return part === 'schema' ? schemaRefusal(before, after) : null;
}

/**
 * The static pre-live checks (§4): the edit's size, the artifact's own rule, and the misevolution gate. A veto is
 * recorded where every misevolution veto is.
 */
export function artifactEditRefusal(sql: SqlExecutor, actor: ActorHandle, input: {
  readonly artifactId: string;
  readonly before: string;
  readonly after: string;
  /** False inside a search, where a refused mutation is no event; the edit that ships is checked again with it. */
  readonly record: boolean;
}): string | null {
  const parsed = parseArtifactId(input.artifactId);

  if (parsed === null || bundledArtifact(input.artifactId) === null) return `${input.artifactId} is no evolvable artifact`;

  if (input.after === input.before) return 'the edit changes nothing';
  const changed = changedChars(input.before, input.after);

  if (changed > MAX_EDIT_CHARS) return `the edit changes ${String(changed)} characters; at most ${String(MAX_EDIT_CHARS)}`;

  const own = parsed.kind === 'section' ? sectionRefusal(parsed.id, input.before, input.after) : toolRefusal(parsed.part, input.before, input.after);

  if (own !== null) return own;
  const misevolution = checkMisevolutionForSurface({ prose: input.after }, 'scaffold');

  if (misevolution.ok) return null;

  if (input.record) recordMisevolutionVeto(sql, actor, { surface: 'scaffold', violation: misevolution, detail: input.artifactId });

  return `misevolution veto (${misevolution.criterionId}): ${misevolution.reason}`;
}

/** A candidate that passed the pre-live tests, waiting for a trial. */
export function writeCandidate(sql: SqlExecutor, actor: ActorHandle, input: {
  readonly artifactId: string;
  readonly body: string;
  readonly rationale: string;
  readonly evidence: ArtifactEvidence;
  readonly now?: number;
}): number {
  actor.assertCurrent();

  const [top] = sql<{ v: number }>`SELECT COALESCE(MAX(version), 0) AS v FROM artifact_versions
    WHERE actor_id = ${actor.actorId} AND artifact_id = ${input.artifactId}`;

  const [current] = sql<{ version: number }>`SELECT version FROM artifact_versions
    WHERE actor_id = ${actor.actorId} AND artifact_id = ${input.artifactId} AND status = 'current'`;

  const version = (top?.v ?? 0) + 1;

  void sql`INSERT INTO artifact_versions (actor_id, artifact_id, version, body, status, parent, rationale, evidence, written_at)
    VALUES (${actor.actorId}, ${input.artifactId}, ${version}, ${input.body}, 'candidate', ${current?.version ?? null},
      ${input.rationale}, ${JSON.stringify(input.evidence)}, ${input.now ?? nowMs()})`;

  return version;
}

/** A version's move: `current` demotes the incumbent to history in the same write. */
export function settleArtifact(sql: SqlExecutor, actor: ActorHandle, input: {
  readonly artifactId: string;
  readonly version: number;
  readonly status: 'trial' | 'current' | 'rolled_back';
  readonly now?: number;
}): void {
  actor.assertCurrent();
  const at = input.now ?? nowMs();

  if (input.status === 'current') {
    void sql`UPDATE artifact_versions SET status = 'historical', decided_at = ${at}
      WHERE actor_id = ${actor.actorId} AND artifact_id = ${input.artifactId} AND status = 'current'`;
  }

  void sql`UPDATE artifact_versions SET status = ${input.status}, decided_at = ${input.status === 'trial' ? null : at}
    WHERE actor_id = ${actor.actorId} AND artifact_id = ${input.artifactId} AND version = ${input.version}`;
}

/** The changelog's revert of a promotion: the version it replaced, or the bundled text, is current again. */
export function revertArtifact(sql: SqlExecutor, actor: ActorHandle, artifactId: string, version: number): void {
  const now = nowMs();
  const reverted = artifactVersion(sql, actor, artifactId, version);

  if (reverted === null) return;
  void sql`UPDATE artifact_versions SET status = 'rolled_back', decided_at = ${now}
    WHERE actor_id = ${actor.actorId} AND artifact_id = ${artifactId} AND version = ${version}`;

  if (reverted.status === 'current' && reverted.parent !== null) {
    void sql`UPDATE artifact_versions SET status = 'current', decided_at = ${now}
      WHERE actor_id = ${actor.actorId} AND artifact_id = ${artifactId} AND version = ${reverted.parent} AND status = 'historical'`;
  }
}

export interface ArtifactOverrides {
  readonly sections: PromptSectionOverrides;
  readonly tools: ToolTextOverrides;
}

/** The bodies a prompt and a tool surface take, from one id map. */
export function artifactOverrides(bodies: Readonly<Record<string, string>>): ArtifactOverrides {
  const sections: Record<string, string> = {};
  const descriptions: Record<string, string> = {};
  const fields: Record<string, Record<string, string>> = {};

  for (const [artifactId, body] of Object.entries(bodies)) {
    const parsed = parseArtifactId(artifactId);

    if (parsed?.kind === 'section') sections[parsed.id] = body;
    else if (parsed?.part === 'description') descriptions[parsed.id] = body;
    else if (parsed?.part === 'schema') {
      const text = fieldText(body);

      if (text !== null) fields[parsed.id] = text;
    }
  }

  return { sections, tools: { descriptions, fields } };
}


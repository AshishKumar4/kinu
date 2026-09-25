import type { RawSqlExec } from '../types/primitives';

/** Relational context history. Payload files are published through VFS before these references commit. */
export function initSessionContextTables(exec: RawSqlExec): void {
  exec(`CREATE TABLE IF NOT EXISTS session_messages (
    actor_id TEXT NOT NULL REFERENCES workspace_actors(actor_id), message_id TEXT NOT NULL, role TEXT NOT NULL CHECK(role IN ('system','user','assistant','tool')),
    native_content_kind TEXT NOT NULL CHECK(native_content_kind IN ('string','parts')),
    origin TEXT NOT NULL CHECK(origin IN ('input','output','edit','context_transform','render')),
    request_id TEXT, output_slot INTEGER, ingress_id TEXT,
    recorded_at INTEGER NOT NULL,
    envelope_json TEXT NOT NULL,
    sealed_at INTEGER, content_json TEXT, content_path TEXT, content_digest TEXT,
    PRIMARY KEY(actor_id,message_id), UNIQUE(actor_id,request_id,output_slot),
    FOREIGN KEY(actor_id,request_id) REFERENCES actor_requests(actor_id,request_id),
    CHECK(output_slot IS NULL OR output_slot >= 0),
    CHECK((request_id IS NULL) = (output_slot IS NULL)),
    CHECK((sealed_at IS NULL AND content_json IS NULL AND content_path IS NULL AND content_digest IS NULL)
      OR (sealed_at IS NOT NULL AND ((content_json IS NOT NULL AND content_path IS NULL AND content_digest IS NULL)
        OR (content_json IS NULL AND content_path IS NOT NULL AND content_digest IS NOT NULL)))))`);
  exec(`CREATE UNIQUE INDEX IF NOT EXISTS session_message_ingress ON session_messages(actor_id,ingress_id) WHERE ingress_id IS NOT NULL`);
  // `sealAbandoned` names the literal `sealed_at IS NULL` at every admission.
  exec(`CREATE INDEX IF NOT EXISTS session_open_messages ON session_messages(actor_id) WHERE sealed_at IS NULL`);
  // An open message's parts while its answer streams, deleted when it seals into `content_*`. Long text
  // continues in the next segment so no row reaches the platform row limit.
  exec(`CREATE TABLE IF NOT EXISTS stream_parts (
    actor_id TEXT NOT NULL, message_id TEXT NOT NULL, part_no INTEGER NOT NULL, segment INTEGER NOT NULL,
    kind TEXT NOT NULL, stream_order INTEGER NOT NULL,
    descriptor_json TEXT, descriptor_path TEXT, descriptor_digest TEXT,
    text TEXT NOT NULL DEFAULT '', ended INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY(actor_id,message_id,part_no,segment),
    FOREIGN KEY(actor_id,message_id) REFERENCES session_messages(actor_id,message_id),
    CHECK(part_no >= 0), CHECK(segment >= 0), CHECK(stream_order >= 0), CHECK(ended IN (0,1)),
    CHECK((segment > 0 AND descriptor_json IS NULL AND descriptor_path IS NULL AND descriptor_digest IS NULL)
      OR (segment = 0 AND ((descriptor_json IS NOT NULL AND descriptor_path IS NULL AND descriptor_digest IS NULL)
        OR (descriptor_json IS NULL AND descriptor_path IS NOT NULL AND descriptor_digest IS NOT NULL)))))`);
  exec(`CREATE TABLE IF NOT EXISTS actor_contexts (
    actor_id TEXT NOT NULL REFERENCES workspace_actors(actor_id), context_id TEXT NOT NULL, fork_context_id TEXT, fork_revision INTEGER,
    PRIMARY KEY(actor_id,context_id), CHECK((fork_context_id IS NULL) = (fork_revision IS NULL)),
    FOREIGN KEY(actor_id,fork_context_id,fork_revision) REFERENCES context_revisions(actor_id,context_id,revision))`);
  exec(`CREATE TABLE IF NOT EXISTS actor_context_selection (
    actor_id TEXT PRIMARY KEY REFERENCES workspace_actors(actor_id), context_id TEXT NOT NULL,
    FOREIGN KEY(actor_id,context_id) REFERENCES actor_contexts(actor_id,context_id))`);
  exec(`CREATE TABLE IF NOT EXISTS context_revisions (
    actor_id TEXT NOT NULL, context_id TEXT NOT NULL, revision INTEGER NOT NULL,
    author TEXT NOT NULL, cause TEXT NOT NULL, turn_id TEXT, proposal_id TEXT, recorded_at INTEGER NOT NULL,
    PRIMARY KEY(actor_id,context_id,revision), CHECK(revision >= 0),
    FOREIGN KEY(actor_id,context_id) REFERENCES actor_contexts(actor_id,context_id),
    FOREIGN KEY(actor_id,proposal_id) REFERENCES context_proposals(actor_id,proposal_id))`);
  exec(`CREATE TABLE IF NOT EXISTS context_memberships (
    actor_id TEXT NOT NULL, context_id TEXT NOT NULL, entry_id TEXT NOT NULL,
    from_revision INTEGER NOT NULL, to_revision INTEGER, position INTEGER NOT NULL,
    message_id TEXT NOT NULL,
    PRIMARY KEY(actor_id,context_id,entry_id,from_revision),
    CHECK(position >= 0), CHECK(to_revision IS NULL OR to_revision > from_revision),
    FOREIGN KEY(actor_id,context_id,from_revision) REFERENCES context_revisions(actor_id,context_id,revision),
    FOREIGN KEY(actor_id,context_id,to_revision) REFERENCES context_revisions(actor_id,context_id,revision),
    FOREIGN KEY(actor_id,message_id) REFERENCES session_messages(actor_id,message_id))`);
  exec(`CREATE UNIQUE INDEX IF NOT EXISTS context_live_entry ON context_memberships(actor_id,context_id,entry_id) WHERE to_revision IS NULL`);
  exec(`CREATE UNIQUE INDEX IF NOT EXISTS context_live_position ON context_memberships(actor_id,context_id,position) WHERE to_revision IS NULL`);
  exec(`CREATE INDEX IF NOT EXISTS context_history_members ON context_memberships(actor_id,context_id,from_revision,to_revision,position)`);
  exec(`CREATE INDEX IF NOT EXISTS context_message_members ON context_memberships(actor_id,message_id)`);
  exec(`CREATE TABLE IF NOT EXISTS context_proposals (
    actor_id TEXT NOT NULL, proposal_id TEXT NOT NULL, context_id TEXT NOT NULL, base_revision INTEGER NOT NULL,
    author TEXT NOT NULL, via TEXT NOT NULL, cause TEXT NOT NULL, turn_id TEXT, build_identity TEXT,
    status TEXT NOT NULL CHECK(status IN ('pending','applied','closed')),
    deferred_reason TEXT, deferred_at INTEGER, closed_reason TEXT, recorded_at INTEGER NOT NULL,
    PRIMARY KEY(actor_id,proposal_id),
    FOREIGN KEY(actor_id,context_id,base_revision) REFERENCES context_revisions(actor_id,context_id,revision))`);
  exec(`CREATE UNIQUE INDEX IF NOT EXISTS context_pending_proposal ON context_proposals(actor_id,context_id) WHERE status='pending'`);
  exec(`CREATE TABLE IF NOT EXISTS context_proposal_entries (
    actor_id TEXT NOT NULL, proposal_id TEXT NOT NULL, entry_id TEXT NOT NULL,
    expected_message_id TEXT, message_id TEXT, position INTEGER,
    PRIMARY KEY(actor_id,proposal_id,entry_id),
    CHECK((message_id IS NULL AND expected_message_id IS NOT NULL AND position IS NULL) OR (message_id IS NOT NULL AND position IS NOT NULL AND position >= 0)),
    FOREIGN KEY(actor_id,proposal_id) REFERENCES context_proposals(actor_id,proposal_id),
    FOREIGN KEY(actor_id,expected_message_id) REFERENCES session_messages(actor_id,message_id),
    FOREIGN KEY(actor_id,message_id) REFERENCES session_messages(actor_id,message_id))`);
  exec(`CREATE TABLE IF NOT EXISTS context_proposal_sources (
    actor_id TEXT NOT NULL, proposal_id TEXT NOT NULL, output_message_id TEXT NOT NULL, output_part_no INTEGER NOT NULL,
    source_entry_id TEXT NOT NULL, source_message_id TEXT NOT NULL, source_part_no INTEGER NOT NULL,
    PRIMARY KEY(actor_id,proposal_id,output_message_id,output_part_no,source_entry_id,source_message_id,source_part_no),
    CHECK(output_part_no >= 0), CHECK(source_part_no >= 0),
    FOREIGN KEY(actor_id,proposal_id) REFERENCES context_proposals(actor_id,proposal_id),
    FOREIGN KEY(actor_id,output_message_id) REFERENCES session_messages(actor_id,message_id),
    FOREIGN KEY(actor_id,source_message_id) REFERENCES session_messages(actor_id,message_id))`);
  exec(`CREATE TABLE IF NOT EXISTS actor_requests (
    actor_id TEXT NOT NULL REFERENCES workspace_actors(actor_id), request_id TEXT NOT NULL, turn_id TEXT NOT NULL, run_id TEXT NOT NULL,
    epoch INTEGER NOT NULL, step_index INTEGER, revision INTEGER NOT NULL,
    context_id TEXT NOT NULL, context_revision INTEGER NOT NULL,
    metadata_json TEXT, metadata_path TEXT, metadata_digest TEXT, recorded_at INTEGER NOT NULL,
    PRIMARY KEY(actor_id,request_id), UNIQUE(actor_id,turn_id,epoch,revision),
    FOREIGN KEY(actor_id,context_id,context_revision) REFERENCES context_revisions(actor_id,context_id,revision),
    CHECK((metadata_json IS NOT NULL AND metadata_path IS NULL AND metadata_digest IS NULL)
      OR (metadata_json IS NULL AND metadata_path IS NOT NULL AND metadata_digest IS NOT NULL)))`);
  // `lastStep` names the literal `step_index IS NOT NULL`.
  exec(`CREATE INDEX IF NOT EXISTS actor_step_requests ON actor_requests(actor_id,recorded_at) WHERE step_index IS NOT NULL`);
  // A step's list is a revision of the actor's unselected `requests` context.
  exec(`CREATE TABLE IF NOT EXISTS request_renders (
    actor_id TEXT NOT NULL, request_id TEXT NOT NULL, context_id TEXT NOT NULL, revision INTEGER NOT NULL,
    PRIMARY KEY(actor_id,request_id),
    FOREIGN KEY(actor_id,request_id) REFERENCES actor_requests(actor_id,request_id),
    FOREIGN KEY(actor_id,context_id,revision) REFERENCES context_revisions(actor_id,context_id,revision))`);
}

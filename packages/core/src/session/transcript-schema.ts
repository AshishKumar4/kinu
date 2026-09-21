import type { RawSqlExec } from '../types/primitives';

/** Public conversation structure references canonical parts, independently of working-context selection. */
/** The chat session every conversational read and write uses. */
export const CHAT_SESSION_ID = 'default';

/** The transcript session a lifetime search writes its trajectories into; never indexed or browsed as chat. */
export const MCTS_SESSION_ID = 'mcts';

export function initSessionTranscriptTables(exec: RawSqlExec): void {
  exec(`CREATE TABLE IF NOT EXISTS conversation_entries (
    actor_id TEXT NOT NULL,
    session_id TEXT NOT NULL,
    id TEXT NOT NULL,
    parent_id TEXT,
    role TEXT NOT NULL CHECK(role IN ('user','assistant','system','tool')),
    turn_id TEXT,
    run_id TEXT,
    metadata_json TEXT,
    metadata_path TEXT,
    metadata_digest TEXT,
    recorded_at INTEGER NOT NULL,
    context_id TEXT,
    context_revision INTEGER,
    PRIMARY KEY(actor_id,session_id,id),
    FOREIGN KEY(actor_id) REFERENCES workspace_actors(actor_id),
    FOREIGN KEY(actor_id,session_id,parent_id) REFERENCES conversation_entries(actor_id,session_id,id),
    FOREIGN KEY(actor_id,context_id,context_revision) REFERENCES context_revisions(actor_id,context_id,revision),
    CHECK((context_id IS NULL) = (context_revision IS NULL)),
    CHECK(parent_id IS NULL OR parent_id != id),
    CHECK((metadata_json IS NULL AND metadata_path IS NULL AND metadata_digest IS NULL)
      OR (metadata_json IS NOT NULL AND metadata_path IS NULL AND metadata_digest IS NULL)
      OR (metadata_json IS NULL AND metadata_path IS NOT NULL AND metadata_digest IS NOT NULL))
  )`);
  exec(`CREATE INDEX IF NOT EXISTS conversation_parent
    ON conversation_entries(actor_id,session_id,parent_id)`);
  exec(`CREATE INDEX IF NOT EXISTS conversation_recent
    ON conversation_entries(actor_id,session_id,recorded_at DESC,id)`);
  exec(`CREATE TABLE IF NOT EXISTS conversation_heads (
    actor_id TEXT NOT NULL, session_id TEXT NOT NULL, entry_id TEXT,
    PRIMARY KEY(actor_id,session_id),
    FOREIGN KEY(actor_id,session_id,entry_id) REFERENCES conversation_entries(actor_id,session_id,id)
  )`);
  exec(`CREATE TABLE IF NOT EXISTS conversation_entry_parts (
    actor_id TEXT NOT NULL,
    session_id TEXT NOT NULL,
    entry_id TEXT NOT NULL,
    position INTEGER NOT NULL CHECK(position >= 0),
    message_id TEXT NOT NULL,
    part_no INTEGER NOT NULL CHECK(part_no >= 0),
    through_sequence INTEGER NOT NULL CHECK(through_sequence >= 0),
    text_start INTEGER,
    text_length INTEGER,
    CHECK((text_start IS NULL AND text_length IS NULL) OR
      (text_start IS NOT NULL AND text_length IS NOT NULL AND text_start >= 0 AND text_length >= 0)), 
    PRIMARY KEY(actor_id,session_id,entry_id,position),
    FOREIGN KEY(actor_id,session_id,entry_id) REFERENCES conversation_entries(actor_id,session_id,id) ON DELETE CASCADE,
    FOREIGN KEY(actor_id,message_id,part_no) REFERENCES message_parts(actor_id,message_id,part_no),
    FOREIGN KEY(actor_id,message_id,through_sequence) REFERENCES message_updates(actor_id,message_id,sequence)
  )`);
}

-- An agent database as rc29 (62b6c90c6) made it: its own init (openAgentDatabase) and stores, a recorded and indexed turn, a split. Stamp 106277352.
CREATE TABLE workspace_identity (
    -- One row per database: a second identity is refused, not arbitrated by readers.
    singleton  INTEGER NOT NULL DEFAULT 1 UNIQUE CHECK (singleton = 1),
    id         TEXT NOT NULL,
    name       TEXT NOT NULL,
    owner_user_id TEXT NOT NULL DEFAULT '',
    created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
  );
CREATE TABLE fork_lineage (
    id                            INTEGER PRIMARY KEY,
    source_workspace_id           TEXT    NOT NULL,
    source_workspace_name         TEXT    NOT NULL,
    source_message_id             TEXT    NOT NULL,
    source_message_created_at     INTEGER NOT NULL,
    forked_at                     INTEGER NOT NULL
  );
CREATE TABLE fork_transfer (
    id                              INTEGER PRIMARY KEY CHECK (id = 1),
    head_declared                   INTEGER NOT NULL DEFAULT 0,
    head_source_id                  TEXT    NOT NULL DEFAULT '',
    head_source_name                TEXT    NOT NULL DEFAULT '',
    head_cut_message_id             TEXT    NOT NULL DEFAULT '',
    head_cut_created_at             INTEGER NOT NULL DEFAULT 0,
    transfer_id                     TEXT,
    expected_seq                    INTEGER NOT NULL DEFAULT 0,
    section_cursor                  INTEGER NOT NULL DEFAULT 0,
    stream                          TEXT    NOT NULL DEFAULT '',
    import_path                     TEXT,
    want_files                      INTEGER NOT NULL DEFAULT 0,
    published                       INTEGER NOT NULL DEFAULT 0
  );
CREATE TABLE fork_transfer_counts (
    section  TEXT    PRIMARY KEY,
    declared INTEGER NOT NULL DEFAULT 0,
    staged   INTEGER NOT NULL DEFAULT 0
  );
CREATE TABLE fork_staged_files (
    path TEXT PRIMARY KEY
  );
CREATE TABLE workspace_actors (
    actor_id TEXT PRIMARY KEY,
    parent_actor_id TEXT REFERENCES workspace_actors(actor_id),
    name TEXT NOT NULL,
    storage_key TEXT NOT NULL,
    origin TEXT NOT NULL CHECK (origin IN ('system','user','agent','swarm','evolution')),
    lifetime TEXT NOT NULL CHECK (lifetime IN ('durable','task')),
    created_at INTEGER NOT NULL,
    creation_id TEXT NOT NULL,
    retiring_at INTEGER,
    deleted_at INTEGER,
    UNIQUE (parent_actor_id, creation_id),
    UNIQUE (parent_actor_id, storage_key),
    CHECK ((origin = 'system') = (parent_actor_id IS NULL)),
    CHECK (origin IN ('system','agent') OR lifetime = (CASE origin WHEN 'user' THEN 'durable' ELSE 'task' END))
  );
CREATE TABLE agent_deliveries (
    seq        INTEGER PRIMARY KEY AUTOINCREMENT,
    actor_id   TEXT NOT NULL,
    id         TEXT NOT NULL,
    input_json TEXT NOT NULL,
    authorship TEXT NOT NULL CHECK (authorship IN ('owner','hirer')),
    UNIQUE (actor_id, id)
  );
CREATE TABLE agent_figures (
    actor_id TEXT PRIMARY KEY REFERENCES workspace_actors(actor_id),
    figures  TEXT NOT NULL
  );
CREATE TABLE agent_figure_folds ( /* derived from run_events: through is a rowid of its */
    actor_id TEXT PRIMARY KEY,
    through  INTEGER NOT NULL,
    totals   TEXT NOT NULL
  );
CREATE TABLE actor_subordinates (
    actor_id      TEXT NOT NULL,
    name          TEXT NOT NULL,
    status        TEXT NOT NULL CHECK (status IN ('idle','working','awaiting_input','dismissed')),
    current_task  TEXT,
    created_at    INTEGER NOT NULL,
    dismissed_at INTEGER,
    task_event_id TEXT,
    actor_reference TEXT,
    birth_request TEXT, delete_requested INTEGER NOT NULL DEFAULT 0 CHECK (delete_requested IN (0,1)),
    PRIMARY KEY (actor_id, name)
  );
CREATE TABLE evolution_helpers (
    actor_id        TEXT NOT NULL,
    name            TEXT NOT NULL,
    lane_request_id TEXT NOT NULL,
    answer_status   TEXT CHECK (answer_status IN ('completed','blocked')),
    answer          TEXT,
    created_at      INTEGER NOT NULL,
    PRIMARY KEY (actor_id, name)
  );
CREATE TABLE fibers (
    actor_id   TEXT NOT NULL,
    id         TEXT NOT NULL,
    name       TEXT NOT NULL,
    snapshot   TEXT,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (actor_id, id)
  );
CREATE TABLE evolution_events (
    actor_id   TEXT NOT NULL,
    id         TEXT NOT NULL DEFAULT (lower(hex(randomblob(9)))),
    type       TEXT NOT NULL,
    message    TEXT NOT NULL,
    data       TEXT,
    created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
    PRIMARY KEY (actor_id, id)
  );
CREATE TABLE executor_output (
    actor_id   TEXT NOT NULL,
    id         TEXT NOT NULL DEFAULT (lower(hex(randomblob(9)))),
    executor   TEXT NOT NULL,
    command    TEXT NOT NULL,
    stdout     TEXT,
    stdout_len INTEGER,
    stderr     TEXT,
    stderr_len INTEGER,
    exit_code  INTEGER,
    created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
    PRIMARY KEY (actor_id, id)
  );
CREATE TABLE activity_log (
    actor_id   TEXT NOT NULL,
    id         TEXT NOT NULL DEFAULT (lower(hex(randomblob(9)))),
    event      TEXT NOT NULL,
    detail     TEXT,
    elapsed_ms INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
    PRIMARY KEY (actor_id, id)
  );
CREATE TABLE search_nodes (
      actor_id         TEXT NOT NULL,
      id               TEXT NOT NULL,
      parent_id        TEXT,
      root_id          TEXT NOT NULL,
      -- The search's task, on its root; a child's is its root's, read through search_node_scores.
      task             TEXT,
      action           TEXT NOT NULL DEFAULT '',
      observation      TEXT NOT NULL DEFAULT '',
      visits           INTEGER NOT NULL DEFAULT 0,
      value            REAL NOT NULL DEFAULT 0,
      depth            INTEGER NOT NULL DEFAULT 0,
      status           TEXT NOT NULL DEFAULT 'open'
                       CHECK(status IN ('open','terminal','failed','pruned')),
      created_at       INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
      PRIMARY KEY (actor_id, id),
      CHECK(parent_id IS NOT NULL OR task IS NOT NULL)
    );
CREATE TABLE scaffold_versions (
      actor_id       TEXT NOT NULL,
      version        INTEGER NOT NULL,
      written_at     INTEGER NOT NULL,
      rationale      TEXT NOT NULL,
      status         TEXT NOT NULL DEFAULT 'current',
      parent_version INTEGER,
      pathology      TEXT,
      PRIMARY KEY (actor_id, version)
    );
CREATE TABLE crafted_tools (
			name TEXT PRIMARY KEY,
			description TEXT NOT NULL DEFAULT '',
			code TEXT NOT NULL DEFAULT '',
			created_at INTEGER NOT NULL DEFAULT 0,
			updated_at INTEGER NOT NULL DEFAULT 0,
			offered INTEGER NOT NULL DEFAULT 0,
			chosen INTEGER NOT NULL DEFAULT 0,
			rated INTEGER NOT NULL DEFAULT 0,
			rating_sum REAL NOT NULL DEFAULT 0,
			broken TEXT,
			last_used_at INTEGER NOT NULL DEFAULT 0
		);
CREATE VIRTUAL TABLE crafted_tools_fts USING fts5(
			name, description,
			content=crafted_tools, content_rowid=rowid
		);
CREATE TABLE alternate_takes (
    actor_id TEXT NOT NULL,
    id TEXT NOT NULL,
    turn_id TEXT,
    session_id TEXT,
    task TEXT NOT NULL,
    chosen_node_id TEXT,
    candidates TEXT NOT NULL,
    settlement_key TEXT,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (actor_id, id)
  );
CREATE TABLE effect_tombstones (
    actor_id    TEXT NOT NULL,
    scope       TEXT NOT NULL,
    key         TEXT NOT NULL,
    PRIMARY KEY (actor_id, scope, key)
  );
CREATE TABLE exploration_records (
  actor_id          TEXT NOT NULL,
  record_key        TEXT NOT NULL,
  objective_id      TEXT NOT NULL,
  floor_digest      TEXT,
  descriptor        TEXT,
  artifact_digest   TEXT NOT NULL,
  artifact          TEXT NOT NULL,
  value             REAL NOT NULL,
  detail            TEXT NOT NULL,
  measured_json     TEXT,
  preset            TEXT NOT NULL,
  label             TEXT,
  root_id           TEXT NOT NULL,
  config_digest     TEXT NOT NULL,
  depth             INTEGER NOT NULL,
  branches          INTEGER NOT NULL,
  floor_value       REAL,
  floor_proof       TEXT,
  cost_tokens       INTEGER,
  first_recorded_at INTEGER NOT NULL,
  displacements     INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (actor_id, record_key)
);
CREATE TABLE exploration_objectives (
  actor_id        TEXT NOT NULL,
  objective_id    TEXT NOT NULL,
  metric          TEXT NOT NULL,
  unit            TEXT NOT NULL,
  direction       TEXT NOT NULL,
  scale           TEXT NOT NULL,
  verifier_digest TEXT NOT NULL,
  PRIMARY KEY (actor_id, objective_id)
);
CREATE TABLE exploration_seals (
  actor_id     TEXT NOT NULL,
  objective_id TEXT NOT NULL,
  floor_digest TEXT NOT NULL,
  breach_json  TEXT NOT NULL,
  PRIMARY KEY (actor_id, objective_id, floor_digest)
);
CREATE TABLE swarm_node_records (
    actor_id    TEXT NOT NULL,
    node_id     TEXT NOT NULL,
    root_id     TEXT NOT NULL,
    record_json TEXT NOT NULL,
    merged_at   INTEGER,
    PRIMARY KEY (actor_id, node_id)
  );
CREATE TABLE lessons (
    actor_id TEXT NOT NULL,
    id TEXT NOT NULL,
    turn_ids TEXT NOT NULL,
    text TEXT NOT NULL,
    source TEXT NOT NULL CHECK (source IN ('execution_recovery','import')),
    created_at INTEGER NOT NULL,
    corroborated_at INTEGER,
    PRIMARY KEY (actor_id, id)
  );
CREATE TABLE pattern_extractions (
    actor_id   TEXT NOT NULL,
    effect_key TEXT NOT NULL,
    answer     TEXT NOT NULL,
    PRIMARY KEY (actor_id, effect_key)
  );
CREATE TABLE turn_ratings (
    actor_id TEXT NOT NULL,
    id TEXT NOT NULL,
    turn_id TEXT NOT NULL,
    score REAL NOT NULL CHECK (score >= 1 AND score <= 5),
    corrected REAL NOT NULL CHECK (corrected >= 0 AND corrected <= 1),
    wrong TEXT CHECK (wrong IN ('nothing','misunderstood','incomplete','incorrect','ignored_instruction','broke_something','unrecovered_error','verbose_or_slow','needless_question')),
    source TEXT NOT NULL CHECK (source IN ('thumbs','take_pick','model')),
    request TEXT NOT NULL,
    actions TEXT NOT NULL,
    answer TEXT NOT NULL,
    followup TEXT,
    scaffold_version INTEGER,
    artifacts_json TEXT,
    picks_json TEXT,
    rejects TEXT,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (actor_id, id)
  );
CREATE TABLE completed_turns (
    actor_id   TEXT NOT NULL,
    id         TEXT NOT NULL,
    turn       TEXT NOT NULL,
    followup   TEXT,
    in_window  INTEGER NOT NULL,
    review     TEXT NOT NULL CHECK (review IN ('none','awaiting_followup','queued','claimed','done')),
    created_at INTEGER NOT NULL,
    PRIMARY KEY (actor_id, id)
  );
CREATE TABLE opened_turns (
    actor_id  TEXT NOT NULL,
    turn_id   TEXT NOT NULL,
    review_id TEXT,
    followup  TEXT,
    PRIMARY KEY (actor_id, turn_id)
  );
CREATE TABLE turn_struggles (
    actor_id   TEXT NOT NULL,
    turn_id    TEXT NOT NULL,
    errors     INTEGER NOT NULL,
    steps      INTEGER NOT NULL,
    struggles  TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (actor_id, turn_id)
  );
CREATE TABLE tool_lessons (
    actor_id   TEXT NOT NULL,
    id         TEXT NOT NULL,
    tool       TEXT NOT NULL,
    text       TEXT NOT NULL,
    revision   INTEGER NOT NULL,
    helpful    INTEGER NOT NULL,
    harmful    INTEGER NOT NULL,
    turn_ids   TEXT NOT NULL,
    status     TEXT NOT NULL CHECK (status IN ('active','retired')),
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (actor_id, id)
  );
CREATE TABLE refinement_requests (
    actor_id   TEXT NOT NULL,
    id         TEXT NOT NULL,
    trigger    TEXT NOT NULL CHECK (trigger IN ('explicit','cadence','idle')),
    scope      TEXT NOT NULL CHECK (scope IN ('workspace','account')),
    stage      TEXT NOT NULL CHECK (stage IN ('requested','planning','gated','evaluating','applied','rolled_back','refused')),
    -- The pass holding this row, non-null exactly while it is planning. A lease
    -- identity, never a deadline: it says WHO is planning, and nothing at all
    -- about for how long.
    claim      TEXT,
    turn_ids   TEXT NOT NULL,
    debt_key   TEXT,
    proposal   TEXT,
    review_json TEXT,
    routes     TEXT NOT NULL,
    detail     TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (actor_id, id)
  );
CREATE TABLE agent_log (
  actor_id            TEXT    NOT NULL,
  id                  TEXT    NOT NULL,
  kind                TEXT    NOT NULL
                              CHECK(kind IN ('event', 'reply_attempt')),
  turn_id             TEXT,
  step_idx            INTEGER,
  parent_id           TEXT,
  trace_id            TEXT    NOT NULL,
  ingress             TEXT,
  variant             TEXT,
  trust               TEXT    CHECK(trust IS NULL OR trust IN ('external', 'authenticated', 'owner', 'self')),
  priority            TEXT    CHECK(priority IS NULL OR priority IN ('urgent', 'normal', 'background')),
  payload_visibility  TEXT    CHECK(payload_visibility IS NULL OR payload_visibility IN ('full', 'redact', 'hash', 'hmac', 'opaque_handle')),
  payload             TEXT    NOT NULL DEFAULT 'null',
  received_at         INTEGER NOT NULL,
  dedupe_key          TEXT,
  consumed_at         INTEGER,
  PRIMARY KEY (actor_id, id)
);
CREATE TABLE reply_channels (
  actor_id            TEXT    NOT NULL,
  id                  TEXT    NOT NULL,
  event_id            TEXT    NOT NULL,
  kind                TEXT    NOT NULL
                              CHECK(kind IN ('peer_back', 'email_thread')),
  holder_addr         TEXT    NOT NULL DEFAULT '',
  ttl_expires_at      INTEGER NOT NULL,
  state               TEXT    NOT NULL DEFAULT 'open'
                              CHECK(state IN ('open', 'replied', 'expired', 'aborted')),
  created_at          INTEGER NOT NULL,
  PRIMARY KEY (actor_id, id)
);
CREATE TABLE triggers (
  actor_id            TEXT    NOT NULL,
  id                  TEXT    NOT NULL,
  kind                TEXT    NOT NULL
                              CHECK(kind IN (
                                'webhook_durable', 'webhook_ephemeral',
                                'timer_oneshot', 'timer_cron',
                                -- Retired with the old mail ingress (docs/MAIL.md §11): no row holds it, and none
                                -- is written; the CHECK keeps it so deployed storage's definition is unchanged.
                                'email_route'
                              )),
  spec                TEXT    NOT NULL DEFAULT '{}',
  creator_trust       TEXT    NOT NULL
                              CHECK(creator_trust IN ('external', 'authenticated', 'owner', 'self')),
  fork_policy         TEXT
                              CHECK(fork_policy IS NULL OR fork_policy IN ('copy', 'sever', 'share')),
  state               TEXT    NOT NULL DEFAULT 'active'
                              CHECK(state IN ('active', 'paused', 'revoked')),
  rate_limit_per_min  INTEGER NOT NULL DEFAULT 60,
  created_at          INTEGER NOT NULL,
  paused_at           INTEGER,
  revoked_at          INTEGER,
  next_fire_at        INTEGER,
  last_fire_at        INTEGER,
  fire_count          INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (actor_id, id)
);
CREATE TABLE head_runs (
    actor_id TEXT NOT NULL,
    root_id TEXT NOT NULL,
    rationale TEXT,
    spawned_at INTEGER NOT NULL,
    PRIMARY KEY (actor_id, root_id)
  );
CREATE TABLE head_journal (
  actor_id TEXT NOT NULL,
  id TEXT NOT NULL,
  parent_id TEXT,
  root_id TEXT NOT NULL,
  depth INTEGER NOT NULL,
  task TEXT NOT NULL,
  rationale TEXT,
  status TEXT NOT NULL,
  spawned_at INTEGER NOT NULL,
  completed_at INTEGER,
  token_input INTEGER,
  token_output INTEGER,
  token_cache_read INTEGER,
  token_cache_write INTEGER,
  token_cache_write_1h INTEGER,
  token_reasoning INTEGER,
  neurons REAL,
  wall_clock_ms INTEGER DEFAULT 0,
  summary TEXT,
  error_message TEXT,
  decisions_json TEXT,
  file_changes_json TEXT,
  merge_strategy TEXT NOT NULL DEFAULT 'synthesize',
  PRIMARY KEY (actor_id, id)
);
CREATE TABLE head_steps (
    actor_id TEXT NOT NULL,
    head_id TEXT NOT NULL,
    seq INTEGER NOT NULL,
    id TEXT GENERATED ALWAYS AS (head_id || '-s' || seq) VIRTUAL,
    parts_json TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (actor_id, head_id, seq)
  );
CREATE TABLE head_merge_results (
  actor_id TEXT NOT NULL,
  root_id TEXT NOT NULL,
  merged_narrative TEXT NOT NULL,
  PRIMARY KEY (actor_id, root_id)
);
CREATE TABLE run_events (
    actor_id TEXT NOT NULL,
    run_id TEXT NOT NULL,
    event_index INTEGER NOT NULL,
    type TEXT NOT NULL,
    payload TEXT NOT NULL,
    ts TEXT NOT NULL,
    PRIMARY KEY (actor_id, run_id, event_index)
  );
CREATE TABLE open_turns (
    actor_id TEXT NOT NULL,
    run_id TEXT NOT NULL,
    opened_at TEXT NOT NULL,
    PRIMARY KEY (actor_id, run_id)
  );
CREATE TABLE agent_sequence (
    actor_id TEXT PRIMARY KEY,
    seq      INTEGER NOT NULL
  );
CREATE TABLE actor_turn_claims (
    actor_id TEXT NOT NULL REFERENCES workspace_actors(actor_id), turn_id TEXT NOT NULL, run_id TEXT NOT NULL, epoch INTEGER NOT NULL,
    work_mode TEXT NOT NULL CHECK(work_mode IN ('plan','build')),
    phase TEXT NOT NULL CHECK(phase IN ('preparing','admitted')),
    program_kind TEXT CHECK(program_kind IS NULL OR program_kind IN ('builtin','scaffold')),
    program_version INTEGER, program_digest TEXT, program_build TEXT,
    outcome TEXT CHECK(outcome IS NULL OR outcome IN ('completed','aborted','error','incomplete','indeterminate')),
    claimed_at INTEGER NOT NULL, withdrawn_through INTEGER NOT NULL DEFAULT 0,
    facts_json TEXT, profile_json TEXT, inputs_key TEXT,
    answered INTEGER NOT NULL DEFAULT 0 CHECK(answered IN (0,1)),
    PRIMARY KEY(actor_id,turn_id));
CREATE TABLE actor_turn_cuts (
    actor_id TEXT NOT NULL, turn_id TEXT NOT NULL, epoch INTEGER NOT NULL, build TEXT,
    phase TEXT NOT NULL CHECK(phase IN ('provider','work')), phase_at INTEGER NOT NULL,
    work_cuts INTEGER NOT NULL, provider_cuts INTEGER NOT NULL,
    oom INTEGER NOT NULL DEFAULT 0 CHECK(oom IN (0,1)), oom_cuts INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY(actor_id,turn_id));
CREATE TABLE actor_profile_inputs (
    actor_id TEXT NOT NULL, inputs_key TEXT NOT NULL, inputs_json TEXT NOT NULL,
    PRIMARY KEY(actor_id,inputs_key));
CREATE TABLE session_messages (
    actor_id TEXT NOT NULL REFERENCES workspace_actors(actor_id), message_id TEXT NOT NULL, role TEXT NOT NULL CHECK(role IN ('system','user','assistant','tool')),
    native_content_kind TEXT NOT NULL CHECK(native_content_kind IN ('string','parts')),
    origin TEXT NOT NULL CHECK(origin IN ('input','output','edit','context_transform','render')),
    request_id TEXT, output_slot INTEGER, ingress_id TEXT,
    envelope_json TEXT NOT NULL,
    sealed_at INTEGER, content_json TEXT, content_path TEXT,
    PRIMARY KEY(actor_id,message_id), UNIQUE(actor_id,request_id,output_slot),
    FOREIGN KEY(actor_id,request_id) REFERENCES actor_requests(actor_id,request_id),
    CHECK(output_slot IS NULL OR output_slot >= 0),
    CHECK((request_id IS NULL) = (output_slot IS NULL)),
    CHECK((sealed_at IS NULL AND content_json IS NULL AND content_path IS NULL)
      OR (sealed_at IS NOT NULL AND (content_json IS NULL) <> (content_path IS NULL))));
CREATE TABLE stream_parts (
    actor_id TEXT NOT NULL, message_id TEXT NOT NULL, part_no INTEGER NOT NULL, segment INTEGER NOT NULL,
    stream_order INTEGER NOT NULL,
    descriptor_json TEXT, descriptor_path TEXT,
    text TEXT NOT NULL DEFAULT '', ended INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY(actor_id,message_id,part_no,segment),
    FOREIGN KEY(actor_id,message_id) REFERENCES session_messages(actor_id,message_id),
    CHECK(part_no >= 0), CHECK(segment >= 0), CHECK(stream_order >= 0), CHECK(ended IN (0,1)),
    CHECK((segment > 0 AND descriptor_json IS NULL AND descriptor_path IS NULL)
      OR (segment = 0 AND (descriptor_json IS NULL) <> (descriptor_path IS NULL))));
CREATE TABLE actor_contexts (
    actor_id TEXT NOT NULL REFERENCES workspace_actors(actor_id), context_id TEXT NOT NULL,
    PRIMARY KEY(actor_id,context_id));
CREATE TABLE actor_context_selection (
    actor_id TEXT PRIMARY KEY REFERENCES workspace_actors(actor_id), context_id TEXT NOT NULL,
    FOREIGN KEY(actor_id,context_id) REFERENCES actor_contexts(actor_id,context_id));
CREATE TABLE context_revisions (
    actor_id TEXT NOT NULL, context_id TEXT NOT NULL, revision INTEGER NOT NULL,
    author TEXT NOT NULL, cause TEXT NOT NULL, turn_id TEXT, proposal_id TEXT, recorded_at INTEGER NOT NULL,
    PRIMARY KEY(actor_id,context_id,revision), CHECK(revision >= 0),
    FOREIGN KEY(actor_id,context_id) REFERENCES actor_contexts(actor_id,context_id),
    FOREIGN KEY(actor_id,proposal_id) REFERENCES context_proposals(actor_id,proposal_id));
CREATE TABLE context_memberships (
    actor_id TEXT NOT NULL, context_id TEXT NOT NULL, entry_id TEXT NOT NULL,
    from_revision INTEGER NOT NULL, to_revision INTEGER, position INTEGER NOT NULL,
    message_id TEXT NOT NULL,
    PRIMARY KEY(actor_id,context_id,entry_id,from_revision),
    CHECK(position >= 0), CHECK(to_revision IS NULL OR to_revision > from_revision),
    FOREIGN KEY(actor_id,context_id,from_revision) REFERENCES context_revisions(actor_id,context_id,revision),
    FOREIGN KEY(actor_id,context_id,to_revision) REFERENCES context_revisions(actor_id,context_id,revision),
    FOREIGN KEY(actor_id,message_id) REFERENCES session_messages(actor_id,message_id));
CREATE TABLE context_proposals (
    actor_id TEXT NOT NULL, proposal_id TEXT NOT NULL, context_id TEXT NOT NULL, base_revision INTEGER NOT NULL,
    author TEXT NOT NULL, via TEXT NOT NULL, cause TEXT NOT NULL, turn_id TEXT, build_identity TEXT,
    status TEXT NOT NULL CHECK(status IN ('pending','applied','closed')),
    deferred_reason TEXT, closed_reason TEXT, recorded_at INTEGER NOT NULL,
    PRIMARY KEY(actor_id,proposal_id),
    FOREIGN KEY(actor_id,context_id,base_revision) REFERENCES context_revisions(actor_id,context_id,revision));
CREATE TABLE context_proposal_entries (
    actor_id TEXT NOT NULL, proposal_id TEXT NOT NULL, entry_id TEXT NOT NULL,
    expected_message_id TEXT, message_id TEXT, position INTEGER,
    PRIMARY KEY(actor_id,proposal_id,entry_id),
    CHECK((message_id IS NULL AND expected_message_id IS NOT NULL AND position IS NULL) OR (message_id IS NOT NULL AND position IS NOT NULL AND position >= 0)),
    FOREIGN KEY(actor_id,proposal_id) REFERENCES context_proposals(actor_id,proposal_id),
    FOREIGN KEY(actor_id,expected_message_id) REFERENCES session_messages(actor_id,message_id),
    FOREIGN KEY(actor_id,message_id) REFERENCES session_messages(actor_id,message_id));
CREATE TABLE actor_requests (
    actor_id TEXT NOT NULL REFERENCES workspace_actors(actor_id), request_id TEXT NOT NULL, turn_id TEXT NOT NULL, run_id TEXT NOT NULL,
    epoch INTEGER NOT NULL, step_index INTEGER, revision INTEGER NOT NULL,
    context_id TEXT NOT NULL, context_revision INTEGER NOT NULL,
    metadata_json TEXT, metadata_path TEXT, recorded_at INTEGER NOT NULL,
    PRIMARY KEY(actor_id,request_id), UNIQUE(actor_id,turn_id,epoch,revision),
    FOREIGN KEY(actor_id,context_id,context_revision) REFERENCES context_revisions(actor_id,context_id,revision),
    CHECK((metadata_json IS NULL) <> (metadata_path IS NULL)));
CREATE TABLE request_renders (
    actor_id TEXT NOT NULL, request_id TEXT NOT NULL, context_id TEXT NOT NULL, revision INTEGER NOT NULL,
    PRIMARY KEY(actor_id,request_id),
    FOREIGN KEY(actor_id,request_id) REFERENCES actor_requests(actor_id,request_id),
    FOREIGN KEY(actor_id,context_id,revision) REFERENCES context_revisions(actor_id,context_id,revision));
CREATE TABLE conversation_entries (
    actor_id TEXT NOT NULL,
    session_id TEXT NOT NULL,
    id TEXT NOT NULL,
    position INTEGER NOT NULL CHECK(position >= 0),
    role TEXT NOT NULL CHECK(role IN ('user','assistant','system','tool')),
    turn_id TEXT,
    run_id TEXT,
    metadata_json TEXT,
    metadata_path TEXT,
    recorded_at INTEGER NOT NULL,
    context_id TEXT,
    context_revision INTEGER,
    PRIMARY KEY(actor_id,session_id,id),
    UNIQUE(actor_id,session_id,position),
    FOREIGN KEY(actor_id) REFERENCES workspace_actors(actor_id),
    FOREIGN KEY(actor_id,context_id,context_revision) REFERENCES context_revisions(actor_id,context_id,revision),
    CHECK((context_id IS NULL) = (context_revision IS NULL)),
    CHECK(metadata_json IS NULL OR metadata_path IS NULL)
  );
CREATE TABLE conversation_entry_parts (
    actor_id TEXT NOT NULL,
    session_id TEXT NOT NULL,
    entry_id TEXT NOT NULL,
    position INTEGER NOT NULL CHECK(position >= 0),
    message_id TEXT NOT NULL,
    part_no INTEGER NOT NULL CHECK(part_no >= 0),
    text_start INTEGER,
    text_length INTEGER,
    CHECK((text_start IS NULL AND text_length IS NULL) OR
      (text_start IS NOT NULL AND text_length IS NOT NULL AND text_start >= 0 AND text_length >= 0)), 
    PRIMARY KEY(actor_id,session_id,entry_id,position),
    FOREIGN KEY(actor_id,session_id,entry_id) REFERENCES conversation_entries(actor_id,session_id,id) ON DELETE CASCADE,
    FOREIGN KEY(actor_id,message_id) REFERENCES session_messages(actor_id,message_id)
  );
CREATE TABLE agent_turn_reports (
    actor_id TEXT NOT NULL,
    turn_id  TEXT NOT NULL,
    settled  INTEGER NOT NULL,
    PRIMARY KEY (actor_id, turn_id)
  );
CREATE TABLE agent_facts (
      actor_id         TEXT NOT NULL,
      key              TEXT NOT NULL,
      value_json       TEXT NOT NULL,
      confidence       REAL NOT NULL DEFAULT 1.0,
      source           TEXT,
      last_observed_at INTEGER NOT NULL,
      importance       REAL NOT NULL DEFAULT 0.5,
      veracity         TEXT NOT NULL DEFAULT 'stated',
      origin_json      TEXT,
      PRIMARY KEY (actor_id, key)
    );
CREATE TABLE agent_fact_history (
      actor_id    TEXT NOT NULL,
      key         TEXT NOT NULL,
      rev         INTEGER NOT NULL,
      value_json  TEXT,
      importance  REAL NOT NULL,
      veracity    TEXT NOT NULL,
      origin_json TEXT,
      at          INTEGER NOT NULL,
      PRIMARY KEY (actor_id, key, rev)
    );
CREATE TABLE proposed_tasks (
      actor_id           TEXT NOT NULL,
      id                 TEXT NOT NULL,
      task               TEXT NOT NULL,
      rationale          TEXT NOT NULL,
      predicted_success  REAL NOT NULL,
      targets_skills     TEXT NOT NULL,
      proposed_at        INTEGER NOT NULL,
      status             TEXT NOT NULL DEFAULT 'pending',
      PRIMARY KEY (actor_id, id)
    );
CREATE TABLE background_jobs (
    actor_id    TEXT NOT NULL,
    id          TEXT NOT NULL,
    kind        TEXT NOT NULL,
    label       TEXT,
    work_mode   TEXT NOT NULL DEFAULT 'build',
    status      TEXT NOT NULL DEFAULT 'running',
    result      TEXT,
    error       TEXT,
    input_json  TEXT,
    epoch       INTEGER NOT NULL DEFAULT 0,
    attempt_started_at INTEGER,
    resume_after INTEGER,
    retry_of TEXT,
    created_at  INTEGER NOT NULL,
    settled_at  INTEGER,
    PRIMARY KEY (actor_id, id)
  );
CREATE TABLE background_job_serves (
    actor_id TEXT NOT NULL,
    job_id   TEXT NOT NULL,
    port     INTEGER NOT NULL,
    PRIMARY KEY (actor_id, job_id)
  );
CREATE TABLE tool_effect_claims (
    actor_id           TEXT NOT NULL,
    turn_id            TEXT NOT NULL,
    run_id             TEXT NOT NULL,
    normalized_call_id TEXT NOT NULL,
    call_digest        TEXT NOT NULL,
    result_json        TEXT,
    PRIMARY KEY (actor_id, turn_id, run_id, normalized_call_id, call_digest)
  );
CREATE TABLE deferred_approvals (
    actor_id     TEXT NOT NULL,
    id           TEXT NOT NULL,
    command      TEXT NOT NULL,
    executor     TEXT NOT NULL DEFAULT '',
    context      TEXT NOT NULL DEFAULT '{}',
    reason       TEXT NOT NULL,
    status       TEXT NOT NULL DEFAULT 'queued',
    requested_at INTEGER NOT NULL,
    decided_at   INTEGER,
    spend_seq    INTEGER NOT NULL DEFAULT 0,
    surface      TEXT,
    PRIMARY KEY (actor_id, id)
  );
CREATE TABLE deferred_approval_hits ( /* derived from deferred_approvals: each hit names one */
    actor_id    TEXT NOT NULL,
    approval_id TEXT NOT NULL,
    rule        TEXT NOT NULL,
    decision    TEXT NOT NULL,
    PRIMARY KEY (actor_id, approval_id, rule)
  );
CREATE TABLE device_consent_asks (
    consent_id      TEXT PRIMARY KEY,
    actor_id        TEXT,
    device_id       TEXT NOT NULL,
    device_label    TEXT NOT NULL,
    method          TEXT NOT NULL,
    command         TEXT NOT NULL,
    workspace_name  TEXT,
    created_at      INTEGER NOT NULL,
    epoch           INTEGER NOT NULL,
    status          TEXT NOT NULL DEFAULT 'queued',
    decided_at      INTEGER,
    surface         TEXT
  );
CREATE TABLE agent_workspaces (
    actor_id    TEXT NOT NULL,
    workspace   TEXT NOT NULL,
    name        TEXT NOT NULL,
    brief       TEXT NOT NULL,
    created_at  INTEGER NOT NULL,
    PRIMARY KEY (actor_id, workspace)
  );
CREATE TABLE plan_reviews (
    actor_id         TEXT NOT NULL,
    id               TEXT NOT NULL,
    session_id       TEXT NOT NULL,
    revision         INTEGER NOT NULL,
    content          TEXT NOT NULL,
    status           TEXT NOT NULL,
    annotations_json TEXT NOT NULL DEFAULT '[]',
    feedback         TEXT,
    handoff_accepted INTEGER NOT NULL DEFAULT 0 CHECK (handoff_accepted IN (0, 1)),
    handoff_attempt  INTEGER NOT NULL DEFAULT 0 CHECK (handoff_attempt >= 0),
    created_at       INTEGER NOT NULL,
    updated_at       INTEGER NOT NULL,
    -- Every write to the row adds one: an agent's plans, summed, name each change a reader that is not here must see.
    writes           INTEGER NOT NULL DEFAULT 1,
    PRIMARY KEY (actor_id, id, revision)
  );
CREATE TABLE owner_questions (
    actor_id       TEXT NOT NULL,
    id             TEXT NOT NULL,
    call_id        TEXT NOT NULL,
    turn_id        TEXT NOT NULL,
    mode           TEXT NOT NULL,
    tier           TEXT,
    reason_json    TEXT NOT NULL,
    digest         TEXT NOT NULL,
    questions_json TEXT NOT NULL,
    status         TEXT NOT NULL,
    answers_json   TEXT,
    asked_at       INTEGER NOT NULL,
    closed_at      INTEGER,
    resumed_at     INTEGER,
    PRIMARY KEY (actor_id, id)
  );
CREATE TABLE github_items (
    repo         TEXT NOT NULL,
    number       INTEGER NOT NULL,
    subject      TEXT NOT NULL,
    title        TEXT,
    url          TEXT,
    state        TEXT,
    actors       TEXT NOT NULL,
    unattributed INTEGER NOT NULL,
    last_at      INTEGER NOT NULL,
    observed_at  INTEGER,
    PRIMARY KEY (repo, number)
  );
CREATE TABLE github_repos (
    repo            TEXT PRIMARY KEY,
    push_ref        TEXT,
    push_at         INTEGER,
    fetched_at      INTEGER,
    observed_branch TEXT,
    ci              TEXT,
    ci_at           INTEGER,
    observed_at     INTEGER
  );
CREATE TABLE github_nodes (
    node_id TEXT PRIMARY KEY,
    repo    TEXT NOT NULL,
    number  INTEGER NOT NULL,
    at      INTEGER NOT NULL
  );
CREATE TABLE instruction_approvals (
    actor_id TEXT NOT NULL,
    scope    TEXT NOT NULL,
    path     TEXT NOT NULL,
    digest   TEXT NOT NULL,
    decision TEXT NOT NULL CHECK (decision IN ('approved', 'revoked')),
    origin   TEXT NOT NULL DEFAULT 'owner' CHECK (origin IN ('owner', 'dream')),
    PRIMARY KEY (actor_id, scope, path)
  );
CREATE TABLE agent_tasks (
    actor_id   TEXT NOT NULL,
    seq        INTEGER NOT NULL,
    id         TEXT GENERATED ALWAYS AS ('t' || seq) VIRTUAL,
    parent_id  TEXT,
    title      TEXT NOT NULL,
    status     TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','active','done','dropped')),
    updated_at INTEGER NOT NULL,
    note       TEXT,
    plan_id    TEXT,
    revision   INTEGER,
    session_id TEXT,
    PRIMARY KEY (actor_id, seq)
  );
CREATE TABLE mcts_search_runs (
    actor_id     TEXT NOT NULL,
    root_id      TEXT NOT NULL,
    task         TEXT NOT NULL,
    config_json  TEXT NOT NULL,
    status       TEXT NOT NULL DEFAULT 'running',
    epoch        INTEGER NOT NULL DEFAULT 0,
    judge_samples_realised INTEGER,
    created_at   INTEGER NOT NULL,
    updated_at   INTEGER NOT NULL,
    PRIMARY KEY (actor_id, root_id)
  );
CREATE TABLE imported_experience (
    actor_id         TEXT NOT NULL,
    id               TEXT NOT NULL,
    library_id       TEXT NOT NULL,
    kind             TEXT NOT NULL CHECK (kind IN ('craft','lesson','fact','scaffold')),
    key              TEXT NOT NULL,
    title            TEXT NOT NULL,
    payload_json     TEXT NOT NULL,
    evidence         TEXT NOT NULL,
    source_workspace TEXT NOT NULL,
    turn_ids         TEXT NOT NULL,
    imported_at      INTEGER NOT NULL,
    -- Null while provisional.
    corroborated_at  INTEGER,
    PRIMARY KEY (actor_id, id)
  );
CREATE TABLE artifact_versions (
    actor_id    TEXT NOT NULL,
    artifact_id TEXT NOT NULL,
    version     INTEGER NOT NULL,
    body        TEXT NOT NULL,
    status      TEXT NOT NULL CHECK (status IN ('current','staged','rolled_back','historical')),
    parent      INTEGER,
    rationale   TEXT NOT NULL,
    evidence    TEXT,
    written_at  INTEGER NOT NULL,
    decided_at  INTEGER,
    PRIMARY KEY (actor_id, artifact_id, version)
  );
CREATE TABLE compaction_state (
      actor_id           TEXT NOT NULL,
      session_key        TEXT NOT NULL,
      plan_json          TEXT,
      last_prompt_tokens INTEGER,
      measured_at_length INTEGER,
      force_compaction   INTEGER,
      PRIMARY KEY (actor_id, session_key)
    );
CREATE TABLE compaction_archive (
      actor_id        TEXT NOT NULL,
      session_key     TEXT NOT NULL,
      range_hash      TEXT NOT NULL,
      start_turn      INTEGER NOT NULL,
      end_turn        INTEGER NOT NULL,
      user_turns      INTEGER NOT NULL,
      first_user_ask  TEXT NOT NULL,
      PRIMARY KEY (actor_id, session_key, range_hash)
    );
CREATE TABLE actor_config (
    actor_id TEXT NOT NULL, key TEXT NOT NULL, value TEXT NOT NULL, PRIMARY KEY (actor_id, key)
  );
CREATE TABLE cache_warm (
    actor_id       TEXT PRIMARY KEY,
    requests       INTEGER NOT NULL,
    refreshes      INTEGER NOT NULL,
    due_at         INTEGER,
    armed_requests INTEGER,
    spec           TEXT,
    model_id       TEXT,
    retention      TEXT,
    body           TEXT
  );
CREATE TABLE agent_data_tables (
    name TEXT PRIMARY KEY,
    scope TEXT NOT NULL CHECK(scope IN ('actor','workspace','private')),
    columns TEXT NOT NULL,
    created_by TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );
CREATE TABLE memory_note_chunks (
			id         TEXT PRIMARY KEY,
			path       TEXT    NOT NULL,
			start_line INTEGER NOT NULL,
			end_line   INTEGER NOT NULL,
			hash       TEXT    NOT NULL
		);
CREATE TABLE memory_projection_updates (
		revision INTEGER PRIMARY KEY AUTOINCREMENT,
		id TEXT NOT NULL UNIQUE,
		kind TEXT NOT NULL CHECK (kind IN ('upsert', 'delete'))
	);
CREATE TABLE memory_note_files (
			path  TEXT PRIMARY KEY,
			stamp TEXT
		);
CREATE VIRTUAL TABLE memory_note_chunks_fts USING fts5(
			text,
			content='',
			contentless_delete=1
		);
CREATE TABLE slates (
    id TEXT NOT NULL, workspace_id TEXT NOT NULL, revision INTEGER NOT NULL, bytes BLOB NOT NULL,
    PRIMARY KEY (id, revision)
  );
CREATE TABLE slate_versions (
    id TEXT PRIMARY KEY, slate_id TEXT NOT NULL, bytes BLOB NOT NULL
  );
CREATE TABLE slate_publications (
    id TEXT PRIMARY KEY, slate_id TEXT NOT NULL, bytes BLOB NOT NULL
  );
CREATE TABLE slate_state (
    slate_id TEXT NOT NULL, key TEXT NOT NULL, value TEXT NOT NULL,
    PRIMARY KEY (slate_id, key)
  );
CREATE TABLE ephemeral_slates (
    id TEXT PRIMARY KEY,
    drawn_at INTEGER NOT NULL
  );
CREATE TABLE slate_file_manifest (
    slate_id    TEXT NOT NULL,
    path        TEXT NOT NULL,
    size        INTEGER NOT NULL,
    mtime_ms    INTEGER NOT NULL,
    ino         INTEGER NOT NULL,
    content     TEXT NOT NULL,
    recorded_at INTEGER NOT NULL,
    PRIMARY KEY (slate_id, path)
  );
CREATE TABLE slate_shares (
    id TEXT PRIMARY KEY, slate_id TEXT NOT NULL, publication_id TEXT NOT NULL, included_paths TEXT NOT NULL,
    created_at INTEGER NOT NULL, revoked_at INTEGER
  );
CREATE TABLE slate_share_users (
    share_id TEXT NOT NULL REFERENCES slate_shares(id), user_id TEXT NOT NULL, email TEXT NOT NULL,
    created_at INTEGER NOT NULL, PRIMARY KEY (share_id, user_id)
  );
CREATE TABLE slate_live_shares (
    id TEXT PRIMARY KEY, slate_id TEXT NOT NULL, visibility TEXT NOT NULL CHECK (visibility IN ('users', 'public')),
    handle TEXT NOT NULL UNIQUE, grant_json TEXT NOT NULL, created_at INTEGER NOT NULL, revoked_at INTEGER,
    mode TEXT NOT NULL DEFAULT 'own' CHECK (mode IN ('own', 'owner')), grant_revision TEXT,
    listing_line TEXT,
    listing_category TEXT CHECK (listing_category IS NULL OR listing_category IN ('work', 'money', 'home', 'developer', 'fun')),
    CHECK ((mode = 'owner') = (grant_revision IS NOT NULL)),
    CHECK ((listing_line IS NULL) = (listing_category IS NULL)),
    CHECK (listing_line IS NULL OR mode = 'own')
  );
CREATE TABLE slate_live_share_users (
    share_id TEXT NOT NULL, user_id TEXT NOT NULL, email TEXT NOT NULL, created_at INTEGER NOT NULL,
    role TEXT NOT NULL DEFAULT 'use' CHECK (role IN ('use', 'edit')),
    PRIMARY KEY (share_id, user_id)
  );
CREATE TABLE slate_viewer_requests (
    id INTEGER PRIMARY KEY AUTOINCREMENT, share_id TEXT NOT NULL, viewer TEXT NOT NULL,
    path TEXT NOT NULL, calls TEXT NOT NULL, outcome TEXT NOT NULL, created_at INTEGER NOT NULL, settled_at INTEGER
  );
CREATE TABLE slate_edit_marks (
    slate_id TEXT PRIMARY KEY,
    editor TEXT NOT NULL,
    revision_before TEXT
  );
CREATE TABLE slate_share_views (
    share TEXT NOT NULL,
    viewer TEXT NOT NULL,
    opens INTEGER NOT NULL,
    PRIMARY KEY (share, viewer)
  );
CREATE TABLE pending_steers (
    seq      INTEGER PRIMARY KEY AUTOINCREMENT,
    actor_id TEXT NOT NULL,
    id       TEXT NOT NULL,
    turn_id  TEXT,
    mode     TEXT NOT NULL CHECK (mode IN ('plan','build')),
    text     TEXT NOT NULL,
    metadata_json TEXT,
    UNIQUE (actor_id, id)
  );
CREATE TABLE pending_steer_files (
    seq        INTEGER PRIMARY KEY AUTOINCREMENT,
    actor_id   TEXT NOT NULL,
    steer_id   TEXT NOT NULL,
    filename   TEXT NOT NULL,
    media_type TEXT NOT NULL,
    url        TEXT NOT NULL
  );
CREATE TABLE input_marks (
    actor_id      TEXT NOT NULL,
    producer      TEXT NOT NULL CHECK (producer IN ('workspace','self')),
    taken_through INTEGER NOT NULL DEFAULT 0,
    cutoff        INTEGER NOT NULL DEFAULT 0,
    applied_json  TEXT,
    PRIMARY KEY (actor_id, producer)
  );
CREATE TABLE queued_turns (
    seq           INTEGER PRIMARY KEY AUTOINCREMENT,
    actor_id      TEXT NOT NULL,
    id            TEXT NOT NULL,
    text          TEXT NOT NULL,
    metadata_json TEXT,
    yields        INTEGER NOT NULL DEFAULT 0,
    run_end_json  TEXT,
    run_end_path  TEXT,
    UNIQUE (actor_id, id),
    CHECK(run_end_json IS NULL OR run_end_path IS NULL)
  );
CREATE TABLE terminal_effects (
    actor_id        TEXT NOT NULL,
    sequence_id     TEXT NOT NULL,
    effect_key      TEXT NOT NULL,
    effect_name     TEXT NOT NULL,
    scope           TEXT NOT NULL,
    seq             INTEGER NOT NULL,
    input_json      TEXT NOT NULL,
    lane            TEXT NOT NULL DEFAULT 'inline',
    status          TEXT NOT NULL,
    attempts        INTEGER NOT NULL DEFAULT 0,
    next_attempt_at INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (actor_id, sequence_id, effect_key)
  );
CREATE TABLE kinu_workspace_generation (id INTEGER PRIMARY KEY, value INTEGER NOT NULL);
CREATE VIRTUAL TABLE conversation_fts USING fts5(
      content, actor_id UNINDEXED, msg_id UNINDEXED, session_id UNINDEXED, role UNINDEXED, created_at UNINDEXED
    );
CREATE TABLE conversation_fts_state (
      actor_id TEXT PRIMARY KEY NOT NULL,
      rev INTEGER NOT NULL DEFAULT 0,
      purges INTEGER NOT NULL DEFAULT 0,
      synced_rev INTEGER NOT NULL DEFAULT -1,
      synced_purges INTEGER NOT NULL DEFAULT -1,
      synced_rowid INTEGER NOT NULL DEFAULT 0
    );
CREATE UNIQUE INDEX idx_workspace_actors_main
    ON workspace_actors(origin) WHERE origin = 'system';
CREATE UNIQUE INDEX idx_workspace_actors_names
    ON workspace_actors(parent_actor_id, name) WHERE deleted_at IS NULL;
CREATE INDEX idx_workspace_actors_parent
    ON workspace_actors(parent_actor_id, created_at, name);
CREATE INDEX idx_actor_subordinates_order
    ON actor_subordinates(actor_id, created_at, name);
CREATE INDEX idx_evolution_helpers_request
    ON evolution_helpers(actor_id, lane_request_id, created_at);
CREATE INDEX idx_fibers_actor_name ON fibers(actor_id, name);
CREATE INDEX idx_evolution_events_actor
     ON evolution_events(actor_id, created_at DESC, id DESC);
CREATE INDEX idx_executor_output_actor
     ON executor_output(actor_id, created_at DESC, id DESC);
CREATE INDEX idx_activity_log_created
     ON activity_log(actor_id, created_at DESC, id DESC);
CREATE INDEX idx_sn_parent ON search_nodes(actor_id, parent_id);
CREATE INDEX idx_sn_status_value ON search_nodes(actor_id, status, value DESC);
CREATE INDEX idx_sn_root_status ON search_nodes(actor_id, root_id, status);
CREATE UNIQUE INDEX idx_alternate_takes_settlement
      ON alternate_takes(actor_id, settlement_key);
CREATE INDEX idx_alternate_takes_actor
      ON alternate_takes(actor_id, created_at DESC, id DESC);
CREATE INDEX idx_er_cell ON exploration_records(actor_id, objective_id, floor_digest, descriptor, value);
CREATE INDEX idx_swarm_node_records_root
    ON swarm_node_records(actor_id, root_id);
CREATE INDEX idx_lessons_actor
             ON lessons(actor_id, created_at DESC);
CREATE INDEX idx_turn_ratings_actor ON turn_ratings(actor_id, created_at DESC, id DESC);
CREATE INDEX idx_turn_ratings_actor_turn ON turn_ratings(actor_id, turn_id);
CREATE INDEX idx_completed_turns_review
             ON completed_turns(actor_id, review, created_at);
CREATE INDEX idx_completed_turns_window
             ON completed_turns(actor_id, in_window, created_at);
CREATE INDEX idx_turn_struggles_actor ON turn_struggles(actor_id, created_at);
CREATE INDEX idx_tool_lessons_actor ON tool_lessons(actor_id, status, updated_at DESC);
CREATE UNIQUE INDEX idx_refinement_debt_key
           ON refinement_requests(actor_id, debt_key) WHERE debt_key IS NOT NULL;
CREATE INDEX idx_refinement_stage
           ON refinement_requests(actor_id, stage, created_at);
CREATE INDEX idx_agent_log_events_pending
   ON agent_log (actor_id, priority, received_at)
   WHERE kind = 'event' AND turn_id IS NULL;
CREATE INDEX idx_agent_log_events_consumed
   ON agent_log (actor_id, consumed_at)
   WHERE kind = 'event' AND consumed_at IS NOT NULL;
CREATE UNIQUE INDEX idx_agent_log_dedupe
   ON agent_log (actor_id, dedupe_key)
   WHERE dedupe_key IS NOT NULL;
CREATE INDEX idx_agent_log_trace_events
   ON agent_log (actor_id, trace_id, received_at)
   WHERE kind = 'event';
CREATE INDEX idx_agent_log_reply_attempts
   ON agent_log (actor_id, parent_id)
   WHERE kind = 'reply_attempt';
CREATE INDEX idx_agent_log_by_trace
   ON agent_log (actor_id, trace_id, id);
CREATE INDEX idx_agent_log_received_at
   ON agent_log (actor_id, received_at DESC);
CREATE INDEX idx_reply_channels_open
   ON reply_channels (actor_id, state, ttl_expires_at);
CREATE INDEX idx_reply_channels_event
   ON reply_channels (actor_id, event_id);
CREATE INDEX idx_triggers_active_fire
   ON triggers (actor_id, next_fire_at)
   WHERE state = 'active' AND next_fire_at IS NOT NULL;
CREATE INDEX idx_triggers_by_kind
   ON triggers (actor_id, kind, state);
CREATE INDEX idx_head_journal_root ON head_journal(actor_id, root_id);
CREATE INDEX idx_head_journal_parent ON head_journal(actor_id, parent_id);
CREATE INDEX idx_head_journal_status ON head_journal(actor_id, status, root_id);
CREATE INDEX idx_run_events_run_ts ON run_events(actor_id, run_id, ts);
CREATE INDEX idx_run_events_type ON run_events(actor_id, type, ts DESC);
CREATE INDEX idx_run_events_actor ON run_events(actor_id);
CREATE INDEX idx_open_turns_opened ON open_turns(actor_id, opened_at DESC);
CREATE INDEX idx_run_events_operator ON run_events(actor_id)
    WHERE type = 'run_start' AND json_valid(payload) AND json_extract(payload, '$.turn.metadata.kinuAuthor') = 'operator';
CREATE INDEX idx_actor_claims_outcome ON actor_turn_claims(actor_id,outcome,claimed_at DESC);
CREATE UNIQUE INDEX session_message_ingress ON session_messages(actor_id,ingress_id) WHERE ingress_id IS NOT NULL;
CREATE INDEX session_open_messages ON session_messages(actor_id) WHERE sealed_at IS NULL;
CREATE UNIQUE INDEX context_live_entry ON context_memberships(actor_id,context_id,entry_id) WHERE to_revision IS NULL;
CREATE UNIQUE INDEX context_live_position ON context_memberships(actor_id,context_id,position) WHERE to_revision IS NULL;
CREATE INDEX context_history_members ON context_memberships(actor_id,context_id,from_revision,to_revision,position);
CREATE INDEX context_message_members ON context_memberships(actor_id,message_id);
CREATE UNIQUE INDEX context_pending_proposal ON context_proposals(actor_id,context_id) WHERE status='pending';
CREATE INDEX actor_step_requests ON actor_requests(actor_id,recorded_at) WHERE step_index IS NOT NULL;
CREATE INDEX idx_agent_facts_observed
             ON agent_facts(actor_id, last_observed_at DESC);
CREATE INDEX idx_proposed_tasks_status_proposed
             ON proposed_tasks(actor_id, status, proposed_at DESC);
CREATE INDEX idx_background_jobs_status ON background_jobs(status);
CREATE INDEX idx_background_jobs_actor_status ON background_jobs(actor_id, status, created_at DESC);
CREATE UNIQUE INDEX idx_background_jobs_retry_of
    ON background_jobs(actor_id, retry_of) WHERE retry_of IS NOT NULL;
CREATE INDEX tool_effect_claims_pending
    ON tool_effect_claims (actor_id, turn_id, normalized_call_id) WHERE result_json IS NULL;
CREATE INDEX idx_deferred_approvals_status
    ON deferred_approvals(actor_id, status, requested_at);
CREATE INDEX idx_deferred_approvals_command
    ON deferred_approvals(actor_id, command, executor, context, requested_at DESC);
CREATE INDEX idx_plan_reviews_session_current
    ON plan_reviews(actor_id, session_id, created_at DESC);
CREATE INDEX idx_owner_questions_call ON owner_questions(actor_id, call_id, digest);
CREATE INDEX idx_owner_questions_turn ON owner_questions(actor_id, turn_id);
CREATE INDEX idx_owner_questions_open ON owner_questions(actor_id, status, asked_at);
CREATE UNIQUE INDEX idx_agent_tasks_id ON agent_tasks(actor_id, id);
CREATE INDEX idx_agent_tasks_status ON agent_tasks(actor_id, status);
CREATE INDEX idx_agent_tasks_parent ON agent_tasks(actor_id, parent_id);
CREATE INDEX idx_agent_tasks_plan ON agent_tasks(actor_id, session_id, plan_id, revision);
CREATE INDEX idx_mcts_search_status_task ON mcts_search_runs(actor_id, status, task, updated_at);
CREATE UNIQUE INDEX idx_imported_experience_library
    ON imported_experience(actor_id, library_id);
CREATE INDEX idx_imported_experience_recent
    ON imported_experience(actor_id, imported_at DESC);
CREATE INDEX idx_artifact_versions_status ON artifact_versions(actor_id, status, artifact_id);
CREATE INDEX idx_mc_path ON memory_note_chunks(path);
CREATE INDEX idx_terminal_effects_owed
    ON terminal_effects (actor_id, sequence_id, status, seq, next_attempt_at);
CREATE VIEW search_node_scores AS
    SELECT n.actor_id, n.id, n.parent_id, n.root_id, t.task, n.action, n.observation, n.visits, n.value, n.depth,
      n.status, n.created_at, CASE
      WHEN n.parent_id IS NULL THEN n.value
      WHEN r.record_json IS NOT NULL THEN json_extract(r.record_json, '$.outcome.score')
      ELSE 0 END AS own_score
    FROM search_nodes n
    LEFT JOIN search_nodes t ON t.actor_id = n.actor_id AND t.id = n.root_id
    LEFT JOIN swarm_node_records r ON r.actor_id = n.actor_id AND r.node_id = n.id;
CREATE TRIGGER crafted_tools_ai AFTER INSERT ON crafted_tools BEGIN
			INSERT INTO crafted_tools_fts(rowid, name, description) VALUES (new.rowid, new.name, new.description);
		END;
CREATE TRIGGER crafted_tools_ad AFTER DELETE ON crafted_tools BEGIN
			INSERT INTO crafted_tools_fts(crafted_tools_fts, rowid, name, description) VALUES ('delete', old.rowid, old.name, old.description);
		END;
CREATE TRIGGER crafted_tools_au AFTER UPDATE ON crafted_tools BEGIN
			INSERT INTO crafted_tools_fts(crafted_tools_fts, rowid, name, description) VALUES ('delete', old.rowid, old.name, old.description);
			INSERT INTO crafted_tools_fts(rowid, name, description) VALUES (new.rowid, new.name, new.description);
		END;
CREATE TRIGGER run_events_open_turn AFTER INSERT ON run_events
    WHEN NEW.type = 'run_start' AND json_valid(NEW.payload) AND json_extract(NEW.payload, '$.turn') IS NOT NULL
    BEGIN INSERT INTO open_turns (actor_id, run_id, opened_at) VALUES (NEW.actor_id, NEW.run_id, NEW.ts); END;
CREATE TRIGGER run_events_close_turn AFTER INSERT ON run_events WHEN NEW.type = 'run_end'
    BEGIN DELETE FROM open_turns WHERE actor_id = NEW.actor_id AND run_id = NEW.run_id; END;
CREATE TRIGGER conversation_rev_entries_ai AFTER INSERT ON conversation_entries BEGIN
          INSERT INTO conversation_fts_state (actor_id, rev) VALUES (NEW.actor_id, 1)
          ON CONFLICT(actor_id) DO UPDATE SET rev = rev + 1; END;
CREATE TRIGGER conversation_rev_entries_ad AFTER DELETE ON conversation_entries BEGIN
          INSERT INTO conversation_fts_state (actor_id, rev, purges) VALUES (OLD.actor_id, 1, 1)
          ON CONFLICT(actor_id) DO UPDATE SET rev = rev + 1, purges = purges + 1;
          DELETE FROM conversation_fts WHERE actor_id = OLD.actor_id AND rowid = OLD.rowid; END;
INSERT INTO "workspace_identity" ("rowid", "singleton", "id", "name", "owner_user_id", "created_at") VALUES (1, 1, 'beb387e8-066f-47f8-a212-1c471b0cfa82', 'rc29-agent', '', 1792565375951);
INSERT INTO "workspace_actors" ("rowid", "actor_id", "parent_actor_id", "name", "storage_key", "origin", "lifetime", "created_at", "creation_id", "retiring_at", "deleted_at") VALUES (1, '20d77b7b-27a2-4784-ac81-caa6b492310e', NULL, 'rc29-agent', 'rc29-agent', 'system', 'durable', 1792565375951, 'beb387e8-066f-47f8-a212-1c471b0cfa82', NULL, NULL);
INSERT INTO "head_runs" ("rowid", "actor_id", "root_id", "rationale", "spawned_at") VALUES (1, '20d77b7b-27a2-4784-ac81-caa6b492310e', 'root-1', 'split the survey', 1760000000000);
INSERT INTO "head_journal" ("rowid", "actor_id", "id", "parent_id", "root_id", "depth", "task", "rationale", "status", "spawned_at", "completed_at", "token_input", "token_output", "token_cache_read", "token_cache_write", "token_cache_write_1h", "token_reasoning", "neurons", "wall_clock_ms", "summary", "error_message", "decisions_json", "file_changes_json", "merge_strategy") VALUES (1, '20d77b7b-27a2-4784-ac81-caa6b492310e', 'head-1', NULL, 'root-1', 0, 'survey the notes', NULL, 'done', 1760000000000, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, 0, NULL, NULL, NULL, NULL, 'synthesize');
INSERT INTO "head_steps" ("rowid", "actor_id", "head_id", "seq", "parts_json", "created_at") VALUES (1, '20d77b7b-27a2-4784-ac81-caa6b492310e', 'head-1', 0, '[]', 1760000000001);
INSERT INTO "session_messages" ("rowid", "actor_id", "message_id", "role", "native_content_kind", "origin", "request_id", "output_slot", "ingress_id", "envelope_json", "sealed_at", "content_json", "content_path") VALUES (1, '20d77b7b-27a2-4784-ac81-caa6b492310e', 'u-msg-1', 'user', 'string', 'input', NULL, NULL, NULL, '{}', 1792565375952, '[{"partNo":0,"streamOrder":0,"replyTo":null,"value":{"type":"text","text":"Hello Kinu, find oldsecretword"}}]', NULL);
INSERT INTO "session_messages" ("rowid", "actor_id", "message_id", "role", "native_content_kind", "origin", "request_id", "output_slot", "ingress_id", "envelope_json", "sealed_at", "content_json", "content_path") VALUES (2, '20d77b7b-27a2-4784-ac81-caa6b492310e', 'a-msg-1', 'assistant', 'string', 'output', NULL, NULL, NULL, '{}', 1792565375953, '[{"partNo":0,"streamOrder":0,"replyTo":null,"value":{"type":"text","text":"Found oldsecretword in the notes."}}]', NULL);
INSERT INTO "conversation_entries" ("rowid", "actor_id", "session_id", "id", "position", "role", "turn_id", "run_id", "metadata_json", "metadata_path", "recorded_at", "context_id", "context_revision") VALUES (1, '20d77b7b-27a2-4784-ac81-caa6b492310e', 'chat', 'u-msg-1', 0, 'user', NULL, NULL, NULL, NULL, 1792565375953, NULL, NULL);
INSERT INTO "conversation_entries" ("rowid", "actor_id", "session_id", "id", "position", "role", "turn_id", "run_id", "metadata_json", "metadata_path", "recorded_at", "context_id", "context_revision") VALUES (2, '20d77b7b-27a2-4784-ac81-caa6b492310e', 'chat', 'a-msg-1', 1, 'assistant', NULL, NULL, NULL, NULL, 1792565375953, NULL, NULL);
INSERT INTO "conversation_entry_parts" ("rowid", "actor_id", "session_id", "entry_id", "position", "message_id", "part_no", "text_start", "text_length") VALUES (1, '20d77b7b-27a2-4784-ac81-caa6b492310e', 'chat', 'u-msg-1', 0, 'u-msg-1', 0, NULL, NULL);
INSERT INTO "conversation_entry_parts" ("rowid", "actor_id", "session_id", "entry_id", "position", "message_id", "part_no", "text_start", "text_length") VALUES (2, '20d77b7b-27a2-4784-ac81-caa6b492310e', 'chat', 'a-msg-1', 0, 'a-msg-1', 0, NULL, NULL);
INSERT INTO "conversation_fts" ("rowid", "content", "actor_id", "msg_id", "session_id", "role", "created_at") VALUES (1, 'Hello Kinu, find oldsecretword', '20d77b7b-27a2-4784-ac81-caa6b492310e', 'u-msg-1', 'chat', 'user', 1792565375953);
INSERT INTO "conversation_fts" ("rowid", "content", "actor_id", "msg_id", "session_id", "role", "created_at") VALUES (2, 'Found oldsecretword in the notes.', '20d77b7b-27a2-4784-ac81-caa6b492310e', 'a-msg-1', 'chat', 'assistant', 1792565375953);
INSERT INTO "conversation_fts_state" ("rowid", "actor_id", "rev", "purges", "synced_rev", "synced_purges", "synced_rowid") VALUES (1, '20d77b7b-27a2-4784-ac81-caa6b492310e', 0, 0, 0, 0, 2);

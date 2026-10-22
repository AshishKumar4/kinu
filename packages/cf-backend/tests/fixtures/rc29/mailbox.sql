-- A mailbox database as rc29 (62b6c90c6) made it: its own init (initMailboxTables) and MailStore, one message delivered and indexed. Stamp 200639136.
CREATE TABLE mail_box (
      id          INTEGER PRIMARY KEY CHECK (id = 1),
      user_id     TEXT    NOT NULL,
      email       TEXT    NOT NULL,
      username    TEXT    NOT NULL,
      created_at  INTEGER NOT NULL
    );
CREATE TABLE mail_addresses (
      path        TEXT    PRIMARY KEY CHECK (length(path) <= 41),
      kind        TEXT    NOT NULL CHECK (kind IN ('person', 'workspace', 'agent')),
      workspace   TEXT,
      actor_id    TEXT,
      wake        TEXT    NOT NULL DEFAULT 'owner' CHECK (wake IN ('owner', 'allowlist', 'verified', 'never')),
      state       TEXT    NOT NULL DEFAULT 'active' CHECK (state IN ('active', 'retired')),
      created_at  INTEGER NOT NULL,
      retired_at  INTEGER,
      CHECK ((kind = 'person') = (path = '')),
      CHECK ((workspace IS NULL) = (actor_id IS NULL)),
      CHECK (kind = 'person' OR workspace IS NOT NULL),
      CHECK ((state = 'retired') = (retired_at IS NOT NULL))
    );
CREATE TABLE mail_allow (
      path        TEXT    NOT NULL REFERENCES mail_addresses (path),
      sender      TEXT    NOT NULL,
      added_at    INTEGER NOT NULL,
      PRIMARY KEY (path, sender)
    );
CREATE TABLE mail_threads (
      id          TEXT    PRIMARY KEY,
      path        TEXT    NOT NULL REFERENCES mail_addresses (path),
      subject     TEXT    NOT NULL,
      important   TEXT    CHECK (important IS NULL OR length(important) BETWEEN 1 AND 280),
      trashed_at  INTEGER,
      created_at  INTEGER NOT NULL,
      CHECK (important IS NULL OR path = '')
    );
CREATE TABLE mail_untriaged (
      thread_id   TEXT    PRIMARY KEY REFERENCES mail_threads (id),
      since       INTEGER NOT NULL
    );
CREATE TABLE mail_messages (
      id           TEXT    PRIMARY KEY,
      thread_id    TEXT    NOT NULL REFERENCES mail_threads (id),
      direction    TEXT    NOT NULL CHECK (direction IN ('in', 'out')),
      header_id    TEXT,
      in_reply_to  TEXT,
      refs         TEXT    NOT NULL DEFAULT '[]',
      from_addr    TEXT    NOT NULL,
      from_name    TEXT,
      to_json      TEXT    NOT NULL DEFAULT '[]',
      cc_json      TEXT    NOT NULL DEFAULT '[]',
      delivered_to TEXT,
      subject      TEXT    NOT NULL,
      at           INTEGER NOT NULL,
      verdict      TEXT    NOT NULL CHECK (verdict IN ('verified', 'unverified', 'ours')),
      auth         TEXT,
      woke         TEXT    CHECK (woke IS NULL OR woke IN ('owner', 'input')),
      snippet      TEXT    NOT NULL DEFAULT '',
      text_body    TEXT,
      text_key     TEXT,
      html_key     TEXT,
      raw_key      TEXT,
      size         INTEGER NOT NULL,
      read         INTEGER NOT NULL DEFAULT 0 CHECK (read IN (0, 1)),
      written_by   TEXT,
      send_state   TEXT    CHECK (send_state IS NULL OR send_state IN ('draft', 'queued', 'sent', 'delivered', 'bounced', 'failed', 'complained')),
      CHECK ((direction = 'in') = (send_state IS NULL)),
      CHECK (direction = 'out' OR (raw_key IS NOT NULL AND written_by IS NULL)),
      CHECK (text_body IS NULL OR text_key IS NULL),
      CHECK (woke IS NULL OR (direction = 'in' AND verdict = 'verified')),
      UNIQUE (thread_id, header_id)
    );
CREATE TABLE mail_attachments (
      id           TEXT    PRIMARY KEY,
      message_id   TEXT    NOT NULL REFERENCES mail_messages (id),
      filename     TEXT    NOT NULL,
      content_type TEXT    NOT NULL,
      size         INTEGER NOT NULL,
      digest       TEXT    NOT NULL,
      inline_cid   TEXT
    );
CREATE VIRTUAL TABLE mail_fts USING fts5 (
      subject, sender, body, content = '', contentless_delete = 1, tokenize = 'unicode61 remove_diacritics 2'
    );
CREATE UNIQUE INDEX mail_addresses_actor ON mail_addresses (workspace, actor_id, kind) WHERE actor_id IS NOT NULL;
CREATE INDEX mail_threads_box ON mail_threads (path, created_at);
CREATE INDEX mail_threads_important ON mail_threads (created_at) WHERE important IS NOT NULL AND trashed_at IS NULL;
CREATE INDEX mail_threads_trashed ON mail_threads (trashed_at) WHERE trashed_at IS NOT NULL;
CREATE INDEX mail_messages_thread ON mail_messages (thread_id, at);
CREATE INDEX mail_messages_header ON mail_messages (header_id) WHERE header_id IS NOT NULL;
CREATE INDEX mail_messages_sent ON mail_messages (direction, at);
CREATE INDEX mail_messages_drafts ON mail_messages (send_state) WHERE send_state = 'draft';
CREATE INDEX mail_attachments_message ON mail_attachments (message_id);
CREATE INDEX mail_attachments_digest ON mail_attachments (digest);
INSERT INTO "mail_box" ("id", "user_id", "email", "username", "created_at") VALUES (1, 'u-1', 'me@example.com', 'ashish', 1760000000000);
INSERT INTO "mail_addresses" ("rowid", "path", "kind", "workspace", "actor_id", "wake", "state", "created_at", "retired_at") VALUES (1, '', 'person', NULL, NULL, 'owner', 'active', 1760000000000, NULL);
INSERT INTO "mail_threads" ("rowid", "id", "path", "subject", "important", "trashed_at", "created_at") VALUES (1, '6db97d67-b3ae-4655-a8d5-43b11587d3dd', '', 'The oldsecretword report', NULL, NULL, 1760000000000);
INSERT INTO "mail_untriaged" ("rowid", "thread_id", "since") VALUES (1, '6db97d67-b3ae-4655-a8d5-43b11587d3dd', 1760000000000);
INSERT INTO "mail_messages" ("rowid", "id", "thread_id", "direction", "header_id", "in_reply_to", "refs", "from_addr", "from_name", "to_json", "cc_json", "delivered_to", "subject", "at", "verdict", "auth", "woke", "snippet", "text_body", "text_key", "html_key", "raw_key", "size", "read", "written_by", "send_state") VALUES (1, '3876f624-5c66-4e94-8c04-30d7941a0a04', '6db97d67-b3ae-4655-a8d5-43b11587d3dd', 'in', 'm1@northwind.io', NULL, '[]', 'dana@northwind.io', 'Dana', '[{"address":"ashish@kinu.run","name":null}]', '[]', 'ashish@kinu.run', 'The oldsecretword report', 1760000000000, 'unverified', NULL, NULL, 'oldsecretword is in the attached report.', 'oldsecretword is in the attached report.', NULL, NULL, 'raw/c67a886085a8136bd29d52071e26d1534b93cb0a4ccb45afa435267d65a1a6bd.eml', 40, 0, NULL, NULL);
INSERT INTO mail_fts (rowid, subject, sender, body) VALUES (1, 'The oldsecretword report', 'Dana dana@northwind.io', 'oldsecretword is in the attached report.');

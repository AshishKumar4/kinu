// Mail's two Durable Object schemas, as approved in docs/MAIL.md §11 (2026-10-19). Idempotent; each runs on every
// boot of its object. `MailName` is one per root label: its one row is the claim, and naming the object is the lock.
// `Mailbox` is one per account: every box the account has (person, workspaces, agents), their threads, messages,
// attachments' index and search. Raw messages, large parts and attachment bytes live in R2 under `mail/<user_id>/`.

import type { SqlExec } from '../types/primitives';

export function initMailNameTables(sql: SqlExec): void {
  sql.exec(`
    CREATE TABLE IF NOT EXISTS mail_name (
      label        TEXT    PRIMARY KEY CHECK (length(label) BETWEEN 1 AND 20),
      user_id      TEXT    NOT NULL,
      kind         TEXT    NOT NULL CHECK (kind IN ('username', 'alias')),
      target_path  TEXT,
      CHECK ((kind = 'alias') = (target_path IS NOT NULL))
    )
  `);
}

export function initMailboxTables(sql: SqlExec): void {
  // The account's mail identity: its sign-in email (a verified message From it is the owner's) and its username.
  sql.exec(`
    CREATE TABLE IF NOT EXISTS mail_box (
      id          INTEGER PRIMARY KEY CHECK (id = 1),
      user_id     TEXT    NOT NULL,
      email       TEXT    NOT NULL,
      username    TEXT    NOT NULL
    )
  `);
  // A path is relative to the username: '' the person, 'api-worker' a workspace, 'scout.api-worker' an agent.
  sql.exec(`
    CREATE TABLE IF NOT EXISTS mail_addresses (
      path        TEXT    PRIMARY KEY CHECK (length(path) <= 41),
      kind        TEXT    NOT NULL CHECK (kind IN ('person', 'workspace', 'agent')),
      workspace   TEXT,
      actor_id    TEXT,
      wake        TEXT    NOT NULL DEFAULT 'owner' CHECK (wake IN ('owner', 'allowlist', 'verified', 'never')),
      CHECK ((kind = 'person') = (path = '')),
      CHECK ((workspace IS NULL) = (actor_id IS NULL)),
      CHECK (kind = 'person' OR workspace IS NOT NULL)
    )
  `);
  sql.exec('CREATE UNIQUE INDEX IF NOT EXISTS mail_addresses_actor ON mail_addresses (workspace, actor_id, kind) WHERE actor_id IS NOT NULL');
  sql.exec(`
    CREATE TABLE IF NOT EXISTS mail_allow (
      path        TEXT    NOT NULL REFERENCES mail_addresses (path),
      sender      TEXT    NOT NULL,
      PRIMARY KEY (path, sender)
    )
  `);
  // All, Sent and Drafts are queries over messages; unverified is a message's verdict, not a folder. `untriaged_since`: the
  // person's thread has mail the assistant has not yet picked Important or not on (docs/MAIL.md §8), and is the thread's
  // version, moved forward at every arrival; null when nothing is owed.
  sql.exec(`
    CREATE TABLE IF NOT EXISTS mail_threads (
      id              TEXT    PRIMARY KEY,
      path            TEXT    NOT NULL REFERENCES mail_addresses (path),
      subject         TEXT    NOT NULL,
      important       TEXT    CHECK (important IS NULL OR length(important) BETWEEN 1 AND 280),
      trashed_at      INTEGER,
      untriaged_since INTEGER,
      CHECK (important IS NULL OR path = ''),
      CHECK (untriaged_since IS NULL OR path = '')
    )
  `);
  sql.exec('CREATE INDEX IF NOT EXISTS mail_threads_box ON mail_threads (path)');
  sql.exec('CREATE INDEX IF NOT EXISTS mail_threads_important ON mail_threads (id) WHERE important IS NOT NULL AND trashed_at IS NULL');
  sql.exec('CREATE INDEX IF NOT EXISTS mail_threads_trashed ON mail_threads (trashed_at) WHERE trashed_at IS NOT NULL');
  sql.exec('CREATE INDEX IF NOT EXISTS mail_threads_untriaged ON mail_threads (untriaged_since DESC, id) WHERE untriaged_since IS NOT NULL AND trashed_at IS NULL');
  sql.exec(`
    CREATE TABLE IF NOT EXISTS mail_messages (
      id           TEXT    PRIMARY KEY,
      thread_id    TEXT    NOT NULL REFERENCES mail_threads (id),
      header_id    TEXT,
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
      read         INTEGER NOT NULL DEFAULT 0 CHECK (read IN (0, 1)),
      written_by   TEXT,
      -- Null on a message received; an outgoing one is a draft, or queued from the moment it is sent.
      send_state   TEXT    CHECK (send_state IS NULL OR send_state IN ('draft', 'queued')),
      CHECK (send_state IS NOT NULL OR (raw_key IS NOT NULL AND written_by IS NULL)),
      CHECK (text_body IS NULL OR text_key IS NULL),
      CHECK (woke IS NULL OR (send_state IS NULL AND verdict = 'verified')),
      UNIQUE (thread_id, header_id)
    )
  `);
  sql.exec('CREATE INDEX IF NOT EXISTS mail_messages_thread ON mail_messages (thread_id, at)');
  sql.exec('CREATE INDEX IF NOT EXISTS mail_messages_header ON mail_messages (header_id) WHERE header_id IS NOT NULL');
  sql.exec("CREATE INDEX IF NOT EXISTS mail_messages_sent ON mail_messages (at) WHERE send_state = 'queued'");
  sql.exec("CREATE INDEX IF NOT EXISTS mail_messages_drafts ON mail_messages (thread_id) WHERE send_state = 'draft'");
  // Its bytes are content-addressed under the account in R2: mail/<user_id>/att/<digest>.
  sql.exec(`
    CREATE TABLE IF NOT EXISTS mail_attachments (
      id           TEXT    PRIMARY KEY,
      message_id   TEXT    NOT NULL REFERENCES mail_messages (id),
      filename     TEXT    NOT NULL,
      content_type TEXT    NOT NULL,
      size         INTEGER NOT NULL,
      digest       TEXT    NOT NULL
    )
  `);
  sql.exec('CREATE INDEX IF NOT EXISTS mail_attachments_message ON mail_attachments (message_id)');
  sql.exec('CREATE INDEX IF NOT EXISTS mail_attachments_digest ON mail_attachments (digest)');
  // Search: regenerable from the messages and their R2 parts; rowid is mail_messages' rowid. contentless_delete and
  // long MATCH queries were measured in workerd and on a deployed object (tests/workerd/mail-search.test.ts).
  sql.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS mail_fts USING fts5 ( /* derived from mail_messages: its rowids are theirs */
      subject, sender, body, content = '', contentless_delete = 1, tokenize = 'unicode61 remove_diacritics 2'
    )
  `);
}

CREATE TABLE IF NOT EXISTS auth_users (
  id             TEXT PRIMARY KEY,
  email          TEXT NOT NULL,
  email_verified INTEGER NOT NULL DEFAULT 0,
  display_name   TEXT,
  avatar_url     TEXT,
  created_at     INTEGER NOT NULL,
  updated_at     INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_auth_users_email ON auth_users(email);

CREATE TABLE IF NOT EXISTS auth_accounts (
  provider            TEXT NOT NULL,
  provider_account_id TEXT NOT NULL,
  user_id             TEXT NOT NULL,
  email               TEXT NOT NULL,
  email_verified      INTEGER NOT NULL DEFAULT 0,
  display_name        TEXT,
  avatar_url          TEXT,
  created_at          INTEGER NOT NULL,
  updated_at          INTEGER NOT NULL,
  PRIMARY KEY(provider, provider_account_id),
  FOREIGN KEY(user_id) REFERENCES auth_users(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_auth_accounts_user ON auth_accounts(user_id);

CREATE TABLE IF NOT EXISTS auth_email_links (
  email      TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  FOREIGN KEY(user_id) REFERENCES auth_users(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_auth_email_links_user ON auth_email_links(user_id);

CREATE TABLE IF NOT EXISTS auth_sessions (
  session_hash        TEXT PRIMARY KEY,
  user_id             TEXT NOT NULL,
  provider            TEXT NOT NULL,
  provider_account_id TEXT NOT NULL,
  auth_time           INTEGER NOT NULL,
  created_at          INTEGER NOT NULL,
  updated_at          INTEGER NOT NULL DEFAULT 0,
  expires_at          INTEGER NOT NULL,
  revoked_at          INTEGER,
  FOREIGN KEY(user_id) REFERENCES auth_users(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_auth_sessions_user ON auth_sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_auth_sessions_expires ON auth_sessions(expires_at);
CREATE INDEX IF NOT EXISTS idx_auth_sessions_revoked_expires ON auth_sessions(revoked_at, expires_at);

CREATE TABLE IF NOT EXISTS auth_oauth_states (
  state_hash    TEXT PRIMARY KEY,
  provider      TEXT NOT NULL,
  code_verifier TEXT NOT NULL,
  nonce         TEXT,
  return_to     TEXT NOT NULL,
  redirect_uri  TEXT NOT NULL,
  created_at    INTEGER NOT NULL,
  expires_at    INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_auth_oauth_states_expires ON auth_oauth_states(expires_at);

CREATE TABLE IF NOT EXISTS cli_auth_requests (
  device_hash TEXT PRIMARY KEY,
  user_code   TEXT NOT NULL UNIQUE,
  device_name TEXT NOT NULL,
  status      TEXT NOT NULL CHECK (status IN ('pending', 'approved', 'expired', 'consumed')),
  origin      TEXT NOT NULL,
  user_id     TEXT,
  user_email  TEXT,
  token_exp   TEXT,
  created_at  INTEGER NOT NULL,
  expires_at  INTEGER NOT NULL,
  approved_at INTEGER
);

CREATE INDEX IF NOT EXISTS idx_cli_auth_code ON cli_auth_requests(user_code);
CREATE INDEX IF NOT EXISTS idx_cli_auth_expires ON cli_auth_requests(expires_at);
CREATE INDEX IF NOT EXISTS idx_cli_auth_status_expires ON cli_auth_requests(status, expires_at);

CREATE TABLE IF NOT EXISTS cli_auth_rate (
  key      TEXT PRIMARY KEY,
  count    INTEGER NOT NULL,
  reset_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_cli_auth_rate_reset ON cli_auth_rate(reset_at);

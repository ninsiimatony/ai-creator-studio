-- Phases 2-7: AI usage metering, YouTube connection, publishing metadata, automation log.

-- Per-call AI metering. cost_usd is computed from the API's reported token usage.
CREATE TABLE ai_usage (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id       TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind          TEXT NOT NULL,
  model         TEXT NOT NULL,
  input_tokens  INTEGER NOT NULL DEFAULT 0, -- characters for non-LLM providers (e.g. voiceover)
  output_tokens INTEGER NOT NULL DEFAULT 0,
  cost_usd      REAL NOT NULL DEFAULT 0,
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_ai_usage_user_day ON ai_usage(user_id, created_at);

-- One connected YouTube channel per user. Only the refresh token is stored, encrypted (AES-GCM).
CREATE TABLE youtube_accounts (
  user_id           TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  channel_id        TEXT NOT NULL,
  channel_title     TEXT NOT NULL,
  refresh_token_enc TEXT NOT NULL,
  scopes            TEXT NOT NULL,
  connected_at      TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Short-lived OAuth state + PKCE verifier (deleted on use or expiry).
CREATE TABLE oauth_states (
  state_hash    TEXT PRIMARY KEY,
  user_id       TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  code_verifier TEXT NOT NULL,
  expires_at    INTEGER NOT NULL
);

-- Publishing metadata and YouTube state. Publishing still requires approval = 'approved'.
ALTER TABLE videos ADD COLUMN description TEXT NOT NULL DEFAULT '';
ALTER TABLE videos ADD COLUMN tags TEXT NOT NULL DEFAULT '[]';           -- JSON array of strings
ALTER TABLE videos ADD COLUMN thumbnail_concept TEXT NOT NULL DEFAULT '';
ALTER TABLE videos ADD COLUMN youtube_video_id TEXT;
ALTER TABLE videos ADD COLUMN youtube_status TEXT NOT NULL DEFAULT 'none'; -- none|uploading|private|unlisted|scheduled|public
ALTER TABLE videos ADD COLUMN publish_at TEXT;

ALTER TABLE scripts ADD COLUMN storyboard TEXT NOT NULL DEFAULT '[]';    -- JSON array of scenes

ALTER TABLE settings ADD COLUMN ai_daily_cap_usd REAL NOT NULL DEFAULT 0; -- 0 = AI disabled

-- Log of automation runs (manual "Run now"; no unattended scheduling is enabled).
CREATE TABLE automation_runs (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind       TEXT NOT NULL,
  status     TEXT NOT NULL CHECK (status IN ('ok', 'error')),
  summary    TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_automation_runs_user ON automation_runs(user_id, id);

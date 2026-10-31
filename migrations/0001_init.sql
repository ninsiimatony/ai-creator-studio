-- Tony AI YouTube Studio — initial schema (Cloudflare D1 / SQLite)
-- All user data is scoped by user_id. Foreign keys are enforced by D1.

CREATE TABLE users (
  id            TEXT PRIMARY KEY,
  email         TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Only a SHA-256 hash of the session token is stored, never the token itself.
CREATE TABLE sessions (
  token_hash TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at INTEGER NOT NULL, -- unix seconds
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_sessions_user ON sessions(user_id);
CREATE INDEX idx_sessions_expires ON sessions(expires_at);

-- Failed-login log used for rate limiting.
CREATE TABLE login_attempts (
  id  INTEGER PRIMARY KEY AUTOINCREMENT,
  key TEXT NOT NULL,     -- hash of email + client IP
  at  INTEGER NOT NULL   -- unix seconds
);
CREATE INDEX idx_login_attempts_key ON login_attempts(key, at);

CREATE TABLE ideas (
  id         TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title      TEXT NOT NULL,
  topic      TEXT NOT NULL,
  angle      TEXT NOT NULL DEFAULT '',
  score      INTEGER NOT NULL DEFAULT 0,
  status     TEXT NOT NULL DEFAULT 'new' CHECK (status IN ('new', 'shortlisted', 'rejected')),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_ideas_user ON ideas(user_id, created_at);

CREATE TABLE scripts (
  id         TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  idea_id    TEXT REFERENCES ideas(id) ON DELETE SET NULL,
  title      TEXT NOT NULL,
  hook       TEXT NOT NULL DEFAULT '',
  outline    TEXT NOT NULL DEFAULT '',
  body       TEXT NOT NULL DEFAULT '',
  cta        TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_scripts_user ON scripts(user_id, created_at);

CREATE TABLE videos (
  id          TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  script_id   TEXT REFERENCES scripts(id) ON DELETE SET NULL,
  title       TEXT NOT NULL,
  stage       TEXT NOT NULL DEFAULT 'script'
              CHECK (stage IN ('script', 'voiceover', 'visuals', 'captions', 'thumbnail', 'quality')),
  done_stages TEXT NOT NULL DEFAULT '[]', -- JSON array of completed stage keys
  scheduled   TEXT NOT NULL DEFAULT '',   -- YYYY-MM-DD target date (plan only; nothing auto-publishes)
  approval    TEXT NOT NULL DEFAULT 'draft' CHECK (approval IN ('draft', 'pending', 'approved', 'changes')),
  note        TEXT,
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_videos_user ON videos(user_id, scheduled);

-- Append-only history of every approval-related action.
CREATE TABLE approvals (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  video_id   TEXT NOT NULL REFERENCES videos(id) ON DELETE CASCADE,
  action     TEXT NOT NULL CHECK (action IN ('submitted', 'approved', 'changes_requested', 'returned')),
  note       TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_approvals_video ON approvals(video_id, id);

CREATE TABLE settings (
  user_id           TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  audience          TEXT NOT NULL DEFAULT 'Worldwide (English)',
  format            TEXT NOT NULL DEFAULT 'Faceless documentary / explainer with AI narration',
  approval_required INTEGER NOT NULL DEFAULT 1,
  timezone          TEXT NOT NULL DEFAULT 'Asia/Muscat',
  budget_cap        REAL NOT NULL DEFAULT 0,
  currency          TEXT NOT NULL DEFAULT 'USD',
  updated_at        TEXT NOT NULL DEFAULT (datetime('now'))
);

PRAGMA foreign_keys = ON;

CREATE TABLE github_image_host_configs (
  id TEXT PRIMARY KEY,
  repository TEXT NOT NULL CHECK (length(trim(repository)) > 0),
  branch TEXT NOT NULL CHECK (length(trim(branch)) > 0),
  object_prefix TEXT NOT NULL DEFAULT '',
  token_encrypted TEXT NOT NULL CHECK (length(token_encrypted) > 0),
  is_enabled INTEGER NOT NULL DEFAULT 1 CHECK (is_enabled IN (0, 1)),
  is_current INTEGER NOT NULL DEFAULT 0 CHECK (is_current IN (0, 1)),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE UNIQUE INDEX idx_github_image_host_single_current
  ON github_image_host_configs(is_current)
  WHERE is_current = 1;

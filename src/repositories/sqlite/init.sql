CREATE TABLE IF NOT EXISTS users (
    id               TEXT PRIMARY KEY,
    email            TEXT NOT NULL,
    email_normalized TEXT NOT NULL UNIQUE,
    created_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
) STRICT;

CREATE TABLE IF NOT EXISTS password_credentials (
    user_id    TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    hash       TEXT NOT NULL,
    changed_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
) STRICT;

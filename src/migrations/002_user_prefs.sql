-- Per-person preferences (for example which columns they like to see on the Flagged Jobs grid).
CREATE TABLE user_prefs (
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  key     TEXT    NOT NULL,
  value   TEXT    NOT NULL,   -- JSON
  PRIMARY KEY (user_id, key)
);

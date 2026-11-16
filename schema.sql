CREATE TABLE IF NOT EXISTS revisions (
  user_email TEXT NOT NULL,
  item_key TEXT NOT NULL,
  dates_json TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1 CHECK(version > 0),
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (user_email, item_key)
);

CREATE TABLE memory_current (
  agent TEXT PRIMARY KEY,
  content TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE memory_archive (
  id INTEGER PRIMARY KEY,
  agent TEXT NOT NULL,
  content TEXT NOT NULL,
  archived_at TEXT NOT NULL
);

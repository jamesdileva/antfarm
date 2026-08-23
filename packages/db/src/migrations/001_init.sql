PRAGMA foreign_keys = ON;

CREATE TABLE messages (
  id INTEGER PRIMARY KEY,
  thread_id TEXT NOT NULL,
  from_agent TEXT NOT NULL,
  to_agent TEXT NOT NULL,
  type TEXT NOT NULL CHECK (type IN ('QUESTION','IDEA','TASK','REVIEW',
                                     'WARNING','DECISION','STATUS','HELP')),
  priority INTEGER NOT NULL DEFAULT 5,
  subject TEXT NOT NULL,
  body TEXT NOT NULL,
  refs TEXT,
  status TEXT NOT NULL DEFAULT 'queued'
    CHECK (status IN ('queued','delivered','read','answered')),
  created_at TEXT NOT NULL,
  delivered_at TEXT
);

CREATE INDEX idx_messages_to_status ON messages (to_agent, status);

CREATE TABLE tasks (
  id INTEGER PRIMARY KEY,
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  state TEXT NOT NULL DEFAULT 'proposed'
    CHECK (state IN ('proposed','active','blocked','done','dropped')),
  owner TEXT,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  artifact_refs TEXT
);

CREATE TABLE sessions (
  id INTEGER PRIMARY KEY,
  agent TEXT NOT NULL,
  opencode_session_id TEXT NOT NULL DEFAULT '',
  cycle INTEGER NOT NULL,
  goal TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'running'
    CHECK (status IN ('running','done','timed_out','failed')),
  tokens_in INTEGER NOT NULL DEFAULT 0,
  tokens_out INTEGER NOT NULL DEFAULT 0,
  cost REAL NOT NULL DEFAULT 0,
  started_at TEXT NOT NULL,
  ended_at TEXT,
  summary TEXT
);

CREATE TABLE events (
  id INTEGER PRIMARY KEY,
  ts TEXT NOT NULL,
  kind TEXT NOT NULL,
  actor TEXT NOT NULL,
  payload TEXT NOT NULL
);

CREATE INDEX idx_events_kind_ts ON events (kind, ts);

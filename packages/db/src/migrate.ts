import Database from 'better-sqlite3';

export type Db = Database.Database;

// Migrations are embedded as TS constants (not .sql files) so the bundled
// desktop build needs no filesystem lookup at runtime (S15 lesson: esbuild
// cjs output turns import.meta.url into undefined).

const M001 = `PRAGMA foreign_keys = ON;

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
`;

const M002 = `CREATE TABLE agent_state (
  agent TEXT PRIMARY KEY,
  last_decision_event INTEGER NOT NULL DEFAULT 0
);
`;

const M003 = `CREATE TABLE memory_current (
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
`;

const M004 = `CREATE TABLE nursery_agents (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  purpose TEXT NOT NULL,
  stage INTEGER NOT NULL DEFAULT 1,
  runtime TEXT NOT NULL DEFAULT 'rules-engine',
  created_by TEXT NOT NULL,
  proposal_thread TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'alive',
  created_at TEXT NOT NULL
);
`;

const M005 = `ALTER TABLE sessions ADD COLUMN model TEXT NOT NULL DEFAULT '';
`;

const MIGRATIONS: Array<{ version: number; file: string; sql: string }> = [
  { version: 1, file: '001_init.sql', sql: M001 },
  { version: 2, file: '002_agent_state.sql', sql: M002 },
  { version: 3, file: '003_memory.sql', sql: M003 },
  { version: 4, file: '004_nursery.sql', sql: M004 },
  { version: 5, file: '005_sessions_model.sql', sql: M005 },
];

export function openDb(path: string): Db {
  const db = new Database(path);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  migrate(db);
  return db;
}

function migrate(db: Db): void {
  const current = (db.pragma('user_version', { simple: true }) as number) ?? 0;
  for (const m of MIGRATIONS) {
    if (current >= m.version) continue;
    const apply = db.transaction(() => {
      db.exec(m.sql);
      db.pragma(`user_version = ${m.version}`);
    });
    apply();
  }
}

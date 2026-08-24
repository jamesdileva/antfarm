CREATE TABLE nursery_agents (
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

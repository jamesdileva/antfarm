CREATE TABLE agent_state (
  agent TEXT PRIMARY KEY,
  last_decision_event INTEGER NOT NULL DEFAULT 0
);

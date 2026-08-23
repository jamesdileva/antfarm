import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), 'migrations');

export type Db = Database.Database;

const MIGRATIONS: Array<{ version: number; file: string }> = [
  { version: 1, file: '001_init.sql' },
  { version: 2, file: '002_agent_state.sql' },
  { version: 3, file: '003_memory.sql' },
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
    const sql = readFileSync(join(MIGRATIONS_DIR, m.file), 'utf8');
    const apply = db.transaction(() => {
      db.exec(sql);
      db.pragma(`user_version = ${m.version}`);
    });
    apply();
  }
}

import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), 'migrations');

export type Db = Database.Database;

export function openDb(path: string): Db {
  const db = new Database(path);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  migrate(db);
  return db;
}

function migrate(db: Db): void {
  const version = (db.pragma('user_version', { simple: true }) as number) ?? 0;
  if (version < 1) {
    const sql = readFileSync(join(MIGRATIONS_DIR, '001_init.sql'), 'utf8');
    const apply = db.transaction(() => {
      db.exec(sql);
      db.pragma('user_version = 1');
    });
    apply();
  }
}

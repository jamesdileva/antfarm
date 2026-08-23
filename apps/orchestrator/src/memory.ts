import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Repos } from '@antfarm/db';

/**
 * MEMORY.md compaction protocol (architecture §2.4):
 * SQLite is the record (D4); project/<agent>/MEMORY.md is a derived mirror.
 */
export function applyMemoryUpdate(repos: Repos, projectRoot: string, agent: string, content?: string): void {
  const trimmed = (content ?? '').trim();
  if (!trimmed) return;
  repos.memory.save(agent, trimmed);
  const dir = join(projectRoot, agent);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'MEMORY.md'), `${trimmed}\n`, 'utf8');
}

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export const GOAL_FILE = 'PROJECT_GOAL.md';

/** Mode 1 seeding: the human authors the goal — verbatim, nothing added. */
export function seedGoal(projectRoot: string, goal: string): string {
  const sharedDir = join(projectRoot, 'shared');
  mkdirSync(sharedDir, { recursive: true });
  const path = join(sharedDir, GOAL_FILE);
  writeFileSync(path, `${goal.trim()}\n`, 'utf8');
  return path;
}

export function readGoal(projectRoot: string): string | null {
  const path = join(projectRoot, 'shared', GOAL_FILE);
  if (!existsSync(path)) return null;
  return readFileSync(path, 'utf8').trim();
}

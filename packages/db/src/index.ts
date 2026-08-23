import type { Db } from './migrate.js';
import { EventRepo, MailRepo, SessionRepo, TaskRepo } from './repositories.js';

export * from './migrate.js';
export * from './repositories.js';

export interface Repos {
  mail: MailRepo;
  tasks: TaskRepo;
  sessions: SessionRepo;
  events: EventRepo;
}

export function createRepos(db: Db): Repos {
  return {
    mail: new MailRepo(db),
    tasks: new TaskRepo(db),
    sessions: new SessionRepo(db),
    events: new EventRepo(db),
  };
}

export function withEvent<T>(repos: Repos, kind: string, actor: string,
                             payloadFn: (result: T) => unknown, fn: () => T): T {
  const result = fn();
  repos.events.append({ kind, actor, payload: payloadFn(result) });
  return result;
}

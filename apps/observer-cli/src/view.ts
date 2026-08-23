import { openDb, createRepos } from '@antfarm/db';

export interface AgentView {
  agent: string;
  lastSession: string;
  status: string;
  cycles: number;
}

export interface ObserverView {
  agents: AgentView[];
  board: Array<{ id: number; state: string; title: string; owner: string | null }>;
  taskCounts: Record<string, number>;
  latestMail: Array<{ id: number; from: string; to: string; type: string; subject: string }>;
  checks: { build: string; test: string };
  recentEvents: Array<{ id: number; kind: string; actor: string }>;
  decisions: number;
}

/** Pure view builder — SQLite in, renderable data out. */
export function buildView(dbPath: string): ObserverView {
  const db = openDb(dbPath);
  try {
    const repos = createRepos(db);

    const agents: AgentView[] = ['agent-a', 'agent-b'].map((agent) => {
      const sessions = repos.sessions.list().filter((s) => s.agent === agent);
      const last = sessions.at(-1);
      return {
        agent,
        status: last?.status ?? 'never run',
        lastSession: last?.summary ?? '',
        cycles: sessions.length,
      };
    });

    const tasks = repos.tasks.list();
    const taskCounts: Record<string, number> = {};
    for (const t of tasks) taskCounts[t.state] = (taskCounts[t.state] ?? 0) + 1;

    const latestMail = repos.events
      .byKind('mail_filed')
      .slice(-5)
      .reverse()
      .map((e) => {
        const p = JSON.parse(e.payload) as { messageId: number; to: string; type: string; subject: string };
        return { id: p.messageId, from: e.actor, to: p.to, type: p.type, subject: p.subject };
      });

    const lastResult = (kind: 'build_result' | 'test_result') => {
      const ev = repos.events.byKind(kind).at(-1);
      if (!ev) return 'not run yet';
      const p = JSON.parse(ev.payload) as { ok: boolean; durationMs: number };
      return `${p.ok ? 'PASS' : 'FAIL'} (${(p.durationMs / 1000).toFixed(1)}s)`;
    };

    return {
      agents,
      board: tasks.map((t) => ({ id: t.id, state: t.state, title: t.title, owner: t.owner })),
      taskCounts,
      latestMail,
      checks: { build: lastResult('build_result'), test: lastResult('test_result') },
      recentEvents: repos.events
        .all()
        .slice(-8)
        .reverse()
        .map((e) => ({ id: e.id, kind: e.kind, actor: e.actor })),
      decisions: repos.events.byKind('decision_logged').length,
    };
  } finally {
    db.close();
  }
}

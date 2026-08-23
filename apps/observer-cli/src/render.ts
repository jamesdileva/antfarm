import type { ObserverView } from './view.js';

const DIM = '\x1b[2m';
const BOLD = '\x1b[1m';
const GREEN = '\x1b[32m';
const RED = '\x1b[31m';
const CYAN = '\x1b[36m';
const RESET = '\x1b[0m';

export function render(view: ObserverView): string {
  const line = '─'.repeat(62);
  const out: string[] = [];

  out.push(`${BOLD}  ANTFARM${RESET} ${DIM}— live whiteboard (read-only)${RESET}`);
  out.push(`┌${line}┐`);

  for (const a of view.agents) {
    const statusColor = a.status === 'done' ? GREEN : a.status === 'never run' ? DIM : RED;
    out.push(
      `│ ${BOLD}${a.agent.padEnd(8)}${RESET} status: ${statusColor}${a.status.padEnd(10)}${RESET} ` +
        `cycles: ${String(a.cycles).padEnd(4)}`
    );
    if (a.lastSession) {
      const summary = a.lastSession.slice(0, 34);
      out.push(`│           "${summary}"`);
    }
  }

  out.push(`├${line}┤`);
  out.push(`│ ${CYAN}LIVE MAIL (latest)${RESET}`);
  for (const m of view.latestMail) {
    out.push(`│   [#${String(m.id).padEnd(3)}] ${m.type.padEnd(9)} ${m.from} → ${m.to}: ${m.subject.slice(0, 30)}`);
  }
  if (!view.latestMail.length) out.push(`│   ${DIM}(no mail yet)${RESET}`);

  out.push(`├${line}┤`);
  out.push(`│ ${CYAN}TASK BOARD${RESET}  ` +
    Object.entries(view.taskCounts).map(([k, v]) => `${k}:${v}`).join('  ').slice(0, 44));
  for (const t of view.board) {
    out.push(`│   #${String(t.id)} [${t.state}] ${t.title.slice(0, 40)} ${DIM}(${t.owner ?? 'unowned'})${RESET}`);
  }

  out.push(`├${line}┤`);
  out.push(`│ ${CYAN}CHECKS${RESET}     build: ${view.checks.build.startsWith('PASS') ? GREEN : view.checks.build === 'not run yet' ? DIM : RED}${view.checks.build}${RESET}`);
  out.push(`│            test:  ${view.checks.test.startsWith('PASS') ? GREEN : view.checks.test === 'not run yet' ? DIM : RED}${view.checks.test}${RESET}`);
  out.push(`│ ${CYAN}DECISIONS${RESET}   ${view.decisions} logged`);

  out.push(`├${line}┤`);
  out.push(`│ ${CYAN}RECENT EVENTS${RESET}`);
  for (const e of view.recentEvents) {
    out.push(`│   [${e.kind}] ${e.actor}`);
  }
  out.push(`└${line}┘`);
  return out.join('\n');
}

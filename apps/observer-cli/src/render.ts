import type { ObserverView } from './view.js';

const DIM = '\x1b[2m';
const BOLD = '\x1b[1m';
const GREEN = '\x1b[32m';
const RED = '\x1b[31m';
const CYAN = '\x1b[36m';
const RESET = '\x1b[0m';

/** Strip terminal control bytes from agent-controlled strings (audit M2):
 * ESC/CSI sequences, OSC hyperlinks, CR overwrites — the whiteboard must
 * not let board/mail text redraw the terminal or spoof rows. */
export function sanitize(s: unknown): string {
  return String(s).replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '').replace(/\r/g, '').replace(/\x9b/g, '');
}

export function render(view: ObserverView): string {
  const line = '─'.repeat(62);
  const out: string[] = [];

  out.push(`${BOLD}  ANTFARM${RESET} ${DIM}— live whiteboard (read-only)${RESET}`);
  out.push(`┌${line}┐`);

  for (const a of view.agents) {
    const agent = sanitize(a.agent);
    const status = sanitize(a.status);
    const statusColor = status === 'done' ? GREEN : status === 'never run' ? DIM : RED;
    out.push(
      `│ ${BOLD}${agent.padEnd(8)}${RESET} status: ${statusColor}${status.padEnd(10)}${RESET} ` +
        `cycles: ${String(a.cycles).padEnd(4)}`
    );
    if (a.lastSession) {
      const summary = sanitize(a.lastSession).slice(0, 34);
      out.push(`│           "${summary}"`);
    }
  }

  out.push(`├${line}┤`);
  out.push(`│ ${CYAN}LIVE MAIL (latest)${RESET}`);
  for (const m of view.latestMail) {
    out.push(`│   [#${String(m.id).padEnd(3)}] ${sanitize(m.type).padEnd(9)} ${sanitize(m.from)} → ${sanitize(m.to)}: ${sanitize(m.subject).slice(0, 30)}`);
  }
  if (!view.latestMail.length) out.push(`│   ${DIM}(no mail yet)${RESET}`);

  out.push(`├${line}┤`);
  out.push(`│ ${CYAN}TASK BOARD${RESET}  ` +
    Object.entries(view.taskCounts).map(([k, v]) => `${k}:${v}`).join('  ').slice(0, 44));
  for (const t of view.board) {
    out.push(`│   #${String(t.id)} [${sanitize(t.state)}] ${sanitize(t.title).slice(0, 40)} ${DIM}(${sanitize(t.owner ?? 'unowned')})${RESET}`);
  }

  out.push(`├${line}┤`);
  const build = sanitize(view.checks.build);
  const test = sanitize(view.checks.test);
  out.push(`│ ${CYAN}CHECKS${RESET}     build: ${build.startsWith('PASS') ? GREEN : build === 'not run yet' ? DIM : RED}${build}${RESET}`);
  out.push(`│            test:  ${test.startsWith('PASS') ? GREEN : test === 'not run yet' ? DIM : RED}${test}${RESET}`);
  out.push(`│ ${CYAN}DECISIONS${RESET}   ${view.decisions} logged`);

  out.push(`├${line}┤`);
  out.push(`│ ${CYAN}RECENT EVENTS${RESET}`);
  for (const e of view.recentEvents) {
    out.push(`│   [${sanitize(e.kind)}] ${sanitize(e.actor)}`);
  }
  out.push(`└${line}┘`);
  return out.join('\n');
}

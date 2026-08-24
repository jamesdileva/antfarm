import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { antfarmHome } from '@antfarm/orchestrator/home.js';
import { buildView } from './view.js';
import { render } from './render.js';

function dbPath(): string {
  const root = antfarmHome();
  if (existsSync(join(root, 'lab.db'))) return join(root, 'lab.db');
  return join(root, 'project', 'lab.db');
}

async function main(): Promise<void> {
  const path = dbPath();
  if (!existsSync(path)) {
    console.error(`no lab database at ${path} — run the orchestrator first`);
    process.exit(1);
  }
  console.error(`watching ${path} — Ctrl+C to exit`);

  const draw = (): void => {
    process.stdout.write('\x1b[2J\x1b[H'); // clear + home
    try {
      console.log(render(buildView(path)));
    } catch (err) {
      console.error(`(db busy: ${(err as Error).message})`);
    }
  };

  draw();
  setInterval(draw, 1000);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

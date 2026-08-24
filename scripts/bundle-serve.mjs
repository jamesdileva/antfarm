// Bundles the orchestrator CLI/serve entry into a single CJS file the
// packaged Electron shell can run with ELECTRON_RUN_AS_NODE=1.
// better-sqlite3 (native) ships separately via electron-builder
// extraResources + NODE_PATH; everything else is pure JS and bundles fine.
import * as esbuild from 'esbuild';
import { mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const outfile = join(root, 'apps', 'shell', 'dist', 'orchestrator.cjs');
mkdirSync(dirname(outfile), { recursive: true });

await esbuild.build({
  entryPoints: [join(root, 'apps', 'orchestrator', 'src', 'main.ts')],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node20',
  outfile,
  external: ['better-sqlite3', 'electron'],
  logLevel: 'info',
});
console.log(`bundled: ${outfile}`);

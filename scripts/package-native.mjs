// Stages an Electron-ABI copy of better-sqlite3 (+ runtime deps) for
// packaging. Dev keeps the Node-ABI copy in node_modules — both coexist.
import { cpSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const electronPkg = [join(root, 'apps', 'shell', 'node_modules'), join(root, 'node_modules')]
  .map((d) => join(d, 'electron', 'package.json'))
  .find(existsSync);
if (!electronPkg) throw new Error('electron not installed');
const electronVersion = JSON.parse(readFileSync(electronPkg, 'utf8')).version;

const stage = join(root, 'release', 'native', 'node_modules');
rmSync(join(root, 'release', 'native'), { recursive: true, force: true });

const packages = ['better-sqlite3', 'bindings', 'file-uri-to-path'];
for (const pkg of packages) {
  const src = join(root, 'node_modules', pkg);
  if (!existsSync(src)) throw new Error(`expected ${src} (run npm install first)`);
  const dst = join(stage, pkg);
  cpSync(src, dst, { recursive: true });
  // drop transitive deps — only runtime roots are needed
  rmSync(join(dst, 'node_modules'), { recursive: true, force: true });
}

// swap the Node-ABI binary for the Electron one (official prebuilt download)
const bsql = join(stage, 'better-sqlite3');
rmSync(join(bsql, 'build'), { recursive: true, force: true });
const prebuildBin = join(root, 'node_modules', 'prebuild-install', 'bin.js');
if (!existsSync(prebuildBin)) throw new Error('prebuild-install not installed');
const ran = spawnSync(process.execPath, [prebuildBin, '-r', 'electron', '-t', electronVersion], {
  cwd: bsql,
  stdio: 'inherit',
});
if (ran.status !== 0) {
  throw new Error(`prebuild-install failed with status ${ran.status}`);
}
console.log(`staged electron-ABI native modules for electron ${electronVersion} -> ${stage}`);

// One-shot repair: PowerShell re-encoded main.ts as CP1252-misread UTF-8.
// Reverse: chars -> latin1 bytes -> utf8 decode.
import { readFileSync, writeFileSync } from 'node:fs';

const p = 'apps/dashboard/src/main.ts';
const s = readFileSync(p, 'utf8');
const buf = Buffer.from(s, 'latin1');
const fixed = buf.toString('utf8');
const bad = (t) => (t.match(/[Ââ]/g) || []).length;
console.log('corrupt markers before:', bad(s), 'after:', bad(fixed));
if (bad(fixed) > 0) {
  console.error('still corrupted after reversal — aborting');
  process.exit(1);
}
writeFileSync(p, fixed, 'utf8');
console.log('repaired', p);

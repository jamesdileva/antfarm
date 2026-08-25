// Targeted repair for double-mangled unicode in dashboard main.ts
import { readFileSync, writeFileSync } from 'node:fs';

const p = 'apps/dashboard/src/main.ts';
let s = readFileSync(p, 'utf8');

const fixes = [
  [/^\uFFFD/, ''],
  [/\uFFFD\u001D/g, '\u2014'],
  [/ \uFFFD \u0019 /g, ' \u2192 '],
  [/\u2B26/g, '\u2026'],
  [/\uFFFDS\u001C/g, '\u2713'],
];

let applied = 0;
for (const [re, to] of fixes) {
  const before = (s.match(re) || []).length;
  if (before) { s = s.replace(re, to); applied += before; }
}
writeFileSync(p, s, 'utf8');
console.log('replacements applied:', applied);
const allowed = ['\u2014', '\u2192', '\u00B7', '\u2026', '\u2713'];
const leftover = (s.match(/[^\x00-\x7F]/g) || []).filter((c) => !allowed.includes(c));
console.log('unexpected non-ascii remaining:', leftover.length);
if (leftover.length) {
  console.log(JSON.stringify(leftover));
  process.exit(1);
}

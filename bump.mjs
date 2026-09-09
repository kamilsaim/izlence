#!/usr/bin/env node
/* Surum yukseltme: app.js, sw.js ve version.json'u birlikte gunceller.
   Kullanim:
     node bump.mjs            -> yama surumu artar (1.5.6 -> 1.5.7)
     node bump.mjs minor      -> 1.5.6 -> 1.6.0
     node bump.mjs major      -> 1.5.6 -> 2.0.0
     node bump.mjs 1.9.3      -> dogrudan o surum
   Ikinci arguman not olarak version.json'a yazilir. */

import { readFileSync, writeFileSync } from 'node:fs';

const read = (f) => readFileSync(new URL(f, import.meta.url), 'utf8');
const write = (f, s) => writeFileSync(new URL(f, import.meta.url), s);

const arg = (process.argv[2] || 'patch').trim();
const note = (process.argv.slice(3).join(' ') || '').trim();

const app = read('app.js');
const cur = (app.match(/version: '([\d.]+)'/) || [])[1];
if (!cur) { console.error('app.js icinde surum bulunamadi'); process.exit(1); }

let next;
if (/^\d+\.\d+\.\d+$/.test(arg)) {
  next = arg;
} else {
  const [ma, mi, pa] = cur.split('.').map(Number);
  if (arg === 'major') next = `${ma + 1}.0.0`;
  else if (arg === 'minor') next = `${ma}.${mi + 1}.0`;
  else if (arg === 'patch') next = `${ma}.${mi}.${pa + 1}`;
  else { console.error(`gecersiz arguman: ${arg}`); process.exit(1); }
}

const today = new Date().toISOString().slice(0, 10);

write('app.js', app.replace(`version: '${cur}'`, `version: '${next}'`)
  .replace(/build: '[\d-]+'/, `build: '${today}'`));

const sw = read('sw.js');
if (!sw.includes(`izlence-v${cur}`)) {
  console.error(`sw.js icinde izlence-v${cur} bulunamadi, elle kontrol et`);
  process.exit(1);
}
write('sw.js', sw.replace(`izlence-v${cur}`, `izlence-v${next}`));

const ver = JSON.parse(read('version.json'));
ver.version = next;
ver.build = today;
if (note) ver.notes = note;
write('version.json', JSON.stringify(ver, null, 2) + '\n');

console.log(`${cur} -> ${next} (app.js, sw.js, version.json)`);
console.log('Simdi: firebase deploy --only hosting:izlence --project siramatik-11af4 --account kayserisustavuklari@gmail.com');

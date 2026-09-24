#!/usr/bin/env node
// Copies the wraith repository's corpus headline (corpus/headline.json) into
// src/data/headline.json, where src/headline.ts reads it at build time and the
// landing page renders its trust row from it.
//
// The wraith checkout defaults to ../wraith (a sibling of this repo);
// WRAITH_REPO overrides it. The file is copied byte for byte after a shape
// check, so the site states exactly what the repository measured, with the
// date it was measured on. Numbers are never typed into the page.

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const wraithRepo = path.resolve(root, process.env.WRAITH_REPO ?? '../wraith');
const sourcePath = path.join(wraithRepo, 'corpus/headline.json');
const targetPath = path.join(root, 'src/data/headline.json');

const text = readFileSync(sourcePath, 'utf8');
const data = JSON.parse(text);

const required = [
  'measured_at.date',
  'corpus.twins',
  'corpus.sessions',
  'in_memory.twins.pass',
  'in_memory.twins.of',
  'strict_replay.equals_in_memory',
  'held_out.newest.pass',
  'held_out.newest.of',
  'fresh.pass',
  'fresh.measured',
];
for (const field of required) {
  const value = field.split('.').reduce((o, k) => (o == null ? undefined : o[k]), data);
  if (value === undefined || value === null) {
    throw new Error(`${sourcePath}: missing ${field}`);
  }
}

let previous = null;
try {
  previous = JSON.parse(readFileSync(targetPath, 'utf8'));
} catch {
  // first sync
}

mkdirSync(path.dirname(targetPath), { recursive: true });
writeFileSync(targetPath, text);

// The repo README states the same numbers in one generated sentence between
// markers, so the GitHub page and the landing page cannot disagree.
const readmePath = path.join(root, 'README.md');
const readme = readFileSync(readmePath, 'utf8');
const markers = /(<!-- headline:start[^\n]*\n)[\s\S]*?(\n<!-- headline:end -->)/;
if (!markers.test(readme)) {
  throw new Error('README.md: no <!-- headline:start --> / <!-- headline:end --> markers');
}
const f = (x) => `${x.pass}/${x.of}`;
const n = (x) => x.toLocaleString('en-US');
const strict = data.strict_replay.equals_in_memory ? ', in memory and in strict replay alike' : '';
const exchanges = data.corpus.exchanges == null ? '' : ` and ${n(data.corpus.exchanges)} exchanges`;
const sentence =
  `Current proof corpus, measured ${data.measured_at.date}: ` +
  `${f(data.in_memory.twins)} twins pass the recordings they were built from${strict}; ` +
  `${f(data.held_out.newest)} pass with their newest session held out; ` +
  `${data.fresh.pass}/${data.fresh.measured} pass a session recorded fresh against a local origin. ` +
  `${n(data.corpus.sessions)} recorded sessions${exchanges} across ${data.corpus.twins} services ` +
  '(REST, GraphQL, gRPC unary + server-streaming, and SSE). See [CHANGELOG.md](./CHANGELOG.md).';
writeFileSync(readmePath, readme.replace(markers, (_, start, end) => `${start}${sentence}${end}`));

const from = previous?.measured_at?.date ?? 'none';
console.log(
  `Synced headline measured ${data.measured_at.date} (was ${from}) from`,
  path.relative(root, sourcePath),
  'to',
  path.relative(root, targetPath),
);

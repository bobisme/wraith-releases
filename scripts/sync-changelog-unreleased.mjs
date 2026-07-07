#!/usr/bin/env node
// Regenerates the "## Unreleased" section of the root CHANGELOG.md from the
// same section in src/content/docs/changelog.md (the hand-edited source).
//
// Scope is deliberately narrow: only the block between "## Unreleased" and
// the next "## v" heading is touched, in both the source and the target.
// Everything else (frozen release history, which has its own pre-existing,
// non-mechanical divergence between the two files) is left alone.
//
// The one transform applied is de-linking site-relative markdown links
// (e.g. "[Overlays](/overlays/)" -> "Overlays"), since those paths don't
// resolve outside the docs site. External (http/https) links are untouched.

import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const sourcePath = path.join(root, 'src/content/docs/changelog.md');
const targetPath = path.join(root, 'CHANGELOG.md');

function extractUnreleased(text) {
  const lines = text.split('\n');
  const start = lines.findIndex((l) => l.trim() === '## Unreleased');
  if (start === -1) {
    throw new Error('No "## Unreleased" heading found');
  }
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (/^## v/.test(lines[i])) {
      end = i;
      break;
    }
  }
  return { block: lines.slice(start, end).join('\n'), rest: lines };
}

function delinkSiteRelative(block) {
  // [text](/path/) -> text   (leave [text](https://...) alone)
  return block.replace(/\[([^\]]+)\]\(\/[^)]*\)/g, '$1');
}

function spliceUnreleased(targetText, newBlock) {
  const lines = targetText.split('\n');
  const start = lines.findIndex((l) => l.trim() === '## Unreleased');
  if (start === -1) {
    throw new Error('Target has no "## Unreleased" heading to replace');
  }
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (/^## v/.test(lines[i])) {
      end = i;
      break;
    }
  }
  // Trim surrounding blank lines from before/after so we control spacing
  // explicitly instead of accumulating blanks across repeated runs.
  const before = lines.slice(0, start).join('\n').replace(/\n*$/, '');
  const after = lines.slice(end).join('\n').replace(/^\n*/, '');
  return `${before}\n\n${newBlock.trimEnd()}\n\n${after}`;
}

const sourceText = readFileSync(sourcePath, 'utf8');
const targetText = readFileSync(targetPath, 'utf8');

const { block: rawBlock } = extractUnreleased(sourceText);
const transformed = delinkSiteRelative(rawBlock);

const newTarget = spliceUnreleased(targetText, transformed);
writeFileSync(targetPath, newTarget);

console.log('Synced Unreleased section from', path.relative(root, sourcePath), 'to', path.relative(root, targetPath));

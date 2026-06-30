import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Single source of truth for the latest released version shown on the site.
 *
 * Derived at build time from the top entry of the changelog, so it tracks every
 * release automatically — adding the `## vX.Y.Z` heading (which we do for each
 * release) is the only edit needed. No hand-maintained version constant.
 *
 * Read via `process.cwd()` (the project root during an Astro build) rather than
 * `import.meta.url`, which Vite rewrites to the bundled chunk path.
 */
function readLatestVersion(): string {
  const changelogPath = join(process.cwd(), 'src/content/docs/changelog.md');
  const changelog = readFileSync(changelogPath, 'utf8');
  // First `## vX.Y.Z` heading (entries are newest-first).
  const match = changelog.match(/^##\s+v(\d+\.\d+\.\d+)/m);
  if (!match) {
    throw new Error(
      'version.ts: could not find a `## vX.Y.Z` heading in src/content/docs/changelog.md',
    );
  }
  return match[1];
}

/** Latest released version, e.g. `"0.16.0"` (no leading `v`). */
export const LATEST_VERSION = readLatestVersion();

import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

/**
 * The corpus headline the landing page's trust row states.
 *
 * `src/data/headline.json` is a byte-for-byte copy of the wraith repository's
 * `corpus/headline.json` (`npm run sync-headline`), which the wraith round
 * close writes from its own measurements. The page never types a number in.
 *
 * The build FAILS when the file is missing, or when it was measured before the
 * newest changelog entry: a release must not ship a trust row older than the
 * release itself. Run `npm run sync-headline` to fix it.
 *
 * Read via `process.cwd()` (the project root during an Astro build), like
 * version.ts.
 */

interface Fraction {
  pass: number;
  of: number;
}

export interface Headline {
  measured_at: { date: string; commit: string; round: number };
  corpus: {
    twins: number;
    sessions: number;
    exchanges: number | null;
    routes: number | null;
    variants: number | null;
  };
  in_memory: { twins: Fraction; sessions: Fraction };
  strict_replay: { equals_in_memory: boolean; pair: [number, number] };
  served: { twins: Fraction; sessions: Fraction };
  held_out: { newest: Fraction; oldest: Fraction };
  fresh: { pass: number; measured: number; at_zero: number; fixtures: number };
  performance: Record<string, number> | null;
}

function newestChangelogDate(): string | null {
  const changelog = readFileSync(join(process.cwd(), 'src/content/docs/changelog.md'), 'utf8');
  const match = changelog.match(/^##\s+v\d+\.\d+\.\d+\s+[—-]\s+(\d{4}-\d{2}-\d{2})/m);
  return match ? match[1] : null;
}

function readHeadline(): Headline {
  const path = join(process.cwd(), 'src/data/headline.json');
  if (!existsSync(path)) {
    throw new Error('headline.ts: src/data/headline.json is missing. Run `npm run sync-headline`.');
  }
  const headline = JSON.parse(readFileSync(path, 'utf8')) as Headline;
  const measured = headline?.measured_at?.date;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(measured ?? '')) {
    throw new Error('headline.ts: src/data/headline.json has no measured_at.date.');
  }
  const released = newestChangelogDate();
  if (released && measured < released) {
    throw new Error(
      `headline.ts: the corpus headline was measured ${measured}, before the newest release (${released}). ` +
        'Run `npm run sync-headline` after the wraith round close, then build again.',
    );
  }
  return headline;
}

export const HEADLINE = readHeadline();

/** "28/29" */
export const frac = (f: Fraction): string => `${f.pass}/${f.of}`;

/** "362" -> "362", 14857 -> "14,857" */
export const count = (n: number): string => n.toLocaleString('en-US');

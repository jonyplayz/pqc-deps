/**
 * Build-time access to the catalog. Fails the build on any schema or lint
 * error, so a broken data file can never be published.
 */
import {
  lintCatalog,
  lintLibrary,
  STATUS_RANK,
  STATUSES,
  type Library,
  type Status,
} from '@pqc-deps/core';
import { loadLibrariesFromDir, dataDir } from '@pqc-deps/core/node';
import { SITE } from '../config';

let cache: Library[] | undefined;

export function getLibraries(): Library[] {
  if (cache) return cache;
  const { libraries, errors } = loadLibrariesFromDir();
  const lintErrors = [
    ...libraries.flatMap((l) => lintLibrary(l)),
    ...lintCatalog(libraries),
  ].filter((i) => i.severity === 'error');
  if (errors.length || lintErrors.length) {
    const lines = [
      ...errors.map((e) => `${e.file}: ${e.message}`),
      ...lintErrors.map((i) => `${i.libraryId} ${i.path}: ${i.message}`),
    ];
    throw new Error(`Catalog data is invalid (run npm run validate):\n${lines.join('\n')}`);
  }
  cache = libraries.sort(
    (a, b) =>
      STATUS_RANK[a.overall_status] - STATUS_RANK[b.overall_status] || a.name.localeCompare(b.name),
  );
  return cache;
}

export function getLibraryMap(): Map<string, Library> {
  return new Map(getLibraries().map((l) => [l.id, l]));
}

/** True when the site is built from the fictional data/examples set. */
export function usingExampleData(): boolean {
  return dataDir().replace(/\\/g, '/').endsWith('data/examples');
}

export function statusCounts(libs: Library[]): Record<Status, number> {
  const counts = Object.fromEntries(STATUSES.map((s) => [s, 0])) as Record<Status, number>;
  for (const l of libs) counts[l.overall_status]++;
  return counts;
}

/** Accepts YYYY-MM-DD (midnight UTC) or a full ISO timestamp. */
export function daysSince(isoDate: string, now = new Date()): number {
  const t = new Date(isoDate.length === 10 ? `${isoDate}T00:00:00Z` : isoDate);
  return Math.floor((now.getTime() - t.getTime()) / 86_400_000);
}

/** "2026-11-12 13:34 UTC" for a timestamp, the date unchanged for a plain date. */
export function formatVerified(s: string): string {
  return s.length === 10 ? s : `${s.slice(0, 10)} ${s.slice(11, 16)} UTC`;
}

export function isStale(lib: Library): boolean {
  return daysSince(lib.last_verified) > SITE.staleAfterDays;
}

/**
 * List catalog entries whose last_verified is older than N days.
 *   npm run stale -- [--days 90] [--markdown]
 * --markdown prints an issue body (used by the scheduled workflow).
 */
import { join } from 'node:path';
import { loadLibrariesFromDir, REPO_ROOT } from '@pqc-deps/core/node';
import { daysSince } from './stale-util';

const argv = process.argv.slice(2);
const daysArg = argv.indexOf('--days');
const days = daysArg >= 0 ? Number(argv[daysArg + 1]) : 90;
const markdown = argv.includes('--markdown');

const { libraries } = loadLibrariesFromDir(join(REPO_ROOT, 'data', 'libraries'));
const stale = libraries
  .map((l) => ({ l, age: daysSince(l.last_verified) }))
  .filter((x) => x.age > days)
  .sort((a, b) => b.age - a.age);

if (markdown) {
  if (!stale.length) process.exit(0);
  console.log(`These ${stale.length} entries were last verified more than ${days} days ago:\n`);
  console.log('| Library | Status | Last verified | Days |\n| --- | --- | --- | --- |');
  for (const { l, age } of stale)
    console.log(`| \`${l.id}\` | ${l.overall_status} | ${l.last_verified} | ${age} |`);
  console.log(`\nRefresh with: \`npm run pipeline -- --stale ${days} --pr\``);
} else {
  console.log(
    stale.length
      ? `${stale.length} stale entr${stale.length === 1 ? 'y' : 'ies'} (> ${days} days):`
      : `No entries older than ${days} days.`,
  );
  for (const { l, age } of stale)
    console.log(`  ${l.id.padEnd(28)} ${l.last_verified}  (${age} days, ${l.overall_status})`);
}

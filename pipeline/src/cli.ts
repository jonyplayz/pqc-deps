/**
 * Evidence pipeline CLI.
 *
 *   npm run pipeline -- <id> [<id> ...]     propose updates for these libraries
 *   npm run pipeline -- --all               every library
 *   npm run pipeline -- --stale [days]      libraries not verified in N days (default 90)
 *   npm run pipeline -- --unknown           libraries whose status is still unknown
 *
 * Output modes (the pipeline never commits to main):
 *   (default)   write proposals/<id>.yaml + proposals/<id>.md for review
 *   --apply     write the proposal into data/libraries/<id>.yaml (review with git diff)
 *   --pr        new branch, one commit per library, push, open a pull request
 *   --dry-run   fetch + filter only, no LLM call; writes proposals/<id>.md
 *
 * Options: --max-chars N (evidence budget, default 80000), --delay ms (between libraries),
 *          --slice k/n (only every n-th library from index k; the daily run uses this
 *          to check a seventh of the catalog each day and stay inside free LLM quotas)
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { isoToday, type Library } from '@pqc-deps/core';
import { loadLibrariesFromDir, REPO_ROOT } from '@pqc-deps/core/node';
import { fetchEvidence } from './fetch';
import { llmFromEnv } from './llm';
import { libraryToYaml, reportMarkdown } from './output';
import { proposeForLibrary, type RunResult } from './run';
import { daysSince, sliceOf } from './stale-util';

try {
  process.loadEnvFile(join(REPO_ROOT, '.env'));
} catch {
  /* no .env file */
}

interface Args {
  ids: string[];
  all: boolean;
  stale?: number;
  unknown: boolean;
  mode: 'proposals' | 'apply' | 'pr' | 'dry-run';
  maxChars: number;
  delay: number;
  /** Only every n-th library, starting at index k (spreads a daily run over n days). */
  slice?: { k: number; n: number };
}

function parseArgs(argv: string[]): Args {
  const a: Args = {
    ids: [],
    all: false,
    unknown: false,
    mode: 'proposals',
    maxChars: 80_000,
    delay: Number(process.env.LLM_DELAY_MS ?? 0),
  };
  for (let i = 0; i < argv.length; i++) {
    const x = argv[i]!;
    const next = () => argv[++i];
    if (x === '--all') a.all = true;
    else if (x === '--unknown') a.unknown = true;
    else if (x === '--stale') a.stale = /^\d+$/.test(argv[i + 1] ?? '') ? Number(next()) : 90;
    else if (x === '--apply') a.mode = 'apply';
    else if (x === '--pr') a.mode = 'pr';
    else if (x === '--dry-run') a.mode = 'dry-run';
    else if (x === '--max-chars') a.maxChars = Number(next());
    else if (x === '--delay') a.delay = Number(next());
    else if (x === '--slice') {
      const m = /^(\d+)\/(\d+)$/.exec(next() ?? '');
      if (!m || Number(m[2]) < 1) throw new Error('--slice needs k/n, for example 3/7');
      a.slice = { k: Number(m[1]) % Number(m[2]), n: Number(m[2]) };
    } else if (x.startsWith('-')) throw new Error(`Unknown option ${x}`);
    else a.ids.push(x);
  }
  return a;
}

const git = (...args: string[]) =>
  execFileSync('git', args, { cwd: REPO_ROOT, encoding: 'utf8' }).trim();
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function select(libs: Library[], a: Args): Library[] {
  return sliceOf(selectAll(libs, a), a.slice);
}

function selectAll(libs: Library[], a: Args): Library[] {
  if (a.ids.length) {
    const missing = a.ids.filter((id) => !libs.some((l) => l.id === id));
    if (missing.length) throw new Error(`Unknown library id(s): ${missing.join(', ')}`);
    return libs.filter((l) => a.ids.includes(l.id));
  }
  if (a.stale !== undefined) return libs.filter((l) => daysSince(l.last_verified) > a.stale!);
  if (a.unknown) return libs.filter((l) => l.overall_status === 'unknown');
  if (a.all) return libs;
  throw new Error('Name library ids, or use --all, --stale [days] or --unknown.');
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const dataDir = join(REPO_ROOT, 'data', 'libraries');
  const { libraries, errors } = loadLibrariesFromDir(dataDir);
  if (errors.length)
    throw new Error(
      `Fix data errors first (npm run validate):\n${errors.map((e) => e.message).join('\n')}`,
    );
  const targets = select(libraries, args);
  if (!targets.length) return console.log('Nothing to do.');

  const llm = args.mode === 'dry-run' ? undefined : llmFromEnv();
  let branch: string | undefined;
  if (args.mode === 'pr') {
    if (git('status', '--porcelain')) throw new Error('--pr needs a clean working tree.');
    branch = `pipeline/refresh-${isoToday()}-${Date.now().toString(36)}`;
    git('switch', '-c', branch);
  }

  const proposalsDir = join(REPO_ROOT, 'proposals');
  mkdirSync(proposalsDir, { recursive: true });
  const results: Array<{ lib: Library; r: RunResult; report: string }> = [];

  for (const [i, lib] of targets.entries()) {
    if (i && args.delay) await sleep(args.delay);
    process.stdout.write(`[${i + 1}/${targets.length}] ${lib.id}: `);
    const r = await proposeForLibrary(lib, {
      fetchEvidence,
      ...(llm ? { llm } : {}),
      excerpt: { maxCharsTotal: args.maxChars },
    });
    const report = reportMarkdown(r, lib);
    results.push({ lib, r, report });
    console.log(
      r.error
        ? `error: ${r.error}`
        : args.mode === 'dry-run'
          ? `${r.docs.length} PQC document(s) of ${r.totalFetched}`
          : r.library
            ? `${r.library.overall_status}, ${r.changes.length} change(s), ${r.dropped.length} dropped claim(s)`
            : 'no proposal',
    );

    writeFileSync(join(proposalsDir, `${lib.id}.md`), report);
    if (!r.library) continue;
    if (args.mode === 'proposals')
      writeFileSync(join(proposalsDir, `${lib.id}.yaml`), libraryToYaml(r.library));
    if ((args.mode === 'apply' || args.mode === 'pr') && r.changes.length) {
      writeFileSync(join(dataDir, `${lib.id}.yaml`), libraryToYaml(r.library));
      if (branch) {
        if (git('rev-parse', '--abbrev-ref', 'HEAD') !== branch)
          throw new Error('Refusing to commit: not on the pipeline branch.');
        git('add', join('data', 'libraries', `${lib.id}.yaml`));
        git(
          'commit',
          '-q',
          '-m',
          `data(${lib.id}): pipeline proposal (${r.changes.length} change(s))\n\nModel: ${r.model}. Needs human review of every source.`,
        );
      }
    }
  }

  if (branch) {
    const changed = results.filter((x) => x.r.library && x.r.changes.length);
    if (!changed.length) {
      git('switch', '-');
      git('branch', '-D', branch);
      return console.log('No changes to propose; no PR opened.');
    }
    git('push', '-q', '-u', 'origin', branch);
    const summary = [
      `Automated evidence refresh for ${changed.length} librar${changed.length === 1 ? 'y' : 'ies'}. **Every claim needs human review before merging.**`,
      '',
      '| Library | Proposed status | Changes | Dropped claims |',
      '| --- | --- | --- | --- |',
      ...changed.map(
        (x) =>
          `| \`${x.lib.id}\` | ${x.r.library!.overall_status} | ${x.r.changes.length} | ${x.r.dropped.length} |`,
      ),
      '',
      'Each library has a comment below with its evidence, quotes and anything that failed verification.',
      '',
      '🤖 Opened by the PQC Deps evidence pipeline',
    ].join('\n');
    const bodyFile = join(proposalsDir, '_pr-body.md');
    writeFileSync(bodyFile, summary);
    const url = execFileSync(
      'gh',
      [
        'pr',
        'create',
        '--base',
        'main',
        '--head',
        branch,
        '--title',
        `Evidence refresh ${isoToday()}`,
        '--body-file',
        bodyFile,
      ],
      { cwd: REPO_ROOT, encoding: 'utf8' },
    ).trim();
    for (const x of changed) {
      const f = join(proposalsDir, `${x.lib.id}.md`);
      execFileSync('gh', ['pr', 'comment', url, '--body-file', f], { cwd: REPO_ROOT });
    }
    console.log(`Opened ${url}`);
  } else if (args.mode !== 'apply') {
    console.log(`\nReports written to ${proposalsDir}`);
  }

  const failed = results.filter((x) => x.r.error);
  if (failed.length && failed.length === results.length) process.exitCode = 1;
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});

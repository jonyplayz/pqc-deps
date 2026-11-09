/**
 * Add a library to the catalog.
 *
 *   npm run add-library -- --name "Botan" --repo https://github.com/randombit/botan \
 *       --ecosystem c-cpp [--packages "pypi:botan3"] [--homepage URL] [--description TEXT]
 *       [--applicable ml-kem,ml-dsa] [--delegates openssl] [--watch URL ...] [--id botan]
 *   npm run add-library -- --from-env         (workflow_dispatch: ADD_* variables)
 *   npm run add-library -- --from-issue 42    (an approved "Request a library" issue)
 *
 * Steps: validate → check the repo/packages exist → (--pipeline) gather evidence
 * with the LLM → write data/libraries/<id>.yaml, or with --pr open a pull request.
 * Never commits to main.
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { isoToday, type Library } from '@pqc-deps/core';
import { loadLibrariesFromDir, REPO_ROOT } from '@pqc-deps/core/node';
import { fetchEvidence } from '../fetch';
import { checkIdentity } from '../identity';
import { llmFromEnv, type LlmClient } from '../llm';
import { libraryToYaml, reportMarkdown } from '../output';
import { proposeForLibrary, type RunResult } from '../run';
import { normalizeInput, rawInputFromEnv, rawInputFromIssue, type RawInput } from './input';
import { buildSkeleton } from './skeleton';

try {
  process.loadEnvFile(join(REPO_ROOT, '.env'));
} catch {
  /* no .env */
}

const git = (...args: string[]) =>
  execFileSync('git', args, { cwd: REPO_ROOT, encoding: 'utf8' }).trim();
const gh = (...args: string[]) =>
  execFileSync('gh', args, { cwd: REPO_ROOT, encoding: 'utf8' }).trim();

interface Options {
  raw: RawInput;
  issue?: number;
  pipeline: boolean;
  pr: boolean;
  skipIdentity: boolean;
}

function parseArgs(argv: string[]): Options {
  const raw: RawInput = {};
  const watch: string[] = [];
  let issue: number | undefined;
  let fromEnv = false;
  const o = { pipeline: false, pr: false, skipIdentity: false };
  const flagToKey: Record<string, keyof RawInput> = {
    '--id': 'id',
    '--name': 'name',
    '--ecosystem': 'ecosystem',
    '--repo': 'repo',
    '--homepage': 'homepage',
    '--description': 'description',
    '--packages': 'packages',
    '--applicable': 'applicable',
    '--delegates': 'delegates',
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === '--from-env') fromEnv = true;
    else if (a === '--from-issue') issue = Number(argv[++i]);
    else if (a === '--pipeline') o.pipeline = true;
    else if (a === '--pr') o.pr = true;
    else if (a === '--skip-identity') o.skipIdentity = true;
    else if (a === '--watch') watch.push(argv[++i] ?? '');
    else if (flagToKey[a]) raw[flagToKey[a]!] = argv[++i];
    else throw new Error(`Unknown option ${a}`);
  }
  if (issue !== undefined && (!Number.isInteger(issue) || issue <= 0))
    throw new Error('--from-issue needs an issue number');
  if (watch.length) raw.watch_urls = watch.join(' ');
  if (fromEnv) Object.assign(raw, rawInputFromEnv(process.env));
  return { raw, ...(issue ? { issue } : {}), ...o };
}

function llmIfConfigured(): LlmClient | undefined {
  const provider = (process.env.LLM_PROVIDER ?? 'anthropic').toLowerCase();
  if (provider === 'anthropic' && !process.env.ANTHROPIC_API_KEY) return undefined;
  try {
    return llmFromEnv();
  } catch {
    return undefined;
  }
}

/** Post a comment on the request issue (best effort). */
function commentOnIssue(issue: number | undefined, body: string) {
  if (!issue) return;
  const file = join(REPO_ROOT, 'proposals', `_issue-${issue}.md`);
  writeFileSync(file, body);
  try {
    gh('issue', 'comment', String(issue), '--body-file', file);
  } catch (e) {
    console.error(`Could not comment on issue #${issue}: ${(e as Error).message}`);
  }
}

function fail(o: Options, title: string, problems: string[]): never {
  const body = `**${title}**\n\n${problems.map((p) => `- ${p}`).join('\n')}\n\nFix the request and add the \`approved\` label again to retry.`;
  console.error(`${title}\n${problems.map((p) => `  - ${p}`).join('\n')}`);
  commentOnIssue(o.issue, body);
  process.exit(1);
}

async function main() {
  const o = parseArgs(process.argv.slice(2));
  mkdirSync(join(REPO_ROOT, 'proposals'), { recursive: true });
  if (o.issue) {
    const body = gh('issue', 'view', String(o.issue), '--json', 'body', '--jq', '.body');
    Object.assign(o.raw, rawInputFromIssue(body));
  }

  // 1. Validate the input.
  const { input, errors } = normalizeInput(o.raw);
  if (!input) fail(o, 'The library request is incomplete or invalid:', errors);

  // 2. Build the entry and check it against the catalog.
  const today = isoToday();
  const dataDir = join(REPO_ROOT, 'data', 'libraries');
  const { libraries } = loadLibrariesFromDir(dataDir);
  const built = buildSkeleton(input, libraries, today);
  if (!built.library) fail(o, 'The library cannot be added:', built.errors);
  let library: Library = built.library;
  console.log(`Adding ${library.id} (${library.name})`);

  // 3. Check that the repo, homepage, watch URLs and packages really exist.
  const checks = o.skipIdentity ? [] : await checkIdentity(library);
  const failed = checks.filter((c) => !c.ok);
  if (failed.length) {
    fail(
      o,
      'Some details could not be verified:',
      failed.map((c) => `${c.what}${c.detail ? ` (${c.detail})` : ''}`),
    );
  }
  const identityTable = checks.length
    ? [
        '| Check | Result |',
        '| --- | --- |',
        ...checks.map((c) => `| ${c.what} | ✓${c.detail ? ` ${c.detail}` : ''} |`),
      ].join('\n')
    : '_Identity check skipped._';
  for (const w of built.warnings) console.warn(`Warning: ${w}`);
  const warningsMd = built.warnings.length
    ? `\n\n**Warnings:**\n${built.warnings.map((w) => `- ${w}`).join('\n')}`
    : '';

  // 4. Optionally gather evidence with the LLM.
  let run: RunResult | undefined;
  let pipelineNote = 'Evidence pipeline not run; the entry starts as `unknown`.';
  if (o.pipeline) {
    const llm = llmIfConfigured();
    if (!llm)
      pipelineNote =
        'No LLM configured, so the evidence pipeline was skipped; the entry starts as `unknown`.';
    else {
      run = await proposeForLibrary(library, { fetchEvidence, llm });
      if (run.library) library = run.library;
      pipelineNote = run.error
        ? `Evidence pipeline failed: ${run.error}. The entry starts as \`unknown\`.`
        : `Evidence pipeline proposed status **${library.overall_status}**.`;
    }
  }
  const report = run ? reportMarkdown(run, built.library) : '';
  writeFileSync(join(REPO_ROOT, 'proposals', `${library.id}.md`), report || pipelineNote);
  console.log(pipelineNote);

  const file = join(dataDir, `${library.id}.yaml`);
  if (!o.pr) {
    writeFileSync(file, libraryToYaml(library));
    console.log(`Wrote data/libraries/${library.id}.yaml. Review it, then commit on a branch.`);
    return;
  }

  // 5. Open a pull request (never on main).
  if (git('status', '--porcelain', '--', 'data'))
    throw new Error('--pr needs a clean data/ directory.');
  const branch = `library/add-${library.id}-${Date.now().toString(36)}`;
  git('switch', '-c', branch);
  writeFileSync(file, libraryToYaml(library));
  git('add', join('data', 'libraries', `${library.id}.yaml`));
  git(
    'commit',
    '-q',
    '-m',
    `data(${library.id}): add ${library.name}${o.issue ? `\n\nRequested in #${o.issue}.` : ''}`,
  );
  git('push', '-q', '-u', 'origin', branch);

  const body = [
    `Adds **${library.name}** (\`${library.id}\`, ${library.ecosystem}) to the catalog.${o.issue ? `\n\nCloses #${o.issue}.` : ''}`,
    '',
    '### Identity checks',
    identityTable + warningsMd,
    '',
    '### Evidence',
    pipelineNote,
    '',
    report ? report.slice(0, 50_000) : '',
    '',
    '**Reviewer:** check the identity details and every cited source before merging.',
  ].join('\n');
  const bodyFile = join(REPO_ROOT, 'proposals', `_pr-add-${library.id}.md`);
  writeFileSync(bodyFile, body);
  const url = gh(
    'pr',
    'create',
    '--base',
    'main',
    '--head',
    branch,
    '--title',
    `Add ${library.name} to the catalog`,
    '--body-file',
    bodyFile,
  );
  console.log(`Opened ${url}`);
  commentOnIssue(
    o.issue,
    `Thanks! A pull request adding **${library.name}** is ready for review: ${url}`,
  );
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});

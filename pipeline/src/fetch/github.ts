/** Evidence from GitHub: releases, PQC-related issues/PRs, and the changelog file. */
import type { Library } from '@pqc-deps/core';
import { githubJson, githubRaw, HttpError } from './http';
import type { FetchedDoc, FetchResult } from './types';

/** owner/name from pipeline.github or a github.com repo URL. */
export function githubRepo(lib: Library): string | undefined {
  if (lib.pipeline?.github) return lib.pipeline.github;
  const m = lib.repo && /^https:\/\/github\.com\/([\w.-]+\/[\w.-]+?)(?:\.git)?\/?$/.exec(lib.repo);
  return m ? m[1] : undefined;
}

// GitHub search allows at most 5 boolean operators per query, hence two queries.
export const ISSUE_QUERIES = [
  '"ML-KEM" OR MLKEM OR Kyber OR X25519MLKEM768 OR "post-quantum"',
  '"ML-DSA" OR Dilithium OR "SLH-DSA" OR SPHINCS OR PQC',
];

const CHANGELOG_CANDIDATES = [
  'CHANGELOG.md',
  'CHANGES.md',
  'NEWS.md',
  'CHANGES',
  'NEWS',
  'CHANGELOG',
  'HISTORY.md',
  'RELEASE-NOTES.md',
];

interface GhRelease {
  html_url: string;
  name: string | null;
  tag_name: string;
  body: string | null;
  draft: boolean;
  prerelease: boolean;
  published_at: string | null;
}
interface GhIssue {
  html_url: string;
  number: number;
  title: string;
  body: string | null;
  state: string;
  updated_at: string;
  closed_at: string | null;
  pull_request?: { merged_at: string | null };
  labels: Array<{ name: string } | string>;
}

export async function fetchGithub(
  lib: Library,
  opts: { releases?: number; issues?: number } = {},
): Promise<FetchResult> {
  const repo = githubRepo(lib);
  if (!repo) return { docs: [], warnings: [] };
  const docs: FetchedDoc[] = [];
  const warnings: string[] = [];
  const note = (what: string, e: unknown) =>
    warnings.push(
      `GitHub ${what} for ${repo}: ${e instanceof HttpError ? `HTTP ${e.status}` : (e as Error).message}`,
    );

  // Releases (newest first). Each release is its own citable document.
  try {
    const releases = await githubJson<GhRelease[]>(
      `/repos/${repo}/releases?per_page=${opts.releases ?? 30}`,
    );
    for (const r of releases) {
      if (r.draft || !r.body?.trim()) continue;
      const name = r.name?.trim() || r.tag_name;
      docs.push({
        url: r.html_url,
        title: `${name}${r.prerelease ? ' (pre-release)' : ''}`,
        kind: 'release-notes',
        text: `Release ${name} (tag ${r.tag_name})${r.prerelease ? ' [PRE-RELEASE]' : ''}\n\n${r.body}`,
        ...(r.published_at ? { date: r.published_at.slice(0, 10) } : {}),
      });
    }
  } catch (e) {
    note('releases', e);
  }

  // Issues and pull requests that mention PQC terms.
  const seen = new Set<number>();
  for (const q of ISSUE_QUERIES) {
    try {
      const res = await githubJson<{ items: GhIssue[] }>(
        `/search/issues?q=${encodeURIComponent(`repo:${repo} ${q}`)}&sort=updated&order=desc&per_page=${opts.issues ?? 15}`,
      );
      for (const i of res.items) {
        if (seen.has(i.number)) continue;
        seen.add(i.number);
        const isPr = !!i.pull_request;
        const state =
          isPr && i.pull_request?.merged_at
            ? `merged ${i.pull_request.merged_at.slice(0, 10)}`
            : i.state;
        const labels = i.labels.map((l) => (typeof l === 'string' ? l : l.name)).join(', ');
        docs.push({
          url: i.html_url,
          title: `${isPr ? 'PR' : 'Issue'} #${i.number}: ${i.title}`,
          kind: isPr ? 'pull-request' : 'issue',
          text: `${isPr ? 'Pull request' : 'Issue'} #${i.number}: ${i.title}\nState: ${state}${labels ? `\nLabels: ${labels}` : ''}\n\n${i.body ?? ''}`,
          date: i.updated_at.slice(0, 10),
        });
      }
    } catch (e) {
      note('issue search', e);
    }
  }

  // Changelog file from the default branch.
  const paths = lib.pipeline?.changelog_path ? [lib.pipeline.changelog_path] : CHANGELOG_CANDIDATES;
  for (const path of paths) {
    try {
      const text = await githubRaw(
        `/repos/${repo}/contents/${path.split('/').map(encodeURIComponent).join('/')}`,
      );
      docs.push({
        url: `https://github.com/${repo}/blob/HEAD/${path}`,
        title: `${repo} ${path}`,
        kind: 'changelog',
        text,
      });
      break;
    } catch (e) {
      if (!(e instanceof HttpError && e.status === 404)) note(`changelog ${path}`, e);
      else if (lib.pipeline?.changelog_path)
        warnings.push(`Changelog ${path} not found in ${repo}.`);
    }
  }

  return { docs, warnings };
}

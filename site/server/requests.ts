/**
 * Shared logic for public requests and admin actions on them. Public requests
 * become GitHub issues; admins approve or reject them from /admin.
 */
import { HttpError } from './http';
import type { Env } from './env';
import { labelNames, type GitHub, type Issue } from './github';

export const LABELS = {
  publicRequest: 'public-request',
  recheck: 'recheck-request',
  newLibrary: 'new-library',
  approved: 'approved',
} as const;

const ID = /^[a-z0-9][a-z0-9-]*[a-z0-9]$/;
const ECOSYSTEMS = ['c-cpp', 'go', 'rust', 'jvm', 'python', 'javascript', 'dotnet', 'platform'];
const ECOSYSTEM_LABELS: Record<string, string> = {
  'c-cpp': 'C / C++',
  go: 'Go',
  rust: 'Rust',
  jvm: 'Java / JVM',
  python: 'Python',
  javascript: 'JavaScript / Node',
  dotnet: '.NET',
  platform: 'OS / platform',
};

export const recheckTitle = (id: string) => `[Re-check] ${id}`;

export function isLibraryId(v: unknown): v is string {
  return typeof v === 'string' && v.length <= 60 && ID.test(v);
}

/** The catalog ids, read from the site's own static API. */
export async function catalogIds(env: Env, requestUrl: string): Promise<Set<string>> {
  const res = await env.ASSETS.fetch(new URL('/api/catalog.json', requestUrl).toString());
  if (!res.ok) throw new HttpError(503, 'Catalog unavailable.');
  const data = (await res.json()) as { libraries: Array<{ id: string }> };
  return new Set(data.libraries.map((l) => l.id));
}

/** Clean free text for an issue body: limited length, no HTML or @mentions. */
export function cleanText(v: unknown, max: number): string {
  if (typeof v !== 'string') return '';
  return v
    .replace(/[<>]/g, '')
    .replace(/@(?=\w)/g, '@​')
    .replace(/\r\n/g, '\n')
    .trim()
    .slice(0, max);
}

const httpsUrl = (v: unknown) => {
  const s = cleanText(v, 300);
  if (!s) return '';
  try {
    const u = new URL(s);
    return u.protocol === 'https:' ? u.toString() : null;
  } catch {
    return null;
  }
};

export interface LibraryFields {
  name: string;
  ecosystem: string;
  repo: string;
  homepage: string;
  description: string;
  packages: string;
  applicable: string;
  delegates: string;
  watch_urls: string;
}

/** Light validation; the add-library workflow does the full check. */
export function libraryFields(body: Record<string, unknown>): LibraryFields {
  const name = cleanText(body.name, 80);
  if (name.length < 2) throw new HttpError(400, 'Please give the library name.');
  const ecosystem = cleanText(body.ecosystem, 20);
  if (!ECOSYSTEMS.includes(ecosystem)) throw new HttpError(400, 'Please choose an ecosystem.');
  const repo = httpsUrl(body.repo);
  if (!repo) throw new HttpError(400, 'The repository URL must start with https://');
  const homepage = httpsUrl(body.homepage);
  if (homepage === null) throw new HttpError(400, 'The homepage must start with https://');
  const watch = cleanText(body.watch_urls, 1000).split(/\s+/).filter(Boolean).slice(0, 10);
  if (watch.some((u) => httpsUrl(u) === null || !u.startsWith('https://'))) {
    throw new HttpError(400, 'Pages to watch must start with https://');
  }
  const words = (v: unknown, max: number, re: RegExp) => {
    const list = cleanText(v, max)
      .split(/[\s,]+/)
      .filter(Boolean);
    if (list.some((x) => !re.test(x))) return null;
    return list.join(' ');
  };
  const packages = words(body.packages, 1000, /^(npm|pypi|go|maven|cargo|nuget):[\w@./:~-]+$/i);
  if (packages === null) {
    throw new HttpError(
      400,
      'Packages must look like registry:name, e.g. npm:jose or pypi:cryptography.',
    );
  }
  const applicable = words(body.applicable, 100, /^(ml-kem|ml-dsa|slh-dsa|hybrid-tls)$/);
  if (applicable === null) throw new HttpError(400, 'Unknown algorithm.');
  const delegates = words(body.delegates, 200, ID);
  if (delegates === null) throw new HttpError(400, 'Delegates must be catalog ids.');
  return {
    name,
    ecosystem,
    repo,
    homepage: homepage ?? '',
    description: cleanText(body.description, 300),
    packages,
    applicable,
    delegates,
    watch_urls: watch.join(' '),
  };
}

/** Issue body in the same format as the "Request a library" issue form, so the workflow can parse it. */
export function libraryIssueBody(f: LibraryFields, notes: string): string {
  const section = (label: string, value: string) => `### ${label}\n\n${value || '_No response_'}\n`;
  return [
    section('Library name', f.name),
    section('Ecosystem', ECOSYSTEM_LABELS[f.ecosystem] ?? f.ecosystem),
    section('Source repository URL', f.repo),
    section('Homepage', f.homepage),
    section('Short description', f.description),
    section('Package names', f.packages.split(' ').join('\n')),
    section('Applicable algorithms', f.applicable.split(' ').join(', ')),
    section('Delegates crypto to', f.delegates),
    section('Pages to watch for evidence', f.watch_urls.split(' ').join('\n')),
    section('Anything else?', notes),
    '_Submitted through the PQC Deps website._',
  ].join('\n');
}

/** Refuse new public requests once the daily cap is reached. */
export async function enforceDailyCap(gh: GitHub, env: Env): Promise<void> {
  const cap = Number(env.PUBLIC_DAILY_CAP ?? 30) || 30;
  if ((await gh.countRecent(LABELS.publicRequest)) >= cap) {
    throw new HttpError(429, 'We received many requests today. Please try again tomorrow.');
  }
}

export type RequestKind = 'recheck' | 'library';

export function requestKind(issue: Issue): RequestKind | undefined {
  const labels = labelNames(issue);
  if (labels.includes(LABELS.recheck)) return 'recheck';
  if (labels.includes(LABELS.newLibrary)) return 'library';
  return undefined;
}

export function recheckId(issue: Issue): string | undefined {
  const m = /^\[Re-check\] ([a-z0-9-]+)$/.exec(issue.title);
  return m && isLibraryId(m[1]) ? m[1] : undefined;
}
